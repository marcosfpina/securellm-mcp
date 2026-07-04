/**
 * Session Bridge — ADR-0003
 *
 * Persistent cross-session memory via Knowledge DB + Cerebro RAG + ADR Ledger.
 *
 * Actions:
 *   recall       — busca local (SQLite FTS5) + semântica (Cerebro API)
 *   snapshot     — salva estado da conversa no knowledge DB
 *   digest       — resumo temporal (hoje, semana, etc.)
 *   adr_context  — busca ADRs relevantes no ADR Ledger
 *   sync_cerebro — indexa knowledge entries no Cerebro RAG
 */

import { z } from "zod";
import type { ExtendedTool } from "../types/mcp-tool-extensions.js";
import { zodToMcpSchema } from "../utils/schema-converter.js";

// ─── Schema ────────────────────────────────────────────────────────────────────

const recallSchema = z.object({
  context: z.string().describe("What the user is working on right now"),
  limit: z.number().int().min(1).max(20).optional().default(5),
  include_adrs: z
    .boolean()
    .optional()
    .default(true)
    .describe("Also search ADR Ledger for related decisions"),
});

const snapshotSchema = z.object({
  tags: z.array(z.string()).optional().describe('Tags: ["nixos", "debugging", "boot-issue"]'),
  summary: z.string().optional().describe("Manual summary (auto-generated if not provided)"),
  files: z.array(z.string()).optional().describe("Files involved in this session"),
  sync_to_cerebro: z
    .boolean()
    .optional()
    .default(false)
    .describe("Also index in Cerebro RAG for future semantic search"),
});

const digestSchema = z.object({
  since: z
    .string()
    .optional()
    .default("today")
    .describe('"today", "yesterday", "this week", "3 days ago"'),
});

const adrContextSchema = z.object({
  context: z.string().describe("What decision context you need ADRs for"),
  project: z
    .string()
    .optional()
    .describe("Filter by project: CEREBRO, SPECTRE, PHANTOM, NEUTRON, GLOBAL"),
});

const syncCerebroSchema = z.object({
  since: z
    .string()
    .optional()
    .default("last_snapshot")
    .describe('"last_snapshot", "today", "1 week ago"'),
  entry_types: z.array(z.string()).optional().describe("Filter by entry type"),
});

// ─── Tool definition ────────────────────────────────────────────────────────────

export const sessionBridgeTool: ExtendedTool = {
  name: "session_bridge",
  description:
    "Persistent cross-session memory: recall past context, save snapshots, search ADR Ledger for architectural decisions, and sync knowledge to Cerebro RAG. Connects MCP ↔ Cerebro ↔ ADR Ledger (ADR-0003, ADR-0008).",
  defer_loading: true,
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["recall", "snapshot", "digest", "adr_context", "sync_cerebro"],
        description: "Which operation to perform",
      },
      // recall params
      context: { type: "string", description: "What the user is working on right now" },
      limit: { type: "number", description: "Max results (default: 5)" },
      include_adrs: { type: "boolean", description: "Also search ADR Ledger" },
      // snapshot params
      tags: { type: "array", items: { type: "string" }, description: "Tags for this session" },
      summary: { type: "string", description: "Manual summary" },
      files: { type: "array", items: { type: "string" }, description: "Files involved" },
      sync_to_cerebro: { type: "boolean", description: "Index in Cerebro RAG" },
      // digest params
      since: { type: "string", description: '"today", "yesterday", "this week"' },
      // adr_context params
      project: { type: "string", description: "Filter ADRs by project" },
      // sync_cerebro params
      entry_types: { type: "array", items: { type: "string" } },
    },
    required: ["action"],
  },
};

// ─── Handler ────────────────────────────────────────────────────────────────────

const CEREBRO_API_URL = process.env.CEREBRO_API_URL || "http://localhost:8009";
const ADR_LEDGER_PATH =
  process.env.ADR_LEDGER_PATH || `${process.env.HOME || "/home/kernelcore"}/master/adr-ledger`;

export async function handleSessionBridge(
  args: {
    action: string;
    context?: string;
    limit?: number;
    include_adrs?: boolean;
    tags?: string[];
    summary?: string;
    files?: string[];
    sync_to_cerebro?: boolean;
    since?: string;
    project?: string;
    entry_types?: string[];
  },
  deps: {
    db: any; // KnowledgeDatabase
    semanticCache: any; // SemanticCache
    projectRoot: string;
  }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { action } = args;

  switch (action) {
    case "recall":
      return handleRecall(args, deps);
    case "snapshot":
      return handleSnapshot(args, deps);
    case "digest":
      return handleDigest(args, deps);
    case "adr_context":
      return handleAdrContext({ context: args.context || "", project: args.project });
    case "sync_cerebro":
      return handleSyncCerebro(args, deps);
    default:
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `Unknown action: ${action}` }) }],
      };
  }
}

