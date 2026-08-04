/**
 * Git Sherlock — ADR-0006, endurecida pela ADR-0062
 *
 * Forensics de git e inteligência de codebase:
 *   blame_heatmap      — que linhas/ficheiros mudam mais?
 *   what_changed       — resumo das mudanças num intervalo
 *   review_uncommitted — analisa o diff atual, sugere commits
 *   churn              — ficheiros mais churnados
 *   authors            — estatísticas de contribuição
 *   file_history       — histórico de um ficheiro
 *
 * A ADR-0062 corrigiu três defeitos estruturais desta tool:
 *
 *   B2 — `what_changed` e `churn` corriam com `shell: true` e interpolavam
 *        `--since="${since}"`. Agora tudo passa por argv, via runGit.
 *   B3 — nenhum comando definia cwd, portanto a tool analisava sempre o cwd
 *        do processo do servidor. Agora o repo é um parâmetro.
 *   —    todo comando terminava em `.catch(() => ({ stdout: "" }))`, o que
 *        tornava um repo em falta indistinguível de um repo limpo. Agora as
 *        falhas aparecem em `errors[]`.
 */

import { z } from "zod";
import type { ExtendedTool } from "../types/mcp-tool-extensions.js";
import { zodToMcpSchema } from "../utils/schema-converter.js";
import {
  createGitOpsContext,
  resolveRepo,
  runGit,
  toGitError,
  RepoResolutionError,
  type GitOpsContext,
  type GitResult,
  type ResolvedRepo,
} from "./git/exec.js";
import {
  COMMIT_LOG_FORMAT,
  parseCommits,
  type ParsedCommit,
} from "./git/conventional.js";

// ─── Schema ──────────────────────────────────────────────────────────────────

/**
 * Mesmo sem shell, um valor que começa por "-" seria lido pelo git como flag.
 * `--since` a valer `--upload-pack=evil` não é uma data.
 */
const notAFlag = (field: string) =>
  z
    .string()
    .refine((v) => !v.startsWith("-"), {
      message: `${field} must not start with "-" (it would be parsed as a git flag)`,
    });

export const gitSherlockSchema = z.object({
  action: z
    .enum([
      "blame_heatmap",
      "what_changed",
      "review_uncommitted",
      "churn",
      "authors",
      "file_history",
      // ADR-0062
      "branch_inventory",
      "divergence",
      "release_readiness",
      "commit_lint",
      "regression_range",
    ])
    .describe("What to analyze"),
  repo: z
    .string()
    .optional()
    .describe(
      "Ecosystem repo name (e.g. 'neoland') or an absolute path. " +
        "Defaults to the active profile, then PROJECT_ROOT, then the server cwd."
    ),
  path: notAFlag("path").optional().describe("Target file or directory"),
  since: notAFlag("since").optional().describe("e.g. '3 days ago', '1 week ago'"),
  until: notAFlag("until").optional().describe("End of the time range"),
  group_by: z.enum(["file", "author", "day"]).optional().default("file"),
  format: z.enum(["summary", "detailed"]).optional().default("summary"),
  suggest_commits: z
    .boolean()
    .optional()
    .default(false)
    .describe("Generate commit message suggestions for uncommitted changes"),
  top_n: z.number().int().min(1).max(50).optional().default(10),
  max_commits: z.number().int().min(1).max(100).optional().default(20),
  timeout_ms: z.number().int().min(1000).max(60000).optional().default(15000),

  // ── ADR-0062 ────────────────────────────────────────────────────────────
  base: notAFlag("base")
    .optional()
    .describe("divergence: ref to compare HEAD against. Defaults to the repo's default branch."),
  good: notAFlag("good")
    .optional()
    .describe("regression_range: last known-good ref (tag or commit)"),
  since_tag: notAFlag("since_tag")
    .optional()
    .describe("release_readiness: base tag. Defaults to `git describe --tags --abbrev=0`."),
  include_merged: z
    .boolean()
    .optional()
    .default(true)
    .describe("branch_inventory: flag which branches are already merged into the default branch"),
});

