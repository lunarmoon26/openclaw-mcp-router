# CLI-First Workflow (MCP Router + MCPorter)

This document explains the intended execution model:

1. **Reindex for discovery metadata**
2. **Search returns compact tool cards**
3. **Execution prefers CLI (`mcporter call`)**
4. **`mcp_call` remains JSON fallback**

## Goals

- Minimize token usage during tool discovery
- Keep rich schemas available without always injecting them
- Enable deterministic, script-friendly MCP execution via CLI
- Preserve compatibility with classic JSON tool calling

## Reindex behavior

During `openclaw openclaw-mcp-router reindex`:

- Router connects to all enabled servers
- Lists MCP tools
- Chunks/embeds tool text
- Stores vectors + metadata in LanceDB

Optional:
- If `indexer.generateCliArtifacts=true`, router performs best-effort `mcporter generate-cli` per server and writes generated artifacts under router state.
- Artifact generation is non-blocking for indexing success.

## `mcp_search` response model

Default mode is **compact**:
- tool name
- server
- description
- inferred signature
- preferred CLI call hint
- fallback JSON call hint

If full schema is needed:
- pass `include_schema=true`
- or set `search.includeParametersDefault=true`

## Execution policy

Current practical policy:

- Prefer CLI call shape when agent/runtime can use mcporter:
  - `mcporter call <server>.<tool> ...`
- Fall back to `mcp_call` JSON path otherwise.

`mcp_call` supports:
- `sdk` backend (default)
- `mcporter-cli` backend (`callExecution.mode="mcporter-cli"`)

## Why this helps

- Search output stays small and focused
- Less prompt pollution from giant JSON schemas
- CLI invocation can be more scriptable and easier to reuse in automation
- Existing JSON workflows still work

## Recommended config

```json5
{
  "plugins": {
    "entries": {
      "openclaw-mcp-router": {
        "enabled": true,
        "config": {
          "search": {
            "topK": 5,
            "minScore": 0.3,
            "includeParametersDefault": false
          },
          "callExecution": {
            "mode": "sdk",
            "cliCommand": "npx",
            "cliArgs": ["-y", "mcporter"],
            "timeoutMs": 60000
          },
          "indexer": {
            "generateCliArtifacts": true
          }
        }
      }
    }
  }
}
```

## Acknowledgement

Special thanks to **@steipete** and **MCPorter** for the CLI-first inspiration:
<https://github.com/steipete/mcporter>

And Anthropic’s engineering write-up for the broader execution pattern:
<https://www.anthropic.com/engineering/code-execution-with-mcp>
