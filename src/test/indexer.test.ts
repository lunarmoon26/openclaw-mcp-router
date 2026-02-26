import { describe, it, expect, vi, beforeEach } from "vitest";
import { runIndexer, abortableDelay } from "../indexer.js";
import type { McpRouterConfig } from "../config.js";

// Mock McpClient so indexer tests don't need a real MCP server
vi.mock("../mcp-client.js", () => ({
  McpClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([
      { name: "read_file", description: "Read a file from disk", inputSchema: { type: "object" } },
      { name: "list_dir", description: "List directory contents", inputSchema: { type: "object" } },
    ]),
  })),
}));

const mockCfg: McpRouterConfig = {
  servers: [{ name: "fs", transport: "stdio", command: "npx" }],
  embedding: { provider: "ollama", model: "embeddinggemma", baseUrl: "http://localhost:11434/v1" },
  vectorDb: { path: "/tmp/test-lancedb" },
  search: { topK: 5, minScore: 0.3 },
  indexer: { connectTimeout: 60_000, maxRetries: 3, initialRetryDelay: 2_000, maxRetryDelay: 30_000, maxChunkChars: 500, overlapChars: 100 },
};

function makeStore() {
  return {
    upsertTool: vi.fn().mockResolvedValue(undefined),
    searchTools: vi.fn().mockResolvedValue([]),
    deleteServer: vi.fn().mockResolvedValue(undefined),
    deleteToolChunks: vi.fn().mockResolvedValue(undefined),
    addToolEntries: vi.fn().mockResolvedValue(undefined),
    countTools: vi.fn().mockResolvedValue(0),
  };
}

function makeEmbeddings() {
  return {
    embed: vi.fn().mockResolvedValue(Array.from<number>({ length: 768 }).fill(0.1)),
    dims: 768,
    probeDims: vi.fn().mockResolvedValue(768),
  };
}

function makeRegistry() {
  return {
    registerToolOwner: vi.fn(),
    resolveServer: vi.fn(),
    allServers: vi.fn().mockReturnValue(mockCfg.servers),
  };
}

const logger = { info: vi.fn(), warn: vi.fn() };

