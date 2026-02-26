# openclaw-mcp-router

Dynamic MCP tool router for [OpenClaw](https://openclaw.ai) — semantic search over large MCP tool catalogs to eliminate context bloat.

## The problem

Loading all MCP tool schemas upfront burns 55k–134k tokens before your agent processes a single message. With 58 tools across 5 MCP servers, that's ~77k tokens wasted on schemas the agent may never use.

## The solution

Two tiny tools replace the full schema dump:

- **`mcp_search(query)`** — embed the query via Ollama, search a local LanceDB index, return only matching tool definitions (~8.7k tokens, 95% reduction)
- **`mcp_call(tool_name, params_json)`** — look up the owning MCP server, execute the call, return the result

The agent asks for tools it needs instead of receiving every schema upfront.

## Prerequisites

Before installing this plugin you need:

- **[OpenClaw](https://openclaw.ai)** installed and running
- **[Ollama](https://ollama.ai)** running locally
- An embedding model pulled:

  ```sh
  ollama pull embeddinggemma
  ollama serve
  ```

## Quick Start

1. **Install the plugin**

   ```sh
   openclaw plugins install openclaw-mcp-router
   ```

   **Alternative: install from source**

   ```sh
   git clone https://github.com/lunarmoon26/openclaw-mcp-router.git
   openclaw plugins install ./openclaw-mcp-router
   ```

2. **Run the setup wizard**

   ```sh
   openclaw openclaw-mcp-router setup
   ```

   This guides you through configuring your MCP servers and embedding model. It also automatically adds `mcp_search` and `mcp_call` to `tools.alsoAllow` in `~/.openclaw/openclaw.json`.

3. **Index your servers**

   ```sh
   openclaw openclaw-mcp-router reindex
   ```

4. **Restart the gateway** — the tools are now available to your agents.

> **Note:** `~/.openclaw/openclaw.json` is JSON5 — it supports `//` comments and trailing commas.

> **Tip: persist your MCP servers across reinstalls.**
> Store your MCP server definitions in `~/.openclaw/openclaw-mcp-router/.mcp.json`. The plugin auto-loads this file when no `mcpServers` key is present in the plugin config, so your server list survives plugin reinstalls, upgrades, or config resets — you won't need to re-run setup just to restore your servers.
>
> ```jsonc
> // ~/.openclaw/openclaw-mcp-router/.mcp.json
> {
>   "mcpServers": {
>     "filesystem": {
>       "command": "npx",
>       "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
>     },
>     "github": {
>       "url": "https://api.githubcopilot.com/mcp/",
>       "transport": "sse"
>     }
>   }
> }
> ```

## Important: `tools.alsoAllow` is required

The plugin registers `mcp_search` and `mcp_call` as **optional tools** (`optional: true`). This means the gateway loads them, but they are **not exposed to agents** unless explicitly allowlisted.

If the plugin is running and `openclaw openclaw-mcp-router stats` shows indexed tools, but your agent can't call `mcp_search` — this is why. The `setup` command adds this automatically, or you can add it manually:

```jsonc
// ~/.openclaw/openclaw.json — global, all agents get access
{
  "tools": {
    "alsoAllow": ["mcp_search", "mcp_call"]
  }
}
```

Or scope it to specific agents:

```jsonc
{
  "agents": {
    "defaults": {
      "tools": {
        "alsoAllow": ["mcp_search", "mcp_call"]
      }
    }
  }
}
```

> **Note:** Plugin configs go under `plugins.entries`, not directly under `plugins`.
> OpenClaw's config schema is strict — keys placed directly under `plugins` other than
> `enabled`, `allow`, `deny`, `load`, `slots`, `entries`, and `installs` will cause a
> validation error.

Restart the gateway after changing the config.

## Manual configuration

Instead of using `setup`, you can edit `~/.openclaw/openclaw.json` directly:

```jsonc
// ~/.openclaw/openclaw.json
{
  "tools": {
    "alsoAllow": ["mcp_search", "mcp_call"]
  },
  "plugins": {
    "entries": {
      "openclaw-mcp-router": {
        "enabled": true,
        "config": {
          "servers": [
            {
              "name": "filesystem",
              "transport": "stdio",
              "command": "npx",
              "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
            },
            {
              "name": "github",
              "transport": "sse",
              "url": "https://api.githubcopilot.com/mcp/"
            }
          ],
          "embedding": {
            "provider": "ollama",
            "model": "embeddinggemma", // or qwen3-embedding:0.6b, all-minilm
            "url": "http://localhost:11434"
          },
          "search": {
            "topK": 5,      // tools returned per search (1–20)
            "minScore": 0.3 // minimum similarity threshold (0–1)
          }
        }
      }
    }
  }
}
```

## Adding and removing servers

The plugin provides non-interactive commands for server management:

```sh
# Add a stdio server (local process)
openclaw openclaw-mcp-router add filesystem npx -y @modelcontextprotocol/server-filesystem /tmp

# Add an SSE server
openclaw openclaw-mcp-router add --transport sse github https://api.githubcopilot.com/mcp/

# Add with environment variables and a custom timeout
openclaw openclaw-mcp-router add --env API_KEY=abc123 --timeout 120000 myserver uvx my-mcp-server

# List configured servers
openclaw openclaw-mcp-router list

# Remove a server
openclaw openclaw-mcp-router remove github
```

After adding or removing servers, run `openclaw openclaw-mcp-router reindex` to update the index. No gateway restart needed.

## CLI commands

```sh
openclaw openclaw-mcp-router setup               # Interactive setup wizard
openclaw openclaw-mcp-router add <name> <cmd> [args...]   # Add a stdio server
openclaw openclaw-mcp-router add --transport sse <name> <url>  # Add SSE/HTTP server
openclaw openclaw-mcp-router remove <name>       # Remove a server
openclaw openclaw-mcp-router list                # List configured servers
openclaw openclaw-mcp-router reindex             # Re-index all servers
openclaw openclaw-mcp-router stats               # Show indexed tool count
```

**`add` flags:**

| Flag | Description |
|------|-------------|
| `--transport <stdio\|sse\|http>` | Transport type (default: `stdio`) |
| `--env KEY=VALUE` | Set an env var on the server; repeatable |
| `--timeout <ms>` | Per-server connect timeout override |

## Configuration reference

### `servers[]`

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Unique server identifier |
| `transport` | yes | `stdio`, `sse`, or `http` |
| `command` | stdio only | Executable to run |
| `args` | stdio only | Arguments array |
| `env` | no | Extra env vars merged over process.env; supports `${VAR}` expansion |
| `url` | sse/http only | Server endpoint URL |
| `timeout` | no | Per-server connect timeout in ms; overrides `indexer.connectTimeout` |

### `embedding`

| Field | Default | Description |
|-------|---------|-------------|
| `provider` | `ollama` | Only Ollama is supported |
| `model` | `embeddinggemma` | Embedding model name |
| `url` | `http://localhost:11434` | Ollama base URL (must be localhost) |

### `vectorDb`

| Field | Default | Description |
|-------|---------|-------------|
| `path` | `~/.openclaw/openclaw-mcp-router/lancedb` | LanceDB database directory |

### `indexer`

Controls retry behavior and timeouts when connecting to MCP servers at startup. Useful for self-hosted servers (e.g. started via `uvx`) that take time to start up.

| Field | Default | Description |
|-------|---------|-------------|
| `connectTimeout` | `60000` | Per-server default connect timeout in ms |
| `maxRetries` | `3` | Retry attempts per server (0 = no retry) |
| `initialRetryDelay` | `2000` | Initial backoff delay in ms |
| `maxRetryDelay` | `30000` | Max backoff cap in ms |
| `maxChunkChars` | `500` | Max characters per chunk for long tool descriptions. `0` = disable chunking |
| `overlapChars` | `100` | Overlap characters between adjacent chunks |

Retries use exponential backoff: delays are `initialRetryDelay * 2^(attempt-1)`, capped at `maxRetryDelay`. With defaults, a slow server gets attempts at ~0s, ~2s, ~4s, ~8s before giving up.

**Chunking:** When a tool description exceeds `maxChunkChars`, it is split into overlapping chunks at semantic boundaries (paragraphs, lines, sentences). Each chunk is stored as a separate vector, and search results are deduplicated so each tool appears once with its best matching score. Short descriptions (the common case) are unaffected.

Example for a slow-starting Python server:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-mcp-router": {
        "config": {
          "servers": [
            {
              "name": "my-python-server",
              "transport": "stdio",
              "command": "uvx",
              "args": ["my-mcp-server"],
              "timeout": 120000 // this server needs 2 minutes to start
            }
          ],
          "indexer": {
            "maxRetries": 5,
            "initialRetryDelay": 3000
          }
        }
      }
    }
  }
}
```

### `search`

| Field | Default | Description |
|-------|---------|-------------|
| `topK` | `5` | Max tools returned per search |
| `minScore` | `0.3` | Minimum similarity score (0–1) |

## How it works

1. At gateway startup, the plugin connects to each MCP server in parallel (with retry and configurable timeouts), lists its tools, embeds each description via Ollama, and stores them in a local LanceDB index.
2. When the agent needs to use an MCP capability, it calls `mcp_search("what I want to do")` to find relevant tools.
3. The agent then calls `mcp_call("tool_name", '{"param": "value"}')` to execute the chosen tool.

Disabling the plugin (`openclaw plugins disable openclaw-mcp-router`) cancels any in-progress indexing immediately. Re-enabling starts fresh.

## Supported embedding models

| Model | Dims | Notes |
|-------|------|-------|
| `embeddinggemma` | 768 | Good balance, recommended default |
| `qwen3-embedding:0.6b` | 1024 | Higher quality, larger footprint |
| `all-minilm` | 384 | Fast and lightweight |

Any Ollama embedding model works — dimensions are detected automatically for unknown models.

## Troubleshooting

### Agent can't call `mcp_search`

Almost always because `mcp_search` and `mcp_call` are not in `tools.alsoAllow`. Run `openclaw openclaw-mcp-router setup` or add them manually (see [Important: `tools.alsoAllow` is required](#important-toolsalsoallow-is-required)).

### `reindex` shows 0 tools indexed

- Check that your MCP servers are reachable. Run `openclaw openclaw-mcp-router reindex` with the gateway stopped and the servers running, then check the output for per-server errors.
- If using `uvx` or other launchers, the server may need more time to start. Increase `indexer.connectTimeout` and `indexer.maxRetries`.

### Ollama connection error

- Confirm Ollama is running: `curl http://localhost:11434/api/tags`
- Confirm the embedding model is pulled: `ollama list`
- If Ollama is on a non-default port, set `embedding.url` in the config.

