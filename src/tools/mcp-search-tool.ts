import { Type } from "@sinclair/typebox";
import { CMD_REINDEX, EXTENSION_ID, TOOL_MCP_CALL, TOOL_MCP_SEARCH } from "../constants.js";
import type { Embeddings } from "../embeddings.js";
import type { McpToolVectorStore } from "../vector-store.js";

type SearchDeps = {
  store: McpToolVectorStore;
  embeddings: Embeddings;
  cfg: { topK: number; minScore: number; includeParametersDefault?: boolean };
};

/** Extract a string param tolerating both camelCase and snake_case keys. */
function readStringParam(params: Record<string, unknown>, key: string): string | undefined {
  const val = params[key] ?? params[key.replace(/([A-Z])/g, "_$1").toLowerCase()];
  return typeof val === "string" ? val : undefined;
}

function readBoolParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const val = params[key] ?? params[key.replace(/([A-Z])/g, "_$1").toLowerCase()];
  return typeof val === "boolean" ? val : undefined;
}

function buildSignature(toolName: string, paramsJson: string): string {
  try {
    const schema = JSON.parse(paramsJson) as {
      properties?: Record<string, { type?: string }>;
      required?: string[];
    };
    const props = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    const parts = Object.entries(props).map(([name, def]) => {
      const type = def?.type ?? "unknown";
      return required.has(name) ? `${name}: ${type}` : `${name}?: ${type}`;
    });
    return `${toolName}(${parts.join(", ")})`;
  } catch {
    return `${toolName}(...)`;
  }
}

/**
 * mcp_search — semantic search over indexed MCP tool definitions.
 * Returns compact cards by default (signature + CLI hint). Full JSON schema is optional.
 */
export function createMcpSearchTool(deps: SearchDeps) {
  return {
    name: TOOL_MCP_SEARCH,
    label: "MCP Search",
    description:
      "Search for MCP tools by describing what you want to do. " +
      "Returns matching tool definitions with compact signatures by default (schema optional). " +
      `Use this before ${TOOL_MCP_CALL} to find the right tool name.`,
    parameters: Type.Object({
      query: Type.String({
        description: "What you want to do, in plain language. E.g. 'list files in a directory'",
      }),
      limit: Type.Optional(
        Type.Number({
          description: "Max tools to return (default 5, max 20).",
        }),
      ),
      include_schema: Type.Optional(
        Type.Boolean({
          description: "Include full JSON parameter schema in results (default: false).",
        }),
      ),
    }),

    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const query = readStringParam(params, "query");
      if (!query || !query.trim()) {
        return {
          content: [{ type: "text", text: "Error: query parameter is required." }],
          details: { count: 0 },
        };
      }

      const rawLimit = typeof params.limit === "number" ? params.limit : deps.cfg.topK;
      const limit = Math.max(1, Math.min(20, rawLimit));
      const includeSchema = readBoolParam(params, "include_schema") ?? deps.cfg.includeParametersDefault ?? false;

      let vector: number[];
      try {
        vector = await deps.embeddings.embed(query);
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text:
                `${TOOL_MCP_SEARCH}: embedding failed — ${String(err)}\n\n` +
                `Ensure the embedding service is running. Run \`openclaw ${EXTENSION_ID} ${CMD_REINDEX}\` after fixing.`,
            },
          ],
          details: { count: 0, error: String(err) },
        };
      }

      // Overfetch to compensate for dedup of multiple chunks per tool
      const fetchLimit = Math.min(60, limit * 3);
      const rawResults = await deps.store.searchTools(vector, fetchLimit, deps.cfg.minScore);

      // Deduplicate: keep highest-scoring chunk per (server_name, tool_name)
      const seen = new Map<string, (typeof rawResults)[number]>();
      for (const r of rawResults) {
        const key = `${r.entry.server_name}::${r.entry.tool_name}`;
        const existing = seen.get(key);
        if (!existing || r.score > existing.score) {
          seen.set(key, r);
        }
      }
      const results = [...seen.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text:
                "No matching MCP tools found. " +
                "Try rephrasing your query or check that servers are indexed.",
            },
          ],
          details: { count: 0 },
        };
      }

      const cards = results
        .map((r, i) => {
          const scoreStr = `${(r.score * 100).toFixed(0)}%`;
          const signature = buildSignature(r.entry.tool_name, r.entry.parameters_json);
          const cliHint = `mcporter call ${r.entry.server_name}.${r.entry.tool_name} '{...}'`;
          const fallbackHint = `${TOOL_MCP_CALL}(\"${r.entry.tool_name}\", '{...}')`;

          const schemaBlock = includeSchema
            ? `\n**Parameters (JSON Schema):**\n\`\`\`json\n${
              r.entry.parameters_json.length > 2000
                ? r.entry.parameters_json.slice(0, 2000) + "\n... (truncated)"
                : r.entry.parameters_json
            }\n\`\`\``
            : "";

          return (
            `### ${i + 1}. ${r.entry.tool_name} (server: ${r.entry.server_name}, score: ${scoreStr})\n` +
            `**Description:** ${r.entry.description}\n` +
            `**Signature:** \`${signature}\`\n` +
            `**Preferred (CLI):** \`${cliHint}\`\n` +
            `**Fallback (JSON):** \`${fallbackHint}\`` +
            schemaBlock
          );
        })
        .join("\n\n");

      const text =
        `Found ${results.length} matching tool(s). ` +
        `${includeSchema ? "Including full schema." : "Using compact mode (set include_schema=true for full JSON schema)."}\n\n` +
        cards;

      return {
        content: [{ type: "text", text }],
        details: { count: results.length, includeSchema },
      };
    },
  };
}
