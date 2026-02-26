import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { parseConfig } from "./config.js";
import { CMD_ADD_SERVER, CMD_LIST_SERVER, CMD_REINDEX, CMD_REMOVE_SERVER, CMD_SETUP, CMD_STATS, EXTENSION_ID } from "./constants.js";
import { createEmbeddings } from "./embeddings.js";
import { runIndexer } from "./indexer.js";
import { McpRegistry } from "./mcp-registry.js";
import { createMcpCallTool } from "./tools/mcp-call-tool.js";
import { createMcpSearchTool } from "./tools/mcp-search-tool.js";
import { McpToolVectorStore } from "./vector-store.js";

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
          .action(
            async (
              name: string,
              commandOrUrl: string,
              extraArgs: string[],
              opts: { transport?: string; env: string[]; timeout?: number },
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
          .description("List configured MCP servers")
          .action(async () => {
            const { listServers } = await import("./commands/list-servers.js");
            listServers();
          });

        router
          .command(CMD_REINDEX)
          .description("Re-index all configured MCP servers into the vector store")
          .action(async () => {
            const abort = new AbortController();
            const onSigint = () => abort.abort(new Error("interrupted"));
            process.on("SIGINT", onSigint);
            try {
              console.log(`${EXTENSION_ID}: re-indexing...`);
              const result = await runIndexer({
                cfg,
                store,
                embeddings,
                registry,
                logger: api.logger,
                signal: abort.signal,
              });
              console.log(
                `${EXTENSION_ID}: done — ${result.indexed} indexed, ${result.failed} failed`,
              );
            } finally {
              process.removeListener("SIGINT", onSigint);
            }
          });

        router
          .command(CMD_STATS)
          .description("Show number of indexed MCP tools")
          .action(async () => {
            const count = await store.countTools();
            console.log(`${EXTENSION_ID}: ${count} tools indexed in ${resolvedDbPath}`);
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
    api.registerTool(
      createMcpSearchTool({ store, embeddings, cfg: cfg.search }),
      { optional: true },
    );
    api.registerTool(
      createMcpCallTool({ registry, logger: api.logger }),
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
