const VOLATILE_TOOLS = new Set([
  "server_status",
  "server_health",
  // Ledger (adr-ledger): tools que ESCREVEM no ledger ou probam estado do
  // filesystem — a resposta reflete o estado do disco no instante da chamada,
  // não os args. Cachear devolve gate/resultado obsoleto (ex.: adr_new
  // repetindo "Duplicate ADR IDs" depois da duplicata já corrigida em disco).
  "adr_new",
  "adr_new_from_research",
  "adr_accept",
  "adr_supersede",
  "adr_pre_sign",
  "adr_gate",
  "adr_validate",
  "chain_sign",
  "chain_status",
  "chain_verify",
  "snapshot_create",
  "snapshot_latest",
  "sbom_generate",
  "sbom_status",
  // Mutadores fora do ledger — mesma classe (side effects; replay do cache
  // pula a execução real):
  "cerebro_rag_ingest",
  "execute_in_sandbox",
  // ADR-0061: resposta depende do cwd/env da INSTÂNCIA, não dos args —
  // cachear vaza o profile de uma sessão pra outra (cache é compartilhado
  // via Cerebro).
  "get_project_context",
  "workspace_quality_gate",
  "rate_limiter_status",
  "cache_stats",
  "system_health_check",
  "thermal_check",
  "thermal_warroom",
  "full_investigation",
  "browser_monitor_changes",
  // ADR-0062: as tools de git leem o working tree e as refs no instante da
  // chamada, não os args. O cache é compartilhado entre sessões via Cerebro,
  // então cachear devolve "repo limpo" depois de um commit — e, no caso do
  // git_workbench, um replay pularia a execução real de uma mutação.
  "git_sherlock",
  "git_fleet",
  "git_workbench",
  "git_release",
]);

const MAX_CACHE_RESPONSE_BYTES = parseInt(
  process.env.SEMANTIC_CACHE_MAX_RESPONSE_BYTES || "131072",
  10
);

export interface SemanticCachePolicyInput {
  toolName: string;
  args?: unknown;
  result?: unknown;
  responseSize?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function shouldAttemptSemanticCache(toolName: string): boolean {
  return !VOLATILE_TOOLS.has(toolName);
}

export function isCacheableResult(result: unknown): boolean {
  if (!isObject(result)) return true;
  if (result.isError === true) return false;
  return true;
}

export function shouldStoreSemanticCache({
  toolName,
  result,
  responseSize,
}: SemanticCachePolicyInput): boolean {
  if (!shouldAttemptSemanticCache(toolName)) {
    return false;
  }

  if (!isCacheableResult(result)) {
    return false;
  }

  if (typeof responseSize === "number" && responseSize > MAX_CACHE_RESPONSE_BYTES) {
    return false;
  }

  return true;
}

export function getSemanticCacheMaxResponseBytes(): number {
  return MAX_CACHE_RESPONSE_BYTES;
}
