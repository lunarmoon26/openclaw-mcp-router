import type { OllamaEmbeddings } from "./embeddings.js";
import type { McpRegistry } from "./mcp-registry.js";
import { McpClient } from "./mcp-client.js";
import type { McpRouterConfig } from "./config.js";
import type { McpToolVectorStore } from "./vector-store.js";

type IndexerLogger = {
  info(msg: string): void;
  warn(msg: string): void;
};

type IndexerResult = {
  indexed: number;
  failed: number;
};

/**
 * Connect to all configured MCP servers in parallel, list their tools,
 * embed each tool description, and upsert into the vector store.
 *
 * Catches Ollama errors gracefully — the plugin degrades to an empty index
 * rather than crashing the gateway.
 */
export async function runIndexer(params: {
  cfg: McpRouterConfig;
  store: McpToolVectorStore;
  embeddings: OllamaEmbeddings;
  registry: McpRegistry;
  logger: IndexerLogger;
}): Promise<IndexerResult> {
  const { cfg, store, embeddings, registry, logger } = params;

  // Run all servers in parallel — failures in one don't block others
  const results = await Promise.allSettled(
    cfg.servers.map((serverCfg) => indexServer({ serverCfg, store, embeddings, registry, logger })),
  );

  let indexed = 0;
  let failed = 0;
  for (const result of results) {
    if (result.status === "fulfilled") {
      indexed += result.value.indexed;
      failed += result.value.failed;
    } else {
      logger.warn(`mcp-router: server indexing error — ${String(result.reason)}`);
      failed++;
    }
  }

  logger.info(
    `mcp-router: indexed ${indexed} tools across ${cfg.servers.length} servers (${failed} errors)`,
  );

  return { indexed, failed };
}

async function indexServer(params: {
  serverCfg: (typeof import("./config.js").parseConfig extends (...args: never[]) => infer R
    ? R
    : never)["servers"][number];
  store: McpToolVectorStore;
  embeddings: OllamaEmbeddings;
  registry: McpRegistry;
  logger: IndexerLogger;
}): Promise<IndexerResult> {
  const { serverCfg, store, embeddings, registry, logger } = params;
  const client = new McpClient(serverCfg);

  let indexed = 0;
  let failed = 0;

  try {
    await client.connect();
    const tools = await client.listTools();

    for (const tool of tools) {
      try {
        // Embed "tool_name: description" (name-first improves retrieval accuracy)
        const embeddingText = `${tool.name}: ${tool.description}`;
        const vector = await embeddings.embed(embeddingText);

        await store.upsertTool({
          tool_id: `${serverCfg.name}::${tool.name}`,
          server_name: serverCfg.name,
          tool_name: tool.name,
          description: tool.description,
          parameters_json: JSON.stringify(tool.inputSchema),
          vector,
        });

        registry.registerToolOwner(tool.name, serverCfg.name);
        indexed++;
      } catch (err) {
        logger.warn(
          `mcp-router: failed to index tool "${tool.name}" from server "${serverCfg.name}": ${String(err)}`,
        );
        failed++;
      }
    }
  } catch (err) {
    const msg = String(err);
    // Surface Ollama connectivity errors clearly
    if (msg.includes("Ollama not reachable") || msg.includes("ollama serve")) {
      logger.warn(
        `mcp-router: Ollama unavailable — run \`ollama serve\` and use the reindex CLI to rebuild the index. ${msg}`,
      );
    } else {
      logger.warn(`mcp-router: failed to index server "${serverCfg.name}": ${msg}`);
    }
    failed++;
  } finally {
    await client.disconnect();
  }

  return { indexed, failed };
}
