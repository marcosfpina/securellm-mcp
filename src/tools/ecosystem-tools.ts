/**
 * Ecosystem Awareness Tools — ecosystem_map, ecosystem_trace, ecosystem_search
 *
 * Gives AI agents consciousness of the 18-project ecosystem in ~/master/.
 * No agent should ever be blind to the project graph again.
 */

import { z } from "zod";
import * as fs from "fs/promises";
import { readFileSync, existsSync } from "fs";
import * as path from "path";
import type { ExtendedTool } from "../types/mcp-tool-extensions.js";
import { stringifyGeneric } from "../utils/json-schemas.js";
import type { McpToolResult } from "../server/wrap.js";

// ─── Ecosystem Root ───────────────────────────────────────────────────────────

const ECOSYSTEM_ROOT = path.resolve(process.env.HOME || "/home/kernelcore", "master");
const EXCLUDED_DIRS = new Set([
  ".claude",
  ".github",
  ".gemini",
  ".phantom",
  ".wrangler",
  "voidnxlabs-newsletter",
  "voidnxlabs-workflows",
]);

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProjectInfo {
  name: string;
  path: string;
  languages: string[];
  description: string;
  role: string;
  subprojects: string[];
  nix_flake_inputs: string[];
  dependencies_on_ecosystem: string[];
  readme_summary: string;
}

interface EcosystemGraph {
  root: string;
  projects: ProjectInfo[];
  relationships: Array<{ from: string; to: string; type: string; detail: string }>;
  stats: {
    total_projects: number;
    rust_projects: number;
    python_projects: number;
    go_projects: number;
    typescript_projects: number;
    total_nix_flakes: number;
  };
}

// ─── Ecosystem Discovery Engine ────────────────────────────────────────────────

let cachedEcosystem: EcosystemGraph | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function discoverEcosystem(force = false): Promise<EcosystemGraph> {
  if (!force && cachedEcosystem && Date.now() - cacheTimestamp < CACHE_TTL_MS)
    return cachedEcosystem;

  const projects: ProjectInfo[] = [];
  const relationships: Array<{ from: string; to: string; type: string; detail: string }> = [];

  let entries;
  try {
    entries = await fs.readdir(ECOSYSTEM_ROOT, { withFileTypes: true });
  } catch {
    return {
      root: ECOSYSTEM_ROOT,
      projects: [],
      relationships: [],
      stats: {
        total_projects: 0,
        rust_projects: 0,
        python_projects: 0,
        go_projects: 0,
        typescript_projects: 0,
        total_nix_flakes: 0,
      },
    };
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith("."))
      continue;
    projects.push(await analyzeProject(entry.name, path.join(ECOSYSTEM_ROOT, entry.name)));
  }

  // Build relationship graph
  for (const project of projects) {
    for (const dep of project.dependencies_on_ecosystem) {
      if (projects.some((p) => p.name === dep)) {
        relationships.push({
          from: project.name,
          to: dep,
          type: "dependency",
          detail: "cross-project reference",
        });
      }
    }
  }

  // Sentinel tests multiple projects
  if (projects.some((p) => p.name === "sentinel")) {
    for (const target of ["neotron", "cerebro", "spectre", "phantom"]) {
      if (projects.some((p) => p.name === target))
        relationships.push({
          from: "sentinel",
          to: target,
          type: "integration_test",
          detail: "Integration test suite covers this project",
        });
    }
  }

  const stats = {
    total_projects: projects.length,
    rust_projects: projects.filter((p) => p.languages.includes("Rust")).length,
    python_projects: projects.filter((p) => p.languages.includes("Python")).length,
    go_projects: projects.filter((p) => p.languages.includes("Go")).length,
    typescript_projects: projects.filter((p) => p.languages.includes("TypeScript")).length,
    total_nix_flakes: projects.filter((p) => existsSync(path.join(p.path, "flake.nix"))).length,
  };

  cachedEcosystem = { root: ECOSYSTEM_ROOT, projects, relationships, stats };
  cacheTimestamp = Date.now();
  return cachedEcosystem;
}

