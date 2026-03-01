# OpenClaw MCP Router 🚀

**OpenClaw MCP Router** is a dynamic **MCP (Model Context Protocol) tool router** for OpenClaw. It uses semantic search to discover the right MCP tools at runtime, so agents avoid loading huge tool catalogs into the system prompt.


Instead of injecting every MCP schema up front, it provides two lightweight meta-tools:

- `mcp_search` → discover the right tool at runtime
- `mcp_call` → execute as JSON fallback

This cuts context bloat, improves tool selection quality, and reduces token cost on large MCP server inventories.

---

## Keywords

OpenClaw plugin, MCP router, Model Context Protocol, tool discovery, semantic tool search, AI agent tooling, LanceDB, Ollama embeddings.

## Why this exists

Large MCP catalogs are expensive in prompt space.

- **Token waste:** tens of thousands of tokens before first user turn
- **Reasoning quality loss:** "lost in the middle" on oversized prompts
- **Higher cost:** more prompt tokens every turn

MCP Router applies Anthropic's tool-search pattern so only relevant tools are surfaced when needed.

Refs:
- Tool search / advanced tool use: <https://www.anthropic.com/engineering/advanced-tool-use>
- Code execution with MCP: <https://www.anthropic.com/engineering/code-execution-with-mcp>

---

## Core model

### 1) Index time (`reindex`)
- Connect to configured MCP servers
- List tools
- Embed tool text
- Store vectors in LanceDB
- Register tool→server ownership
- *(Optional)* generate CLI artifacts via `mcporter generate-cli`

### 2) Runtime (`mcp_search`)
- Semantic search over indexed tools
- Default schema verbosity is adaptive:
  - if `mcporter` is available: compact cards by default
  - if `mcporter` is not available: include JSON params by default
- Full JSON schema can always be forced with `include_schema=true`

### 3) Execute (`mcp_call`)
- JSON-based execution path (classic MCP params flow)

---

## CLI-first behavior (new)

Router is now optimized for a CLI-first workflow:

- Prefer: `mcporter call <server>.<tool> ...`
- Fallback: `mcp_call(tool_name, params_json)`

`mcp_search` adapts to environment: compact when mcporter is present, schema-forward when it is not (so agents can drive `mcp_call` reliably).

---

## Use cases

- Route large MCP tool catalogs without prompt bloat
- Improve tool selection for coding and automation agents
- Keep system prompts small while preserving broad MCP capability
- Enable CLI-first MCP execution with JSON fallback

## Quick start

### Prerequisites

```bash
ollama pull embeddinggemma
```

### Install

```bash
openclaw plugins install openclaw-mcp-router
```

### Setup + index

```bash
openclaw openclaw-mcp-router setup
openclaw openclaw-mcp-router reindex
```

The setup wizard auto-detects whether `mcporter` is installed and suggests a sensible default for `mcp_search` schema verbosity.

---

## Key configuration

In `~/.openclaw/openclaw.json` under `plugins.entries.openclaw-mcp-router.config`:

```json5
{
  "search": {
    "topK": 5,
    "minScore": 0.3
    // includeParametersDefault optional:
    // true  -> always include params
    // false -> always compact
    // unset -> auto (based on mcporter availability)
  },
  "indexer": {
    "connectTimeout": 60000,
    "maxRetries": 3,
    "initialRetryDelay": 2000,
    "maxRetryDelay": 30000,
    "maxChunkChars": 500,
    "overlapChars": 100,
    "generateCliArtifacts": false
  }
}
```

### Notes

- `search.includeParametersDefault` is optional; if omitted, router auto-decides based on mcporter availability.
- `indexer.generateCliArtifacts=true` enables best-effort per-server `mcporter generate-cli` during reindex.
- `mcp_call` stays the classic JSON meta-tool (no backend mode flag).

---

## Server management

```bash
openclaw openclaw-mcp-router control
openclaw openclaw-mcp-router list
openclaw openclaw-mcp-router add <name> <command-or-url> [...]
openclaw openclaw-mcp-router reindex
```

---

## MCPorter inspiration

Huge thanks to **@steipete** and [mcporter](https://github.com/steipete/mcporter) for the CLI-first MCP execution model inspiration.

---

## Documentation

- Architecture + flow details: `docs/CLI_FIRST_WORKFLOW.md`
- Plugin config schema: `openclaw.plugin.json`
- Skill usage examples: `skills/mcp-router/`

---

## Contributing

PRs welcome — especially around:
- better reranking
- hybrid retrieval (vector + lexical)

PR hygiene:
- keep README + docs in sync for every behavior/config/workflow change
- keep `skills/` guidance in sync when user-facing behavior changes
- run test suite before opening PR

## License

MIT


## GitHub SEO checklist

- Set repo description to include: `OpenClaw`, `MCP`, `Model Context Protocol`, `semantic search`
- Add GitHub topics (see `.github/topics.txt`)
- Pin this repository on your profile if it's a flagship plugin
- Link this repo from related blog posts, docs, and demos
