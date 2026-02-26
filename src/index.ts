import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { parseConfig } from "./config.js";
import { EXTENSION_ID } from "./constants.js";
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

    if (cfg.servers.length === 0) {
      api.logger.warn(
        `${EXTENSION_ID}: no MCP servers configured. ` +
          "Add mcpServers to your plugin config, then run `openclaw openclaw-mcp-router reindex`.",
      );
      return;
    }

    // api.resolvePath handles ~ expansion and resolves relative paths to the config dir
    const resolvedDbPath = api.resolvePath(cfg.vectorDb.path);

    const embeddings = createEmbeddings(cfg.embedding);
    const store = new McpToolVectorStore(resolvedDbPath, () => embeddings.probeDims());
    const registry = new McpRegistry(cfg.servers, api.logger);

    // Register tools as optional so the agent only sees them when alsoAllow is set
    api.registerTool(
      createMcpSearchTool({ store, embeddings, cfg: cfg.search }),
      { optional: true },
    );
    api.registerTool(
      createMcpCallTool({ registry, logger: api.logger }),
      { optional: true },
    );

    // Register a CLI sub-command for manual re-indexing
    api.registerCli(
      ({ program }) => {
        const router = program.command(EXTENSION_ID).description("MCP Router plugin commands");

        router
          .command("reindex")
          .description("Re-index all configured MCP servers into the vector store")
          .action(async () => {
            const abort = new AbortController();
            const onSigint = () => abort.abort(new Error("interrupted"));
            process.on("SIGINT", onSigint);
            try {
              console.log(`${EXTENSION_ID}: re-indexing...`);
              const result = await runIndexer({
                cfg, store, embeddings, registry,
                logger: api.logger, signal: abort.signal,
              });
              console.log(`${EXTENSION_ID}: done — ${result.indexed} indexed, ${result.failed} failed`);
            } finally {
              process.removeListener("SIGINT", onSigint);
            }
          });

        router
          .command("stats")
          .description("Show number of indexed MCP tools")
          .action(async () => {
            const count = await store.countTools();
            console.log(`${EXTENSION_ID}: ${count} tools indexed in ${resolvedDbPath}`);
          });
      },
      { commands: [EXTENSION_ID] },
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
          cfg, store, embeddings, registry,
          logger: api.logger, signal: indexerAbort.signal,
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