export type GitSherlockArgs = z.infer<typeof gitSherlockSchema>;

// ─── Tool definition ──────────────────────────────────────────────────────────

export const gitSherlockTool: ExtendedTool = {
  name: "git_sherlock",
  description:
    "Git forensics: heatmaps, churn analysis, change summaries, uncommitted review with " +
    "commit suggestions, author stats, and file history. Targets any ecosystem repo via " +
    "`repo` (ADR-0006, ADR-0062).",
  inputSchema: zodToMcpSchema(gitSherlockSchema),
  defer_loading: true,
  priority: "normal",
  execution_class: "diagnostic",
  cost_tier: "moderate",
  volatile: true,
};

// ─── Handler ─────────────────────────────────────────────────────────────────

interface ToolText {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function ok(payload: unknown): ToolText {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function fail(payload: unknown): ToolText {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: true };
}

/** Metadados do repo em toda resposta: o alvo nunca é implícito. */
function repoMeta(repo: ResolvedRepo) {
  return { repo: repo.name, repo_path: repo.path, repo_source: repo.source };
}

export function createGitSherlockHandler(ctx: GitOpsContext) {
  return async function handle(rawArgs: unknown): Promise<ToolText> {
    let args: GitSherlockArgs;
    try {
      args = gitSherlockSchema.parse(rawArgs ?? {});
    } catch (err) {
      return fail({
        error: "invalid_arguments",
        detail: err instanceof z.ZodError ? err.issues : String(err),
      });
    }

    let repo: ResolvedRepo;
    try {
      repo = await resolveRepo(args.repo, ctx);
    } catch (err) {
      if (err instanceof RepoResolutionError) {
        return fail({ error: err.code, detail: err.message, requested: args.repo ?? null });
      }
      return fail({ error: "repo_resolution_failed", detail: String(err) });
    }

    const opts = { timeoutMs: args.timeout_ms };

    try {
      switch (args.action) {
        case "blame_heatmap":
          return await blameHeatmap(repo, args, ctx, opts);
        case "what_changed":
          return await whatChanged(repo, args, ctx, opts);
        case "review_uncommitted":
          return await reviewUncommitted(repo, args, ctx, opts);
        case "churn":
          return await churnAnalysis(repo, args, ctx, opts);
        case "authors":
          return await authorStats(repo, ctx, opts);
        case "file_history":
          return await fileHistory(repo, args, ctx, opts);
        case "branch_inventory":
          return await branchInventory(repo, args, ctx, opts);
        case "divergence":
          return await divergence(repo, args, ctx, opts);
        case "release_readiness":
          return await releaseReadiness(repo, args, ctx, opts);
        case "commit_lint":
          return await commitLint(repo, args, ctx, opts);
        case "regression_range":
          return await regressionRange(repo, args, ctx, opts);
        default:
          return fail({ error: `Unknown action: ${(args as GitSherlockArgs).action}` });
      }
    } catch (err) {
      return fail({
        error: "action_failed",
        action: args.action,
        detail: err instanceof Error ? err.message : String(err),
        ...repoMeta(repo),
      });
    }
  };
}

/** Instância default usada pelo dispatcher. */
export const handleGitSherlock = createGitSherlockHandler(createGitOpsContext());

// ─── Actions ─────────────────────────────────────────────────────────────────

type RunOpts = { timeoutMs?: number };

async function blameHeatmap(
  repo: ResolvedRepo,
  args: GitSherlockArgs,
  ctx: GitOpsContext,
  opts: RunOpts
): Promise<ToolText> {
  const errors: ReturnType<typeof toGitError>[] = [];
  const target = args.path || ".";

  const listed = await runGit(repo, ["ls-files", "--", target], ctx, opts);
  if (!listed.ok) {
    return fail({
      ...repoMeta(repo),
      error: "ls_files_failed",
      errors: [toGitError("ls-files", listed)],
    });
  }

  const fileList = listed.stdout.split("\n").filter(Boolean).slice(0, 100);
  const fileChanges: Record<string, { lines: number; authors: string[] }> = {};
  const authorLines: Record<string, number> = {};

  // Amostra: os primeiros 20 ficheiros. Blame é caro e o objetivo é o
  // panorama, não o censo.
  for (const file of fileList.slice(0, 20)) {
    const blame = await runGit(repo, ["blame", "--line-porcelain", "--", file], ctx, opts);
    if (!blame.ok) {
      errors.push(toGitError(`blame ${file}`, blame));
      continue;
    }

    const authorsHere = new Set<string>();
    let lines = 0;

    for (const line of blame.stdout.split("\n")) {
      if (line.startsWith("author ")) {
        const author = line.slice(7);
        authorLines[author] = (authorLines[author] || 0) + 1;
        authorsHere.add(author);
        lines++;
      }
    }

    if (lines > 0) {
      fileChanges[file] = { lines, authors: [...authorsHere].sort() };
    }
  }

  const topFiles = Object.entries(fileChanges)
    .sort((a, b) => b[1].lines - a[1].lines)
    .slice(0, args.top_n)
    .map(([file, data]) => ({ file, lines: data.lines, authors: data.authors }));

  const topAuthors = Object.entries(authorLines)
    .sort((a, b) => b[1] - a[1])
    .slice(0, args.top_n)
    .map(([author, count]) => ({ author, lines: count }));

  return ok({
    ...repoMeta(repo),
    files_tracked: fileList.length,
    files_blamed: Object.keys(fileChanges).length,
    top_files: topFiles,
    top_authors: topAuthors,
    note: "Based on git blame — attribution is to whoever last touched each line",
    errors,
  });
}

async function whatChanged(
  repo: ResolvedRepo,
  args: GitSherlockArgs,
  ctx: GitOpsContext,
  opts: RunOpts
): Promise<ToolText> {
  const since = args.since || "1 week ago";
  const errors: ReturnType<typeof toGitError>[] = [];

  // B2: `--since=<valor>` é UM elemento de argv. Sem shell, sem aspas, sem
  // interpolação — o valor nunca é reparseado por nada.
  const logArgs = ["log", `--since=${since}`, "--oneline", "--stat"];
  if (args.until) logArgs.push(`--until=${args.until}`);

  const log = await runGit(repo, logArgs, ctx, opts);
  if (!log.ok) {
    return fail({ ...repoMeta(repo), error: "log_failed", errors: [toGitError("log", log)] });
  }

  const fileMap: Record<string, number> = {};
  let totalCommits = 0;

  for (const block of log.stdout.split("\n\n").filter(Boolean)) {
    const lines = block.split("\n");
    if (!lines[0] || !/^[0-9a-f]{7,}/.test(lines[0])) continue;
    totalCommits++;
    for (const line of lines.slice(1)) {
      const match = line.match(/^\s+(.+?)\s+\|\s+(\d+)/);
      if (match) fileMap[match[1]] = (fileMap[match[1]] || 0) + parseInt(match[2], 10);
    }
  }

  const authorMap: Record<string, number> = {};
  const shortlogArgs = ["shortlog", "-sn", `--since=${since}`];
  if (args.until) shortlogArgs.push(`--until=${args.until}`);

  const shortlog = await runGit(repo, shortlogArgs, ctx, opts);
  if (shortlog.ok) {
    for (const line of shortlog.stdout.split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(.+)/);
      if (match) authorMap[match[2]] = parseInt(match[1], 10);
    }
  } else {
    errors.push(toGitError("shortlog", shortlog));
  }

