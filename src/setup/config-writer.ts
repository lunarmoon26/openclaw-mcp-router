import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { EXTENSION_ID, TOOL_MCP_CALL, TOOL_MCP_SEARCH } from "../constants";

export type OpenclawConfig = Record<string, unknown>;
type PluginEntry = { enabled?: boolean; config?: Record<string, unknown> };

/** Locate the openclaw.json config file via env vars or default path. */
export function locateOpenclawConfig(): string {
  if (process.env.OPENCLAW_CONFIG_PATH) {
    return process.env.OPENCLAW_CONFIG_PATH;
  }
  if (process.env.OPENCLAW_STATE_DIR) {
    return path.join(process.env.OPENCLAW_STATE_DIR, "openclaw.json");
  }
  return path.join(os.homedir(), ".openclaw", "openclaw.json");
}

/** Read and JSON5-parse the openclaw config. Returns {} if the file doesn't exist. */
export function readOpenclawConfig(configPath: string): OpenclawConfig {
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    return JSON5.parse(content) as OpenclawConfig;
  } catch {
    return {};
  }
}

/** Write the config back as formatted JSON. */
export function writeOpenclawConfig(configPath: string, config: OpenclawConfig): void {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/** Return the contents of plugins.entries[EXTENSION_ID].config, or {} if absent. */
export function getPluginConfig(config: OpenclawConfig): Record<string, unknown> {
  const plugins = (config.plugins ?? {}) as Record<string, unknown>;
  const entries = (plugins.entries ?? {}) as Record<string, unknown>;
  const entry = (entries[EXTENSION_ID] ?? {}) as PluginEntry;
  return (entry.config ?? {}) as Record<string, unknown>;
}

/**
 * Deep-merge `pluginConfigPatch` into the existing plugin config entry and return
 * the updated top-level config object (immutably).
 * Plugin configs live under plugins.entries[EXTENSION_ID] per the OpenClaw schema.
 */
export function patchPluginConfig(
  config: OpenclawConfig,
  pluginConfigPatch: Record<string, unknown>,
): OpenclawConfig {
  const plugins = { ...((config.plugins ?? {}) as Record<string, unknown>) };
  const entries = { ...((plugins.entries ?? {}) as Record<string, unknown>) };
  const entry = { ...((entries[EXTENSION_ID] ?? {}) as PluginEntry) };
  const existing = { ...((entry.config ?? {}) as Record<string, unknown>) };

  entry.config = { ...existing, ...pluginConfigPatch };
  if (entry.enabled === undefined) entry.enabled = true;
  entries[EXTENSION_ID] = entry;
  plugins.entries = entries;

  return { ...config, plugins };
}

function resolveHome(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Resolve the .mcp.json path, respecting mcpServersFile override. */
function resolveMcpJsonPath(configPath: string, pluginCfg: Record<string, unknown>): string {
  return typeof pluginCfg.mcpServersFile === "string"
    ? resolveHome(pluginCfg.mcpServersFile)
    : path.join(path.dirname(configPath), EXTENSION_ID, ".mcp.json");
}

/**
 * Return "inline" if the server is defined in mcpServers in openclaw.json,
 * "file" if it comes from .mcp.json / mcpServersFile, or null if not found.
 */
export function resolveServerSource(
  configPath: string,
  name: string,
): "inline" | "file" | null {
  const merged = resolveRawMcpServers(configPath);
  if (!(name in merged)) return null;

  const config = readOpenclawConfig(configPath);
  const pluginCfg = getPluginConfig(config);
  const inline = (pluginCfg.mcpServers ?? {}) as Record<string, unknown>;
  return name in inline ? "inline" : "file";
}

/**
 * Read .mcp.json, apply `updater` to the named entry, and write back.
 * Returning null from the updater deletes the entry.
 * Always normalises the file to `{ mcpServers: { ... } }` wrapper format on write.
 */
export function patchMcpJsonServer(
  configPath: string,
  name: string,
  updater: (entry: Record<string, unknown>) => Record<string, unknown> | null,
): void {
  const cfg = getPluginConfig(readOpenclawConfig(configPath));
  const mcpJsonPath = resolveMcpJsonPath(configPath, cfg);

  let mcpServers: Record<string, Record<string, unknown>> = {};
  try {
    const raw = JSON5.parse(fs.readFileSync(mcpJsonPath, "utf-8")) as Record<string, unknown>;
    const dict = (
      raw.mcpServers &&
      typeof raw.mcpServers === "object" &&
      !Array.isArray(raw.mcpServers)
    )
      ? (raw.mcpServers as Record<string, unknown>)
      : raw;
    mcpServers = dict as Record<string, Record<string, unknown>>;
  } catch { /* file doesn't exist — start empty */ }

  const updated = updater((mcpServers[name] ?? {}) as Record<string, unknown>);
  if (updated === null) {
    delete mcpServers[name];
  } else {
    mcpServers[name] = updated;
  }

  fs.mkdirSync(path.dirname(mcpJsonPath), { recursive: true });
  fs.writeFileSync(mcpJsonPath, JSON.stringify({ mcpServers }, null, 2) + "\n", "utf-8");
}

/**
 * Resolve merged raw server dict for CLI display commands (list, stats, control).
 * Loads file-based servers (.mcp.json / mcpServersFile) as base, then merges
 * inline mcpServers on top — inline wins on name collision.
 */
export function resolveRawMcpServers(
  configPath: string,
): Record<string, Record<string, unknown>> {
  const config = readOpenclawConfig(configPath);
  const pluginCfg = getPluginConfig(config);

  // Determine file-based source path
  const mcpJsonPath = typeof pluginCfg.mcpServersFile === "string"
    ? resolveHome(pluginCfg.mcpServersFile)
    : path.join(path.dirname(configPath), EXTENSION_ID, ".mcp.json");

  // Load raw file dict
  let fileDict: Record<string, Record<string, unknown>> = {};
  try {
    const content = fs.readFileSync(mcpJsonPath, "utf-8");
    const parsed = JSON5.parse(content) as Record<string, unknown>;
    const rawDict = (
      parsed.mcpServers &&
      typeof parsed.mcpServers === "object" &&
      !Array.isArray(parsed.mcpServers)
    )
      ? (parsed.mcpServers as Record<string, unknown>)
      : parsed;
    fileDict = rawDict as Record<string, Record<string, unknown>>;
  } catch { /* file not found — ignore */ }

  // Inline mcpServers (higher priority)
  const inlineDict = (pluginCfg.mcpServers ?? {}) as Record<string, Record<string, unknown>>;

  return { ...fileDict, ...inlineDict };
}

/** Ensure `TOOL_MCP_SEARCH` and `TOOL_MCP_CALL` are present in `tools.alsoAllow`. */
export function ensureToolsAllowlist(config: OpenclawConfig): OpenclawConfig {
  const tools = { ...((config.tools ?? {}) as Record<string, unknown>) };
  const alsoAllow = [...((tools.alsoAllow ?? []) as string[])];

  for (const tool of [TOOL_MCP_SEARCH, TOOL_MCP_CALL]) {
    if (!alsoAllow.includes(tool)) {
      alsoAllow.push(tool);
    }
  }

  tools.alsoAllow = alsoAllow;
  return { ...config, tools };
}
