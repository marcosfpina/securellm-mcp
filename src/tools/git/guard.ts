/**
 * Git write guard — ADR-0062
 *
 * Fronteira única entre um agente e o repo do operador. Puro, síncrono, sem
 * I/O: é a peça mais barata de testar e a que mais custa se estiver errada.
 *
 * Três princípios:
 *
 *   1. Allowlist, não denylist. Um subcomando ou flag desconhecido é negado.
 *      Falhar fechado significa que uma flag nova do git é rejeitada até ser
 *      revista — inconveniente e correto.
 *
 *   2. Posicional, não textual. `argv.includes("--force")` erra nas duas
 *      direções: recusa `commit -m "--force fix"` (uma mensagem legítima) e
 *      aceitaria `--force` escondido onde o parser não olha. Aqui um token é
 *      flag ou valor consoante o que o precede.
 *
 *   3. argv[0] tem de ser um subcomando. Isto sozinho elimina toda a classe
 *      de global options — `-c core.sshCommand=...`, `-C /etc`, `--git-dir=`,
 *      `--exec-path=` — porque todas precedem o subcomando.
 */

import { validatePath } from "../../security/path-validator.js";

// ─── Tipos ───────────────────────────────────────────────────────────────────

export type GuardDenialCode =
  | "denied_subcommand"
  | "unknown_subcommand"
  | "denied_flag"
  | "unknown_flag"
  | "global_option"
  | "path_escape"
  | "too_many_positionals"
  | "writes_disabled"
  | "nul_byte"
  | "empty_argv";

export type GuardDecision =
  | { allowed: true; mutating: boolean; argv: string[] }
  | {
      allowed: false;
      code: GuardDenialCode;
      offending: string;
      reason: string;
      policy: string;
    };

export interface GuardContext {
  repoRoot: string;
  ecosystemRoot: string;
}

interface SubcommandSpec {
  /** Muta o repo? Determina se dry_run/confirm são exigidos. */
  mutating: boolean;
  /** Flags aceites, em forma canónica (com os dashes). */
  allowedFlags: Set<string>;
  /** Flags cujo token seguinte é um VALOR, não uma flag nem um path. */
  valueFlags: Set<string>;
  /** Sub-verbos aceites como primeiro positional (ex.: `stash push`). */
  subVerbs?: Set<string>;
  /** Positionals são paths e devem ficar dentro do repo. */
  positionalsArePaths?: boolean;
  /** Positionals são paths e devem ficar dentro do ecossistema (worktree). */
  positionalsAreEcosystemPaths?: boolean;
  /** Limite de positionals. Ausente = sem limite. */
  maxPositionals?: number;
}

const POLICY = "ADR-0062 §Security";

// ─── Denylists ───────────────────────────────────────────────────────────────

/**
 * Subcomandos que este sistema nunca monta e nunca aceita. Distinguem-se de
 * "unknown" para dar ao chamador uma mensagem honesta: não é omissão, é
 * política.
 */
const GIT_DENIED_SUBCOMMANDS = new Set([
  "push", "pull", "reset", "clean", "rebase", "merge", "cherry-pick", "revert",
  "am", "apply", "restore", "checkout", "rm", "mv", "gc", "prune", "reflog",
  "update-ref", "filter-branch", "filter-repo", "remote", "submodule", "notes",
  "replace", "bundle", "daemon", "credential", "sparse-checkout", "init",
  "clone", "archive", "send-email", "request-pull", "hook",
]);

/** Flags rejeitadas em qualquer subcomando, curtas ou longas. */
const GLOBAL_DENIED_FLAGS = new Set([
  "-f", "--force", "--force-with-lease", "--force-if-includes",
  "-D", "--hard", "--soft", "--mixed", "--keep",
  "--amend", "--no-verify",
  "-i", "--interactive", "--autosquash", "--onto", "--root",
  "-e", "--edit", "--exec",
  "--upload-pack", "--receive-pack", "--upload-archive",
  "--index-filter", "--tree-filter", "--msg-filter", "--env-filter",
  "--commit-filter", "--subdirectory-filter",
  "--mirror", "--bare", "--separate-git-dir", "--template",
  "--git-dir", "--work-tree", "--exec-path", "--namespace", "--config-env",
]);

