/**
 * Conventional commits — ADR-0062
 *
 * Parsing puro: sem git, sem I/O. É o gate do changelog e do version bump, e
 * o sítio onde o separador \x1f prova que resolve o bug do "|".
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  parseCommitLog,
  parseConventional,
  parseCommits,
  parseVersion,
  formatVersion,
  computeBump,
  applyBump,
  buildChangelog,
  renderChangelogMarkdown,
  type RawCommit,
} from "../../src/tools/git/conventional.js";

function record(fields: string[]): string {
  return fields.join("\x1f") + "\x1e";
}

function raw(subject: string, body = ""): RawCommit {
  return { hash: "f".repeat(40), short: "abc1234", date: "2026-08-01T00:00:00Z", author: "A", subject, body };
}

describe("parseCommitLog", () => {
  it("keeps a subject containing a pipe intact", () => {
    // O formato antigo "%h|%aI|%an|%s" partia em "|" e corrompia tudo a
    // seguir ao primeiro pipe da mensagem.
    const out = record(["h", "abc1234", "2026-08-01T00:00:00Z", "Kernel Core", "fix: a | b", ""]);

    const [commit] = parseCommitLog(out);

    assert.equal(commit.subject, "fix: a | b");
    assert.equal(commit.author, "Kernel Core");
  });

  it("keeps a multiline body whole", () => {
    const body = "line one\nline two\n\nBREAKING CHANGE: the API moved";
    const out = record(["h", "s", "2026-08-01T00:00:00Z", "A", "feat: x", body]);

    const [commit] = parseCommitLog(out);

    assert.equal(commit.body, body);
    assert.match(commit.body, /BREAKING CHANGE/);
  });

  it("parses several records and drops empty trailing ones", () => {
    const out = record(["h1", "s1", "d", "A", "feat: one", ""]) + "\n" + record(["h2", "s2", "d", "B", "fix: two", ""]) + "\n";

    const commits = parseCommitLog(out);

    assert.equal(commits.length, 2);
    assert.deepEqual(commits.map((c) => c.subject), ["feat: one", "fix: two"]);
  });

  it("returns nothing for empty output rather than a bogus record", () => {
    assert.deepEqual(parseCommitLog(""), []);
    assert.deepEqual(parseCommitLog("\n\n"), []);
  });
});

describe("parseConventional", () => {
  it("splits type, scope and description", () => {
    const parsed = parseConventional(raw("feat(providers): add llamacpp support"));

    assert.equal(parsed.conventional, true);
    assert.equal(parsed.type, "feat");
    assert.equal(parsed.scope, "providers");
    assert.equal(parsed.description, "add llamacpp support");
    assert.deepEqual(parsed.violations, []);
  });

  it("handles a missing scope", () => {
    const parsed = parseConventional(raw("docs: update readme"));

    assert.equal(parsed.type, "docs");
    assert.equal(parsed.scope, null);
  });

  it("detects breaking via the ! marker", () => {
    const parsed = parseConventional(raw("feat(api)!: drop v1 endpoints"));

    assert.equal(parsed.breaking, true);
    assert.deepEqual(parsed.violations, []);
  });

  it("detects breaking via a BREAKING CHANGE footer", () => {
    const parsed = parseConventional(raw("feat: x", "BREAKING CHANGE: config format changed"));

    assert.equal(parsed.breaking, true);
  });

  it("flags a non-conventional subject", () => {
    const parsed = parseConventional(raw("fixed the thing"));

    assert.equal(parsed.conventional, false);
    assert.equal(parsed.violations.length, 1);
  });

  it("exempts merge and deploy commits from the lint", () => {
    for (const subject of [
      "Merge branch 'dev' into main",
      "Merge pull request #12 from x/y",
      "pages: deploy",
    ]) {
      const parsed = parseConventional(raw(subject));
      assert.equal(parsed.conventional, false);
      assert.deepEqual(parsed.violations, [], `"${subject}" should be exempt`);
    }
  });

  it("flags an unknown type, a trailing period, and a capitalised description", () => {
    assert.match(parseConventional(raw("wibble: x")).violations[0], /unknown type/);
    assert.match(parseConventional(raw("feat: adds a thing.")).violations[0], /period/);
    assert.match(parseConventional(raw("feat: Adds a thing")).violations[0], /capital/);
  });

  it("flags an over-long subject", () => {
    const parsed = parseConventional(raw(`feat: ${"x".repeat(120)}`));

    assert.ok(parsed.violations.some((v) => /exceeds/.test(v)));
  });

  it("never throws on malformed input", () => {
    assert.doesNotThrow(() => parseConventional(raw("")));
    assert.doesNotThrow(() => parseConventional(raw(":")));
    assert.doesNotThrow(() => parseConventional(raw("feat(:")));
  });
});

describe("parseVersion / formatVersion", () => {
  it("accepts a v prefix and round-trips", () => {
    const parts = parseVersion("v1.2.3");
    assert.deepEqual(parts, { prefix: "v", major: 1, minor: 2, patch: 3, suffix: "" });
    assert.equal(formatVersion(parts!), "v1.2.3");
  });

  it("accepts a bare version", () => {
    assert.equal(formatVersion(parseVersion("0.1.0")!), "0.1.0");
  });

  it("captures a prerelease suffix", () => {
    assert.equal(parseVersion("v1.0.0-rc.1")!.suffix, "-rc.1");
  });

  it("returns null for a non-semver tag", () => {
    assert.equal(parseVersion("release-2026-08"), null);
    assert.equal(parseVersion("v1.2"), null);
  });
});

describe("computeBump", () => {
  const feat = parseConventional(raw("feat: a"));
  const fix = parseConventional(raw("fix: b"));
  const chore = parseConventional(raw("chore: c"));
  const breaking = parseConventional(raw("feat!: d"));

  it("maps fix to patch, feat to minor", () => {
    assert.equal(computeBump([fix], { currentMajor: 1, zeroMajorPolicy: true }).bump, "patch");
    assert.equal(computeBump([feat, fix], { currentMajor: 1, zeroMajorPolicy: true }).bump, "minor");
  });

  it("maps breaking to major once past 1.0.0", () => {
    assert.equal(computeBump([breaking], { currentMajor: 1, zeroMajorPolicy: true }).bump, "major");
  });

  it("suppresses the major bump below 1.0.0 under the zero-major policy", () => {
    const result = computeBump([breaking], { currentMajor: 0, zeroMajorPolicy: true });

    assert.equal(result.bump, "minor");
    assert.ok(result.drivers.some((d) => /zero-major/.test(d)));
  });

  it("honours a disabled zero-major policy", () => {
    assert.equal(computeBump([breaking], { currentMajor: 0, zeroMajorPolicy: false }).bump, "major");
  });

  it("returns none when nothing releasable happened", () => {
    assert.equal(computeBump([chore], { currentMajor: 1, zeroMajorPolicy: true }).bump, "none");
    assert.equal(computeBump([], { currentMajor: 1, zeroMajorPolicy: true }).bump, "none");
  });

  it("explains itself through drivers", () => {
    const result = computeBump([feat, fix], { currentMajor: 1, zeroMajorPolicy: true });
    assert.ok(result.drivers.length > 0);
  });
});

describe("applyBump", () => {
  const base = parseVersion("v1.2.3")!;

  it("resets lower components", () => {
    assert.equal(formatVersion(applyBump(base, "major")), "v2.0.0");
    assert.equal(formatVersion(applyBump(base, "minor")), "v1.3.0");
    assert.equal(formatVersion(applyBump(base, "patch")), "v1.2.4");
    assert.equal(formatVersion(applyBump(base, "none")), "v1.2.3");
  });

  it("drops a prerelease suffix on bump", () => {
    assert.equal(formatVersion(applyBump(parseVersion("v1.0.0-rc.1")!, "patch")), "v1.0.1");
  });
});

describe("buildChangelog", () => {
  const commits = parseCommits(
    [
      record(["h1", "aaa1111", "d", "A", "feat(api): add endpoint", ""]),
      record(["h2", "bbb2222", "d", "B", "fix: correct off-by-one", ""]),
      record(["h3", "ccc3333", "d", "C", "feat!: drop v1", "BREAKING CHANGE: gone"]),
      record(["h4", "ddd4444", "d", "D", "random unstructured message", ""]),
    ].join("\n")
  );

  it("groups by type in presentation order", () => {
    const log = buildChangelog(commits);

    assert.deepEqual(log.sections.map((s) => s.type), ["feat", "fix"]);
    assert.equal(log.sections[0].commits.length, 2);
  });

  it("collects breaking changes separately", () => {
    assert.equal(buildChangelog(commits).breaking.length, 1);
  });

  it("does not discard unconventional commits", () => {
    const log = buildChangelog(commits);

    assert.equal(log.unconventional.length, 1);
    assert.equal(log.unconventional[0].subject, "random unstructured message");
    assert.equal(log.total, 4);
  });

  it("renders markdown with a breaking section first", () => {
    const md = renderChangelogMarkdown(buildChangelog(commits), "v0.2.0");

    assert.match(md, /^## v0\.2\.0/);
    assert.ok(md.indexOf("BREAKING") < md.indexOf("### Features"));
    assert.match(md, /\*\*api:\*\* add endpoint \(aaa1111\)/);
    assert.match(md, /### Other/);
  });

  it("renders an empty changelog without crashing", () => {
    const md = renderChangelogMarkdown(buildChangelog([]), "v0.0.1");
    assert.match(md, /## v0\.0\.1/);
  });
});
