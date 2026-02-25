import { describe, it, expect } from "vitest";
import { parseConfig } from "../config.js";

describe("parseConfig", () => {
  it("throws when config is not an object", () => {
    expect(() => parseConfig(null)).toThrow("must be an object");
    expect(() => parseConfig("bad")).toThrow("must be an object");
  });

  it("throws when servers is missing or empty", () => {
    expect(() => parseConfig({})).toThrow("servers");
    expect(() => parseConfig({ servers: [] })).toThrow("servers");
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
    expect(cfg.embedding.model).toBe("nomic-embed-text");
    expect(cfg.embedding.url).toBe("http://localhost:11434");
    expect(cfg.search.topK).toBe(5);
    expect(cfg.search.minScore).toBe(0.3);
    expect(cfg.vectorDb.path).toContain("mcp-router");
  });

  it("applies embedding overrides", () => {
    const cfg = parseConfig({
      servers: [{ name: "fs", transport: "stdio", command: "npx" }],
      embedding: { model: "mxbai-embed-large", url: "http://127.0.0.1:11434" },
    });

    expect(cfg.embedding.model).toBe("mxbai-embed-large");
    expect(cfg.embedding.url).toBe("http://127.0.0.1:11434");
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
    delete process.env.TEST_MCP_TOKEN;
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
});
