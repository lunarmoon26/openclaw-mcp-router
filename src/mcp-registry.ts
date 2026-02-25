import type { McpServerConfig } from "./config.js";

/**
 * In-memory map of tool name → owning server config.
 * On collision (same tool name from multiple servers), last-writer-wins with a warning.
 */
export class McpRegistry {
  private readonly toolOwnerMap = new Map<string, string>();
  private readonly serverMap: Map<string, McpServerConfig>;

  constructor(
    private readonly servers: McpServerConfig[],
    private readonly logger?: { warn(msg: string): void },
  ) {
    this.serverMap = new Map(servers.map((s) => [s.name, s]));
  }

  registerToolOwner(toolName: string, serverName: string): void {
    if (this.toolOwnerMap.has(toolName)) {
      const existing = this.toolOwnerMap.get(toolName);
      this.logger?.warn(
        `mcp-router: tool name collision — "${toolName}" already registered by server ` +
          `"${existing}"; overwriting with "${serverName}". ` +
          "Use unique tool names across servers to avoid conflicts.",
      );
    }
    this.toolOwnerMap.set(toolName, serverName);
  }

  resolveServer(toolName: string): McpServerConfig | undefined {
    const serverName = this.toolOwnerMap.get(toolName);
    if (!serverName) return undefined;
    return this.serverMap.get(serverName);
  }

  allServers(): McpServerConfig[] {
    return this.servers;
  }
}
