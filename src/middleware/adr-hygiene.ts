/**
 * ADR Hygiene Middleware (ADR-0036)
 *
 * Periodically checks the health of open ADRs during agent workflow.
 * Runs every N tool calls (configurable) and surfaces:
 *   - Stale ADRs (proposed > 30 days with no activity)
 *   - Expired review deadlines
 *   - High open count warnings
 *
 * Designed to be non-blocking — returns a report that can be
 * appended to tool results as suggestions.
 */

import { readFile, readdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { logger } from "../utils/logger.js";
import { resolveAdrLedgerPath } from "../config/workspace.js";

export interface ADRHygieneReport {
  needsAttention: boolean;
  staleCount: number;
  expiredDeadlineCount: number;
  totalOpen: number;
  details: string[];
  summary: string;
}

interface ProposedADR {
  id: string;
  title: string;
  date: string;
  reviewDeadline?: string;
  classification?: string;
}

const DEFAULT_CHECK_INTERVAL = 50; // every N tool calls
const STALE_THRESHOLD_DAYS = 30;
const HIGH_OPEN_THRESHOLD = 10;

export class ADRHygieneMiddleware {
  private callCount = 0;
  private lastReport: ADRHygieneReport | null = null;
  private lastCheckAt = 0;
  private readonly checkInterval: number;
  private readonly repoPath: string;

  constructor(options?: { checkInterval?: number; repoPath?: string }) {
    this.checkInterval =
      options?.checkInterval ??
      (parseInt(process.env.ADR_HYGIENE_INTERVAL || "", 10) || DEFAULT_CHECK_INTERVAL);
    // ADR-0062 (B4): path do ledger resolvido, não hardcoded.
    this.repoPath = options?.repoPath ?? resolveAdrLedgerPath();
  }

  /**
   * Called on every tool invocation. Returns a report when check interval is reached.
   */
  async onToolCall(): Promise<ADRHygieneReport | null> {
    this.callCount++;

    if (this.callCount % this.checkInterval !== 0) {
      return null;
    }

    try {
      const report = await this.check();
      this.lastReport = report;
      this.lastCheckAt = Date.now();

      if (report.needsAttention) {
        logger.info("ADR Hygiene: %s", report.summary);
      }

      return report.needsAttention ? report : null;
    } catch (error) {
      logger.debug({ error }, "ADR hygiene check failed (non-blocking)");
      return null;
    }
  }

  /**
   * Run the full hygiene check
   */
  async check(): Promise<ADRHygieneReport> {
    const proposed = await this.loadProposed();
    const now = new Date();
    const details: string[] = [];

    // Stale ADRs (>30 days old)
    const stale = proposed.filter((adr) => {
      const created = new Date(adr.date);
      const daysSince = (now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24);
      return daysSince > STALE_THRESHOLD_DAYS;
    });

    if (stale.length > 0) {
      details.push(
        `${stale.length} stale ADR(s) (>${STALE_THRESHOLD_DAYS} days): ${stale.map((a) => a.id).join(", ")}`
      );
    }

    // Expired deadlines
    const expired = proposed.filter(
      (adr) => adr.reviewDeadline && new Date(adr.reviewDeadline) < now
    );

    if (expired.length > 0) {
      details.push(
        `${expired.length} expired deadline(s): ${expired.map((a) => `${a.id} (due ${a.reviewDeadline})`).join(", ")}`
      );
    }

    // High open count
    if (proposed.length > HIGH_OPEN_THRESHOLD) {
      details.push(
        `${proposed.length} open ADRs exceeds threshold of ${HIGH_OPEN_THRESHOLD} — consider triaging`
      );
    }

    // Critical ADRs that are stale
    const staleCritical = stale.filter((a) => a.classification === "critical");
    if (staleCritical.length > 0) {
      details.push(
        `${staleCritical.length} CRITICAL stale ADR(s): ${staleCritical.map((a) => a.id).join(", ")}`
      );
    }

    const needsAttention = details.length > 0;
    const summary = needsAttention
      ? `ADR Hygiene: ${stale.length} stale, ${expired.length} expired, ${proposed.length} total open`
      : `ADR Hygiene: OK (${proposed.length} open)`;

    return {
      needsAttention,
      staleCount: stale.length,
      expiredDeadlineCount: expired.length,
      totalOpen: proposed.length,
      details,
      summary,
    };
  }

  /**
   * Load proposed ADRs from filesystem
   */
  private async loadProposed(): Promise<ProposedADR[]> {
    const proposedDir = join(this.repoPath, "adr", "proposed");
    if (!existsSync(proposedDir)) return [];

    const files = await readdir(proposedDir);
    const adrFiles = files.filter((f) => f.startsWith("ADR-") && f.endsWith(".md"));
    const results: ProposedADR[] = [];

    for (const file of adrFiles) {
      try {
        const content = await readFile(join(proposedDir, file), "utf-8");
        const id = content.match(/^id:\s*"([^"]+)"/m)?.[1];
        const title = content.match(/^title:\s*"([^"]+)"/m)?.[1];
        const date = content.match(/^date:\s*"([^"]+)"/m)?.[1];
        const deadline = content.match(/review_deadline:\s*"([^"]+)"/m)?.[1];
        const classification = content.match(/classification:\s*"([^"]+)"/m)?.[1];

        if (id && title && date) {
          results.push({ id, title, date, reviewDeadline: deadline, classification });
        }
      } catch {
        // Skip unreadable
      }
    }

    return results;
  }

  /**
   * Get the last report without running a new check
   */
  getLastReport(): ADRHygieneReport | null {
    return this.lastReport;
  }

  /**
   * Force a check on next tool call
   */
  forceNextCheck(): void {
    this.callCount = this.checkInterval - 1;
  }
}
