import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMcpCallTool } from "../../tools/mcp-call-tool.js";

const fsServerCfg = { name: "fs", transport: "stdio" as const, command: "npx" };

// Mock McpClient for call-tool tests
vi.mock("../../mcp-client.js", () => ({
  McpClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "file contents here" }],
      isError: false,
    }),
  })),
}));

function makeRegistry(resolved: typeof fsServerCfg | undefined = fsServerCfg) {
  return {
    resolveServer: vi.fn().mockReturnValue(resolved),
    registerToolOwner: vi.fn(),
    allServers: vi.fn(),
  };
}

const logger = { warn: vi.fn(), info: vi.fn() };

describe("mcp_call tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error when tool_name is missing", async () => {
    const tool = createMcpCallTool({ registry: makeRegistry() as never, logger });
    const result = await tool.execute("id", {});
    expect(result.content[0].text).toContain("tool_name is required");
  });

  it("returns error for invalid params_json", async () => {
    const tool = createMcpCallTool({ registry: makeRegistry() as never, logger });
    const result = await tool.execute("id", { tool_name: "read_file", params_json: "not-json" });
    expect(result.content[0].text).toContain("invalid params_json");
  });

  it("returns error when params_json is an array", async () => {
    const tool = createMcpCallTool({ registry: makeRegistry() as never, logger });
    const result = await tool.execute("id", { tool_name: "read_file", params_json: "[]" });
    expect(result.content[0].text).toContain("JSON object");
  });

  it("returns error when tool is not found in registry", async () => {
    const tool = createMcpCallTool({
      registry: makeRegistry(undefined) as never,
      logger,
    });
    const result = await tool.execute("id", { tool_name: "unknown_tool" });
    expect(result.content[0].text).toContain("unknown tool");
    expect(result.content[0].text).toContain("mcp_search");
  });

  it("calls the MCP tool and returns result", async () => {
    const tool = createMcpCallTool({ registry: makeRegistry() as never, logger });
    const result = await tool.execute("id", {
      tool_name: "read_file",
      params_json: '{"path":"/tmp/test.txt"}',
    });

    expect(result.content[0].text).toBe("file contents here");
    expect(result.details).toMatchObject({
      tool: "read_file",
      server: "fs",
      isError: false,
    });
  });

  it("defaults params_json to empty object when omitted", async () => {
    const { McpClient } = await import("../../mcp-client.js");
    const callToolMock = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      isError: false,
    });
    vi.mocked(McpClient).mockImplementation(
      () =>
        ({
          connect: vi.fn().mockResolvedValue(undefined),
          disconnect: vi.fn().mockResolvedValue(undefined),
          callTool: callToolMock,
        }) as never,
    );

    const tool = createMcpCallTool({ registry: makeRegistry() as never, logger });
    await tool.execute("id", { tool_name: "list_dir" });
    expect(callToolMock).toHaveBeenCalledWith("list_dir", {});
  });

  it("disconnects client even when callTool throws", async () => {
    const { McpClient } = await import("../../mcp-client.js");
    const disconnectMock = vi.fn().mockResolvedValue(undefined);
    vi.mocked(McpClient).mockImplementation(
      () =>
        ({
          connect: vi.fn().mockResolvedValue(undefined),
          disconnect: disconnectMock,
          callTool: vi.fn().mockRejectedValue(new Error("timeout")),
        }) as never,
    );

    const tool = createMcpCallTool({ registry: makeRegistry() as never, logger });
    const result = await tool.execute("id", { tool_name: "read_file" });

    expect(disconnectMock).toHaveBeenCalled();
    expect(result.details).toMatchObject({ isError: true });
  });
});
