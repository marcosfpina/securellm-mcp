/**
 * Catalog ↔ dispatch parity — ADR-0062 (B1)
 *
 * `tools/list` serve buildToolCatalog(); `tools/call` procura em
 * buildDispatchMap(). São duas listas mantidas à mão em ficheiros diferentes,
 * e src/index.ts lança MethodNotFound quando divergem. Foi assim que
 * change_impact, ci_failure_summary, ci_batch_triage e cache_tuning_advisor
 * ficaram anunciadas mas inchamáveis.
 *
 * Nota: em build/ o catálogo já passou pela curação da ADR-0059
 * (scripts/curate-tools.ts), portanto este teste vê exatamente a superfície
 * que o cliente MCP vê.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { buildToolCatalog } from "../../src/server/tool-registry.js";
import { buildDispatchMap, type DispatchDeps } from "../../src/server/dispatcher.js";

/**
 * buildDispatchMap só lê `stringify` de forma eager — tudo o resto é capturado
 * em closures de handlers que este teste nunca invoca. Um stub mínimo chega.
 */
function stubDeps(): DispatchDeps {
  const notCalled = () => {
    throw new Error("dispatch dependency invoked during a parity test");
  };
  return {
    db: null,
    rateLimiter: {} as DispatchDeps["rateLimiter"],
    semanticCache: null,
    projectRoot: "/tmp/parity",
    packageDiagnose: {} as DispatchDeps["packageDiagnose"],
    packageDownload: {} as DispatchDeps["packageDownload"],
    packageConfigure: {} as DispatchDeps["packageConfigure"],
    professionalToolHandlers: {} as DispatchDeps["professionalToolHandlers"],
    stringify: (obj: unknown) => JSON.stringify(obj),
    getServerStatus: notCalled as unknown as DispatchDeps["getServerStatus"],
    getRateLimiterStatus: notCalled as unknown as DispatchDeps["getRateLimiterStatus"],
    handleKnowledge: notCalled as unknown as DispatchDeps["handleKnowledge"],
  };
}

describe("catalog ↔ dispatch parity", () => {
  it("every advertised tool has a dispatch handler", () => {
    const dispatch = buildDispatchMap(stubDeps());
    const catalog = buildToolCatalog(null, false);

    const missing = catalog.map((t) => t.name).filter((name) => !(name in dispatch));

    assert.deepEqual(
      missing,
      [],
      `Tools advertised in tools/list with no dispatch entry (tools/call would throw ` +
        `MethodNotFound): ${missing.join(", ")}`
    );
  });

  it("knowledge-gated tools also dispatch when knowledge is enabled", () => {
    const dispatch = buildDispatchMap(stubDeps());
    const fakeDb = {} as Parameters<typeof buildToolCatalog>[0];
    const catalog = buildToolCatalog(fakeDb, true);

    const missing = catalog.map((t) => t.name).filter((name) => !(name in dispatch));

    assert.deepEqual(missing, [], `Missing dispatch entries: ${missing.join(", ")}`);
  });

  it("the four previously-dead professional tools are wired", () => {
    const dispatch = buildDispatchMap(stubDeps());

    for (const name of [
      "change_impact",
      "ci_failure_summary",
      "ci_batch_triage",
      "cache_tuning_advisor",
    ]) {
      assert.equal(typeof dispatch[name], "function", `${name} has no dispatch handler`);
    }
  });

  it("the catalog has no duplicate tool names", () => {
    const names = buildToolCatalog(null, false).map((t) => t.name);
    const seen = new Set<string>();
    const duplicates = names.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));

    assert.deepEqual(duplicates, [], `Duplicate tool names in catalog: ${duplicates.join(", ")}`);
  });
});
