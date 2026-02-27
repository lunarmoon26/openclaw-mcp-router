---
name: mcp-router
description: Discover and route tasks to configured MCP tools using mcp_search + mcp_call. Use when a task needs external capabilities (APIs, SaaS, databases, web, files, messaging, infra) and the best tool is not already known in-session, especially before falling back to manual shell/curl/web workflows.
---

# MCP Router

Use MCP as the first integration layer for external capabilities.

## Core Rule

Before manual API calls, curl scripts, or ad-hoc web work, run:

- `mcp_search("<action-oriented intent>")`

If a relevant tool exists, use it with `mcp_call`.

## Fast Workflow

1. **Search capability**
   - Use an action-oriented query: `"create github pull request"`, `"query postgres"`, `"send slack message"`.
2. **Select tool**
   - Prefer best intent match + feasible required params.
3. **Read schema**
   - Identify required fields, types, enums, nested structure.
4. **Call tool**
   - `mcp_call("exact_tool_name", "{...valid JSON...}")`
5. **Recover on failure**
   - Fix schema/type mismatch or re-search with rewritten query.

## Query Rewrite Ladder (Deterministic)

If search quality is poor, retry in this order:

1. **Action only**: `"read file"`
2. **Action + system**: `"read file from s3"`, `"github create issue"`
3. **Verb swap**: create/open, read/fetch/get, list/enumerate
4. **Scope adjust**: broaden then narrow

Stop once you have a high-confidence tool.

## Tool Selection Rules

When multiple tools match, rank by:

1. Intent fit (description matches requested outcome)
2. Required-input fit (you can provide required params now)
3. Simplicity (fewer fragile/optional parameters)
4. Score/order from search results (tie-breaker)

## `mcp_call` Parameter Checklist

`params_json` must be a **JSON string**.

- Include all required fields.
- Match exact types (`42` vs `"42"`, `true` vs `"true"`).
- Respect enums and nested object shapes.
- Do not add unsupported keys unless schema allows them.

Examples:

```text
✅ mcp_call("filesystem::read_file", '{"path":"/tmp/a.txt"}')
❌ mcp_call("filesystem::read_file", {"path":"/tmp/a.txt"})
```

```text
✅ mcp_call("db::query", '{"sql":"select * from t where id=$1","params":[123]}')
```

## Error Handling

- **Missing required / invalid type**: re-read schema and correct `params_json`.
- **Unknown tool name**: re-run `mcp_search` and use exact returned name.
- **Server-side error**: report clearly; retry only with changed inputs.
- **No relevant tools**: use native fallback tools/workflow.

## Practical Boundaries

- Reuse known tool names in the same task; avoid unnecessary re-search.
- Re-search when intent changes materially.
- Do not loop retries blindly; each retry must change query or params.

For full examples, see [references/workflows.md](references/workflows.md).
