// Known embedding dimensions by model name (avoids a probe round-trip for common models)
const KNOWN_DIMS: Record<string, number> = {
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
  "all-minilm": 384,
};

/** Ollama-backed embeddings using native fetch (SSRF-safe: localhost only). */
export class OllamaEmbeddings {
  private readonly baseUrl: string;
  private readonly model: string;
  private _dims: number | null = null;

  constructor(url: string, model: string) {
    // SSRF guard: only allow localhost / loopback addresses
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
      throw new Error(
        `mcp-router: Ollama URL must point to localhost (got ${host}). ` +
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
        `mcp-router: Ollama not reachable at ${this.baseUrl} — run \`ollama serve\`. ${String(err)}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `mcp-router: Ollama returned HTTP ${response.status}: ${body.slice(0, 200)}`,
      );
    }

    const data = (await response.json()) as { embedding?: number[] };
    if (!Array.isArray(data.embedding)) {
      throw new Error("mcp-router: Ollama response missing 'embedding' field");
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
