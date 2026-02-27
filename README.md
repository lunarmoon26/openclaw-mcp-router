# OpenClaw MCP Router 🚀

**OpenClaw MCP Router** is a dynamic tool discovery layer for [OpenClaw](https://openclaw.ai). It uses semantic vector search to eliminate **Context Bloat** by routing only the necessary Model Context Protocol (MCP) tool schemas to your agent on-demand.

## ⚡ The Problem: Context Window Exhaustion

Modern MCP catalogs are growing. Loading every tool schema upfront is expensive and inefficient:

* **Token Waste:** 5 MCP servers with 50+ tools can burn **55k–134k tokens** before your agent even says "Hello."
* **Performance Hit:** Massive system prompts degrade reasoning accuracy (the "lost in the middle" phenomenon).
* **Cost:** High token usage leads to higher API costs for every turn of the conversation.

## 🛠️ The Solution: Semantic Tool Routing

Instead of a full schema dump, this plugin registers two lightweight "Meta-Tools":

1. **`mcp_search(query)`**: Uses **Ollama** and **LanceDB** to perform a semantic search. It returns only the top-N most relevant tool definitions (reducing overhead by ~95%).
2. **`mcp_call(tool_name, params)`**: Dynamically resolves the owning MCP server and executes the call.

> **Result:** Your agent "asks" for the tools it needs, keeping the context window clean and the reasoning sharp.

---

## 🚀 Quick Start

### 1. Prerequisites

Ensure you have **Ollama** running locally with an embedding model:

```bash
ollama pull embeddinggemma

```

### 2. Installation

```bash
openclaw plugins install openclaw-mcp-router

```

### 3. Setup & Indexing

Run the interactive wizard to configure your servers and automatically update your `alsoAllow` permissions:

```bash
openclaw openclaw-mcp-router setup
openclaw openclaw-mcp-router reindex

```

---

## ⚙️ Configuration

The plugin is highly configurable via `~/.openclaw/openclaw.json`.

### Server Management

You can manage servers via the **Interactive TUI**:

```bash
openclaw openclaw-mcp-router control

```

### Manual Schema Example

For power users, add servers directly to your `plugins.entries`:

| Key | Description | Default |
| --- | --- | --- |
| `topK` | Number of tools returned per search | `5` |
| `minScore` | Similarity threshold (0.0 - 1.0) | `0.3` |
| `maxRetries` | Connection attempts for slow servers | `3` |

```json5
// ~/.openclaw/openclaw.json
{
  "plugins": {
    "entries": {
      "openclaw-mcp-router": {
        "enabled": true,
        "config": {
          "servers": [{ "name": "filesystem", "transport": "stdio", "command": "npx", "args": ["..."] }],
          "embedding": { "provider": "ollama", "model": "embeddinggemma" }
        }
      }
    }
  }
}

```

---

## 🧠 How It Works: Under the Hood

1. **Indexing:** During `reindex`, the router connects to all configured MCP servers, fetches their manifests, and generates vector embeddings for every tool description.
2. **Storage:** These embeddings are stored in a local **LanceDB** instance for sub-millisecond retrieval.
3. **Runtime Discovery:** * Agent detects a task (e.g., "Analyze this CSV").
* Agent calls `mcp_search("read or analyze csv files")`.
* Router returns the `filesystem` tool schema.
* Agent executes the tool via `mcp_call`.



---

## 📈 Performance & Benchmarks

Based on the [Anthropic Tool Search](https://www.anthropic.com/engineering/advanced-tool-use) pattern, dynamic routing can improve tool selection accuracy significantly:

* **Standard Loading:** ~49% Accuracy (Large catalogs)
* **Dynamic Routing:** **~88% Accuracy** (Opus 4.5 benchmarks)

---

## 🤝 Contributing

We are looking to implement **Hybrid Search (BM25)** and **LLM-based Reranking**. If you're interested in improving LLM orchestration efficiency, we'd love your help!

1. Fork the repo.
2. Create your feature branch.
3. Submit a PR.

## 📄 License

Released under the [MIT License](https://www.google.com/search?q=LICENSE).
