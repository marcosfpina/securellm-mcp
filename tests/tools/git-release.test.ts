/**
 * git_release — ADR-0062
 *
 * A propriedade central: esta tool nunca escreve. Tag creation sai daqui como
 * uma chamada a git_workbench, para que exista um só caminho de escrita e uma
 * só auditoria.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createGitReleaseHandler } from "../../src/tools/git/release.js";
import { createGitOpsContext, resetRepoCacheForTests, type RunCommand } from "../../src/tools/git/exec.js";
import { resetWorkspaceCacheForTests } from "../../src/config/workspace.js";

const ENV_KEYS = ["SECURELLM_ECOSYSTEM_ROOT", "PROJECT_ROOT", "HOME"] as const;
let saved: Record<string, string | undefined>;
let tmp: string;
let repoPath: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmp = mkdtempSync(path.join(os.tmpdir(), "securellm-release-"));
  repoPath = path.join(tmp, "target");
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

function record(short: string, subject: string, body = ""): string {
  return ["h".repeat(40), short, "2026-08-01T00:00:00Z", "Dev", subject, body].join("\x1f") + "\x1e";
}

const COMMITS = [
  record("aaa1111", "feat(api): add endpoint"),
  record("bbb2222", "fix: correct off-by-one"),
].join("\n");

interface Call {
  program: string;
  args: string[];
}

function harness(
  reply: (program: string, args: string[]) => Partial<Awaited<ReturnType<RunCommand>>> | undefined
) {
  const calls: Call[] = [];
  const run: RunCommand = async (program, args) => {
    calls.push({ program, args });
    if (program === "git" && args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      return { exitCode: 0, stdout: repoPath, stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "", ...(reply(program, args) ?? {}) };
  };
  const ctx = createGitOpsContext({
    run,
    ecosystemRoot: tmp,
    now: () => new Date("2026-08-04T12:00:00.000Z"),
  });
  return { calls, handler: createGitReleaseHandler(ctx) };
}

/** Repo limpo, tag v0.1.0, dois commits convencionais desde então. */
const CLEAN_REPO: Parameters<typeof harness>[0] = (program, args) => {
  if (program !== "git") return undefined;
  if (args[0] === "describe") return { stdout: "v0.1.0" };
  if (args[0] === "log") return { stdout: COMMITS };
  if (args[0] === "status") return { stdout: "" };
  if (args[0] === "rev-list") return { stdout: "0\t2" };
  if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { stdout: "main" };
  return undefined;
};

