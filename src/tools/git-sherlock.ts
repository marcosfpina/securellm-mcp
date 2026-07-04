/**
 * Git Sherlock — ADR-0006
 *
 * Git forensics and codebase intelligence:
 *   blame_heatmap    — which lines/files change most?
 *   what_changed     — summarize changes in a time range
 *   review_uncommitted — analyze current diff, suggest commits
 *   churn            — top churned files
 *   authors          — contribution stats
 *   file_history     — commit history of a specific file
 */

import { z } from "zod";
import { execa } from "execa";
import type { ExtendedTool } from "../types/mcp-tool-extensions.js";

// ─── Schema ──────────────────────────────────────────────────────────────────

const gitSherlockSchema = z.object({
  action: z
    .enum([
      "blame_heatmap",
      "what_changed",
      "review_uncommitted",
      "churn",
      "authors",
      "file_history",
    ])
    .describe("What to analyze"),
  path: z.string().optional().describe("Target file or directory"),
  since: z.string().optional().describe("e.g. '3 days ago', '1 week ago'"),
  until: z.string().optional(),
  group_by: z.enum(["file", "author", "day"]).optional().default("file"),
  format: z.enum(["summary", "detailed"]).optional().default("summary"),
  suggest_commits: z
    .boolean()
    .optional()
    .default(false)
    .describe("Generate commit message suggestions for uncommitted changes"),
  top_n: z.number().int().min(1).max(50).optional().default(10),
  max_commits: z.number().int().min(1).max(100).optional().default(20),
});

// ─── Tool definition ──────────────────────────────────────────────────────────

export const gitSherlockTool: ExtendedTool = {
  name: "git_sherlock",
  description:
    "Git forensics: heatmaps, churn analysis, change summaries, uncommitted review with commit suggestions, author stats, and file history (ADR-0006).",
  defer_loading: true,
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "blame_heatmap",
          "what_changed",
          "review_uncommitted",
          "churn",
          "authors",
          "file_history",
        ],
        description: "What to analyze",
      },
      path: { type: "string", description: "Target file or directory" },
      since: { type: "string", description: "e.g. '3 days ago', '1 week ago'" },
      until: { type: "string", description: "End of time range" },
      group_by: {
        type: "string",
        enum: ["file", "author", "day"],
        description: "Group results by",
      },
      format: { type: "string", enum: ["summary", "detailed"], description: "Output detail level" },
      suggest_commits: {
        type: "boolean",
        description: "Suggest commit messages for uncommitted changes",
      },
      top_n: { type: "number", description: "How many results (default: 10)" },
      max_commits: { type: "number", description: "Max commits for file history (default: 20)" },
    },
    required: ["action"],
  },
};

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleGitSherlock(
  args: z.infer<typeof gitSherlockSchema>
): Promise<{ content: Array<{ type: string; text: string }> }> {
  try {
    switch (args.action) {
      case "blame_heatmap":
        return blameHeatmap(args);
      case "what_changed":
        return whatChanged(args);
      case "review_uncommitted":
        return reviewUncommitted(args);
      case "churn":
        return churnAnalysis(args);
      case "authors":
        return authorStats();
      case "file_history":
        return fileHistory(args);
      default:
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: `Unknown action: ${args.action}` }) },
          ],
        };
    }
  } catch (err: any) {
    return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }] };
  }
}

// ─── Actions ─────────────────────────────────────────────────────────────────

async function blameHeatmap(args: { path?: string; top_n?: number }) {
  const { path, top_n = 10 } = args;
  const target = path || ".";
  const cmdArgs = ["blame", "--line-porcelain"];

  // Get list of tracked files
  const { stdout: files } = await execa("git", ["ls-files", target], { timeout: 10_000 }).catch(
    () => ({ stdout: "" })
  );
  const fileList = files.split("\n").filter(Boolean).slice(0, 100); // max 100 files

  const fileChanges: Record<string, { changes: number; authors: Set<string> }> = {};
  const authorChanges: Record<string, number> = {};

  // Sample: blame first 10 files
  for (const file of fileList.slice(0, 20)) {
    const { stdout } = await execa("git", ["blame", "--line-porcelain", file], {
      timeout: 10_000,
    }).catch(() => ({ stdout: "" }));
    const lines = stdout.split("\n");
    let currentAuthor = "";

    for (const line of lines) {
      if (line.startsWith("author ")) {
        currentAuthor = line.slice(7);
        authorChanges[currentAuthor] = (authorChanges[currentAuthor] || 0) + 1;
      }
    }

    if (currentAuthor) {
      if (!fileChanges[file]) fileChanges[file] = { changes: 0, authors: new Set() };
      fileChanges[file].changes = lines.filter(
        (l) => l.length === 40 && /^[0-9a-f]+$/.test(l)
      ).length;
    }
  }

  const topFiles = Object.entries(fileChanges)
    .sort((a, b) => b[1].changes - a[1].changes)
    .slice(0, top_n)
    .map(([file, data]) => ({ file, changes: data.changes, authors: [...data.authors] }));

  const topAuthors = Object.entries(authorChanges)
    .sort((a, b) => b[1] - a[1])
    .slice(0, top_n)
    .map(([author, count]) => ({ author, lines: count }));

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            files_analyzed: fileList.length,
            top_changed_files: topFiles,
            top_authors: topAuthors,
            note: "Based on git blame — shows who last modified each line",
          },
          null,
          2
        ),
      },
    ],
  };
}

