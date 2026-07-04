/**
 * Linux Debugging & Observability Tools — ADR-0060
 *
 * Automates repetitive debugging tasks with structured output.
 * All commands run via execAsync with timeouts for safety.
 *
 * Tools:
 *   journal_analyze  — journalctl with summarization
 *   process_inspect  — /proc inspection, cgroups, resource usage
 *   systemd_delta    — what changed between states
 *   network_diag     — comprehensive network diagnostics
 *   disk_analyze     — disk usage and Nix store analysis
 *   security_scan    — quick security health checks
 */

import { z } from "zod";
import { execa } from "execa";
import type { ExtendedTool } from "../types/mcp-tool-extensions.js";

// ─── Schemas ──────────────────────────────────────────────────────────────────

const journalAnalyzeSchema = z.object({
  unit: z.string().optional().describe("Filter by systemd unit (nix-daemon, sshd, etc.)"),
  since: z.string().optional().default("5 min ago"),
  until: z.string().optional(),
  pattern: z.string().optional().describe("Regex filter: 'error|fail|timeout|killed'"),
  priority: z
    .enum(["emerg", "alert", "crit", "err", "warning", "notice", "info", "debug"])
    .optional(),
  lines: z.number().int().min(1).max(500).optional().default(100),
  format: z.enum(["raw", "summary", "timeline"]).optional().default("summary"),
});

const processInspectSchema = z.object({
  pid: z.number().int().positive().optional(),
  name: z.string().optional().describe("Filter by process name (e.g., 'llama-server')"),
  action: z.enum(["tree", "resources", "cgroup", "files", "sockets", "all"]).default("all"),
});

const systemdDeltaSchema = z.object({
  action: z.enum(["failed", "changed", "list_units"]).default("list_units"),
  state: z.string().optional().describe("Filter: running, failed, inactive"),
  pattern: z.string().optional().describe("Filter by unit name pattern"),
});

const networkDiagSchema = z.object({
  action: z.enum(["summary", "dns", "connections", "interfaces", "routes"]).default("summary"),
  port: z.number().int().min(1).max(65535).optional(),
});

const diskAnalyzeSchema = z.object({
  action: z.enum(["usage", "nix_store", "largest_files", "io_stats", "all"]).default("usage"),
  path: z.string().optional().default("/"),
  top_n: z.number().int().min(1).max(50).optional().default(10),
});

const securityScanSchema = z.object({
  action: z
    .enum(["failed_logins", "open_ports", "suid_files", "recent_changes", "all"])
    .default("all"),
  since: z.string().optional().default("24 hours ago"),
});

// ─── Tool definitions ──────────────────────────────────────────────────────────

export const linuxDebuggingTools: ExtendedTool[] = [
  {
    name: "journal_analyze",
    description:
      "Intelligent journalctl: search systemd journals with pattern matching, priority filtering, and optional summarization (ADR-0060).",
    defer_loading: true,
    inputSchema: {
      type: "object",
      properties: {
        unit: { type: "string", description: "systemd unit name" },
        since: { type: "string", description: "Time range start (default: 5 min ago)" },
        until: { type: "string", description: "Time range end" },
        pattern: { type: "string", description: "Regex filter: error|fail|timeout" },
        priority: {
          type: "string",
          enum: ["emerg", "alert", "crit", "err", "warning", "notice", "info", "debug"],
        },
        lines: { type: "number", description: "Max lines (default: 100)" },
        format: {
          type: "string",
          enum: ["raw", "summary", "timeline"],
          description: "Output format",
        },
      },
      required: [],
    },
  },
  {
    name: "process_inspect",
    description:
      "Deep process inspection: process tree, resource usage, cgroups, open files, and sockets (ADR-0060).",
    defer_loading: true,
    inputSchema: {
      type: "object",
      properties: {
        pid: { type: "number", description: "Process ID" },
        name: { type: "string", description: "Filter by process name" },
        action: {
          type: "string",
          enum: ["tree", "resources", "cgroup", "files", "sockets", "all"],
          description: "What to inspect",
        },
      },
      required: [],
    },
  },
  {
    name: "systemd_delta",
    description:
      "Show what changed in systemd: failed units, state changes between boots, unit listing (ADR-0060).",
    defer_loading: true,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["failed", "changed", "list_units"],
          description: "What to show",
        },
        state: { type: "string", description: "Filter by state: running, failed, inactive" },
        pattern: { type: "string", description: "Filter by unit name" },
      },
      required: [],
    },
  },
  {
    name: "network_diag",
    description:
      "Comprehensive network diagnostics: listening ports, DNS resolution, interfaces, routes (ADR-0060).",
    defer_loading: true,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["summary", "dns", "connections", "interfaces", "routes"],
          description: "What to diagnose",
        },
        port: { type: "number", description: "Check specific port" },
      },
      required: [],
    },
  },
  {
    name: "disk_analyze",
    description:
      "Disk and filesystem analysis: usage, Nix store health, largest files, I/O stats (ADR-0060).",
    defer_loading: true,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["usage", "nix_store", "largest_files", "io_stats", "all"],
          description: "What to analyze",
        },
        path: { type: "string", description: "Target path (default: /)" },
        top_n: { type: "number", description: "How many results (default: 10)" },
      },
      required: [],
    },
  },
  {
    name: "security_scan",
    description:
      "Quick security health check: failed logins, open ports, SUID files, recent system changes (ADR-0060).",
    defer_loading: true,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["failed_logins", "open_ports", "suid_files", "recent_changes", "all"],
          description: "What to scan",
        },
        since: { type: "string", description: "Time range (default: 24 hours ago)" },
      },
      required: [],
    },
  },
];