### Config changes not taking effect

Always restart the gateway after editing `~/.openclaw/openclaw.json`. Run `openclaw openclaw-mcp-router reindex` after adding or removing servers.

## Background

This plugin is a basic implementation of the [Tool Search Tool](https://www.anthropic.com/engineering/advanced-tool-use) pattern from Anthropic's advanced tool use guide. The core idea: instead of injecting all tool schemas into the system prompt, provide a search tool that dynamically surfaces only relevant tools at runtime. Anthropic's benchmarks showed this improved tool selection accuracy from 49% to 74% (Opus 4) and 79.5% to 88.1% (Opus 4.5).

Our approach is intentionally simple — pure vector similarity over tool descriptions. There's plenty of room to improve:

- **Hybrid search (BM25 + embedding).** Pure embedding search can miss exact keyword matches. Combining sparse retrieval (BM25/TF-IDF) with dense vectors would improve recall, especially for tools with distinctive names like `git_diff` or `kubectl_apply`.
- **LLM-based reranking.** After the initial vector search returns candidates, a small LLM could rerank them based on the full query context — catching semantic nuances that cosine similarity misses.
- **Tool use examples.** Indexing not just descriptions but example invocations (input/output pairs) would let the search match against concrete usage patterns, not just what the tool claims to do.
- **Programmatic tool calling.** Anthropic's guide describes letting the agent compose tool calls inside code blocks rather than pure JSON — reducing context pollution and enabling multi-step tool pipelines.

Contributions welcome if any of these interest you.

## License

MIT