  const topFiles = Object.entries(fileMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([file, changes]) => ({ file, changes }));

  return ok({
    ...repoMeta(repo),
    since,
    until: args.until || "now",
    total_commits: totalCommits,
    files_changed: Object.keys(fileMap).length,
    authors: authorMap,
    top_files: topFiles,
    errors,
  });
}

async function reviewUncommitted(
  repo: ResolvedRepo,
  args: GitSherlockArgs,
  ctx: GitOpsContext,
  opts: RunOpts
): Promise<ToolText> {
  const errors: ReturnType<typeof toGitError>[] = [];

  const [staged, unstaged, untracked] = await Promise.all([
    runGit(repo, ["diff", "--cached", "--stat"], ctx, opts),
    runGit(repo, ["diff", "--stat"], ctx, opts),
    runGit(repo, ["ls-files", "--others", "--exclude-standard"], ctx, opts),
  ]);

  for (const [step, result] of [
    ["diff --cached", staged],
    ["diff", unstaged],
    ["ls-files --others", untracked],
  ] as Array<[string, GitResult]>) {
    if (!result.ok) errors.push(toGitError(step, result));
  }

  const stagedLines = staged.stdout.split("\n").filter(Boolean);
  const unstagedLines = unstaged.stdout.split("\n").filter(Boolean);
  const untrackedFiles = untracked.stdout.split("\n").filter(Boolean);

  const categories: Record<string, string[]> = {};
  for (const line of [...stagedLines, ...unstagedLines]) {
    const match = line.match(/^\s*(.+?)\s+\|\s+(\d+)/);
    if (!match) continue;
    const file = match[1].trim();
    const ext = file.split(".").pop() || "";

    let category: string;
    if (file.includes("test") || file.includes(".test.")) category = "tests";
    else if (file.includes("docs/") || file.endsWith(".md")) category = "docs";
    else if (ext === "nix" || file.includes("flake.")) category = "nix";
    else if (ext === "ts" || ext === "tsx") category = "source";
    else category = "other";

    (categories[category] ||= []).push(file);
  }

  const result: Record<string, unknown> = {
    ...repoMeta(repo),
    staged: { count: stagedLines.filter((l) => l.includes("|")).length, files: stagedLines },
    unstaged: { count: unstagedLines.filter((l) => l.includes("|")).length, files: unstagedLines },
    untracked: { count: untrackedFiles.length, files: untrackedFiles.slice(0, 20) },
    categories: Object.fromEntries(Object.entries(categories).map(([k, v]) => [k, v.length])),
    errors,
  };

  if (args.suggest_commits) {
    const suggestions: string[] = [];
    for (const [category, files] of Object.entries(categories)) {
      if (!files.length) continue;
      const scope = category === "source" ? "code" : category;
      const sample = files.slice(0, 3).join(", ");
      const more = files.length > 3 ? ", ..." : "";
      const verb = category === "docs" ? "docs" : category === "tests" ? "test" : "feat";

      if (category === "nix") {
        suggestions.push(`fix(nix): update ${files.length} nix files (${sample}${more})`);
      } else if (category === "source" && files.some((f) => f.includes("tools/"))) {
        suggestions.push(`feat(tools): add/update ${files.length} tool implementations`);
      } else {
        suggestions.push(`${verb}(${scope}): update ${files.length} files (${sample}${more})`);
      }
    }
    result.suggested_commits = suggestions;
    result.note = "Suggestions only — git_workbench performs the commit, and only on confirm.";
  }

  if (args.format === "detailed") {
    result.diff_summary = unstaged.stdout;
    result.staged_summary = staged.stdout;
  }

  return errors.length ? fail(result) : ok(result);
}