// ─── Handlers ─────────────────────────────────────────────────────────────────

export async function handleJournalAnalyze(args: z.infer<typeof journalAnalyzeSchema>) {
  const {
    unit,
    since = "5 min ago",
    until,
    pattern,
    priority,
    lines = 100,
    format = "summary",
  } = args;

  const cmdArgs: string[] = ["--no-pager", "-n", String(lines), "--since", since];
  if (until) cmdArgs.push("--until", until);
  if (unit) cmdArgs.push("-u", unit);
  if (priority) cmdArgs.push("-p", priority);
  if (format === "raw" || format === "timeline") cmdArgs.push("-o", "short-iso");

  const { stdout } = await execa("journalctl", cmdArgs, { timeout: 10_000 }).catch(() => ({
    stdout: "",
  }));

  if (format === "raw") {
    return { content: [{ type: "text", text: stdout || "(no entries)" }] };
  }

  // Parse and summarize
  const lines_arr = stdout.split("\n").filter(Boolean);
  const errors: string[] = [];
  const warnings: string[] = [];
  const others: string[] = [];
  const patterns: Record<string, number> = {};

  for (const line of lines_arr) {
    const lower = line.toLowerCase();
    if (lower.includes("error") || lower.includes("fail") || lower.includes("critical"))
      errors.push(line);
    else if (lower.includes("warn")) warnings.push(line);
    else others.push(line);

    if (pattern) {
      try {
        const re = new RegExp(pattern, "gi");
        const matches = line.match(re);
        if (matches) {
          for (const m of matches) {
            patterns[m] = (patterns[m] || 0) + 1;
          }
        }
      } catch {
        /* invalid regex */
      }
    }
  }

  const summary = [
    `${unit ? unit + " " : ""}journal (${since}${until ? " → " + until : ""}):`,
    `  Total entries: ${lines_arr.length}`,
    `  Errors/Critical: ${errors.length}`,
    `  Warnings: ${warnings.length}`,
    `  Other: ${others.length}`,
  ];

  if (errors.length > 0 && errors.length <= 5) {
    summary.push(`\nErrors:\n${errors.map((e) => "  " + e.slice(0, 200)).join("\n")}`);
  } else if (errors.length > 5) {
    summary.push(
      `\nLast 5 errors:\n${errors
        .slice(-5)
        .map((e) => "  " + e.slice(0, 200))
        .join("\n")}`
    );
  }

  if (Object.keys(patterns).length > 0) {
    const top = Object.entries(patterns)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    summary.push(`\nTop patterns:\n${top.map(([k, v]) => `  ${k}: ${v}x`).join("\n")}`);
  }

  return { content: [{ type: "text", text: summary.join("\n") }] };
}

