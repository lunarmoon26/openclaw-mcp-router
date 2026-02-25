import { describe, it, expect, vi, beforeEach } from "vitest";
import { runIndexer } from "../indexer.js";
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
  embedding: { provider: "ollama", model: "nomic-embed-text", url: "http://localhost:11434" },
  vectorDb: { path: "/tmp/test-lancedb" },
  search: { topK: 5, minScore: 0.3 },
};

function makeStore() {
  return {
    upsertTool: vi.fn().mockResolvedValue(undefined),
    searchTools: vi.fn().mockResolvedValue([]),
    deleteServer: vi.fn().mockResolvedValue(undefined),
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

  it("handles Ollama unavailable gracefully — logs warning, returns failed count", async () => {
    const store = makeStore();
    const embeddings = {
      embed: vi.fn().mockRejectedValue(new Error("Ollama not reachable — run `ollama serve`")),
      dims: null,
      probeDims: vi.fn(),
    };
    const registry = makeRegistry();

    const result = await runIndexer({
      cfg: mockCfg,
      store: store as never,
      embeddings: embeddings as never,
      registry: registry as never,
      logger,
    });

    // Should not throw; failed count should be non-zero
    expect(result.failed).toBeGreaterThan(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("ollama serve"));
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
});
