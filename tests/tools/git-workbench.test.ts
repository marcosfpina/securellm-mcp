/**
 * git_workbench — ADR-0062
 *
 * Esta é a única tool do servidor que muta um repo. Os testes centrais não
 * verificam o que ela faz — verificam o que ela NÃO faz: quantas invocações
 * mutantes chegam ao git quando não devia chegar nenhuma.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createGitWorkbenchHandler,
  buildCommitSubject,
  gitWorkbenchTestHelpers,
} from "../../src/tools/git/workbench.js";
import {
  createGitOpsContext,
  resetRepoCacheForTests,
  type GitAuditEntry,
  type RunCommand,
} from "../../src/tools/git/exec.js";
import { resetWorkspaceCacheForTests } from "../../src/config/workspace.js";

/** Subcomandos que alteram o repo. Nenhum destes pode correr sem confirm. */
const MUTATING_SUBCOMMANDS = new Set([
  "add", "commit", "branch", "switch", "tag", "stash", "worktree", "fetch",
]);

/** `stash list` e `worktree list` são leituras apesar do subcomando mutante. */
function isMutatingCall(args: string[]): boolean {
  if (!MUTATING_SUBCOMMANDS.has(args[0])) return false;
  if ((args[0] === "stash" || args[0] === "worktree") && args[1] === "list") return false;
  if (args[0] === "branch" && args.includes("--merged")) return false;
  if (args[0] === "tag" && args.includes("-l")) return false;
  return true;
}

const ENV_KEYS = ["SECURELLM_ECOSYSTEM_ROOT", "PROJECT_ROOT", "HOME", "GIT_OPS_WRITES_ENABLED"] as const;
let saved: Record<string, string | undefined>;
let tmp: string;
let repoPath: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmp = mkdtempSync(path.join(os.tmpdir(), "securellm-workbench-"));
  repoPath = path.join(tmp, "target");
  mkdirSync(path.join(repoPath, ".git"), { recursive: true });
  process.env.SECURELLM_ECOSYSTEM_ROOT = tmp;
  process.env.PROJECT_ROOT = repoPath;
  delete process.env.GIT_OPS_WRITES_ENABLED;
  resetRepoCacheForTests();
  resetWorkspaceCacheForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(tmp, { recursive: true, force: true });
  resetRepoCacheForTests();
  resetWorkspaceCacheForTests();
});

function harness(
  reply: (args: string[]) => Partial<Awaited<ReturnType<RunCommand>>> | undefined = () => undefined
) {
  const calls: string[][] = [];
  const audits: GitAuditEntry[] = [];
  const run: RunCommand = async (_p, args) => {
    calls.push(args);
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { exitCode: 0, stdout: repoPath, stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "", ...(reply(args) ?? {}) };
  };
  const ctx = createGitOpsContext({
    run,
    ecosystemRoot: tmp,
    audit: (e) => audits.push(e),
    now: () => new Date("2026-08-04T12:00:00.000Z"),
  });
  return {
    calls,
    audits,
    handler: createGitWorkbenchHandler(ctx),
    mutations: () => calls.filter(isMutatingCall),
  };
}

function payload(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

/** Um repo com trabalho staged, para o commit ter algo que fazer. */
const STAGED = (args: string[]) => {
  if (args[0] === "diff" && args[1] === "--cached") return { stdout: " a.ts | 3 +++\n" };
  if (args[0] === "config" && args[2] === "user.email") return { stdout: "dev@example.com" };
  if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "dev" };
  if (args[0] === "status") return { stdout: " M a.ts\n" };
  return undefined;
};

