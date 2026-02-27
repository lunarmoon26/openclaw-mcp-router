import { spawnSync } from "node:child_process";
import { cancel, confirm, intro, isCancel, outro, select, text } from "@clack/prompts";
import { parseConfig, type McpServerConfig, type McpTransportKind } from "../config.js";
import {
  ensureToolsAllowlist,
  getPluginConfig,
  locateOpenclawConfig,
  patchPluginConfig,
  readOpenclawConfig,
  writeOpenclawConfig,
} from "./config-writer.js";
import { CMD_REINDEX, EXTENSION_ID } from "../constants.js";


function detectMcporterInstalled(): boolean {
  try {
    const r = spawnSync("mcporter", ["--version"], { stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
}

function abortIfCancel(value: unknown): void {
  if (isCancel(value)) {
    cancel("Setup cancelled.");
    process.exit(0);
  }
}

async function promptServer(): Promise<McpServerConfig> {
  const transport = await select<McpTransportKind>({
    message: "Transport",
    options: [
      { value: "stdio", label: "stdio — local process (most common)" },
      { value: "sse", label: "sse — remote HTTP+SSE server" },
      { value: "http", label: "http — remote HTTP server" },
    ],
  });
  abortIfCancel(transport);

  const name = await text({ message: "Server name", placeholder: "e.g. filesystem" });
  abortIfCancel(name);

  if ((transport as McpTransportKind) === "stdio") {
    const command = await text({ message: "Command", placeholder: "npx" });
    abortIfCancel(command);

    const rawArgs = await text({
      message: "Arguments (comma-separated, or leave blank)",
      placeholder: "-y, @modelcontextprotocol/server-filesystem, /tmp",
    });
    abortIfCancel(rawArgs);

    const args =
      typeof rawArgs === "string" && rawArgs.trim()
        ? rawArgs
            .split(",")
            .map((a) => a.trim())
            .filter(Boolean)
        : undefined;

    return {
      name: name as string,
      transport: "stdio",
      command: command as string,
      args,
    };
  } else {
    const url = await text({ message: "URL", placeholder: "https://..." });
    abortIfCancel(url);

    return {
      name: name as string,
      transport: transport as McpTransportKind,
      url: url as string,
    };
  }
}

export async function runSetupCommand(): Promise<void> {
  const configPath = locateOpenclawConfig();

  intro(`${EXTENSION_ID} setup`);

  // Show existing servers from all supported locations so the user can see what's configured
  const existingOpenclawCfg = readOpenclawConfig(configPath);
  const existingPluginCfg = getPluginConfig(existingOpenclawCfg);
  let existingServers: McpServerConfig[] = [];
  try {
    existingServers = parseConfig(existingPluginCfg).servers;
  } catch {
    // ignore — best effort display
  }
  if (existingServers.length > 0) {
    const lines = existingServers
      .map((s) => `  • ${s.name}  (${s.transport})  ${s.transport === "stdio" ? s.command : s.url}`)
      .join("\n");
    console.log(`\nExisting servers:\n${lines}\n`);
  }

  // Step 1: Embedding model
  const ollamaUrl = await text({
    message: "Ollama base URL",
    initialValue: "http://localhost:11434",
  });
  abortIfCancel(ollamaUrl);

  const modelChoice = await select<string>({
    message: "Embedding model",
    options: [
      { value: "embeddinggemma", label: "embeddinggemma (recommended)" },
      { value: "qwen3-embedding:0.6b", label: "qwen3-embedding:0.6b — higher quality" },
      { value: "all-minilm", label: "all-minilm — fast and lightweight" },
      { value: "__custom__", label: "Custom model name" },
    ],
  });
  abortIfCancel(modelChoice);

  let embeddingModel = modelChoice as string;
  if ((modelChoice as string) === "__custom__") {
    const custom = await text({ message: "Model name" });
    abortIfCancel(custom);
    embeddingModel = custom as string;
  }

  // Step 2: MCP servers
  const servers: McpServerConfig[] = [];

  let addMore = await confirm({ message: "Add an MCP server?" });
  abortIfCancel(addMore);

  while (addMore === true) {
    const server = await promptServer();
    servers.push(server);

    addMore = await confirm({ message: "Add another server?" });
    abortIfCancel(addMore);
  }

  // Step 3: Advanced settings (optional)
  let topK = 5;
  let minScore = 0.3;
  let maxChunkChars = 500;
  let overlapChars = 100;

  const customizeAdvanced = await confirm({ message: "Customize advanced settings?" });
  abortIfCancel(customizeAdvanced);

  if (customizeAdvanced === true) {
    const rawTopK = await text({
      message: "Max tools returned per search (topK)",
      initialValue: "5",
    });
    abortIfCancel(rawTopK);

    const rawMinScore = await text({
      message: "Minimum similarity threshold (minScore, 0–1)",
      initialValue: "0.3",
    });
    abortIfCancel(rawMinScore);

    const rawMaxChunkChars = await text({
      message: "Max characters per chunk for long descriptions (maxChunkChars, 0 = disable)",
      initialValue: "500",
    });
    abortIfCancel(rawMaxChunkChars);

    const rawOverlapChars = await text({
      message: "Overlap characters between adjacent chunks (overlapChars)",
      initialValue: "100",
    });
    abortIfCancel(rawOverlapChars);

    topK = parseInt(rawTopK as string, 10) || 5;
    minScore = parseFloat(rawMinScore as string) || 0.3;
    maxChunkChars = parseInt(rawMaxChunkChars as string, 10) || 500;
    overlapChars = parseInt(rawOverlapChars as string, 10) || 100;
  }

  // Step 4: Search verbosity defaults
  // First install assumption: no mcporter => include params by default.
  const hasMcporter = detectMcporterInstalled();
  const schemaPreference = await confirm({
    message: hasMcporter
      ? "mcporter detected. Use compact mcp_search output by default?"
      : "mcporter not detected. Keep full params in mcp_search by default?",
    initialValue: true,
  });
  abortIfCancel(schemaPreference);

  const includeParametersDefault = hasMcporter
    ? !Boolean(schemaPreference)
    : Boolean(schemaPreference);

  // Step 5: Write config
  // Build mcpServers dict (key = server name, value = entry without name field)
  const mcpServers: Record<string, unknown> = {};
  for (const srv of servers) {
    const { name, ...entry } = srv;
    mcpServers[name] = entry;
  }

  const pluginConfigPatch: Record<string, unknown> = {
    embedding: {
      provider: "ollama",
      model: embeddingModel,
      url: ollamaUrl as string,
    },
    search: { topK, minScore, includeParametersDefault },
    indexer: { maxChunkChars, overlapChars },
  };

  if (servers.length > 0) {
    pluginConfigPatch.mcpServers = mcpServers;
  }

  let config = readOpenclawConfig(configPath);
  config = patchPluginConfig(config, pluginConfigPatch);
  config = ensureToolsAllowlist(config);
  writeOpenclawConfig(configPath, config);

  console.log(`\nConfig written to ${configPath}`);
  outro(`Run: openclaw ${EXTENSION_ID} ${CMD_REINDEX}`);
}
