/**
 * Conventional commits — ADR-0062
 *
 * Parsing partilhado entre `git_sherlock` (commit_lint, release_readiness) e
 * `git_release` (changelog, next_version). Uma só definição do que conta como
 * commit convencional evita que o lint e o changelog discordem.
 *
 * O formato de log usado em todo o lado é:
 *   --format=%H%x1f%h%x1f%aI%x1f%an%x1f%s%x1f%b%x1e
 *
 * \x1f (unit separator) entre campos e \x1e (record separator) entre commits:
 * são caracteres de controlo que não aparecem em mensagens de commit, ao
 * contrário do "|" que o código original usava e que qualquer subject podia
 * conter.
 */

export const COMMIT_LOG_FORMAT = "--format=%H%x1f%h%x1f%aI%x1f%an%x1f%s%x1f%b%x1e";

/** Tipos aceites. Alinhado com o enum de `git_workbench.commit`. */
export const CONVENTIONAL_TYPES = [
  "feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci",
  "chore", "revert",
] as const;

export type ConventionalType = (typeof CONVENTIONAL_TYPES)[number];

export interface RawCommit {
  hash: string;
  short: string;
  date: string;
  author: string;
  subject: string;
  body: string;
}

export interface ParsedCommit extends RawCommit {
  conventional: boolean;
  type: string | null;
  scope: string | null;
  description: string | null;
  breaking: boolean;
  /** Motivos pelos quais o commit não passa no lint. Vazio = conforme. */
  violations: string[];
}

/** `type(scope)!: description` — scope e `!` opcionais. */
const SUBJECT_RE = /^([a-z]+)(?:\(([^)]+)\))?(!)?:\s+(.+)$/;

const MAX_SUBJECT_LENGTH = 100;

/** Divide o stdout de um `git log` com COMMIT_LOG_FORMAT em registos. */
export function parseCommitLog(stdout: string): RawCommit[] {
  return stdout
    .split("\x1e")
    .map((record) => record.replace(/^\r?\n/, ""))
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const [hash = "", short = "", date = "", author = "", subject = "", body = ""] =
        record.split("\x1f");
      return { hash, short, date, author, subject, body: body.trim() };
    });
}

/**
 * Classifica um commit. Nunca lança: um commit malformado é um commit com
 * violações, não um erro de execução.
 */
/**
 * Commits gerados por máquinas ou pelo próprio git. Não são falhas de autoria
 * e não devem contar contra a taxa de conformidade. A isenção vale nos dois
 * ramos: "pages: deploy" casa a forma de um commit convencional mas o seu
 * "tipo" não é um tipo — sem esta verificação seria reportado como
 * "unknown type".
 */
function isExemptFromLint(subject: string): boolean {
  return (
    /^Merge (branch|pull request|remote-tracking)/.test(subject) ||
    /^Revert "/.test(subject) ||
    /^(pages|deploy): /.test(subject)
  );
}

export function parseConventional(commit: RawCommit): ParsedCommit {
  const violations: string[] = [];
  const exempt = isExemptFromLint(commit.subject);
  const match = exempt ? null : commit.subject.match(SUBJECT_RE);

  if (!match) {
    if (!exempt) {
      violations.push("subject does not match 'type(scope): description'");
    }

    return {
      ...commit,
      conventional: false,
      type: null,
      scope: null,
      description: null,
      breaking: /BREAKING[ -]CHANGE/.test(commit.body),
      violations,
    };
  }

  const [, type, scope = null, bang, description] = match;

  if (!(CONVENTIONAL_TYPES as readonly string[]).includes(type)) {
    violations.push(`unknown type "${type}"`);
  }
  if (commit.subject.length > MAX_SUBJECT_LENGTH) {
    violations.push(`subject exceeds ${MAX_SUBJECT_LENGTH} characters`);
  }
  if (/\.$/.test(description)) {
    violations.push("description ends with a period");
  }
  if (/^[A-Z]/.test(description)) {
    violations.push("description starts with a capital letter");
  }

  return {
    ...commit,
    conventional: true,
    type,
    scope,
    description,
    breaking: bang === "!" || /^BREAKING[ -]CHANGE:/m.test(commit.body),
    violations,
  };
}

export function parseCommits(stdout: string): ParsedCommit[] {
  return parseCommitLog(stdout).map(parseConventional);
}

// ─── SemVer ──────────────────────────────────────────────────────────────────

export type Bump = "major" | "minor" | "patch" | "none";

export interface VersionParts {
  major: number;
  minor: number;
  patch: number;
  prefix: string;
  suffix: string;
}