async function analyzeProject(name: string, pp: string): Promise<ProjectInfo> {
  const languages: string[] = [];
  const subprojects: string[] = [];
  const nix_flake_inputs: string[] = [];
  const deps: string[] = [];
  let description = "",
    role = "",
    readme = "";

  if (existsSync(path.join(pp, "Cargo.toml"))) {
    languages.push("Rust");
    try {
      const c = readFileSync(path.join(pp, "Cargo.toml"), "utf-8");
      for (const kw of [
        "cerebro",
        "phantom",
        "spectre",
        "neotron",
        "sentinel",
        "spider",
        "securellm",
        "adr",
        "owasaka",
      ])
        if (c.toLowerCase().includes(kw)) deps.push(kw);
    } catch {
      // Optional manifest metadata may be unreadable; discovery should continue.
    }
  }
  if (existsSync(path.join(pp, "package.json"))) {
    languages.push("TypeScript");
  }
  if (existsSync(path.join(pp, "pyproject.toml")) || existsSync(path.join(pp, "setup.py"))) {
    languages.push("Python");
    try {
      const c = existsSync(path.join(pp, "pyproject.toml"))
        ? readFileSync(path.join(pp, "pyproject.toml"), "utf-8")
        : "";
      for (const kw of [
        "cerebro",
        "phantom",
        "spectre",
        "neotron",
        "sentinel",
        "spider",
        "spooknix",
        "securellm",
        "nexus",
        "bastion",
      ])
        if (c.toLowerCase().includes(kw)) {
          const r = kw === "nexus" || kw === "bastion" ? "neotron" : kw;
          if (!deps.includes(r)) deps.push(r);
        }
    } catch {
      // Optional Python project metadata may be unreadable; discovery should continue.
    }
  }
  if (existsSync(path.join(pp, "go.mod"))) {
    languages.push("Go");
  }

  if (existsSync(path.join(pp, "flake.nix"))) {
    try {
      const f = readFileSync(path.join(pp, "flake.nix"), "utf-8");
      for (const m of f.matchAll(/inputs\.(\w+)/g)) nix_flake_inputs.push(m[1]);
      const map: Record<string, string> = {
        cerebro: "cerebro",
        phantom: "phantom",
        spectre: "spectre",
        spider: "spider-nix",
        intel: "phantom",
        ml: "ml-ops-api",
        securellm: "securellm-bridge",
        owasaka: "owasaka",
      };
      for (const inp of nix_flake_inputs) {
        const pn = map[inp] || inp;
        if (pn !== "nixpkgs" && pn !== "crane" && pn !== "flake" && !deps.includes(pn))
          deps.push(pn);
      }
    } catch {
      // Optional flake metadata may be unreadable; discovery should continue.
    }
  }

  try {
    for (const d of await fs.readdir(pp, { withFileTypes: true }))
      if (
        d.isDirectory() &&
        !d.name.startsWith(".") &&
        ![
          "node_modules",
          "target",
          "build",
          "dist",
          "__pycache__",
          "result",
          ".git",
          "vendor",
        ].includes(d.name)
      )
        subprojects.push(d.name);
  } catch {
    // Optional subproject scan may fail on permissions; discovery should continue.
  }

  if (existsSync(path.join(pp, "README.md"))) {
    try {
      const lines = readFileSync(path.join(pp, "README.md"), "utf-8").split("\n");
      const h1 = lines.find((l) => /^#\s/.test(l));
      if (h1) description = h1.replace(/^#\s+/, "").trim();
      readme = lines.slice(0, 30).join(" ").substring(0, 500);
    } catch {
      // Optional README metadata may be unreadable; discovery should continue.
    }
  }

  // Role classification
  const roleMap: Record<string, string> = {
    "securellm-bridge": "API Gateway / LLM Proxy (Zero-Trust)",
    cerebro: "Knowledge Extraction & Distributed RAG Platform",
    neotron: "AI Agent Orchestration & Compliance (NEXUS/BASTION)",
    neoland: "AI Agent Platform (Multi-Agent DSPy + TUI + gRPC)",
    phantom: "Document Intelligence — classify, sanitize, index",
    spooknix: "Privacy-first Speech-to-Text Engine (Whisper)",
    spectre: "Fleet Management & Infrastructure Orchestration",
    "adr-ledger": "Architecture Decision Records — Merkle Blockchain",
    "spider-nix": "OSINT Reconnaissance (DNS, subdomains, port scans)",
    sentinel: "Integration Test Suite — cross-project validation",
    owasaka: "SIEM — Security Information & Event Management",
    "ml-ops-api": "ML Offload API & Model Registry",
    voidnxsec: "Security Fortress (C/C++/Go/Rust tools)",
    "ai-agent-os": "AI Agent Operating System",
    "arch-analyzer": "Architecture Analyzer",
    "cerebro-reranker": "Reranking Module for Cerebro",
    "spider-nix-network": "Network Proxy for Spider-Nix",
    "securellm-mcp": "MCP Server — AI Tool Protocol (this server)",
  };
  role = roleMap[name] || "";

  return {
    name,
    path: pp,
    languages,
    description,
    role,
    subprojects,
    nix_flake_inputs,
    dependencies_on_ecosystem: [...new Set(deps)],
    readme_summary: readme,
  };
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const ecosystemMapSchema = z.object({
  force_refresh: z
    .boolean()
    .optional()
    .default(false)
    .describe("Force re-discovery instead of using cache"),
  format: z.enum(["summary", "full"]).optional().default("summary").describe("Output detail level"),
  filter_project: z.string().optional().describe("Focus on a specific project (by name)"),
});

const ecosystemTraceSchema = z.object({
  target: z.string().describe("Symbol, API, file path, or concept to trace across the ecosystem"),
  direction: z
    .enum(["upstream", "downstream", "both"])
    .optional()
    .default("both")
    .describe("Trace direction from the target"),
});

const ecosystemSearchSchema = z.object({
  query: z.string().describe("Search query — symbol, concept, pattern, dependency name"),
  scope: z
    .enum(["code", "docs", "configs", "all"])
    .optional()
    .default("all")
    .describe("Search scope"),
  max_results: z.number().int().min(1).max(50).optional().default(20),
});

// ─── Tool Definitions ─────────────────────────────────────────────────────────

export const ecosystemMapTool: ExtendedTool = {
  name: "ecosystem_map",
  description:
    "Discover and map the entire ~/master/ project ecosystem. Shows all projects, their roles, languages, dependencies, and cross-project relationships. Use this FIRST when working across projects.",
  defer_loading: true,
  priority: "high",
  execution_class: "diagnostic",
  cost_tier: "moderate",
  inputSchema: {
    type: "object",
    properties: {
      force_refresh: {
        type: "boolean",
        description: "Force re-discovery instead of using cache",
        default: false,
      },
      format: {
        type: "string",
        enum: ["summary", "full"],
        description: "Output detail level",
        default: "summary",
      },
      filter_project: { type: "string", description: "Focus on a specific project (by name)" },
    },
  },
};

export const ecosystemTraceTool: ExtendedTool = {
  name: "ecosystem_trace",
  description:
    "Trace a symbol, API, file, or concept across the entire ecosystem. Shows where it's used, what depends on it, and what it depends on. Essential for understanding change impact across 18 projects.",
  defer_loading: true,
  priority: "high",
  execution_class: "diagnostic",
  cost_tier: "moderate",
  inputSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description: "Symbol, API, file path, or concept to trace across the ecosystem",
      },
      direction: {
        type: "string",
        enum: ["upstream", "downstream", "both"],
        description: "Trace direction from the target",
        default: "both",
      },
    },
    required: ["target"],
  },
};

