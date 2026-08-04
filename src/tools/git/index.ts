/**
 * Git operations — ADR-0062
 *
 * Ponto de entrada único das tools de git novas. O catálogo importa
 * `gitOpsTools`; o dispatcher importa `gitOpsHandlers`.
 *
 * `git_sherlock` continua a viver em ../git-sherlock.ts (ADR-0006) e é
 * registada separadamente — esta ADR estende-a, não a absorve.
 */

import type { ExtendedTool } from "../../types/mcp-tool-extensions.js";
import { createGitOpsContext, type GitOpsContext } from "./exec.js";
import { gitFleetTool, createGitFleetHandler } from "./fleet.js";
import { gitWorkbenchTool, createGitWorkbenchHandler } from "./workbench.js";
import { gitReleaseTool, createGitReleaseHandler } from "./release.js";

export { createGitOpsContext } from "./exec.js";
export type { GitOpsContext, RunCommand, GitAuditEntry, GitToolResult } from "./exec.js";
export { guardGitArgv, guardGhArgv } from "./guard.js";

/** Tools declaradas no catálogo. */
export const gitOpsTools: ExtendedTool[] = [gitFleetTool, gitWorkbenchTool, gitReleaseTool];

export function createGitOpsHandlers(ctx: GitOpsContext) {
  return {
    git_fleet: createGitFleetHandler(ctx),
    git_workbench: createGitWorkbenchHandler(ctx),
    git_release: createGitReleaseHandler(ctx),
  };
}

/** Instância default usada pelo dispatcher. */
export const gitOpsHandlers = createGitOpsHandlers(createGitOpsContext());

export const gitOpsTestHelpers = {
  createGitOpsHandlers,
};
