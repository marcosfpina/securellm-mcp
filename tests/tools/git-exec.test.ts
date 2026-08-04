/**
 * Git exec helper — ADR-0062
 *
 * As propriedades que aqui se fixam são as que o git_sherlock original não
 * tinha: cwd explícito, argv apenas, falha visível, e um toplevel que não
 * pode saltar a fronteira por symlink.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createGitOpsContext,
  resolveRepo,
  runGit,
  runGitIn,
  resetRepoCacheForTests,
  toGitError,
  emitAudit,
  RepoResolutionError,
  type GitAuditEntry,
  type RunCommand,
} from "../../src/tools/git/exec.js";
import { resetWorkspaceCacheForTests } from "../../src/config/workspace.js";

interface Call {
  program: string;
  args: string[];
  options: { cwd: string; timeoutMs?: number };
}

/** runCommand falso que grava tudo e devolve respostas roteadas por argv. */
function recorder(
  routes: Array<{ match: (args: string[]) => boolean; reply: Partial<Awaited<ReturnType<RunCommand>>> }> = []
) {
  const calls: Call[] = [];
  const run: RunCommand = async (program, args, options) => {
    calls.push({ program, args, options });
    const route = routes.find((r) => r.match(args));
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      ...(route?.reply ?? {}),
    };
  };
  return { calls, run };
}

const ENV_KEYS = ["SECURELLM_ECOSYSTEM_ROOT", "PROJECT_ROOT", "HOME"] as const;
let saved: Record<string, string | undefined>;
let tmp: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmp = mkdtempSync(path.join(os.tmpdir(), "securellm-gitexec-"));
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

function fakeRepo(root: string, name: string): string {
  const repo = path.join(root, name);
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  return repo;
}

describe("runGitIn", () => {
  it("passes argv through untouched and never builds a shell string", async () => {
    const { calls, run } = recorder();
    const ctx = createGitOpsContext({ run, ecosystemRoot: tmp });

    await runGitIn(tmp, ["log", "--since=1 week ago; touch /tmp/pwned"], ctx);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].program, "git");
    assert.deepEqual(calls[0].args, ["log", "--since=1 week ago; touch /tmp/pwned"]);
    assert.equal(calls[0].options.cwd, tmp);
    assert.ok(!("shell" in calls[0].options), "no shell option may reach the runner");
  });

  it("surfaces a non-zero exit instead of an empty stdout", async () => {
    const { run } = recorder([
      { match: () => true, reply: { exitCode: 128, stderr: "fatal: not a git repository" } },
    ]);
    const ctx = createGitOpsContext({ run, ecosystemRoot: tmp });

    const result = await runGitIn(tmp, ["status"], ctx);

    assert.equal(result.ok, false);
    assert.equal(result.exit_code, 128);
    assert.match(result.stderr_tail, /not a git repository/);
  });

  it("marks a timeout distinctly from a plain failure", async () => {
    const { run } = recorder([{ match: () => true, reply: { exitCode: 0, timedOut: true } }]);
    const ctx = createGitOpsContext({ run, ecosystemRoot: tmp });

    const result = await runGitIn(tmp, ["log"], ctx);

    assert.equal(result.timed_out, true);
    assert.equal(result.ok, false, "a timeout is not a success even with exit 0");
  });

  it("does not throw when the injected runner throws", async () => {
    const run: RunCommand = async () => {
      throw new Error("spawn ENOENT");
    };
    const ctx = createGitOpsContext({ run, ecosystemRoot: tmp });

    const result = await runGitIn(tmp, ["status"], ctx);

    assert.equal(result.ok, false);
    assert.equal(result.exit_code, -1);
    assert.match(result.stderr_tail, /ENOENT/);
  });

  it("forwards timeoutMs to the runner", async () => {
    const { calls, run } = recorder();
    const ctx = createGitOpsContext({ run, ecosystemRoot: tmp });

    await runGitIn(tmp, ["status"], ctx, { timeoutMs: 1234 });

    assert.equal(calls[0].options.timeoutMs, 1234);
  });

  it("truncates a long stderr into stderr_tail while keeping stderr whole", async () => {
    const long = "x".repeat(5000);
    const { run } = recorder([{ match: () => true, reply: { exitCode: 1, stderr: long } }]);
    const ctx = createGitOpsContext({ run, ecosystemRoot: tmp });

    const result = await runGitIn(tmp, ["status"], ctx);

    assert.equal(result.stderr.length, 5000);
    assert.ok(result.stderr_tail.length < 500);
  });
});

