import { CMD_SETUP, EXTENSION_ID } from "../constants.js";
import {
  getPluginConfig,
  locateOpenclawConfig,
  readOpenclawConfig,
} from "../setup/config-writer.js";

export function listServers(): void {
  const configPath = locateOpenclawConfig();
  const config = readOpenclawConfig(configPath);
  const pluginCfg = getPluginConfig(config);

  const mcpServers = (pluginCfg.mcpServers ?? {}) as Record<string, unknown>;
  const entries = Object.entries(mcpServers);

  if (entries.length === 0) {
    console.log(`No servers configured. Run: openclaw ${EXTENSION_ID} ${CMD_SETUP}`);
    return;
  }

  const rows: string[][] = [["NAME", "TRANSPORT", "COMMAND / URL"]];

  for (const [name, srv] of entries) {
    const s = (srv ?? {}) as Record<string, unknown>;

    // Infer transport: explicit type field → command means stdio → otherwise http
    const transport =
      typeof s.type === "string"
        ? s.type
        : typeof s.command === "string"
          ? "stdio"
          : "http";

    const cmdOrUrl =
      typeof s.command === "string"
        ? `${s.command}${Array.isArray(s.args) ? " " + (s.args as string[]).join(" ") : ""}`
        : typeof s.url === "string"
          ? s.url
          : "";

    rows.push([name, transport, cmdOrUrl]);
  }

  // Calculate column widths and print aligned table
  const widths = (rows[0] as string[]).map((_, ci) =>
    Math.max(...rows.map((r) => r[ci].length)),
  );

  for (const row of rows) {
    console.log(row.map((cell, i) => cell.padEnd(widths[i])).join("  "));
  }
}