/**
 * `-c` e `-C` deliberadamente FORA da lista acima.
 *
 * Como globais (`git -c core.sshCommand=... status`, `git -C /etc status`) são
 * perigosas, mas só existem ANTES do subcomando — e essa posição já é fechada
 * pelo teste de que argv[0] tem de ser um subcomando. Depois do subcomando
 * são flags locais legítimas e inofensivas: `switch -c <branch>` cria um
 * branch, `blame -C` deteta código copiado. Negá-las globalmente rejeitaria
 * operações válidas sem fechar ameaça nenhuma.
 */

// ─── Read allowlist ──────────────────────────────────────────────────────────

/**
 * Flags de leitura genéricas. Predicados de `log`/`rev-list` (--since, --until,
 * --author, --grep, --format, ...) são valores fornecidos pelo utilizador, mas
 * não têm poder de execução — a proteção contra injeção é o argv-only do
 * exec.ts, não esta lista.
 */
const COMMON_READ_FLAGS = [
  "--", "-n", "--max-count", "--skip", "--reverse", "--all", "--oneline",
  "--stat", "--shortstat", "--numstat", "--name-only", "--name-status",
  "--format", "--pretty", "--abbrev", "--abbrev-commit", "--no-abbrev",
  "--date", "--since", "--until", "--before", "--after", "--author",
  "--committer", "--grep", "--merges", "--no-merges", "--first-parent",
  "--follow", "--graph", "--decorate", "--no-color", "--color",
  "--porcelain", "--short", "--branch", "--untracked-files", "--ignored",
  "--cached", "--staged", "--left-right", "--count", "--sort", "--contains",
  "--merged", "--no-merged", "--points-at", "--is-ancestor", "--verify",
  "--quiet", "-q", "--line-porcelain", "--others", "--exclude-standard",
  "--tags", "--abbrev-ref", "--show-toplevel", "--is-inside-work-tree",
  "--symbolic-full-name", "--get", "--get-all", "--list", "--show-current",
  "-v", "-vv", "-s", "-l", "-b", "-w", "-M", "-C1", "--find-renames",
  "--full-history", "--simplify-merges", "--boundary", "--children",
  "--parents", "--objects", "--disk-usage", "--human-readable",
];

/** Flags de leitura que consomem o token seguinte como valor. */
const COMMON_READ_VALUE_FLAGS = [
  "-n", "--max-count", "--skip", "--format", "--pretty", "--abbrev", "--date",
  "--since", "--until", "--before", "--after", "--author", "--committer",
  "--grep", "--sort", "--contains", "--merged", "--no-merged", "--points-at",
  "--untracked-files", "--ignored", "--color", "--get", "--get-all", "-b",
];

function readSpec(overrides: Partial<SubcommandSpec> = {}): SubcommandSpec {
  return {
    mutating: false,
    allowedFlags: new Set(COMMON_READ_FLAGS),
    valueFlags: new Set(COMMON_READ_VALUE_FLAGS),
    ...overrides,
  };
}

// ─── Especificações ──────────────────────────────────────────────────────────

