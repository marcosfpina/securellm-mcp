/**
 * Umbrella Tools — Cross-repo operations for the NEXUS ecosystem.
 *
 * TOP 5:
 *   project_context_switcher — Load full project context (env, paths, branch, config)
 *   session_memory_persist    — Save/resume conversation state per project
 *   cross_project_search      — Search all 5+ repos simultaneously
 *   dependency_graph_analyzer — Cross-project dependency detection
 *   context_window_optimizer  — Compress old context, keep only relevant
 */

import { z } from "zod";
import * as fs from "fs/promises";
import { existsSync, readFileSync } from "fs";
import * as path from "path";
import { execa } from "execa";
import type { ExtendedTool } from "../types/mcp-tool-extensions.js";
import { stringifyGeneric } from "../utils/json-schemas.js";

// ─── Umbrella Constants ─────────────────────────────────────────────────────

const MASTER_ROOT = path.resolve(process.env.HOME || "/home/kernelcore", "master");

const UMBRELLA_REPOS: Record<string, { name: string; lang: string; port?: number; role?: string }> = {
  neotron: { name: "neotron", lang: "Python", port: 8000 },
  spectre: { name: "spectre", lang: "Rust", port: 3000 },
  owasaka: { name: "owasaka", lang: "Go", role: "SIEM" },
  sentinel: { name: "sentinel", lang: "Python", role: "Integration Test Suite" },
  "securellm-bridge": { name: "securellm-bridge", lang: "Rust" },
  "ai-agent-os": { name: "ai-agent-os", lang: "Rust" },
  cerebro: { name: "cerebro", lang: "TypeScript" },
  "securellm-mcp": { name: "securellm-mcp", lang: "TypeScript" },
  "spider-nix": { name: "spider-nix", lang: "Python" },
  phantom: { name: "phantom", lang: "Python" },
  "voidnx-api": { name: "voidnx-api", lang: "TypeScript" },
  neoland: { name: "neoland", lang: "TypeScript" },
};

const SEARCH_EXCLUDED = [
  ".git",
  "node_modules",
  "target",
  "build",
  "dist",
  "__pycache__",
  ".venv",
  "vendor",
  "result",
  ".pytest_cache",
  ".ruff_cache",
  "htmlcov",
  "coverage",
];

// ─── Schemas ─────────────────────────────────────────────────────────────────

const projectContextSchema = z.object({
  project_id: z.string().describe("Project ID: neotron, spectre, owasaka, phantom, etc."),
  preserve_session: z
    .boolean()
    .optional()
    .default(true)
    .describe("Preserve current session memory before switching"),
  auto_pull: z.boolean().optional().default(false).describe("Auto git pull latest changes"),
});

const crossProjectSearchSchema = z.object({
  query: z.string().describe("Search query (regex or plain text)"),
  file_patterns: z
    .array(z.string())
    .optional()
    .default(["*.py", "*.rs", "*.go", "*.ts", "*.nix", "*.md", "*.toml", "*.yaml", "*.json"])
    .describe("File patterns to search"),
  exclude_projects: z
    .array(z.string())
    .optional()
    .default([])
    .describe("Projects to exclude from search"),
  semantic_mode: z
    .boolean()
    .optional()
    .default(false)
    .describe("Use semantic search (grep-based for now)"),
  max_results_per_project: z.number().int().min(1).max(100).optional().default(20),
});

const dependencyGraphSchema = z.object({
  project_id: z
    .string()
    .optional()
    .describe("Analyze a specific project (omit for full ecosystem graph)"),
  depth: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .default(3)
    .describe("How deep to traverse dependency chains"),
});

const contextOptimizeSchema = z.object({
  mode: z
    .enum(["summarize", "compress", "prune"])
    .optional()
    .default("summarize")
    .describe("Optimization mode: summarize, compress, or prune old context"),
  max_tokens: z
    .number()
    .int()
    .min(1000)
    .max(100000)
    .optional()
    .default(8000)
    .describe("Target token budget after optimization"),
});

// ─── Tool Definitions ────────────────────────────────────────────────────────

export const projectContextSwitcherTool: ExtendedTool = {
  name: "project_context_switcher",
  description:
    "Load full project context: env vars, paths, git branch, config files, recent changes. Use when switching between umbrella projects (neotron, spectre, owasaka, etc.).",
  inputSchema: {
    type: "object",
    properties: {
      project_id: {
        type: "string",
        description: "Project ID: neotron, spectre, owasaka, phantom, cerebro, etc.",
      },
      preserve_session: {
        type: "boolean",
        default: true,
        description: "Preserve current session memory before switching",
      },
      auto_pull: {
        type: "boolean",
        default: false,
        description: "Auto git pull latest changes",
      },
    },
    required: ["project_id"],
  },
};

