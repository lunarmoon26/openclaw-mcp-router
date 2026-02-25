import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMcpSearchTool } from "../../tools/mcp-search-tool.js";

const mockVector = Array.from<number>({ length: 768 }).fill(0.1);

function makeEmbeddings(overrides?: Partial<{ embed: () => Promise<number[]> }>) {
  return {
    embed: vi.fn().mockResolvedValue(mockVector),
    dims: 768,
    ...overrides,
  };
}

function makeStore(results: Array<{ entry: Record<string, unknown>; score: number }> = []) {
  return {
    searchTools: vi.fn().mockResolvedValue(results),
  };
}

function makeTool(storeResults = makeStore()) {
  return createMcpSearchTool({
    store: storeResults as never,
    embeddings: makeEmbeddings() as never,
    cfg: { topK: 5, minScore: 0.3 },
  });
}

describe("mcp_search tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error when query is empty", async () => {
    const tool = makeTool();
    const result = await tool.execute("id", { query: "" });
    expect(result.content[0].text).toContain("required");
  });

  it("returns no-results message when store returns empty", async () => {
    const store = makeStore([]);
    const tool = createMcpSearchTool({
      store: store as never,
      embeddings: makeEmbeddings() as never,
      cfg: { topK: 5, minScore: 0.3 },
    });

    const result = await tool.execute("id", { query: "list files" });
    expect(result.content[0].text).toContain("No matching");
    expect(result.details).toMatchObject({ count: 0 });
  });

  it("returns formatted tool cards for results", async () => {
    const store = makeStore([
      {
        entry: {
          tool_id: "fs::read_file",
          server_name: "fs",
          tool_name: "read_file",
          description: "Read a file from disk",
          parameters_json: '{"type":"object"}',
          vector: mockVector,
        },
        score: 0.87,
      },
    ]);

    const tool = createMcpSearchTool({
      store: store as never,
      embeddings: makeEmbeddings() as never,
      cfg: { topK: 5, minScore: 0.3 },
    });

    const result = await tool.execute("id", { query: "read file" });
    expect(result.content[0].text).toContain("read_file");
    expect(result.content[0].text).toContain("server: fs");
    expect(result.content[0].text).toContain("87%");
    expect(result.details).toMatchObject({ count: 1 });
  });

  it("clamps limit to [1,20]", async () => {
    const store = makeStore();
    const tool = createMcpSearchTool({
      store: store as never,
      embeddings: makeEmbeddings() as never,
      cfg: { topK: 5, minScore: 0.3 },
    });

    await tool.execute("id", { query: "test", limit: 999 });
    expect(store.searchTools).toHaveBeenCalledWith(mockVector, 20, 0.3);

    await tool.execute("id", { query: "test", limit: 0 });
    expect(store.searchTools).toHaveBeenCalledWith(mockVector, 1, 0.3);
  });

  it("truncates parameters_json longer than 2000 chars", async () => {
    const longSchema = "x".repeat(3000);
    const store = makeStore([
      {
        entry: {
          tool_id: "s::t",
          server_name: "s",
          tool_name: "t",
          description: "desc",
          parameters_json: longSchema,
          vector: mockVector,
        },
        score: 0.9,
      },
    ]);

    const tool = createMcpSearchTool({
      store: store as never,
      embeddings: makeEmbeddings() as never,
      cfg: { topK: 5, minScore: 0.3 },
    });

    const result = await tool.execute("id", { query: "test" });
    expect(result.content[0].text).toContain("truncated");
  });

  it("returns friendly error when embedding fails", async () => {
    const embeddings = makeEmbeddings({
      embed: vi.fn().mockRejectedValue(new Error("Ollama not reachable")),
    });

    const tool = createMcpSearchTool({
      store: makeStore() as never,
      embeddings: embeddings as never,
      cfg: { topK: 5, minScore: 0.3 },
    });

    const result = await tool.execute("id", { query: "files" });
    expect(result.content[0].text).toContain("embedding failed");
  });
});