const GIT_SPECS: Record<string, SubcommandSpec> = {
  // ── Leitura ────────────────────────────────────────────────────────────
  status: readSpec(),
  log: readSpec(),
  show: readSpec(),
  diff: readSpec(),
  blame: readSpec(),
  "rev-parse": readSpec(),
  "rev-list": readSpec(),
  "merge-base": readSpec(),
  "for-each-ref": readSpec(),
  "show-ref": readSpec(),
  "symbolic-ref": readSpec(),
  shortlog: readSpec(),
  "ls-files": readSpec(),
  describe: readSpec(),
  "cat-file": readSpec(),
  "count-objects": readSpec(),
  var: readSpec(),
  "check-ignore": readSpec(),
  // Leitura da rede: pergunta ao remote sem escrever nada localmente. Só
  // git_fleet a usa, e só com refresh:true.
  "ls-remote": readSpec({
    allowedFlags: new Set(["--tags", "--heads", "--quiet", "-q", "--refs", "--exit-code"]),
    valueFlags: new Set(),
    maxPositionals: 2,
  }),
  // `config` só na forma de leitura: sem --get/--get-all/--list, `git config
  // x y` escreveria no .git/config.
  config: {
    mutating: false,
    allowedFlags: new Set(["--get", "--get-all", "--list", "--local", "--null", "-z"]),
    valueFlags: new Set(["--get", "--get-all"]),
    maxPositionals: 1,
  },

  // ── Escrita (allowlist estrita) ────────────────────────────────────────
  add: {
    mutating: true,
    allowedFlags: new Set(["-A", "--all", "-u", "--update", "-N", "--intent-to-add", "--"]),
    valueFlags: new Set(),
    positionalsArePaths: true,
  },
  commit: {
    mutating: true,
    allowedFlags: new Set(["-m", "--message", "-a", "--all", "-s", "--signoff"]),
    valueFlags: new Set(["-m", "--message"]),
    maxPositionals: 0,
  },
  branch: {
    mutating: true,
    allowedFlags: new Set([
      "--list", "--show-current", "-v", "-vv", "-d", "--delete", "--merged",
      "--no-merged", "--format", "--sort", "--contains",
    ]),
    valueFlags: new Set(["--format", "--merged", "--no-merged", "--sort", "--contains"]),
    maxPositionals: 2,
  },
  switch: {
    mutating: true,
    allowedFlags: new Set(["-c", "--create", "--no-guess"]),
    valueFlags: new Set(["-c", "--create"]),
    maxPositionals: 1,
  },
  tag: {
    mutating: true,
    allowedFlags: new Set(["-a", "-m", "-s", "--sign", "-l", "--list", "-n", "--sort", "--format"]),
    valueFlags: new Set(["-m", "--sort", "--format"]),
    maxPositionals: 2,
  },
  stash: {
    mutating: true,
    // Sem `drop`, `clear` nem `branch`: destroem trabalho sem recuperação.
    subVerbs: new Set(["push", "list", "show", "pop", "apply"]),
    allowedFlags: new Set([
      "-m", "--message", "-u", "--include-untracked", "--keep-index", "--stat",
      "--porcelain",
    ]),
    valueFlags: new Set(["-m", "--message"]),
    maxPositionals: 1,
  },
  worktree: {
    mutating: true,
    subVerbs: new Set(["add", "list", "remove"]),
    allowedFlags: new Set(["--porcelain", "-b", "--detach"]),
    valueFlags: new Set(["-b"]),
    positionalsAreEcosystemPaths: true,
    maxPositionals: 2,
  },
  // `fetch` não é montável pelo chamador: só o caminho fixo de git_fleet
  // (refresh) o usa, e é auditado como mutação por escrever remote-tracking
  // refs. Aqui existe apenas para que esse caminho passe pelo guard como tudo
  // o resto.
  fetch: {
    mutating: true,
    allowedFlags: new Set(["--quiet", "-q", "--no-tags", "--dry-run"]),
    valueFlags: new Set(),
    maxPositionals: 0,
  },
};

// ─── gh allowlist ────────────────────────────────────────────────────────────

const GH_ALLOWED: Record<string, Set<string>> = {
  pr: new Set(["view", "list", "checks", "diff", "status"]),
  run: new Set(["view", "list"]),
  repo: new Set(["view"]),
};

const GH_DENIED_VERBS = new Set([
  "create", "merge", "close", "edit", "ready", "review", "comment", "delete",
  "reopen", "sync", "clone", "fork", "rename", "archive",
]);

