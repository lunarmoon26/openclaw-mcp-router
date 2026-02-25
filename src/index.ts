import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { parseConfig } from "./config.js";
import { OllamaEmbeddings } from "./embeddings.js";
import { runIndexer } from "./indexer.js";
import { McpRegistry } from "./mcp-registry.js";
import { createMcpCallTool } from "./tools/mcp-call-tool.js";
import { createMcpSearchTool } from "./tools/mcp-search-tool.js";
import { McpToolVectorStore } from "./vector-store.js";

const mcpRouterPlugin = {
  id: "mcp-router",
  name: "MCP Router",
  description:
    "Dynamic MCP tool router — semantic search over large MCP catalogs to eliminate context bloat",

  register(api: OpenClawPluginApi) {
    const cfg = parseConfig(api.pluginConfig);
    // api.resolvePath handles ~ expansion and resolves relative paths to the config dir
    const resolvedDbPath = api.resolvePath(cfg.vectorDb.path);

    const embeddings = new OllamaEmbeddings(cfg.embedding.url, cfg.embedding.model);
    const store = new McpToolVectorStore(resolvedDbPath, cfg.embedding.model);
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
        const router = program.command("mcp-router").description("MCP Router plugin commands");

        router
          .command("reindex")
          .description("Re-index all configured MCP servers into the vector store")
          .action(async () => {
            console.log("mcp-router: re-indexing...");
            const result = await runIndexer({ cfg, store, embeddings, registry, logger: api.logger });
            console.log(`mcp-router: done — ${result.indexed} indexed, ${result.failed} failed`);
          });

        router
          .command("stats")
          .description("Show number of indexed MCP tools")
          .action(async () => {
            const count = await store.countTools();
            console.log(`mcp-router: ${count} tools indexed in ${resolvedDbPath}`);
          });
      },
      { commands: ["mcp-router"] },
    );

    // Service: run indexer at gateway startup
    api.registerService({
      id: "mcp-router",
      start: async () => {
        api.logger.info(`mcp-router: starting indexer (db: ${resolvedDbPath})`);
        const result = await runIndexer({ cfg, store, embeddings, registry, logger: api.logger });
        api.logger.info(`mcp-router: ready — ${result.indexed} tools indexed`);
      },
      stop: async () => {
        api.logger.info("mcp-router: stopped");
      },
    });
  },
};

export default mcpRouterPlugin;
