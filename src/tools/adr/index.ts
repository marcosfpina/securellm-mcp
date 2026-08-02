/**
 * ADR MCP Tools — Full Blockchain Integration
 *
 * 21 tools: 13 read + 8 write
 * Delegates to `scripts/adr` CLI and `.chain/` Python modules via CLIBackend.
 */

import type { ExtendedTool } from "../../types/mcp-tool-extensions.js";
import { ResearchParser } from "./research/parser.js";
import { CLIBackend } from "./storage/cli-backend.js";
import type {
  ADRCreateArgs,
  ADRListArgs,
  ADRShowArgs,
  ADRAcceptArgs,
  ADRSearchArgs,
  ResearchData,
} from "./types.js";
import { stringifyGeneric } from "../../utils/json-schemas.js";
import { logger } from "../../utils/logger.js";
import { ADRRuntimeGate, FilesystemScanner } from "./runtime-gate.js";
import type { RuntimeGateResult, ScannedADR } from "./runtime-gate.js";
import { existsSync } from "fs";
import { join } from "path";

const DEFAULT_ADR_LEDGER_PATH = "/home/kernelcore/Projects/master/deploy/adr-ledger";

function hasAdrLayout(repoPath: string): boolean {
  return existsSync(join(repoPath, "adr")) || existsSync(join(repoPath, "docs", "adr"));
}

