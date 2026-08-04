/**
 * git_fleet — ADR-0062
 *
 * O que se fixa aqui: o survey não faz fetch sem ser pedido, um repo a falhar
 * não derruba os outros, e o parse do porcelain v2 não confunde staged com
 * unstaged.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createGitFleetHandler,
  parsePorcelainV2,
  gitFleetTestHelpers,
} from "../../src/tools/git/fleet.js";
import { createGitOpsContext, type GitAuditEntry, type RunCommand } from "../../src/tools/git/exec.js";
import { resetWorkspaceCacheForTests } from "../../src/config/workspace.js";

const ENV_KEYS = ["SECURELLM_ECOSYSTEM_ROOT", "PROJECT_ROOT", "HOME"] as const;
let saved: Record<string, string | undefined>;
let tmp: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmp = mkdtempSync(path.join(os.tmpdir(), "securellm-fleet-"));
  process.env.SECURELLM_ECOSYSTEM_ROOT = tmp;
  resetWorkspaceCacheForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(tmp, { recursive: true, force: true });
  resetWorkspaceCacheForTests();
});

function makeRepos(...names: string[]) {
  for (const name of names) mkdirSync(path.join(tmp, name, ".git"), { recursive: true });
}

interface Call {
  args: string[];
  cwd: string;
}

function harness(
  reply: (repo: string, args: string[]) => Partial<Awaited<ReturnType<RunCommand>>> | undefined
) {
  const calls: Call[] = [];
  const audits: GitAuditEntry[] = [];
  const run: RunCommand = async (_program, args, options) => {
    calls.push({ args, cwd: options.cwd });
    const repo = path.basename(options.cwd);
    return { exitCode: 0, stdout: "", stderr: "", ...(reply(repo, args) ?? {}) };
  };
  const ctx = createGitOpsContext({
    run,
    ecosystemRoot: tmp,
    audit: (e) => audits.push(e),
    now: () => new Date("2026-08-04T12:00:00.000Z"),
  });
  return { calls, audits, handler: createGitFleetHandler(ctx) };
}

function payload(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

const STATUS_DIRTY = [
  "# branch.oid abc123",
  "# branch.head dev",
  "# branch.upstream origin/dev",
  "# branch.ab +3 -1",
  "1 M. N... 100644 100644 100644 aaa bbb staged-only.ts",
  "1 .M N... 100644 100644 100644 aaa bbb unstaged-only.ts",
  "1 MM N... 100644 100644 100644 aaa bbb both.ts",
  "? untracked.ts",
].join("\n");

describe("parsePorcelainV2", () => {
  it("separates staged from unstaged from untracked", () => {
    const parsed = parsePorcelainV2(STATUS_DIRTY, 10);

    assert.equal(parsed.branch, "dev");
    assert.equal(parsed.upstream, "origin/dev");
    assert.equal(parsed.ahead, 3);
    assert.equal(parsed.behind, 1);
    assert.equal(parsed.staged, 2, "M. and MM are staged");
    assert.equal(parsed.unstaged, 2, ".M and MM are unstaged");
    assert.equal(parsed.untracked, 1);
  });

  it("detects a detached HEAD", () => {
    const parsed = parsePorcelainV2("# branch.oid abc\n# branch.head (detached)\n", 10);

    assert.equal(parsed.detached, true);
    assert.equal(parsed.branch, null);
  });

  it("reports zero when there is no upstream", () => {
    const parsed = parsePorcelainV2("# branch.head main\n", 10);

    assert.equal(parsed.upstream, null);
    assert.equal(parsed.ahead, 0);
    assert.equal(parsed.behind, 0);
  });

  it("caps the dirty sample", () => {
    const many = ["# branch.head main", ...Array.from({ length: 30 }, (_, i) => `? f${i}.ts`)].join("\n");

    assert.equal(parsePorcelainV2(many, 5).samples.length, 5);
    assert.equal(parsePorcelainV2(many, 5).untracked, 30, "the count is not capped, only the sample");
  });

  it("counts unmerged entries as both staged and unstaged", () => {
    const parsed = parsePorcelainV2("# branch.head main\nu UU N... 1 2 3 a b c conflict.ts\n", 10);

    assert.equal(parsed.staged, 1);
    assert.equal(parsed.unstaged, 1);
  });

  it("survives empty output", () => {
    assert.equal(parsePorcelainV2("", 10).staged, 0);
  });
});

describe("git_fleet — refresh policy", () => {
  it("never fetches by default", async () => {
    makeRepos("alpha", "beta");
    const { calls, handler } = harness(() => undefined);

    const body = payload(await handler({}));

    assert.equal(calls.filter((c) => c.args[0] === "fetch").length, 0);
    assert.equal(body.refreshed, false);
    assert.match(body.freshness_note, /cached remote-tracking refs/);
  });

  it("fetches in exactly one fixed, guarded form when asked", async () => {
    makeRepos("alpha");
    const { calls, audits, handler } = harness(() => undefined);

    await handler({ refresh: true });

    const fetches = calls.filter((c) => c.args[0] === "fetch");
    assert.equal(fetches.length, 1);
    assert.deepEqual(fetches[0].args, ["fetch", "--quiet", "--no-tags"]);

    const fetchAudit = audits.find((a) => a.action === "refresh");
    assert.ok(fetchAudit, "a fetch writes remote-tracking refs and must be audited");
    assert.equal(fetchAudit.status, "executed");
    assert.equal(fetchAudit.mode, "confirmed");
  });

  it("does not claim tags are unpublished when it cannot know", async () => {
    // As refs locais não guardam que tags o remote conhece: refs/remotes/ tem
    // branches. Sem perguntar ao remote, a resposta honesta é "não verificado".
    makeRepos("tagged");
    const { calls, handler } = harness((_repo, args) =>
      args[0] === "for-each-ref" && args[2] === "refs/tags/"
        ? { stdout: "v0.1.0\nv0.2.0\n" }
        : undefined
    );

    const body = payload(await handler({ include_clean: true }));

    assert.equal(calls.filter((c) => c.args[0] === "ls-remote").length, 0);
    assert.equal(body.repos[0].tags_total, 2);
    assert.equal(body.repos[0].latest_tag, "v0.2.0");
    assert.deepEqual(body.repos[0].local_only_tags, []);
    assert.equal(body.repos[0].tags_checked_against_remote, false);
    assert.equal(body.totals.local_only_tags, 0);
  });

  it("checks tags against the remote only when refreshing", async () => {
    makeRepos("tagged");
    const { calls, handler } = harness((_repo, args) => {
      if (args[0] === "for-each-ref" && args[2] === "refs/tags/") {
        return { stdout: "v0.1.0\nv0.2.0\n" };
      }
      if (args[0] === "ls-remote") {
        return { stdout: "abc123\trefs/tags/v0.1.0\ndef456\trefs/tags/v0.1.0^{}\n" };
      }
      return undefined;
    });

    const body = payload(await handler({ refresh: true, include_clean: true }));

    assert.equal(calls.filter((c) => c.args[0] === "ls-remote").length, 1);
    assert.equal(body.repos[0].tags_checked_against_remote, true);
    assert.deepEqual(body.repos[0].local_only_tags, ["v0.2.0"], "v0.1.0 is published; the ^{} peel must not confuse it");
  });

  it("reports how stale the cached refs are", async () => {
    makeRepos("alpha");
    const { handler } = harness(() => undefined);

    const body = payload(await handler({ include_clean: true }));

    // Sem FETCH_HEAD o campo é null, não zero: "nunca houve fetch" e "acabou
    // de fazer fetch" não podem parecer a mesma coisa.
    assert.equal(body.repos[0].upstream_ref_age_seconds, null);
  });
});

describe("git_fleet — aggregation", () => {
  function threeRepos() {
    makeRepos("dirty-repo", "clean-repo", "behind-repo");
    return harness((repo, args) => {
      if (args[0] === "status") {
        if (repo === "dirty-repo") return { stdout: STATUS_DIRTY };
        if (repo === "behind-repo") {
          return {
            stdout: "# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -5\n",
          };
        }
        return { stdout: "# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n" };
      }
      if (args[0] === "log") {
        return { stdout: `abc1234\x1f2026-08-01T00:00:00Z\x1flast commit in ${repo}` };
      }
      return undefined;
    });
  }

  it("totals dirty, ahead and behind across the fleet", async () => {
    const { handler } = threeRepos();

    const body = payload(await handler({ action: "status" }));

    assert.equal(body.totals.repos, 3);
    assert.equal(body.totals.dirty, 1);
    assert.equal(body.totals.ahead, 1);
    assert.equal(body.totals.behind, 2, "dirty-repo is behind 1 and behind-repo behind 5");
  });

  it("hides clean repos unless asked", async () => {
    const { handler } = threeRepos();

    const hidden = payload(await handler({ action: "status" }));
    const shown = payload(await handler({ action: "status", include_clean: true }));

    assert.ok(!hidden.repos.some((r: { name: string }) => r.name === "clean-repo"));
    assert.equal(shown.repos.length, 3);
  });

  it("filters to unpushed and to behind", async () => {
    const { handler } = threeRepos();

    const unpushed = payload(await handler({ action: "unpushed" }));
    const behind = payload(await handler({ action: "behind" }));

    assert.deepEqual(unpushed.repos.map((r: { name: string }) => r.name), ["dirty-repo"]);
    assert.deepEqual(
      behind.repos.map((r: { name: string }) => r.name).sort(),
      ["behind-repo", "dirty-repo"]
    );
  });

  it("omits the per-repo array for the summary action", async () => {
    const { handler } = threeRepos();

    const body = payload(await handler({ action: "summary" }));

    assert.equal(body.repos, undefined);
    assert.equal(body.totals.repos, 3);
  });

  it("restricts to the requested repos and names the unknown ones", async () => {
    const { handler } = threeRepos();

    const body = payload(await handler({ action: "status", repos: ["dirty-repo", "ghost"], include_clean: true }));

    assert.deepEqual(body.repos.map((r: { name: string }) => r.name), ["dirty-repo"]);
    assert.deepEqual(body.unknown_repos, ["ghost"]);
    assert.ok(body.known_repos.includes("clean-repo"));
  });

  it("honours exclude", async () => {
    const { handler } = threeRepos();

    const body = payload(await handler({ action: "status", exclude: ["dirty-repo"], include_clean: true }));

    assert.ok(!body.repos.some((r: { name: string }) => r.name === "dirty-repo"));
    assert.equal(body.totals.repos, 2);
  });
});

describe("git_fleet — resilience", () => {
  it("keeps surveying when one repo's git fails", async () => {
    makeRepos("healthy", "broken");
    const { handler } = harness((repo, args) => {
      if (repo === "broken" && args[0] === "status") {
        return { exitCode: 128, stderr: "fatal: bad object HEAD" };
      }
      if (args[0] === "status") {
        return { stdout: "# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -0\n" };
      }
      return undefined;
    });

    const body = payload(await handler({ action: "status", include_clean: true }));

    assert.equal(body.totals.repos, 2, "the broken repo must still be reported");
    assert.equal(body.totals.errors, 1);

    const broken = body.repos.find((r: { name: string }) => r.name === "broken");
    assert.equal(broken.errors[0].exit_code, 128);

    const healthy = body.repos.find((r: { name: string }) => r.name === "healthy");
    assert.equal(healthy.ahead, 2, "the healthy repo's data must survive intact");
  });

  it("returns an empty but valid report when no repos exist", async () => {
    const { handler } = harness(() => undefined);

    const body = payload(await handler({}));

    assert.equal(body.totals.repos, 0);
    assert.ok(Array.isArray(body.recommendations));
  });

  it("rejects invalid arguments before running anything", async () => {
    makeRepos("alpha");
    const { calls, handler } = harness(() => undefined);

    const result = await handler({ action: "nonsense" });

    assert.equal(result.isError, true);
    assert.equal(payload(result).error, "invalid_arguments");
    assert.equal(calls.length, 0);
  });
});

describe("git_fleet — concurrency", () => {
  it("never exceeds the configured limit and preserves order", async () => {
    const { mapWithConcurrency } = gitFleetTestHelpers;
    let inFlight = 0;
    let peak = 0;

    const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 2;
    });

    assert.ok(peak <= 3, `peak concurrency was ${peak}`);
    assert.deepEqual(results, [2, 4, 6, 8, 10, 12, 14]);
  });
});
