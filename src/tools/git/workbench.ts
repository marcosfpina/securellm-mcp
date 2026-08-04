/**
 * git_workbench — ADR-0062
 *
 * A única tool do servidor que muta um repo. Todo o desenho serve uma coisa:
 * que nenhuma mutação aconteça por acidente.
 *
 *   - `dry_run` é true por default. Um chamador que não leia o schema planeia
 *     em vez de executar.
 *   - `confirm` tem de ser dado EM CONJUNTO com `dry_run: false`. Duas chaves
 *     independentes, porque uma só é fácil de acertar por engano.
 *   - `reason` é obrigatório e vai para o registo de auditoria.
 *   - Todo argv passa pelo guard antes de correr, mesmo os que esta tool
 *     construiu. A tool não é confiável só por ser a nossa.
 *
 * O plano devolvido em dry_run contém o argv exato que seria executado — o
 * operador revê comandos, não descrições deles.
 */

import { z } from "zod";
import type { ExtendedTool } from "../../types/mcp-tool-extensions.js";
import { zodToMcpSchema } from "../../utils/schema-converter.js";
import {
  resolveRepo,
  runGit,
  toGitError,
  emitAudit,
  newAuditId,
  gitOk,
  gitFail,
  RepoResolutionError,
  type GitOpsContext,
  type GitToolResult,
  type ResolvedRepo,
} from "./exec.js";
import { guardGitArgv, type GuardDecision } from "./guard.js";
import { CONVENTIONAL_TYPES } from "./conventional.js";

// ─── Schema ──────────────────────────────────────────────────────────────────

const MUTATING_ACTIONS = new Set([
  "stage",
  "commit",
  "branch_create",
  "branch_switch",
  "branch_delete_merged",
  "tag_create",
  "stash_push",
  "stash_pop",
  "worktree_add",
  "worktree_remove",
]);

/** Nomes de ref: sem espaços, sem ~ ^ : ? * [ \, sem começar por dash. */
const refName = (field: string) =>
  z
    .string()
    .min(1)
    .max(120)
    .refine((v) => !v.startsWith("-") && !/[\s~^:?*[\\]/.test(v) && !v.includes(".."), {
      message: `${field} is not a valid git ref name`,
    });

export const gitWorkbenchSchema = z
  .object({
    action: z.enum([
      "stage",
      "commit",
      "branch_create",
      "branch_switch",
      "branch_delete_merged",
      "tag_create",
      "stash_push",
      "stash_pop",
      "stash_list",
      "worktree_add",
      "worktree_remove",
      "worktree_list",
    ]),
    repo: z
      .string()
      .optional()
      .describe("Ecosystem repo name or path. Defaults to the active profile, PROJECT_ROOT, cwd."),

    dry_run: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "SAFE DEFAULT. true = plan only, nothing runs. Set false AND confirm=true to execute."
      ),
    confirm: z
      .boolean()
      .optional()
      .default(false)
      .describe("Required together with dry_run=false. Without it nothing is executed."),
    reason: z
      .string()
      .min(3)
      .max(500)
      .optional()
      .describe("Why this change is being made. Required for mutating actions; audited."),

    // stage
    paths: z.array(z.string().min(1)).max(200).optional().describe("stage: paths to add"),
    all: z.boolean().optional().default(false).describe("stage: use -A instead of explicit paths"),

    // commit
    message: z.string().min(1).max(500).optional().describe("commit: subject (without the type prefix if `type` is given)"),
    body: z.string().max(5000).optional().describe("commit: message body"),
    type: z.enum(CONVENTIONAL_TYPES).optional().describe("commit: conventional commit type"),
    scope: z.string().max(40).optional().describe("commit: conventional commit scope"),
    stage_all_first: z.boolean().optional().default(false).describe("commit: run `add -A` before committing"),

    // branch
    branch: refName("branch").optional(),
    base: refName("base").optional().describe("branch_create: start point (default: current HEAD)"),
    protected_branches: z
      .array(z.string().min(1))
      .max(20)
      .optional()
      .default(["main", "master", "develop", "release"]),
    max_branches: z.number().int().min(1).max(50).optional().default(10),

    // tag
    tag: refName("tag").optional(),
    tag_message: z.string().max(1000).optional(),
    annotate: z.boolean().optional().default(true),

    // stash
    stash_message: z.string().max(200).optional(),
    include_untracked: z.boolean().optional().default(false),

    // worktree
    worktree_path: z.string().min(1).optional(),
    worktree_branch: refName("worktree_branch").optional(),

    timeout_ms: z.number().int().min(1000).max(60000).optional().default(20000),
  })
  .superRefine((value, ctx) => {
    if (MUTATING_ACTIONS.has(value.action) && !value.reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: `reason is required for "${value.action}" — it is recorded in the audit log`,
      });
    }

    const require = (field: keyof typeof value, actions: string[]) => {
      if (actions.includes(value.action) && value[field] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field as string],
          message: `${String(field)} is required for "${value.action}"`,
        });
      }
    };

    require("branch", ["branch_create", "branch_switch"]);
    require("tag", ["tag_create"]);
    require("worktree_path", ["worktree_add", "worktree_remove"]);

    if (value.action === "commit" && !value.message) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["message"],
        message: 'message is required for "commit"',
      });
    }
    if (value.action === "stage" && !value.all && !value.paths?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paths"],
        message: 'stage requires either `paths` or `all: true`',
      });
    }
    if (value.action === "tag_create" && value.annotate && !value.tag_message) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tag_message"],
        message: "an annotated tag requires tag_message (or set annotate:false)",
      });
    }
  });