function resolveAdrRepoPath(): string {
  if (process.env.ADR_REPO_PATH) return process.env.ADR_REPO_PATH;

  // Priority: explicit ADR_REPO_PATH > PROJECT_ROOT > cwd > adr-ledger staging > adr-ledger master
  const candidates = [
    process.env.PROJECT_ROOT,
    process.cwd(),
    DEFAULT_ADR_LEDGER_PATH,
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find(hasAdrLayout) || process.env.PROJECT_ROOT || process.cwd();
}

const ADR_REPO_PATH = resolveAdrRepoPath();
const backend = new CLIBackend(ADR_REPO_PATH);
const gate = new ADRRuntimeGate(ADR_REPO_PATH);
const scanner = new FilesystemScanner(ADR_REPO_PATH);

// ═══════════════════════════════════════════════════════════════
// Tool definitions
// ═══════════════════════════════════════════════════════════════

export const adrTools: ExtendedTool[] = [
  // ─── ADR Query (6) ───
  {
    name: "adr_new",
    description: "Create new Architecture Decision Record",
    defer_loading: false,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Title of the architectural decision" },
        project: {
          type: "string",
          description: "Project name (CEREBRO, SPECTRE, PHANTOM, NEUTRON, GLOBAL)",
          default: "GLOBAL",
        },
        classification: {
          type: "string",
          enum: ["critical", "major", "minor", "patch"],
          description: "Decision classification",
          default: "major",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "adr_new_from_research",
    description: "Generate ADR from research_agent validation data with credibility scoring",
    defer_loading: false,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Title of the architectural decision" },
        research_data: { type: "object", description: "Output from research_agent tool" },
        project: { type: "string", description: "Project name", default: "GLOBAL" },
      },
      required: ["title", "research_data"],
    },
  },
  {
    name: "adr_list",
    description: "List all ADRs with optional filters by status, project, or classification",
    defer_loading: false,
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["proposed", "accepted", "rejected", "superseded", "deprecated"],
          description: "Filter by status",
        },
        project: {
          type: "string",
          description: "Filter by project name (CEREBRO, SPECTRE, PHANTOM, NEUTRON, GLOBAL)",
        },
        format: {
          type: "string",
          enum: ["table", "json"],
          description: "Output format",
          default: "table",
        },
      },
    },
  },
  {
    name: "adr_show",
    description: "Show detailed ADR content including frontmatter and body",
    defer_loading: false,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "ADR ID (e.g., ADR-0001)" },
      },
      required: ["id"],
    },
  },
  {
    name: "adr_search",
    description: "Full-text search across all ADRs (title and content)",
    defer_loading: false,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        status_filter: {
          type: "string",
          enum: ["proposed", "accepted", "rejected", "superseded"],
          description: "Filter by status",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "adr_relations",
    description: "Show relation graph for an ADR: supersedes, superseded_by, related_to, enables",
    defer_loading: false,
    inputSchema: {
      type: "object",
      properties: {
        adr_id: { type: "string", description: "ADR ID (e.g., ADR-0001)" },
      },
      required: ["adr_id"],
    },
  },
  {
    name: "adr_validate",
    description:
      "Validate ADR(s) against governance contracts (required fields, schema compliance)",
    defer_loading: false,
    inputSchema: {
      type: "object",
      properties: {
        adr_id: { type: "string", description: "ADR ID to validate (omit for all)" },
      },
    },
  },
  {
    name: "adr_gate",
    description: "ADR Runtime Assurance Gate: probe runtime level before any write (ADR-0065)",
    defer_loading: false,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "governance_rules",
    description: "Show governance configuration: approval matrix, compliance tags, chain config",
    defer_loading: false,
    inputSchema: { type: "object", properties: {} },
  },

  // ─── Blockchain Verification (4) ───
  {
    name: "chain_status",
    description: "Get blockchain status: height, tip hash, last ADR, signed count",
    defer_loading: false,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "chain_verify",
    description:
      "Full chain verification report: hash chain integrity, signatures, per-block results",
    defer_loading: false,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "chain_prove",
    description:
      "Generate Merkle inclusion proof for an ADR (cryptographic proof of existence in chain)",
    defer_loading: false,
    inputSchema: {
      type: "object",
      properties: {
        adr_id: { type: "string", description: "ADR ID (e.g., ADR-0001)" },
      },
      required: ["adr_id"],
    },
  },
  {
    name: "provenance_trace",
    description: "Show provenance trail for an ADR: stages from research through acceptance",
    defer_loading: false,
    inputSchema: {
      type: "object",
      properties: {
        adr_id: { type: "string", description: "ADR ID (e.g., ADR-0001)" },
      },
      required: ["adr_id"],
    },
  },

  // ─── Analytics (3) ───
  {
    name: "snapshot_latest",
    description: "Get the latest cryptographic snapshot: hash, merkle root, stats",
    defer_loading: false,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "economics_report",
    description: "ADR economics: quality scores, velocity, distribution by project/classification",
    defer_loading: false,
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "sbom_status",
    description: "Show current SBOM (Software Bill of Materials): dependency count, drift status",
    defer_loading: false,
    inputSchema: { type: "object", properties: {} },
  },

  // ─── ADR Lifecycle (4) ───
  {
    name: "adr_accept",
    description:
      "Accept a proposed ADR: governance check → move file → chain append → merkle rebuild → provenance → snapshot",
    defer_loading: false,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "ADR ID to accept (e.g., ADR-0032)" },
      },
      required: ["id"],
    },
  },
  {
    name: "adr_supersede",
    description: "Mark an ADR as superseded by another, with bidirectional linking",
    defer_loading: false,
    inputSchema: {
      type: "object",
      properties: {
        old_id: { type: "string", description: "ADR ID being superseded" },
        new_id: { type: "string", description: "ADR ID that supersedes it" },
      },
      required: ["old_id", "new_id"],
    },
  },
  {
    name: "adr_pre_sign",
    description: "Pre-sign an ADR before acceptance (required for critical classification)",
    defer_loading: false,
    inputSchema: {
      type: "object",
      properties: {
        adr_id: { type: "string", description: "ADR ID to pre-sign" },
        signer: { type: "string", description: "Signer name (defaults to git user.name)" },
      },
      required: ["adr_id"],
    },
  },

  // ─── Chain Operations (2) ───
  {
    name: "chain_sign",
    description: "Sign an existing block in the chain (post-acceptance cryptographic signature)",
    defer_loading: false,
    inputSchema: {
      type: "object",
      properties: {
        adr_id: { type: "string", description: "ADR ID of the block to sign" },
        signer: { type: "string", description: "Signer name (defaults to git user.name)" },
      },
      required: ["adr_id"],
    },
  },
  {
    name: "snapshot_create",
    description: "Create a cryptographic snapshot of the current chain state",
    defer_loading: false,
    inputSchema: { type: "object", properties: {} },
  },

  // ─── Supply Chain (1) ───
  {
    name: "sbom_generate",
    description: "Regenerate SBOM from current flake.nix dependencies",
    defer_loading: false,
    inputSchema: { type: "object", properties: {} },
  },
];

