/**
 * Project Profiles — ADR-0061
 *
 * Per-repository context and tool governance for MCP sessions. The MCP
 * client (Claude Code) launches this server with cwd = project root; the
 * profile whose `path` is the longest prefix of that cwd becomes active.
 *
 * A profile can carry:
 *   - `context`: markdown handed to the agent via `get_project_context`
 *   - `toolAllowlist` / `toolDisabled`: fed into the EXISTING governance
 *     env contract (TOOL_ALLOWLIST / TOOL_DISABLED_LIST) — profiles never
 *     bypass ToolGovernanceManager, they configure it.
 *
 * Explicit env vars always win over profile values (instruction hierarchy).
 * No profiles file, or an invalid one → feature is dormant, zero behavior
 * change.
 *
 * File: $SECURELLM_PROFILES_FILE, else $XDG_CONFIG_HOME/securellm/profiles.json,
 * else ~/.config/securellm/profiles.json. Declared from NixOS (claude-code.nix).
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve, sep } from "path";
import { z } from "zod";
import { logger } from "../utils/logger.js";

// ─── Schema ──────────────────────────────────────────────────────────────────

const projectProfileSchema = z.object({
  path: z.string().min(1).describe("Absolute project root this profile applies to"),
  context: z.string().optional().describe("Markdown context served to the agent"),
  toolAllowlist: z.array(z.string()).optional(),
  toolDisabled: z.array(z.string()).optional(),
});

const profilesFileSchema = z.object({
  profiles: z.record(z.string(), projectProfileSchema),
  defaultProfile: z.string().optional(),
});

export type ProjectProfile = z.infer<typeof projectProfileSchema>;
export type ProfilesFile = z.infer<typeof profilesFileSchema>;

export interface ActiveProfile {
  name: string;
  profile: ProjectProfile;
  matchedBy: "path" | "default";
  profilesFile: string;
}

// ─── Loading ─────────────────────────────────────────────────────────────────

function defaultProfilesPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, "securellm", "profiles.json");
}

export function profilesFilePath(): string {
  return process.env.SECURELLM_PROFILES_FILE || defaultProfilesPath();
}

export function loadProfilesFile(): ProfilesFile | null {
  const file = profilesFilePath();
  if (!existsSync(file)) return null;
  try {
    const parsed = profilesFileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success) {
      logger.warn({ file, issues: parsed.error.issues }, "profiles.json invalid — profiles dormant");
      return null;
    }
    return parsed.data;
  } catch (err) {
    logger.warn({ file, err }, "profiles.json unreadable — profiles dormant");
    return null;
  }
}

// ─── Resolution ──────────────────────────────────────────────────────────────

function isPathPrefix(prefix: string, target: string): boolean {
  const p = resolve(prefix);
  const t = resolve(target);
  return t === p || t.startsWith(p.endsWith(sep) ? p : p + sep);
}

export function resolveActiveProfile(cwd: string = process.cwd()): ActiveProfile | null {
  const data = loadProfilesFile();
  if (!data) return null;

  let best: { name: string; profile: ProjectProfile } | null = null;
  for (const [name, profile] of Object.entries(data.profiles)) {
    if (!isPathPrefix(profile.path, cwd)) continue;
    if (!best || resolve(profile.path).length > resolve(best.profile.path).length) {
      best = { name, profile };
    }
  }

  if (best) {
    return { ...best, matchedBy: "path", profilesFile: profilesFilePath() };
  }

  if (data.defaultProfile && data.profiles[data.defaultProfile]) {
    return {
      name: data.defaultProfile,
      profile: data.profiles[data.defaultProfile],
      matchedBy: "default",
      profilesFile: profilesFilePath(),
    };
  }

  return null;
}

// ─── Application ─────────────────────────────────────────────────────────────

let activeProfile: ActiveProfile | null = null;

export function getActiveProfile(): ActiveProfile | null {
  return activeProfile;
}

/**
 * Resolve the profile for `cwd` and feed its governance lists into the
 * existing TOOL_ALLOWLIST / TOOL_DISABLED_LIST env contract. Must run
 * BEFORE ToolGovernanceManager is constructed. Explicit env wins.
 */
export function applyActiveProfile(cwd: string = process.cwd()): ActiveProfile | null {
  activeProfile = resolveActiveProfile(cwd);
  if (!activeProfile) return null;

  const { name, profile } = activeProfile;

  if (profile.toolAllowlist?.length && !process.env.TOOL_ALLOWLIST) {
    process.env.TOOL_ALLOWLIST = profile.toolAllowlist.join(",");
  }
  if (profile.toolDisabled?.length && !process.env.TOOL_DISABLED_LIST) {
    process.env.TOOL_DISABLED_LIST = profile.toolDisabled.join(",");
  }

  logger.info(
    { profile: name, matchedBy: activeProfile.matchedBy, cwd },
    "project profile active"
  );
  return activeProfile;
}
