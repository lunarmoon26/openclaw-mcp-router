import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { parseConfig } from "./config.js";
import { CMD_ADD_SERVER, CMD_CONTROL, CMD_DISABLE_SERVER, CMD_ENABLE_SERVER, CMD_LIST_SERVER, CMD_REINDEX, CMD_REMOVE_SERVER, CMD_SETUP, EXTENSION_ID } from "./constants.js";
import { createEmbeddings } from "./embeddings.js";
import { runIndexer, type IndexerResult } from "./indexer.js";
import { McpRegistry } from "./mcp-registry.js";
import { createMcpCallTool } from "./tools/mcp-call-tool.js";
import { createMcpSearchTool } from "./tools/mcp-search-tool.js";
import { McpToolVectorStore } from "./vector-store.js";


function detectMcporterInstalled(): boolean {
  try {
    const r = spawnSync("mcporter", ["--version"], { stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
}

const mcpRouterPlugin = {
  id: EXTENSION_ID,
  name: "OpenClaw MCP Router",
  description:
    "Dynamic MCP tool router — semantic search over large MCP catalogs to eliminate context bloat",

  register(api: OpenClawPluginApi) {
    const cfg = parseConfig(api.pluginConfig, {
      openclawConfig: api.config,
      resolvePath: api.resolvePath,
    });

    // api.resolvePath handles ~ expansion and resolves relative paths to the config dir
    const resolvedDbPath = api.resolvePath(cfg.vectorDb.path);
    const statusPath = path.join(path.dirname(resolvedDbPath), "status.json");

    function writeIndexStatus(result: IndexerResult, merge = false): void {
      type StatusFile = { timestamp: string; servers: IndexerResult["servers"] };
      let existing: StatusFile | null = null;
      if (merge) {
        try {
          existing = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as StatusFile;
        } catch { /* no prior status */ }
      }
      const serverMap = new Map(existing?.servers.map((s) => [s.name, s]) ?? []);
      for (const s of result.servers) serverMap.set(s.name, s);
      const status: StatusFile = { timestamp: new Date().toISOString(), servers: [...serverMap.values()] };
      try {
        fs.mkdirSync(path.dirname(statusPath), { recursive: true });
        fs.writeFileSync(statusPath, JSON.stringify(status, null, 2) + "\n", "utf-8");
      } catch { /* best effort */ }
    }

    const embeddings = createEmbeddings(cfg.embedding);
    const store = new McpToolVectorStore(resolvedDbPath, () => embeddings.probeDims());
    const registry = new McpRegistry(cfg.servers, api.logger);

    // Register CLI commands — always, even before the servers check so `CMD_SETUP` is
    // available when the plugin has no servers configured yet.
    api.registerCli(
      ({ program }) => {
        const router = program.command(EXTENSION_ID).description("MCP Router plugin commands");

        router
          .command(CMD_SETUP)
          .description("Interactive setup wizard — configure servers and embedding model")
          .action(async () => {
            const { runSetupCommand } = await import("./setup/setup-command.js");
            await runSetupCommand();
          });

        router
          .command(CMD_CONTROL)
          .description("Interactive TUI to enable/disable servers and manage auth")
          .action(async () => {
            const { runControlCommand } = await import("./setup/control-command.js");
            await runControlCommand();
          });

        router
          .command(CMD_ADD_SERVER)
          .description("Add an MCP server to the config")
          .argument("<name>", "Server name")
          .argument("<command-or-url>", "Executable command (stdio) or URL (sse/http)")
          .argument("[args...]", "Additional arguments for stdio command")
          .option("--transport <type>", "Transport: stdio | sse | http (default: stdio)")
          .option(
            "--env <KEY=VALUE>",
            "Environment variable; repeatable",
            (v: string, prev: string[]) => [...prev, v],
            [] as string[],
          )
          .option("--timeout <ms>", "Per-server connect timeout in ms", parseInt)
          .option("--file", "Add server to ~/.openclaw/openclaw-mcp-router/.mcp.json instead of openclaw.json")
          .action(
            async (
              name: string,
              commandOrUrl: string,
              extraArgs: string[],
              opts: { transport?: string; env: string[]; timeout?: number; file?: boolean },
            ) => {
              const { addServer } = await import("./commands/add-server.js");
              addServer(name, commandOrUrl, extraArgs, opts);
            },
          );

        router
          .command(CMD_REMOVE_SERVER)
          .description("Remove an MCP server from the config")
          .argument("<name>", "Server name to remove")
          .action(async (name: string) => {
            const { removeServer } = await import("./commands/remove-server.js");
            removeServer(name);
          });

        router
          .command(CMD_LIST_SERVER)
          .description("List configured MCP servers with tool counts and status")
          .action(async () => {
            const { listServers } = await import("./commands/list-servers.js");
            await listServers();
          });

        router
          .command(CMD_REINDEX)
          .description("Re-index all configured MCP servers into the vector store")
          .option("--server <name>", "Re-index only a specific server")
          .action(async (opts: { server?: string }) => {
            const abort = new AbortController();
            const onSigint = () => abort.abort(new Error("interrupted"));
            process.on("SIGINT", onSigint);
            try {
              let targetCfg = cfg;
              if (opts.server) {
                const filtered = cfg.servers.filter((s) => s.name === opts.server);
                if (filtered.length === 0) {
                  console.error(`${EXTENSION_ID}: server "${opts.server}" not found (check it is not disabled)`);
                  process.exit(1);
                }
                targetCfg = { ...cfg, servers: filtered };
              }
              console.log(`${EXTENSION_ID}: re-indexing${opts.server ? ` "${opts.server}"` : ""}...`);
              const result = await runIndexer({
                cfg: targetCfg,
                store,
                embeddings,
                registry,
                logger: api.logger,
                signal: abort.signal,
              });
              writeIndexStatus(result, !!opts.server);
              console.log(
                `${EXTENSION_ID}: done — ${result.indexed} indexed, ${result.failed} failed`,
              );
            } finally {
              process.removeListener("SIGINT", onSigint);
            }
          });

        router
          .command(CMD_DISABLE_SERVER)
          .description("Disable an MCP server (skip during indexing)")
          .argument("<name>", "Server name to disable")
          .action(async (name: string) => {
            const { disableServer } = await import("./commands/disable-server.js");
            disableServer(name);
          });

        router
          .command(CMD_ENABLE_SERVER)
          .description("Re-enable a previously disabled MCP server")
          .argument("<name>", "Server name to enable")
          .action(async (name: string) => {
            const { enableServer } = await import("./commands/enable-server.js");
            enableServer(name);
          });
      },
      { commands: [EXTENSION_ID] },
    );

    if (cfg.servers.length === 0) {
      api.logger.warn(
        `${EXTENSION_ID}: no MCP servers configured. ` +
          `Run \`openclaw ${EXTENSION_ID} ${CMD_SETUP}\` to configure, then \`${CMD_REINDEX}\`.`,
      );
      return;
    }

    // Register tools as optional so the agent only sees them when alsoAllow is set
    const hasMcporter = detectMcporterInstalled();

    api.registerTool(
      createMcpSearchTool({ store, embeddings, cfg: cfg.search, hasMcporter }) as never,
      { optional: true },
    );
    api.registerTool(
      createMcpCallTool({ registry, logger: api.logger }) as never,
      { optional: true },
    );

    // Service: run indexer at gateway startup
    let indexerAbort: AbortController | null = null;

    api.registerService({
      id: EXTENSION_ID,
      start: async () => {
        indexerAbort?.abort(new Error("restarting"));
        indexerAbort = new AbortController();
        api.logger.info(`${EXTENSION_ID}: starting indexer (db: ${resolvedDbPath})`);
        const result = await runIndexer({
          cfg,
          store,
          embeddings,
          registry,
          logger: api.logger,
          signal: indexerAbort.signal,
        });
        writeIndexStatus(result);
        api.logger.info(`${EXTENSION_ID}: ready — ${result.indexed} tools indexed`);
      },
      stop: async () => {
        indexerAbort?.abort(new Error("plugin stopped"));
        indexerAbort = null;
        api.logger.info(`${EXTENSION_ID}: stopped`);
      },
    });
  },
};

export default mcpRouterPlugin;
