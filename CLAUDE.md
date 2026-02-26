# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

- `npm test` — run all tests (vitest)
- `npx vitest run src/test/config.test.ts` — run a single test file
- `npx vitest run -t "test name"` — run a single test by name
- `npm run typecheck` — type-check without emitting (`tsc --noEmit`)

No build step — OpenClaw loads `src/index.ts` directly via the `openclaw.extensions` field in package.json.

## Architecture

This is an **OpenClaw plugin** that solves MCP context bloat. Instead of loading all MCP tool schemas upfront (~77k tokens for 58 tools), it exposes two meta-tools that let the agent discover and call tools on demand (~8.7k tokens, 95% reduction).

### Data Flow

1. **Startup (indexing):** Plugin connects to each configured MCP server in parallel (with retry/backoff per server) → lists tools → embeds descriptions via Ollama → stores vectors in local LanceDB. An `AbortController` governs the lifecycle — `stop()` cancels all in-flight connections and delays immediately.
2. **Search:** Agent calls `mcp_search(query)` → query embedded → vector similarity search → returns matching tool cards with schemas
3. **Execution:** Agent calls `mcp_call(tool_name, params_json)` → registry lookup for owning server → fresh MCP client connection → execute → return result

### Module Map

| Module | Role |
|--------|------|
| `src/index.ts` | Plugin entry point — registers tools, CLI commands, and startup service with OpenClaw's `OpenClawPluginApi` |
| `src/config.ts` | Parses plugin YAML config into typed `McpRouterConfig` (including `IndexerConfig` and per-server `timeout`); validates, applies defaults, expands `${VAR}` and `~/` |
| `src/embeddings.ts` | `OllamaEmbeddings` — embeds text via Ollama's `/api/embeddings`; SSRF-safe (localhost-only); caches known model dimensions |
| `src/vector-store.ts` | `McpToolVectorStore` — LanceDB wrapper; lazy init; upsert via delete-then-add; L2 distance → similarity score |
| `src/indexer.ts` | `runIndexer()` — parallel server indexing with `Promise.allSettled`; per-server retry with exponential backoff; `AbortSignal` threading for cancellation; `abortableDelay()` helper |
| `src/mcp-client.ts` | `McpClient` — thin MCP SDK wrapper; supports stdio/sse/http transports; `connect()` accepts optional `{ signal, timeout }` forwarded to SDK |
| `src/mcp-registry.ts` | `McpRegistry` — in-memory `toolName → serverConfig` map; last-writer-wins on name collisions |
| `src/tools/mcp-search-tool.ts` | `mcp_search` tool — embeds query, searches vector store, formats tool cards |
| `src/tools/mcp-call-tool.ts` | `mcp_call` tool — resolves server from registry, opens fresh connection, executes, disconnects |

### Key Patterns

- **Dependency injection via factory functions.** `createMcpSearchTool({ store, embeddings, cfg })` and `createMcpCallTool({ registry, logger })` accept their deps explicitly. Tests mock these deps.
- **Optional tool registration.** Both tools use `{ optional: true }` — they only appear in agent context when `tools.alsoAllow` includes them.
- **Compound tool IDs.** Vector store entries use `"${serverName}::${toolName}"` as stable upsert keys.
- **Graceful degradation.** Indexer uses `Promise.allSettled` — one failing server doesn't block others. Ollama being unreachable is a warning, not a crash.
- **Retry with backoff.** Each server gets `maxRetries` attempts with exponential backoff (`initialRetryDelay * 2^(attempt-1)`, capped at `maxRetryDelay`). Per-server `timeout` overrides the global `indexer.connectTimeout`.
- **AbortSignal lifecycle.** `runIndexer` accepts an optional `AbortSignal`. The plugin entry point manages an `AbortController` — `start()` creates one, `stop()` aborts it. The `reindex` CLI command handles SIGINT. `abortableDelay()` ensures backoff waits are cancelled immediately on abort.
- **Fresh connections per call.** `mcp_call` opens a new MCP client connection for each invocation (stateless, no pooling).

## Testing

Tests live in `src/test/` and use Vitest with `vi.mock()` / `vi.fn()` for all external dependencies (MCP SDK, fetch, LanceDB). No real MCP servers or Ollama needed to run tests.

## Background: Anthropic's Advanced Tool Use

This plugin implements the **Tool Search** pattern from Anthropic's advanced tool use guide. The core idea: instead of injecting all tool schemas into the system prompt (causing context pollution and degraded tool selection accuracy), provide a search tool that dynamically surfaces only relevant tools at runtime. Anthropic's benchmarks showed this approach improved tool selection accuracy from 49% → 74% (Opus 4) and 79.5% → 88.1% (Opus 4.5).