// ═══════════════════════════════════════════════════════════════
// Handlers
// ═══════════════════════════════════════════════════════════════

function ok(data: Record<string, unknown>) {
  return { content: [{ type: "text", text: stringifyGeneric(data) }] };
}

function fail(error: string) {
  return {
    content: [{ type: "text", text: stringifyGeneric({ success: false, error }) }],
    isError: true,
  };
}

// ─── ADR CRUD ───

async function handleAdrNew(args: ADRCreateArgs) {
  try {
    const { title, project = "GLOBAL", classification = "major" } = args;

    // ═══ ADR-0065: Runtime Assurance Gate ═══
    const gateResult = await gate.probe();
    logger.info({ gateResult }, "ADR Gate probe result");

    if (!gateResult.canWrite) {
      return ok({
        success: false,
        blocked: true,
        gate: {
          level: gateResult.level,
          reason: gateResult.reason,
          adrCount: gateResult.adrCount,
        },
        message: `[GATE] Runtime level: ${gateResult.level}. ${gateResult.reason}`,
        hint:
          gateResult.level === "degraded-readonly"
            ? "You can still list and inspect ADRs. Run 'nix develop' for full assured mode."
            : "Fix the issues above to enable ADR creation.",
      });
    }

    // ═══ Use filesystem scanner for next ID (independent of CLI) ═══
    const id = gateResult.nextId;

    // ═══ Check ID collision ═══
    const exists = await scanner.exists(id);
    if (exists) {
      return ok({
        success: false,
        blocked: true,
        collision: true,
        gate: { level: gateResult.level },
        message: `[GATE] ID collision: ${id} already exists on filesystem. Next available: ${await scanner.getNextId()}`,
      });
    }

    const date = new Date().toISOString().split("T")[0];
    const timestamp = new Date().toISOString();

    const content = `---
id: "${id}"
title: "${title}"
status: proposed
date: "${date}"

authors:
  - name: "AI Agent"
    role: "Development Assistant"
    github: "securellm-mcp"

reviewers: []

governance:
  classification: "${classification}"
  requires_approval_from:
    - architect
  compliance_tags: []
  review_deadline: "${new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]}"
  auto_supersede_after: "1y"

scope:
  projects:
    - ${project}
  layers:
    - infrastructure
  environments:
    - all

rationale:
  drivers: []
  alternatives_considered: []
  trade_offs: []

consequences:
  positive: []
  negative: []
  risks: []

implementation:
  effort: "medium"
  timeline: ""
  dependencies: []
  blocked_by: []
  tasks: []

relations:
  supersedes: []
  superseded_by: null
  related_to: []
  implements: []
  enables: []

knowledge_extraction:
  keywords: []
  concepts: []
  questions_answered: []
  embedding_priority: "normal"

audit:
  created_at: "${timestamp}"
  last_modified: "${timestamp}"
  version: 1
  changelog:
    - date: "${timestamp}"
      author: "securellm-mcp"
      change: "ADR created"
      commit_hash: null
---

## Context

[Describe the context and problem that led to this decision]

## Decision

[Describe the decision being made]

## Rationale

### Drivers

- [Driver 1]

### Alternatives Considered

#### Option A: [Name]
- **Pros:**${" "}
- **Cons:**${" "}
- **Why rejected:**${" "}

### Trade-offs

- [Trade-off accepted]

## Consequences

### Positive

- [Positive consequence]

### Negative

- [Negative consequence]

### Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| [Risk] | medium | medium | [Mitigation] |

## Implementation

### Tasks

- [ ] Task 1

### Timeline

[Estimated timeline]

## References

- [Relevant documentation]
`;

    // ═══ ADR-0065: Exclusive write with wx flag ═══
    const fs = await import("fs/promises");
    const path = await import("path");
    const filePath = path.join(ADR_REPO_PATH, "adr", "proposed", `${id}.md`);

    try {
      await fs.writeFile(filePath, content, { encoding: "utf-8", flag: "wx" });
    } catch (writeError: any) {
      if (writeError.code === "EEXIST") {
        return ok({
          success: false,
          collision: true,
          message: `[GATE] Exclusive write failed: ${id}.md already exists. Use a different ID.`,
        });
      }
      throw writeError;
    }

    // ═══ ADR-0065: Post-write validation ═══
    const validationError = await gate.validatePostWrite(id, gateResult.level);
    const needsFix = validationError !== null;

    return ok({
      success: true,
      id,
      status: needsFix ? "needs_fix" : "proposed",
      gate_level: gateResult.level,
      message: needsFix
        ? `ADR created but validation failed: ${validationError}. Marked as needs_fix.`
        : `ADR created: ${id}`,
      file_path: filePath,
      next_steps: needsFix
        ? [`Fix validation errors: ${validationError}`, `Re-run validation after fixing`]
        : [`Edit the file to fill in details`, `Run adr_accept ${id} when ready`],
    });
  } catch (error: any) {
    logger.error({ err: error }, "Failed to create ADR");
    return fail(error.message);
  }
}

