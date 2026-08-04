/**
 * git_release — ADR-0062
 *
 * Responde a "posso lançar?" — a pergunta da Wave 1 do delivery compass, cujo
 * gate é "ship on tag + changelog".
 *
 * Read-only por construção. Criar a tag não acontece aqui: `tag_plan` devolve
 * a invocação exata de git_workbench que a criaria. Um único caminho de
 * escrita significa um único caminho de auditoria — se esta tool também
 * pudesse escrever, haveria duas políticas para manter em sincronia.
 *
 * O acesso ao GitHub é `gh` de leitura, filtrado por guardGhArgv: view, list,
 * checks, diff, status. Nunca `pr create` nem `pr merge`.
 */

import { z } from "zod";
import type { ExtendedTool } from "../../types/mcp-tool-extensions.js";
import { zodToMcpSchema } from "../../utils/schema-converter.js";
import {
  resolveRepo,
  runGit,
  toGitError,
  gitOk,
  gitFail,
  RepoResolutionError,
  type GitOpsContext,
  type GitToolResult,
  type ResolvedRepo,
} from "./exec.js";
import { guardGhArgv } from "./guard.js";
import {
  COMMIT_LOG_FORMAT,
  parseCommits,
  parseVersion,
  formatVersion,
  computeBump,
  applyBump,
  buildChangelog,
  renderChangelogMarkdown,
  type ParsedCommit,
} from "./conventional.js";

// ─── Schema ──────────────────────────────────────────────────────────────────

export const gitReleaseSchema = z.object({
  action: z
    .enum(["readiness", "changelog", "next_version", "pr_status", "tag_plan"])
    .optional()
    .default("readiness")
    .describe(
      "readiness: composite ship gate | changelog: grouped conventional commits | " +
        "next_version: proposed semver bump | pr_status: read-only GitHub PR state | " +
        "tag_plan: the exact git_workbench call that would create the tag"
    ),
  repo: z.string().optional(),
  since_tag: z
    .string()
    .optional()
    .refine((v) => v === undefined || !v.startsWith("-"), {
      message: "since_tag must not start with '-'",
    })
    .describe("Base tag. Defaults to `git describe --tags --abbrev=0`."),
  zero_major_policy: z
    .boolean()
    .optional()
    .default(true)
    .describe("While the version is below 1.0.0, treat breaking changes as a minor bump"),
  include_pr: z
    .boolean()
    .optional()
    .default(false)
    .describe("readiness: also query GitHub with read-only `gh pr` calls"),
  pr: z
    .union([z.number().int().positive(), z.string()])
    .optional()
    .describe("PR number or branch. Defaults to the current branch."),
  format: z.enum(["json", "markdown"]).optional().default("json"),
  max_commits: z.number().int().min(1).max(500).optional().default(200),
  timeout_ms: z.number().int().min(1000).max(60000).optional().default(20000),
});

export type GitReleaseArgs = z.infer<typeof gitReleaseSchema>;

export const gitReleaseTool: ExtendedTool = {
  name: "git_release",
  description:
    "Release readiness for a repo: ship gate, conventional-commit changelog, proposed semver " +
    "bump, and read-only GitHub PR status. Tag creation is delegated to git_workbench " +
    "(ADR-0062).",
  inputSchema: zodToMcpSchema(gitReleaseSchema),
  defer_loading: true,
  priority: "normal",
  execution_class: "diagnostic",
  cost_tier: "cheap",
  volatile: true,
};

// ─── Recolha ─────────────────────────────────────────────────────────────────

interface ReleaseContext {
  tag: string | null;
  range: string;
  commits: ParsedCommit[];
  errors: ReturnType<typeof toGitError>[];
}

async function collect(
  repo: ResolvedRepo,
  args: GitReleaseArgs,
  ctx: GitOpsContext,
  opts: { timeoutMs: number }
): Promise<ReleaseContext> {
  const errors: ReturnType<typeof toGitError>[] = [];
  let tag = args.since_tag ?? null;

  if (!tag) {
    const described = await runGit(repo, ["describe", "--tags", "--abbrev=0"], ctx, opts);
    // Um repo sem tags é um estado legítimo (pré-primeiro-release), não erro.
    if (described.ok && described.stdout.trim()) tag = described.stdout.trim();
  }

  const range = tag ? `${tag}..HEAD` : "HEAD";
  const logArgs = ["log", `--max-count=${args.max_commits}`, COMMIT_LOG_FORMAT];
  if (tag) logArgs.push(range);

  const log = await runGit(repo, logArgs, ctx, opts);
  if (!log.ok) {
    errors.push(toGitError("log", log));
    return { tag, range, commits: [], errors };
  }

  return { tag, range, commits: parseCommits(log.stdout), errors };
}