async function whatChanged(args: {
  since?: string;
  until?: string;
  group_by?: string;
  format?: string;
}) {
  const { since = "1 week ago", until, group_by = "file", format = "summary" } = args;

  const cmdArgs = ["log", `--since="${since}"`, "--oneline", "--stat"];
  if (until) cmdArgs.push(`--until="${until}"`);

  const { stdout } = await execa("git", cmdArgs, { timeout: 15_000, shell: true }).catch(() => ({
    stdout: "",
  }));

  const commits = stdout.split("\n\n").filter(Boolean);
  const fileMap: Record<string, number> = {};
  const authorMap: Record<string, number> = {};
  const dayMap: Record<string, number> = {};
  let totalCommits = 0;

  for (const block of commits) {
    const lines = block.split("\n");
    if (lines[0] && /^[0-9a-f]{7,}/.test(lines[0])) {
      totalCommits++;
      for (const line of lines.slice(1)) {
        const match = line.match(/^\s+(.+?)\s+\|\s+(\d+)/);
        if (match) {
          fileMap[match[1]] = (fileMap[match[1]] || 0) + parseInt(match[2]);
        }
      }
    }
  }

  // Get author stats separately
  const { stdout: shortlog } = await execa("git", ["shortlog", "-sn", `--since="${since}"`], {
    timeout: 10_000,
    shell: true,
  }).catch(() => ({ stdout: "" }));
  for (const line of shortlog.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)/);
    if (match) authorMap[match[2]] = parseInt(match[1]);
  }

  const topFiles = Object.entries(fileMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            since,
            until: until || "now",
            total_commits: totalCommits,
            files_changed: Object.keys(fileMap).length,
            authors: authorMap,
            top_files: topFiles.map(([f, c]) => ({ file: f, changes: c })),
          },
          null,
          2
        ),
      },
    ],
  };
}