async function handleAdrNewFromResearch(args: ADRCreateArgs) {
  try {
    const { title, research_data, project = "GLOBAL" } = args;
    if (!research_data) throw new Error("research_data is required");

    // ═══ ADR-0065: Runtime Assurance Gate ═══
    const gateResult = await gate.probe();
    if (!gateResult.canWrite) {
      return ok({
        success: false,
        blocked: true,
        gate: { level: gateResult.level, reason: gateResult.reason },
        message: `[GATE] Runtime level: ${gateResult.level}. Cannot create ADR.`,
      });
    }

    const research = research_data;
    const credibilityScore = ResearchParser.calculateCredibilityScore(research);
    const content = ResearchParser.generateADR(research, title, project);
    const id = gateResult.nextId;
    const updatedContent = content.replace(/"ADR-\d+"/, `"${id}"`);

    // ═══ Exclusive write with wx flag ═══
    const fs = await import("fs/promises");
    const path = await import("path");
    const filePath = path.join(ADR_REPO_PATH, "adr", "proposed", `${id}.md`);

    try {
      await fs.writeFile(filePath, updatedContent, { encoding: "utf-8", flag: "wx" });
    } catch (writeError: any) {
      if (writeError.code === "EEXIST") {
        return ok({
          success: false,
          collision: true,
          message: `[GATE] Exclusive write failed: ${id}.md already exists.`,
        });
      }
      throw writeError;
    }

    return ok({
      success: true,
      id,
      status: "proposed",
      gate_level: gateResult.level,
      credibility_score: credibilityScore,
      sources_count: research.sources.length,
      message: `ADR generated from research: ${id}`,
      file_path: filePath,
      validation: {
        method: "research_agent",
        confidence: research.confidence,
        credibility: credibilityScore,
      },
    });
  } catch (error: any) {
    logger.error({ err: error }, "Failed to generate ADR from research");
    return fail(error.message);
  }
}

