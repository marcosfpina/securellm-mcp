import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { FilesystemScanner } from "../../src/tools/adr/runtime-gate.js";
import { CLIBackend } from "../../src/tools/adr/storage/cli-backend.js";
import { createTempDir, populateTempDir } from "../helpers/sandbox.js";

const adr0002 = `---
id: "ADR-0002"
title: "Neovim Context Bridge"
status: accepted
date: "2026-04-01"
project: "GLOBAL"
---

## Context

Use Neovim context in MCP tools.
`;

const adr0060 = `---
id: "ADR-0060"
title: "Linux Debugging Tools"
status: proposed
date: "2026-05-05"
project: "GLOBAL"
---

## Context

Add Linux debugging tools.
`;

describe("ADR filesystem discovery", () => {
  it("should scan project-local docs/adr files in ADR numeric order", async () => {
    const temp = await createTempDir("securellm-adr-");

    try {
      await populateTempDir(temp.path, {
        "docs/adr/ADR-0060-linux-debugging-tools.md": adr0060,
        "docs/adr/ADR-0002-nvim-context.md": adr0002,
      });

      const scanner = new FilesystemScanner(temp.path);
      const adrs = await scanner.scanAll();

      assert.deepEqual(
        adrs.map((adr) => adr.id),
        ["ADR-0002", "ADR-0060"]
      );
      assert.equal(adrs[0].status, "accepted");
      assert.equal(adrs[0].project, "GLOBAL");
    } finally {
      await temp.cleanup();
    }
  });

  it("should let CLIBackend fall back to docs/adr for list, show, and search", async () => {
    const temp = await createTempDir("securellm-adr-backend-");

    try {
      await populateTempDir(temp.path, {
        "docs/adr/ADR-0060-linux-debugging-tools.md": adr0060,
        "docs/adr/ADR-0002-nvim-context.md": adr0002,
      });

      const backend = new CLIBackend(temp.path);
      const list = await backend.list(undefined, "GLOBAL");
      const content = await backend.get("ADR-0002");
      const results = await backend.search("debugging");

      assert.deepEqual(
        list.map((adr) => adr.id),
        ["ADR-0002", "ADR-0060"]
      );
      assert.match(content ?? "", /Neovim Context Bridge/);
      assert.deepEqual(
        results.map((adr) => adr.id),
        ["ADR-0060"]
      );
    } finally {
      await temp.cleanup();
    }
  });
});
