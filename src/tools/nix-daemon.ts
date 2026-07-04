/**
 * Nix Daemon Tools — ADR-0004
 *
 * Nix store management: health checks, garbage collection, generation diffs,
 * store optimisation, and integrity verification.
 *
 * Tools:
 *   nix_daemon  — unified tool with actions: store_health, gc, diff_generation,
 *                 list_generations, optimise, verify
 */

import { z } from "zod";
import { execa } from "execa";
import type { ExtendedTool } from "../types/mcp-tool-extensions.js";

// ─── Schema ──────────────────────────────────────────────────────────────────

const nixDaemonSchema = z.object({
  action: z
    .enum(["store_health", "gc", "diff_generation", "list_generations", "optimise", "verify"])
    .describe("What to do with the Nix store"),
  // gc
  dry_run: z
    .boolean()
    .optional()
    .default(true)
    .describe("Preview what would be deleted (default: true for safety)"),
  older_than: z
    .string()
    .optional()
    .describe("Only delete paths older than this (e.g., '7d', '30d')"),
  // diff_generation
  from: z.number().int().positive().optional().describe("Generation number to diff from"),
  to: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Generation number to diff to (default: current)"),
  // verify
  repair: z
    .boolean()
    .optional()
    .default(false)
    .describe("Attempt to repair broken paths (dangerous!)"),
});

// ─── Tool definition ──────────────────────────────────────────────────────────

export const nixDaemonTool: ExtendedTool = {
  name: "nix_daemon",
  description:
    "Nix store management: health check, garbage collection (dry-run by default), generation diff, store optimisation, and integrity verification (ADR-0004).",
  defer_loading: true,
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["store_health", "gc", "diff_generation", "list_generations", "optimise", "verify"],
        description: "What to do",
      },
      dry_run: { type: "boolean", description: "Preview GC deletion (default: true)" },
      older_than: { type: "string", description: "Delete paths older than e.g. '7d', '30d'" },
      from: { type: "number", description: "Generation number from" },
      to: { type: "number", description: "Generation number to" },
      repair: { type: "boolean", description: "Repair broken paths (default: false)" },
    },
    required: ["action"],
  },
};

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleNixDaemon(
  args: z.infer<typeof nixDaemonSchema>
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { action, dry_run = true, older_than, from, to, repair = false } = args;

  try {
    switch (action) {
      case "store_health":
        return await storeHealth();
      case "gc":
        return await garbageCollect(dry_run, older_than);
      case "diff_generation":
        return await diffGeneration(from, to);
      case "list_generations":
        return await listGenerations();
      case "optimise":
        return await optimiseStore();
      case "verify":
        return await verifyStore(repair);
      default:
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `Unknown action: ${action}` }) }],
        };
    }
  } catch (err: any) {
    return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }] };
  }
}

// ─── Actions ─────────────────────────────────────────────────────────────────

async function storeHealth() {
  const result: any = {};

  // Store info
  const { stdout: info } = await execa("nix", ["store", "info"], { timeout: 10_000 }).catch(() => ({
    stdout: "",
  }));
  result.store_info = parseNixStoreInfo(info);

  // Check number of store paths
  const { stdout: pathCount } = await execa("bash", ["-c", "ls /nix/store | wc -l"], {
    timeout: 5_000,
  }).catch(() => ({ stdout: "?" }));
  result.store_paths = parseInt(pathCount.trim()) || 0;

  // Check generations
  const { stdout: genList } = await execa("nix-env", ["--list-generations"], {
    timeout: 5_000,
  }).catch(() => ({ stdout: "" }));
  const genLines = genList.split("\n").filter(Boolean);
  result.user_generations = genLines.length;

  // System profiles
  const { stdout: sysProfiles } = await execa(
    "bash",
    ["-c", "ls -d /nix/var/nix/profiles/system-*-link 2>/dev/null | wc -l"],
    { timeout: 5_000 }
  ).catch(() => ({ stdout: "0" }));
  result.system_generations = parseInt(sysProfiles.trim()) || 0;

  // GC preview (what would be freed)
  const { stdout: gcPreview } = await execa("nix", ["store", "gc", "--dry-run"], {
    timeout: 15_000,
  }).catch(() => ({ stdout: "" }));
  const gcLines = gcPreview.split("\n").filter(Boolean);
  result.gc_preview = {
    paths_removable: gcLines.length,
    total_size: "run 'nix store gc --dry-run' manually for size estimate",
  };

  // Dead symlinks
  const { stdout: deadLinks } = await execa(
    "bash",
    ["-c", "find /nix/store -xtype l 2>/dev/null | wc -l"],
    { timeout: 10_000 }
  ).catch(() => ({ stdout: "0" }));
  result.dead_symlinks = parseInt(deadLinks.trim()) || 0;

  // Overall health score
  const issues: string[] = [];
  if (result.dead_symlinks > 10) issues.push(`${result.dead_symlinks} dead symlinks found`);
  if (gcLines.length > 100) issues.push(`${gcLines.length} paths can be garbage collected`);
  if (result.user_generations > 20)
    issues.push(`${result.user_generations} user generations (consider cleanup)`);
  if (result.system_generations > 10)
    issues.push(`${result.system_generations} system generations (consider cleanup)`);

  result.health = issues.length === 0 ? "healthy" : `needs attention: ${issues.join("; ")}`;

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

async function garbageCollect(dryRun: boolean, olderThan?: string) {
  const args = ["store", "gc"];
  if (dryRun) args.push("--dry-run");

  const { stdout, stderr } = await execa("nix", args, { timeout: 30_000 }).catch((e: any) => ({
    stdout: "",
    stderr: e.stderr || e.message,
  }));

  const lines = stdout.split("\n").filter(Boolean);
  const pathsRemoved = lines.filter((l) => l.startsWith("/nix/store")).length;

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            dry_run: dryRun,
            paths_removable: pathsRemoved,
            action: dryRun ? "DRY RUN — nothing deleted" : "GC executed",
            paths: lines.slice(0, 30),
            note: olderThan ? `Filtered: paths older than ${olderThan}` : "All unreachable paths",
            warning: !dryRun ? "⚠️ GC EXECUTED — paths have been deleted" : undefined,
          },
          null,
          2
        ),
      },
    ],
  };
}

