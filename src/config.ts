import os from "node:os";
import path from "node:path";

export type McpTransportKind = "stdio" | "sse" | "http";

export type McpServerConfig = {
  name: string;
  transport: McpTransportKind;
  /** stdio: path/name of executable */
  command?: string;
  /** stdio: arguments */
  args?: string[];
  /** stdio: extra env vars merged over process.env; ${VAR} expanded */
  env?: Record<string, string>;
  /** sse/http: endpoint URL */
  url?: string;
};

export type McpRouterConfig = {
  servers: McpServerConfig[];
  embedding: {
    provider: "ollama";
    model: string;
    url: string;
  };
  vectorDb: { path: string };
  search: { topK: number; minScore: number };
};

/** Expand ${VAR} placeholders in env values from process.env */
function expandEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, key: string) => process.env[key] ?? "");
}

function expandServerEnv(env: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    result[k] = expandEnv(v);
  }
  return result;
}

function resolveHome(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/** Parse and validate raw plugin config, applying defaults. Throws on invalid input. */
export function parseConfig(raw: unknown): McpRouterConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("mcp-router: config must be an object");
  }
  const r = raw as Record<string, unknown>;

  // servers
  if (!Array.isArray(r.servers) || r.servers.length === 0) {
    throw new Error("mcp-router: config.servers must be a non-empty array");
  }

  const servers: McpServerConfig[] = r.servers.map((s: unknown, i: number) => {
    if (!s || typeof s !== "object" || Array.isArray(s)) {
      throw new Error(`mcp-router: servers[${i}] must be an object`);
    }
    const sv = s as Record<string, unknown>;

    if (typeof sv.name !== "string" || !sv.name.trim()) {
      throw new Error(`mcp-router: servers[${i}].name is required`);
    }
    const transport = sv.transport as McpTransportKind;
    if (!["stdio", "sse", "http"].includes(transport)) {
      throw new Error(`mcp-router: servers[${i}].transport must be stdio, sse, or http`);
    }

    if (transport === "stdio") {
      if (typeof sv.command !== "string" || !sv.command.trim()) {
        throw new Error(`mcp-router: servers[${i}] with transport=stdio requires command`);
      }
    } else {
      if (typeof sv.url !== "string" || !sv.url.trim()) {
        throw new Error(`mcp-router: servers[${i}] with transport=${transport} requires url`);
      }
    }

    const rawEnv = (sv.env ?? {}) as Record<string, string>;

    return {
      name: (sv.name as string).trim(),
      transport,
      command: typeof sv.command === "string" ? sv.command : undefined,
      args: Array.isArray(sv.args) ? (sv.args as string[]) : undefined,
      env: expandServerEnv(rawEnv),
      url: typeof sv.url === "string" ? sv.url : undefined,
    };
  });

  // embedding defaults
  const embRaw = (r.embedding ?? {}) as Record<string, unknown>;
  const embedding = {
    provider: "ollama" as const,
    model: typeof embRaw.model === "string" ? embRaw.model : "nomic-embed-text",
    url: typeof embRaw.url === "string" ? embRaw.url : "http://localhost:11434",
  };

  // vectorDb defaults
  const vdbRaw = (r.vectorDb ?? {}) as Record<string, unknown>;
  const dbPath =
    typeof vdbRaw.path === "string"
      ? resolveHome(vdbRaw.path)
      : path.join(os.homedir(), ".openclaw", "mcp-router", "lancedb");
  const vectorDb = { path: dbPath };

  // search defaults
  const srchRaw = (r.search ?? {}) as Record<string, unknown>;
  const search = {
    topK: typeof srchRaw.topK === "number" ? Math.min(20, Math.max(1, srchRaw.topK)) : 5,
    minScore: typeof srchRaw.minScore === "number" ? srchRaw.minScore : 0.3,
  };

  return { servers, embedding, vectorDb, search };
}
