# CLI-First Workflow (MCP Router + MCPorter)

This document explains the intended execution model:

1. Reindex tools + metadata
2. Search tools with adaptive schema verbosity
3. Prefer CLI calls when available
4. Use `mcp_call` as classic JSON fallback

## Reindex behavior

During `openclaw openclaw-mcp-router reindex`:

- Router connects to enabled MCP servers
- Lists tools
- Chunks/embeds descriptions
- Stores vectors + metadata in LanceDB

Optional:
- If `indexer.generateCliArtifacts=true`, router runs best-effort `mcporter generate-cli` per server.
- Generation failures do **not** block indexing.

## `mcp_search` behavior

`mcp_search` supports adaptive defaults:

- If `mcporter` is installed: default to compact cards (save tokens)
- If `mcporter` is not installed: include JSON params by default (so agents can call `mcp_call` reliably)

Overrides:
- request-level: `include_schema=true|false`
- config-level: `search.includeParametersDefault=true|false`
  - if unset, auto mode is used

## `mcp_call` behavior

`mcp_call` remains the original JSON meta-tool path:

- resolve tool owner by registry
- open MCP connection
- call tool with `params_json`
- return content/errors

No backend mode flag is required.

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
            "minScore": 0.3
            // includeParametersDefault optional (true|false)
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

Special thanks to **@steipete** and **MCPorter**:
<https://github.com/steipete/mcporter>

Anthropic reference:
<https://www.anthropic.com/engineering/code-execution-with-mcp>