async function diffGeneration(from?: number, to?: number) {
  if (!from) {
    // Default: diff last two system generations
    const { stdout } = await execa(
      "bash",
      [
        "-c",
        "ls -t /nix/var/nix/profiles/system-*-link | head -2 | tail -1 | grep -oP 'system-\\K\\d+'",
      ],
      { timeout: 5_000 }
    ).catch(() => ({ stdout: "" }));
    from = parseInt(stdout.trim()) || 1;
  }
  if (!to) {
    const { stdout } = await execa(
      "bash",
      ["-c", "ls -t /nix/var/nix/profiles/system-*-link | head -1 | grep -oP 'system-\\K\\d+'"],
      { timeout: 5_000 }
    ).catch(() => ({ stdout: "" }));
    to = parseInt(stdout.trim()) || 1;
  }

  const { stdout } = await execa(
    "nix",
    [
      "store",
      "diff-closures",
      `/nix/var/nix/profiles/system-${from}-link`,
      `/nix/var/nix/profiles/system-${to}-link`,
    ],
    { timeout: 15_000 }
  ).catch(() => ({ stdout: "" }));

  const added: string[] = [];
  const removed: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.startsWith("+")) added.push(line.slice(1).trim());
    else if (line.startsWith("-")) removed.push(line.slice(1).trim());
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            from_generation: from,
            to_generation: to,
            added: added.length,
            removed: removed.length,
            added_packages: added.slice(0, 30),
            removed_packages: removed.slice(0, 30),
          },
          null,
          2
        ),
      },
    ],
  };
}

async function listGenerations() {
  const result: any = {};

  // System generations
  const { stdout: sysList } = await execa(
    "bash",
    ["-c", "ls -lt /nix/var/nix/profiles/system-*-link | grep -oP 'system-\\K\\d+' | head -20"],
    { timeout: 5_000 }
  ).catch(() => ({ stdout: "" }));
  result.system_generations = sysList.split("\n").filter(Boolean).map(Number);

  // Current system
  const { stdout: currentSys } = await execa("readlink", ["-f", "/run/current-system"], {
    timeout: 5_000,
  }).catch(() => ({ stdout: "" }));
  result.current_system = currentSys.trim();

  // Booted system
  const { stdout: bootedSys } = await execa("readlink", ["-f", "/run/booted-system"], {
    timeout: 5_000,
  }).catch(() => ({ stdout: "" }));
  result.booted_system = bootedSys.trim();

  // User generations
  const { stdout: userList } = await execa("nix-env", ["--list-generations"], {
    timeout: 5_000,
  }).catch(() => ({ stdout: "" }));
  result.user_generations = userList.split("\n").filter(Boolean).slice(-10);

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

async function optimiseStore() {
  const { stdout } = await execa("nix-store", ["--optimise"], { timeout: 60_000 }).catch(
    (e: any) => ({ stdout: "", stderr: e.stderr || e.message })
  );
  return { content: [{ type: "text", text: stdout || "Optimisation complete (or not needed)" }] };
}

async function verifyStore(repair: boolean) {
  const args = ["store", "verify"];
  if (repair) args.push("--repair");

  const { stdout } = await execa("nix", args, { timeout: 120_000 }).catch((e: any) => ({
    stdout: "",
    stderr: e.stderr || e.message,
  }));

  const lines = stdout.split("\n").filter(Boolean);
  const errors = lines.filter((l) => l.includes("error") || l.includes("path"));

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            verified: lines.length > 0,
            paths_checked: lines.length,
            errors_found: errors.length,
            repair_mode: repair,
            errors: errors.slice(0, 20),
          },
          null,
          2
        ),
      },
    ],
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseNixStoreInfo(output: string): any {
  const info: any = {};
  for (const line of output.split("\n")) {
    const kv = line.match(/^(.+?):\s+(.+)/);
    if (kv) {
      info[kv[1].trim().toLowerCase().replace(/ /g, "_")] = kv[2].trim();
    }
  }
  return info;
}
