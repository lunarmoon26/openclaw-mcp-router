import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseConfig } from "../config.js";
import { EXTENSION_ID } from "../constants.js";

// Mock fs for mcpServersFile tests
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, default: { ...actual, readFileSync: vi.fn() } };
});

import fs from "node:fs";

describe("parseConfig", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Default: file not found for auto-load
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
  });

  afterEach(() => {
    delete process.env.TEST_MCP_TOKEN;
    delete process.env.TEST_API_KEY;
    delete process.env.OPENCLAW_CONFIG_PATH;
    delete process.env.OPENCLAW_STATE_DIR;
  });

  // ── Basic validation ──

  it("throws when config is not an object", () => {
    expect(() => parseConfig("bad")).toThrow("must be an object");
    expect(() => parseConfig(42)).toThrow("must be an object");
    expect(() => parseConfig([])).toThrow("must be an object");
  });

  it("treats null/undefined as empty config with no servers", () => {
    const cfg1 = parseConfig(null);
    expect(cfg1.servers).toHaveLength(0);
    const cfg2 = parseConfig(undefined);
    expect(cfg2.servers).toHaveLength(0);
  });

  it("returns empty servers when no servers are configured from any source", () => {
    const cfg = parseConfig({});
    expect(cfg.servers).toHaveLength(0);
  });

  // ── Legacy servers[] ──

  it("returns empty servers when legacy servers is empty", () => {
    const cfg = parseConfig({ servers: [] });
    expect(cfg.servers).toHaveLength(0);
  });

  it("throws when stdio server is missing command", () => {
    expect(() =>
      parseConfig({
        servers: [{ name: "fs", transport: "stdio" }],
      }),
    ).toThrow("command");
  });

  it("throws when sse server is missing url", () => {
    expect(() =>
      parseConfig({
        servers: [{ name: "remote", transport: "sse" }],
      }),
    ).toThrow("url");
  });

  it("throws on invalid transport", () => {
    expect(() =>
      parseConfig({
        servers: [{ name: "bad", transport: "websocket" }],
      }),
    ).toThrow("transport");
  });

  it("parses a minimal valid config with defaults", () => {
    const cfg = parseConfig({
      servers: [{ name: "fs", transport: "stdio", command: "npx" }],
    });

    expect(cfg.servers).toHaveLength(1);
    expect(cfg.servers[0].name).toBe("fs");
    expect(cfg.servers[0].transport).toBe("stdio");
    expect(cfg.servers[0].command).toBe("npx");

    // defaults
    expect(cfg.embedding.provider).toBe("ollama");
    expect(cfg.embedding.model).toBe("embeddinggemma");
    expect(cfg.embedding.baseUrl).toBe("http://localhost:11434/v1");
    expect(cfg.search.topK).toBe(5);
    expect(cfg.search.minScore).toBe(0.3);
    expect(cfg.vectorDb.path).toContain(EXTENSION_ID);
  });

  it("clamps topK to valid range", () => {
    const low = parseConfig({
      servers: [{ name: "s", transport: "stdio", command: "x" }],
      search: { topK: 0 },
    });
    expect(low.search.topK).toBe(1);

    const high = parseConfig({
      servers: [{ name: "s", transport: "stdio", command: "x" }],
      search: { topK: 999 },
    });
    expect(high.search.topK).toBe(20);
  });

  it("expands ${VAR} in env values", () => {
    process.env.TEST_MCP_TOKEN = "secret123";
    const cfg = parseConfig({
      servers: [
        {
          name: "fs",
          transport: "stdio",
          command: "npx",
          env: { TOKEN: "${TEST_MCP_TOKEN}" },
        },
      ],
    });
    expect(cfg.servers[0].env?.TOKEN).toBe("secret123");
  });

  it("resolves ~ in vectorDb path", () => {
    const cfg = parseConfig({
      servers: [{ name: "s", transport: "stdio", command: "x" }],
      vectorDb: { path: "~/custom/db" },
    });
    expect(cfg.vectorDb.path).not.toContain("~");
    expect(cfg.vectorDb.path).toContain("custom/db");
  });

  it("accepts sse server with url", () => {
    const cfg = parseConfig({
      servers: [{ name: "gh", transport: "sse", url: "https://api.example.com/mcp/" }],
    });
    expect(cfg.servers[0].url).toBe("https://api.example.com/mcp/");
  });

  // ── mcpServers dict ──

  it("infers stdio transport from command in mcpServers dict", () => {
    const cfg = parseConfig({
      mcpServers: {
        fs: { command: "npx", args: ["-y", "@anthropic/mcp-fs"] },
      },
    });

    expect(cfg.servers).toHaveLength(1);
    expect(cfg.servers[0].name).toBe("fs");
    expect(cfg.servers[0].transport).toBe("stdio");
    expect(cfg.servers[0].command).toBe("npx");
    expect(cfg.servers[0].args).toEqual(["-y", "@anthropic/mcp-fs"]);
  });

  it("infers http transport from url in mcpServers dict", () => {
    const cfg = parseConfig({
      mcpServers: {
        remote: { url: "https://mcp.example.com/api" },
      },
    });

    expect(cfg.servers[0].transport).toBe("http");
    expect(cfg.servers[0].url).toBe("https://mcp.example.com/api");
  });

  it("infers http transport from serverUrl in mcpServers dict", () => {
    const cfg = parseConfig({
      mcpServers: {
        remote: { serverUrl: "https://mcp.example.com/api" },
      },
    });

    expect(cfg.servers[0].transport).toBe("http");
    expect(cfg.servers[0].url).toBe("https://mcp.example.com/api");
  });

  it("allows type override to sse in mcpServers dict", () => {
    const cfg = parseConfig({
      mcpServers: {
        legacy: { url: "https://legacy.example.com/sse", type: "sse" },
      },
    });

    expect(cfg.servers[0].transport).toBe("sse");
  });

  it("throws on invalid type override in mcpServers dict", () => {
    expect(() =>
      parseConfig({
        mcpServers: {
          bad: { url: "https://example.com", type: "websocket" },
        },
      }),
    ).toThrow("type must be stdio, sse, or http");
  });

  it("throws when mcpServers entry has neither command nor url", () => {
    expect(() =>
      parseConfig({
        mcpServers: { bad: { args: ["foo"] } },
      }),
    ).toThrow('must have either "command"');
  });

  it("expands ${VAR} in mcpServers header values", () => {
    process.env.TEST_API_KEY = "key-abc";
    const cfg = parseConfig({
      mcpServers: {
        remote: {
          url: "https://api.example.com",
          headers: { Authorization: "Bearer ${TEST_API_KEY}" },
        },
      },
    });

    expect(cfg.servers[0].headers?.Authorization).toBe("Bearer key-abc");
  });

  // ── Server resolution: merge and priority ──

  it("mcpServers wins over legacy servers", () => {
    const cfg = parseConfig({
      mcpServers: {
        newServer: { command: "new-cmd" },
      },
      servers: [{ name: "oldServer", transport: "stdio", command: "old-cmd" }],
    });

    expect(cfg.servers).toHaveLength(1);
    expect(cfg.servers[0].name).toBe("newServer");
  });

  // ── mcpServersFile ──

  it("loads servers from mcpServersFile", () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        fs: { command: "npx", args: ["-y", "mcp-fs"] },
        github: { url: "https://github.mcp.example.com" },
      }),
    );

    const cfg = parseConfig({ mcpServersFile: "~/my-servers.json" });

    expect(cfg.servers).toHaveLength(2);
    expect(cfg.servers.find((s) => s.name === "fs")?.transport).toBe("stdio");
    expect(cfg.servers.find((s) => s.name === "github")?.transport).toBe("http");
  });

  it("supports { mcpServers: {...} } wrapper format in file", () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        mcpServers: {
          wrapped: { command: "cmd" },
        },
      }),
    );

    const cfg = parseConfig({ mcpServersFile: "~/.mcp.json" });

    expect(cfg.servers).toHaveLength(1);
    expect(cfg.servers[0].name).toBe("wrapped");
  });

  it("auto-loads default ~/.openclaw/openclaw-mcp-router/.mcp.json when no servers configured", () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        autoloaded: { command: "auto-cmd" },
      }),
    );

    const cfg = parseConfig({});

    expect(cfg.servers).toHaveLength(1);
    expect(cfg.servers[0].name).toBe("autoloaded");
    expect(vi.mocked(fs.readFileSync)).toHaveBeenCalledWith(
      expect.stringMatching(/\.openclaw[/\\]openclaw-mcp-router[/\\]\.mcp\.json$/),
      "utf-8",
    );
  });

  it("auto-load path uses OPENCLAW_CONFIG_PATH env var base dir", () => {
    process.env.OPENCLAW_CONFIG_PATH = "/custom/dir/openclaw.json";
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ envServer: { command: "env-cmd" } }),
    );

    const cfg = parseConfig({});

    expect(vi.mocked(fs.readFileSync)).toHaveBeenCalledWith(
      "/custom/dir/openclaw-mcp-router/.mcp.json",
      "utf-8",
    );
    expect(cfg.servers[0].name).toBe("envServer");
  });

  it("auto-load path uses OPENCLAW_STATE_DIR env var", () => {
    process.env.OPENCLAW_STATE_DIR = "/state/dir";
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ stateServer: { command: "state-cmd" } }),
    );

    const cfg = parseConfig({});

    expect(vi.mocked(fs.readFileSync)).toHaveBeenCalledWith(
      "/state/dir/openclaw-mcp-router/.mcp.json",
      "utf-8",
    );
    expect(cfg.servers[0].name).toBe("stateServer");
  });

  it("auto-loads .mcp.json even when mcpServers is an empty object", () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ fromFile: { command: "file-cmd" } }),
    );
    const cfg = parseConfig({ mcpServers: {} });
    expect(cfg.servers).toHaveLength(1);
    expect(cfg.servers[0].name).toBe("fromFile");
  });

  it("merges inline mcpServers with .mcp.json servers", () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ fileServer: { command: "file-cmd" } }),
    );
    const cfg = parseConfig({
      mcpServers: { inlineServer: { command: "inline-cmd" } },
    });
    expect(cfg.servers).toHaveLength(2);
    expect(cfg.servers.find((s) => s.name === "fileServer")).toBeDefined();
    expect(cfg.servers.find((s) => s.name === "inlineServer")).toBeDefined();
  });

  it("inline mcpServers wins over .mcp.json on name collision", () => {
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ server1: { command: "file-cmd" } }),
    );
    const cfg = parseConfig({
      mcpServers: { server1: { command: "inline-cmd" } },
    });
    expect(cfg.servers).toHaveLength(1);
    expect(cfg.servers[0].command).toBe("inline-cmd");
  });

  it("uses resolvePath option for mcpServersFile", () => {
    const resolvePath = vi.fn((p: string) => `/resolved${p}`);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ s: { command: "cmd" } }),
    );

    parseConfig({ mcpServersFile: "/my/servers.json" }, { resolvePath });

    expect(resolvePath).toHaveBeenCalledWith("/my/servers.json");
    expect(vi.mocked(fs.readFileSync)).toHaveBeenCalledWith("/resolved/my/servers.json", "utf-8");
  });

  it("throws when mcpServersFile contains invalid JSON", () => {
    vi.mocked(fs.readFileSync).mockReturnValue("not json{");

    expect(() => parseConfig({ mcpServersFile: "/bad.json" })).toThrow("failed to parse");
  });

  // ── Embedding config ──

  it("applies explicit embedding overrides with baseUrl", () => {
    const cfg = parseConfig({
      servers: [{ name: "fs", transport: "stdio", command: "npx" }],
      embedding: {
        provider: "openai",
        model: "text-embedding-3-small",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
      },
    });

    expect(cfg.embedding.provider).toBe("openai");
    expect(cfg.embedding.model).toBe("text-embedding-3-small");
    expect(cfg.embedding.baseUrl).toBe("https://api.openai.com/v1");
    expect(cfg.embedding.apiKey).toBe("sk-test");
  });

  it("applies explicit ollama embedding with default baseUrl", () => {
    const cfg = parseConfig({
      servers: [{ name: "fs", transport: "stdio", command: "npx" }],
      embedding: { provider: "ollama", model: "qwen3-embedding:0.6b" },
    });

    expect(cfg.embedding.provider).toBe("ollama");
    expect(cfg.embedding.model).toBe("qwen3-embedding:0.6b");
    expect(cfg.embedding.baseUrl).toBe("http://localhost:11434/v1");
  });

  it("backward compat: old embedding.url gets /v1 appended", () => {
    const cfg = parseConfig({
      servers: [{ name: "fs", transport: "stdio", command: "npx" }],
      embedding: { model: "qwen3-embedding:0.6b", url: "http://127.0.0.1:11434" },
    });

    expect(cfg.embedding.baseUrl).toBe("http://127.0.0.1:11434/v1");
  });

  it("backward compat: old embedding.url trailing slash is handled", () => {
    const cfg = parseConfig({
      servers: [{ name: "fs", transport: "stdio", command: "npx" }],
      embedding: { url: "http://localhost:11434/" },
    });

    expect(cfg.embedding.baseUrl).toBe("http://localhost:11434/v1");
  });

  it("throws when non-ollama provider has no baseUrl", () => {
    expect(() =>
      parseConfig({
        servers: [{ name: "s", transport: "stdio", command: "x" }],
        embedding: { provider: "openai", model: "text-embedding-3-small" },
      }),
    ).toThrow("baseUrl is required");
  });

  it("expands ${VAR} in embedding headers", () => {
    process.env.TEST_API_KEY = "emb-key";
    const cfg = parseConfig({
      servers: [{ name: "s", transport: "stdio", command: "x" }],
      embedding: {
        provider: "openai",
        model: "text-embedding-3-small",
        baseUrl: "https://api.openai.com/v1",
        headers: { "X-Custom": "${TEST_API_KEY}" },
      },
    });

    expect(cfg.embedding.headers?.["X-Custom"]).toBe("emb-key");
  });

  // ── Embedding inherit from memorySearch ──

  it("inherits embedding from memorySearch config", () => {
    const cfg = parseConfig(
      { servers: [{ name: "s", transport: "stdio", command: "x" }] },
      {
        openclawConfig: {
          agents: {
            defaults: {
              memorySearch: {
                provider: "openai",
                model: "text-embedding-3-small",
                remote: {
                  baseUrl: "https://api.openai.com/v1",
                  apiKey: "sk-inherited",
                  headers: { "X-Org": "my-org" },
                },
              },
            },
          },
        },
      },
    );

    expect(cfg.embedding.provider).toBe("openai");
    expect(cfg.embedding.model).toBe("text-embedding-3-small");
    expect(cfg.embedding.baseUrl).toBe("https://api.openai.com/v1");
    expect(cfg.embedding.apiKey).toBe("sk-inherited");
    expect(cfg.embedding.headers?.["X-Org"]).toBe("my-org");
  });

  it("falls back to Ollama defaults when memorySearch is missing", () => {
    const cfg = parseConfig(
      { servers: [{ name: "s", transport: "stdio", command: "x" }] },
      {
        openclawConfig: { agents: { defaults: {} } },
      },
    );

    expect(cfg.embedding.provider).toBe("ollama");
    expect(cfg.embedding.model).toBe("embeddinggemma");
    expect(cfg.embedding.baseUrl).toBe("http://localhost:11434/v1");
  });

  it("falls back to Ollama defaults when memorySearch uses local provider", () => {
    const cfg = parseConfig(
      { servers: [{ name: "s", transport: "stdio", command: "x" }] },
      {
        openclawConfig: {
          agents: {
            defaults: {
              memorySearch: { provider: "local" },
            },
          },
        },
      },
    );

    expect(cfg.embedding.provider).toBe("ollama");
    expect(cfg.embedding.model).toBe("embeddinggemma");
    expect(cfg.embedding.baseUrl).toBe("http://localhost:11434/v1");
  });

  it("explicit embedding takes priority over memorySearch inherit", () => {
    const cfg = parseConfig(
      {
        servers: [{ name: "s", transport: "stdio", command: "x" }],
        embedding: {
          provider: "voyage",
          model: "voyage-3",
          baseUrl: "https://api.voyageai.com/v1",
          apiKey: "pa-explicit",
        },
      },
      {
        openclawConfig: {
          agents: {
            defaults: {
              memorySearch: {
                provider: "openai",
                model: "text-embedding-3-small",
                remote: { baseUrl: "https://api.openai.com/v1", apiKey: "sk-inherited" },
              },
            },
          },
        },
      },
    );

    expect(cfg.embedding.provider).toBe("voyage");
    expect(cfg.embedding.apiKey).toBe("pa-explicit");
  });

  // ── Indexer config ──

  it("applies default indexer values", () => {
    const cfg = parseConfig({});
    expect(cfg.indexer).toEqual({
      connectTimeout: 60_000,
      maxRetries: 3,
      initialRetryDelay: 2_000,
      maxRetryDelay: 30_000,
      maxChunkChars: 500,
      overlapChars: 100,
      generateCliArtifacts: false,
    });
  });

  it("applies custom indexer config", () => {
    const cfg = parseConfig({
      indexer: {
        connectTimeout: 10_000,
        maxRetries: 5,
        initialRetryDelay: 1_000,
        maxRetryDelay: 15_000,
        maxChunkChars: 4000,
        overlapChars: 400,
      },
    });
    expect(cfg.indexer).toEqual({
      connectTimeout: 10_000,
      maxRetries: 5,
      initialRetryDelay: 1_000,
      maxRetryDelay: 15_000,
      maxChunkChars: 4000,
      overlapChars: 400,
      generateCliArtifacts: false,
    });
  });

  it("clamps maxRetries to non-negative", () => {
    const cfg = parseConfig({ indexer: { maxRetries: -2 } });
    expect(cfg.indexer.maxRetries).toBe(0);
  });

  it("clamps maxChunkChars to non-negative", () => {
    const cfg = parseConfig({ indexer: { maxChunkChars: -100 } });
    expect(cfg.indexer.maxChunkChars).toBe(0);
  });

  it("clamps overlapChars to non-negative", () => {
    const cfg = parseConfig({ indexer: { overlapChars: -50 } });
    expect(cfg.indexer.overlapChars).toBe(0);
  });

  it("parses per-server timeout from mcpServers dict", () => {
    const cfg = parseConfig({
      mcpServers: {
        slow: { command: "uvx", timeout: 120_000 },
        fast: { command: "npx" },
      },
    });
    expect(cfg.servers.find((s) => s.name === "slow")?.timeout).toBe(120_000);
    expect(cfg.servers.find((s) => s.name === "fast")?.timeout).toBeUndefined();
  });

  it("parses per-server timeout from legacy servers", () => {
    const cfg = parseConfig({
      servers: [
        { name: "slow", transport: "stdio", command: "uvx", timeout: 90_000 },
        { name: "fast", transport: "stdio", command: "npx" },
      ],
    });
    expect(cfg.servers.find((s) => s.name === "slow")?.timeout).toBe(90_000);
    expect(cfg.servers.find((s) => s.name === "fast")?.timeout).toBeUndefined();
  });
});
