import { CMD_REINDEX, EXTENSION_ID } from "../constants.js";
import {
  getPluginConfig,
  locateOpenclawConfig,
  patchPluginConfig,
  readOpenclawConfig,
  writeOpenclawConfig,
} from "../setup/config-writer.js";

export function removeServer(name: string): void {
  const configPath = locateOpenclawConfig();
  let config = readOpenclawConfig(configPath);
  const pluginCfg = getPluginConfig(config);

  const mcpServers = { ...((pluginCfg.mcpServers ?? {}) as Record<string, unknown>) };

  if (!(name in mcpServers)) {
    console.error(`Server '${name}' not found in config.`);
    process.exit(1);
  }

  delete mcpServers[name];

  config = patchPluginConfig(config, { ...pluginCfg, mcpServers });
  writeOpenclawConfig(configPath, config);

  console.log(`Server '${name}' removed. Run: openclaw ${EXTENSION_ID} ${CMD_REINDEX}`);
}
