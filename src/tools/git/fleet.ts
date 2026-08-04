/**
 * git_fleet — ADR-0062
 *
 * Survey read-only dos repos do ecossistema. Responde à pergunta que um
 * operador solo com 21 repos faz todos os dias e que nenhuma tool respondia:
 * "o que está dirty, unpushed ou atrás do upstream em tudo?"
 *
 * Duas decisões que valem a pena conhecer:
 *
 *   - `status --porcelain=v2 --branch` devolve branch, upstream, ahead, behind
 *     e o estado de cada ficheiro numa chamada só. Um comando por repo em vez
 *     de quatro.
 *
 *   - Por default NÃO faz fetch. Ahead/behind vem de remote-tracking refs que
 *     podem estar velhas, e a resposta diz há quanto tempo — um número stale
 *     visível é melhor do que um número errado invisível. `refresh: true` pede
 *     o fetch explicitamente, e ele é auditado como mutação porque escreve refs.
 */

import { z } from "zod";
import { statSync } from "fs";
import * as path from "path";
import type { ExtendedTool } from "../../types/mcp-tool-extensions.js";
import { zodToMcpSchema } from "../../utils/schema-converter.js";
import { listEcosystemRepos } from "../../config/workspace.js";
import {
  runGitIn,
  toGitError,
  emitAudit,
  newAuditId,
  gitFail,
  type GitOpsContext,
  type GitToolResult,
} from "./exec.js";
import { guardGitArgv } from "./guard.js";

// ─── Schema ──────────────────────────────────────────────────────────────────

export const gitFleetSchema = z.object({
  action: z
    .enum(["status", "unpushed", "behind", "branches", "stale", "summary"])
    .optional()
    .default("status")
    .describe(
      "status: full per-repo report | unpushed: only repos with local-only commits or tags | " +
        "behind: only repos behind their upstream | branches: branch sprawl | " +
        "stale: no commits in stale_days | summary: totals only"
    ),
  repos: z
    .array(z.string().min(1))
    .max(64)
    .optional()
    .describe("Repo names under the ecosystem root. Omit for every discovered git repo."),
  exclude: z.array(z.string().min(1)).max(64).optional().default([]),
  refresh: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Run a guarded `git fetch --quiet --no-tags` first. Touches the network and writes " +
        "remote-tracking refs; audited. Default false reports the age of cached refs instead."
    ),
  include_clean: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include repos that have nothing to report"),
  stale_days: z.number().int().min(1).max(365).optional().default(30),
  concurrency: z.number().int().min(1).max(8).optional().default(4),
  max_dirty_files: z.number().int().min(1).max(50).optional().default(10),
  timeout_ms: z.number().int().min(1000).max(60000).optional().default(10000),
});

export type GitFleetArgs = z.infer<typeof gitFleetSchema>;

export const gitFleetTool: ExtendedTool = {
  name: "git_fleet",
  description:
    "Read-only git status survey across every repo in the ecosystem: dirty working trees, " +
    "unpushed commits and tags, divergence from upstream, branch sprawl, and stale repos " +
    "(ADR-0062).",
  inputSchema: zodToMcpSchema(gitFleetSchema),
  defer_loading: true,
  priority: "high",
  execution_class: "diagnostic",
  cost_tier: "moderate",
  volatile: true,
};

// ─── Tipos de saída ──────────────────────────────────────────────────────────

interface RepoReport {
  name: string;
  path: string;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  upstream_ref_age_seconds: number | null;
  staged: number;
  unstaged: number;
  untracked: number;
  dirty_files: number;
  sample_dirty: string[];
  stash_count: number;
  local_branches: number;
  worktrees: number;
  tags_total: number;
  latest_tag: string | null;
  local_only_tags: string[];
  tags_checked_against_remote: boolean;
  last_commit: { short: string; date: string; age_days: number | null; subject: string } | null;
  clean: boolean;
  errors: ReturnType<typeof toGitError>[];
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

/**
 * `git status --porcelain=v2 --branch`.
 *
 * Cabeçalhos: `# branch.head <name>`, `# branch.upstream <ref>`,
 * `# branch.ab +<ahead> -<behind>`. Entradas: `1`/`2` (alteradas/renomeadas,
 * com XY onde X é staged e Y é unstaged), `u` (unmerged), `?` (untracked).
 */
export function parsePorcelainV2(stdout: string, maxSamples: number) {
  let branch: string | null = null;
  let upstream: string | null = null;
  let detached = false;
  let ahead = 0;
  let behind = 0;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  const samples: string[] = [];

  for (const line of stdout.split("\n")) {
    if (!line) continue;

    if (line.startsWith("# branch.head ")) {
      const value = line.slice("# branch.head ".length).trim();
      // O git escreve literalmente "(detached)" quando não há branch.
      if (value === "(detached)") detached = true;
      else branch = value;
      continue;
    }
    if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length).trim();
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const match = line.match(/\+(\d+)\s+-(\d+)/);
      if (match) {
        ahead = parseInt(match[1], 10);
        behind = parseInt(match[2], 10);
      }
      continue;
    }
    if (line.startsWith("#")) continue;