describe("resolveRepo", () => {
  it("resolves a simple ecosystem repo name", async () => {
    process.env.SECURELLM_ECOSYSTEM_ROOT = tmp;
    const alpha = fakeRepo(tmp, "alpha");
    const { run } = recorder([
      { match: (a) => a[0] === "rev-parse", reply: { stdout: alpha } },
    ]);
    const ctx = createGitOpsContext({ run, ecosystemRoot: tmp });

    const repo = await resolveRepo("alpha", ctx);

    assert.equal(repo.path, alpha);
    assert.equal(repo.name, "alpha");
    assert.equal(repo.source, "explicit_name");
    assert.equal(repo.requested, "alpha");
  });

  it("rejects an unknown repo name with the known list", async () => {
    process.env.SECURELLM_ECOSYSTEM_ROOT = tmp;
    fakeRepo(tmp, "alpha");
    const { run } = recorder();
    const ctx = createGitOpsContext({ run, ecosystemRoot: tmp });

    await assert.rejects(
      () => resolveRepo("nonexistent", ctx),
      (err: RepoResolutionError) => {
        assert.equal(err.code, "unknown_repo");
        assert.match(err.message, /alpha/);
        return true;
      }
    );
  });

  it("rejects a traversal path", async () => {
    process.env.SECURELLM_ECOSYSTEM_ROOT = tmp;
    process.env.PROJECT_ROOT = tmp;
    const { run } = recorder();
    const ctx = createGitOpsContext({ run, ecosystemRoot: tmp });

    await assert.rejects(
      () => resolveRepo("../../etc", ctx),
      (err: RepoResolutionError) => err.code === "path_escape"
    );
  });

  it("rejects an absolute path outside every boundary", async () => {
    process.env.SECURELLM_ECOSYSTEM_ROOT = tmp;
    process.env.PROJECT_ROOT = tmp;
    const { run } = recorder();
    const ctx = createGitOpsContext({ run, ecosystemRoot: tmp });

    await assert.rejects(
      () => resolveRepo("/etc/passwd", ctx),
      (err: RepoResolutionError) => err.code === "path_escape"
    );
  });

  it("re-validates the toplevel — a symlinked repo cannot escape the boundary", async () => {
    // O path de entrada respeita a fronteira, mas o git devolve um toplevel
    // fora dela. Sem re-validação, operar-se-ia num repo que o operador nunca
    // autorizou.
    process.env.SECURELLM_ECOSYSTEM_ROOT = tmp;
    process.env.PROJECT_ROOT = tmp;
    const inside = fakeRepo(tmp, "looks-fine");
    const { run } = recorder([
      { match: (a) => a[0] === "rev-parse", reply: { stdout: "/etc/somewhere-else" } },
    ]);
    const ctx = createGitOpsContext({ run, ecosystemRoot: tmp });

    await assert.rejects(
      () => resolveRepo(inside, ctx),
      (err: RepoResolutionError) => {
        assert.equal(err.code, "path_escape");
        assert.match(err.message, /toplevel/);
        return true;
      }
    );
  });

  it("rejects a directory that is not a git repository", async () => {
    process.env.SECURELLM_ECOSYSTEM_ROOT = tmp;
    process.env.PROJECT_ROOT = tmp;
    const plain = path.join(tmp, "plain");
    mkdirSync(plain, { recursive: true });
    const { run } = recorder([
      {
        match: (a) => a[0] === "rev-parse",
        reply: { exitCode: 128, stderr: "fatal: not a git repository" },
      },
    ]);
    const ctx = createGitOpsContext({ run, ecosystemRoot: tmp });

    await assert.rejects(
      () => resolveRepo(plain, ctx),
      (err: RepoResolutionError) => err.code === "not_a_git_repo"
    );
  });

  it("falls back to PROJECT_ROOT when no repo is given", async () => {
    process.env.SECURELLM_ECOSYSTEM_ROOT = tmp;
    const proj = fakeRepo(tmp, "the-project");
    process.env.PROJECT_ROOT = proj;
    const { run } = recorder([
      { match: (a) => a[0] === "rev-parse", reply: { stdout: proj } },
    ]);
    const ctx = createGitOpsContext({ run, ecosystemRoot: tmp });

    const repo = await resolveRepo(undefined, ctx);

    assert.equal(repo.path, proj);
    assert.equal(repo.source, "project_root");
    assert.equal(repo.requested, null);
  });

  it("memoizes resolution and resetRepoCacheForTests clears it", async () => {
    process.env.SECURELLM_ECOSYSTEM_ROOT = tmp;
    const alpha = fakeRepo(tmp, "alpha");
    const { calls, run } = recorder([
      { match: (a) => a[0] === "rev-parse", reply: { stdout: alpha } },
    ]);
    const ctx = createGitOpsContext({ run, ecosystemRoot: tmp });

    await resolveRepo("alpha", ctx);
    await resolveRepo("alpha", ctx);
    assert.equal(calls.length, 1, "second resolution should hit the memo");

    resetRepoCacheForTests();
    await resolveRepo("alpha", ctx);
    assert.equal(calls.length, 2);
  });
});