async function reviewUncommitted(args: { suggest_commits?: boolean; format?: string }) {
  const { suggest_commits = false, format = "summary" } = args;

  // Staged changes
  const { stdout: staged } = await execa("git", ["diff", "--cached", "--stat"], {
    timeout: 10_000,
  }).catch(() => ({ stdout: "" }));
  // Unstaged changes
  const { stdout: unstaged } = await execa("git", ["diff", "--stat"], { timeout: 10_000 }).catch(
    () => ({ stdout: "" })
  );
  // Untracked files
  const { stdout: untracked } = await execa("git", ["ls-files", "--others", "--exclude-standard"], {
    timeout: 10_000,
  }).catch(() => ({ stdout: "" }));

  const stagedFiles = staged.split("\n").filter(Boolean);
  const unstagedFiles = unstaged.split("\n").filter(Boolean);
  const untrackedFiles = untracked.split("\n").filter(Boolean);

  // Categorize changes
  const categories: Record<string, string[]> = {};
  for (const line of [...stagedFiles, ...unstagedFiles]) {
    const match = line.match(/^\s*(.+?)\s+\|\s+(\d+)/);
    if (match) {
      const file = match[1].trim();
      const ext = file.split(".").pop() || "";

      if (file.includes("test") || file.includes(".test.")) {
        categories["tests"] = categories["tests"] || [];
        categories["tests"].push(file);
      } else if (file.includes("docs/") || file.endsWith(".md")) {
        categories["docs"] = categories["docs"] || [];
        categories["docs"].push(file);
      } else if (ext === "nix" || file.includes("flake.")) {
        categories["nix"] = categories["nix"] || [];
        categories["nix"].push(file);
      } else if (ext === "ts" || ext === "tsx") {
        categories["source"] = categories["source"] || [];
        categories["source"].push(file);
      } else {
        categories["other"] = categories["other"] || [];
        categories["other"].push(file);
      }
    }
  }

  const result: any = {
    staged: { count: stagedFiles.filter((l) => l.includes("|")).length, files: stagedFiles },
    unstaged: { count: unstagedFiles.filter((l) => l.includes("|")).length, files: unstagedFiles },
    untracked: { count: untrackedFiles.length, files: untrackedFiles.slice(0, 20) },
    categories: Object.fromEntries(Object.entries(categories).map(([k, v]) => [k, v.length])),
  };

  if (suggest_commits) {
    const suggestions: string[] = [];

    for (const [category, files] of Object.entries(categories)) {
      if (!files || files.length === 0) continue;
      const scope = category === "source" ? "code" : category;
      const fileList = files.slice(0, 3).join(", ");
      const verb = category === "docs" ? "docs" : category === "tests" ? "test" : "feat";

      if (category === "nix") {
        suggestions.push(
          `fix(nix): update ${files.length} nix files (${fileList}${files.length > 3 ? ", ..." : ""})`
        );
      } else if (category === "source" && files.some((f) => f.includes("tools/"))) {
        suggestions.push(`feat(tools): add/update ${files.length} tool implementations`);
      } else {
        suggestions.push(
          `${verb}(${scope}): update ${files.length} files (${fileList}${files.length > 3 ? ", ..." : ""})`
        );
      }
    }

    result.suggested_commits = suggestions;
  }

  // Also include the full diff summary for context
  if (format === "detailed") {
    const { stdout: diffSummary } = await execa("git", ["diff", "--stat"], {
      timeout: 10_000,
    }).catch(() => ({ stdout: "" }));
    result.diff_summary = diffSummary;
  }

  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

async function churnAnalysis(args: { since?: string; top_n?: number }) {
  const { since = "1 month ago", top_n = 10 } = args;

  const { stdout } = await execa(
    "git",
    ["log", `--since="${since}"`, "--format=format:", "--name-only"],
    { timeout: 15_000, shell: true }
  ).catch(() => ({ stdout: "" }));

  const fileCount: Record<string, number> = {};
  for (const file of stdout.split("\n")) {
    const trimmed = file.trim();
    if (trimmed) fileCount[trimmed] = (fileCount[trimmed] || 0) + 1;
  }

  const top = Object.entries(fileCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, top_n);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            since,
            total_files: Object.keys(fileCount).length,
            top_churn: top.map(([file, count]) => ({ file, commits: count })),
          },
          null,
          2
        ),
      },
    ],
  };
}

async function authorStats() {
  const { stdout } = await execa("git", ["shortlog", "-sne"], { timeout: 10_000 }).catch(() => ({
    stdout: "",
  }));

  const authors = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(.+?)\s*<(.+?)>/);
      if (match) return { commits: parseInt(match[1]), name: match[2], email: match[3] };
      return { raw: line };
    });

  const { stdout: firstCommit } = await execa(
    "git",
    ["log", "--reverse", "--format=%aI", "--max-count=1"],
    { timeout: 5_000 }
  ).catch(() => ({ stdout: "" }));
  const { stdout: lastCommit } = await execa("git", ["log", "--format=%aI", "--max-count=1"], {
    timeout: 5_000,
  }).catch(() => ({ stdout: "" }));

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            total_authors: authors.length,
            total_commits: authors.reduce((sum, a) => sum + (a.commits || 0), 0),
            first_commit: firstCommit.trim(),
            last_commit: lastCommit.trim(),
            authors,
          },
          null,
          2
        ),
      },
    ],
  };
}

async function fileHistory(args: { path?: string; max_commits?: number }) {
  const { path: filePath, max_commits = 20 } = args;
  if (!filePath)
    return { content: [{ type: "text", text: JSON.stringify({ error: "path is required" }) }] };

  const { stdout } = await execa(
    "git",
    ["log", "--follow", `--max-count=${max_commits}`, "--format=%h|%aI|%an|%s", "--", filePath],
    { timeout: 10_000 }
  ).catch(() => ({ stdout: "" }));

  const commits = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, date, author, ...message] = line.split("|");
      return { hash, date, author, message: message.join("|") };
    });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            file: filePath,
            total_commits_shown: commits.length,
            commits,
          },
          null,
          2
        ),
      },
    ],
  };
}