function payload(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("git_release — never writes", () => {
  const WRITE_SUBCOMMANDS = ["add", "commit", "tag", "branch", "switch", "stash", "worktree", "push", "fetch"];

  it("issues no mutating git command for any action", async () => {
    for (const action of ["readiness", "changelog", "next_version", "tag_plan"]) {
      const { calls, handler } = harness(CLEAN_REPO);
      await handler({ action });

      const writes = calls.filter(
        (c) => c.program === "git" && WRITE_SUBCOMMANDS.includes(c.args[0]) && c.args[1] !== "-l"
      );
      assert.deepEqual(writes, [], `${action} issued a write: ${JSON.stringify(writes)}`);
    }
  });

  it("delegates tag creation to git_workbench with dry_run still on", async () => {
    const { handler } = harness(CLEAN_REPO);

    const body = payload(await handler({ action: "tag_plan" }));

    assert.equal(body.workbench_call.tool, "git_workbench");
    assert.equal(body.workbench_call.arguments.action, "tag_create");
    assert.equal(body.workbench_call.arguments.dry_run, true);
    assert.ok(body.workbench_call.arguments.reason, "the delegated call must carry a reason");
    assert.equal(body.workbench_call.arguments.tag, "v0.2.0");
    assert.match(body.workbench_call.arguments.tag_message, /### Features/);
  });
});

describe("git_release — next_version", () => {
  it("proposes a minor bump for a feature", async () => {
    const { handler } = harness(CLEAN_REPO);

    const body = payload(await handler({ action: "next_version" }));

    assert.equal(body.current_version, "v0.1.0");
    assert.equal(body.bump, "minor");
    assert.equal(body.proposed_version, "v0.2.0");
  });

  it("applies the zero-major policy to a breaking change below 1.0.0", async () => {
    const { handler } = harness((p, a) =>
      p === "git" && a[0] === "log"
        ? { stdout: record("ccc3333", "feat!: drop v1") }
        : CLEAN_REPO(p, a)
    );

    const body = payload(await handler({ action: "next_version" }));

    assert.equal(body.bump, "minor");
    assert.equal(body.proposed_version, "v0.2.0");
    assert.ok(body.drivers.some((d: string) => /zero-major/.test(d)));
  });

  it("honours zero_major_policy:false", async () => {
    const { handler } = harness((p, a) =>
      p === "git" && a[0] === "log"
        ? { stdout: record("ccc3333", "feat!: drop v1") }
        : CLEAN_REPO(p, a)
    );

    const body = payload(await handler({ action: "next_version", zero_major_policy: false }));

    assert.equal(body.bump, "major");
    assert.equal(body.proposed_version, "v1.0.0");
  });

  it("starts from 0.0.0 when there is no tag at all", async () => {
    const { handler } = harness((p, a) => {
      if (p !== "git") return undefined;
      if (a[0] === "describe") return { exitCode: 128, stderr: "fatal: no names found" };
      if (a[0] === "log") return { stdout: COMMITS };
      return CLEAN_REPO(p, a);
    });

    const body = payload(await handler({ action: "next_version" }));

    assert.equal(body.current_tag, null);
    assert.equal(body.proposed_version, "v0.1.0");
  });

  it("flags a non-semver tag instead of extrapolating from it", async () => {
    const { handler } = harness((p, a) =>
      p === "git" && a[0] === "describe" ? { stdout: "release-2026-08" } : CLEAN_REPO(p, a)
    );

    const body = payload(await handler({ action: "next_version" }));

    assert.equal(body.tag_is_semver, false);
    assert.match(body.note, /not semver/);
  });
});

describe("git_release — readiness", () => {
  it("says ready for a clean repo with conventional commits", async () => {
    const { handler } = harness(CLEAN_REPO);

    const body = payload(await handler({ action: "readiness" }));

    assert.equal(body.verdict, "ready");
    assert.deepEqual(body.blockers, []);
    assert.equal(body.proposed_version, "v0.2.0");
  });

  it("blocks on uncommitted work", async () => {
    const { handler } = harness((p, a) =>
      p === "git" && a[0] === "status" ? { stdout: " M a.ts\n?? b.ts\n" } : CLEAN_REPO(p, a)
    );

    const body = payload(await handler({ action: "readiness" }));

    assert.equal(body.verdict, "blocked");
    assert.equal(body.uncommitted_files, 2);
    assert.ok(body.blockers.some((b: string) => /uncommitted/.test(b)));
  });

  it("blocks on unconventional commits, since the changelog would be incomplete", async () => {
    const { handler } = harness((p, a) =>
      p === "git" && a[0] === "log"
        ? { stdout: record("ddd4444", "just some random message") }
        : CLEAN_REPO(p, a)
    );

    const body = payload(await handler({ action: "readiness" }));

    assert.equal(body.verdict, "blocked");
    assert.equal(body.unconventional_commits.length, 1);
  });

  it("blocks when behind upstream but only warns when ahead", async () => {
    const behind = harness((p, a) =>
      p === "git" && a[0] === "rev-list" ? { stdout: "3\t0" } : CLEAN_REPO(p, a)
    );
    const bodyBehind = payload(await behind.handler({ action: "readiness" }));
    assert.equal(bodyBehind.verdict, "blocked");
    assert.ok(bodyBehind.blockers.some((b: string) => /behind/.test(b)));

    const ahead = harness(CLEAN_REPO);
    const bodyAhead = payload(await ahead.handler({ action: "readiness" }));
    assert.equal(bodyAhead.verdict, "ready");
    assert.ok(bodyAhead.warnings.some((w: string) => /not pushed/.test(w)));
  });

  it("blocks when there is nothing to release", async () => {
    const { handler } = harness((p, a) =>
      p === "git" && a[0] === "log" ? { stdout: "" } : CLEAN_REPO(p, a)
    );

    const body = payload(await handler({ action: "readiness" }));

    assert.equal(body.verdict, "blocked");
    assert.ok(body.blockers.some((b: string) => /no commits since/.test(b)));
  });

  it("does not call gh unless include_pr is set", async () => {
    const { calls, handler } = harness(CLEAN_REPO);

    await handler({ action: "readiness" });

    assert.equal(calls.filter((c) => c.program === "gh").length, 0);
  });
});

describe("git_release — changelog", () => {
  it("groups commits and renders markdown", async () => {
    const { handler } = harness(CLEAN_REPO);

    const body = payload(await handler({ action: "changelog" }));

    assert.equal(body.total_commits, 2);
    assert.deepEqual(body.sections.map((s: { type: string }) => s.type), ["feat", "fix"]);
    assert.match(body.changelog_markdown, /## v0\.2\.0/);
    assert.match(body.changelog_markdown, /\*\*api:\*\* add endpoint/);
  });

  it("returns markdown only in markdown format", async () => {
    const { handler } = harness(CLEAN_REPO);

    const body = payload(await handler({ action: "changelog", format: "markdown" }));

    assert.ok(body.changelog_markdown);
    assert.equal(body.sections, undefined);
  });
});

describe("git_release — pr_status is read-only gh", () => {
  it("uses only allowlisted gh verbs", async () => {
    const { calls, handler } = harness((p, a) => {
      if (p === "gh" && a[1] === "view") {
        return { stdout: JSON.stringify({ number: 7, state: "OPEN", isDraft: false }) };
      }
      if (p === "gh" && a[1] === "checks") {
        return { stdout: JSON.stringify([{ name: "ci", state: "SUCCESS" }]) };
      }
      return CLEAN_REPO(p, a);
    });

    const body = payload(await handler({ action: "pr_status" }));

    const ghCalls = calls.filter((c) => c.program === "gh");
    assert.ok(ghCalls.length > 0);
    for (const call of ghCalls) {
      assert.equal(call.args[0], "pr");
      assert.ok(["view", "checks"].includes(call.args[1]), `unexpected gh verb ${call.args[1]}`);
    }
    assert.equal(body.available, true);
    assert.equal(body.pr.number, 7);
    assert.equal(body.failing_checks, 0);
    assert.match(body.read_only, /denied by policy/);
  });

  it("counts failing checks", async () => {
    const { handler } = harness((p, a) => {
      if (p === "gh" && a[1] === "view") return { stdout: JSON.stringify({ number: 7 }) };
      if (p === "gh" && a[1] === "checks") {
        return {
          exitCode: 1,
          stdout: JSON.stringify([
            { name: "ci", state: "FAILURE" },
            { name: "lint", state: "SUCCESS" },
            { name: "skip", state: "SKIPPED" },
          ]),
        };
      }
      return CLEAN_REPO(p, a);
    });

    const body = payload(await handler({ action: "pr_status" }));

    assert.equal(body.failing_checks, 1, "SKIPPED and SUCCESS must not count as failures");
  });

  it("degrades gracefully when there is no PR", async () => {
    const { handler } = harness((p, a) =>
      p === "gh" ? { exitCode: 1, stderr: "no pull requests found for branch" } : CLEAN_REPO(p, a)
    );

    const result = await handler({ action: "pr_status" });
    const body = payload(result);

    assert.equal(body.available, false);
    assert.match(body.detail, /no pull requests/);
  });
});

describe("git_release — errors", () => {
  it("surfaces a git log failure rather than reporting zero commits", async () => {
    const { handler } = harness((p, a) => {
      if (p !== "git") return undefined;
      if (a[0] === "describe") return { stdout: "v0.1.0" };
      if (a[0] === "log") return { exitCode: 128, stderr: "fatal: bad revision" };
      return CLEAN_REPO(p, a);
    });

    const body = payload(await handler({ action: "next_version" }));

    assert.equal(body.errors.length, 1);
    assert.equal(body.errors[0].exit_code, 128);
  });

  it("rejects a flag-like since_tag", async () => {
    const { calls, handler } = harness(CLEAN_REPO);

    const result = await handler({ action: "changelog", since_tag: "--upload-pack=evil" });

    assert.equal(result.isError, true);
    assert.equal(payload(result).error, "invalid_arguments");
    assert.equal(calls.length, 0);
  });
});