async function handleAdrList(args: ADRListArgs) {
  try {
    const { status: statusFilter, project, format = "table" } = args;

    // ═══ ADR-0065: Try CLI first, fallback to filesystem scanner ═══
    let adrs: Array<{ id: string; title: string; status: string; date: string }>;
    let usedFallback = false;

    try {
      adrs = await backend.list(statusFilter, project);
      // Bug fix: if CLI returns empty but filesystem has ADRs, use scanner
      if (adrs.length === 0) {
        const scanned = await scanner.scanAll();
        if (scanned.length > 0) {
          logger.warn(
            { cliCount: 0, fsCount: scanned.length },
            "CLI returned 0 ADRs but filesystem has entries — using scanner fallback"
          );
          usedFallback = true;
          adrs = scanned
            .filter(
              (a: ScannedADR) =>
                (!statusFilter || a.status === statusFilter) &&
                (!project || a.project?.toLowerCase() === project.toLowerCase())
            )
            .map((a: ScannedADR) => ({ id: a.id, title: a.title, status: a.status, date: a.date }));
        }
      }
    } catch {
      // CLI failed entirely — use scanner
      logger.warn("CLI list failed, using filesystem scanner fallback");
      usedFallback = true;
      const scanned = await scanner.scanAll();
      adrs = scanned
        .filter(
          (a: ScannedADR) =>
            (!statusFilter || a.status === statusFilter) &&
            (!project || a.project?.toLowerCase() === project.toLowerCase())
        )
        .map((a: ScannedADR) => ({ id: a.id, title: a.title, status: a.status, date: a.date }));
    }

    // Get gate level for visibility
    let gateInfo = "";
    try {
      const gateResult = await gate.probe();
      gateInfo = `\n[Gate: ${gateResult.level}]${usedFallback ? " (scanner fallback)" : ""}`;
    } catch {
      // non-blocking
    }

    if (format === "json") {
      return ok({ success: true, count: adrs.length, adrs });
    }

    // Table format
    let table = `\u2554${"═".repeat(12)}\u2566${"═".repeat(10)}\u2566${"═".repeat(47)}\u2566${"═".repeat(12)}\u2557\n`;
    table += `\u2551 ${"ID".padEnd(10)} \u2551 ${"Status".padEnd(8)} \u2551 ${"Title".padEnd(45)} \u2551 ${"Date".padEnd(10)} \u2551\n`;
    table += `\u2560${"═".repeat(12)}\u256C${"═".repeat(10)}\u256C${"═".repeat(47)}\u256C${"═".repeat(12)}\u2563\n`;

    for (const adr of adrs) {
      const title = (adr.title || "").substring(0, 45).padEnd(45);
      const id = (adr.id || "").padEnd(10);
      const st = (adr.status || "").padEnd(8);
      const date = (adr.date || "").substring(0, 10).padEnd(10);
      table += `\u2551 ${id} \u2551 ${st} \u2551 ${title} \u2551 ${date} \u2551\n`;
    }
    table += `\u255A${"═".repeat(12)}\u2569${"═".repeat(10)}\u2569${"═".repeat(47)}\u2569${"═".repeat(12)}\u255D`;

    let suggestionsText = "";
    if (!statusFilter || statusFilter === "proposed") {
      try {
        const suggestions = await backend.suggestLifecycleChanges();
        if (suggestions.length > 0) {
          suggestionsText =
            "\n\nLifecycle Suggestions:\n" +
            suggestions.map((s) => `  - ${s.adrId}: ${s.action} — ${s.reason}`).join("\n");
        }
      } catch {
        /* non-blocking */
      }
    }

    return {
      content: [
        {
          type: "text",
          text: `Total ADRs: ${adrs.length}${gateInfo}\n\n${table}${suggestionsText}`,
        },
      ],
    };
  } catch (error: any) {
    logger.error({ err: error }, "Failed to list ADRs");
    return fail(error.message);
  }
}

async function handleAdrShow(args: ADRShowArgs) {
  try {
    const content = await backend.get(args.id);
    if (!content) throw new Error(`ADR not found: ${args.id}`);
    return { content: [{ type: "text", text: content }] };
  } catch (error: any) {
    return fail(error.message);
  }
}

async function handleAdrSearch(args: ADRSearchArgs) {
  try {
    const results = await backend.search(args.query, args.status_filter);
    return ok({ success: true, query: args.query, count: results.length, results });
  } catch (error: any) {
    return fail(error.message);
  }
}