describe("git_workbench — the confirmation protocol", () => {
  const commitArgs = {
    action: "commit",
    type: "feat",
    scope: "git",
    message: "add workbench",
    reason: "testing the confirmation protocol",
  };

  it("plans and executes nothing by default", async () => {
    const { handler, mutations } = harness(STAGED);

    const body = payload(await handler(commitArgs));

    assert.equal(body.status, "planned");
    assert.equal(mutations().length, 0, "dry_run must not touch the repo");
    assert.deepEqual(body.plan[0].argv, ["commit", "-m", "feat(git): add workbench"]);
    assert.match(body.next_step, /confirm:true/);
  });

  it("refuses to execute on dry_run:false alone", async () => {
    const { handler, mutations } = harness(STAGED);

    const body = payload(await handler({ ...commitArgs, dry_run: false }));

    assert.equal(body.status, "confirmation_required");
    assert.equal(mutations().length, 0, "one flag must never be enough");
    assert.match(body.next_step, /Nothing has been changed/);
  });

  it("refuses to execute on confirm:true alone", async () => {
    const { handler, mutations } = harness(STAGED);

    const body = payload(await handler({ ...commitArgs, confirm: true }));

    assert.equal(body.status, "planned", "confirm without dry_run:false is still a plan");
    assert.equal(mutations().length, 0);
  });

  it("executes only when both flags agree", async () => {
    const { handler, mutations } = harness(STAGED);

    const body = payload(await handler({ ...commitArgs, dry_run: false, confirm: true }));

    assert.equal(body.status, "executed");
    assert.equal(mutations().length, 1);
    assert.deepEqual(mutations()[0], ["commit", "-m", "feat(git): add workbench"]);
  });

  it("requires a reason for every mutating action", async () => {
    const { handler, mutations } = harness(STAGED);

    const result = await handler({ action: "commit", message: "x", dry_run: false, confirm: true });

    assert.equal(result.isError, true);
    const issues = payload(result).detail;
    assert.ok(issues.some((i: { path: string[] }) => i.path.includes("reason")));
    assert.equal(mutations().length, 0);
  });

  it("does not require a reason for a read-only action", async () => {
    const { handler } = harness();

    const body = payload(await handler({ action: "stash_list" }));

    assert.equal(body.status, "ok");
  });
});

describe("git_workbench — auditing", () => {
  const args = { action: "stage", all: true, reason: "stage everything for review" };

  it("audits a plan as planned, in dry_run mode", async () => {
    const { handler, audits } = harness((a) => (a[0] === "status" ? { stdout: " M a.ts\n" } : undefined));

    await handler(args);

    assert.equal(audits.length, 1);
    assert.equal(audits[0].status, "planned");
    assert.equal(audits[0].mode, "dry_run");
    assert.equal(audits[0].reason, "stage everything for review");
    assert.deepEqual(audits[0].argv, ["add", "-A"]);
    assert.equal(audits[0].ts, "2026-08-04T12:00:00.000Z");
  });

  it("audits an execution and carries the same audit_id into the response", async () => {
    const { handler, audits } = harness((a) => (a[0] === "status" ? { stdout: " M a.ts\n" } : undefined));

    const body = payload(await handler({ ...args, dry_run: false, confirm: true }));

    assert.equal(audits.length, 1);
    assert.equal(audits[0].status, "executed");
    assert.equal(audits[0].mode, "confirmed");
    assert.equal(audits[0].audit_id, body.audit_id);
  });

  it("audits a failure distinctly from a success", async () => {
    const { handler, audits } = harness((a) => {
      if (a[0] === "status") return { stdout: " M a.ts\n" };
      if (a[0] === "add") return { exitCode: 128, stderr: "fatal: pathspec did not match" };
      return undefined;
    });

    const result = await handler({ ...args, dry_run: false, confirm: true });

    assert.equal(result.isError, true);
    assert.equal(payload(result).status, "failed");
    assert.equal(audits[0].status, "failed");
    assert.equal(audits[0].exit_code, 128);
  });
});

describe("git_workbench — denial", () => {
  it("denies every mutation and runs nothing when writes are disabled", async () => {
    process.env.GIT_OPS_WRITES_ENABLED = "false";
    const { handler, mutations, audits } = harness((a) =>
      a[0] === "status" ? { stdout: " M a.ts\n" } : undefined
    );

    const result = await handler({
      action: "stage",
      all: true,
      reason: "should be blocked",
      dry_run: false,
      confirm: true,
    });

    assert.equal(result.isError, true);
    const body = payload(result);
    assert.equal(body.status, "denied");
    assert.equal(body.denials[0].code, "writes_disabled");
    assert.equal(mutations().length, 0);
    assert.equal(audits.filter((a) => a.status === "denied").length, 1);
  });

  it("offers a legal alternative instead of just refusing", async () => {
    process.env.GIT_OPS_WRITES_ENABLED = "false";
    const { handler } = harness((a) => (a[0] === "tag" ? { stdout: "" } : undefined));

    const body = payload(
      await handler({
        action: "tag_create",
        tag: "v1.0.0",
        tag_message: "release",
        reason: "cutting a release",
        dry_run: false,
        confirm: true,
      })
    );

    assert.ok(Array.isArray(body.allowed_alternatives));
    assert.ok(body.allowed_alternatives.length > 0);
  });
});

