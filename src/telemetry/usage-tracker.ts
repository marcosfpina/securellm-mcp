import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";
import type { NatsConnection } from "nats";

const DB_PATH =
  process.env.USAGE_DB_PATH ||
  path.join(process.env.HOME || ".", ".local/share/securellm/usage.db");

export interface InvocationRecord {
  session_id: string;
  client_id?: string;
  tool_name: string;
  params_hash?: string;
  started_at: number;
  duration_ms?: number;
  success: boolean;
  error_code?: string;
  cache_hit?: boolean;
}

export interface UsageSummary {
  period_days: number;
  total_invocations: number;
  successful: number;
  failed: number;
  cache_hits: number;
  cache_hit_rate: string;
  top_tools: Array<{ tool_name: string; count: number; success_rate: string }>;
  avg_duration_ms: number;
  generated_at: string;
}

const NATS_URL = process.env.NATS_URL || "nats://localhost:4222";
const NATS_SUBJECT = "system.metrics.v1";

class UsageTracker {
  private db: InstanceType<typeof Database> | null = null;
  private nats: NatsConnection | null = null;
  private natsConnecting = false;

  private getDb(): InstanceType<typeof Database> {
    if (this.db) return this.db;
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    this.db = new Database(DB_PATH);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_invocations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT    NOT NULL,
        client_id   TEXT,
        tool_name   TEXT    NOT NULL,
        params_hash TEXT,
        started_at  INTEGER NOT NULL,
        duration_ms INTEGER,
        success     INTEGER NOT NULL,
        error_code  TEXT,
        cache_hit   INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_tool_name ON tool_invocations(tool_name);
      CREATE INDEX IF NOT EXISTS idx_started_at ON tool_invocations(started_at);
    `);
    return this.db;
  }

  private async getNats(): Promise<NatsConnection | null> {
    if (this.nats) return this.nats;
    if (this.natsConnecting) return null;
    this.natsConnecting = true;
    try {
      const { connect } = await import("nats");
      this.nats = await connect({ servers: NATS_URL, timeout: 3_000 });
      return this.nats;
    } catch {
      // NATS unavailable — silently degrade to SQLite-only
      return null;
    } finally {
      this.natsConnecting = false;
    }
  }

  record(inv: InvocationRecord): void {
    try {
      this.getDb()
        .prepare(
          `INSERT INTO tool_invocations
           (session_id, client_id, tool_name, params_hash, started_at, duration_ms, success, error_code, cache_hit)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          inv.session_id,
          inv.client_id ?? null,
          inv.tool_name,
          inv.params_hash ?? null,
          inv.started_at,
          inv.duration_ms ?? null,
          inv.success ? 1 : 0,
          inv.error_code ?? null,
          inv.cache_hit ? 1 : 0
        );
    } catch {
      // Non-fatal — telemetry must never break tool execution
    }

    // Publish to NATS/Spectre (fire-and-forget)
    void this.getNats().then((nc) => {
      if (!nc) return;
      try {
        const payload = JSON.stringify({
          event_type: "mcp.tool.invocation.v1",
          source_service: "securellm-mcp",
          tool_name: inv.tool_name,
          session_id: inv.session_id,
          started_at: inv.started_at,
          duration_ms: inv.duration_ms,
          success: inv.success,
          cache_hit: inv.cache_hit ?? false,
          error_code: inv.error_code,
        });
        nc.publish(NATS_SUBJECT, new TextEncoder().encode(payload));
      } catch {
        /* non-fatal */
      }
    });
  }

  summary(periodDays: number = 7): UsageSummary {
    const db = this.getDb();
    const since = Date.now() - periodDays * 86_400_000;

    const totals = db
      .prepare(
        `SELECT COUNT(*) as total,
                SUM(success) as successful,
                SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) as failed,
                SUM(cache_hit) as cache_hits,
                AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END) as avg_dur
         FROM tool_invocations WHERE started_at >= ?`
      )
      .get(since) as any;

    const topTools = db
      .prepare(
        `SELECT tool_name, COUNT(*) as count,
                ROUND(100.0 * SUM(success) / COUNT(*), 1) as success_rate
         FROM tool_invocations WHERE started_at >= ?
         GROUP BY tool_name ORDER BY count DESC LIMIT 10`
      )
      .all(since) as any[];

    const total = totals.total || 0;
    const cacheHits = totals.cache_hits || 0;

    return {
      period_days: periodDays,
      total_invocations: total,
      successful: totals.successful || 0,
      failed: totals.failed || 0,
      cache_hits: cacheHits,
      cache_hit_rate: total > 0 ? `${((cacheHits / total) * 100).toFixed(1)}%` : "0%",
      top_tools: topTools.map((r) => ({
        tool_name: r.tool_name,
        count: r.count,
        success_rate: `${r.success_rate}%`,
      })),
      avg_duration_ms: Math.round(totals.avg_dur || 0),
      generated_at: new Date().toISOString(),
    };
  }

  async close(): Promise<void> {
    try {
      await this.nats?.drain();
    } catch {
      /* ignore */
    }
    this.nats = null;
    this.db?.close();
    this.db = null;
  }
}

// Singleton
export const usageTracker = new UsageTracker();
