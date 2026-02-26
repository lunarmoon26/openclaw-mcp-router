export type ChunkConfig = {
  /** Max characters per chunk. 0 = disable chunking. */
  maxChunkChars: number;
  /** Overlap characters between adjacent chunks. */
  overlapChars: number;
};

export type Chunk = {
  /** 0-based chunk index */
  index: number;
  /** Total chunks for this tool */
  total: number;
  /** Chunk text content */
  text: string;
};

/**
 * Split text into overlapping chunks that respect semantic boundaries.
 *
 * Fast path: if the text fits in a single chunk (or chunking is disabled),
 * returns a single chunk with zero overhead.
 *
 * @param text - The full text to chunk (e.g. "tool_name: description")
 * @param toolNamePrefix - Prefixed to chunks with index > 0 so the embedding
 *   model always sees the tool name (e.g. "tool_name: ... ")
 * @param config - Chunking parameters
 */
export function chunkText(
  text: string,
  toolNamePrefix: string,
  config: ChunkConfig,
): Chunk[] {
  // Fast path: single chunk
  if (config.maxChunkChars === 0 || text.length <= config.maxChunkChars) {
    return [{ index: 0, total: 1, text }];
  }

  const segments = splitSegments(text);
  const chunks = mergeSegments(segments, toolNamePrefix, config);
  const total = chunks.length;

  return chunks.map((text, index) => ({ index, total, text }));
}

/**
 * Split text into segments using a separator hierarchy that preserves
 * semantic boundaries: \n\n → \n → ". " → hard character boundary.
 */
function splitSegments(text: string): string[] {
  // Try separators in order of preference
  const separators = ["\n\n", "\n", ". "];

  for (const sep of separators) {
    if (text.includes(sep)) {
      const parts = text.split(sep);
      // Re-attach separator to end of each part (except last)
      return parts.map((part, i) => (i < parts.length - 1 ? part + sep : part));
    }
  }

  // No separators found — return the whole text as one segment
  // (will be hard-split in mergeSegments if needed)
  return [text];
}

/**
 * Greedily merge segments into chunks up to maxChunkChars.
 * When a chunk is full, start a new one with overlap from the previous chunk's tail.
 * Chunks with index > 0 get the tool name prefix.
 */
function mergeSegments(
  segments: string[],
  toolNamePrefix: string,
  config: ChunkConfig,
): string[] {
  const { maxChunkChars, overlapChars } = config;
  const continuationPrefix = `${toolNamePrefix}: ... `;
  const chunks: string[] = [];

  let current = "";

  for (const segment of segments) {
    // If adding this segment exceeds the limit, finalize current chunk
    if (current.length > 0 && current.length + segment.length > maxChunkChars) {
      chunks.push(current);
      // Start new chunk with overlap from the tail of the previous chunk
      const overlap = overlapChars > 0 ? current.slice(-overlapChars) : "";
      current = continuationPrefix + overlap;
    }

    // If a single segment is too long, hard-split it
    if (segment.length > maxChunkChars) {
      // Flush anything accumulated
      if (current.length > 0 && current !== continuationPrefix) {
        // There may be partial content — include it
      }

      let remaining = current + segment;
      while (remaining.length > maxChunkChars) {
        chunks.push(remaining.slice(0, maxChunkChars));
        const overlap = overlapChars > 0 ? remaining.slice(maxChunkChars - overlapChars, maxChunkChars) : "";
        remaining = continuationPrefix + overlap + remaining.slice(maxChunkChars);
      }
      current = remaining;
      continue;
    }

    current += segment;
  }

  // Flush remaining
  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}
