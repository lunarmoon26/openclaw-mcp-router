import { CMD_REINDEX, EXTENSION_ID } from "../constants.js";
import {
  getPluginConfig,
  locateOpenclawConfig,
  patchMcpJsonServer,
  patchPluginConfig,
  readOpenclawConfig,
  resolveServerSource,
  writeOpenclawConfig,
} from "../setup/config-writer.js";

export function enableServer(name: string): void {
  const configPath = locateOpenclawConfig();
  const source = resolveServerSource(configPath, name);

  if (source === null) {
    console.error(`${EXTENSION_ID}: server "${name}" not found`);
    process.exit(1);
  }

  if (source === "file") {
    patchMcpJsonServer(configPath, name, (entry) => {
      const { disabled: _removed, ...rest } = entry;
      return rest;
    });
  } else {
    let config = readOpenclawConfig(configPath);
    const pluginCfg = getPluginConfig(config);
    const mcpServers = { ...((pluginCfg.mcpServers ?? {}) as Record<string, unknown>) };
    const { disabled: _removed, ...entry } = (mcpServers[name] ?? {}) as Record<string, unknown>;
    mcpServers[name] = entry;
    config = patchPluginConfig(config, { ...pluginCfg, mcpServers });
    writeOpenclawConfig(configPath, config);
  }

  console.log(`Server "${name}" enabled. Run: openclaw ${EXTENSION_ID} ${CMD_REINDEX} --server ${name}`);
}
