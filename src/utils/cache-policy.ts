const VOLATILE_TOOLS = new Set([
  // System / monitoring — state changes constantly
  "server_status",
  "server_health",
  "workspace_quality_gate",
  "rate_limiter_status",
  "cache_stats",
  "system_health_check",
  "thermal_check",
  "thermal_warroom",
  "full_investigation",
  "browser_monitor_changes",
  // ADR reads — backed by mutable files on disk
  "adr_list",
  "adr_show",
  "adr_search",
  "adr_relations",
  "adr_validate",
  // Chain reads — state appended over time
  "chain_status",
  "chain_verify",
  "chain_prove",
  // Other read-state tools that change when ADRs change
  "snapshot_latest",
  "economics_report",
  "sbom_status",
  "provenance_trace",
  "governance_rules",
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