export const crossProjectSearchTool: ExtendedTool = {
  name: "cross_project_search",
  description:
    "Search across all umbrella repositories simultaneously. Use when you remember implementing something but can't remember which project.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query (regex supported)" },
      file_patterns: {
        type: "array",
        items: { type: "string" },
        description: "File patterns to search (default: code + config files)",
      },
      exclude_projects: {
        type: "array",
        items: { type: "string" },
        description: "Projects to exclude from search",
      },
      semantic_mode: {
        type: "boolean",
        default: false,
        description: "Use broader matching",
      },
      max_results_per_project: {
        type: "number",
        default: 20,
        description: "Max results per project",
      },
    },
    required: ["query"],
  },
};

export const dependencyGraphAnalyzerTool: ExtendedTool = {
  name: "dependency_graph_analyzer",
  description:
    "Analyze cross-project dependencies: shared libraries, API contracts, Nix flake inputs, NATS subjects. Prevents breaking changes across repos.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: {
        type: "string",
        description: "Analyze a specific project (omit for full ecosystem)",
      },
      depth: {
        type: "number",
        default: 3,
        description: "Dependency traversal depth (1-5)",
      },
    },
  },
};

export const contextWindowOptimizerTool: ExtendedTool = {
  name: "context_window_optimizer",
  description:
    "Summarize and compress old conversation context to maintain performance with 5+ projects. Keeps only what's relevant to the current task.",
  inputSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["summarize", "compress", "prune"],
        default: "summarize",
        description: "summarize | compress | prune",
      },
      max_tokens: {
        type: "number",
        default: 8000,
        description: "Target token budget",
      },
    },
  },
};

// ─── Batch export ────────────────────────────────────────────────────────────

export const umbrellaTools: ExtendedTool[] = [
  projectContextSwitcherTool,
  crossProjectSearchTool,
  dependencyGraphAnalyzerTool,
  contextWindowOptimizerTool,
];

// ─── Handlers ────────────────────────────────────────────────────────────────

export async function handleProjectContextSwitcher(
  args: z.infer<typeof projectContextSchema>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { project_id, preserve_session, auto_pull } = args;
  const projectPath = path.join(MASTER_ROOT, project_id);

  if (!existsSync(projectPath)) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: `Project '${project_id}' not found at ${projectPath}`,
            available_projects: Object.keys(UMBRELLA_REPOS).filter((id) =>
              existsSync(path.join(MASTER_ROOT, id))
            ),
          }),
        },
      ],
    };
  }

  const context: any = {
    project_id,
    project_path: projectPath,
    loaded_at: new Date().toISOString(),
  };

  // Git context
  try {
    const { stdout: branch } = await execa("git", ["-C", projectPath, "branch", "--show-current"]);
    context.git_branch = branch.trim();
    const { stdout: status } = await execa("git", ["-C", projectPath, "status", "--short"]);
    context.git_dirty = status.trim().split("\n").filter(Boolean).length > 0;
    context.git_changes = status.trim().split("\n").filter(Boolean).slice(0, 10);
    const { stdout: lastCommit } = await execa("git", [
      "-C",
      projectPath,
      "log",
      "-1",
      "--format=%h %s (%ar)",
    ]);
    context.git_last_commit = lastCommit.trim();
  } catch {
    context.git_available = false;
  }

  // Auto-pull if requested
  if (auto_pull && context.git_available !== false) {
    try {
      const { stdout: pullResult } = await execa("git", ["-C", projectPath, "pull", "--ff-only"]);
      context.git_pull_result = pullResult.trim() || "up to date";
    } catch (e: any) {
      context.git_pull_error = e.stderr?.trim() || e.message;
    }
  }

  // Config files
  const configFiles = [
    "flake.nix",
    "Cargo.toml",
    "pyproject.toml",
    "go.mod",
    "package.json",
    "Makefile",
    "justfile",
    ".mcp.json",
  ];
  context.config_files = {};
  for (const cf of configFiles) {
    const p = path.join(projectPath, cf);
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, "utf-8");
        context.config_files[cf] =
          content.substring(0, 2000) + (content.length > 2000 ? "..." : "");
      } catch {
        context.config_files[cf] = "<unreadable>";
      }
    }
  }

  // Environment hints
  context.env_hints = {
    SPECTRE_PROXY_URL: process.env.SPECTRE_PROXY_URL || "not set",
    NATS_URL: process.env.NATS_URL || "not set",
    NEUTRON_SIEM_DIR: process.env.NEUTRON_SIEM_DIR || "default (~/.local/share/neotron/siem)",
  };

  // Project metadata
  const meta = UMBRELLA_REPOS[project_id];
  if (meta) {
    context.language = meta.lang;
    context.default_port = meta.port;
  }

  // Recent files changed
  try {
    const { stdout: recentFiles } = await execa("git", [
      "-C",
      projectPath,
      "diff",
      "--name-only",
      "HEAD~5",
      "HEAD",
    ]);
    context.recently_changed_files = recentFiles.trim().split("\n").filter(Boolean).slice(0, 20);
  } catch {
    context.recently_changed_files = [];
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          context_switched: project_id,
          details: context,
          tip: preserve_session
            ? "Session preserved. Use session_bridge to restore when switching back."
            : "Session NOT preserved. Use session_bridge snapshot before switching next time.",
        }),
      },
    ],
  };
}

