/**
 * Project Context — ADR-0061
 *
 * Surfaces the active per-repository profile (resolved from the session's
 * cwd at startup — see src/config/profiles.ts) to the agent: which project
 * this session belongs to, its curated context markdown, and the governance
 * lists the profile applied. Read-only, zero side effects.
 */

import type { ExtendedTool } from "../types/mcp-tool-extensions.js";
import { getActiveProfile, profilesFilePath } from "../config/profiles.js";

// ─── Tool definition ──────────────────────────────────────────────────────────

export const projectContextTool: ExtendedTool = {
  name: "get_project_context",
  description:
    "Get the active per-repository profile for this session: project name, curated context markdown, and applied tool governance (ADR-0061). Resolved from the session cwd.",
  defer_loading: true,
  inputSchema: { type: "object", properties: {} },
};

// ─── Handler ──────────────────────────────────────────────────────────────────

export function handleProjectContext(): {
  active: boolean;
  profilesFile: string;
  profile?: {
    name: string;
    matchedBy: "path" | "default";
    path: string;
    context: string | null;
    toolAllowlist: string[];
    toolDisabled: string[];
  };
  hint?: string;
} {
  const active = getActiveProfile();
  if (!active) {
    return {
      active: false,
      profilesFile: profilesFilePath(),
      hint: "No profile matched this session's cwd (or no profiles.json). Declare profiles in NixOS: kernelcore.packages.claude.profiles.",
    };
  }
  return {
    active: true,
    profilesFile: active.profilesFile,
    profile: {
      name: active.name,
      matchedBy: active.matchedBy,
      path: active.profile.path,
      context: active.profile.context ?? null,
      toolAllowlist: active.profile.toolAllowlist ?? [],
      toolDisabled: active.profile.toolDisabled ?? [],
    },
  };
}