describe("git_workbench — branch_delete_merged", () => {
  function branchHarness(extra: (args: string[]) => Partial<Awaited<ReturnType<RunCommand>>> | undefined = () => undefined) {
    return harness((a) => {
      if (a[0] === "symbolic-ref") return { stdout: "origin/main" };
      if (a[0] === "branch" && a.includes("--merged")) {
        return { stdout: "main\ndev\nfeat/done\nrelease\nfeat/current\n" };
      }
      if (a[0] === "rev-parse" && a[1] === "--abbrev-ref") return { stdout: "feat/current" };
      if (a[0] === "merge-base") return { exitCode: 0 };
      return extra(a);
    });
  }

  it("never uses -D, only the safe -d", async () => {
    const { handler } = branchHarness();

    const body = payload(
      await handler({ action: "branch_delete_merged", reason: "cleaning up merged branches" })
    );

    assert.ok(body.plan.length > 0);
    for (const step of body.plan) {
      assert.equal(step.argv[1], "-d", `expected -d, got ${step.argv.join(" ")}`);
      assert.ok(!step.argv.includes("-D"));
      assert.ok(!step.argv.includes("--force"));
    }
  });

  it("skips the default branch, protected branches, and the current branch", async () => {
    const { handler } = branchHarness();

    const body = payload(
      await handler({ action: "branch_delete_merged", reason: "cleaning up merged branches" })
    );

    const targets = body.plan.map((s: { argv: string[] }) => s.argv[2]);
    assert.deepEqual(targets, ["dev", "feat/done"]);

    const skipped = Object.fromEntries(
      body.preflight.skipped.map((s: { branch: string; why: string }) => [s.branch, s.why])
    );
    assert.match(skipped["main"], /default/);
    assert.match(skipped["release"], /protected/);
    assert.match(skipped["feat/current"], /checked out/);
  });

  it("drops a branch that merge-base says is not actually merged", async () => {
    // --merged pode ficar desatualizado; merge-base é a segunda opinião.
    const { handler } = branchHarness();
    const h = harness((a) => {
      if (a[0] === "symbolic-ref") return { stdout: "origin/main" };
      if (a[0] === "branch" && a.includes("--merged")) return { stdout: "dev\nfeat/done\n" };
      if (a[0] === "rev-parse" && a[1] === "--abbrev-ref") return { stdout: "main" };
      if (a[0] === "merge-base") {
        return a.includes("feat/done") ? { exitCode: 1 } : { exitCode: 0 };
      }
      return undefined;
    });
    void handler;

    const body = payload(
      await h.handler({ action: "branch_delete_merged", reason: "cleaning up" })
    );

    assert.deepEqual(body.plan.map((s: { argv: string[] }) => s.argv[2]), ["dev"]);
    assert.ok(
      body.preflight.skipped.some((s: { branch: string }) => s.branch === "feat/done")
    );
  });

  it("reports a noop rather than an empty execution", async () => {
    const { handler } = harness((a) => {
      if (a[0] === "symbolic-ref") return { stdout: "origin/main" };
      if (a[0] === "branch" && a.includes("--merged")) return { stdout: "main\n" };
      if (a[0] === "rev-parse" && a[1] === "--abbrev-ref") return { stdout: "main" };
      return undefined;
    });

    const body = payload(await handler({ action: "branch_delete_merged", reason: "cleanup" }));

    assert.equal(body.status, "noop");
    assert.match(body.detail, /No merged branches/);
  });
});

