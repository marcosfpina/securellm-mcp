/**
 * Git execution helper — ADR-0062
 *
 * Camada única por onde passa todo o git das tools novas. Existe para fixar
 * quatro propriedades que o git_sherlock original não tinha:
 *
 *   1. argv apenas — nunca `shell: true`, nunca comandos em string. A
 *      superfície de injeção deixa de existir em vez de ser escapada.
 *   2. cwd explícito — o repo alvo é uma decisão do chamador, não um acidente
 *      do processo do servidor.
 *   3. falha é dado — `runGit` nunca lança em exit != 0. O padrão antigo
 *      (`.catch(() => ({ stdout: "" }))`) tornava um repo em falta
 *      indistinguível de um repo limpo.
 *   4. mutações são auditadas — uma entrada por comando planeado, executado,
 *      falhado ou negado.
 */

import { execa } from "execa";
import { randomUUID } from "crypto";
import * as path from "path";
import { logger } from "../../utils/logger.js";
import { getEcosystemRoot, listEcosystemRepos } from "../../config/workspace.js";
import { getActiveProfile } from "../../config/profiles.js";
import { isPathWithinBoundary, validatePath } from "../../security/path-validator.js";
import type { GuardDenialCode } from "./guard.js";

// ─── Tipos ───────────────────────────────────────────────────────────────────

/**
 * Estruturalmente compatível com o `runCommand` injetável de
 * professional-tools.ts — o único padrão testável já provado no repo.
 */
export type RunCommand = (
  program: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number }
) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut?: boolean }>;

export interface GitResult {
  ok: boolean;
  exit_code: number;
  stdout: string;
  stderr: string;
  /** Cauda do stderr, curta o suficiente para embutir no JSON da tool. */
  stderr_tail: string;
  timed_out: boolean;
  duration_ms: number;
  /** argv sem o "git" inicial. */
  argv: string[];
  cwd: string;
}

export interface ResolvedRepo {
  name: string;
  /** Toplevel canónico, absoluto. */
  path: string;
  requested: string | null;
  source: "explicit_name" | "explicit_path" | "active_profile" | "project_root" | "cwd";
}

export interface GitAuditEntry {
  audit_id: string;
  ts: string;
  tool: string;
  action: string;
  repo: string;
  argv: string[];
  mode: "dry_run" | "confirmed";
  status: "planned" | "executed" | "failed" | "denied";
  exit_code?: number;
  denial?: { code: GuardDenialCode; offending: string };
  reason?: string;
}

export type GitAuditSink = (entry: GitAuditEntry) => void;

/** Forma de resposta MCP partilhada por todas as tools de git. */
export interface GitToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export function gitOk(payload: unknown): GitToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export function gitFail(payload: unknown): GitToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: true };
}

export interface GitOpsContext {
  run: RunCommand;
  audit: GitAuditSink;
  ecosystemRoot: string;
  now: () => Date;
}

export class RepoResolutionError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "not_a_git_repo"
      | "path_escape"
      | "unknown_repo"
      | "resolution_failed"
  ) {
    super(message);
    this.name = "RepoResolutionError";
  }
}

// ─── Execução ────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 15_000;
const STDERR_TAIL_CHARS = 400;

/**
 * Env endurecido. Cada variável fecha um modo de falha concreto:
 *
 *   GIT_TERMINAL_PROMPT=0 — sem isto, um remote que peça credenciais pendura
 *                           o servidor MCP até ao timeout.
 *   GIT_OPTIONAL_LOCKS=0  — `git status` normalmente reescreve o index; com
 *                           isto uma "leitura" é mesmo uma leitura.
 *   GIT_PAGER=cat         — garante que argv[0] é sempre o subcomando, que é
 *                           a premissa de que o guard depende.
 *   LC_ALL=C              — output estável e parseável, independente da locale.
 */
const HARDENED_GIT_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
  LC_ALL: "C",
};

