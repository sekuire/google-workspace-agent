export interface CloudflareD1Config {
  accountId: string;
  databaseId: string;
  apiToken: string;
}

export interface MemoryMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryStorage {
  add(sessionId: string, message: MemoryMessage): Promise<void>;
  get(sessionId: string, limit?: number): Promise<MemoryMessage[]>;
  clear(sessionId: string): Promise<void>;
  delete(sessionId: string): Promise<void>;
  exists(sessionId: string): Promise<boolean>;
}

interface D1Response {
  success: boolean;
  errors: Array<{ message: string }>;
  result: Array<{
    results: Array<Record<string, unknown>>;
    success: boolean;
  }>;
}

export class CloudflareD1Memory implements MemoryStorage {
  private baseUrl: string;
  private headers: Record<string, string>;
  private initialized = false;

  constructor(private config: CloudflareD1Config) {
    this.baseUrl = `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}`;
    this.headers = {
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "application/json",
    };
  }

  private async query(sql: string, params: unknown[] = []): Promise<D1Response> {
    const response = await fetch(`${this.baseUrl}/query`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ sql, params }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`D1 query failed: ${error}`);
    }

    return response.json() as Promise<D1Response>;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.query(`
      CREATE TABLE IF NOT EXISTS memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        metadata TEXT
      )
    `);

    await this.query(`
      CREATE INDEX IF NOT EXISTS idx_memory_session
      ON memory(session_id, timestamp DESC)
    `);

    this.initialized = true;
  }

  async add(sessionId: string, message: MemoryMessage): Promise<void> {
    await this.initialize();

    await this.query(
      `INSERT INTO memory (session_id, role, content, timestamp, metadata) VALUES (?, ?, ?, ?, ?)`,
      [
        sessionId,
        message.role,
        message.content,
        message.timestamp,
        message.metadata ? JSON.stringify(message.metadata) : null,
      ]
    );
  }

  async get(sessionId: string, limit?: number): Promise<MemoryMessage[]> {
    await this.initialize();

    const sql = limit
      ? `SELECT role, content, timestamp, metadata FROM memory WHERE session_id = ? ORDER BY timestamp ASC LIMIT ?`
      : `SELECT role, content, timestamp, metadata FROM memory WHERE session_id = ? ORDER BY timestamp ASC`;

    const params = limit ? [sessionId, limit] : [sessionId];
    const result = await this.query(sql, params);

    if (!result.success || !result.result[0]?.results) {
      return [];
    }

    return result.result[0].results.map((row) => ({
      role: row.role as "user" | "assistant" | "system",
      content: row.content as string,
      timestamp: row.timestamp as number,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
    }));
  }

  async clear(sessionId: string): Promise<void> {
    await this.initialize();
    await this.query(`DELETE FROM memory WHERE session_id = ?`, [sessionId]);
  }

  async delete(sessionId: string): Promise<void> {
    await this.clear(sessionId);
  }

  async exists(sessionId: string): Promise<boolean> {
    await this.initialize();

    const result = await this.query(
      `SELECT 1 FROM memory WHERE session_id = ? LIMIT 1`,
      [sessionId]
    );

    return (
      result.success &&
      result.result[0]?.results &&
      result.result[0].results.length > 0
    );
  }

  async getRecentSessions(limit = 10): Promise<string[]> {
    await this.initialize();

    const result = await this.query(
      `SELECT DISTINCT session_id FROM memory ORDER BY timestamp DESC LIMIT ?`,
      [limit]
    );

    if (!result.success || !result.result[0]?.results) {
      return [];
    }

    return result.result[0].results.map((row) => row.session_id as string);
  }

  async getSessionStats(sessionId: string): Promise<{
    messageCount: number;
    firstMessage: number | null;
    lastMessage: number | null;
  }> {
    await this.initialize();

    const result = await this.query(
      `SELECT COUNT(*) as count, MIN(timestamp) as first, MAX(timestamp) as last
       FROM memory WHERE session_id = ?`,
      [sessionId]
    );

    if (!result.success || !result.result[0]?.results?.[0]) {
      return { messageCount: 0, firstMessage: null, lastMessage: null };
    }

    const row = result.result[0].results[0];
    return {
      messageCount: (row.count as number) || 0,
      firstMessage: (row.first as number) || null,
      lastMessage: (row.last as number) || null,
    };
  }
}