/** Aceita `v1.2.3`, `1.2.3`, `v1.2.3-rc.1`. Devolve null se não for semver. */
export function parseVersion(tag: string): VersionParts | null {
  const match = tag.trim().match(/^(v?)(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!match) return null;
  const [, prefix, major, minor, patch, suffix] = match;
  return {
    prefix,
    major: parseInt(major, 10),
    minor: parseInt(minor, 10),
    patch: parseInt(patch, 10),
    suffix,
  };
}

export function formatVersion(parts: VersionParts): string {
  return `${parts.prefix}${parts.major}.${parts.minor}.${parts.patch}`;
}

/**
 * Bump implicado por um conjunto de commits.
 *
 * `zeroMajorPolicy` (default) implementa a convenção semver de que, abaixo de
 * 1.0.0, a API é instável: um breaking change sobe o minor em vez do major,
 * para não gastar o 1.0.0 antes de o projeto estar pronto.
 */
export function computeBump(
  commits: ParsedCommit[],
  opts: { currentMajor: number; zeroMajorPolicy: boolean }
): { bump: Bump; drivers: string[] } {
  const drivers: string[] = [];
  let hasBreaking = false;
  let hasFeature = false;
  let hasFix = false;

  for (const commit of commits) {
    if (commit.breaking) {
      hasBreaking = true;
      drivers.push(`breaking: ${commit.short} ${commit.subject}`);
    } else if (commit.type === "feat") {
      hasFeature = true;
    } else if (commit.type === "fix" || commit.type === "perf") {
      hasFix = true;
    }
  }

  if (hasFeature) drivers.push(`${commits.filter((c) => c.type === "feat").length} feat commit(s)`);
  if (hasFix) {
    const count = commits.filter((c) => c.type === "fix" || c.type === "perf").length;
    drivers.push(`${count} fix/perf commit(s)`);
  }

  if (hasBreaking) {
    const suppressed = opts.zeroMajorPolicy && opts.currentMajor === 0;
    if (suppressed) {
      drivers.push("zero-major policy: breaking change bumps minor while < 1.0.0");
      return { bump: "minor", drivers };
    }
    return { bump: "major", drivers };
  }
  if (hasFeature) return { bump: "minor", drivers };
  if (hasFix) return { bump: "patch", drivers };
  return { bump: "none", drivers };
}

export function applyBump(parts: VersionParts, bump: Bump): VersionParts {
  switch (bump) {
    case "major":
      return { ...parts, major: parts.major + 1, minor: 0, patch: 0, suffix: "" };
    case "minor":
      return { ...parts, minor: parts.minor + 1, patch: 0, suffix: "" };
    case "patch":
      return { ...parts, patch: parts.patch + 1, suffix: "" };
    case "none":
      return { ...parts, suffix: "" };
  }
}

// ─── Changelog ───────────────────────────────────────────────────────────────

const SECTION_TITLES: Record<string, string> = {
  feat: "Features",
  fix: "Bug Fixes",
  perf: "Performance",
  refactor: "Refactoring",
  docs: "Documentation",
  test: "Tests",
  build: "Build",
  ci: "CI",
  style: "Style",
  chore: "Chores",
  revert: "Reverts",
};

/** Ordem de apresentação: o que interessa ao leitor primeiro. */
const SECTION_ORDER = [
  "feat", "fix", "perf", "refactor", "docs", "test", "build", "ci", "style",
  "chore", "revert",
];

export interface ChangelogSection {
  type: string;
  title: string;
  commits: Array<{ short: string; scope: string | null; description: string; breaking: boolean }>;
}

export interface Changelog {
  sections: ChangelogSection[];
  breaking: Array<{ short: string; subject: string; body: string }>;
  unconventional: Array<{ short: string; subject: string }>;
  total: number;
}

export function buildChangelog(commits: ParsedCommit[]): Changelog {
  const grouped = new Map<string, ChangelogSection["commits"]>();
  const breaking: Changelog["breaking"] = [];
  const unconventional: Changelog["unconventional"] = [];

  for (const commit of commits) {
    if (commit.breaking) {
      breaking.push({ short: commit.short, subject: commit.subject, body: commit.body });
    }
    if (!commit.conventional || !commit.type) {
      unconventional.push({ short: commit.short, subject: commit.subject });
      continue;
    }
    const entry = {
      short: commit.short,
      scope: commit.scope,
      description: commit.description ?? commit.subject,
      breaking: commit.breaking,
    };
    const list = grouped.get(commit.type) ?? [];
    list.push(entry);
    grouped.set(commit.type, list);
  }

  const sections: ChangelogSection[] = [];
  const seen = new Set<string>();

  for (const type of SECTION_ORDER) {
    const list = grouped.get(type);
    if (!list?.length) continue;
    sections.push({ type, title: SECTION_TITLES[type] ?? type, commits: list });
    seen.add(type);
  }
  // Tipos desconhecidos mas bem formados não desaparecem do changelog.
  for (const [type, list] of grouped) {
    if (seen.has(type)) continue;
    sections.push({ type, title: SECTION_TITLES[type] ?? type, commits: list });
  }

  return { sections, breaking, unconventional, total: commits.length };
}

export function renderChangelogMarkdown(changelog: Changelog, heading: string): string {
  const lines: string[] = [`## ${heading}`, ""];

  if (changelog.breaking.length) {
    lines.push("### ⚠ BREAKING CHANGES", "");
    for (const item of changelog.breaking) {
      lines.push(`- ${item.subject} (${item.short})`);
    }
    lines.push("");
  }

  for (const section of changelog.sections) {
    lines.push(`### ${section.title}`, "");
    for (const commit of section.commits) {
      const scope = commit.scope ? `**${commit.scope}:** ` : "";
      lines.push(`- ${scope}${commit.description} (${commit.short})`);
    }
    lines.push("");
  }

  if (changelog.unconventional.length) {
    lines.push("### Other", "");
    for (const item of changelog.unconventional) {
      lines.push(`- ${item.subject} (${item.short})`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}