export async function handleProcessInspect(args: z.infer<typeof processInspectSchema>) {
  const { pid, name, action = "all" } = args;

  let targetPid = pid;
  if (!targetPid && name) {
    // Find PID by name
    const { stdout } = await execa("pgrep", ["-f", name], { timeout: 5_000 }).catch(() => ({
      stdout: "",
    }));
    const pids = stdout.split("\n").filter(Boolean);
    if (pids.length === 0) {
      return {
        content: [
          { type: "text", text: JSON.stringify({ error: `No process found matching '${name}'` }) },
        ],
      };
    }
    targetPid = parseInt(pids[0], 10);
  }

  if (!targetPid) {
    return { content: [{ type: "text", text: JSON.stringify({ error: "Provide pid or name" }) }] };
  }

  const result: any = { pid: targetPid };

  // Basic info
  const { stdout: psOut } = await execa(
    "ps",
    ["-p", String(targetPid), "-o", "pid,ppid,user,%cpu,%mem,vsz,rss,comm", "--no-headers"],
    { timeout: 5_000 }
  ).catch(() => ({ stdout: "" }));
  if (psOut) {
    const parts = psOut.trim().split(/\s+/);
    result.process = {
      pid: parts[0],
      ppid: parts[1],
      user: parts[2],
      cpu_pct: parts[3],
      mem_pct: parts[4],
      vsz_kb: parts[5],
      rss_kb: parts[6],
      command: parts.slice(7).join(" "),
    };
  }

  if (action === "tree" || action === "all") {
    const { stdout } = await execa(
      "ps",
      ["-o", "pid,ppid,comm", "--forest", "-g", String(targetPid)],
      { timeout: 5_000 }
    ).catch(() => ({ stdout: "" }));
    result.tree = stdout.split("\n").filter(Boolean);
  }

  if (action === "cgroup" || action === "all") {
    try {
      const cgroup = await import("fs").then((fs) =>
        fs.readFileSync(`/proc/${targetPid}/cgroup`, "utf-8")
      );
      result.cgroups = cgroup.split("\n").filter(Boolean);
    } catch {
      result.cgroups = ["(access denied)"];
    }
  }

  if (action === "files" || action === "all") {
    const { stdout } = await execa("lsof", ["-p", String(targetPid), "-nP"], {
      timeout: 5_000,
    }).catch(() => ({ stdout: "" }));
    result.open_files = stdout.split("\n").filter(Boolean).slice(0, 20);
  }

  if (action === "sockets" || action === "all") {
    const { stdout } = await execa("ss", ["-tlnp"], { timeout: 5_000 }).catch(() => ({
      stdout: "",
    }));
    const lines = stdout.split("\n").filter((l) => l.includes(String(targetPid)));
    result.sockets = lines;
  }

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

export async function handleSystemdDelta(args: z.infer<typeof systemdDeltaSchema>) {
  const { action = "list_units", state, pattern } = args;

  if (action === "failed") {
    const { stdout } = await execa("systemctl", ["--failed", "--no-pager"], {
      timeout: 10_000,
    }).catch(() => ({ stdout: "" }));
    return { content: [{ type: "text", text: stdout || "(no failed units)" }] };
  }

  if (action === "changed") {
    // Show recently changed unit states
    const { stdout } = await execa("systemctl", ["list-units", "--no-pager", "--no-legend"], {
      timeout: 10_000,
    }).catch(() => ({ stdout: "" }));
    const lines = stdout.split("\n").filter(Boolean);
    const filtered = lines.filter((l) => {
      if (state && !l.includes(state)) return false;
      if (pattern && !l.toLowerCase().includes(pattern.toLowerCase())) return false;
      return true;
    });
    return { content: [{ type: "text", text: filtered.join("\n") || "(no matches)" }] };
  }

  // list_units
  const args_list = ["list-units", "--no-pager", "--no-legend"];
  if (state) args_list.push("--state", state);
  const { stdout } = await execa("systemctl", args_list, { timeout: 10_000 }).catch(() => ({
    stdout: "",
  }));
  const all = stdout.split("\n").filter(Boolean);
  const filtered = pattern
    ? all.filter((l) => l.toLowerCase().includes(pattern.toLowerCase()))
    : all;

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            total: all.length,
            filtered: filtered.length,
            units: filtered.slice(0, 30).map((l) => {
              const p = l.trim().split(/\s+/);
              return {
                unit: p[0],
                load: p[1],
                active: p[2],
                sub: p[3],
                description: p.slice(4).join(" "),
              };
            }),
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function handleNetworkDiag(args: z.infer<typeof networkDiagSchema>) {
  const { action = "summary", port } = args;
  const result: any = {};

  if (action === "summary" || action === "interfaces") {
    const { stdout } = await execa("ip", ["-br", "addr"], { timeout: 5_000 }).catch(() => ({
      stdout: "",
    }));
    result.interfaces = stdout.split("\n").filter(Boolean);
  }

  if (action === "summary" || action === "connections") {
    const ssArgs = port ? ["-tlnp", "sport", "=", String(port)] : ["-tlnp"];
    const { stdout } = await execa("ss", ssArgs, { timeout: 5_000 }).catch(() => ({ stdout: "" }));
    result.listeners = stdout.split("\n").filter(Boolean).slice(0, 20);
  }

  if (action === "summary" || action === "dns") {
    const { stdout } = await execa("resolvectl", ["status"], { timeout: 5_000 }).catch(() => ({
      stdout: "",
    }));
    result.dns = stdout
      .split("\n")
      .filter((l) => l.includes("DNS") || l.includes("Server") || l.includes("Link"))
      .slice(0, 15);
  }

  if (action === "summary" || action === "routes") {
    const { stdout } = await execa("ip", ["route"], { timeout: 5_000 }).catch(() => ({
      stdout: "",
    }));
    result.routes = stdout.split("\n").filter(Boolean);
  }

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

export async function handleDiskAnalyze(args: z.infer<typeof diskAnalyzeSchema>) {
  const { action = "usage", path = "/", top_n = 10 } = args;
  const result: any = {};

  if (action === "usage" || action === "all") {
    const { stdout } = await execa(
      "df",
      ["-h", "--type=ext4", "--type=btrfs", "--type=tmpfs", "--type=overlay"],
      { timeout: 5_000 }
    ).catch(() => execa("df", ["-h"]));
    result.filesystems = stdout.split("\n").filter(Boolean);
  }

  if (action === "nix_store") {
    const { stdout: info } = await execa("nix", ["store", "info"], { timeout: 10_000 }).catch(
      () => ({ stdout: "nix store info failed" })
    );
    result.nix_store_info = info.split("\n").filter(Boolean);
    const { stdout: gc } = await execa("nix", ["store", "gc", "--dry-run"], {
      timeout: 15_000,
    }).catch(() => ({ stdout: "" }));
    result.gc_dry_run = gc.split("\n").filter(Boolean).slice(0, 20);
  }

  if (action === "largest_files") {
    const { stdout } = await execa("du", ["-ah", path], { timeout: 15_000 }).catch(() => ({
      stdout: "",
    }));
    const sorted = stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [size, ...file] = l.split("\t");
        return { size, file: file.join("\t") };
      })
      .sort((a, b) => parseFloat(b.size) - parseFloat(a.size))
      .slice(0, top_n);
    result.largest = sorted;
  }

  if (action === "io_stats") {
    const { stdout } = await execa("iostat", ["-x", "1", "2"], { timeout: 10_000 }).catch(() => ({
      stdout: "",
    }));
    result.io_stats = stdout.split("\n").filter(Boolean);
  }

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

export async function handleSecurityScan(args: z.infer<typeof securityScanSchema>) {
  const { action = "all", since = "24 hours ago" } = args;
  const result: any = {};

  if (action === "failed_logins" || action === "all") {
    const { stdout } = await execa(
      "journalctl",
      ["--no-pager", "-u", "sshd", "--since", since, "-p", "warning"],
      { timeout: 10_000 }
    ).catch(() => ({ stdout: "" }));
    const failures = stdout
      .split("\n")
      .filter((l) => l.includes("Failed") || l.includes("failure") || l.includes("Invalid"));
    result.failed_logins = { count: failures.length, recent: failures.slice(-5) };
  }

  if (action === "open_ports" || action === "all") {
    const { stdout } = await execa("ss", ["-tlnp"], { timeout: 5_000 }).catch(() => ({
      stdout: "",
    }));
    const lines = stdout.split("\n").filter(Boolean).slice(1);
    result.open_ports = lines.map((l) => {
      const p = l.trim().split(/\s+/);
      return { proto: p[0], local: p[3], process: p.slice(6).join(" ") };
    });
  }

  if (action === "suid_files" || action === "all") {
    const { stdout } = await execa(
      "find",
      ["/usr/bin", "/usr/sbin", "-perm", "/4000", "-type", "f"],
      { timeout: 10_000 }
    ).catch(() => ({ stdout: "" }));
    result.suid_files = stdout.split("\n").filter(Boolean);
  }

  if (action === "recent_changes" || action === "all") {
    const { stdout } = await execa("find", ["/etc", "-mtime", "-1", "-type", "f"], {
      timeout: 10_000,
    }).catch(() => ({ stdout: "" }));
    result.recent_changes = stdout.split("\n").filter(Boolean).slice(0, 20);
  }

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}