export const ecosystemSearchTool: ExtendedTool = {
  name: "ecosystem_search",
  description:
    "Cross-project search across all ~/master/ projects. Searches code, docs, and configs simultaneously. Returns context-aware results showing which projects reference a concept and how.",
  defer_loading: true,
  priority: "high",
  execution_class: "interactive",
  cost_tier: "moderate",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query — symbol, concept, pattern, dependency name",
      },
      scope: {
        type: "string",
        enum: ["code", "docs", "configs", "all"],
        description: "Search scope",
        default: "all",
      },
      max_results: { type: "number", description: "Maximum results (default: 20)", default: 20 },
    },
    required: ["query"],
  },
};

// ─── Batch export ─────────────────────────────────────────────────────────────

export const ecosystemTools: ExtendedTool[] = [
  ecosystemMapTool,
  ecosystemTraceTool,
  ecosystemSearchTool,
];

// ─── Handlers ─────────────────────────────────────────────────────────────────

export async function handleEcosystemMap(
  args: z.infer<typeof ecosystemMapSchema>
): Promise<McpToolResult> {
  try {
    const eco = await discoverEcosystem(args.force_refresh);
    const projects = args.filter_project
      ? eco.projects.filter(
          (p) => p.name === args.filter_project || p.name.includes(args.filter_project!)
        )
      : eco.projects;

    if (args.format === "full") {
      return {
        content: [
          {
            type: "text",
            text: stringifyGeneric({ ecosystem: eco, generated_at: new Date().toISOString() }),
          },
        ],
      };
    }

    const summary = projects.map((p) => ({
      name: p.name,
      role: p.role || "(unknown)",
      languages: p.languages,
      deps_on_ecosystem: p.dependencies_on_ecosystem,
      subprojects: p.subprojects.slice(0, 8),
    }));

    const relationships = eco.relationships.filter(
      (r) => !args.filter_project || r.from === args.filter_project || r.to === args.filter_project
    );

    return {
      content: [
        {
          type: "text",
          text: stringifyGeneric({
            ecosystem_root: eco.root,
            stats: eco.stats,
            projects: summary,
            relationships,
            tip: "Use ecosystem_trace to analyze change impact. Use ecosystem_search to find concepts across projects.",
            generated_at: new Date().toISOString(),
          }),
        },
      ],
    };
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `Ecosystem map error: ${err.message}` }],
      isError: true,
    };
  }
}

