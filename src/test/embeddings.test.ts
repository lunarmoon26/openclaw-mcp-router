import { describe, it, expect, vi, beforeEach } from "vitest";
import { OllamaEmbeddings } from "../embeddings.js";

describe("OllamaEmbeddings", () => {
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