    const kind = line[0];
    if (kind === "1" || kind === "2") {
      const xy = line.slice(2, 4);
      if (xy[0] !== ".") staged++;
      if (xy[1] !== ".") unstaged++;
      // Renomeados (`2`) trazem "<novo>\t<antigo>"; o path é o último campo.
      const filePath = line.split(" ").slice(kind === "2" ? 9 : 8).join(" ").split("\t")[0];
      if (samples.length < maxSamples) samples.push(`${xy} ${filePath}`);
    } else if (kind === "u") {
      staged++;
      unstaged++;
      const filePath = line.split(" ").slice(10).join(" ");
      if (samples.length < maxSamples) samples.push(`UU ${filePath}`);
    } else if (kind === "?") {
      untracked++;
      if (samples.length < maxSamples) samples.push(`?? ${line.slice(2)}`);
    }
  }

  return { branch, upstream, detached, ahead, behind, staged, unstaged, untracked, samples };
}

/** Idade do último fetch, por mtime do FETCH_HEAD. null se nunca houve fetch. */
function fetchAgeSeconds(repoPath: string, now: Date): number | null {
  try {
    const stat = statSync(path.join(repoPath, ".git", "FETCH_HEAD"));
    return Math.max(0, Math.floor((now.getTime() - stat.mtimeMs) / 1000));
  } catch {
    return null;
  }
}

// ─── Recolha por repo ────────────────────────────────────────────────────────

