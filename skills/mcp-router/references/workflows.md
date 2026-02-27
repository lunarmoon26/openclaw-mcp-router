# Complete Workflow Examples

---

## Example 0: Check MCP before web search

**Goal:** Research a topic — but before using a built-in web search, check if a configured MCP server already handles this.

```
mcp_search("search the web")
```

**Tool card returned:**
```
Tool: brave::web_search
Description: Search the web using the Brave Search API.
Input Schema:
  - query (string, required): The search query
  - count (number, optional): Number of results (default: 10)
```

**Call:**
```
mcp_call("brave::web_search", '{"query": "MCP server authentication patterns", "count": 5}')
```

If no web-search tool appears, fall back to whichever search capability is natively available.

**The pattern applies everywhere:**
- Need to fetch a URL? → `mcp_search("fetch a webpage")` before using curl
- Need to query a DB? → `mcp_search("run a SQL query")` before writing a connection script
- Need to post to Slack? → `mcp_search("send a Slack message")` before building an API request
- Need to read a file? → `mcp_search("read a local file")` before opening a shell

The configured MCP catalog is the toolbox. Exhaust it before doing things the hard way.

These end-to-end examples show the full search → read tool card → call sequence with realistic inputs.

---

## Example 1: Read a local file

**Goal:** Read the contents of `/tmp/report.txt`.

```
mcp_search("read a local file")
```

**Tool card returned:**
```
Tool: filesystem::read_file
Description: Read the complete contents of a file from the local filesystem.
Input Schema:
  - path (string, required): Absolute path to the file
  - encoding (string, optional): File encoding (default: "utf-8")
```

**Call:**
```
mcp_call("filesystem::read_file", '{"path": "/tmp/report.txt"}')
```

---

## Example 2: Create a GitHub pull request

**Goal:** Open a PR from branch `feature/add-auth` to `main`.

```
mcp_search("create a GitHub pull request")
```

**Tool card returned:**
```
Tool: github::create_pull_request
Description: Creates a new pull request in a GitHub repository.
Input Schema:
  - owner (string, required): Repository owner (user or org)
  - repo (string, required): Repository name
  - title (string, required): PR title
  - head (string, required): Branch containing the changes
  - base (string, required): Branch to merge into
  - body (string, optional): PR description in Markdown
```

**Call:**
```
mcp_call("github::create_pull_request", '{
  "owner": "acme-corp",
  "repo": "backend",
  "title": "Add JWT authentication",
  "head": "feature/add-auth",
  "base": "main",
  "body": "Implements JWT-based auth as described in issue #42."
}')
```

---

## Example 3: Query a database

**Goal:** Count active users in a Postgres database.

```
mcp_search("execute a SQL query against a Postgres database")
```

**Tool card returned:**
```
Tool: postgres::query
Description: Execute a read-only SQL query against the configured Postgres database.
Input Schema:
  - sql (string, required): SQL statement to execute
  - params (array, optional): Positional parameters for parameterized queries
```

**Call:**
```
mcp_call("postgres::query", '{"sql": "SELECT COUNT(*) FROM users WHERE active = true"}')
```

---

## Example 4: Multi-step workflow (search once, call multiple times)

**Goal:** List files in a directory, then read one of them.

```
mcp_search("list files in a directory")
```

**Tool card returned:**
```
Tool: filesystem::list_directory
Description: List the files and subdirectories in a given directory.
Input Schema:
  - path (string, required): Absolute path to the directory
  - recursive (boolean, optional): Include subdirectories (default: false)
```

**Call 1 — list:**
```
mcp_call("filesystem::list_directory", '{"path": "/tmp/project"}')
```

**Result:** `["README.md", "config.json", "src/"]`

**Call 2 — read (reuse known tool name `filesystem::read_file` from Example 1):**
```
mcp_call("filesystem::read_file", '{"path": "/tmp/project/config.json"}')
```

No second `mcp_search` needed — once a tool name is known, reuse it directly.

---

## Example 5: Handling a failed search

**Goal:** Get the current weather for a city, but the first query returns nothing.

```
mcp_search("weather")
```

**Result:** No matches.

**Rephrase with action verb + domain:**
```
mcp_search("get current weather conditions for a city")
```

**Tool card returned:**
```
Tool: weather-api::current
Description: Fetches current weather conditions for a given city or coordinates.
Input Schema:
  - city (string, required): City name or "lat,lon" coordinates
  - units (string, optional): "metric" or "imperial" (default: "metric")
```

**Call:**
```
mcp_call("weather-api::current", '{"city": "San Francisco", "units": "imperial"}')
```