export async function handleEcosystemTrace(
  args: z.infer<typeof ecosystemTraceSchema>
): Promise<McpToolResult> {
  try {
    const eco = await discoverEcosystem();
    const { target, direction } = args;
    const targetLower = target.toLowerCase();

    // Find projects that reference the target
    const hits: Array<{
      project: string;
      files: string[];
      relevance: "direct" | "indirect";
      context: string;
    }> = [];

    for (const project of eco.projects) {
      try {
        const projectFiles: string[] = [];

        // Search README
        const readmePath = path.join(project.path, "README.md");
        if (existsSync(readmePath)) {
          const readme = readFileSync(readmePath, "utf-8");
          if (readme.toLowerCase().includes(targetLower)) {
            projectFiles.push("README.md");
          }
        }

        // Search flake.nix
        const flakePath = path.join(project.path, "flake.nix");
        if (existsSync(flakePath)) {
          const flake = readFileSync(flakePath, "utf-8");
          if (flake.toLowerCase().includes(targetLower)) {
            projectFiles.push("flake.nix");
          }
        }

        // Search Cargo.toml / pyproject.toml / package.json
        for (const manifest of ["Cargo.toml", "pyproject.toml", "package.json", "go.mod"]) {
          const mp = path.join(project.path, manifest);
          if (existsSync(mp)) {
            const content = readFileSync(mp, "utf-8");
            if (content.toLowerCase().includes(targetLower)) {
              projectFiles.push(manifest);
            }
          }
        }

        if (projectFiles.length > 0) {
          const relevance: "direct" | "indirect" = project.dependencies_on_ecosystem.some(
            (d) => d.toLowerCase().includes(targetLower) || targetLower.includes(d.toLowerCase())
          )
            ? "direct"
            : "indirect";

          hits.push({
            project: project.name,
            files: projectFiles,
            relevance,
            context: project.role || project.description,
          });
        }
      } catch {
        // Individual projects may have unreadable manifests; trace should continue.
      }
    }

    // Build impact analysis
    const directDeps = hits.filter((h) => h.relevance === "direct");
    const indirectDeps = hits.filter((h) => h.relevance === "indirect");
    const affectedProjects = [...new Set(hits.map((h) => h.project))];

    return {
      content: [
        {
          type: "text",
          text: stringifyGeneric({
            target,
            direction,
            summary: `Found in ${hits.length} project(s) — ${directDeps.length} direct, ${indirectDeps.length} indirect`,
            affected_projects: affectedProjects,
            direct_dependencies: directDeps,
            indirect_references: indirectDeps,
            ecosystem_deps_of_affected: affectedProjects.flatMap((name) => {
              const proj = eco.projects.find((p) => p.name === name);
              return proj ? [{ project: name, depends_on: proj.dependencies_on_ecosystem }] : [];
            }),
            tip: "Use ecosystem_search for deeper code-level search. Use ecosystem_map for full context.",
          }),
        },
      ],
    };
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `Ecosystem trace error: ${err.message}` }],
      isError: true,
    };
  }
}

