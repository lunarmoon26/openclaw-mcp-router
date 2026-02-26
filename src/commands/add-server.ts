import type { McpTransportKind } from "../config.js";
import { CMD_REINDEX, EXTENSION_ID } from "../constants.js";
import {
  getPluginConfig,
  locateOpenclawConfig,
  patchPluginConfig,
  readOpenclawConfig,
  writeOpenclawConfig,
} from "../setup/config-writer.js";

export type AddServerOptions = {
  transport?: string;
  env?: string[];
  timeout?: number;
};

export function addServer(
  name: string,
  commandOrUrl: string,
  extraArgs: string[],
  opts: AddServerOptions,
): void {
  const transport = (opts.transport ?? "stdio") as McpTransportKind;
  const configPath = locateOpenclawConfig();
  let config = readOpenclawConfig(configPath);
  const pluginCfg = getPluginConfig(config);

  const mcpServers = { ...((pluginCfg.mcpServers ?? {}) as Record<string, unknown>) };

  const entry: Record<string, unknown> = {};

  if (transport === "stdio") {
    entry.command = commandOrUrl;
    if (extraArgs.length > 0) {
      entry.args = extraArgs;
    }
  } else {
    entry.type = transport;
    entry.url = commandOrUrl;
  }

  if (opts.env && opts.env.length > 0) {
    const envRecord: Record<string, string> = {};
    for (const kv of opts.env) {
      const idx = kv.indexOf("=");
      if (idx > 0) {
        envRecord[kv.slice(0, idx)] = kv.slice(idx + 1);
      }
    }
    entry.env = envRecord;
  }

  if (opts.timeout != null) {
    entry.timeout = opts.timeout;
  }

  mcpServers[name] = entry;

  config = patchPluginConfig(config, { ...pluginCfg, mcpServers });
  writeOpenclawConfig(configPath, config);

  console.log(`Server '${name}' added. Run: openclaw ${EXTENSION_ID} ${CMD_REINDEX}`);
}