function proposeVersion(release: ReleaseContext, args: GitReleaseArgs) {
  const current = release.tag ? parseVersion(release.tag) : null;
  // Sem tag anterior (ou com uma tag não-semver) a base é 0.0.0: a proposta é
  // a primeira versão, não uma extrapolação de um formato desconhecido.
  const basis = current ?? { prefix: "v", major: 0, minor: 0, patch: 0, suffix: "" };

  const { bump, drivers } = computeBump(release.commits, {
    currentMajor: basis.major,
    zeroMajorPolicy: args.zero_major_policy,
  });

  const proposed = applyBump(basis, bump === "none" ? "patch" : bump);

  return {
    current_tag: release.tag,
    current_version: current ? formatVersion(current) : null,
    tag_is_semver: current !== null,
    bump,
    proposed_version: formatVersion(proposed),
    drivers,
    note:
      current === null && release.tag
        ? `"${release.tag}" is not semver; the proposal starts from 0.0.0.`
        : bump === "none"
          ? "No feat/fix/breaking commits since the last tag — a patch bump is proposed as a floor."
          : undefined,
  };
}

// ─── gh (leitura) ────────────────────────────────────────────────────────────

const PR_JSON_FIELDS =
  "number,title,state,isDraft,mergeable,mergeStateStatus,reviewDecision,url,headRefName";