export const defaultRunCommand: RunCommand = async (program, args, options) => {
  const result = await execa(program, args, {
    cwd: options.cwd,
    reject: false,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    stripFinalNewline: true,
    extendEnv: true,
    env: HARDENED_GIT_ENV,
  });

  return {
    exitCode: result.exitCode ?? 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: result.timedOut === true,
  };
};

const gitAuditLogger = logger.child({ component: "git-ops" });

export const defaultAuditSink: GitAuditSink = (entry) => {
  gitAuditLogger.info(entry, `git_ops.${entry.status}`);
};

export function createGitOpsContext(overrides: Partial<GitOpsContext> = {}): GitOpsContext {
  return {
    run: overrides.run ?? defaultRunCommand,
    audit: overrides.audit ?? defaultAuditSink,
    ecosystemRoot: overrides.ecosystemRoot ?? getEcosystemRoot(),
    now: overrides.now ?? (() => new Date()),
  };
}

function tail(value: string, chars = STDERR_TAIL_CHARS): string {
  if (value.length <= chars) return value;
  return `…${value.slice(-chars)}`;
}

/**
 * Corre git num repo já resolvido. Nunca lança por exit != 0 — o resultado
 * carrega o código e a cauda do stderr para o chamador decidir.
 */
export async function runGit(
  repo: ResolvedRepo,
  argv: string[],
  ctx: GitOpsContext,
  opts: { timeoutMs?: number } = {}
): Promise<GitResult> {
  return runGitIn(repo.path, argv, ctx, opts);
}

/** Igual a runGit, mas contra um path — usado antes de haver ResolvedRepo. */
export async function runGitIn(
  cwd: string,
  argv: string[],
  ctx: GitOpsContext,
  opts: { timeoutMs?: number } = {}
): Promise<GitResult> {
  const started = Date.now();

  let raw: Awaited<ReturnType<RunCommand>>;
  try {
    raw = await ctx.run("git", argv, { cwd, timeoutMs: opts.timeoutMs });
  } catch (err) {
    // Um runCommand injetado pode lançar; o contrato de runGit é não lançar.
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      exit_code: -1,
      stdout: "",
      stderr: message,
      stderr_tail: tail(message),
      timed_out: false,
      duration_ms: Date.now() - started,
      argv,
      cwd,
    };
  }

  const timedOut = raw.timedOut === true;
  return {
    ok: raw.exitCode === 0 && !timedOut,
    exit_code: raw.exitCode,
    stdout: raw.stdout,
    stderr: raw.stderr,
    stderr_tail: tail(raw.stderr),
    timed_out: timedOut,
    duration_ms: Date.now() - started,
    argv,
    cwd,
  };
}

/** Erro serializável para o campo `errors[]` das respostas das tools. */
export function toGitError(step: string, result: GitResult) {
  return {
    step,
    argv: result.argv,
    exit_code: result.exit_code,
    timed_out: result.timed_out,
    stderr_tail: result.stderr_tail,
  };
}

// ─── Resolução de repo ───────────────────────────────────────────────────────

interface RepoCacheEntry {
  repo: ResolvedRepo;
  at: number;
}

const REPO_CACHE_TTL_MS = 60_000;
const repoCache = new Map<string, RepoCacheEntry>();

export function resetRepoCacheForTests(): void {
  repoCache.clear();
}

/** Um nome simples de repo: sem separadores, sem truques de path. */
const SIMPLE_NAME = /^[A-Za-z0-9._-]+$/;

function defaultRepoSpec(): { path: string; source: ResolvedRepo["source"] } {
  const profile = getActiveProfile();
  if (profile?.profile?.path) {
    return { path: profile.profile.path, source: "active_profile" };
  }
  if (process.env.PROJECT_ROOT) {
    return { path: process.env.PROJECT_ROOT, source: "project_root" };
  }
  return { path: process.cwd(), source: "cwd" };
}