export type GitWorkbenchArgs = z.infer<typeof gitWorkbenchSchema>;

export const gitWorkbenchTool: ExtendedTool = {
  name: "git_workbench",
  description:
    "Guarded local git writes: stage, commit, branch, tag, stash, worktree. Plans by default " +
    "(dry_run:true); executing requires dry_run:false AND confirm:true plus a reason. Push, " +
    "force, reset --hard, history rewrite and remote mutation are denied by policy (ADR-0062).",
  inputSchema: zodToMcpSchema(gitWorkbenchSchema),
  defer_loading: true,
  priority: "high",
  execution_class: "interactive",
  cost_tier: "cheap",
  volatile: true,
  input_examples: [
    {
      action: "commit",
      repo: "securellm-mcp",
      type: "feat",
      scope: "git",
      message: "add fleet survey",
      reason: "shipping ADR-0062 step 6",
    },
    {
      action: "commit",
      repo: "securellm-mcp",
      type: "feat",
      scope: "git",
      message: "add fleet survey",
      reason: "shipping ADR-0062 step 6",
      dry_run: false,
      confirm: true,
    },
  ],
};

// ─── Plano ───────────────────────────────────────────────────────────────────

interface PlanStep {
  argv: string[];
  description: string;
}

interface Plan {
  steps: PlanStep[];
  preflight: Record<string, unknown>;
  /** Motivo para não haver nada a fazer (ex.: nenhum branch merged). */
  noop?: string;
}

type Preflight = (
  repo: ResolvedRepo,
  args: GitWorkbenchArgs,
  ctx: GitOpsContext,
  opts: { timeoutMs: number }
) => Promise<Plan>;

/** `type(scope): message` quando `type` é dado; senão a message tal e qual. */
export function buildCommitSubject(args: GitWorkbenchArgs): string {
  if (!args.type) return args.message!;
  const scope = args.scope ? `(${args.scope})` : "";
  return `${args.type}${scope}: ${args.message}`;
}

