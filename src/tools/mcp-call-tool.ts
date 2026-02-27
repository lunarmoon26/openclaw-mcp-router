import { Type } from "@sinclair/typebox";
import { EXTENSION_ID, TOOL_MCP_CALL, TOOL_MCP_SEARCH } from "../constants.js";
import { McpClient } from "../mcp-client.js";
import type { McpRegistry } from "../mcp-registry.js";

type CallDeps = {
  registry: McpRegistry;
  logger: { warn(msg: string): void };
};

/**
 * TOOL_MCP_CALL — execute a specific MCP tool by name.
 * Looks up the owning server from the registry, opens a fresh connection,
 * calls the tool, and returns the result.
 */
export function createMcpCallTool(deps: CallDeps) {
  return {
    name: TOOL_MCP_CALL,
    label: "MCP Call",
    description:
      `Call an MCP tool by its exact name (as returned by ${TOOL_MCP_SEARCH}). ` +
      "Pass parameters as a JSON object string.",
    parameters: Type.Object({
      tool_name: Type.String({
        description: `Exact MCP tool name returned by ${TOOL_MCP_SEARCH}.`,
      }),
      params_json: Type.Optional(
        Type.String({
          description: 'Parameters as a JSON object. Default: "{}"',
        }),
      ),
    }),

    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const toolName =
        typeof params.tool_name === "string" ? params.tool_name.trim() : "";
      if (!toolName) {
        return {
          content: [{ type: "text", text: "Error: tool_name is required." }],
          details: { error: "missing_tool_name" },
        };
      }

      // Parse params_json; default to empty object
      const rawJson =
        typeof params.params_json === "string" ? params.params_json.trim() : "{}";
      let toolParams: Record<string, unknown>;
      try {
        const parsed = JSON.parse(rawJson || "{}");
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("params_json must be a JSON object");
        }
        toolParams = parsed as Record<string, unknown>;
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error: invalid params_json — ${String(err)}. Provide a valid JSON object.`,
            },
          ],
          details: { error: "invalid_json" },
        };
      }

      // Resolve which server owns this tool
      const serverCfg = deps.registry.resolveServer(toolName);
      if (!serverCfg) {
        return {
          content: [
            {
              type: "text",
              text:
                `Error: unknown tool "${toolName}". ` +
                `Use ${TOOL_MCP_SEARCH} first to find valid tool names.`,
            },
          ],
          details: { error: "unknown_tool", tool: toolName },
        };
      }

      // Per-call fresh connection (simple, stateless; persistent pool is a follow-up)
      const client = new McpClient(serverCfg);
      try {
        await client.connect();
        const result = await client.callTool(toolName, toolParams);
        return {
          content: result.content,
          details: {
            tool: toolName,
            server: serverCfg.name,
            isError: result.isError ?? false,
          },
        };
      } catch (err) {
        deps.logger.warn(
          `${EXTENSION_ID}: ${TOOL_MCP_CALL} error for "${toolName}" on server "${serverCfg.name}": ${String(err)}`,
        );
        return {
          content: [
            {
              type: "text",
              text: `Error calling ${toolName} on ${serverCfg.name}: ${String(err)}`,
            },
          ],
          details: { error: String(err), tool: toolName, server: serverCfg.name, isError: true },
        };
      } finally {
        await client.disconnect();
      }
    },
  };
}
