import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  getSemanticCacheMaxResponseBytes,
  isCacheableResult,
  shouldAttemptSemanticCache,
  shouldStoreSemanticCache,
} from "../../src/utils/cache-policy.js";

describe("semantic cache policy", () => {
  it("should skip volatile operational tools", () => {
    assert.equal(shouldAttemptSemanticCache("server_status"), false);
    assert.equal(shouldAttemptSemanticCache("server_health"), false);
    assert.equal(shouldAttemptSemanticCache("workspace_quality_gate"), false);
    assert.equal(shouldAttemptSemanticCache("package_diagnose"), true);
  });

  it("should skip ledger mutators — response depends on disk state, not args", () => {
    for (const tool of [
      "adr_new",
      "adr_new_from_research",
      "adr_accept",
      "adr_supersede",
      "adr_pre_sign",
      "chain_sign",
      "snapshot_create",
      "sbom_generate",
    ]) {
      assert.equal(shouldAttemptSemanticCache(tool), false, `${tool} must not be cached`);
    }
  });

  it("should skip ledger state probes — cached probe returns a stale gate", () => {
    for (const tool of [
      "adr_gate",
      "adr_validate",
      "chain_status",
      "chain_verify",
      "snapshot_latest",
      "sbom_status",
    ]) {
      assert.equal(shouldAttemptSemanticCache(tool), false, `${tool} must not be cached`);
    }
  });

  it("should skip non-ledger mutators (cache replay would skip real execution)", () => {
    assert.equal(shouldAttemptSemanticCache("cerebro_rag_ingest"), false);
    assert.equal(shouldAttemptSemanticCache("execute_in_sandbox"), false);
  });

  it("should never store a volatile tool response, even a valid one", () => {
    // Regressão: adr_new com args idênticos devolvia gate "blocked" obsoleto
    // do cache após a duplicata já ter sido corrigida em disco.
    assert.equal(
      shouldStoreSemanticCache({
        toolName: "adr_new",
        result: { content: [{ type: "text", text: '{"success":false,"blocked":true}' }] },
        responseSize: 128,
      }),
      false
    );
  });

  it("should reject cache storage for error results", () => {
    assert.equal(isCacheableResult({ isError: true, content: [] }), false);
    assert.equal(
      shouldStoreSemanticCache({
        toolName: "package_diagnose",
        result: { isError: true, content: [] },
        responseSize: 256,
      }),
      false
    );
  });

  it("should reject overly large responses for semantic storage", () => {
    assert.equal(
      shouldStoreSemanticCache({
        toolName: "package_diagnose",
        result: { content: [{ type: "text", text: "ok" }] },
        responseSize: getSemanticCacheMaxResponseBytes() + 1,
      }),
      false
    );
  });

  it("should allow normal successful responses", () => {
    assert.equal(
      shouldStoreSemanticCache({
        toolName: "package_diagnose",
        result: { content: [{ type: "text", text: "ok" }] },
        responseSize: 1024,
      }),
      true
    );
  });
});