// ─── Recall ─────────────────────────────────────────────────────────────────────

async function handleRecall(
  args: { context?: string; limit?: number; include_adrs?: boolean },
  deps: { db: any; semanticCache: any }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { context = "", limit = 5, include_adrs = true } = args;
  const results: any = { local: [], cerebro: null, adrs: null };

  // 1. Local FTS5 search
  try {
    if (deps.db) {
      const stmt = deps.db.prepare(`
        SELECT id, summary, tags, files, created_at, entry_type
        FROM knowledge_entries
        WHERE knowledge_entries MATCH ?
        ORDER BY rank
        LIMIT ?
      `);
      const localResults = stmt.all(context, limit);
      results.local = localResults;
    }
  } catch (err) {
    results.local = { error: "Local search unavailable" };
  }

  // 2. Cerebro RAG (best-effort, graceful degradation)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);
    const resp = await fetch(`${CEREBRO_API_URL}/intelligence/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: context, limit, semantic: true }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (resp.ok) {
      results.cerebro = await resp.json();
    } else {
      results.cerebro = { error: `Cerebro returned ${resp.status}` };
    }
  } catch {
    results.cerebro = { error: "Cerebro unavailable — using local search only" };
  }

  // 3. ADR Ledger context
  if (include_adrs) {
    try {
      const adrResults = await searchAdrLedger(context, limit);
      results.adrs = adrResults;
    } catch {
      results.adrs = { error: "ADR Ledger unavailable" };
    }
  }

  return {
    content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
  };
}

// ─── Snapshot ───────────────────────────────────────────────────────────────────

async function handleSnapshot(
  args: { tags?: string[]; summary?: string; files?: string[]; sync_to_cerebro?: boolean },
  deps: { db: any; semanticCache: any }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { tags = [], summary, files = [], sync_to_cerebro = false } = args;

  const entryId = `snapshot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const autoSummary = summary || `Session at ${new Date().toISOString()}`;

  // Save to local knowledge DB
  let saved = false;
  try {
    if (deps.db) {
      deps.db
        .prepare(
          `INSERT INTO knowledge_entries (id, summary, tags, files, entry_type, created_at)
           VALUES (?, ?, ?, ?, 'session', ?)`
        )
        .run(entryId, autoSummary, JSON.stringify(tags), JSON.stringify(files), Date.now());
      saved = true;
    }
  } catch (err: any) {
    return {
      content: [
        { type: "text", text: JSON.stringify({ error: `Local save failed: ${err.message}` }) },
      ],
    };
  }

  // Optionally sync to Cerebro
  let cerebroStatus = "not requested";
  if (sync_to_cerebro) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      const resp = await fetch(`${CEREBRO_API_URL}/actions/rag/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documents: [
            {
              id: entryId,
              content: autoSummary,
              metadata: { tags, files, source: "session_bridge" },
            },
          ],
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      cerebroStatus = resp.ok ? "synced" : `failed: ${resp.status}`;
    } catch (err: any) {
      cerebroStatus = `failed: ${err.message}`;
    }
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            id: entryId,
            saved,
            summary: autoSummary,
            tags,
            files,
            cerebro: cerebroStatus,
          },
          null,
          2
        ),
      },
    ],
  };
}

// ─── Digest ─────────────────────────────────────────────────────────────────────

async function handleDigest(
  args: { since?: string },
  deps: { db: any }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { since = "today" } = args;

  // Parse time range
  const now = Date.now();
  const ranges: Record<string, number> = {
    today: now - 24 * 60 * 60 * 1000,
    yesterday: now - 48 * 60 * 60 * 1000,
    "this week": now - 7 * 24 * 60 * 60 * 1000,
    "last week": now - 14 * 24 * 60 * 60 * 1000,
  };
  const sinceMs = ranges[since] || now - 24 * 60 * 60 * 1000;

  try {
    if (!deps.db) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "Knowledge DB not available" }) }],
      };
    }

    const stmt = deps.db.prepare(`
      SELECT id, summary, tags, files, entry_type, created_at
      FROM knowledge_entries
      WHERE created_at >= ?
      ORDER BY created_at DESC
    `);
    const entries = stmt.all(sinceMs);

    // Aggregate
    const byType: Record<string, number> = {};
    const allTags = new Set<string>();
    const allFiles = new Set<string>();

    for (const entry of entries) {
      byType[entry.entry_type] = (byType[entry.entry_type] || 0) + 1;
      try {
        JSON.parse(entry.tags || "[]").forEach((t: string) => allTags.add(t));
        JSON.parse(entry.files || "[]").forEach((f: string) => allFiles.add(f));
      } catch {
        /* skip malformed */
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              since,
              total_entries: entries.length,
              by_type: byType,
              tags: [...allTags],
              files: [...allFiles].slice(0, 20),
              entries: entries.slice(0, 10),
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (err: any) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: err.message }) }],
    };
  }
}

// ─── ADR Context ──────────────────────────────────────────────────────────────

async function handleAdrContext(args: {
  context: string;
  project?: string;
}): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { context, project } = args;

  try {
    const adrs = await searchAdrLedger(context, 10, project);
    return {
      content: [{ type: "text", text: JSON.stringify(adrs, null, 2) }],
    };
  } catch (err: any) {
    return {
      content: [
        { type: "text", text: JSON.stringify({ error: `ADR search failed: ${err.message}` }) },
      ],
    };
  }
}

// ─── Sync Cerebro ─────────────────────────────────────────────────────────────

async function handleSyncCerebro(
  args: { since?: string; entry_types?: string[] },
  deps: { db: any }
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    if (!deps.db) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "Knowledge DB not available" }) }],
      };
    }

    // Fetch recent entries
    const sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000; // last week
    const stmt = deps.db.prepare(`
      SELECT id, summary, tags, files, entry_type, created_at
      FROM knowledge_entries
      WHERE created_at >= ?
      ORDER BY created_at DESC
      LIMIT 50
    `);
    const entries = stmt.all(sinceMs);

    if (entries.length === 0) {
      return {
        content: [{ type: "text", text: JSON.stringify({ status: "no new entries to sync" }) }],
      };
    }

    // Send to Cerebro
    const documents = entries.map((e: any) => ({
      id: e.id,
      content: e.summary,
      metadata: {
        tags: e.tags,
        files: e.files,
        entry_type: e.entry_type,
        source: "session_bridge_sync",
      },
    }));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const resp = await fetch(`${CEREBRO_API_URL}/actions/rag/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documents }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              status: resp.ok ? "synced" : `failed: ${resp.status}`,
              entries_synced: entries.length,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (err: any) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: `Sync failed: ${err.message}` }) }],
    };
  }
}