describe("git_workbench — path boundaries", () => {
  it("denies a worktree outside the ecosystem root and runs nothing", async () => {
    const { handler, mutations } = harness();

    const result = await handler({
      action: "worktree_add",
      worktree_path: "/etc/evil",
      reason: "should be refused",
      dry_run: false,
      confirm: true,
    });

    assert.equal(result.isError, true);
    const body = payload(result);
    assert.equal(body.status, "denied");
    assert.equal(body.denials[0].code, "path_escape");
    assert.equal(mutations().length, 0);
  });

  it("allows a worktree inside the ecosystem root", async () => {
    const { handler } = harness();

    const body = payload(
      await handler({
        action: "worktree_add",
        worktree_path: path.join(tmp, "wt-feature"),
        worktree_branch: "feat/x",
        reason: "parallel work on a feature",
      })
    );

    assert.equal(body.status, "planned");
    assert.equal(body.plan[0].argv[0], "worktree");
    assert.equal(body.plan[0].argv[1], "add");
  });

  it("rejects a ref name with shell or git metacharacters", async () => {
    const { handler, mutations } = harness();

    for (const branch of ["feat/x;rm -rf /", "--force", "a..b", "with space", "x^"]) {
      const result = await handler({ action: "branch_create", branch, reason: "should be rejected" });
      assert.equal(result.isError, true, `"${branch}" should be rejected`);
    }
    assert.equal(mutations().length, 0);
  });
});

describe("git_workbench — preflight", () => {
  it("stops before committing when nothing is staged", async () => {
    const { handler, mutations } = harness((a) => {
      if (a[0] === "config" && a[2] === "user.email") return { stdout: "dev@example.com" };
      return undefined;
    });

    const body = payload(
      await handler({
        action: "commit",
        message: "empty",
        reason: "nothing staged",
        dry_run: false,
        confirm: true,
      })
    );

    assert.equal(body.status, "noop");
    assert.equal(mutations().length, 0, "an empty commit must not be attempted");
  });

  it("warns up front when user.email is missing", async () => {
    const { handler } = harness((a) =>
      a[0] === "diff" && a[1] === "--cached" ? { stdout: " a.ts | 1 +\n" } : undefined
    );

    const body = payload(
      await handler({ action: "commit", message: "x", reason: "checking the warning" })
    );

    assert.ok(body.preflight.warnings.some((w: string) => /user\.email/.test(w)));
  });

  it("stops at the first failed step instead of chaining writes", async () => {
    const { handler, mutations } = harness((a) => {
      if (a[0] === "config" && a[2] === "user.email") return { stdout: "dev@example.com" };
      if (a[0] === "diff") return { stdout: " a.ts | 1 +\n" };
      if (a[0] === "add") return { exitCode: 1, stderr: "fatal: unable to index" };
      return undefined;
    });

    const result = await handler({
      action: "commit",
      message: "x",
      reason: "testing failure containment",
      stage_all_first: true,
      dry_run: false,
      confirm: true,
    });

    const body = payload(result);
    assert.equal(body.status, "failed");
    assert.equal(body.steps.length, 1, "the commit must not run after add failed");
    assert.deepEqual(mutations(), [["add", "-A"]]);
    assert.match(body.detail, /not attempted/);
  });

  it("refuses to guess when the default branch cannot be detected", async () => {
    const { handler } = harness((a) => {
      if (a[0] === "symbolic-ref") return { exitCode: 1 };
      if (a[0] === "show-ref") return { exitCode: 1 };
      return undefined;
    });

    const body = payload(await handler({ action: "branch_delete_merged", reason: "cleanup" }));

    assert.equal(body.status, "noop");
    assert.match(body.detail, /refusing to guess/);
  });
});

describe("buildCommitSubject", () => {
  const helpers = gitWorkbenchTestHelpers;

  it("composes type, scope and message", () => {
    assert.equal(
      buildCommitSubject({ type: "feat", scope: "git", message: "add x" } as never),
      "feat(git): add x"
    );
  });

  it("omits the scope when absent", () => {
    assert.equal(buildCommitSubject({ type: "fix", message: "y" } as never), "fix: y");
  });

  it("passes the message through untouched when no type is given", () => {
    assert.equal(buildCommitSubject({ message: "raw subject" } as never), "raw subject");
  });

  it("agrees with the tool on which actions mutate", () => {
    assert.ok(helpers.MUTATING_ACTIONS.has("commit"));
    assert.ok(!helpers.MUTATING_ACTIONS.has("stash_list"));
    assert.ok(!helpers.MUTATING_ACTIONS.has("worktree_list"));
  });
});