async function surveyRepo(
  repo: { name: string; path: string },
  args: GitFleetArgs,
  ctx: GitOpsContext,
  auditId: string
): Promise<RepoReport> {
  const errors: ReturnType<typeof toGitError>[] = [];
  const opts = { timeoutMs: args.timeout_ms };
  const run = (argv: string[]) => runGitIn(repo.path, argv, ctx, opts);

  if (args.refresh) {
    // Forma fixa e guardada: é a única maneira de `fetch` ser alcançável.
    const argv = ["fetch", "--quiet", "--no-tags"];
    const decision = guardGitArgv(argv, { repoRoot: repo.path, ecosystemRoot: ctx.ecosystemRoot });

    if (!decision.allowed) {
      emitAudit(ctx, {
        audit_id: auditId,
        tool: "git_fleet",
        action: "refresh",
        repo: repo.name,
        argv,
        mode: "confirmed",
        status: "denied",
        denial: { code: decision.code, offending: decision.offending },
      });
      errors.push({
        step: "fetch",
        argv,
        exit_code: -1,
        timed_out: false,
        stderr_tail: decision.reason,
      });
    } else {
      const fetched = await run(argv);
      emitAudit(ctx, {
        audit_id: auditId,
        tool: "git_fleet",
        action: "refresh",
        repo: repo.name,
        argv,
        mode: "confirmed",
        status: fetched.ok ? "executed" : "failed",
        exit_code: fetched.exit_code,
        reason: "git_fleet refresh: update remote-tracking refs before reporting",
      });
      if (!fetched.ok) errors.push(toGitError("fetch", fetched));
    }
  }

  const [status, stash, lastCommit, branches, worktrees] = await Promise.all([
    run(["status", "--porcelain=v2", "--branch", "--untracked-files=normal"]),
    run(["stash", "list"]),
    run(["log", "-1", "--format=%h%x1f%aI%x1f%s"]),
    run(["for-each-ref", "--format=%(refname:short)", "refs/heads/"]),
    run(["worktree", "list", "--porcelain"]),
  ]);

  if (!status.ok) errors.push(toGitError("status", status));
  if (!stash.ok) errors.push(toGitError("stash list", stash));
  if (!lastCommit.ok) errors.push(toGitError("log -1", lastCommit));

  const parsed = parsePorcelainV2(status.stdout, args.max_dirty_files);

  // Tags. Saber se uma tag está publicada exige perguntar ao remote — as refs
  // locais não guardam essa informação (refs/remotes/ tem branches, não tags).
  // Portanto: sem `refresh` reportamos as tags que existem e dizemos que não
  // sabemos; com `refresh` perguntamos de facto. Um "16 repos com tags por
  // publicar" inventado é pior do que um "não verificado" honesto.
  const localTags = await run(["for-each-ref", "--format=%(refname:short)", "refs/tags/"]);
  const tags = localTags.ok
    ? localTags.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
    : [];

  let localOnlyTags: string[] = [];
  let tagsChecked = false;

  if (args.refresh && tags.length) {
    const remote = await run(["ls-remote", "--tags", "--quiet", "origin"]);
    if (remote.ok) {
      const published = new Set(
        remote.stdout
          .split("\n")
          .map((line) => line.split("\t")[1])
          .filter(Boolean)
          .map((ref) => ref.replace(/^refs\/tags\//, "").replace(/\^\{\}$/, ""))
      );
      localOnlyTags = tags.filter((t) => !published.has(t)).slice(0, 10);
      tagsChecked = true;
    } else {
      errors.push(toGitError("ls-remote --tags", remote));
    }
  }

  const now = ctx.now();
  let last: RepoReport["last_commit"] = null;
  if (lastCommit.ok && lastCommit.stdout.trim()) {
    const [short, date, subject] = lastCommit.stdout.trim().split("\x1f");
    const ageDays = date ? Math.floor((now.getTime() - new Date(date).getTime()) / 86_400_000) : null;
    last = { short, date, age_days: ageDays, subject: subject ?? "" };
  }

  const dirtyFiles = parsed.staged + parsed.unstaged + parsed.untracked;
  const stashCount = stash.ok ? stash.stdout.split("\n").filter(Boolean).length : 0;
  const branchCount = branches.ok ? branches.stdout.split("\n").filter(Boolean).length : 0;
  const worktreeCount = worktrees.ok
    ? worktrees.stdout.split("\n").filter((l) => l.startsWith("worktree ")).length
    : 0;

  return {
    name: repo.name,
    path: repo.path,
    branch: parsed.branch,
    detached: parsed.detached,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    upstream_ref_age_seconds: fetchAgeSeconds(repo.path, now),
    staged: parsed.staged,
    unstaged: parsed.unstaged,
    untracked: parsed.untracked,
    dirty_files: dirtyFiles,
    sample_dirty: parsed.samples,
    stash_count: stashCount,
    local_branches: branchCount,
    worktrees: worktreeCount,
    tags_total: tags.length,
    latest_tag: tags.length ? tags[tags.length - 1] : null,
    local_only_tags: localOnlyTags,
    tags_checked_against_remote: tagsChecked,
    last_commit: last,
    clean:
      dirtyFiles === 0 &&
      parsed.ahead === 0 &&
      parsed.behind === 0 &&
      stashCount === 0 &&
      localOnlyTags.length === 0 &&
      errors.length === 0,
    errors,
  };
}

/** Executa `worker` sobre `items` com no máximo `limit` em voo. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function drain(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, drain));
  return results;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export function createGitFleetHandler(ctx: GitOpsContext) {
  return async function handle(rawArgs: unknown): Promise<GitToolResult> {
    let args: GitFleetArgs;
    try {
      args = gitFleetSchema.parse(rawArgs ?? {});
    } catch (err) {
      return gitFail({
        error: "invalid_arguments",
        detail: err instanceof z.ZodError ? err.issues : String(err),
      });
    }

    const auditId = newAuditId();
    const discovered = listEcosystemRepos();
    const excluded = new Set(args.exclude);

    let targets = discovered.filter((r) => !excluded.has(r.name));
    const unknown: string[] = [];

    if (args.repos?.length) {
      const wanted = new Set(args.repos);
      targets = targets.filter((r) => wanted.has(r.name));
      const found = new Set(targets.map((r) => r.name));
      for (const name of args.repos) if (!found.has(name)) unknown.push(name);
    }

    const reports = await mapWithConcurrency(targets, args.concurrency, (repo) =>
      surveyRepo(repo, args, ctx, auditId)
    );

    const totals = {
      repos: reports.length,
      dirty: reports.filter((r) => r.dirty_files > 0).length,
      ahead: reports.filter((r) => r.ahead > 0).length,
      behind: reports.filter((r) => r.behind > 0).length,
      detached: reports.filter((r) => r.detached).length,
      no_upstream: reports.filter((r) => !r.upstream && !r.detached).length,
      stale: reports.filter(
        (r) => r.last_commit?.age_days !== null && (r.last_commit?.age_days ?? 0) >= args.stale_days
      ).length,
      with_stashes: reports.filter((r) => r.stash_count > 0).length,
      local_only_tags: reports.filter((r) => r.local_only_tags.length > 0).length,
      errors: reports.filter((r) => r.errors.length > 0).length,
    };

    const filtered = selectForAction(reports, args);

    const payload: Record<string, unknown> = {
      generated_at: ctx.now().toISOString(),
      ecosystem_root: ctx.ecosystemRoot,
      action: args.action,
      refreshed: args.refresh,
      totals,
      recommendations: buildRecommendations(reports, totals, args),
    };

    if (unknown.length) {
      payload.unknown_repos = unknown;
      payload.known_repos = discovered.map((r) => r.name);
    }
    if (args.action !== "summary") {
      payload.repos = filtered;
    }
    if (!args.refresh) {
      payload.freshness_note =
        "ahead/behind come from cached remote-tracking refs — see upstream_ref_age_seconds. " +
        "Tag publication is not checked at all without a remote round-trip " +
        "(tags_checked_against_remote:false). Pass refresh:true for both.";
    }

    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  };
}

function selectForAction(reports: RepoReport[], args: GitFleetArgs): RepoReport[] {
  switch (args.action) {
    case "unpushed":
      return reports.filter((r) => r.ahead > 0 || r.local_only_tags.length > 0);
    case "behind":
      return reports.filter((r) => r.behind > 0);
    case "branches":
      return reports
        .filter((r) => args.include_clean || r.local_branches > 1 || r.worktrees > 1)
        .sort((a, b) => b.local_branches - a.local_branches);
    case "stale":
      return reports.filter(
        (r) => r.last_commit?.age_days !== null && (r.last_commit?.age_days ?? 0) >= args.stale_days
      );
    case "summary":
      return [];
    case "status":
    default:
      return args.include_clean ? reports : reports.filter((r) => !r.clean);
  }
}

function buildRecommendations(
  reports: RepoReport[],
  totals: Record<string, number>,
  args: GitFleetArgs
): string[] {
  const out: string[] = [];

  if (totals.errors) {
    out.push(`${totals.errors} repo(s) reported git errors — see the per-repo errors[].`);
  }
  if (totals.ahead) {
    const names = reports.filter((r) => r.ahead > 0).map((r) => r.name);
    out.push(`${totals.ahead} repo(s) have local-only commits: ${names.join(", ")}.`);
  }
  if (totals.local_only_tags) {
    const names = reports.filter((r) => r.local_only_tags.length > 0).map((r) => r.name);
    out.push(`${totals.local_only_tags} repo(s) hold unpublished tags: ${names.join(", ")}.`);
  } else if (!args.refresh && reports.some((r) => r.tags_total > 0)) {
    out.push(
      "Tag publication was not checked — that needs the remote. Pass refresh:true to verify."
    );
  }
  if (totals.behind) {
    out.push(`${totals.behind} repo(s) are behind upstream — review before committing.`);
  }
  if (totals.detached) {
    out.push(`${totals.detached} repo(s) are on a detached HEAD.`);
  }
  if (totals.dirty) {
    out.push(
      `${totals.dirty} repo(s) have uncommitted work. ` +
        `git_sherlock { action: "review_uncommitted", repo: "<name>", suggest_commits: true } drafts messages.`
    );
  }
  if (totals.stale) {
    out.push(`${totals.stale} repo(s) had no commit in ${args.stale_days} days.`);
  }
  if (!out.length) out.push("Fleet is clean: nothing dirty, unpushed, behind, or stale.");

  return out;
}

export const gitFleetTestHelpers = {
  gitFleetSchema,
  parsePorcelainV2,
  mapWithConcurrency,
  selectForAction,
  createGitFleetHandler,
};