export async function handleEcosystemSearch(
  args: z.infer<typeof ecosystemSearchSchema>
): Promise<McpToolResult> {
  try {
    const eco = await discoverEcosystem();
    const { query, scope, max_results } = args;
    const queryLower = query.toLowerCase();

    const results: Array<{ project: string; file: string; lines: string[]; match_count: number }> =
      [];

    for (const project of eco.projects) {
      if (results.length >= max_results) break;
      try {
        // Search README
        const readmePath = path.join(project.path, "README.md");
        if (existsSync(readmePath) && (scope === "all" || scope === "docs")) {
          const readme = readFileSync(readmePath, "utf-8");
          const matchingLines = readme
            .split("\n")
            .filter((l) => l.toLowerCase().includes(queryLower));
          if (matchingLines.length > 0) {
            results.push({
              project: project.name,
              file: "README.md",
              lines: matchingLines.slice(0, 3),
              match_count: matchingLines.length,
            });
          }
        }

        // Search manifests
        if (scope === "all" || scope === "configs") {
          for (const manifest of [
            "flake.nix",
            "Cargo.toml",
            "pyproject.toml",
            "package.json",
            "go.mod",
          ]) {
            const mp = path.join(project.path, manifest);
            if (existsSync(mp)) {
              const content = readFileSync(mp, "utf-8");
              const matchingLines = content
                .split("\n")
                .filter((l) => l.toLowerCase().includes(queryLower));
              if (matchingLines.length > 0) {
                results.push({
                  project: project.name,
                  file: manifest,
                  lines: matchingLines.slice(0, 3).map((l) => l.trim()),
                  match_count: matchingLines.length,
                });
              }
            }
          }
        }

        // Search source files (limited depth for performance)
        if (scope === "all" || scope === "code") {
          const srcDir = path.join(project.path, "src");
          if (existsSync(srcDir)) {
            const srcFiles = await collectSourceFiles(
              srcDir,
              [".rs", ".py", ".ts", ".go", ".js"],
              30
            );
            for (const sf of srcFiles) {
              if (results.length >= max_results) break;
              try {
                const content = readFileSync(sf, "utf-8");
                const matchingLines = content
                  .split("\n")
                  .filter((l) => l.toLowerCase().includes(queryLower));
                if (matchingLines.length > 0) {
                  results.push({
                    project: project.name,
                    file: path.relative(project.path, sf),
                    lines: matchingLines.slice(0, 3).map((l) => l.trim()),
                    match_count: matchingLines.length,
                  });
                }
              } catch {
                // Individual source files may be unreadable; search should continue.
              }
            }
          }
        }
      } catch {
        // Individual projects may be unreadable; search should continue.
      }
    }

    const byProject: Record<string, number> = {};
    for (const r of results) {
      byProject[r.project] = (byProject[r.project] || 0) + 1;
    }

    return {
      content: [
        {
          type: "text",
          text: stringifyGeneric({
            query,
            scope,
            total_results: results.length,
            projects_touched: Object.keys(byProject).length,
            by_project: byProject,
            results: results.slice(0, max_results),
            tip: "Use ecosystem_trace to analyze impact of what you found.",
          }),
        },
      ],
    };
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `Ecosystem search error: ${err.message}` }],
      isError: true,
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function collectSourceFiles(
  dir: string,
  extensions: string[],
  maxFiles: number
): Promise<string[]> {
  const results: string[] = [];
  const queue = [dir];
  const exclude = new Set([
    "node_modules",
    "target",
    "build",
    "dist",
    "__pycache__",
    ".git",
    "vendor",
    "result",
    ".venv",
  ]);
  while (queue.length > 0 && results.length < maxFiles) {
    const current = queue.pop()!;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (results.length >= maxFiles) break;
      if (e.isDirectory() && !exclude.has(e.name) && !e.name.startsWith("."))
        queue.push(path.join(current, e.name));
      else if (e.isFile() && extensions.some((ext) => e.name.endsWith(ext)))
        results.push(path.join(current, e.name));
    }
  }
  return results;
}
