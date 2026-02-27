import { EXTENSION_ID } from "../constants.js";
import {
  getPluginConfig,
  locateOpenclawConfig,
  patchMcpJsonServer,
  patchPluginConfig,
  readOpenclawConfig,
  resolveServerSource,
  writeOpenclawConfig,
} from "../setup/config-writer.js";

export function disableServer(name: string): void {
  const configPath = locateOpenclawConfig();
  const source = resolveServerSource(configPath, name);

  if (source === null) {
    console.error(`${EXTENSION_ID}: server "${name}" not found`);
    process.exit(1);
  }

  if (source === "file") {
    patchMcpJsonServer(configPath, name, (entry) => ({ ...entry, disabled: true }));
  } else {
    let config = readOpenclawConfig(configPath);
    const pluginCfg = getPluginConfig(config);
    const mcpServers = { ...((pluginCfg.mcpServers ?? {}) as Record<string, unknown>) };
    mcpServers[name] = { ...((mcpServers[name] ?? {}) as Record<string, unknown>), disabled: true };
    config = patchPluginConfig(config, { ...pluginCfg, mcpServers });
    writeOpenclawConfig(configPath, config);
  }

  console.log(`Server "${name}" disabled. Restart OpenClaw or run reindex for changes to take effect.`);
}