describe("runGit targets the resolved repo", () => {
  it("every command runs with cwd set to the repo toplevel", async () => {
    process.env.SECURELLM_ECOSYSTEM_ROOT = tmp;
    const beta = fakeRepo(tmp, "beta");
    const { calls, run } = recorder([
      { match: (a) => a[0] === "rev-parse", reply: { stdout: beta } },
    ]);
    const ctx = createGitOpsContext({ run, ecosystemRoot: tmp });

    const repo = await resolveRepo("beta", ctx);
    await runGit(repo, ["status", "--porcelain"], ctx);
    await runGit(repo, ["log", "-1"], ctx);

    const nonResolve = calls.filter((c) => c.args[0] !== "rev-parse");
    assert.equal(nonResolve.length, 2);
    for (const call of nonResolve) assert.equal(call.options.cwd, beta);
  });
});

describe("audit", () => {
  it("emits one entry with the caller's fields and a timestamp", () => {
    const entries: GitAuditEntry[] = [];
    const ctx = createGitOpsContext({
      run: recorder().run,
      ecosystemRoot: tmp,
      audit: (e) => entries.push(e),
      now: () => new Date("2026-08-04T12:00:00.000Z"),
    });

    emitAudit(ctx, {
      audit_id: "aid",
      tool: "git_workbench",
      action: "commit",
      repo: "alpha",
      argv: ["commit", "-m", "x"],
      mode: "dry_run",
      status: "planned",
      reason: "because",
    });

    assert.equal(entries.length, 1);
    assert.equal(entries[0].ts, "2026-08-04T12:00:00.000Z");
    assert.equal(entries[0].status, "planned");
    assert.equal(entries[0].reason, "because");
  });

  it("never lets a failing audit sink break the operation", () => {
    const ctx = createGitOpsContext({
      run: recorder().run,
      ecosystemRoot: tmp,
      audit: () => {
        throw new Error("log destination is full");
      },
    });

    assert.doesNotThrow(() =>
      emitAudit(ctx, {
        audit_id: "aid",
        tool: "git_workbench",
        action: "commit",
        repo: "alpha",
        argv: [],
        mode: "confirmed",
        status: "executed",
      })
    );
  });
});

describe("toGitError", () => {
  it("keeps the argv and exit code so a failure is diagnosable", async () => {
    const { run } = recorder([
      { match: () => true, reply: { exitCode: 129, stderr: "usage: git log" } },
    ]);
    const ctx = createGitOpsContext({ run, ecosystemRoot: tmp });

    const result = await runGitIn(tmp, ["log", "--bogus"], ctx);
    const error = toGitError("history", result);

    assert.equal(error.step, "history");
    assert.deepEqual(error.argv, ["log", "--bogus"]);
    assert.equal(error.exit_code, 129);
    assert.match(error.stderr_tail, /usage: git log/);
  });
});