const GH_DENIED_SUBCOMMANDS = new Set([
  "api", "auth", "secret", "ssh-key", "gist", "release", "workflow", "config",
  "alias", "extension", "codespace", "variable",
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function deny(
  code: GuardDenialCode,
  offending: string,
  reason: string
): GuardDecision {
  return { allowed: false, code, offending, reason, policy: POLICY };
}

/** Separa `--flag=valor` em `--flag`. Deixa tudo o resto intacto. */
function flagName(token: string): string {
  const eq = token.indexOf("=");
  return eq === -1 ? token : token.slice(0, eq);
}

function isFlagToken(token: string): boolean {
  return token.startsWith("-") && token !== "-";
}

/** Escritas globalmente desligadas por env? */
function writesDisabled(): boolean {
  return process.env.GIT_OPS_WRITES_ENABLED === "false";
}

// ─── Guard principal ─────────────────────────────────────────────────────────

/**
 * Decide se um argv de git (sem o "git" inicial) pode ser executado.
 *
 * Nunca lança: uma negação é dado estruturado, para que o chamador possa
 * devolver ao agente um motivo legível por máquina em vez de um stack trace.
 */
export function guardGitArgv(argv: string[], ctx: GuardContext): GuardDecision {
  if (!Array.isArray(argv) || argv.length === 0) {
    return deny("empty_argv", "", "Empty git argv.");
  }

  for (const token of argv) {
    if (typeof token !== "string") {
      return deny("nul_byte", String(token), "Every git argument must be a string.");
    }
    if (token.includes("\0")) {
      return deny("nul_byte", token, "Arguments must not contain NUL bytes.");
    }
  }

  const subcommand = argv[0];

  // Um subcomando é [a-z][a-z0-9-]*. Qualquer coisa que comece por '-' aqui é
  // uma global option, e é assim que se contorna um guard ingénuo.
  if (!/^[a-z][a-z0-9-]*$/.test(subcommand)) {
    return deny(
      "global_option",
      subcommand,
      `argv[0] must be a git subcommand; "${subcommand}" looks like a global option. ` +
        `Global options (-c, -C, --git-dir, --exec-path, --namespace) can redirect git ` +
        `outside the repository or execute arbitrary programs.`
    );
  }

  if (GIT_DENIED_SUBCOMMANDS.has(subcommand)) {
    return deny(
      "denied_subcommand",
      subcommand,
      `Subcommand "${subcommand}" is denied by policy: it can publish, rewrite history, ` +
        `or destroy uncommitted work.`
    );
  }

  const spec = GIT_SPECS[subcommand];
  if (!spec) {
    return deny(
      "unknown_subcommand",
      subcommand,
      `Subcommand "${subcommand}" is not in the allowlist. New subcommands must be ` +
        `reviewed before use.`
    );
  }

  if (spec.mutating && writesDisabled()) {
    return deny(
      "writes_disabled",
      subcommand,
      `Git writes are disabled (GIT_OPS_WRITES_ENABLED=false).`
    );
  }

  // ── Varredura posicional ───────────────────────────────────────────────
  let afterDoubleDash = false;
  let expectingValueFor: string | null = null;
  let positionals = 0;
  let sawSubVerb = false;

  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];

    // Depois de `--` tudo é path, mesmo que pareça uma flag.
    if (afterDoubleDash) {
      const escape = checkPositionalPath(token, spec, ctx);
      if (escape) return escape;
      positionals++;
      continue;
    }

    // Valor de uma flag anterior: aceite tal e qual. É isto que torna
    // `commit -m "--force fix"` legal.
    if (expectingValueFor !== null) {
      expectingValueFor = null;
      continue;
    }

    if (token === "--") {
      afterDoubleDash = true;
      continue;
    }

    if (isFlagToken(token)) {
      const name = flagName(token);

      if (GLOBAL_DENIED_FLAGS.has(name)) {
        return deny(
          "denied_flag",
          name,
          `Flag "${name}" is globally denied: it forces, rewrites, destroys, or executes.`
        );
      }

      if (!spec.allowedFlags.has(name)) {
        return deny(
          "unknown_flag",
          name,
          `Flag "${name}" is not allowed for "${subcommand}".`
        );
      }

      // `--flag=valor` já traz o valor; só `--flag valor` consome o seguinte.
      if (spec.valueFlags.has(name) && !token.includes("=")) {
        expectingValueFor = name;
      }
      continue;
    }

    // Primeiro positional pode ser um sub-verbo (stash push, worktree add).
    if (spec.subVerbs && !sawSubVerb) {
      if (!spec.subVerbs.has(token)) {
        return deny(
          "denied_subcommand",
          token,
          `"${subcommand} ${token}" is not allowed. Permitted: ` +
            `${[...spec.subVerbs].join(", ")}.`
        );
      }
      sawSubVerb = true;
      continue;
    }

    const escape = checkPositionalPath(token, spec, ctx);
    if (escape) return escape;
    positionals++;

    if (spec.maxPositionals !== undefined && positionals > spec.maxPositionals) {
      return deny(
        "too_many_positionals",
        token,
        `"${subcommand}" accepts at most ${spec.maxPositionals} positional argument(s).`
      );
    }
  }

  // Um sub-verbo obrigatório em falta (ex.: `worktree` sozinho) é ambíguo.
  if (spec.subVerbs && !sawSubVerb) {
    return deny(
      "unknown_subcommand",
      subcommand,
      `"${subcommand}" requires one of: ${[...spec.subVerbs].join(", ")}.`
    );
  }

  return { allowed: true, mutating: spec.mutating, argv };
}

