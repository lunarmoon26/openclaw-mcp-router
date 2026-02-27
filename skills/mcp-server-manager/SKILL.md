---
name: mcp-server-manager
description: Manage MCP servers for openclaw-mcp-router (add/list/enable/disable/remove/reindex/setup/control), including choosing openclaw.json vs ~/.openclaw/openclaw-mcp-router/.mcp.json and validating server state after changes. Use when the user asks to add new MCP capabilities, troubleshoot missing tools, rotate credentials/env vars, or maintain MCP server inventory.
---

# MCP Server Manager

Manage MCP server lifecycle through `openclaw-mcp-router` commands first; edit config files directly only when CLI paths cannot express the change.

## Command Surface

Use these exact commands:

- `openclaw openclaw-mcp-router setup`
- `openclaw openclaw-mcp-router control`
- `openclaw openclaw-mcp-router add <name> <command-or-url> [args...] [--transport stdio|sse|http] [--env KEY=VALUE ...] [--timeout <ms>] [--file]`
- `openclaw openclaw-mcp-router list`
- `openclaw openclaw-mcp-router enable <name>`
- `openclaw openclaw-mcp-router disable <name>`
- `openclaw openclaw-mcp-router remove <name>`
- `openclaw openclaw-mcp-router reindex [--server <name>]`

## Source of Truth and Precedence

Server definitions can come from two places:

1. inline plugin config (`plugins.entries.openclaw-mcp-router.config.mcpServers` in `~/.openclaw/openclaw.json`)
2. file-based config (`~/.openclaw/openclaw-mcp-router/.mcp.json` by default, or configured `mcpServersFile`)

Resolution rules:

- Both sources are merged.
- Name collisions are resolved with inline `mcpServers` winning over file-based entries.
- Disabled servers (`disabled: true`) are skipped during indexing.

## Standard Workflow

1. Inspect current state:
   - `openclaw openclaw-mcp-router list`
2. Apply change (add/enable/disable/remove).
3. Reindex:
   - Full: `openclaw openclaw-mcp-router reindex`
   - Single server: `openclaw openclaw-mcp-router reindex --server <name>`
4. Verify:
   - `openclaw openclaw-mcp-router list`
   - confirm status is `ok` and tool count is non-zero when expected.

## Add Server Patterns

### Stdio server (default transport)

```bash
openclaw openclaw-mcp-router add filesystem npx -y @modelcontextprotocol/server-filesystem /path/to/root
```

### HTTP/SSE server

```bash
openclaw openclaw-mcp-router add notion https://mcp.example.com --transport http
```

### Store in `.mcp.json` instead of `openclaw.json`

```bash
openclaw openclaw-mcp-router add github npx -y @modelcontextprotocol/server-github --env GITHUB_TOKEN=${GITHUB_TOKEN} --file
```

## Operational Notes

- Always run `reindex` after add/remove and after most enable/disable changes.
- If a server fails to connect, retry with larger timeout (for slow startup servers):
  - `--timeout 120000`
- For env updates, re-run `add` with the same name (entry is replaced), then reindex.
- Prefer `--file` when keeping credentials and frequently changing servers outside `openclaw.json`.

## Troubleshooting Quick Checks

- No results in `mcp_search`: verify server is enabled and indexed.
- `list` shows `failed`: inspect endpoint/command/env and rerun reindex.
- Server missing: check whether it exists in inline config vs `.mcp.json` and whether an inline entry with same name is overriding it.


## Setup Behavior (mcporter-aware)

- During `openclaw openclaw-mcp-router setup`, detect whether `mcporter` is installed and suggest `mcp_search` schema defaults accordingly.
- First-install guidance:
  - no `mcporter`: keep params visible by default (`search.includeParametersDefault=true`)
  - with `mcporter`: prefer compact cards by default (`search.includeParametersDefault=false`)
- This can still be overridden by users later in plugin config.
