import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXTENSION_ID } from "./constants.js";
import type { EmbeddingConfig, EmbeddingProvider } from "./embeddings.js";

export type McpTransportKind = "stdio" | "sse" | "http";

export type McpServerSource = "inline" | "file" | "legacy";

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
  /** sse/http: extra headers; ${VAR} expanded */
  headers?: Record<string, string>;
  /** Per-server connect timeout in ms; overrides indexer.connectTimeout */
  timeout?: number;
  /** Where this server was loaded from: "inline" (mcpServers in openclaw.json),
   * "file" (.mcp.json / mcpServersFile), or "legacy" (servers[] array). */
  source?: McpServerSource;
};

export type IndexerConfig = {
  /** Per-server default connect timeout in ms (default: 60_000) */
  connectTimeout: number;
  /** Retry attempts per server, 0 = no retry (default: 3) */
  maxRetries: number;
  /** Initial backoff delay in ms (default: 2_000) */
  initialRetryDelay: number;
  /** Max backoff cap in ms (default: 30_000) */
  maxRetryDelay: number;
  /** Max characters per chunk for long tool descriptions. 0 = disable chunking. (default: 500) */
  maxChunkChars: number;
  /** Overlap characters between adjacent chunks (default: 100) */
  overlapChars: number;
  /** Generate mcporter CLI artifacts during reindex (default: false). */
  generateCliArtifacts: boolean;
};


export type McpRouterConfig = {
  servers: McpServerConfig[];
  embedding: EmbeddingConfig;
  vectorDb: { path: string };
  search: { topK: number; minScore: number; includeParametersDefault?: boolean };
  indexer: IndexerConfig;
};

export type ParseConfigOpts = {
  openclawConfig?: { agents?: { defaults?: { memorySearch?: unknown } } };
  resolvePath?: (p: string) => string;
};

/** Expand ${VAR} placeholders in a string value from process.env */
function expandEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, key: string) => process.env[key] ?? "");
}

function expandEnvRecord(rec: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
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

const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1";
const DEFAULT_EMBEDDING_MODEL = "embeddinggemma";

/**
 * Resolve the .openclaw state directory using the same env-var priority as
 * locateOpenclawConfig() in config-writer.ts:
 *   OPENCLAW_CONFIG_PATH → directory of that file
 *   OPENCLAW_STATE_DIR   → that directory
 *   fallback             → ~/.openclaw
 */
function locateOpenclawDir(): string {
  if (process.env.OPENCLAW_CONFIG_PATH) {
    return path.dirname(process.env.OPENCLAW_CONFIG_PATH);
  }
  if (process.env.OPENCLAW_STATE_DIR) {
    return process.env.OPENCLAW_STATE_DIR;
  }
  return path.join(os.homedir(), ".openclaw");
}

// ── mcpServers dict parsing ──────────────────────────────────────────────

function parseMcpServersDict(dict: Record<string, unknown>, source: "inline" | "file" = "inline"): McpServerConfig[] {
  const servers: McpServerConfig[] = [];
  for (const [name, raw] of Object.entries(dict)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`${EXTENSION_ID}: mcpServers["${name}"] must be an object`);
    }
    const sv = raw as Record<string, unknown>;

    // Skip servers explicitly disabled by the user
    if (sv.disabled === true) continue;

    // Infer transport from fields
    let transport: McpTransportKind;
    if (typeof sv.command === "string") {
      transport = "stdio";
    } else if (typeof sv.url === "string" || typeof sv.serverUrl === "string") {
      transport = "http";
    } else {
      throw new Error(
        `${EXTENSION_ID}: mcpServers["${name}"] must have either "command" (stdio) or "url"/"serverUrl" (http)`,
      );
    }

    // Allow explicit type override (e.g. "sse" for legacy servers)
    if (typeof sv.type === "string") {
      if (!["stdio", "sse", "http"].includes(sv.type)) {
        throw new Error(`${EXTENSION_ID}: mcpServers["${name}"].type must be stdio, sse, or http`);
      }
      transport = sv.type as McpTransportKind;
    }

    const rawEnv = (sv.env ?? {}) as Record<string, string>;
    const rawHeaders = (sv.headers ?? {}) as Record<string, string>;
    const url = typeof sv.url === "string" ? sv.url : typeof sv.serverUrl === "string" ? sv.serverUrl : undefined;

    servers.push({
      name,
      transport,
      command: typeof sv.command === "string" ? sv.command : undefined,
      args: Array.isArray(sv.args) ? (sv.args as string[]) : undefined,
      env: expandEnvRecord(rawEnv),
      url,
      headers: Object.keys(rawHeaders).length > 0 ? expandEnvRecord(rawHeaders) : undefined,
      timeout: typeof sv.timeout === "number" ? sv.timeout : undefined,
      source,
    });
  }
  return servers;
}

// ── mcpServersFile loading ───────────────────────────────────────────────