function checkPositionalPath(
  token: string,
  spec: SubcommandSpec,
  ctx: GuardContext
): GuardDecision | null {
  if (!spec.positionalsArePaths && !spec.positionalsAreEcosystemPaths) return null;

  const boundary = spec.positionalsAreEcosystemPaths ? ctx.ecosystemRoot : ctx.repoRoot;
  try {
    validatePath(token, boundary);
    return null;
  } catch {
    return deny(
      "path_escape",
      token,
      `Path "${token}" resolves outside the allowed boundary "${boundary}".`
    );
  }
}

// ─── Guard do gh ─────────────────────────────────────────────────────────────

/**
 * Só leitura. O agente consulta o estado do GitHub; nunca publica.
 */
export function guardGhArgv(argv: string[]): GuardDecision {
  if (!Array.isArray(argv) || argv.length === 0) {
    return deny("empty_argv", "", "Empty gh argv.");
  }

  for (const token of argv) {
    if (typeof token !== "string" || token.includes("\0")) {
      return deny("nul_byte", String(token), "Arguments must be NUL-free strings.");
    }
  }

  const [subcommand, verb] = argv;

  if (!/^[a-z][a-z0-9-]*$/.test(subcommand)) {
    return deny("global_option", subcommand, `argv[0] must be a gh subcommand.`);
  }

  if (GH_DENIED_SUBCOMMANDS.has(subcommand)) {
    return deny(
      "denied_subcommand",
      subcommand,
      `"gh ${subcommand}" is denied: it can mutate remote state or expose credentials.`
    );
  }

  const allowedVerbs = GH_ALLOWED[subcommand];
  if (!allowedVerbs) {
    return deny(
      "unknown_subcommand",
      subcommand,
      `"gh ${subcommand}" is not in the read-only allowlist.`
    );
  }

  if (!verb) {
    return deny("unknown_subcommand", subcommand, `"gh ${subcommand}" requires a verb.`);
  }

  if (GH_DENIED_VERBS.has(verb)) {
    return deny(
      "denied_subcommand",
      `${subcommand} ${verb}`,
      `"gh ${subcommand} ${verb}" mutates remote state and is denied by policy.`
    );
  }

  if (!allowedVerbs.has(verb)) {
    return deny(
      "unknown_subcommand",
      `${subcommand} ${verb}`,
      `"gh ${subcommand} ${verb}" is not in the read-only allowlist. ` +
        `Permitted: ${[...allowedVerbs].join(", ")}.`
    );
  }

  return { allowed: true, mutating: false, argv };
}

// ─── Exposto para testes ─────────────────────────────────────────────────────

export const guardTestHelpers = {
  GIT_DENIED_SUBCOMMANDS,
  GLOBAL_DENIED_FLAGS,
  GIT_SPECS,
  GH_ALLOWED,
  flagName,
};
