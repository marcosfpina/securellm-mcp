/**
 * Workspace roots — ADR-0062 (B4)
 *
 * O bug original não foi "a constante estava errada": foi que uma constante
 * errada não tinha forma de falhar. Estes testes fixam a propriedade que
 * substitui a constante — um candidato só é escolhido se contiver repos git.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getEcosystemRoot,
  listEcosystemRepos,
  resolveEcosystemProject,
  resolveAdrLedgerPath,
  resetWorkspaceCacheForTests,
} from "../../src/config/workspace.js";

const ENV_KEYS = ["SECURELLM_ECOSYSTEM_ROOT", "ADR_REPO_PATH", "HOME"] as const;

let saved: Record<string, string | undefined>;
let tmp: string;

/** Cria `<root>/<name>/.git` para simular um clone. */
function fakeRepo(root: string, name: string): string {
  const repo = path.join(root, name);
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  return repo;
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmp = mkdtempSync(path.join(os.tmpdir(), "securellm-workspace-"));
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

describe("getEcosystemRoot", () => {
  it("honours SECURELLM_ECOSYSTEM_ROOT above every probe", () => {
    const explicit = path.join(tmp, "somewhere-else");
    mkdirSync(explicit, { recursive: true });
    process.env.SECURELLM_ECOSYSTEM_ROOT = explicit;

    assert.equal(getEcosystemRoot(), explicit);
  });

  it("picks the first candidate that actually contains git repos", () => {
    process.env.HOME = tmp;
    delete process.env.SECURELLM_ECOSYSTEM_ROOT;

    // ~/master existe mas está vazio; ~/Projects/master/deploy tem repos.
    // Este é exatamente o cenário invertido do bug original.
    mkdirSync(path.join(tmp, "master"), { recursive: true });
    const deploy = path.join(tmp, "Projects", "master", "deploy");
    mkdirSync(deploy, { recursive: true });
    for (const name of ["alpha", "beta", "gamma"]) fakeRepo(deploy, name);

    assert.equal(getEcosystemRoot(), deploy);
  });

  it("prefers ~/master when it holds the repos", () => {
    process.env.HOME = tmp;
    delete process.env.SECURELLM_ECOSYSTEM_ROOT;

    const master = path.join(tmp, "master");
    mkdirSync(master, { recursive: true });
    for (const name of ["alpha", "beta", "gamma"]) fakeRepo(master, name);

    assert.equal(getEcosystemRoot(), master);
  });

  it("does not accept a directory with only a couple of repos", () => {
    process.env.HOME = tmp;
    delete process.env.SECURELLM_ECOSYSTEM_ROOT;

    // Dois repos não chegam — é o que distingue uma raiz de ecossistema de um
    // directório qualquer que por acaso tem um clone lá dentro.
    const master = path.join(tmp, "master");
    mkdirSync(master, { recursive: true });
    fakeRepo(master, "only-one");
    fakeRepo(master, "only-two");

    const deploy = path.join(tmp, "Projects", "master", "deploy");
    mkdirSync(deploy, { recursive: true });
    for (const name of ["a", "b", "c", "d"]) fakeRepo(deploy, name);

    assert.equal(getEcosystemRoot(), deploy);
  });

  it("falls back deterministically to ~/master when nothing qualifies", () => {
    process.env.HOME = tmp;
    delete process.env.SECURELLM_ECOSYSTEM_ROOT;

    assert.equal(getEcosystemRoot(), path.join(tmp, "master"));
  });

  it("memoizes, and resetWorkspaceCacheForTests clears the memo", () => {
    const first = path.join(tmp, "first");
    const second = path.join(tmp, "second");
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });

    process.env.SECURELLM_ECOSYSTEM_ROOT = first;
    assert.equal(getEcosystemRoot(), first);

    process.env.SECURELLM_ECOSYSTEM_ROOT = second;
    assert.equal(getEcosystemRoot(), first, "memo should survive an env change");

    resetWorkspaceCacheForTests();
    assert.equal(getEcosystemRoot(), second);
  });
});

describe("listEcosystemRepos", () => {
  it("lists only git directories, sorted, skipping dotfiles and plain dirs", () => {
    process.env.SECURELLM_ECOSYSTEM_ROOT = tmp;

    fakeRepo(tmp, "zeta");
    fakeRepo(tmp, "alpha");
    mkdirSync(path.join(tmp, "not-a-repo"), { recursive: true });
    mkdirSync(path.join(tmp, ".hidden-repo", ".git"), { recursive: true });
    writeFileSync(path.join(tmp, "loose-file.txt"), "x");

    assert.deepEqual(
      listEcosystemRepos().map((r) => r.name),
      ["alpha", "zeta"]
    );
  });

  it("treats a .git file (linked worktree) as a repo", () => {
    process.env.SECURELLM_ECOSYSTEM_ROOT = tmp;

    const wt = path.join(tmp, "worktree-style");
    mkdirSync(wt, { recursive: true });
    writeFileSync(path.join(wt, ".git"), "gitdir: /elsewhere/.git/worktrees/x");

    assert.deepEqual(
      listEcosystemRepos().map((r) => r.name),
      ["worktree-style"]
    );
  });

  it("returns an empty list instead of throwing when the root is missing", () => {
    process.env.SECURELLM_ECOSYSTEM_ROOT = path.join(tmp, "does-not-exist");

    assert.deepEqual(listEcosystemRepos(), []);
  });
});

describe("resolveEcosystemProject", () => {
  it("resolves a known repo and returns null for an unknown one", () => {
    process.env.SECURELLM_ECOSYSTEM_ROOT = tmp;
    const alpha = fakeRepo(tmp, "alpha");

    assert.equal(resolveEcosystemProject("alpha"), alpha);
    assert.equal(resolveEcosystemProject("nope"), null);
  });
});

describe("resolveAdrLedgerPath", () => {
  it("honours ADR_REPO_PATH above everything", () => {
    process.env.ADR_REPO_PATH = "/explicit/ledger";
    process.env.SECURELLM_ECOSYSTEM_ROOT = tmp;

    assert.equal(resolveAdrLedgerPath(), "/explicit/ledger");
  });

  it("uses <root>/adr-ledger when it has an ADR layout", () => {
    delete process.env.ADR_REPO_PATH;
    process.env.SECURELLM_ECOSYSTEM_ROOT = tmp;
    mkdirSync(path.join(tmp, "adr-ledger", "adr"), { recursive: true });

    assert.equal(resolveAdrLedgerPath(), path.join(tmp, "adr-ledger"));
  });

  it("falls back to a legacy location that still has the ledger", () => {
    delete process.env.ADR_REPO_PATH;
    delete process.env.SECURELLM_ECOSYSTEM_ROOT;
    process.env.HOME = tmp;

    // Raiz eleita: ~/master (3 repos). Ledger: ainda no sítio antigo.
    const master = path.join(tmp, "master");
    mkdirSync(master, { recursive: true });
    for (const name of ["a", "b", "c"]) fakeRepo(master, name);

    const legacyLedger = path.join(tmp, "Projects", "master", "deploy", "adr-ledger");
    mkdirSync(path.join(legacyLedger, "docs", "adr"), { recursive: true });

    assert.equal(resolveAdrLedgerPath(), legacyLedger);
  });

  it("returns the primary candidate when no layout is found anywhere", () => {
    delete process.env.ADR_REPO_PATH;
    process.env.SECURELLM_ECOSYSTEM_ROOT = tmp;

    assert.equal(resolveAdrLedgerPath(), path.join(tmp, "adr-ledger"));
  });
});