function loadMcpServersFile(filePath: string, opts?: ParseConfigOpts): McpServerConfig[] {
  const resolved = opts?.resolvePath ? opts.resolvePath(filePath) : resolveHome(filePath);
  let content: string;
  try {
    content = fs.readFileSync(resolved, "utf-8");
  } catch {
    return []; // File doesn't exist or not readable — graceful degradation
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`${EXTENSION_ID}: failed to parse ${resolved} as JSON`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${EXTENSION_ID}: ${resolved} must contain a JSON object`);
  }

  const obj = parsed as Record<string, unknown>;

  // Support both flat dict and { mcpServers: {...} } wrapper
  const dict = (obj.mcpServers && typeof obj.mcpServers === "object" && !Array.isArray(obj.mcpServers))
    ? (obj.mcpServers as Record<string, unknown>)
    : obj;

  return parseMcpServersDict(dict, "file");
}

// ── Embedding config resolution ──────────────────────────────────────────

function resolveEmbeddingConfig(
  embRaw: Record<string, unknown> | undefined,
  opts?: ParseConfigOpts,
): EmbeddingConfig {
  // Explicit embedding config provided
  if (embRaw && Object.keys(embRaw).length > 0) {
    const provider = (typeof embRaw.provider === "string" ? embRaw.provider : "ollama") as EmbeddingProvider;
    const model = typeof embRaw.model === "string" ? embRaw.model : DEFAULT_EMBEDDING_MODEL;

    let baseUrl: string;
    if (typeof embRaw.baseUrl === "string") {
      baseUrl = embRaw.baseUrl;
    } else if (typeof embRaw.url === "string") {
      // Backward compat: old `embedding.url` (Ollama native endpoint) — append /v1
      baseUrl = embRaw.url.replace(/\/$/, "") + "/v1";
    } else if (provider === "ollama") {
      baseUrl = DEFAULT_OLLAMA_BASE_URL;
    } else {
      throw new Error(`${EXTENSION_ID}: embedding.baseUrl is required for provider "${provider}"`);
    }

    return {
      provider,
      model,
      baseUrl,
      apiKey: typeof embRaw.apiKey === "string" ? embRaw.apiKey : undefined,
      headers: embRaw.headers && typeof embRaw.headers === "object" && !Array.isArray(embRaw.headers)
        ? expandEnvRecord(embRaw.headers as Record<string, string>)
        : undefined,
    };
  }

  // Try to inherit from OpenClaw memorySearch config
  const memorySearch = opts?.openclawConfig?.agents?.defaults?.memorySearch;
  if (memorySearch && typeof memorySearch === "object" && !Array.isArray(memorySearch)) {
    const ms = memorySearch as Record<string, unknown>;
    const msProvider = typeof ms.provider === "string" ? ms.provider : undefined;

    // Fall back to Ollama defaults if memorySearch uses local provider
    if (msProvider === "local" || !msProvider) {
      return {
        provider: "ollama",
        model: DEFAULT_EMBEDDING_MODEL,
        baseUrl: DEFAULT_OLLAMA_BASE_URL,
      };
    }

    const remote = (ms.remote && typeof ms.remote === "object" && !Array.isArray(ms.remote))
      ? (ms.remote as Record<string, unknown>)
      : ({} as Record<string, unknown>);

    const provider = msProvider as EmbeddingProvider;
    const model = typeof ms.model === "string" ? ms.model : DEFAULT_EMBEDDING_MODEL;
    const baseUrl = typeof remote.baseUrl === "string" ? remote.baseUrl : DEFAULT_OLLAMA_BASE_URL;
    const apiKey = typeof remote.apiKey === "string" ? remote.apiKey : undefined;
    const headers = remote.headers && typeof remote.headers === "object" && !Array.isArray(remote.headers)
      ? expandEnvRecord(remote.headers as Record<string, string>)
      : undefined;

    return { provider, model, baseUrl, apiKey, headers };
  }

  // Default: Ollama with OpenAI-compatible endpoint
  return {
    provider: "ollama",
    model: DEFAULT_EMBEDDING_MODEL,
    baseUrl: DEFAULT_OLLAMA_BASE_URL,
  };
}

// ── Legacy servers[] parsing ─────────────────────────────────────────────

function parseLegacyServers(serversRaw: unknown[]): McpServerConfig[] {
  return serversRaw.map((s: unknown, i: number) => {
    if (!s || typeof s !== "object" || Array.isArray(s)) {
      throw new Error(`${EXTENSION_ID}: servers[${i}] must be an object`);
    }
    const sv = s as Record<string, unknown>;

    if (typeof sv.name !== "string" || !sv.name.trim()) {
      throw new Error(`${EXTENSION_ID}: servers[${i}].name is required`);
    }
    const transport = sv.transport as McpTransportKind;
    if (!["stdio", "sse", "http"].includes(transport)) {
      throw new Error(`${EXTENSION_ID}: servers[${i}].transport must be stdio, sse, or http`);
    }

    if (transport === "stdio") {
      if (typeof sv.command !== "string" || !sv.command.trim()) {
        throw new Error(`${EXTENSION_ID}: servers[${i}] with transport=stdio requires command`);
      }
    } else {
      if (typeof sv.url !== "string" || !sv.url.trim()) {
        throw new Error(`${EXTENSION_ID}: servers[${i}] with transport=${transport} requires url`);
      }
    }

    const rawEnv = (sv.env ?? {}) as Record<string, string>;
    const rawHeaders = (sv.headers ?? {}) as Record<string, string>;

    return {
      name: (sv.name as string).trim(),
      transport,
      command: typeof sv.command === "string" ? sv.command : undefined,
      args: Array.isArray(sv.args) ? (sv.args as string[]) : undefined,
      env: expandEnvRecord(rawEnv),
      url: typeof sv.url === "string" ? sv.url : undefined,
      headers: Object.keys(rawHeaders).length > 0 ? expandEnvRecord(rawHeaders) : undefined,
      timeout: typeof sv.timeout === "number" ? sv.timeout : undefined,
      source: "legacy" as const,
    };
  });
}

// ── Main parser ──────────────────────────────────────────────────────────

/** Parse and validate raw plugin config, applying defaults. Throws on invalid input. */
export function parseConfig(raw: unknown, opts?: ParseConfigOpts): McpRouterConfig {
  // Treat null/undefined as empty config — allows auto-loading from default file
  const normalized = raw ?? {};
  if (typeof normalized !== "object" || Array.isArray(normalized)) {
    throw new Error(`${EXTENSION_ID}: config must be an object`);
  }
  const r = normalized as Record<string, unknown>;

  // ── Server resolution: file-based base + inline mcpServers overlay ──
  // All sources are merged; inline mcpServers wins on name collision.

  // Step 1: Load file-based servers (lower priority)
  const fileServers: McpServerConfig[] = typeof r.mcpServersFile === "string"
    ? loadMcpServersFile(r.mcpServersFile, opts)
    : loadMcpServersFile(path.join(locateOpenclawDir(), EXTENSION_ID, ".mcp.json"), opts);

  // Step 2: Parse inline mcpServers (higher priority)
  const hasInline = r.mcpServers && typeof r.mcpServers === "object" && !Array.isArray(r.mcpServers);
  const inlineServers = hasInline
    ? parseMcpServersDict(r.mcpServers as Record<string, unknown>, "inline")
    : [];

  // Step 3: Merge — inline wins over file-based on name collision
  let servers: McpServerConfig[];
  if (fileServers.length > 0 || inlineServers.length > 0) {
    const nameMap = new Map(fileServers.map((s) => [s.name, s]));
    for (const s of inlineServers) nameMap.set(s.name, s);
    servers = [...nameMap.values()];
  } else if (Array.isArray(r.servers) && r.servers.length > 0) {
    // Legacy fallback: only when no file-based or inline servers found
    servers = parseLegacyServers(r.servers);
  } else {
    servers = [];
  }

  // Empty servers is valid — user may add servers later.
  // Callers should check servers.length and skip indexing if zero.

  // ── Embedding config ──
  const embRaw = r.embedding && typeof r.embedding === "object" && !Array.isArray(r.embedding)
    ? (r.embedding as Record<string, unknown>)
    : undefined;
  const embedding = resolveEmbeddingConfig(embRaw, opts);

  // ── vectorDb defaults ──
  const vdbRaw = (r.vectorDb ?? {}) as Record<string, unknown>;
  const dbPath =
    typeof vdbRaw.path === "string"
      ? resolveHome(vdbRaw.path)
      : path.join(locateOpenclawDir(), EXTENSION_ID, "lancedb");
  const vectorDb = { path: dbPath };

  // ── search defaults ──
  const srchRaw = (r.search ?? {}) as Record<string, unknown>;
  const search = {
    topK: typeof srchRaw.topK === "number" ? Math.min(20, Math.max(1, srchRaw.topK)) : 5,
    minScore: typeof srchRaw.minScore === "number" ? srchRaw.minScore : 0.3,
    includeParametersDefault: typeof srchRaw.includeParametersDefault === "boolean" ? srchRaw.includeParametersDefault : undefined,
  };

  // ── indexer defaults ──
  const idxRaw = (r.indexer ?? {}) as Record<string, unknown>;
  const indexer: IndexerConfig = {
    connectTimeout: typeof idxRaw.connectTimeout === "number" ? idxRaw.connectTimeout : 60_000,
    maxRetries: typeof idxRaw.maxRetries === "number" ? Math.max(0, idxRaw.maxRetries) : 3,
    initialRetryDelay: typeof idxRaw.initialRetryDelay === "number" ? idxRaw.initialRetryDelay : 2_000,
    maxRetryDelay: typeof idxRaw.maxRetryDelay === "number" ? idxRaw.maxRetryDelay : 30_000,
    maxChunkChars: typeof idxRaw.maxChunkChars === "number" ? Math.max(0, idxRaw.maxChunkChars) : 500,
    overlapChars: typeof idxRaw.overlapChars === "number" ? Math.max(0, idxRaw.overlapChars) : 100,
    generateCliArtifacts: typeof idxRaw.generateCliArtifacts === "boolean" ? idxRaw.generateCliArtifacts : false,
  };

  return { servers, embedding, vectorDb, search, indexer };
}
