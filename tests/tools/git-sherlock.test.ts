/**
 * Git Sherlock — ADR-0006 endurecida pela ADR-0062
 *
 * Não existia teste nenhum para esta tool. Os primeiros a escrever são os que
 * fixam os defeitos que ela tinha: injeção por shell, ausência de cwd, e
 * falhas silenciosas.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createGitSherlockHandler } from "../../src/tools/git-sherlock.js";
import { createGitOpsContext, resetRepoCacheForTests, type RunCommand } from "../../src/tools/git/exec.js";
import { resetWorkspaceCacheForTests } from "../../src/config/workspace.js";

interface Call {
  program: string;
  args: string[];
  options: { cwd: string; timeoutMs?: number };
}

const ENV_KEYS = ["SECURELLM_ECOSYSTEM_ROOT", "PROJECT_ROOT", "HOME"] as const;
let saved: Record<string, string | undefined>;
let tmp: string;
let repoPath: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmp = mkdtempSync(path.join(os.tmpdir(), "securellm-sherlock-"));
  repoPath = path.join(tmp, "target-repo");
  mkdirSync(path.join(repoPath, ".git"), { recursive: true });
  process.env.SECURELLM_ECOSYSTEM_ROOT = tmp;
  process.env.PROJECT_ROOT = repoPath;
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
  routes: Array<{ match: (args: string[]) => boolean; reply: Partial<Awaited<ReturnType<RunCommand>>> }> = []
) {
  const calls: Call[] = [];
  const run: RunCommand = async (program, args, options) => {
    calls.push({ program, args, options });
    if (args[0] === "rev-parse") return { exitCode: 0, stdout: repoPath, stderr: "" };
    const route = routes.find((r) => r.match(args));
    return { exitCode: 0, stdout: "", stderr: "", ...(route?.reply ?? {}) };
  };
  const handler = createGitSherlockHandler(createGitOpsContext({ run, ecosystemRoot: tmp }));
  return { calls, handler, gitCalls: () => calls.filter((c) => c.args[0] !== "rev-parse") };
}

function payload(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("git_sherlock — command injection (B2)", () => {
  it("carries a shell payload in `since` as one inert argv element", async () => {
    const evil = '"; touch /tmp/pwned #';
    const { handler, gitCalls } = harness();

    await handler({ action: "what_changed", since: evil });

    const log = gitCalls().find((c) => c.args[0] === "log");
    assert.ok(log, "expected a git log call");
    assert.deepEqual(log.args, ["log", `--since=${evil}`, "--oneline", "--stat"]);
    // O payload é exatamente um elemento: nada foi partido nem reinterpretado.
    assert.equal(log.args.filter((a) => a.includes("touch")).length, 1);
  });

  it("never passes a shell option to the runner", async () => {
    const { handler, calls } = harness();

    await handler({ action: "churn", since: "1 month ago" });

    assert.ok(calls.length > 0);
    for (const call of calls) {
      assert.ok(!("shell" in call.options), `shell leaked into ${call.args.join(" ")}`);
      assert.equal(call.program, "git");
    }
  });

  it("rejects a value that would be parsed as a git flag", async () => {
    const { handler, gitCalls } = harness();

    const result = await handler({ action: "what_changed", since: "--upload-pack=evil" });

    assert.equal(result.isError, true);
    assert.equal(payload(result).error, "invalid_arguments");
    assert.equal(gitCalls().length, 0, "nothing should run after a rejected argument");
  });

  it("rejects a flag-like path too", async () => {
    const { handler } = harness();

    const result = await handler({ action: "file_history", path: "--exec-path=/tmp" });

    assert.equal(result.isError, true);
    assert.equal(payload(result).error, "invalid_arguments");
  });

  it("separates user paths with -- so a dashed filename stays a path", async () => {
    const { handler, gitCalls } = harness();

    await handler({ action: "file_history", path: "src/index.ts" });

    const log = gitCalls().find((c) => c.args[0] === "log");
    assert.ok(log);
    const dashdash = log.args.indexOf("--");
    assert.ok(dashdash > 0, "expected a -- separator");
    assert.equal(log.args[dashdash + 1], "src/index.ts");
  });
});

describe("git_sherlock — repo targeting (B3)", () => {
  it("runs every command in the resolved repo, not the server cwd", async () => {
    const { handler, gitCalls } = harness();

    await handler({ action: "churn", repo: "target-repo" });

    assert.ok(gitCalls().length > 0);
    for (const call of gitCalls()) {
      assert.equal(call.options.cwd, repoPath);
    }
    assert.notEqual(repoPath, process.cwd());
  });

  it("reports which repo was used and how it was chosen", async () => {
    const { handler } = harness();

    const result = await handler({ action: "churn", repo: "target-repo" });
    const body = payload(result);

    assert.equal(body.repo, "target-repo");
    assert.equal(body.repo_path, repoPath);
    assert.equal(body.repo_source, "explicit_name");
  });

  it("falls back to PROJECT_ROOT when no repo is named", async () => {
    const { handler } = harness();

    const body = payload(await handler({ action: "churn" }));

    assert.equal(body.repo_path, repoPath);
    assert.equal(body.repo_source, "project_root");
  });

  it("returns a structured error for an unknown repo", async () => {
    const { handler, gitCalls } = harness();

    const result = await handler({ action: "churn", repo: "no-such-repo" });

    assert.equal(result.isError, true);
    assert.equal(payload(result).error, "unknown_repo");
    assert.equal(gitCalls().length, 0);
  });
});

describe("git_sherlock — failures are visible", () => {
  it("does not report a clean repo when git actually failed", async () => {
    const { handler } = harness([
      {
        match: (a) => a[0] === "log",
        reply: { exitCode: 128, stderr: "fatal: your current branch does not have any commits" },
      },
    ]);

    const result = await handler({ action: "churn" });
    const body = payload(result);

    assert.equal(result.isError, true);
    assert.equal(body.error, "log_failed");
    assert.equal(body.errors.length, 1);
    assert.equal(body.errors[0].exit_code, 128);
    assert.match(body.errors[0].stderr_tail, /does not have any commits/);
  });

  it("collects partial failures without discarding the parts that worked", async () => {
    const { handler } = harness([
      { match: (a) => a[0] === "log" && a[1] === "--since=1 week ago", reply: { stdout: "abc1234 feat: x\n file.ts | 3 +++\n" } },
      { match: (a) => a[0] === "shortlog", reply: { exitCode: 1, stderr: "shortlog exploded" } },
    ]);

    const result = await handler({ action: "what_changed" });
    const body = payload(result);

    assert.equal(body.total_commits, 1, "the log result must survive the shortlog failure");
    assert.equal(body.errors.length, 1);
    assert.equal(body.errors[0].step, "shortlog");
  });
});

describe("git_sherlock — parsing", () => {
  it("keeps a commit subject that contains a pipe intact", async () => {
    // O formato original era "%h|%aI|%an|%s" e partia em "|": qualquer subject
    // com um pipe corrompia todos os campos seguintes.
    const record = ["fullhash", "abc1234", "2026-08-01T10:00:00Z", "Kernel Core", "fix: handle a | b parsing"].join("\x1f");
    const { handler } = harness([
      { match: (a) => a[0] === "log", reply: { stdout: `${record}\x1e` } },
    ]);

    const body = payload(await handler({ action: "file_history", path: "src/x.ts" }));

    assert.equal(body.commits.length, 1);
    assert.equal(body.commits[0].subject, "fix: handle a | b parsing");
    assert.equal(body.commits[0].author, "Kernel Core");
    assert.equal(body.commits[0].short, "abc1234");
  });

  it("parses several records without losing any", async () => {
    const records = [
      ["h1", "s1", "2026-08-01T10:00:00Z", "A", "feat: one"],
      ["h2", "s2", "2026-08-02T10:00:00Z", "B", "fix: two"],
    ]
      .map((f) => f.join("\x1f"))
      .join("\x1e\n");
    const { handler } = harness([
      { match: (a) => a[0] === "log", reply: { stdout: `${records}\x1e` } },
    ]);

    const body = payload(await handler({ action: "file_history", path: "src/x.ts" }));

    assert.equal(body.commits.length, 2);
    assert.deepEqual(
      body.commits.map((c: { subject: string }) => c.subject),
      ["feat: one", "fix: two"]
    );
  });

  it("aggregates churn counts per file", async () => {
    const { handler } = harness([
      { match: (a) => a[0] === "log", reply: { stdout: "a.ts\nb.ts\na.ts\n\nc.ts\na.ts\n" } },
    ]);

    const body = payload(await handler({ action: "churn", top_n: 2 }));

    assert.equal(body.total_files, 3);
    assert.deepEqual(body.top_churn[0], { file: "a.ts", commits: 3 });
    assert.equal(body.top_churn.length, 2);
  });

  it("categorises uncommitted work and only ever suggests commits", async () => {
    const { handler } = harness([
      {
        match: (a) => a[0] === "diff" && a[1] === "--cached",
        reply: { stdout: " src/tools/x.ts | 10 ++++++----\n" },
      },
      {
        match: (a) => a[0] === "diff",
        reply: { stdout: " docs/readme.md | 2 +-\n flake.nix | 1 +\n" },
      },
      { match: (a) => a[0] === "ls-files", reply: { stdout: "new-file.ts\n" } },
    ]);

    const body = payload(await handler({ action: "review_uncommitted", suggest_commits: true }));

    assert.equal(body.categories.source, 1);
    assert.equal(body.categories.docs, 1);
    assert.equal(body.categories.nix, 1);
    assert.equal(body.untracked.count, 1);
    assert.ok(body.suggested_commits.some((s: string) => s.startsWith("feat(tools):")));
    assert.ok(body.suggested_commits.some((s: string) => s.startsWith("fix(nix):")));
    assert.match(body.note, /only/i);
  });
});

describe("git_sherlock — schema", () => {
  it("rejects an unknown action", async () => {
    const { handler, gitCalls } = harness();

    const result = await handler({ action: "rm_rf" });

    assert.equal(result.isError, true);
    assert.equal(payload(result).error, "invalid_arguments");
    assert.equal(gitCalls().length, 0);
  });

  it("requires a path for file_history", async () => {
    const { handler } = harness();

    const result = await handler({ action: "file_history" });

    assert.equal(result.isError, true);
    assert.match(payload(result).error, /path is required/);
  });

  it("clamps top_n to the documented range", async () => {
    const { handler } = harness();

    const result = await handler({ action: "churn", top_n: 999 });

    assert.equal(result.isError, true);
    assert.equal(payload(result).error, "invalid_arguments");
  });
});