async function churnAnalysis(
  repo: ResolvedRepo,
  args: GitSherlockArgs,
  ctx: GitOpsContext,
  opts: RunOpts
): Promise<ToolText> {
  const since = args.since || "1 month ago";

  // B2: idem what_changed — argv, não shell.
  const log = await runGit(
    repo,
    ["log", `--since=${since}`, "--format=format:", "--name-only"],
    ctx,
    opts
  );

  if (!log.ok) {
    return fail({ ...repoMeta(repo), error: "log_failed", errors: [toGitError("log", log)] });
  }

  const fileCount: Record<string, number> = {};
  for (const raw of log.stdout.split("\n")) {
    const file = raw.trim();
    if (file) fileCount[file] = (fileCount[file] || 0) + 1;
  }

  const top = Object.entries(fileCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, args.top_n)
    .map(([file, commits]) => ({ file, commits }));

  return ok({
    ...repoMeta(repo),
    since,
    total_files: Object.keys(fileCount).length,
    top_churn: top,
    errors: [],
  });
}

async function authorStats(
  repo: ResolvedRepo,
  ctx: GitOpsContext,
  opts: RunOpts
): Promise<ToolText> {
  const errors: ReturnType<typeof toGitError>[] = [];

  const [shortlog, first, last] = await Promise.all([
    runGit(repo, ["shortlog", "-sne", "--all"], ctx, opts),
    runGit(repo, ["log", "--reverse", "--format=%aI", "--max-count=1"], ctx, opts),
    runGit(repo, ["log", "--format=%aI", "--max-count=1"], ctx, opts),
  ]);

  if (!shortlog.ok) {
    return fail({
      ...repoMeta(repo),
      error: "shortlog_failed",
      errors: [toGitError("shortlog", shortlog)],
    });
  }
  if (!first.ok) errors.push(toGitError("first commit", first));
  if (!last.ok) errors.push(toGitError("last commit", last));

  const authors = shortlog.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(.+?)\s*<(.+?)>/);
      return match
        ? { commits: parseInt(match[1], 10), name: match[2], email: match[3] }
        : { commits: 0, name: line.trim(), email: "" };
    });

  return ok({
    ...repoMeta(repo),
    total_authors: authors.length,
    total_commits: authors.reduce((sum, a) => sum + a.commits, 0),
    first_commit: first.stdout.trim() || null,
    last_commit: last.stdout.trim() || null,
    authors,
    errors,
  });
}

