import { spawn } from "node:child_process";
import { Type } from "@sinclair/typebox";
import { EXTENSION_ID, TOOL_MCP_CALL, TOOL_MCP_SEARCH } from "../constants.js";
import { McpClient } from "../mcp-client.js";
import type { CallExecutionConfig } from "../config.js";
import type { McpRegistry } from "../mcp-registry.js";

type CallDeps = {
  registry: McpRegistry;
  logger: { warn(msg: string): void };
  callExecution?: CallExecutionConfig;
};

type TextContent = { type: string; text?: string };

async function callViaMcporterCli(
  execCfg: CallExecutionConfig,
  serverName: string,
  toolName: string,
  toolParams: Record<string, unknown>,
): Promise<{ content: TextContent[]; isError: boolean; backend: string }> {
  const target = `${serverName}.${toolName}`;
  const callArgs = [
    ...execCfg.cliArgs,
    "call",
    target,
    JSON.stringify(toolParams),
    "--output",
    "raw",
  ];

  const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
    const child = spawn(execCfg.cliCommand, callArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, execCfg.timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });

  const out = result.stdout.trim();
  let parsed: unknown = null;
  if (out) {
    try {
      parsed = JSON.parse(out);
    } catch {
      parsed = null;
    }
  }

  if (result.code !== 0) {
    const errText = result.stderr.trim() || out || `mcporter call exited with code ${String(result.code)}`;
    return {
      content: [{ type: "text", text: `Error calling ${target} via mcporter: ${errText}` }],
      isError: true,
      backend: "mcporter-cli",
    };
  }

  if (
    parsed &&
    typeof parsed === "object" &&
    "content" in parsed &&
    Array.isArray((parsed as { content: unknown }).content)
  ) {
    const envelope = parsed as { content: TextContent[]; isError?: boolean };
    return {
      content: envelope.content,
      isError: envelope.isError === true,
      backend: "mcporter-cli",
    };
  }

  return {
    content: [{ type: "text", text: out || "(empty response)" }],
    isError: false,
    backend: "mcporter-cli",
  };
}

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

      const callExec = deps.callExecution;
      if (callExec?.mode === "mcporter-cli") {
        try {
          const result = await callViaMcporterCli(callExec, serverCfg.name, toolName, toolParams);
          return {
            content: result.content,
            details: {
              tool: toolName,
              server: serverCfg.name,
              isError: result.isError,
              backend: result.backend,
            },
          };
        } catch (err) {
          deps.logger.warn(
            `${EXTENSION_ID}: ${TOOL_MCP_CALL} mcporter-cli error for "${toolName}" on server "${serverCfg.name}": ${String(err)}`,
          );
          return {
            content: [
              {
                type: "text",
                text: `Error calling ${toolName} on ${serverCfg.name} via mcporter-cli: ${String(err)}`,
              },
            ],
            details: {
              error: String(err),
              tool: toolName,
              server: serverCfg.name,
              isError: true,
              backend: "mcporter-cli",
            },
          };
        }
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
            backend: "sdk",
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
          details: { error: String(err), tool: toolName, server: serverCfg.name, isError: true, backend: "sdk" },
        };
      } finally {
        await client.disconnect();
      }
    },
  };
}