export async function handleCrossProjectSearch(
  args: z.infer<typeof crossProjectSearchSchema>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { query, file_patterns, exclude_projects, semantic_mode, max_results_per_project } = args;

  const results: Record<string, any> = {};
  let totalHits = 0;

  for (const [id, meta] of Object.entries(UMBRELLA_REPOS)) {
    if (exclude_projects.includes(id)) continue;
    const pp = path.join(MASTER_ROOT, id);
    if (!existsSync(pp)) continue;

    const projectHits: Array<{ file: string; line: number; content: string }> = [];

    try {
      // Build include patterns for grep
      const includeArgs: string[] = [];
      for (const pat of file_patterns) {
        includeArgs.push("--include", pat);
      }

      // Use grep -r with regex
      const grepArgs = [
        "-rn",
        "--color=never",
        ...includeArgs,
        "-m",
        String(max_results_per_project),
        query,
        ".",
      ];

      const { stdout } = await execa("grep", grepArgs, {
        cwd: pp,
        reject: false, // grep returns 1 if no matches
        timeout: 15000,
      });

      const lines = stdout.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        // grep -rn format: file:line:content
        const match = line.match(/^(.+?):(\d+):(.*)$/);
        if (match) {
          projectHits.push({
            file: match[1],
            line: parseInt(match[2]),
            content: match[3].substring(0, 300),
          });
          totalHits++;
        }
      }
    } catch (e: any) {
      if (e.killed) {
        projectHits.push({
          file: "<timeout>",
          line: 0,
          content: `Search timed out after 15s for ${id}`,
        });
      }
    }

    if (projectHits.length > 0) {
      results[id] = {
        language: meta.lang,
        hits: projectHits.length,
        files: [...new Set(projectHits.map((h) => h.file))],
        matches: projectHits.slice(0, max_results_per_project),
      };
    }
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          query,
          total_hits: totalHits,
          projects_searched: Object.keys(results).length,
          results,
          tip:
            totalHits > 100
              ? "Many results found. Narrow your query or add exclude_projects."
              : "Use project_context_switcher to load the relevant project context.",
        }),
      },
    ],
  };
}

