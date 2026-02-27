import fs from "node:fs";
import path from "node:path";
import { CMD_SETUP, EXTENSION_ID } from "../constants.js";
import {
  locateOpenclawConfig,
  resolveRawMcpServers,
} from "../setup/config-writer.js";
import { McpToolVectorStore } from "../vector-store.js";
import { createEmbeddings } from "../embeddings.js";
import { parseConfig } from "../config.js";

export async function listServers(): Promise<void> {
  const configPath = locateOpenclawConfig();
  const rawServers = resolveRawMcpServers(configPath) as Record<string, unknown>;
  const serverNames = Object.keys(rawServers);

  if (serverNames.length === 0) {
    console.log(`No servers configured. Run: openclaw ${EXTENSION_ID} ${CMD_SETUP}`);
    return;
  }

  // Resolve db path from parsed config for vector store access
  const cfg = parseConfig(null, { resolvePath: (p) => p });
  const resolvedDbPath = cfg.vectorDb.path;
  const statusPath = path.join(path.dirname(resolvedDbPath), "status.json");

  // Read last indexer run status
  type StatusEntry = { name: string; error?: string; failed?: number };
  type StatusFile = { timestamp: string; servers: StatusEntry[] };
  let lastStatus: StatusFile | null = null;
  try {
    lastStatus = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as StatusFile;
  } catch { /* not indexed yet */ }
  const statusByName = new Map(lastStatus?.servers.map((s) => [s.name, s]) ?? []);

  // Get live per-server tool counts from vector store
  let toolCounts = new Map<string, number>();
  try {
    const embeddings = createEmbeddings(cfg.embedding);
    const store = new McpToolVectorStore(resolvedDbPath, () => embeddings.probeDims());
    toolCounts = await store.countToolsByServer();
  } catch { /* store not ready */ }

  const rows: string[][] = [["NAME", "TRANSPORT", "ENDPOINT", "TOOLS", "STATUS"]];
  const errors: { name: string; error: string }[] = [];

  for (const name of serverNames) {
    const srv = (rawServers[name] ?? {}) as Record<string, unknown>;
    const isDisabled = srv.disabled === true;

    const transport =
      typeof srv.type === "string" ? srv.type :
      typeof srv.command === "string" ? "stdio" : "http";

    const rawEndpoint =
      typeof srv.command === "string"
        ? `${srv.command}${Array.isArray(srv.args) ? " " + (srv.args as string[]).join(" ") : ""}`
        : typeof srv.url === "string" ? srv.url
        : typeof srv.serverUrl === "string" ? srv.serverUrl
        : "";
    const endpoint = rawEndpoint.length > 45 ? rawEndpoint.slice(0, 44) + "…" : rawEndpoint;

    const tools = String(toolCounts.get(name) ?? 0);

    let status: string;
    if (isDisabled) {
      status = "disabled";
    } else {
      const srvStatus = statusByName.get(name);
      if (!srvStatus) {
        status = lastStatus ? "not in last run" : "not indexed";
      } else if (srvStatus.error) {
        status = "failed";
        errors.push({ name, error: srvStatus.error });
      } else if ((srvStatus.failed ?? 0) > 0) {
        status = `partial (${srvStatus.failed} tool errors)`;
      } else {
        status = "ok";
      }
    }

    rows.push([name, transport, endpoint, tools, status]);
  }

  // Print aligned table
  const widths = (rows[0] as string[]).map((_, ci) =>
    Math.max(...rows.map((r) => r[ci].length)),
  );
  for (const row of rows) {
    console.log(row.map((cell, i) => cell.padEnd(widths[i])).join("  "));
  }

  if (errors.length > 0) {
    console.log("\nErrors:");
    for (const { name, error } of errors) {
      console.log(`  ${name}: ${error}`);
    }
  }

  if (lastStatus) {
    console.log(`\nLast indexed: ${lastStatus.timestamp}`);
  }

  const totalTools = [...toolCounts.values()].reduce((a, b) => a + b, 0);
  console.log(`${totalTools} tools · db: ${resolvedDbPath}`);
}
