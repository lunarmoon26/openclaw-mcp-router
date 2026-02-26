import type { Embeddings } from "./embeddings.js";
import type { McpRegistry } from "./mcp-registry.js";
import { McpClient } from "./mcp-client.js";
import type { McpRouterConfig, McpServerConfig } from "./config.js";
import { EXTENSION_ID } from "./constants.js";
import type { McpToolVectorStore } from "./vector-store.js";
import { chunkText } from "./chunker.js";

type IndexerLogger = {
  info(msg: string): void;
  warn(msg: string): void;
};

type IndexerResult = {
  indexed: number;
  failed: number;
};

/**
 * Returns a promise that resolves after `ms` milliseconds,
 * but rejects immediately if the AbortSignal fires.
 */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(signal!.reason);
    }

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Connect to all configured MCP servers in parallel, list their tools,
 * embed each tool description, and upsert into the vector store.
 *
 * Catches Ollama errors gracefully — the plugin degrades to an empty index
 * rather than crashing the gateway.
 *
 * Supports retry with exponential backoff and AbortSignal-based cancellation.
 */
export async function runIndexer(params: {
  cfg: McpRouterConfig;
  store: McpToolVectorStore;
  embeddings: Embeddings;
  registry: McpRegistry;
  logger: IndexerLogger;
  signal?: AbortSignal;
}): Promise<IndexerResult> {
  const { cfg, store, embeddings, registry, logger, signal } = params;

  // Run all servers in parallel — failures in one don't block others
  const results = await Promise.allSettled(
    cfg.servers.map((serverCfg) =>
      indexServer({ serverCfg, cfg, store, embeddings, registry, logger, signal }),
    ),
  );

  let indexed = 0;
  let failed = 0;
  for (const result of results) {
    if (result.status === "fulfilled") {
      indexed += result.value.indexed;
      failed += result.value.failed;
    } else {
      logger.warn(`${EXTENSION_ID}: server indexing error — ${String(result.reason)}`);
      failed++;
    }
  }

  logger.info(
    `${EXTENSION_ID}: indexed ${indexed} tools across ${cfg.servers.length} servers (${failed} errors)`,
  );

  return { indexed, failed };
}

async function indexServer(params: {
  serverCfg: McpServerConfig;
  cfg: McpRouterConfig;
  store: McpToolVectorStore;
  embeddings: Embeddings;
  registry: McpRegistry;
  logger: IndexerLogger;
  signal?: AbortSignal;
}): Promise<IndexerResult> {
  const { serverCfg, cfg, store, embeddings, registry, logger, signal } = params;
  const { indexer } = cfg;
  const maxAttempts = indexer.maxRetries + 1; // total attempts = retries + 1

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    signal?.throwIfAborted();

    // Backoff delay before retry (skip on first attempt)
    if (attempt > 0) {
      const delay = Math.min(
        indexer.initialRetryDelay * 2 ** (attempt - 1),
        indexer.maxRetryDelay,
      );
      logger.info(
        `${EXTENSION_ID}: retrying server "${serverCfg.name}" in ${delay}ms (attempt ${attempt + 1}/${maxAttempts})`,
      );
      await abortableDelay(delay, signal);
    }

    const client = new McpClient(serverCfg);
    try {
      const connectTimeout = serverCfg.timeout ?? indexer.connectTimeout;
      await client.connect({ signal, timeout: connectTimeout });
      const tools = await client.listTools();

      let indexed = 0;
      let failed = 0;

      const { maxChunkChars, overlapChars } = cfg.indexer;

      for (const tool of tools) {
        signal?.throwIfAborted();
        try {
          const embeddingText = `${tool.name}: ${tool.description}`;
          const chunks = chunkText(embeddingText, tool.name, { maxChunkChars, overlapChars });
          const description = tool.description;
          const parametersJson = JSON.stringify(tool.inputSchema);

          if (chunks.length === 1) {
            // Fast path: single chunk — existing behavior
            const vector = await embeddings.embed(chunks[0].text);
            await store.upsertTool({
              tool_id: `${serverCfg.name}::${tool.name}`,
              server_name: serverCfg.name,
              tool_name: tool.name,
              description,
              parameters_json: parametersJson,
              vector,
            });
          } else {
            // Multi-chunk path
            await store.deleteToolChunks(serverCfg.name, tool.name);
            const entries = [];
            for (let i = 0; i < chunks.length; i++) {
              signal?.throwIfAborted();
              const vector = await embeddings.embed(chunks[i].text);
              entries.push({
                tool_id: `${serverCfg.name}::${tool.name}::chunk${i}`,
                server_name: serverCfg.name,
                tool_name: tool.name,
                description,
                parameters_json: parametersJson,
                vector,
              });
            }
            await store.addToolEntries(entries);
          }

          registry.registerToolOwner(tool.name, serverCfg.name);
          indexed++;
        } catch (err) {
          // If aborted during tool processing, re-throw to exit
          signal?.throwIfAborted();
          logger.warn(
            `${EXTENSION_ID}: failed to index tool "${tool.name}" from server "${serverCfg.name}": ${String(err)}`,
          );
          failed++;
        }
      }

      return { indexed, failed };
    } catch (err) {
      await client.disconnect();

      // If aborted, don't retry — propagate immediately
      signal?.throwIfAborted();

      const msg = String(err);
      const isLastAttempt = attempt === maxAttempts - 1;

      if (isLastAttempt) {
        // Surface embedding service connectivity errors clearly
        if (msg.includes("not reachable") || msg.includes("embedding service")) {
          logger.warn(
            `${EXTENSION_ID}: embedding service unavailable — check that the service is running and run \`openclaw ${EXTENSION_ID} reindex\` to rebuild the index. ${msg}`,
          );
        } else {
          logger.warn(`${EXTENSION_ID}: failed to index server "${serverCfg.name}": ${msg}`);
        }
        return { indexed: 0, failed: 1 };
      }

      // Not last attempt — log and continue to retry
      logger.info(
        `${EXTENSION_ID}: server "${serverCfg.name}" not ready — ${msg}`,
      );
    } finally {
      await client.disconnect();
    }
  }

  // Should not reach here, but just in case
  return { indexed: 0, failed: 1 };
}
