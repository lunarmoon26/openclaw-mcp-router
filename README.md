# openclaw-mcp-router

Dynamic MCP tool router for [OpenClaw](https://openclaw.ai) — semantic search over large MCP tool catalogs to eliminate context bloat.

## The problem

Loading all MCP tool schemas upfront burns 55k–134k tokens before your agent processes a single message. With 58 tools across 5 MCP servers, that's ~77k tokens wasted on schemas the agent may never use.

## The solution

Two tiny tools replace the full schema dump:

- **`mcp_search(query)`** — embed the query via Ollama, search a local LanceDB index, return only matching tool definitions (~8.7k tokens, 95% reduction)
- **`mcp_call(tool_name, params_json)`** — look up the owning MCP server, execute the call, return the result

The agent asks for tools it needs instead of receiving every schema upfront.

## Install

```sh
openclaw plugins install openclaw-mcp-router
```

Requires [Ollama](https://ollama.ai) running locally with an embedding model:

```sh
ollama pull nomic-embed-text
ollama serve
```

## Configuration

Add to `~/.openclaw/openclaw.yml`:

```yaml
tools:
  alsoAllow:
    - mcp_search
    - mcp_call

plugins:
  mcp-router:
    enabled: true
    config:
      servers:
        - name: filesystem
          transport: stdio
          command: npx
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
        - name: github
          transport: sse
          url: https://api.githubcopilot.com/mcp/
      embedding:
        provider: ollama
        model: nomic-embed-text    # or mxbai-embed-large, all-minilm
        url: http://localhost:11434
      search:
        topK: 5        # tools returned per search (1–20)
        minScore: 0.3  # minimum similarity threshold (0–1)
```

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

### `embedding`

| Field | Default | Description |
|-------|---------|-------------|
| `provider` | `ollama` | Only Ollama is supported |
| `model` | `nomic-embed-text` | Embedding model name |
| `url` | `http://localhost:11434` | Ollama base URL (must be localhost) |

### `vectorDb`

| Field | Default | Description |
|-------|---------|-------------|
| `path` | `~/.openclaw/mcp-router/lancedb` | LanceDB database directory |

### `search`

| Field | Default | Description |
|-------|---------|-------------|
| `topK` | `5` | Max tools returned per search |
| `minScore` | `0.3` | Minimum similarity score (0–1) |

## CLI commands

```sh
# Re-index all configured MCP servers
openclaw mcp-router reindex

# Show indexed tool count
openclaw mcp-router stats
```

## How it works

1. At gateway startup, the plugin connects to each MCP server, lists its tools, embeds each description via Ollama, and stores them in a local LanceDB index.
2. When the agent needs to use an MCP capability, it calls `mcp_search("what I want to do")` to find relevant tools.
3. The agent then calls `mcp_call("tool_name", '{"param": "value"}')` to execute the chosen tool.

## Supported embedding models

| Model | Dims | Notes |
|-------|------|-------|
| `nomic-embed-text` | 768 | Good balance, recommended default |
| `mxbai-embed-large` | 1024 | Higher quality, larger footprint |
| `all-minilm` | 384 | Fast and lightweight |

Any Ollama embedding model works — dimensions are detected automatically for unknown models.

## License

MIT
