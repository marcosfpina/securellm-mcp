/**
 * ADR Runtime Assurance Gate (ADR-0065)
 *
 * Enforces that no ADR write happens without first declaring the runtime level.
 * Four levels: assured, verified-local, degraded-readonly, blocked.
 *
 * Core rule: Write only happens after the gate.
 */

import { readdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { logger } from "../../utils/logger.js";

const STATUS_DIRS = ["proposed", "accepted", "rejected", "superseded", "deprecated"];

// ═══════════════════════════════════════════════════════════════
// Runtime levels
// ═══════════════════════════════════════════════════════════════

export type RuntimeLevel = "assured" | "verified-local" | "degraded-readonly" | "blocked";

export interface RuntimeGateResult {
  level: RuntimeLevel;
  canWrite: boolean;
  reason: string;
  adrCount: number;
  maxId: number;
  nextId: string;
  structureOk: boolean;
  schemaAvailable: boolean;
  cliAvailable: boolean;
  pythonAvailable: boolean;
}

// ═══════════════════════════════════════════════════════════════
// Filesystem Scanner (independent of CLI)
// ═══════════════════════════════════════════════════════════════

export interface ScannedADR {
  id: string;
  numericId: number;
  status: string;
  title: string;
  date: string;
  project?: string;
  filePath: string;
}

function parseFrontmatterValue(content: string, field: string): string {
  const match = content.match(new RegExp(`^${field}:\\s*(?:"([^"]*)"|'([^']*)'|([^\\n#]+))`, "m"));
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
}

/**
 * Scan ADR files directly from the filesystem.
 * Does NOT depend on CLI — uses regex on filenames + frontmatter.
 */
export class FilesystemScanner {
  constructor(private repoPath: string) {}

  private async scanDirectory(
    dirPath: string,
    defaultStatus: string,
    statusFromFrontmatter: boolean
  ): Promise<ScannedADR[]> {
    const results: ScannedADR[] = [];

    if (!existsSync(dirPath)) return results;

    let files: string[];
    try {
      files = await readdir(dirPath);
    } catch {
      return results; // permission denied, etc
    }

    for (const file of files) {
      // Regex: ADR-XXXX.md or ADR-XXXX-something.md
      const match = file.match(/^ADR-(\d{4})(?:-.*)?\.md$/);
      if (!match) continue;

      const numericId = parseInt(match[1], 10);
      if (isNaN(numericId)) continue;

      const filePath = join(dirPath, file);
      let title = "";
      let date = "";
      let frontmatterId = "";
      let status = defaultStatus;
      let project: string | undefined;

      try {
        const content = await readFile(filePath, "utf-8");
        title = parseFrontmatterValue(content, "title");
        date = parseFrontmatterValue(content, "date");
        frontmatterId = parseFrontmatterValue(content, "id");
        project = parseFrontmatterValue(content, "project") || undefined;
        if (statusFromFrontmatter) status = parseFrontmatterValue(content, "status") || status;
      } catch {
        // unreadable file — still include with what we know
      }

      results.push({
        id: frontmatterId || `ADR-${match[1]}`,
        numericId,
        status,
        title,
        date,
        project,
        filePath,
      });
    }

    return results;
  }

  /**
   * Scan all ADR files across all status directories.
   * Returns sorted by numeric ID.
   */
  async scanAll(): Promise<ScannedADR[]> {
    const results: ScannedADR[] = [];
    const adrDir = join(this.repoPath, "adr");
    const docsAdrDir = join(this.repoPath, "docs", "adr");

    for (const status of STATUS_DIRS) {
      results.push(...(await this.scanDirectory(join(adrDir, status), status, false)));
    }

    results.push(...(await this.scanDirectory(docsAdrDir, "proposed", true)));
    results.push(...(await this.scanDirectory(this.repoPath, "proposed", true)));

    // Sort by numeric ID ascending
    results.sort((a, b) => a.numericId - b.numericId || a.id.localeCompare(b.id));
    return results;
  }

  /**
   * Detect duplicate IDs (same ID appearing in multiple status dirs or files)
   */
  detectDuplicates(adrs: ScannedADR[]): Array<{ id: string; files: string[] }> {
    const map = new Map<string, string[]>();
    for (const adr of adrs) {
      const existing = map.get(adr.id) || [];
      existing.push(adr.filePath);
      map.set(adr.id, existing);
    }
    return [...map.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([id, files]) => ({ id, files }));
  }

  /**
   * Check if a specific ADR ID already exists on filesystem
   */
  async exists(id: string): Promise<boolean> {
    const all = await this.scanAll();
    return all.some((adr) => adr.id === id);
  }

  /**
   * Get the next available ADR ID (max numeric + 1)
   */
  async getNextId(): Promise<string> {
    const all = await this.scanAll();
    if (all.length === 0) return "ADR-0001";
    const maxId = Math.max(...all.map((a) => a.numericId));
    return `ADR-${String(maxId + 1).padStart(4, "0")}`;
  }
}

// ═══════════════════════════════════════════════════════════════
// Runtime Gate
// ═══════════════════════════════════════════════════════════════

export class ADRRuntimeGate {
  private scanner: FilesystemScanner;
  private repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
    this.scanner = new FilesystemScanner(repoPath);
  }

  /**
   * Probe the runtime and determine the current level.
   * This is called before ANY write operation.
   */
  async probe(): Promise<RuntimeGateResult> {
    const adrDir = join(this.repoPath, "adr");
    const proposedDir = join(adrDir, "proposed");
    const acceptedDir = join(adrDir, "accepted");
    const schemaPath = join(this.repoPath, ".schema", "adr.schema.json");
    const adrScript = join(this.repoPath, "scripts", "adr");

    // 1. Check structure
    const schemaAvailable = existsSync(schemaPath);
    const writableStructureOk = existsSync(proposedDir) && existsSync(acceptedDir);
    const readStructureOk =
      writableStructureOk || existsSync(adrDir) || existsSync(join(this.repoPath, "docs", "adr"));
    const structureOk = writableStructureOk && schemaAvailable;

    // 2. Check CLI
    let cliAvailable = false;
    if (existsSync(adrScript)) {
      try {
        const { execFile } = await import("child_process");
        const { promisify } = await import("util");
        const execFileAsync = promisify(execFile);
        const result = await execFileAsync("bash", [adrScript, "list", "-f", "json"], {
          cwd: this.repoPath,
          timeout: 5000,
          env: { ...process.env, ADR_ROOT: this.repoPath, NO_COLOR: "1" },
        });
        cliAvailable = result.stdout.includes("{");
      } catch {
        cliAvailable = false;
      }
    }

    // 3. Check Python deps
    let pythonAvailable = false;
    try {
      const { execFile } = await import("child_process");
      const { promisify } = await import("util");
      const execFileAsync = promisify(execFile);
      const result = await execFileAsync(
        "python3",
        ["-c", "import yaml; import jsonschema; print('ok')"],
        {
          timeout: 5000,
        }
      );
      pythonAvailable = result.stdout.includes("ok");
    } catch {
      pythonAvailable = false;
    }

    // 4. Scan filesystem (works for both adr/status and docs/adr layouts)
    let adrCount = 0;
    let maxId = 0;
    let nextId = "ADR-0001";
    let duplicates: Array<{ id: string; files: string[] }> = [];

    if (readStructureOk) {
      const adrs = await this.scanner.scanAll();
      adrCount = adrs.length;
      maxId = adrs.length > 0 ? Math.max(...adrs.map((a) => a.numericId)) : 0;
      nextId = adrs.length > 0 ? `ADR-${String(maxId + 1).padStart(4, "0")}` : "ADR-0001";
      duplicates = this.scanner.detectDuplicates(adrs);
    }

    // 6. Determine level
    let level: RuntimeLevel;
    let canWrite: boolean;
    let reason: string;

    if (!structureOk && adrCount > 0) {
      level = "degraded-readonly";
      canWrite = false;
      reason = `Read-only ADR layout detected. Missing writable ledger requirements: ${[
        !existsSync(proposedDir) && "adr/proposed/",
        !existsSync(acceptedDir) && "adr/accepted/",
        !schemaAvailable && ".schema/adr.schema.json",
      ]
        .filter(Boolean)
        .join(", ")}`;
    } else if (!structureOk) {
      level = "blocked";
      canWrite = false;
      reason = `Repository structure incomplete. Missing: ${[
        !existsSync(proposedDir) && "adr/proposed/",
        !existsSync(acceptedDir) && "adr/accepted/",
        !schemaAvailable && ".schema/adr.schema.json",
      ]
        .filter(Boolean)
        .join(", ")}`;
    } else if (duplicates.length > 0) {
      level = "blocked";
      canWrite = false;
      reason = `Duplicate ADR IDs detected: ${duplicates.map((d) => `${d.id} in [${d.files.join(", ")}]`).join("; ")}`;
    } else if (cliAvailable && pythonAvailable) {
      level = "assured";
      canWrite = true;
      reason = "Full runtime available: CLI + Python deps + schema";
    } else if (structureOk && schemaAvailable) {
      level = "verified-local";
      canWrite = true; // Can create draft, but validation must run post-write
      reason = `Running in verified-local mode. Missing: ${[
        !cliAvailable && "CLI",
        !pythonAvailable && "Python deps (PyYAML/jsonschema)",
      ]
        .filter(Boolean)
        .join(", ")}`;
    } else {
      level = "degraded-readonly";
      canWrite = false;
      reason = "Structure present but deps missing. Cannot write.";
    }

    return {
      level,
      canWrite,
      reason,
      adrCount,
      maxId,
      nextId,
      structureOk,
      schemaAvailable,
      cliAvailable,
      pythonAvailable,
    };
  }

  /**
   * Validate an ADR post-write.
   * In assured mode: runs full CLI validation.
   * In verified-local: runs minimal schema check.
   * Returns null if valid, or an error string if invalid.
   */
  async validatePostWrite(adrId: string, level: RuntimeLevel): Promise<string | null> {
    if (level === "assured") {
      try {
        const { execFile } = await import("child_process");
        const { promisify } = await import("util");
        const execFileAsync = promisify(execFile);
        const adrScript = join(this.repoPath, "scripts", "adr");
        const result = await execFileAsync("bash", [adrScript, "validate", adrId], {
          cwd: this.repoPath,
          timeout: 30000,
          env: { ...process.env, ADR_ROOT: this.repoPath, NO_COLOR: "1" },
        });
        // exit code 0 = success, execFileAsync throws on non-zero
      } catch (error: any) {
        return `CLI validation failed: ${error.stderr || error.stdout || error.message}`;
      }
    } else if (level === "verified-local") {
      // Minimal check: file exists and has frontmatter
      const all = await this.scanner.scanAll();
      const adr = all.find((a) => a.id === adrId);
      if (!adr) {
        return `ADR ${adrId} not found after write`;
      }
      if (!adr.title) {
        return `ADR ${adrId} missing title in frontmatter`;
      }
    }
    return null; // valid
  }

  getScanner(): FilesystemScanner {
    return this.scanner;
  }
}
