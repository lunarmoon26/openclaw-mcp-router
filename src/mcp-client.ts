import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig } from "./config.js";

export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpCallResult = {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

/** Thin MCP client wrapping @modelcontextprotocol/sdk. One instance per connection. */
export class McpClient {
  private client: Client | null = null;

  constructor(private readonly cfg: McpServerConfig) {}

  async connect(): Promise<void> {
    this.client = new Client(
      { name: "openclaw-mcp-router", version: "0.1.0" },
      { capabilities: {} },
    );

    let transport;
    if (this.cfg.transport === "stdio") {
      if (!this.cfg.command) {
        throw new Error(`mcp-router: server "${this.cfg.name}" missing command for stdio transport`);
      }
      transport = new StdioClientTransport({
        command: this.cfg.command,
        args: this.cfg.args ?? [],
        // Merge env on top of process.env so subprocess inherits PATH etc.
        env: { ...process.env, ...(this.cfg.env ?? {}) } as Record<string, string>,
      });
    } else if (this.cfg.transport === "sse") {
      if (!this.cfg.url) {
        throw new Error(
          `mcp-router: server "${this.cfg.name}" missing url for sse transport`,
        );
      }
      transport = new SSEClientTransport(new URL(this.cfg.url), {
        requestInit: this.cfg.headers ? { headers: this.cfg.headers } : undefined,
      });
    } else {
      // http — StreamableHTTP
      if (!this.cfg.url) {
        throw new Error(
          `mcp-router: server "${this.cfg.name}" missing url for http transport`,
        );
      }
      transport = new StreamableHTTPClientTransport(new URL(this.cfg.url), {
        requestInit: this.cfg.headers ? { headers: this.cfg.headers } : undefined,
      });
    }

    await this.client.connect(transport);
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close().catch(() => {});
      this.client = null;
    }
  }

  async listTools(): Promise<McpToolDefinition[]> {
    if (!this.client) throw new Error("mcp-router: McpClient not connected");
    const response = await this.client.listTools();
    return (response.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
    }));
  }

  async callTool(name: string, params: Record<string, unknown>): Promise<McpCallResult> {
    if (!this.client) throw new Error("mcp-router: McpClient not connected");
    try {
      const result = await this.client.callTool({ name, arguments: params });
      const content = Array.isArray(result.content)
        ? (result.content as Array<{ type: string; text?: string }>)
        : [{ type: "text", text: String(result.content ?? "") }];
      return { content, isError: result.isError === true };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error calling ${name}: ${String(err)}` }],
        isError: true,
      };
    }
  }
}
