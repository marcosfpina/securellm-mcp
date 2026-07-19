import type { KnowledgeDatabase } from "../types/knowledge.js";
import type { ExtendedTool } from "../types/mcp-tool-extensions.js";
import { adrTools } from "../tools/adr/index.js";
import { executeInSandboxTool } from "../tools/secure-execution.js";
import { gitSherlockTool } from "../tools/git-sherlock.js";
import { sessionBridgeTool } from "../tools/session-bridge.js";
import { nvimContextTool } from "../tools/nvim-context.js";
import { projectContextTool } from "../tools/project-context.js";
import { ecosystemTools } from "../tools/ecosystem-tools.js";
import { umbrellaTools } from "../tools/umbrella-tools.js";
import { uxTools } from "../tools/bridge-ux.js";
import { memoriesTool } from "../tools/memories.js";
import { consolidatedTools } from "../tools/consolidated.js";
import { professionalTools } from "../tools/professional-tools.js";
import {
  browserLaunchAdvancedSchema,
} from "../tools/browser/index.js";
import { cerebroRagTools } from "../tools/cerebro-rag.js";

export function buildToolCatalog(
  db: KnowledgeDatabase | null,
  enableKnowledge: boolean
): ExtendedTool[] {
  return [
    // ── Server internals ─────────────────────────────────────────────
    {
      name: "server_status",
      description: "Get current MCP server status, feature flags, and runtime health",
      defer_loading: true,
      inputSchema: {
        type: "object",
        properties: {
          include_metrics: {
            type: "boolean",
            description: "Include per-tool metrics and queue state",
            default: true,
          },
        },
      },
    },
    {
      name: "cache_stats",
      description: "Get semantic cache and rate limiter statistics",
      defer_loading: true,
      inputSchema: { type: "object", properties: {} },
    },

    // ── Consolidated semantic tools ──────────────────────────────────
    ...consolidatedTools,            // search, code_analyze, quality_gate, system
    ...(enableKnowledge && db ? [memoriesTool] : []),

    // ── ADR ──────────────────────────────────────────────────────────
    ...adrTools,

    // ── Execution & automation ────────────────────────────────────────
    executeInSandboxTool,
    browserLaunchAdvancedSchema,

    // ── Context & ecosystem ───────────────────────────────────────────
    projectContextTool,
    sessionBridgeTool,
    gitSherlockTool,
    nvimContextTool,
    ...ecosystemTools,
    ...umbrellaTools,

    // ── Cerebro RAG — direct integration ─────────────────────────────
    ...cerebroRagTools,

    // ── UX design mode ────────────────────────────────────────────────
    ...uxTools,

    // ── Professional operations ───────────────────────────────────────
    ...professionalTools,
  ] as ExtendedTool[]; // end buildToolCatalog
}