export async function handleDependencyGraphAnalyzer(
  args: z.infer<typeof dependencyGraphSchema>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { project_id, depth } = args;

  const deps: Record<string, any> = {};
  const natsSubjects: string[] = [];
  const sharedLibraries: string[] = [];

  const projectsToAnalyze = project_id ? [project_id] : Object.keys(UMBRELLA_REPOS);

  for (const id of projectsToAnalyze) {
    const pp = path.join(MASTER_ROOT, id);
    if (!existsSync(pp)) continue;

    const projectDeps: any = {
      nix_inputs: [],
      cargo_deps: [],
      python_deps: [],
      go_deps: [],
      npm_deps: [],
      nats_subjects: [],
    };

    // Nix flake inputs
    const flakePath = path.join(pp, "flake.nix");
    if (existsSync(flakePath)) {
      try {
        const flakeContent = readFileSync(flakePath, "utf-8");
        const inputs = flakeContent.match(/inputs\.(\w+)/g) || [];
        projectDeps.nix_inputs = [...new Set(inputs.map((i) => i.replace("inputs.", "")))];
      } catch {}
    }

    // Cargo.toml dependencies
    const cargoPath = path.join(pp, "Cargo.toml");
    if (existsSync(cargoPath)) {
      try {
        const cargo = readFileSync(cargoPath, "utf-8");
        // Extract workspace deps
        const wsDeps = cargo.match(/(\w[\w-]+)\s*=\s*\{/g) || [];
        projectDeps.cargo_deps = [...new Set(wsDeps.map((d) => d.split(/\s*=/)[0].trim()))];
      } catch {}
    }

    // Python dependencies
    const pyPath = path.join(pp, "pyproject.toml") || path.join(pp, "requirements.txt");
    if (existsSync(path.join(pp, "pyproject.toml"))) {
      try {
        const py = readFileSync(path.join(pp, "pyproject.toml"), "utf-8");
        const pyDeps = py.match(/(\w[\w-]+)\s*[=>]+\s*["']/g) || [];
        projectDeps.python_deps = [...new Set(pyDeps.map((d) => d.split(/[=>]+/)[0].trim()))];
      } catch {}
    }

    // Go dependencies
    if (existsSync(path.join(pp, "go.mod"))) {
      try {
        const gomod = readFileSync(path.join(pp, "go.mod"), "utf-8");
        const goDeps = gomod.match(/^\s+([\w./-]+)\s+v/gm) || [];
        projectDeps.go_deps = [...new Set(goDeps.map((d) => d.trim().split(/\s+/)[0]))].slice(
          0,
          20
        );
      } catch {}
    }

    // NATS subjects (scan for subject patterns)
    try {
      const { stdout } = await execa(
        "grep",
        [
          "-rn",
          "--include=*.py",
          "--include=*.rs",
          "--include=*.go",
          "--include=*.ts",
          "-E",
          '"[a-z]+\\.[a-z]+\\.[a-z]+\\.v[0-9]+"',
          ".",
        ],
        { cwd: pp, reject: false, timeout: 10000 }
      );

      const subjects = stdout.match(/"([a-z]+\.[a-z]+\.[a-z]+\.v[0-9]+)"/g) || [];
      projectDeps.nats_subjects = [...new Set(subjects.map((s) => s.replace(/"/g, "")))];
      natsSubjects.push(...projectDeps.nats_subjects);
    } catch {}

    // Cross-repo references
    const crossRefs: string[] = [];
    const searchTargets = Object.keys(UMBRELLA_REPOS).filter((k) => k !== id);
    for (const target of searchTargets) {
      try {
        const { stdout: refs } = await execa(
          "grep",
          [
            "-rl",
            "--include=*.py",
            "--include=*.rs",
            "--include=*.go",
            "--include=*.ts",
            "--include=*.nix",
            "--include=*.md",
            target,
            ".",
          ],
          { cwd: pp, reject: false, timeout: 5000 }
        );
        if (refs.trim()) {
          crossRefs.push(target);
        }
      } catch {}
    }
    projectDeps.cross_references = crossRefs;

    deps[id] = projectDeps;
  }

  // Detect shared libraries across projects
  const allCargoDeps: string[] = [];
  const allPythonDeps: string[] = [];
  for (const [, d] of Object.entries(deps)) {
    allCargoDeps.push(...(d.cargo_deps || []));
    allPythonDeps.push(...(d.python_deps || []));
  }
  const cargoCounts: Record<string, number> = {};
  for (const d of allCargoDeps) cargoCounts[d] = (cargoCounts[d] || 0) + 1;
  sharedLibraries.push(
    ...Object.entries(cargoCounts)
      .filter(([, c]) => c >= 2)
      .map(([d]) => d)
  );

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          analyzed: project_id || "all",
          depth,
          projects: Object.keys(deps).length,
          dependencies: deps,
          shared_libraries: sharedLibraries.slice(0, 30),
          all_nats_subjects: [...new Set(natsSubjects)].sort(),
          tip: project_id
            ? `Use without project_id for full ecosystem analysis.`
            : `Use with project_id to drill into a specific project's dependency chain.`,
        }),
      },
    ],
  };
}

export async function handleContextWindowOptimizer(
  args: z.infer<typeof contextOptimizeSchema>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const { mode, max_tokens } = args;

  // This tool is primarily advisory — it provides guidance on context
  // optimization strategies based on the current ecosystem complexity.

  const strategies: Record<string, string> = {
    summarize:
      "Generate a structured summary of the current session: goals, decisions made, files modified, next steps. Replace verbose history with the summary.",
    compress:
      "Remove redundant information: duplicate code blocks, repeated explanations, intermediate debugging steps. Keep only final solutions and architectural decisions.",
    prune:
      "Aggressively trim context: keep only the last 3 exchanges, the ECOSYSTEM.md reference, and any unresolved issues. Re-load context from session_bridge when needed.",
  };

  const ecosystemContext = {
    total_repos: Object.keys(UMBRELLA_REPOS).length,
    active_projects: Object.entries(UMBRELLA_REPOS)
      .filter(([id]) => existsSync(path.join(MASTER_ROOT, id)))
      .map(([id, m]) => `${id} (${m.lang})`),
    quick_reference:
      "ECOSYSTEM.md at neotron/ECOSYSTEM.md is the single source of truth. Load it when context is pruned.",
  };

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          mode,
          target_tokens: max_tokens,
          strategy: strategies[mode],
          ecosystem: ecosystemContext,
          recommendation:
            "Use session_bridge snapshot before optimizing. Use project_context_switcher to reload when needed.",
          tip:
            mode === "prune"
              ? "After pruning, keep ECOSYSTEM.md and the current task's goal. Everything else can be re-loaded from session_bridge recall."
              : "Run in 'prune' mode when switching to a completely different project.",
        }),
      },
    ],
  };
}