async function fileHistory(
  repo: ResolvedRepo,
  args: GitSherlockArgs,
  ctx: GitOpsContext,
  opts: RunOpts
): Promise<ToolText> {
  if (!args.path) {
    return fail({ ...repoMeta(repo), error: "path is required for file_history" });
  }

  // \x1f separa campos e \x1e separa registos: ambos são de controlo e não
  // aparecem em mensagens de commit. O separador "|" original partia qualquer
  // subject que contivesse um pipe.
  const log = await runGit(
    repo,
    [
      "log",
      "--follow",
      `--max-count=${args.max_commits}`,
      "--format=%H%x1f%h%x1f%aI%x1f%an%x1f%s%x1e",
      "--",
      args.path,
    ],
    ctx,
    opts
  );

  if (!log.ok) {
    return fail({
      ...repoMeta(repo),
      file: args.path,
      error: "log_failed",
      errors: [toGitError("log --follow", log)],
    });
  }

  const commits = log.stdout
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const [hash, short, date, author, subject] = record.split("\x1f");
      return { hash, short, date, author, subject };
    });

  return ok({
    ...repoMeta(repo),
    file: args.path,
    total_commits_shown: commits.length,
    commits,
    errors: [],
  });
}

// ─── Actions — ADR-0062 ──────────────────────────────────────────────────────

/**
 * Branch default do repo. Tenta o HEAD do remote, depois nomes convencionais.
 * Devolve null se nada casar — quem chama decide se isso é fatal.
 */