// ─── ADR Ledger search helper ─────────────────────────────────────────────────

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";

async function searchAdrLedger(
  query: string,
  limit: number = 10,
  project?: string
): Promise<any[]> {
  const adrDir = join(ADR_LEDGER_PATH, "adr");
  const results: any[] = [];

  // Search both accepted and proposed
  for (const status of ["accepted", "proposed"]) {
    const statusDir = join(adrDir, status);
    if (!existsSync(statusDir)) continue;

    const files = readdirSync(statusDir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      try {
        const content = readFileSync(join(statusDir, file), "utf-8");
        const queryLower = query.toLowerCase();
        const contentLower = content.toLowerCase();

        // Simple relevance: count keyword matches
        const keywords = queryLower.split(/\s+/).filter((w) => w.length > 2);
        const score = keywords.reduce(
          (acc, kw) => acc + (contentLower.match(new RegExp(kw, "g")) || []).length,
          0
        );

        if (score > 0) {
          // Extract frontmatter
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
          const frontmatter: Record<string, any> = {};
          if (fmMatch) {
            const fm = fmMatch[1];
            const lines = fm.split("\n");
            for (const line of lines) {
              const kv = line.match(/^(\w+):\s*(.+)/);
              if (kv) {
                try {
                  frontmatter[kv[1]] = JSON.parse(kv[2]);
                } catch {
                  frontmatter[kv[1]] = kv[2].replace(/^"(.*)"$/, "$1");
                }
              }
            }
          }

          // Project filter
          if (project && frontmatter.project && frontmatter.project !== project) continue;

          results.push({
            id: frontmatter.id || file.replace(".md", ""),
            title: frontmatter.title || file,
            status: frontmatter.status || status,
            project: frontmatter.project,
            classification: frontmatter.classification,
            date: frontmatter.date,
            score,
          });
        }
      } catch {
        // skip unreadable
      }
    }
  }

  // Sort by relevance, limit
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