const planners: Record<string, Preflight> = {
  async stage(repo, args, ctx, opts) {
    const status = await runGit(repo, ["status", "--porcelain"], ctx, opts);
    const changed = status.ok ? status.stdout.split("\n").filter(Boolean).length : null;

    const argv = args.all ? ["add", "-A"] : ["add", "--", ...(args.paths ?? [])];

    return {
      preflight: { branch: await currentBranch(repo, ctx, opts), changed_files: changed },
      steps: [
        {
          argv,
          description: args.all
            ? "Stage every change in the working tree"
            : `Stage ${args.paths?.length ?? 0} path(s)`,
        },
      ],
      noop: changed === 0 ? "Working tree is clean — nothing to stage." : undefined,
    };
  },

  async commit(repo, args, ctx, opts) {
    const [email, staged, gpg] = await Promise.all([
      runGit(repo, ["config", "--get", "user.email"], ctx, opts),
      runGit(repo, ["diff", "--cached", "--stat"], ctx, opts),
      runGit(repo, ["config", "--get", "commit.gpgsign"], ctx, opts),
    ]);

    const stagedCount = staged.ok ? staged.stdout.split("\n").filter((l) => l.includes("|")).length : 0;
    const gpgOn = gpg.ok && gpg.stdout.trim() === "true";

    const steps: PlanStep[] = [];
    if (args.stage_all_first) {
      steps.push({ argv: ["add", "-A"], description: "Stage every change first" });
    }

    const subject = buildCommitSubject(args);
    const argv = ["commit", "-m", subject];
    if (args.body) argv.push("-m", args.body);
    steps.push({ argv, description: `Commit as: ${subject}` });

    const warnings: string[] = [];
    if (!email.ok || !email.stdout.trim()) {
      warnings.push("user.email is not configured — git will refuse to commit");
    }
    if (gpgOn && !process.stdout.isTTY) {
      // Sem tty, um prompt de assinatura fica pendurado até ao timeout. Dizê-lo
      // à cabeça poupa 20 segundos de confusão.
      warnings.push("commit.gpgsign is true and there is no tty — signing may hang or fail");
    }

    return {
      preflight: {
        branch: await currentBranch(repo, ctx, opts),
        user_email: email.ok ? email.stdout.trim() || null : null,
        staged_files: stagedCount,
        gpg_sign: gpgOn,
        subject,
        warnings,
      },
      steps,
      noop:
        stagedCount === 0 && !args.stage_all_first
          ? "Nothing staged — stage first, or pass stage_all_first:true."
          : undefined,
    };
  },

  async branch_create(repo, args, ctx, opts) {
    const exists = await runGit(
      repo,
      ["show-ref", "--verify", "--quiet", `refs/heads/${args.branch}`],
      ctx,
      opts
    );
    const argv = ["branch", args.branch!];
    if (args.base) argv.push(args.base);

    return {
      preflight: { branch: await currentBranch(repo, ctx, opts), already_exists: exists.ok },
      steps: [{ argv, description: `Create branch ${args.branch}${args.base ? ` from ${args.base}` : ""}` }],
      noop: exists.ok ? `Branch "${args.branch}" already exists.` : undefined,
    };
  },

  async branch_switch(repo, args, ctx, opts) {
    const [exists, status] = await Promise.all([
      runGit(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${args.branch}`], ctx, opts),
      runGit(repo, ["status", "--porcelain"], ctx, opts),
    ]);
    const dirty = status.ok ? status.stdout.split("\n").filter(Boolean).length : 0;

    const argv = exists.ok ? ["switch", args.branch!] : ["switch", "-c", args.branch!];

    return {
      preflight: {
        branch: await currentBranch(repo, ctx, opts),
        target_exists: exists.ok,
        dirty_files: dirty,
        note: dirty
          ? "Uncommitted changes will be carried over; git refuses the switch if they conflict."
          : undefined,
      },
      steps: [
        {
          argv,
          description: exists.ok
            ? `Switch to existing branch ${args.branch}`
            : `Create and switch to ${args.branch}`,
        },
      ],
    };
  },

  async branch_delete_merged(repo, args, ctx, opts) {
    const defaultBranch = await detectDefault(repo, ctx, opts);
    if (!defaultBranch) {
      return {
        preflight: { default_branch: null },
        steps: [],
        noop: "Could not detect a default branch; refusing to guess which branches are merged.",
      };
    }

    const listed = await runGit(
      repo,
      ["branch", "--format=%(refname:short)", "--merged", defaultBranch],
      ctx,
      opts
    );
    const current = await currentBranch(repo, ctx, opts);
    const protectedSet = new Set(args.protected_branches);

    const candidates = listed.ok
      ? listed.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
      : [];

    const skipped: Array<{ branch: string; why: string }> = [];
    const eligible: string[] = [];

    for (const branch of candidates) {
      if (branch === defaultBranch) {
        skipped.push({ branch, why: "is the default branch" });
      } else if (protectedSet.has(branch)) {
        skipped.push({ branch, why: "is protected" });
      } else if (branch === current) {
        skipped.push({ branch, why: "is currently checked out" });
      } else {
        eligible.push(branch);
      }
    }

    // Confirmação dupla: `--merged` já filtrou, mas -d é a rede de segurança
    // final (o git recusa apagar um branch não-merged). Nunca -D.
    const verified: string[] = [];
    for (const branch of eligible.slice(0, args.max_branches)) {
      const ancestor = await runGit(
        repo,
        ["merge-base", "--is-ancestor", branch, defaultBranch],
        ctx,
        opts
      );
      if (ancestor.ok) verified.push(branch);
      else skipped.push({ branch, why: "merge-base says it is not an ancestor of the default branch" });
    }

    return {
      preflight: {
        default_branch: defaultBranch,
        current_branch: current,
        candidates: candidates.length,
        eligible: verified,
        skipped,
      },
      steps: verified.map((branch) => ({
        argv: ["branch", "-d", branch],
        description: `Delete merged branch ${branch} (safe delete: git refuses if unmerged)`,
      })),
      noop: verified.length === 0 ? "No merged branches are eligible for deletion." : undefined,
    };
  },

  async tag_create(repo, args, ctx, opts) {
    const [existing, latest] = await Promise.all([
      runGit(repo, ["tag", "-l", args.tag!], ctx, opts),
      runGit(repo, ["describe", "--tags", "--abbrev=0"], ctx, opts),
    ]);
    const exists = existing.ok && existing.stdout.trim() === args.tag;

    const argv = args.annotate
      ? ["tag", "-a", args.tag!, "-m", args.tag_message!]
      : ["tag", args.tag!];

    return {
      preflight: {
        branch: await currentBranch(repo, ctx, opts),
        already_exists: exists,
        previous_tag: latest.ok ? latest.stdout.trim() || null : null,
        annotated: args.annotate,
      },
      steps: [{ argv, description: `Create ${args.annotate ? "annotated " : ""}tag ${args.tag}` }],
      noop: exists
        ? `Tag "${args.tag}" already exists. Retagging requires --force, which is denied by policy.`
        : undefined,
    };
  },

  async stash_push(repo, args, ctx, opts) {
    const status = await runGit(repo, ["status", "--porcelain"], ctx, opts);
    const dirty = status.ok ? status.stdout.split("\n").filter(Boolean).length : 0;

    const argv = ["stash", "push"];
    if (args.include_untracked) argv.push("-u");
    if (args.stash_message) argv.push("-m", args.stash_message);

    return {
      preflight: { branch: await currentBranch(repo, ctx, opts), dirty_files: dirty },
      steps: [{ argv, description: "Stash the current working tree" }],
      noop: dirty === 0 ? "Working tree is clean — nothing to stash." : undefined,
    };
  },

  async stash_pop(repo, _args, ctx, opts) {
    const list = await runGit(repo, ["stash", "list"], ctx, opts);
    const entries = list.ok ? list.stdout.split("\n").filter(Boolean) : [];

    return {
      preflight: { stash_count: entries.length, top: entries[0] ?? null },
      steps: [{ argv: ["stash", "pop"], description: "Restore the most recent stash entry" }],
      noop: entries.length === 0 ? "The stash is empty." : undefined,
    };
  },

  async stash_list(repo, _args, ctx, opts) {
    const list = await runGit(repo, ["stash", "list"], ctx, opts);
    return {
      preflight: {
        entries: list.ok ? list.stdout.split("\n").filter(Boolean) : [],
        errors: list.ok ? [] : [toGitError("stash list", list)],
      },
      steps: [],
    };
  },

  async worktree_add(repo, args, ctx, opts) {
    const list = await runGit(repo, ["worktree", "list", "--porcelain"], ctx, opts);
    const existing = list.ok
      ? list.stdout.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9))
      : [];

    const argv = ["worktree", "add", args.worktree_path!];
    if (args.worktree_branch) argv.push(args.worktree_branch);

    return {
      preflight: { existing_worktrees: existing },
      steps: [{ argv, description: `Add a worktree at ${args.worktree_path}` }],
      noop: existing.includes(args.worktree_path!)
        ? `A worktree already exists at ${args.worktree_path}.`
        : undefined,
    };
  },

  async worktree_remove(repo, args, ctx, opts) {
    const list = await runGit(repo, ["worktree", "list", "--porcelain"], ctx, opts);
    const existing = list.ok
      ? list.stdout.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9))
      : [];
    const known = existing.includes(args.worktree_path!);

    return {
      preflight: { existing_worktrees: existing, known },
      steps: [
        {
          argv: ["worktree", "remove", args.worktree_path!],
          description: `Remove the worktree at ${args.worktree_path} ` +
            `(git refuses if it holds uncommitted work — --force is denied)`,
        },
      ],
      noop: known ? undefined : `No worktree is registered at ${args.worktree_path}.`,
    };
  },

  async worktree_list(repo, _args, ctx, opts) {
    const list = await runGit(repo, ["worktree", "list", "--porcelain"], ctx, opts);
    const worktrees: Array<Record<string, string>> = [];
    let current: Record<string, string> = {};

    for (const line of list.stdout.split("\n")) {
      if (!line.trim()) {
        if (Object.keys(current).length) worktrees.push(current);
        current = {};
        continue;
      }
      const [key, ...rest] = line.split(" ");
      current[key] = rest.join(" ");
    }
    if (Object.keys(current).length) worktrees.push(current);

    return {
      preflight: {
        worktrees,
        errors: list.ok ? [] : [toGitError("worktree list", list)],
      },
      steps: [],
    };
  },
};

async function currentBranch(
  repo: ResolvedRepo,
  ctx: GitOpsContext,
  opts: { timeoutMs: number }
): Promise<string | null> {
  const result = await runGit(repo, ["rev-parse", "--abbrev-ref", "HEAD"], ctx, opts);
  return result.ok ? result.stdout.trim() : null;
}

async function detectDefault(
  repo: ResolvedRepo,
  ctx: GitOpsContext,
  opts: { timeoutMs: number }
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

// ─── Handler ─────────────────────────────────────────────────────────────────

export function createGitWorkbenchHandler(ctx: GitOpsContext) {
  return async function handle(rawArgs: unknown): Promise<GitToolResult> {
    let args: GitWorkbenchArgs;
    try {
      args = gitWorkbenchSchema.parse(rawArgs ?? {});
    } catch (err) {
      return gitFail({
        error: "invalid_arguments",
        detail: err instanceof z.ZodError ? err.issues : String(err),
      });
    }

    const auditId = newAuditId();
    const mutating = MUTATING_ACTIONS.has(args.action);

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
    const base = {
      audit_id: auditId,
      repo: repo.name,
      repo_path: repo.path,
      action: args.action,
      reason: args.reason ?? null,
    };

    // ── Preflight (sempre read-only) ────────────────────────────────────
    let plan: Plan;
    try {
      plan = await planners[args.action](repo, args, ctx, opts);
    } catch (err) {
      return gitFail({
        ...base,
        status: "failed",
        error: "preflight_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    // ── Guard (antes de qualquer decisão de execução) ────────────────────
    const denials: Array<{ code: string; offending: string; reason: string; policy: string; argv: string[] }> = [];
    for (const step of plan.steps) {
      const decision: GuardDecision = guardGitArgv(step.argv, {
        repoRoot: repo.path,
        ecosystemRoot: ctx.ecosystemRoot,
      });
      if (!decision.allowed) {
        denials.push({
          code: decision.code,
          offending: decision.offending,
          reason: decision.reason,
          policy: decision.policy,
          argv: step.argv,
        });
      }
    }

    if (denials.length) {
      for (const denial of denials) {
        emitAudit(ctx, {
          audit_id: auditId,
          tool: "git_workbench",
          action: args.action,
          repo: repo.name,
          argv: denial.argv,
          mode: args.dry_run ? "dry_run" : "confirmed",
          status: "denied",
          denial: { code: denial.code as never, offending: denial.offending },
          reason: args.reason,
        });
      }
      return gitFail({
        ...base,
        status: "denied",
        denials,
        allowed_alternatives: alternativesFor(args.action),
      });
    }

    // Ações puramente informativas (stash_list, worktree_list) devolvem já.
    if (!mutating && plan.steps.length === 0) {
      return gitOk({ ...base, status: "ok", ...plan.preflight });
    }

    // ── Nada a fazer ────────────────────────────────────────────────────
    if (plan.noop) {
      return gitOk({
        ...base,
        status: "noop",
        preflight: plan.preflight,
        plan: plan.steps,
        detail: plan.noop,
      });
    }

    // ── dry_run: planear e parar ─────────────────────────────────────────
    if (args.dry_run) {
      for (const step of plan.steps) {
        emitAudit(ctx, {
          audit_id: auditId,
          tool: "git_workbench",
          action: args.action,
          repo: repo.name,
          argv: step.argv,
          mode: "dry_run",
          status: "planned",
          reason: args.reason,
        });
      }
      return gitOk({
        ...base,
        status: "planned",
        preflight: plan.preflight,
        plan: plan.steps,
        next_step: "Re-run with dry_run:false AND confirm:true to execute.",
      });
    }

    // ── dry_run:false sem confirm ────────────────────────────────────────
    if (!args.confirm) {
      for (const step of plan.steps) {
        emitAudit(ctx, {
          audit_id: auditId,
          tool: "git_workbench",
          action: args.action,
          repo: repo.name,
          argv: step.argv,
          mode: "confirmed",
          status: "planned",
          reason: args.reason,
        });
      }
      return gitOk({
        ...base,
        status: "confirmation_required",
        preflight: plan.preflight,
        plan: plan.steps,
        next_step: "Add confirm:true to execute the plan above. Nothing has been changed.",
      });
    }

    // ── Execução ─────────────────────────────────────────────────────────
    const executed: Array<Record<string, unknown>> = [];

    for (const step of plan.steps) {
      const result = await runGit(repo, step.argv, ctx, opts);

      emitAudit(ctx, {
        audit_id: auditId,
        tool: "git_workbench",
        action: args.action,
        repo: repo.name,
        argv: step.argv,
        mode: "confirmed",
        status: result.ok ? "executed" : "failed",
        exit_code: result.exit_code,
        reason: args.reason,
      });

      executed.push({
        argv: step.argv,
        description: step.description,
        exit_code: result.exit_code,
        ok: result.ok,
        stdout_tail: result.stdout.slice(-400),
        stderr_tail: result.stderr_tail,
      });

      // Parar à primeira falha: encadear escritas depois de um erro é como se
      // perdem repos.
      if (!result.ok) {
        return gitFail({
          ...base,
          status: "failed",
          preflight: plan.preflight,
          steps: executed,
          detail: `Step "${step.description}" failed with exit ${result.exit_code}. ` +
            `Remaining steps were not attempted.`,
        });
      }
    }

    return gitOk({
      ...base,
      status: "executed",
      preflight: plan.preflight,
      steps: executed,
    });
  };
}

function alternativesFor(action: string): string[] {
  switch (action) {
    case "branch_delete_merged":
      return ["branch_delete_merged uses -d only; -D (force delete) is denied by policy"];
    case "tag_create":
      return ["Retagging requires --force, which is denied. Choose a new tag name."];
    case "worktree_remove":
      return ["Commit or stash the worktree's changes first; --force is denied by policy."];
    default:
      return ["See ADR-0062 §Security for the full allowlist."];
  }
}

export const gitWorkbenchTestHelpers = {
  gitWorkbenchSchema,
  buildCommitSubject,
  planners,
  MUTATING_ACTIONS,
};
