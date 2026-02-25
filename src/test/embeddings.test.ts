import { describe, it, expect, vi, beforeEach } from "vitest";
import { OllamaEmbeddings, OpenAICompatibleEmbeddings, createEmbeddings } from "../embeddings.js";

// ── OpenAICompatibleEmbeddings ──

describe("OpenAICompatibleEmbeddings", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("calls /embeddings and returns vector", async () => {
    const mockEmbed = [0.1, 0.2, 0.3];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: mockEmbed }] }),
      }),
    );

    const emb = new OpenAICompatibleEmbeddings({
      baseUrl: "https://api.openai.com/v1",
      model: "text-embedding-3-small",
      apiKey: "sk-test",
    });
    const result = await emb.embed("hello world");

    expect(result).toEqual(mockEmbed);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "https://api.openai.com/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ model: "text-embedding-3-small", input: "hello world" }),
      }),
    );
  });

  it("sends Authorization header when apiKey is provided", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: [0.1] }] }),
      }),
    );

    const emb = new OpenAICompatibleEmbeddings({
      baseUrl: "http://localhost:11434/v1",
      model: "nomic-embed-text",
      apiKey: "sk-test",
    });
    await emb.embed("test");

    const callArgs = vi.mocked(fetch).mock.calls[0];
    const headers = (callArgs[1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");
  });

  it("does not send Authorization header when apiKey is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: [0.1] }] }),
      }),
    );

    const emb = new OpenAICompatibleEmbeddings({
      baseUrl: "http://localhost:11434/v1",
      model: "nomic-embed-text",
    });
    await emb.embed("test");

    const callArgs = vi.mocked(fetch).mock.calls[0];
    const headers = (callArgs[1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("merges custom headers into requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: [0.1] }] }),
      }),
    );

    const emb = new OpenAICompatibleEmbeddings({
      baseUrl: "http://localhost:11434/v1",
      model: "nomic-embed-text",
      headers: { "X-Custom": "custom-value" },
    });
    await emb.embed("test");

    const callArgs = vi.mocked(fetch).mock.calls[0];
    const headers = (callArgs[1] as RequestInit).headers as Record<string, string>;
    expect(headers["X-Custom"]).toBe("custom-value");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("pre-populates dims for known models", () => {
    const emb = new OpenAICompatibleEmbeddings({
      baseUrl: "https://api.openai.com/v1",
      model: "text-embedding-3-small",
    });
    expect(emb.dims).toBe(1536);

    const emb2 = new OpenAICompatibleEmbeddings({
      baseUrl: "http://localhost:11434/v1",
      model: "nomic-embed-text",
    });
    expect(emb2.dims).toBe(768);
  });

  it("dims is null for unknown model before embed", () => {
    const emb = new OpenAICompatibleEmbeddings({
      baseUrl: "http://localhost:11434/v1",
      model: "unknown-model",
    });
    expect(emb.dims).toBeNull();
  });

  it("caches dims after first successful embed for unknown model", async () => {
    const mockEmbed = Array.from<number>({ length: 512 }).fill(0.1);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: mockEmbed }] }),
      }),
    );

    const emb = new OpenAICompatibleEmbeddings({
      baseUrl: "http://localhost:11434/v1",
      model: "custom-model",
    });
    expect(emb.dims).toBeNull();
    await emb.embed("probe");
    expect(emb.dims).toBe(512);
  });

  it("throws a friendly error when service is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const emb = new OpenAICompatibleEmbeddings({
      baseUrl: "http://localhost:11434/v1",
      model: "nomic-embed-text",
    });
    await expect(emb.embed("test")).rejects.toThrow("embedding service not reachable");
  });

  it("throws on non-OK HTTP response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => "unauthorized",
      }),
    );

    const emb = new OpenAICompatibleEmbeddings({
      baseUrl: "https://api.openai.com/v1",
      model: "text-embedding-3-small",
      apiKey: "bad-key",
    });
    await expect(emb.embed("test")).rejects.toThrow("401");
  });

  it("throws when response is missing data field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ unexpected: true }),
      }),
    );

    const emb = new OpenAICompatibleEmbeddings({
      baseUrl: "http://localhost:11434/v1",
      model: "nomic-embed-text",
    });
    await expect(emb.embed("test")).rejects.toThrow("data[0].embedding");
  });

  it("strips trailing slash from baseUrl", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: [0.1] }] }),
      }),
    );

    const emb = new OpenAICompatibleEmbeddings({
      baseUrl: "http://localhost:11434/v1/",
      model: "nomic-embed-text",
    });
    await emb.embed("test");

    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "http://localhost:11434/v1/embeddings",
      expect.anything(),
    );
  });

  it("probeDims returns cached dims without network call", async () => {
    const emb = new OpenAICompatibleEmbeddings({
      baseUrl: "http://localhost:11434/v1",
      model: "nomic-embed-text",
    });
    const dims = await emb.probeDims();
    expect(dims).toBe(768);
  });

  it("probeDims probes for unknown models", async () => {
    const mockEmbed = Array.from<number>({ length: 256 }).fill(0.1);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: mockEmbed }] }),
      }),
    );

    const emb = new OpenAICompatibleEmbeddings({
      baseUrl: "http://localhost:11434/v1",
      model: "custom-model",
    });
    const dims = await emb.probeDims();
    expect(dims).toBe(256);
  });
});