async function handleAdrRelations(args: { adr_id: string }) {
  try {
    const relations = await backend.relations(args.adr_id);
    return ok({ success: true, adr_id: args.adr_id, relations });
  } catch (error: any) {
    return fail(error.message);
  }
}

async function handleAdrValidate(args: { adr_id?: string }) {
  try {
    const result = await backend.validate(args.adr_id);
    return ok({ success: result.success, output: result.stdout, errors: result.stderr || null });
  } catch (error: any) {
    return fail(error.message);
  }
}

// ─── ADR-0065: Runtime Assurance Gate ───

async function handleAdrGateStatus() {
  try {
    const gateResult = await gate.probe();
    const duplicates =
      gateResult.level === "blocked" ? scanner.detectDuplicates(await scanner.scanAll()) : [];
    return ok({
      success: true,
      gate: {
        level: gateResult.level,
        canWrite: gateResult.canWrite,
        reason: gateResult.reason,
      },
      diagnostics: {
        adrCount: gateResult.adrCount,
        nextId: gateResult.nextId,
        maxId: gateResult.maxId,
        structureOk: gateResult.structureOk,
        schemaAvailable: gateResult.schemaAvailable,
        cliAvailable: gateResult.cliAvailable,
        pythonAvailable: gateResult.pythonAvailable,
      },
      duplicates: duplicates.length > 0 ? duplicates : undefined,
      hint:
        gateResult.level === "degraded-readonly"
          ? "Run 'nix develop' to upgrade to assured mode."
          : gateResult.level === "blocked"
            ? "Fix structure issues to enable ADR operations."
            : undefined,
    });
  } catch (error: any) {
    return fail(error.message);
  }
}

async function handleGovernanceRules() {
  try {
    const rules = await backend.governanceRules();
    if (!rules) throw new Error("governance.yaml not found");
    return { content: [{ type: "text", text: rules }] };
  } catch (error: any) {
    return fail(error.message);
  }
}

// ─── Blockchain ───

async function handleChainStatus() {
  try {
    const { raw, parsed } = await backend.chainStatus();
    return ok({ success: true, ...(parsed || {}), raw });
  } catch (error: any) {
    return fail(error.message);
  }
}

async function handleChainVerify() {
  try {
    const result = await backend.chainVerify();
    return ok({
      success: result.success,
      total_blocks: result.blockResults.length,
      passed: result.blockResults.filter((b) => b.status === "PASS").length,
      failed: result.blockResults.filter((b) => b.status === "FAIL").length,
      blocks: result.blockResults,
      raw: result.raw,
    });
  } catch (error: any) {
    return fail(error.message);
  }
}

async function handleChainProve(args: { adr_id: string }) {
  try {
    const { proof, raw } = await backend.chainProve(args.adr_id);
    if (proof) {
      return ok({ success: true, adr_id: args.adr_id, ...proof });
    }
    return ok({ success: true, adr_id: args.adr_id, raw });
  } catch (error: any) {
    return fail(error.message);
  }
}

async function handleProvenanceTrace(args: { adr_id: string }) {
  try {
    const { trace, raw } = await backend.provenanceTrace(args.adr_id);
    if (trace) {
      return ok({ success: true, adr_id: args.adr_id, provenance: trace });
    }
    return ok({ success: true, adr_id: args.adr_id, raw });
  } catch (error: any) {
    return fail(error.message);
  }
}

// ─── Analytics ───

async function handleSnapshotLatest() {
  try {
    const { snapshot, raw } = await backend.snapshotLatest();
    if (snapshot) {
      return ok({ success: true, snapshot });
    }
    return ok({ success: true, raw });
  } catch (error: any) {
    return fail(error.message);
  }
}

async function handleEconomicsReport() {
  try {
    const { metrics, raw } = await backend.economicsReport();
    if (metrics) {
      return ok({ success: true, metrics });
    }
    return ok({ success: true, raw });
  } catch (error: any) {
    return fail(error.message);
  }
}

