---
name: mcp-router
description: Searches configured MCP servers for external tools by description and executes them on demand, eliminating the need to know tool names in advance. Use when working with any external MCP capability — file operations, web APIs, databases, code execution, GitHub, Kubernetes, Slack, Notion, or any other configured MCP server. Covers writing effective mcp_search queries, reading tool cards and input schemas, formatting mcp_call params_json correctly, and recovering when searches return no matches.
license: MIT
---

# MCP Router: Search and Call External Tools

Two tools provide access to all configured MCP servers without loading their schemas upfront:

- **`mcp_search(query)`** — find tools by semantic description; returns tool cards with names and input schemas
- **`mcp_call(tool_name, params_json)`** — execute a specific tool by its exact name

## The Core Workflow

**Always search before calling.** Tool names vary across servers and cannot be guessed reliably.

### 1. Search

Call `mcp_search` with an action-oriented query describing the desired capability:

```
mcp_search("list files in a directory")
mcp_search("create a pull request on GitHub")
mcp_search("run a SQL query against a Postgres database")
mcp_search("execute Python code in a sandbox")
```

### 2. Read the Tool Card

Each result contains:

- **`name`** — the exact identifier to pass to `mcp_call`
- **`description`** — what the tool does
- **`inputSchema`** — JSON Schema describing required and optional parameters

Read `inputSchema` carefully before calling. It specifies:
- Which parameters are **required** vs optional
- Parameter **types** (string, number, boolean, array, object)
- Any **format** constraints or enum values
- Nested object structure for complex params

### 3. Call the Tool

```
mcp_call("tool_name", '{"param1": "value", "param2": 42}')
```

The second argument (`params_json`) **must be a JSON string** — not a JavaScript object or Python dict. Serialize it first. Include all required parameters exactly as typed in the schema.

---

## Writing Effective Search Queries

The query is embedded and compared against tool descriptions using vector similarity — **not keyword matching**. Semantic phrasing matters.

**Prefer action verbs that describe the outcome:**

| Vague (poor results) | Action-oriented (better results) |
|---|---|
| `"files"` | `"read a file"` or `"list directory contents"` |
| `"github"` | `"create a GitHub pull request"` |
| `"database"` | `"execute a SQL query against a database"` |
| `"k8s"` | `"list Kubernetes pods in a namespace"` |
| `"memory"` | `"store information in long-term memory"` |

**Include the target system when known.** If Brave MCP is configured, `"search the web with Brave"` surfaces it faster than `"search the web"`.

**Start broad, then refine if needed:**

1. Broad first: `"read a file"` → see what file-related tools exist across all servers
2. Narrow if too many results: `"read a file from S3"` or `"read a local file from disk"`

**Try the domain + action pattern** for unfamiliar capabilities:
- `"<system> <action>"` → `"Notion create a page"`, `"Slack send a message"`, `"Docker list containers"`

---

## Calling the Tool Correctly

### params_json must be a JSON string

```
✅  mcp_call("filesystem_read_file", '{"path": "/tmp/data.csv"}')
❌  mcp_call("filesystem_read_file", {path: "/tmp/data.csv"})   ← object, not string
```

### Match the schema exactly

- Required fields: **all must be present** or the server returns an error
- Types: `42` ≠ `"42"` for numeric params; `true` ≠ `"true"` for booleans
- Nested objects: if the schema shows `{ "options": { "encoding": "string" } }`, pass `'{"options": {"encoding": "utf-8"}}'`

### Reuse the tool name

Each `mcp_call` opens a fresh connection — there is no persistent session between calls. Once a tool name is known from `mcp_search`, reuse it directly for subsequent calls in the same workflow without re-searching.

---

## When Search Returns No Useful Results

If `mcp_search` returns nothing relevant or only low-scored matches:

1. **Rephrase** — describe the outcome instead of the mechanism. `"get current date and time"` instead of `"datetime"`.
2. **Broaden** — remove qualifiers. `"create a file"` instead of `"create a markdown file in the workspace"`.
3. **Try synonyms** — `"fetch"` vs `"retrieve"` vs `"get"` vs `"read"` can produce different results.
4. **Check configured servers** — if no server handles the needed capability, `mcp_search` will find nothing regardless of phrasing. Ask the user to run `openclaw openclaw-mcp-router list` to see what is configured.

The index only contains tools from configured MCP servers. Absent capabilities cannot be discovered.

---

## Choosing Among Multiple Results

When several tools match the query, use the tool card to decide:

- **Read descriptions** — the closest semantic match to the intent is usually correct
- **Compare input schemas** — the tool whose required parameters align with available inputs is the practical choice
- **Prefer the higher-scored result** when descriptions are similar
- **Check the server name in the tool ID** (format: `serverName::toolName`) to identify which server owns the tool

When two tools look equally good, call the top-ranked one first. If it fails or returns unexpected output, try the next.

---

## Error Handling

If `mcp_call` returns an error:

- **Schema mismatch** (`missing required field`, `invalid type`): re-read the `inputSchema` from the search result and fix the params
- **Not found** (`tool not registered`, `unknown tool`): re-run `mcp_search` — the tool name may have changed after a reindex
- **Server error** (MCP server returned an error response): report the error message clearly and offer to retry with different parameters or ask the user for clarification

Do not retry the same call with the same parameters if it fails — diagnose the cause first.

---

## Quick Reference

```
# Discover what's available
mcp_search("action I want to perform")

# Execute the tool
mcp_call("exact_tool_name", '{"required_param": "value"}')

# When results are poor, rephrase with an action verb + target system
mcp_search("rephrased query with action verb + target system")
```

For complete end-to-end workflow references, see [references/workflows.md](references/workflows.md).