describe("runIndexer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("indexes tools from all servers and returns counts", async () => {
    const store = makeStore();
    const embeddings = makeEmbeddings();
    const registry = makeRegistry();

    const result = await runIndexer({
      cfg: mockCfg,
      store: store as never,
      embeddings: embeddings as never,
      registry: registry as never,
      logger,
    });

    expect(result.indexed).toBe(2);
    expect(result.failed).toBe(0);
    expect(store.upsertTool).toHaveBeenCalledTimes(2);
    expect(registry.registerToolOwner).toHaveBeenCalledWith("read_file", "fs");
    expect(registry.registerToolOwner).toHaveBeenCalledWith("list_dir", "fs");
    expect(embeddings.embed).toHaveBeenCalledWith("read_file: Read a file from disk");
    expect(embeddings.embed).toHaveBeenCalledWith("list_dir: List directory contents");
  });

  it("logs summary message", async () => {
    const store = makeStore();
    const embeddings = makeEmbeddings();
    const registry = makeRegistry();

    await runIndexer({
      cfg: mockCfg,
      store: store as never,
      embeddings: embeddings as never,
      registry: registry as never,
      logger,
    });

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("indexed 2 tools"),
    );
  });

  it("handles embedding service unavailable gracefully — logs warning, returns failed count", async () => {
    const store = makeStore();
    const embeddings = {
      embed: vi.fn().mockRejectedValue(new Error("embedding service not reachable at http://localhost:11434/v1")),
      dims: null,
      probeDims: vi.fn(),
    };
    const registry = makeRegistry();

    // Use maxRetries: 0 to avoid slow retries in this test
    const cfg = { ...mockCfg, indexer: { ...mockCfg.indexer, maxRetries: 0 } };
    const result = await runIndexer({
      cfg,
      store: store as never,
      embeddings: embeddings as never,
      registry: registry as never,
      logger,
    });

    // Should not throw; failed count should be non-zero
    expect(result.failed).toBeGreaterThan(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("not reachable"));
  });

  it("handles multiple servers in parallel", async () => {
    const { McpClient } = await import("../mcp-client.js");
    vi.mocked(McpClient).mockImplementation(
      () =>
        ({
          connect: vi.fn().mockResolvedValue(undefined),
          disconnect: vi.fn().mockResolvedValue(undefined),
          listTools: vi.fn().mockResolvedValue([
            { name: "tool_a", description: "Tool A", inputSchema: {} },
          ]),
        }) as never,
    );

    const multiCfg: McpRouterConfig = {
      ...mockCfg,
      servers: [
        { name: "server1", transport: "stdio", command: "cmd1" },
        { name: "server2", transport: "stdio", command: "cmd2" },
      ],
    };

    const store = makeStore();
    const embeddings = makeEmbeddings();
    const registry = makeRegistry();

    const result = await runIndexer({
      cfg: multiCfg,
      store: store as never,
      embeddings: embeddings as never,
      registry: registry as never,
      logger,
    });

    // 1 tool per server × 2 servers
    expect(result.indexed).toBe(2);
  });

  // ── Retry behavior ──

  it("retries on connection failure and succeeds on later attempt", async () => {
    const { McpClient } = await import("../mcp-client.js");
    let connectAttempt = 0;
    vi.mocked(McpClient).mockImplementation(
      () =>
        ({
          connect: vi.fn().mockImplementation(() => {
            connectAttempt++;
            if (connectAttempt <= 2) return Promise.reject(new Error("Connection refused"));
            return Promise.resolve();
          }),
          disconnect: vi.fn().mockResolvedValue(undefined),
          listTools: vi.fn().mockResolvedValue([
            { name: "tool_x", description: "Tool X", inputSchema: {} },
          ]),
        }) as never,
    );

    const cfg: McpRouterConfig = {
      ...mockCfg,
      indexer: { ...mockCfg.indexer, connectTimeout: 5_000, maxRetries: 3, initialRetryDelay: 10, maxRetryDelay: 100 },
    };

    const store = makeStore();
    const embeddings = makeEmbeddings();
    const registry = makeRegistry();

    const result = await runIndexer({
      cfg,
      store: store as never,
      embeddings: embeddings as never,
      registry: registry as never,
      logger,
    });

    expect(result.indexed).toBe(1);
    expect(result.failed).toBe(0);
    expect(connectAttempt).toBe(3); // failed 2 times, succeeded on 3rd
  });

  it("gives up after maxRetries and returns failed count", async () => {
    const { McpClient } = await import("../mcp-client.js");
    vi.mocked(McpClient).mockImplementation(
      () =>
        ({
          connect: vi.fn().mockRejectedValue(new Error("Connection refused")),
          disconnect: vi.fn().mockResolvedValue(undefined),
          listTools: vi.fn().mockResolvedValue([]),
        }) as never,
    );

    const cfg: McpRouterConfig = {
      ...mockCfg,
      indexer: { ...mockCfg.indexer, connectTimeout: 5_000, maxRetries: 2, initialRetryDelay: 10, maxRetryDelay: 100 },
    };

    const store = makeStore();
    const embeddings = makeEmbeddings();
    const registry = makeRegistry();

    const result = await runIndexer({
      cfg,
      store: store as never,
      embeddings: embeddings as never,
      registry: registry as never,
      logger,
    });

    expect(result.indexed).toBe(0);
    expect(result.failed).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("failed to index server"));
  });

  it("cancels immediately when signal is pre-aborted", async () => {
    const store = makeStore();
    const embeddings = makeEmbeddings();
    const registry = makeRegistry();

    const abort = new AbortController();
    abort.abort(new Error("already aborted"));

    const result = await runIndexer({
      cfg: mockCfg,
      store: store as never,
      embeddings: embeddings as never,
      registry: registry as never,
      logger,
      signal: abort.signal,
    });

    // allSettled catches the abort — shows up as failed
    expect(result.failed).toBeGreaterThan(0);
    expect(store.upsertTool).not.toHaveBeenCalled();
  });

  it("aborts mid-retry without waiting for full backoff delay", async () => {
    const { McpClient } = await import("../mcp-client.js");
    vi.mocked(McpClient).mockImplementation(
      () =>
        ({
          connect: vi.fn().mockRejectedValue(new Error("Connection refused")),
          disconnect: vi.fn().mockResolvedValue(undefined),
          listTools: vi.fn().mockResolvedValue([]),
        }) as never,
    );

    // Use a very long retry delay to prove abort cuts it short
    const cfg: McpRouterConfig = {
      ...mockCfg,
      indexer: { ...mockCfg.indexer, connectTimeout: 5_000, maxRetries: 3, initialRetryDelay: 60_000, maxRetryDelay: 60_000 },
    };

    const abort = new AbortController();
    const store = makeStore();
    const embeddings = makeEmbeddings();
    const registry = makeRegistry();

    // Abort after a small delay — well before the 60s backoff would resolve
    setTimeout(() => abort.abort(new Error("cancelled")), 50);

    const start = Date.now();
    const result = await runIndexer({
      cfg,
      store: store as never,
      embeddings: embeddings as never,
      registry: registry as never,
      logger,
      signal: abort.signal,
    });
    const elapsed = Date.now() - start;

    expect(result.failed).toBeGreaterThan(0);
    // Should complete much faster than the 60s backoff
    expect(elapsed).toBeLessThan(5_000);
  });

  it("passes per-server timeout to McpClient.connect()", async () => {
    const { McpClient } = await import("../mcp-client.js");
    const mockConnect = vi.fn().mockResolvedValue(undefined);
    vi.mocked(McpClient).mockImplementation(
      () =>
        ({
          connect: mockConnect,
          disconnect: vi.fn().mockResolvedValue(undefined),
          listTools: vi.fn().mockResolvedValue([]),
        }) as never,
    );

    const cfg: McpRouterConfig = {
      ...mockCfg,
      servers: [{ name: "slow", transport: "stdio", command: "uvx", timeout: 120_000 }],
    };

    const store = makeStore();
    const embeddings = makeEmbeddings();
    const registry = makeRegistry();

    await runIndexer({
      cfg,
      store: store as never,
      embeddings: embeddings as never,
      registry: registry as never,
      logger,
    });

    expect(mockConnect).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: 120_000 }),
    );
  });

  // ── Chunking behavior ──

  it("uses single upsertTool for short descriptions (fast path)", async () => {
    const { McpClient } = await import("../mcp-client.js");
    vi.mocked(McpClient).mockImplementation(
      () =>
        ({
          connect: vi.fn().mockResolvedValue(undefined),
          disconnect: vi.fn().mockResolvedValue(undefined),
          listTools: vi.fn().mockResolvedValue([
            { name: "read_file", description: "Read a file from disk", inputSchema: { type: "object" } },
            { name: "list_dir", description: "List directory contents", inputSchema: { type: "object" } },
          ]),
        }) as never,
    );

    const store = makeStore();
    const embeddings = makeEmbeddings();
    const registry = makeRegistry();

    const result = await runIndexer({
      cfg: mockCfg,
      store: store as never,
      embeddings: embeddings as never,
      registry: registry as never,
      logger,
    });

    expect(result.indexed).toBe(2);
    expect(store.upsertTool).toHaveBeenCalledTimes(2);
    expect(store.deleteToolChunks).not.toHaveBeenCalled();
    expect(store.addToolEntries).not.toHaveBeenCalled();
  });

  it("uses deleteToolChunks + addToolEntries for long descriptions", async () => {
    const { McpClient } = await import("../mcp-client.js");
    const longDesc = "x".repeat(3000);
    vi.mocked(McpClient).mockImplementation(
      () =>
        ({
          connect: vi.fn().mockResolvedValue(undefined),
          disconnect: vi.fn().mockResolvedValue(undefined),
          listTools: vi.fn().mockResolvedValue([
            { name: "big_tool", description: longDesc, inputSchema: { type: "object" } },
          ]),
        }) as never,
    );

    const store = makeStore();
    const embeddings = makeEmbeddings();
    const registry = makeRegistry();

    // Use small chunk size to force multi-chunk
    const cfg: McpRouterConfig = {
      ...mockCfg,
      indexer: { ...mockCfg.indexer, maxChunkChars: 500, overlapChars: 50 },
    };

    const result = await runIndexer({
      cfg,
      store: store as never,
      embeddings: embeddings as never,
      registry: registry as never,
      logger,
    });

    expect(result.indexed).toBe(1); // counts tools, not chunks
    expect(store.upsertTool).not.toHaveBeenCalled();
    expect(store.deleteToolChunks).toHaveBeenCalledWith("fs", "big_tool");
    expect(store.addToolEntries).toHaveBeenCalledTimes(1);

    // Check that entries have correct tool_id format
    const entries = store.addToolEntries.mock.calls[0][0];
    expect(entries.length).toBeGreaterThan(1);
    expect(entries[0].tool_id).toBe("fs::big_tool::chunk0");
    expect(entries[1].tool_id).toBe("fs::big_tool::chunk1");

    // All entries should have the full description and parameters
    for (const entry of entries) {
      expect(entry.description).toBe(longDesc);
      expect(entry.server_name).toBe("fs");
      expect(entry.tool_name).toBe("big_tool");
    }
  });

  it("disables chunking when maxChunkChars is 0", async () => {
    const { McpClient } = await import("../mcp-client.js");
    const longDesc = "x".repeat(3000);
    vi.mocked(McpClient).mockImplementation(
      () =>
        ({
          connect: vi.fn().mockResolvedValue(undefined),
          disconnect: vi.fn().mockResolvedValue(undefined),
          listTools: vi.fn().mockResolvedValue([
            { name: "big_tool", description: longDesc, inputSchema: { type: "object" } },
          ]),
        }) as never,
    );

    const store = makeStore();
    const embeddings = makeEmbeddings();
    const registry = makeRegistry();

    const cfg: McpRouterConfig = {
      ...mockCfg,
      indexer: { ...mockCfg.indexer, maxChunkChars: 0, overlapChars: 200 },
    };

    const result = await runIndexer({
      cfg,
      store: store as never,
      embeddings: embeddings as never,
      registry: registry as never,
      logger,
    });

    expect(result.indexed).toBe(1);
    // Should use single upsertTool even for long description
    expect(store.upsertTool).toHaveBeenCalledTimes(1);
    expect(store.deleteToolChunks).not.toHaveBeenCalled();
    expect(store.addToolEntries).not.toHaveBeenCalled();
  });

  it("falls back to indexer.connectTimeout when server has no timeout", async () => {
    const { McpClient } = await import("../mcp-client.js");
    const mockConnect = vi.fn().mockResolvedValue(undefined);
    vi.mocked(McpClient).mockImplementation(
      () =>
        ({
          connect: mockConnect,
          disconnect: vi.fn().mockResolvedValue(undefined),
          listTools: vi.fn().mockResolvedValue([]),
        }) as never,
    );

    const cfg: McpRouterConfig = {
      ...mockCfg,
      servers: [{ name: "normal", transport: "stdio", command: "npx" }],
      indexer: { ...mockCfg.indexer, connectTimeout: 45_000 },
    };

    const store = makeStore();
    const embeddings = makeEmbeddings();
    const registry = makeRegistry();

    await runIndexer({
      cfg,
      store: store as never,
      embeddings: embeddings as never,
      registry: registry as never,
      logger,
    });

    expect(mockConnect).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: 45_000 }),
    );
  });
});

describe("abortableDelay", () => {
  it("resolves after the specified delay", async () => {
    const start = Date.now();
    await abortableDelay(50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });

  it("rejects immediately when signal is already aborted", async () => {
    const abort = new AbortController();
    abort.abort(new Error("pre-aborted"));
    await expect(abortableDelay(10_000, abort.signal)).rejects.toThrow("pre-aborted");
  });

  it("rejects when signal is aborted during delay", async () => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(new Error("mid-delay")), 20);

    const start = Date.now();
    await expect(abortableDelay(10_000, abort.signal)).rejects.toThrow("mid-delay");
    expect(Date.now() - start).toBeLessThan(5_000);
  });
});