async function fetchPrStatus(
  repo: ResolvedRepo,
  args: GitReleaseArgs,
  ctx: GitOpsContext,
  opts: { timeoutMs: number }
) {
  const selector = args.pr !== undefined ? String(args.pr) : null;
  const viewArgs = ["pr", "view"];
  if (selector) viewArgs.push(selector);
  viewArgs.push("--json", PR_JSON_FIELDS);

  const decision = guardGhArgv(viewArgs);
  if (!decision.allowed) {
    return {
      available: false,
      denied: { code: decision.code, offending: decision.offending, reason: decision.reason },
    };
  }

  const view = await ctx.run("gh", viewArgs, { cwd: repo.path, timeoutMs: opts.timeoutMs });
  if (view.exitCode !== 0) {
    return {
      available: false,
      detail: view.stderr.slice(-300) || "gh pr view failed (no PR for this branch, or not authenticated)",
    };
  }

  let pr: Record<string, unknown> | null = null;
  try {
    pr = JSON.parse(view.stdout);
  } catch {
    return { available: false, detail: "gh returned output that is not JSON" };
  }

  const checksArgs = ["pr", "checks"];
  if (selector) checksArgs.push(selector);
  checksArgs.push("--json", "name,state,link");

  let checks: unknown[] = [];
  let checksDetail: string | undefined;
  const checksDecision = guardGhArgv(checksArgs);
  if (checksDecision.allowed) {
    const run = await ctx.run("gh", checksArgs, { cwd: repo.path, timeoutMs: opts.timeoutMs });
    // `gh pr checks` sai com != 0 quando algum check falhou — isso é o
    // resultado, não uma falha da chamada.
    if (run.stdout.trim()) {
      try {
        checks = JSON.parse(run.stdout);
      } catch {
        checksDetail = "checks output was not JSON";
      }
    } else {
      checksDetail = run.stderr.slice(-200) || "no checks reported";
    }
  }

  const failing = (checks as Array<{ state?: string }>).filter(
    (c) => c.state && !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.state)
  );

  return {
    available: true,
    pr,
    checks,
    checks_detail: checksDetail,
    failing_checks: failing.length,
    read_only: "gh pr create/merge/close are denied by policy (ADR-0062).",
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export function createGitReleaseHandler(ctx: GitOpsContext) {
  return async function handle(rawArgs: unknown): Promise<GitToolResult> {
    let args: GitReleaseArgs;
    try {
      args = gitReleaseSchema.parse(rawArgs ?? {});
    } catch (err) {
      return gitFail({
        error: "invalid_arguments",
        detail: err instanceof z.ZodError ? err.issues : String(err),
      });
    }

    let repo: ResolvedRepo;
    try {
      repo = await resolveRepo(args.repo, ctx);
    } catch (err) {
      if (err instanceof RepoResolutionError) {
        return gitFail({ error: err.code, detail: err.message, requested: args.repo ?? null });
      }
      return gitFail({ error: "repo_resolution_failed", detail: String(err) });
    }

    const opts = { timeoutMs: args.timeout_ms };
    const meta = { repo: repo.name, repo_path: repo.path, action: args.action };

    // pr_status não precisa do histórico de commits.
    if (args.action === "pr_status") {
      return gitOk({ ...meta, ...(await fetchPrStatus(repo, args, ctx, opts)) });
    }

    const release = await collect(repo, args, ctx, opts);

    switch (args.action) {
      case "changelog": {
        const changelog = buildChangelog(release.commits);
        const heading = proposeVersion(release, args).proposed_version;
        const markdown = renderChangelogMarkdown(changelog, heading);

        // O markdown vai sempre: é o artefacto que o operador cola no release.
        // `format` escolhe se o detalhe estruturado o acompanha.
        if (args.format === "markdown") {
          return gitOk({
            ...meta,
            since_tag: release.tag,
            range: release.range,
            total_commits: changelog.total,
            changelog_markdown: markdown,
            errors: release.errors,
          });
        }

        return gitOk({
          ...meta,
          since_tag: release.tag,
          range: release.range,
          total_commits: changelog.total,
          sections: changelog.sections,
          breaking: changelog.breaking,
          unconventional: changelog.unconventional,
          changelog_markdown: markdown,
          errors: release.errors,
        });
      }

      case "next_version":
        return gitOk({
          ...meta,
          range: release.range,
          commits_since_tag: release.commits.length,
          ...proposeVersion(release, args),
          errors: release.errors,
        });

      case "tag_plan": {
        const version = proposeVersion(release, args);
        const changelog = buildChangelog(release.commits);
        const annotation = renderChangelogMarkdown(changelog, version.proposed_version);

        return gitOk({
          ...meta,
          ...version,
          // A escrita vive toda no git_workbench: uma política, uma auditoria.
          workbench_call: {
            tool: "git_workbench",
            arguments: {
              action: "tag_create",
              repo: repo.name,
              tag: version.proposed_version,
              tag_message: annotation,
              annotate: true,
              reason: `Release ${version.proposed_version}: ${version.bump} bump over ${release.tag ?? "the initial commit"}`,
              dry_run: true,
            },
          },
          next_step:
            "Review the plan, then re-issue the git_workbench call with dry_run:false and confirm:true.",
          note: "git_release never writes. Tag creation goes through git_workbench so it is guarded and audited.",
          errors: release.errors,
        });
      }

      case "readiness":
      default: {
        const errors = [...release.errors];

        const [status, divergence, branch] = await Promise.all([
          runGit(repo, ["status", "--porcelain"], ctx, opts),
          runGit(repo, ["rev-list", "--left-right", "--count", "@{u}...HEAD"], ctx, opts),
          runGit(repo, ["rev-parse", "--abbrev-ref", "HEAD"], ctx, opts),
        ]);

        if (!status.ok) errors.push(toGitError("status", status));

        const dirty = status.ok ? status.stdout.split("\n").filter(Boolean).length : null;

        let ahead = 0;
        let behind = 0;
        let hasUpstream = false;
        if (divergence.ok) {
          const [b, a] = divergence.stdout.trim().split(/\s+/);
          behind = parseInt(b || "0", 10);
          ahead = parseInt(a || "0", 10);
          hasUpstream = true;
        }

        const violations = release.commits.filter((c) => c.violations.length > 0);
        const version = proposeVersion(release, args);

        const blockers: string[] = [];
        const warnings: string[] = [];

        if (dirty) blockers.push(`${dirty} uncommitted change(s) in the working tree`);
        if (release.commits.length === 0) {
          blockers.push(`no commits since ${release.tag ?? "the beginning of history"}`);
        }
        if (violations.length) {
          blockers.push(
            `${violations.length} commit(s) do not follow conventional commits — the changelog would be incomplete`
          );
        }
        if (ahead > 0) warnings.push(`${ahead} commit(s) not pushed to the upstream`);
        if (behind > 0) blockers.push(`${behind} commit(s) behind the upstream — pull before tagging`);
        if (!hasUpstream) warnings.push("no upstream configured for the current branch");

        const payload: Record<string, unknown> = {
          ...meta,
          branch: branch.ok ? branch.stdout.trim() : null,
          last_tag: release.tag,
          range: release.range,
          commits_since_tag: release.commits.length,
          uncommitted_files: dirty,
          ahead,
          behind,
          unconventional_commits: violations.map((c) => ({
            short: c.short,
            subject: c.subject,
            violations: c.violations,
          })),
          breaking_changes: release.commits
            .filter((c) => c.breaking)
            .map((c) => ({ short: c.short, subject: c.subject })),
          proposed_version: version.proposed_version,
          bump: version.bump,
          verdict: blockers.length === 0 ? "ready" : "blocked",
          blockers,
          warnings,
          next_step:
            blockers.length === 0
              ? `git_release { action: "tag_plan", repo: "${repo.name}" } produces the tag command.`
              : "Clear the blockers above first.",
          errors,
        };

        if (args.include_pr) {
          payload.pr = await fetchPrStatus(repo, args, ctx, opts);
        }

        return gitOk(payload);
      }
    }
  };
}

export const gitReleaseTestHelpers = {
  gitReleaseSchema,
  proposeVersion,
  collect,
};