async function handleSbomStatus() {
  try {
    const { sbom, raw } = await backend.sbomStatus();
    if (sbom) {
      return ok({ success: true, sbom });
    }
    return ok({ success: true, raw });
  } catch (error: any) {
    return fail(error.message);
  }
}

// ─── Write: Lifecycle ───

async function handleAdrAccept(args: ADRAcceptArgs) {
  try {
    const result = await backend.accept(args.id);

    let lifecycleSuggestions: Array<{ adrId: string; action: string; reason: string }> = [];
    try {
      lifecycleSuggestions = await backend.suggestLifecycleChanges();
    } catch {
      /* */
    }

    const data: any = {
      success: result.success,
      id: args.id,
      status: result.success ? "accepted" : "failed",
      output: result.stdout,
      errors: result.stderr || null,
    };
    if (lifecycleSuggestions.length > 0) data.lifecycle_suggestions = lifecycleSuggestions;

    return ok(data);
  } catch (error: any) {
    return fail(error.message);
  }
}

async function handleAdrSupersede(args: { old_id: string; new_id: string }) {
  try {
    const result = await backend.supersede(args.old_id, args.new_id);
    return ok({
      success: result.success,
      old_id: args.old_id,
      new_id: args.new_id,
      output: result.stdout,
      errors: result.stderr || null,
    });
  } catch (error: any) {
    return fail(error.message);
  }
}

async function handleAdrPreSign(args: { adr_id: string; signer?: string }) {
  try {
    const signer = args.signer;
    const result = await backend.preSign(args.adr_id, signer);
    return ok({
      success: result.success,
      adr_id: args.adr_id,
      signer,
      output: result.stdout,
      errors: result.stderr || null,
    });
  } catch (error: any) {
    return fail(error.message);
  }
}

// ─── Write: Chain Ops ───

async function handleChainSign(args: { adr_id: string; signer?: string }) {
  try {
    const signer = args.signer;
    const result = await backend.chainSign(args.adr_id, signer);
    return ok({
      success: result.success,
      adr_id: args.adr_id,
      signer,
      output: result.stdout,
      errors: result.stderr || null,
    });
  } catch (error: any) {
    return fail(error.message);
  }
}

async function handleSnapshotCreate() {
  try {
    const result = await backend.snapshotCreate();
    return ok({
      success: result.success,
      output: result.stdout,
      errors: result.stderr || null,
    });
  } catch (error: any) {
    return fail(error.message);
  }
}

async function handleSbomGenerate() {
  try {
    const result = await backend.sbomGenerate();
    return ok({
      success: result.success,
      output: result.stdout,
      errors: result.stderr || null,
    });
  } catch (error: any) {
    return fail(error.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// Handler map
// ═══════════════════════════════════════════════════════════════

export const adrHandlers: Record<string, (args: any) => Promise<any>> = {
  // Read
  adr_new: handleAdrNew,
  adr_new_from_research: handleAdrNewFromResearch,
  adr_list: handleAdrList,
  adr_show: handleAdrShow,
  adr_search: handleAdrSearch,
  adr_relations: handleAdrRelations,
  adr_validate: handleAdrValidate,
  adr_gate: handleAdrGateStatus,
  governance_rules: handleGovernanceRules,
  chain_status: handleChainStatus,
  chain_verify: handleChainVerify,
  chain_prove: handleChainProve,
  provenance_trace: handleProvenanceTrace,
  snapshot_latest: handleSnapshotLatest,
  economics_report: handleEconomicsReport,
  sbom_status: handleSbomStatus,
  // Write
  adr_accept: handleAdrAccept,
  adr_supersede: handleAdrSupersede,
  adr_pre_sign: handleAdrPreSign,
  chain_sign: handleChainSign,
  snapshot_create: handleSnapshotCreate,
  sbom_generate: handleSbomGenerate,
};
