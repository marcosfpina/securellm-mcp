/**
 * Workspace roots — ADR-0062 (B4)
 *
 * O ecossistema VoidNxSEC vive numa raiz que já mudou de sítio uma vez
 * (~/master → ~/Projects/master/deploy) e a mudança partiu, em silêncio,
 * ecosystem_map, cross_project_search, dependency_graph_analyzer,
 * context_window_optimizer e as ADR tools: continuavam a responder, só que
 * sobre zero projetos.
 *
 * A lição não é "corrigir a constante" — é parar de a hardcodar. Este módulo
 * resolve a raiz por prova de existência (um candidato só ganha se contiver
 * repos git de facto), com override por env, e memoiza o resultado.
 */

import { existsSync, readdirSync, statSync } from "fs";
import * as os from "os";
import * as path from "path";

/** Quantos subdirectórios com .git um candidato precisa para ser credível. */
const MIN_REPOS_FOR_ROOT = 3;

/** Ordem de probe. O primeiro candidato que passe MIN_REPOS_FOR_ROOT ganha. */
function rootCandidates(home: string): string[] {
  return [
    path.join(home, "master"),
    path.join(home, "Projects", "master", "deploy"),
    path.join(home, "Projects", "master"),
    path.join(home, "projects"),
  ];
}

export interface EcosystemRepo {
  name: string;
  path: string;
}

let cachedRoot: string | null = null;
let cachedRepos: EcosystemRepo[] | null = null;
let cachedAdrLedger: string | null = null;

function isGitRepo(dir: string): boolean {
  // .git é directório num clone normal e ficheiro num worktree linkado.
  return existsSync(path.join(dir, ".git"));
}

function countGitRepos(dir: string): number {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }

  let count = 0;
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const candidate = path.join(dir, entry);
    try {
      if (!statSync(candidate).isDirectory()) continue;
    } catch {
      continue;
    }
    if (isGitRepo(candidate)) count++;
    // Curto-circuito: acima do limiar a contagem exata é irrelevante.
    if (count >= MIN_REPOS_FOR_ROOT) return count;
  }
  return count;
}

/**
 * Raiz do ecossistema.
 *
 * 1. `SECURELLM_ECOSYSTEM_ROOT` (override explícito, sempre vence)
 * 2. primeiro candidato com >= MIN_REPOS_FOR_ROOT subdirectórios git
 * 3. fallback determinístico `~/master`
 */
export function getEcosystemRoot(): string {
  if (cachedRoot) return cachedRoot;

  const override = process.env.SECURELLM_ECOSYSTEM_ROOT;
  if (override) {
    cachedRoot = path.resolve(override);
    return cachedRoot;
  }

  const home = process.env.HOME || os.homedir() || "/home/kernelcore";
  const candidates = rootCandidates(home);

  for (const candidate of candidates) {
    if (countGitRepos(candidate) >= MIN_REPOS_FOR_ROOT) {
      cachedRoot = candidate;
      return cachedRoot;
    }
  }

  cachedRoot = candidates[0];
  return cachedRoot;
}

/**
 * Todos os repos git imediatamente sob a raiz do ecossistema, por ordem
 * alfabética. Substitui listas hardcoded de projetos, que envelhecem mal:
 * UMBRELLA_REPOS conhece 13 dos 21 repos reais.
 */
export function listEcosystemRepos(): EcosystemRepo[] {
  if (cachedRepos) return cachedRepos;

  const root = getEcosystemRoot();
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    cachedRepos = [];
    return cachedRepos;
  }

  const repos: EcosystemRepo[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const full = path.join(root, entry);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    if (isGitRepo(full)) repos.push({ name: entry, path: full });
  }

  repos.sort((a, b) => a.name.localeCompare(b.name));
  cachedRepos = repos;
  return cachedRepos;
}

/** Path de um projeto do ecossistema pelo nome, ou null se não existir. */
export function resolveEcosystemProject(name: string): string | null {
  const match = listEcosystemRepos().find((repo) => repo.name === name);
  return match ? match.path : null;
}

function hasAdrLayout(repoPath: string): boolean {
  return existsSync(path.join(repoPath, "adr")) || existsSync(path.join(repoPath, "docs", "adr"));
}

/**
 * Path do adr-ledger.
 *
 * `ADR_REPO_PATH` > `<ecosystemRoot>/adr-ledger` (se tiver layout ADR) >
 * fallback determinístico. Note que quem chama isto para *escrever* ADRs
 * continua a ter a sua própria cadeia de precedência (ver
 * resolveAdrRepoPath em src/tools/adr/index.ts, que prefere o cwd).
 */
export function resolveAdrLedgerPath(): string {
  if (process.env.ADR_REPO_PATH) return process.env.ADR_REPO_PATH;
  if (cachedAdrLedger) return cachedAdrLedger;

  const primary = path.join(getEcosystemRoot(), "adr-ledger");
  if (hasAdrLayout(primary)) {
    cachedAdrLedger = primary;
    return cachedAdrLedger;
  }

  // Um SECURELLM_ECOSYSTEM_ROOT explícito confina a busca: quem declarou a
  // raiz não quer que se vagueie por localizações legadas.
  if (process.env.SECURELLM_ECOSYSTEM_ROOT) {
    cachedAdrLedger = primary;
    return cachedAdrLedger;
  }

  // Sem override: a raiz já mudou uma vez e pode voltar a mudar. Se o ledger
  // ainda vive numa localização legada com layout ADR válido, usa-a em vez de
  // devolver um path que não existe.
  const home = process.env.HOME || os.homedir() || "/home/kernelcore";
  const legacy = rootCandidates(home)
    .map((root) => path.join(root, "adr-ledger"))
    .find(hasAdrLayout);

  cachedAdrLedger = legacy ?? primary;
  return cachedAdrLedger;
}

/** Limpa a memoização. Só para testes. */
export function resetWorkspaceCacheForTests(): void {
  cachedRoot = null;
  cachedRepos = null;
  cachedAdrLedger = null;
}
