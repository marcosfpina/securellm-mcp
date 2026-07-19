const VOLATILE_TOOLS = new Set([
  "server_status",
  "server_health",
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