/**
 * Resolve o repo alvo.
 *
 * Nome simples → sob a raiz do ecossistema. Path → tem de cair dentro da raiz
 * do ecossistema ou do repo default. Em qualquer caso o toplevel devolvido
 * pelo git é RE-validado: um symlink ou um worktree linkado pode apontar para
 * fora do boundary que o path de entrada respeitava.
 */
export async function resolveRepo(
  spec: string | undefined,
  ctx: GitOpsContext
): Promise<ResolvedRepo> {
  const cacheKey = `${ctx.ecosystemRoot} ${spec ?? ""}`;
  const cached = repoCache.get(cacheKey);
  if (cached && Date.now() - cached.at < REPO_CACHE_TTL_MS) {
    return cached.repo;
  }

  let candidate: string;
  let source: ResolvedRepo["source"];

  if (!spec) {
    const fallback = defaultRepoSpec();
    candidate = fallback.path;
    source = fallback.source;
  } else if (SIMPLE_NAME.test(spec) && !spec.includes(path.sep)) {
    const known = listEcosystemRepos().find((r) => r.name === spec);
    if (!known) {
      throw new RepoResolutionError(
        `Unknown repo "${spec}". Known repos under ${ctx.ecosystemRoot}: ` +
          `${listEcosystemRepos().map((r) => r.name).join(", ") || "(none found)"}`,
        "unknown_repo"
      );
    }
    candidate = known.path;
    source = "explicit_name";
  } else {
    const boundaries = [ctx.ecosystemRoot, defaultRepoSpec().path];
    if (!boundaries.some((boundary) => isPathWithinBoundary(spec, boundary))) {
      throw new RepoResolutionError(
        `Path "${spec}" resolves outside the allowed boundaries ` +
          `(${boundaries.join(", ")}).`,
        "path_escape"
      );
    }
    candidate = path.resolve(spec);
    source = "explicit_path";
  }

  const toplevel = await runGitIn(candidate, ["rev-parse", "--show-toplevel"], ctx, {
    timeoutMs: 5_000,
  });

  if (!toplevel.ok || !toplevel.stdout.trim()) {
    throw new RepoResolutionError(
      `"${candidate}" is not a git repository` +
        (toplevel.stderr_tail ? `: ${toplevel.stderr_tail}` : "."),
      "not_a_git_repo"
    );
  }

  const resolvedPath = path.resolve(toplevel.stdout.trim());

  // Re-validação: o toplevel pode ter saltado a fronteira por symlink ou por
  // um worktree cujo gitdir vive noutro sítio.
  const allowed = [ctx.ecosystemRoot, defaultRepoSpec().path];
  if (!allowed.some((boundary) => isPathWithinBoundary(resolvedPath, boundary))) {
    throw new RepoResolutionError(
      `Repository toplevel "${resolvedPath}" lies outside the allowed boundaries ` +
        `(${allowed.join(", ")}). Refusing to operate on it.`,
      "path_escape"
    );
  }

  const repo: ResolvedRepo = {
    name: path.basename(resolvedPath),
    path: resolvedPath,
    requested: spec ?? null,
    source,
  };

  repoCache.set(cacheKey, { repo, at: Date.now() });
  return repo;
}

// ─── Auditoria ───────────────────────────────────────────────────────────────

export function newAuditId(): string {
  return randomUUID();
}

export function emitAudit(
  ctx: GitOpsContext,
  entry: Omit<GitAuditEntry, "ts"> & { ts?: string }
): GitAuditEntry {
  const full: GitAuditEntry = { ...entry, ts: entry.ts ?? ctx.now().toISOString() };
  try {
    ctx.audit(full);
  } catch {
    // Auditoria nunca derruba a operação que estava a registar.
  }
  return full;
}

// ─── Exposto para testes ─────────────────────────────────────────────────────

export const execTestHelpers = {
  tail,
  HARDENED_GIT_ENV,
  REPO_CACHE_TTL_MS,
  validatePath,
};
