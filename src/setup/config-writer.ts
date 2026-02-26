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
