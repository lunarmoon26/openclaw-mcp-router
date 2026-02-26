import { EXTENSION_ID } from "./constants.js";

// Known embedding dimensions by model name (avoids a probe round-trip for common models)
const KNOWN_DIMS: Record<string, number> = {
  // Ollama models
  "embeddinggemma": 768,
  "qwen3-embedding:0.6b": 1024,
  "all-minilm": 384,
  // OpenAI models
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
  // Voyage models
  "voyage-3": 1024,
  "voyage-3-lite": 512,
  "voyage-code-3": 1024,
  // Gemini models
  "text-embedding-004": 768,
  // Mistral models
  "mistral-embed": 1024,
};

export type EmbeddingConfig = {
  provider: EmbeddingProvider;
  model: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
};

export type EmbeddingProvider = "openai" | "gemini" | "voyage" | "mistral" | "ollama";

/** Provider-agnostic embeddings interface. */
export interface Embeddings {
  embed(text: string): Promise<number[]>;
  readonly dims: number | null;
  probeDims(): Promise<number>;
}

/** OpenAI-compatible embeddings using the /v1/embeddings endpoint. Works with any compatible provider (OpenAI, Ollama, Voyage, etc.). */
export class OpenAICompatibleEmbeddings implements Embeddings {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly extraHeaders?: Record<string, string>;
  private _dims: number | null = null;

  constructor(opts: { baseUrl: string; model: string; apiKey?: string; headers?: Record<string, string> }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.extraHeaders = opts.headers;
    this._dims = KNOWN_DIMS[opts.model] ?? null;
  }

  async embed(text: string): Promise<number[]> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.extraHeaders,
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: this.model, input: text }),
      });
    } catch (err) {
      throw new Error(
        `${EXTENSION_ID}: embedding service not reachable at ${this.baseUrl} — check that the service is running. ${String(err)}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `${EXTENSION_ID}: embedding service returned HTTP ${response.status}: ${body.slice(0, 200)}`,
      );
    }

    const data = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
    const embedding = data.data?.[0]?.embedding;
    if (!Array.isArray(embedding)) {
      throw new Error(`${EXTENSION_ID}: embedding response missing 'data[0].embedding' field`);
    }

    if (this._dims === null) {
      this._dims = embedding.length;
    }

    return embedding;
  }

  get dims(): number | null {
    return this._dims;
  }

  async probeDims(): Promise<number> {
    if (this._dims !== null) {
      return this._dims;
    }
    await this.embed("probe");
    return this._dims!;
  }
}

/** Create an Embeddings instance from config. */
export function createEmbeddings(cfg: EmbeddingConfig): Embeddings {
  return new OpenAICompatibleEmbeddings({
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    apiKey: cfg.apiKey,
    headers: cfg.headers,
  });
}

/**
 * @deprecated Use `OpenAICompatibleEmbeddings` instead. Kept for backward compatibility.
 * Ollama-backed embeddings using native fetch (SSRF-safe: localhost only).
 */
export class OllamaEmbeddings implements Embeddings {
  private readonly baseUrl: string;
  private readonly model: string;
  private _dims: number | null = null;

  constructor(url: string, model: string) {
    // SSRF guard: only allow localhost / loopback addresses
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
      throw new Error(
        `${EXTENSION_ID}: Ollama URL must point to localhost (got ${host}). ` +
          "Embedding requests are only allowed to loopback addresses.",
      );
    }
    this.baseUrl = url.replace(/\/$/, "");
    this.model = model;
    // Pre-populate dims if model is known, avoiding an extra round-trip
    this._dims = KNOWN_DIMS[model] ?? null;
  }

  /** Embed a single text string and return the embedding vector. */
  async embed(text: string): Promise<number[]> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt: text }),
      });
    } catch (err) {
      throw new Error(
        `${EXTENSION_ID}: Ollama not reachable at ${this.baseUrl} — run \`ollama serve\`. ${String(err)}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `${EXTENSION_ID}: Ollama returned HTTP ${response.status}: ${body.slice(0, 200)}`,
      );
    }

    const data = (await response.json()) as { embedding?: number[] };
    if (!Array.isArray(data.embedding)) {
      throw new Error(`${EXTENSION_ID}: Ollama response missing 'embedding' field`);
    }

    // Cache dims after first successful embed (used for LanceDB schema)
    if (this._dims === null) {
      this._dims = data.embedding.length;
    }

    return data.embedding;
  }

  /**
   * The vector dimension for this model.
   * Returns the known dimension immediately, or null if not yet probed.
   * Call embed() at least once to populate from an unknown model.
   */
  get dims(): number | null {
    return this._dims;
  }

  /**
   * Probe Ollama with a short string to determine dims.
   * Only needed for unknown models before the first real embed call.
   */
  async probeDims(): Promise<number> {
    if (this._dims !== null) {
      return this._dims;
    }
    await this.embed("probe");
    return this._dims!;
  }
}