// ── createEmbeddings factory ──

describe("createEmbeddings", () => {
  it("returns OpenAICompatibleEmbeddings for all providers", () => {
    const providers = ["openai", "ollama", "voyage", "gemini", "mistral"] as const;
    for (const provider of providers) {
      const emb = createEmbeddings({
        provider,
        model: "test-model",
        baseUrl: "http://localhost/v1",
      });
      expect(emb).toBeInstanceOf(OpenAICompatibleEmbeddings);
    }
  });
});

// ── OllamaEmbeddings (deprecated, backward compat) ──

describe("OllamaEmbeddings (deprecated)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects non-localhost URLs", () => {
    expect(() => new OllamaEmbeddings("http://example.com:11434", "nomic-embed-text")).toThrow(
      "localhost",
    );
    expect(() => new OllamaEmbeddings("http://10.0.0.1:11434", "nomic-embed-text")).toThrow(
      "localhost",
    );
  });

  it("accepts localhost and 127.0.0.1", () => {
    expect(() => new OllamaEmbeddings("http://localhost:11434", "nomic-embed-text")).not.toThrow();
    expect(
      () => new OllamaEmbeddings("http://127.0.0.1:11434", "nomic-embed-text"),
    ).not.toThrow();
  });

  it("pre-populates dims for known models", () => {
    const emb = new OllamaEmbeddings("http://localhost:11434", "nomic-embed-text");
    expect(emb.dims).toBe(768);

    const emb2 = new OllamaEmbeddings("http://localhost:11434", "mxbai-embed-large");
    expect(emb2.dims).toBe(1024);
  });

  it("dims is null for unknown model before embed", () => {
    const emb = new OllamaEmbeddings("http://localhost:11434", "unknown-model");
    expect(emb.dims).toBeNull();
  });

  it("calls /api/embeddings and returns vector", async () => {
    const mockEmbed = [0.1, 0.2, 0.3];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ embedding: mockEmbed }),
      }),
    );

    const emb = new OllamaEmbeddings("http://localhost:11434", "nomic-embed-text");
    const result = await emb.embed("hello world");

    expect(result).toEqual(mockEmbed);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "http://localhost:11434/api/embeddings",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws a friendly error when Ollama is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const emb = new OllamaEmbeddings("http://localhost:11434", "nomic-embed-text");
    await expect(emb.embed("test")).rejects.toThrow("ollama serve");
  });

  it("throws on non-OK HTTP response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => "model not found",
      }),
    );

    const emb = new OllamaEmbeddings("http://localhost:11434", "nomic-embed-text");
    await expect(emb.embed("test")).rejects.toThrow("404");
  });

  it("caches dims after first successful embed for unknown model", async () => {
    const mockEmbed = Array.from<number>({ length: 512 }).fill(0.1);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ embedding: mockEmbed }),
      }),
    );

    const emb = new OllamaEmbeddings("http://localhost:11434", "custom-model");
    expect(emb.dims).toBeNull();
    await emb.embed("probe");
    expect(emb.dims).toBe(512);
  });
});
