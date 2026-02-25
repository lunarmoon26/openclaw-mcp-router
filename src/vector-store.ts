import type * as LanceDB from "@lancedb/lancedb";

// Known embedding dimensions — kept in sync with embeddings.ts
const KNOWN_DIMS: Record<string, number> = {
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
  "all-minilm": 384,
};

const TABLE_NAME = "mcp_tools";

export type McpToolEntry = {
  /** Stable upsert key: "${server_name}::${tool_name}" */
  tool_id: string;
  server_name: string;
  tool_name: string;
  description: string;
  /** JSON.stringify of MCP inputSchema */
  parameters_json: string;
  vector: number[];
};

type SearchResult = {
  entry: McpToolEntry;
  score: number;
};

// Deferred LanceDB import to match memory-lancedb lazy-init pattern
let lancedbPromise: Promise<typeof import("@lancedb/lancedb")> | null = null;
function loadLanceDB(): Promise<typeof import("@lancedb/lancedb")> {
  if (!lancedbPromise) {
    lancedbPromise = import("@lancedb/lancedb");
  }
  return lancedbPromise.catch((err) => {
    lancedbPromise = null;
    throw new Error(
      `mcp-router: failed to load LanceDB native bindings. ${String(err)}`,
      { cause: err },
    );
  });
}

export class McpToolVectorStore {
  private db: LanceDB.Connection | null = null;
  private table: LanceDB.Table | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly modelName: string,
  ) {}

  private async ensureInitialized(): Promise<void> {
    if (this.table) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const lancedb = await loadLanceDB();
    this.db = await lancedb.connect(this.dbPath);
    const tables = await this.db.tableNames();

    if (tables.includes(TABLE_NAME)) {
      // Open existing table (trust its vector dimension)
      this.table = await this.db.openTable(TABLE_NAME);
    } else {
      // Create table with sentinel row to establish schema, then delete sentinel
      const vectorDim = KNOWN_DIMS[this.modelName] ?? 768;
      this.table = await this.db.createTable(TABLE_NAME, [
        {
          tool_id: "__schema__",
          server_name: "",
          tool_name: "",
          description: "",
          parameters_json: "{}",
          vector: Array.from<number>({ length: vectorDim }).fill(0),
        },
      ]);
      await this.table.delete('tool_id = "__schema__"');
    }
  }

  /**
   * Upsert a tool entry: delete existing row by tool_id then insert.
   * LanceDB has no native upsert, so we replicate the delete-then-add pattern
   * used in memory-lancedb.
   */
  async upsertTool(entry: McpToolEntry): Promise<void> {
    await this.ensureInitialized();
    // Escape single quotes in tool_id for SQL filter safety
    const safeId = entry.tool_id.replace(/'/g, "\\'");
    await this.table!.delete(`tool_id = '${safeId}'`);
    await this.table!.add([entry]);
  }

  /**
   * Search for tools semantically similar to the given vector.
   * Converts L2 distance to a [0,1] score: score = 1 / (1 + distance).
   */
  async searchTools(
    vector: number[],
    topK: number,
    minScore: number,
  ): Promise<SearchResult[]> {
    await this.ensureInitialized();
    const rows = await this.table!.vectorSearch(vector).limit(topK).toArray();

    const results: SearchResult[] = rows.map((row) => {
      const distance = (row._distance as number | undefined) ?? 0;
      const score = 1 / (1 + distance);
      return {
        entry: {
          tool_id: row.tool_id as string,
          server_name: row.server_name as string,
          tool_name: row.tool_name as string,
          description: row.description as string,
          parameters_json: row.parameters_json as string,
          vector: row.vector as number[],
        },
        score,
      };
    });

    return results.filter((r) => r.score >= minScore);
  }

  /** Delete all tool entries belonging to a server. */
  async deleteServer(serverName: string): Promise<void> {
    await this.ensureInitialized();
    const safe = serverName.replace(/'/g, "\\'");
    await this.table!.delete(`server_name = '${safe}'`);
  }

  async countTools(): Promise<number> {
    await this.ensureInitialized();
    return this.table!.countRows();
  }
}