export async function detectDefaultBranch(
  repo: ResolvedRepo,
  ctx: GitOpsContext,
  opts: RunOpts
): Promise<string | null> {
  const originHead = await runGit(
    repo,
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    ctx,
    opts
  );
  if (originHead.ok && originHead.stdout.trim()) {
    return originHead.stdout.trim().replace(/^origin\//, "");
  }

  for (const candidate of ["main", "master", "develop"]) {
    const exists = await runGit(
      repo,
      ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`],
      ctx,
      opts
    );
    if (exists.ok) return candidate;
  }
  return null;
}

const BRANCH_FORMAT =
  "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track)%09" +
  "%(committerdate:iso8601)%09%(objectname:short)%09%(contents:subject)";

async function branchInventory(
  repo: ResolvedRepo,
  args: GitSherlockArgs,
  ctx: GitOpsContext,
  opts: RunOpts
): Promise<ToolText> {
  const errors: ReturnType<typeof toGitError>[] = [];

  // Uma chamada só: for-each-ref formata tudo, sem loop por branch.
  const refs = await runGit(repo, ["for-each-ref", BRANCH_FORMAT, "refs/heads/"], ctx, opts);
  if (!refs.ok) {
    return fail({
      ...repoMeta(repo),
      error: "for_each_ref_failed",
      errors: [toGitError("for-each-ref", refs)],
    });
  }

  const defaultBranch = await detectDefaultBranch(repo, ctx, opts);

  let mergedSet = new Set<string>();
  if (args.include_merged && defaultBranch) {
    const merged = await runGit(
      repo,
      ["branch", "--format=%(refname:short)", "--merged", defaultBranch],
      ctx,
      opts
    );
    if (merged.ok) {
      mergedSet = new Set(merged.stdout.split("\n").map((l) => l.trim()).filter(Boolean));
    } else {
      errors.push(toGitError("branch --merged", merged));
    }
  }

  const now = ctx.now().getTime();
  const branches = refs.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, upstream, track, date, hash, subject] = line.split("\t");
      const ageDays = date ? Math.floor((now - new Date(date).getTime()) / 86_400_000) : null;
      // `track` vem como "[ahead 2, behind 1]", "[gone]" ou vazio.
      const ahead = /ahead (\d+)/.exec(track || "");
      const behind = /behind (\d+)/.exec(track || "");
      return {
        branch: name,
        upstream: upstream || null,
        upstream_gone: /\[gone\]/.test(track || ""),
        ahead: ahead ? parseInt(ahead[1], 10) : 0,
        behind: behind ? parseInt(behind[1], 10) : 0,
        last_commit: hash,
        last_commit_date: date,
        age_days: ageDays,
        subject,
        merged: mergedSet.has(name),
        is_default: name === defaultBranch,
      };
    })
    .sort((a, b) => (a.age_days ?? 0) - (b.age_days ?? 0));

  const deletable = branches.filter((b) => b.merged && !b.is_default).map((b) => b.branch);

  return ok({
    ...repoMeta(repo),
    default_branch: defaultBranch,
    total_branches: branches.length,
    branches,
    merged_into_default: deletable,
    hint: deletable.length
      ? `git_workbench { action: "branch_delete_merged", repo: "${repo.name}" } would remove ${deletable.length} branch(es), using -d only.`
      : "No merged branches to clean up.",
    errors,
  });
}

async function divergence(
  repo: ResolvedRepo,
  args: GitSherlockArgs,
  ctx: GitOpsContext,
  opts: RunOpts
): Promise<ToolText> {
  const errors: ReturnType<typeof toGitError>[] = [];
  const defaultBranch = await detectDefaultBranch(repo, ctx, opts);
  const base = args.base || defaultBranch;

  if (!base) {
    return fail({
      ...repoMeta(repo),
      error: "no_base_ref",
      detail: "Could not detect a default branch; pass `base` explicitly.",
    });
  }

  const current = await runGit(repo, ["rev-parse", "--abbrev-ref", "HEAD"], ctx, opts);
  const counts = await runGit(
    repo,
    ["rev-list", "--left-right", "--count", `${base}...HEAD`],
    ctx,
    opts
  );

  if (!counts.ok) {
    return fail({
      ...repoMeta(repo),
      base,
      error: "rev_list_failed",
      errors: [toGitError("rev-list", counts)],
    });
  }

  // "<behind>\t<ahead>": o lado esquerdo é o base, o direito é HEAD.
  const [behindRaw, aheadRaw] = counts.stdout.trim().split(/\s+/);
  const behind = parseInt(behindRaw || "0", 10);
  const ahead = parseInt(aheadRaw || "0", 10);

  const mergeBase = await runGit(repo, ["merge-base", base, "HEAD"], ctx, opts);
  if (!mergeBase.ok) errors.push(toGitError("merge-base", mergeBase));

  const upstream = await runGit(
    repo,
    ["rev-list", "--left-right", "--count", "@{u}...HEAD"],
    ctx,
    opts
  );
  let upstreamState: { ahead: number; behind: number } | null = null;
  if (upstream.ok) {
    const [ub, ua] = upstream.stdout.trim().split(/\s+/);
    upstreamState = { behind: parseInt(ub || "0", 10), ahead: parseInt(ua || "0", 10) };
  }

  const verdict =
    ahead === 0 && behind === 0
      ? "in_sync"
      : behind > 0 && ahead > 0
        ? "diverged"
        : behind > 0
          ? "behind"
          : "ahead";

  return ok({
    ...repoMeta(repo),
    branch: current.ok ? current.stdout.trim() : null,
    base,
    base_source: args.base ? "explicit" : "detected_default",
    ahead,
    behind,
    verdict,
    merge_base: mergeBase.ok ? mergeBase.stdout.trim() : null,
    upstream: upstreamState,
    upstream_note: upstreamState
      ? "Counts come from cached remote-tracking refs; run git_fleet with refresh:true to update them."
      : "No upstream configured for the current branch.",
    errors,
  });
}

/** Resolve a tag base e os commits desde ela. Partilhado com git_release. */
export async function collectSinceTag(
  repo: ResolvedRepo,
  ctx: GitOpsContext,
  opts: RunOpts,
  sinceTag?: string,
  maxCommits = 200
): Promise<{
  tag: string | null;
  range: string;
  commits: ParsedCommit[];
  errors: ReturnType<typeof toGitError>[];
}> {
  const errors: ReturnType<typeof toGitError>[] = [];
  let tag = sinceTag ?? null;

  if (!tag) {
    const described = await runGit(repo, ["describe", "--tags", "--abbrev=0"], ctx, opts);
    // Sem tags é um estado legítimo (repo pré-primeiro-release), não um erro.
    if (described.ok && described.stdout.trim()) tag = described.stdout.trim();
  }

  const range = tag ? `${tag}..HEAD` : "HEAD";
  const logArgs = ["log", `--max-count=${maxCommits}`, COMMIT_LOG_FORMAT];
  if (tag) logArgs.push(range);

  const log = await runGit(repo, logArgs, ctx, opts);
  if (!log.ok) {
    errors.push(toGitError("log", log));
    return { tag, range, commits: [], errors };
  }

  return { tag, range, commits: parseCommits(log.stdout), errors };
}

async function releaseReadiness(
  repo: ResolvedRepo,
  args: GitSherlockArgs,
  ctx: GitOpsContext,
  opts: RunOpts
): Promise<ToolText> {
  const { tag, range, commits, errors } = await collectSinceTag(
    repo,
    ctx,
    opts,
    args.since_tag,
    100
  );

  const status = await runGit(repo, ["status", "--porcelain"], ctx, opts);
  if (!status.ok) errors.push(toGitError("status", status));

  const dirty = status.ok ? status.stdout.split("\n").filter(Boolean).length : null;
  const violations = commits.filter((c) => c.violations.length > 0);
  const breaking = commits.filter((c) => c.breaking);

  const blockers: string[] = [];
  if (dirty) blockers.push(`${dirty} uncommitted change(s) in the working tree`);
  if (commits.length === 0) blockers.push(`no commits since ${tag ?? "the beginning of history"}`);
  if (violations.length) {
    blockers.push(`${violations.length} commit(s) do not follow conventional commits`);
  }

  return ok({
    ...repoMeta(repo),
    last_tag: tag,
    range,
    commits_since_tag: commits.length,
    uncommitted_files: dirty,
    breaking_changes: breaking.map((c) => ({ short: c.short, subject: c.subject })),
    unconventional_commits: violations.map((c) => ({
      short: c.short,
      subject: c.subject,
      violations: c.violations,
    })),
    verdict: blockers.length === 0 ? "ready" : "blocked",
    blockers,
    next_step: `git_release { action: "next_version", repo: "${repo.name}" } proposes the version bump.`,
    errors,
  });
}

async function commitLint(
  repo: ResolvedRepo,
  args: GitSherlockArgs,
  ctx: GitOpsContext,
  opts: RunOpts
): Promise<ToolText> {
  const log = await runGit(
    repo,
    ["log", `--max-count=${args.max_commits}`, COMMIT_LOG_FORMAT],
    ctx,
    opts
  );

  if (!log.ok) {
    return fail({ ...repoMeta(repo), error: "log_failed", errors: [toGitError("log", log)] });
  }

  const commits = parseCommits(log.stdout);
  const offenders = commits.filter((c) => c.violations.length > 0);
  const byType: Record<string, number> = {};
  for (const commit of commits) {
    const key = commit.type ?? "(none)";
    byType[key] = (byType[key] || 0) + 1;
  }

  return ok({
    ...repoMeta(repo),
    inspected: commits.length,
    conforming: commits.length - offenders.length,
    violating: offenders.length,
    compliance_rate:
      commits.length === 0
        ? null
        : Math.round(((commits.length - offenders.length) / commits.length) * 100) / 100,
    by_type: byType,
    offenders: offenders.map((c) => ({
      short: c.short,
      subject: c.subject,
      violations: c.violations,
    })),
    errors: [],
  });
}

async function regressionRange(
  repo: ResolvedRepo,
  args: GitSherlockArgs,
  ctx: GitOpsContext,
  opts: RunOpts
): Promise<ToolText> {
  if (!args.good) {
    return fail({
      ...repoMeta(repo),
      error: "good is required for regression_range",
      detail: "Pass the last known-good ref (a tag or commit) as `good`.",
    });
  }

  const logArgs = [
    "log",
    `--max-count=${args.max_commits}`,
    COMMIT_LOG_FORMAT,
    `${args.good}..HEAD`,
  ];
  if (args.path) logArgs.push("--", args.path);

  const log = await runGit(repo, logArgs, ctx, opts);
  if (!log.ok) {
    return fail({
      ...repoMeta(repo),
      good: args.good,
      error: "log_failed",
      errors: [toGitError("log", log)],
    });
  }

  const commits = parseCommits(log.stdout);
  const scoped = args.path ? ` -- ${args.path}` : "";

  return ok({
    ...repoMeta(repo),
    good: args.good,
    path: args.path ?? null,
    candidates: commits.length,
    // Ordem cronológica: o primeiro suspeito é o mais antigo depois do bom.
    commits: commits
      .slice()
      .reverse()
      .map((c) => ({ short: c.short, date: c.date, author: c.author, subject: c.subject })),
    estimated_bisect_steps:
      commits.length > 0 ? Math.ceil(Math.log2(commits.length + 1)) : 0,
    // bisect muta HEAD, por isso esta tool nunca o corre — devolve o guião.
    bisect_script: [
      `cd ${repo.path}`,
      `git bisect start HEAD ${args.good}${scoped}`,
      `# then, at each step:`,
      `#   git bisect good   |   git bisect bad`,
      `git bisect reset`,
    ].join("\n"),
    note: "git_sherlock never runs bisect — it mutates HEAD. The script above is for you to run.",
    errors: [],
  });
}

// ─── Exposto para testes ─────────────────────────────────────────────────────

export const gitSherlockTestHelpers = {
  gitSherlockSchema,
  createGitSherlockHandler,
  detectDefaultBranch,
  collectSinceTag,
};
