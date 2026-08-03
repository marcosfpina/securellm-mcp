import { z } from "zod";
import { execa } from "execa";
import { access, readFile, readdir, stat } from "fs/promises";
import { existsSync } from "fs";
import * as path from "path";
import type { ExtendedTool } from "../types/mcp-tool-extensions.js";
import { zodToMcpSchema } from "../utils/schema-converter.js";
import { stringifyGeneric } from "../utils/json-schemas.js";
import { validatePath } from "../security/path-validator.js";

const serverHealthSchema = z.object({
  include_external_services: z
    .boolean()
    .optional()
    .default(true)
    .describe("Check optional external HTTP services such as Phantom and Cerebro Reranker"),
  include_git: z
    .boolean()
    .optional()
    .default(true)
    .describe("Include git repository health details"),
  timeout_ms: z.number().int().min(250).max(10000).optional().default(2000),
});

const workspaceQualityGateSchema = z.object({
  profile: z
    .enum(["quick", "standard", "full"])
    .optional()
    .default("standard")
    .describe(
      "quick: lint/format/build, standard: quick + test, full: quick + test coverage when available"
    ),
  include_git_status: z
    .boolean()
    .optional()
    .default(true)
    .describe("Include git working tree summary in the report"),
  max_output_chars: z
    .number()
    .int()
    .min(500)
    .max(20000)
    .optional()
    .default(4000)
    .describe("Maximum stdout/stderr chars captured for each executed step"),
  timeout_ms: z.number().int().min(1000).max(120000).optional().default(60000),
});

const performanceReportSchema = z.object({
  top_n: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .default(5)
    .describe("How many top tools to include in each ranked section"),
  include_recommendations: z
    .boolean()
    .optional()
    .default(true)
    .describe("Include prioritized optimization recommendations"),
});

const cacheTuningAdvisorSchema = z.object({
  top_n: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .default(5)
    .describe("How many tools to include in each advisory section"),
});

const changeImpactSchema = z.object({
  target: z
    .string()
    .describe(
      "File or directory to inspect for downstream impact, relative to project root or absolute"
    ),
  max_files: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .default(40)
    .describe("Maximum number of related files to return"),
});

const ciFailureSummarySchema = z
  .object({
    log_text: z
      .string()
      .optional()
      .describe("Raw CI log text to summarize. Best option when logs are already available."),
    log_file: z
      .string()
      .optional()
      .describe("Path to a local CI log file, relative to project root or absolute."),
    run_id: z
      .string()
      .optional()
      .describe(
        "Optional GitHub Actions run ID. When provided, the tool will try `gh run view <id> --log`."
      ),
    include_github_metadata: z
      .boolean()
      .optional()
      .default(true)
      .describe("When run_id is provided, also fetch workflow and job metadata from GitHub CLI."),
    max_log_chars: z
      .number()
      .int()
      .min(1000)
      .max(200000)
      .optional()
      .default(40000)
      .describe("Maximum amount of log text to analyze after trimming"),
    max_structured_entries: z
      .number()
      .int()
      .min(5)
      .max(200)
      .optional()
      .default(40)
      .describe("Maximum number of structured log entries to return, prioritizing errors first"),
    log_level_filter: z
      .enum(["error", "warning", "notice", "all"])
      .optional()
      .default("all")
      .describe("Narrow structured log entries to a single severity level, or 'all' for every level"),
  })
  .refine((value) => Boolean(value.log_text || value.log_file || value.run_id), {
    message: "Provide at least one of log_text, log_file, or run_id",
  });

const toolControlPlaneSchema = z.object({
  include_tools: z
    .boolean()
    .optional()
    .default(true)
    .describe("Include per-tool governance metadata and enforcement decision"),
});

const ciBatchTriageSchema = z.object({
  repos: z
    .array(z.string().min(3))
    .min(1)
    .max(50)
    .describe("GitHub repositories in owner/repo format"),
  workflow: z
    .string()
    .optional()
    .describe("Optional workflow name or file to trigger/filter in each repository"),
  branch: z
    .string()
    .optional()
    .default("main")
    .describe("Branch to target when triggering workflows"),
  action: z
    .enum(["triage_recent", "trigger_and_triage"])
    .optional()
    .default("triage_recent")
    .describe(
      "Either inspect recent workflow runs or trigger a workflow before collecting recent runs"
    ),
  limit_per_repo: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .default(2)
    .describe("How many recent runs to inspect per repository"),
  max_log_chars: z
    .number()
    .int()
    .min(1000)
    .max(100000)
    .optional()
    .default(16000)
    .describe("Maximum chars of failed log text to analyze per run"),
});

type ServerStatus = Awaited<ReturnType<ProfessionalToolDeps["getServerStatus"]>>;

interface ProfessionalToolDeps {
  getProjectRoot: () => string;
  getServerStatus: (includeMetrics: boolean) => Promise<Record<string, unknown>>;
  getToolGovernanceSummary?: (includeTools: boolean) => Record<string, unknown>;
  runCommand?: (
    program: string,
    args: string[],
    options: { cwd: string }
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

interface ToolMetricRecord extends Record<string, unknown> {
  toolName: string;
}

interface QualityGateStep {
  name: string;
  command: string;
  status: "passed" | "failed" | "skipped";
  duration_ms: number;
  exit_code?: number;
  summary: string;
  stdout?: string;
  stderr?: string;
}

interface FileImpactRecord {
  file: string;
  relation: "direct_import" | "re_export" | "symbol_reference";
  score: number;
}

interface CiPatternMatch {
  type:
    | "typescript"
    | "eslint"
    | "prettier"
    | "tests"
    | "module_resolution"
    | "npm"
    | "github_actions"
    | "generic";
  confidence: number;
  title: string;
  cause: string;
  suggestions: string[];
}

interface GithubActionsContext {
  likelyStepName: string | null;
  annotations: string[];
  runnerLines: string[];
}

interface StructuredLogEntry {
  timestamp: string | null;
  job: string | null;
  step: string | null;
  level: "error" | "warning" | "notice" | "info";
  message: string;
}

interface StructuredLog {
  entries: StructuredLogEntry[];
  total_lines: number;
  error_count: number;
  warning_count: number;
  notice_count: number;
  first_timestamp: string | null;
  last_timestamp: string | null;
  duration_ms: number | null;
}

interface GithubRunJob {
  name?: string;
  conclusion?: string;
  status?: string;
  steps?: Array<{ name?: string; conclusion?: string; status?: string }>;
}

interface GithubRunMetadata {
  workflowName?: string;
  name?: string;
  conclusion?: string;
  status?: string;
  event?: string;
  headBranch?: string;
  number?: number;
  url?: string;
  jobs?: GithubRunJob[];
}

interface GithubRunListItem {
  databaseId?: number;
  workflowName?: string;
  displayTitle?: string;
  conclusion?: string;
  status?: string;
  url?: string;
  headBranch?: string;
  event?: string;
}

function buildCommand(program: string, args: string[]): string {
  return [program, ...args].map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ");
}

async function safeAccess(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function checkHttpHealth(url: string, timeoutMs: number) {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return {
      url,
      ok: response.ok,
      status: response.status,
      response_time_ms: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      url,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      response_time_ms: Date.now() - startedAt,
    };
  }
}

async function readPackageScripts(projectRoot: string): Promise<Record<string, string>> {
  try {
    const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
    return packageJson.scripts || {};
  } catch {
    return {};
  }
}

async function safeReadText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function listProjectFiles(
  rootDir: string,
  extensions: string[],
  limit: number
): Promise<string[]> {
  const queue = [rootDir];
  const results: string[] = [];

  while (queue.length > 0 && results.length < limit) {
    const current = queue.shift()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (results.length >= limit) break;
      if (entry.name.startsWith(".")) continue;
      if (["node_modules", "build", "dist", "coverage"].includes(entry.name)) continue;

      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }

      if (extensions.includes(path.extname(entry.name))) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeImportSpec(specifier: string): string {
  return specifier.replaceAll(path.sep, "/").replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
}

function trimLogForAnalysis(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.6));
  const tail = text.slice(-Math.floor(maxChars * 0.4));
  return `${head}\n...[trimmed for analysis]...\n${tail}`;
}

function uniqueLines(lines: string[], limit: number): string[] {
  return Array.from(new Set(lines.map((line) => line.trim()).filter(Boolean))).slice(0, limit);
}

function extractGithubActionsContext(logText: string): GithubActionsContext {
  const lines = logText.split("\n");
  let currentStep: string | null = null;
  let likelyStepName: string | null = null;
  const annotations: string[] = [];
  const runnerLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const stepMatch =
      line.match(/^##\[group\]Run\s+(.+)$/) ||
      line.match(/^Run\s+(.+)$/) ||
      line.match(/^##\[group\](.+)$/);

    if (stepMatch?.[1]) {
      currentStep = stepMatch[1].trim();
    }

    if (/##\[error\]|Process completed with exit code/i.test(line)) {
      likelyStepName = likelyStepName || currentStep;
      if (annotations.length < 6) {
        annotations.push(line);
      }
    }

    if (
      /Current runner version:|Operating System|Runner Image|Runner Image Provisioner/i.test(line)
    ) {
      runnerLines.push(line);
    }
  }

  return {
    likelyStepName,
    annotations: uniqueLines(annotations, 6),
    runnerLines: uniqueLines(runnerLines, 4),
  };
}

const GH_LOG_LINE_RE = /^(?:([^\t]*)\t([^\t]*)\t)?(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s?(.*)$/;

function classifyLogLevel(message: string): StructuredLogEntry["level"] {
  if (
    /##\[error\]|error TS\d+:|AssertionError|npm ERR!|pnpm ERR!|yarn error|Cannot find module|not ok \d+|Process completed with exit code [1-9]/i.test(
      message
    )
  ) {
    return "error";
  }
  if (/##\[warning\]|\bwarn(ing)?\b/i.test(message)) {
    return "warning";
  }
  if (/##\[notice\]|##\[group\]|##\[endgroup\]/i.test(message)) {
    return "notice";
  }
  return "info";
}

/**
 * Turns raw CI log text into timestamped, job/step-attributed entries.
 * Tolerant of `gh run view --log`'s `job\tstep\ttimestamp message` lines and of
 * plain runner log lines with no job/step/timestamp prefix at all.
 */
function parseGithubActionsLog(
  logText: string,
  opts: { maxEntries: number; levelFilter: "error" | "warning" | "notice" | "all" }
): StructuredLog {
  const lines = logText.split("\n");
  let currentStep: string | null = null;
  const signalEntries: StructuredLogEntry[] = [];
  let errorCount = 0;
  let warningCount = 0;
  let noticeCount = 0;
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;

    const match = line.match(GH_LOG_LINE_RE);
    let job: string | null = null;
    let step: string | null = null;
    let timestamp: string | null = null;
    let message = line;

    if (match) {
      job = match[1]?.trim() || null;
      step = match[2]?.trim() || null;
      timestamp = match[3] || null;
      message = (match[4] ?? "").trim();
    }

    const stepMatch =
      message.match(/^##\[group\]Run\s+(.+)$/) ||
      message.match(/^Run\s+(.+)$/) ||
      message.match(/^##\[group\](.+)$/);
    if (stepMatch?.[1]) {
      currentStep = stepMatch[1].trim();
    }

    if (timestamp) {
      firstTimestamp = firstTimestamp ?? timestamp;
      lastTimestamp = timestamp;
    }

    const level = classifyLogLevel(message);
    if (level === "error") errorCount++;
    else if (level === "warning") warningCount++;
    else if (level === "notice") noticeCount++;
    else continue; // keep the entry list focused on signal, not routine info lines

    signalEntries.push({
      timestamp,
      job,
      step: step || currentStep,
      level,
      message: message.slice(0, 500),
    });
  }

  const levelPriority: Record<"error" | "warning" | "notice", number> = {
    error: 0,
    warning: 1,
    notice: 2,
  };
  const filtered =
    opts.levelFilter === "all"
      ? signalEntries
      : signalEntries.filter((entry) => entry.level === opts.levelFilter);
  filtered.sort(
    (a, b) =>
      levelPriority[a.level as "error" | "warning" | "notice"] -
      levelPriority[b.level as "error" | "warning" | "notice"]
  );

  const seen = new Set<string>();
  const entries: StructuredLogEntry[] = [];
  for (const entry of filtered) {
    const key = `${entry.level}:${entry.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
    if (entries.length >= opts.maxEntries) break;
  }

  const durationMs =
    firstTimestamp && lastTimestamp
      ? Math.max(0, new Date(lastTimestamp).getTime() - new Date(firstTimestamp).getTime())
      : null;

  return {
    entries,
    total_lines: lines.length,
    error_count: errorCount,
    warning_count: warningCount,
    notice_count: noticeCount,
    first_timestamp: firstTimestamp,
    last_timestamp: lastTimestamp,
    duration_ms: durationMs,
  };
}

function detectCiPatterns(logText: string): CiPatternMatch[] {
  const patterns: CiPatternMatch[] = [];
  const lower = logText.toLowerCase();

  if (/error TS\d+:/i.test(logText)) {
    patterns.push({
      type: "typescript",
      confidence: 0.95,
      title: "TypeScript compilation failure",
      cause:
        "The CI log contains TypeScript compiler errors (`TSxxxx`), which usually means type drift or invalid imports.",
      suggestions: [
        "Run `npm run build` locally and fix the first TypeScript error before chasing follow-on errors.",
        "Check recently changed interfaces, renamed exports, and path aliases.",
      ],
    });
  }

  if (/eslint|no-unused-vars|Parsing error|Expected .* but found/i.test(logText)) {
    patterns.push({
      type: "eslint",
      confidence: 0.9,
      title: "Lint failure",
      cause: "The log looks like an ESLint failure rather than a runtime or compile error.",
      suggestions: [
        "Run `npm run lint` locally to reproduce the exact offending file and rule.",
        "If the rule is expected, align the code style or update the lint config intentionally.",
      ],
    });
  }

  if (/prettier|Code style issues found|--check/i.test(logText)) {
    patterns.push({
      type: "prettier",
      confidence: 0.82,
      title: "Formatting check failure",
      cause: "The log indicates formatting drift detected by Prettier or an equivalent formatter.",
      suggestions: [
        "Run `npm run format` or the repository formatter command and commit the resulting diffs.",
      ],
    });
  }

  if (/AssertionError|not ok \d+|failing|failed tests?|expected:|received:/i.test(logText)) {
    patterns.push({
      type: "tests",
      confidence: 0.88,
      title: "Test suite failure",
      cause:
        "The log contains test assertion markers, suggesting behavioral regression instead of infra-only failure.",
      suggestions: [
        "Re-run the failing test file locally first to isolate whether this is deterministic.",
        "Compare expected outputs with recent code-path changes and fixtures.",
      ],
    });
  }

  if (/Cannot find module|module not found|ERR_MODULE_NOT_FOUND/i.test(logText)) {
    patterns.push({
      type: "module_resolution",
      confidence: 0.91,
      title: "Module resolution failure",
      cause: "CI could not resolve a required module, file, or export at build/test time.",
      suggestions: [
        "Check import paths, file casing, and whether generated build artifacts are required but missing.",
        "Verify the dependency exists in `package.json` and is available in the lockfile.",
      ],
    });
  }

  if (/npm ERR!|pnpm ERR!|yarn error/i.test(logText)) {
    patterns.push({
      type: "npm",
      confidence: 0.78,
      title: "Package manager failure",
      cause: "The package manager reported an install or script execution failure.",
      suggestions: [
        "Inspect the first `npm ERR!` block; later errors are often secondary symptoms.",
        "Check whether the failure happened during install, build, or test command execution.",
      ],
    });
  }

  if (
    /Process completed with exit code \d+|Error: Process completed with exit code/i.test(logText)
  ) {
    patterns.push({
      type: "github_actions",
      confidence: 0.65,
      title: "GitHub Actions step failure",
      cause:
        "The workflow step exited non-zero. This usually wraps another underlying compile, test, or script failure.",
      suggestions: [
        "Scroll upward to the first error block in the same step; the exit code line is usually not the root cause.",
      ],
    });
  }

  if (patterns.length === 0 && lower.includes("error")) {
    patterns.push({
      type: "generic",
      confidence: 0.45,
      title: "Generic CI error",
      cause:
        "The log contains error markers, but it does not strongly match a known failure family.",
      suggestions: [
        "Review the earliest stack trace or command failure in the log for the actual root cause.",
      ],
    });
  }

  return patterns.sort((a, b) => b.confidence - a.confidence);
}

function extractFailureSignals(logText: string): string[] {
  const lines = logText.split("\n");
  const matches = lines.filter((line) =>
    /error TS\d+:|AssertionError|Cannot find module|module not found|npm ERR!|eslint|prettier|not ok \d+|failed/i.test(
      line
    )
  );
  return uniqueLines(matches, 8);
}

function summarizeCiFailure(
  logText: string,
  structuredLogOptions: { maxEntries: number; levelFilter: "error" | "warning" | "notice" | "all" } = {
    maxEntries: 40,
    levelFilter: "all",
  }
) {
  const patterns = detectCiPatterns(logText);
  const topPattern = patterns[0];
  const failureSignals = extractFailureSignals(logText);
  const actionsContext = extractGithubActionsContext(logText);
  const structuredLog = parseGithubActionsLog(logText, structuredLogOptions);

  return {
    summary: topPattern?.title || "Unknown CI failure",
    likely_cause:
      topPattern?.cause ||
      "The log does not match a strong known pattern yet. Manual review of the first failure block is recommended.",
    category: topPattern?.type || "generic",
    confidence: topPattern?.confidence || 0.3,
    failure_signals: failureSignals,
    suggested_fixes: uniqueLines(
      patterns.flatMap((pattern) => pattern.suggestions),
      6
    ),
    github_actions_context: actionsContext,
    structured_log: structuredLog,
  };
}

function summarizeGithubRunMetadata(metadata: GithubRunMetadata | null | undefined) {
  if (!metadata) {
    return {
      workflow_name: null,
      run_name: null,
      run_conclusion: null,
      status: null,
      event: null,
      head_branch: null,
      url: null,
      failed_job: null as null | {
        name: string | null;
        conclusion: string | null;
        failed_steps: string[];
      },
      job_summaries: [] as Array<{
        name: string | null;
        conclusion: string | null;
        status: string | null;
      }>,
    };
  }

  const jobs = Array.isArray(metadata.jobs) ? metadata.jobs : [];
  const failedJob =
    jobs.find((job) =>
      ["failure", "cancelled", "timed_out", "startup_failure", "action_required"].includes(
        job.conclusion || ""
      )
    ) ||
    jobs.find((job) => (job.status || "").toLowerCase() === "failed") ||
    null;

  return {
    workflow_name: metadata.workflowName || null,
    run_name: metadata.name || null,
    run_conclusion: metadata.conclusion || null,
    status: metadata.status || null,
    event: metadata.event || null,
    head_branch: metadata.headBranch || null,
    url: metadata.url || null,
    failed_job: failedJob
      ? {
          name: failedJob.name || null,
          conclusion: failedJob.conclusion || null,
          failed_steps: Array.isArray(failedJob.steps)
            ? uniqueLines(
                failedJob.steps
                  .filter((step) =>
                    ["failure", "cancelled", "timed_out", "action_required"].includes(
                      step.conclusion || ""
                    )
                  )
                  .map((step) => step.name || "UNKNOWN STEP"),
                8
              )
            : [],
        }
      : null,
    job_summaries: jobs.slice(0, 12).map((job) => ({
      name: job.name || null,
      conclusion: job.conclusion || null,
      status: job.status || null,
    })),
  };
}

async function triageGithubRun(
  projectRoot: string,
  repo: string,
  runId: string,
  maxLogChars: number,
  runCommand: (
    program: string,
    args: string[],
    options: { cwd: string }
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>
) {
  const [logResult, metadataResult] = await Promise.all([
    runCommand("gh", ["run", "view", runId, "--repo", repo, "--log-failed"], { cwd: projectRoot }),
    runCommand(
      "gh",
      [
        "run",
        "view",
        runId,
        "--repo",
        repo,
        "--json",
        "workflowName,name,conclusion,status,event,headBranch,number,url,jobs",
      ],
      { cwd: projectRoot }
    ),
  ]);

  const logText = logResult.stdout || logResult.stderr || "";
  const summary = summarizeCiFailure(trimLogForAnalysis(logText, maxLogChars), {
    maxEntries: 5,
    levelFilter: "all",
  });
  let githubRun = null as ReturnType<typeof summarizeGithubRunMetadata> | null;

  if (metadataResult.exitCode === 0 && metadataResult.stdout.trim()) {
    try {
      githubRun = summarizeGithubRunMetadata(JSON.parse(metadataResult.stdout));
    } catch {
      githubRun = null;
    }
  }

  return {
    run_id: runId,
    repo,
    source: `gh run ${runId} --repo ${repo}`,
    summary: summary.summary,
    likely_cause: summary.likely_cause,
    category: summary.category,
    confidence: summary.confidence,
    failure_signals: summary.failure_signals,
    github_actions_step: summary.github_actions_context.likelyStepName,
    github_actions_annotations: summary.github_actions_context.annotations,
    github_run: githubRun,
    structured_log: summary.structured_log,
    log_available: Boolean(logText.trim()),
    log_error:
      logResult.exitCode === 0
        ? null
        : logResult.stderr.trim() || "Unable to fetch failed-step logs for this run.",
  };
}

async function collectChangeImpact(
  projectRoot: string,
  target: string,
  maxFiles: number
): Promise<{
  target: string;
  targetType: "file" | "directory";
  relatedFiles: FileImpactRecord[];
  summary: {
    directImporters: number;
    reExporters: number;
    symbolReferences: number;
  };
}> {
  const safeTarget = validatePath(target, projectRoot);
  const targetStats = await stat(safeTarget);
  const targetType = targetStats.isDirectory() ? "directory" : "file";
  const projectFiles = await listProjectFiles(
    projectRoot,
    [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    2000
  );

  const relativeTarget = path.relative(projectRoot, safeTarget).replaceAll(path.sep, "/");

  const symbolNames =
    targetType === "file"
      ? Array.from(
          new Set(
            ((await safeReadText(safeTarget)) || "")
              .match(/export\s+(?:const|function|class|interface|type)\s+([A-Za-z_]\w*)/g)
              ?.map((match) => match.replace(/.*\s+([A-Za-z_]\w*)$/, "$1")) || []
          )
        )
      : [];

  const relatedFiles: FileImpactRecord[] = [];

  for (const file of projectFiles) {
    if (file === safeTarget) continue;
    const text = await safeReadText(file);
    if (!text) continue;

    const relativeFile = path.relative(projectRoot, file).replaceAll(path.sep, "/");
    const relativeSpecifier = normalizeImportSpec(
      path.relative(path.dirname(file), safeTarget).replaceAll(path.sep, "/")
    );
    const localSpecifier = relativeSpecifier.startsWith(".")
      ? relativeSpecifier
      : `./${relativeSpecifier}`;
    const importNeedles = new Set([
      localSpecifier,
      normalizeImportSpec(relativeTarget),
      relativeTarget,
    ]);
    let score = 0;
    let relation: FileImpactRecord["relation"] | null = null;

    for (const needle of importNeedles) {
      if (
        text.includes(`export * from "${needle}"`) ||
        text.includes(`export * from '${needle}'`)
      ) {
        relation = "re_export";
        score = 4;
        break;
      }
      if (text.includes(`from "${needle}"`) || text.includes(`from '${needle}'`)) {
        relation = "direct_import";
        score = 3;
        break;
      }
    }

    if (!relation && symbolNames.length > 0) {
      for (const symbol of symbolNames) {
        const regex = new RegExp(`\\b${escapeRegex(symbol)}\\b`);
        if (regex.test(text)) {
          relation = "symbol_reference";
          score = 1;
          break;
        }
      }
    }

    if (relation) {
      relatedFiles.push({
        file: relativeFile,
        relation,
        score,
      });
    }
  }

  relatedFiles.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  const trimmed = relatedFiles.slice(0, maxFiles);

  return {
    target: relativeTarget,
    targetType,
    relatedFiles: trimmed,
    summary: {
      directImporters: trimmed.filter((item) => item.relation === "direct_import").length,
      reExporters: trimmed.filter((item) => item.relation === "re_export").length,
      symbolReferences: trimmed.filter((item) => item.relation === "symbol_reference").length,
    },
  };
}

async function runQualityStep(
  projectRoot: string,
  name: string,
  command: { program: string; args: string[] } | null,
  maxOutputChars: number,
  timeoutMs: number
): Promise<QualityGateStep> {
  if (!command) {
    return {
      name,
      command: "not configured",
      status: "skipped",
      duration_ms: 0,
      summary: "Step skipped because no matching project script was found.",
    };
  }

  const startedAt = Date.now();
  const result = await execa(command.program, command.args, {
    cwd: projectRoot,
    reject: false,
    preferLocal: true,
    timeout: timeoutMs,
  });
  const durationMs = Date.now() - startedAt;
  const stdout = result.stdout.slice(-maxOutputChars);
  const stderr = result.stderr.slice(-maxOutputChars);

  return {
    name,
    command: buildCommand(command.program, command.args),
    status: result.exitCode === 0 ? "passed" : "failed",
    duration_ms: durationMs,
    exit_code: result.exitCode ?? undefined,
    summary:
      result.exitCode === 0
        ? `${name} passed`
        : `${name} failed with exit code ${result.exitCode ?? "unknown"}`,
    stdout: stdout || undefined,
    stderr: stderr || undefined,
  };
}

function selectQualityCommands(
  scripts: Record<string, string>,
  profile: z.infer<typeof workspaceQualityGateSchema>["profile"]
) {
  const formatCheck = scripts["format:check"]
    ? { program: "npm", args: ["run", "format:check"] }
    : scripts.format
      ? { program: "npm", args: ["run", "format"] }
      : null;

  const lint = scripts.lint ? { program: "npm", args: ["run", "lint"] } : null;
  const build = scripts.build ? { program: "npm", args: ["run", "build"] } : null;

  let test: { program: string; args: string[] } | null = null;
  if (profile === "full" && scripts["test:coverage"]) {
    test = { program: "npm", args: ["run", "test:coverage"] };
  } else if (scripts.test) {
    test = { program: "npm", args: ["test"] };
  }

  const steps: Array<{ name: string; command: { program: string; args: string[] } | null }> = [
    { name: "format_check", command: formatCheck },
    { name: "lint", command: lint },
    { name: "build", command: build },
  ];

  if (profile !== "quick") {
    steps.push({ name: profile === "full" ? "test_coverage" : "test", command: test });
  }

  return steps;
}

async function getGitSummary(projectRoot: string) {
  const insideWorkTree = await execa("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: projectRoot,
    reject: false,
  });
  if (insideWorkTree.exitCode !== 0 || insideWorkTree.stdout.trim() !== "true") {
    return { available: false };
  }

  const [branch, status] = await Promise.all([
    execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: projectRoot, reject: false }),
    execa("git", ["status", "--short"], { cwd: projectRoot, reject: false }),
  ]);

  const lines = status.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return {
    available: true,
    branch: branch.stdout.trim() || "unknown",
    dirty: lines.length > 0,
    changed_files: lines.slice(0, 20),
    changed_files_count: lines.length,
  };
}

function summarizeQualityGate(steps: QualityGateStep[]): {
  overall_status: "passed" | "failed";
  passed: number;
  failed: number;
  skipped: number;
} {
  const passed = steps.filter((step) => step.status === "passed").length;
  const failed = steps.filter((step) => step.status === "failed").length;
  const skipped = steps.filter((step) => step.status === "skipped").length;

  return {
    overall_status: failed > 0 ? "failed" : "passed",
    passed,
    failed,
    skipped,
  };
}

export const professionalTools: ExtendedTool[] = [
  {
    name: "server_health",
    description:
      "Professional runtime health report for the MCP server and its optional dependencies",
    inputSchema: zodToMcpSchema(serverHealthSchema),
    defer_loading: true,
  },
  {
    name: "workspace_quality_gate",
    description:
      "Run a professional workspace quality gate across formatting, linting, build, and tests",
    inputSchema: zodToMcpSchema(workspaceQualityGateSchema),
    defer_loading: true,
  },
  {
    name: "performance_report",
    description:
      "Summarize MCP performance hotspots, token savings, and response compaction opportunities across tools",
    inputSchema: zodToMcpSchema(performanceReportSchema),
    defer_loading: true,
  },
  {
    name: "cache_tuning_advisor",
    description:
      "Recommend semantic cache and response compaction tuning based on observed tool metrics",
    inputSchema: zodToMcpSchema(cacheTuningAdvisorSchema),
    defer_loading: true,
  },
  {
    name: "change_impact",
    description:
      "Estimate which files are most likely to be affected by a change in a target file or directory",
    inputSchema: zodToMcpSchema(changeImpactSchema),
    defer_loading: true,
  },
  {
    name: "ci_failure_summary",
    description:
      "Summarize CI logs into likely root cause, confidence, failure signals, and next fixes",
    inputSchema: zodToMcpSchema(ciFailureSummarySchema),
    defer_loading: true,
    priority: "high",
    execution_class: "diagnostic",
    cost_tier: "cheap",
    volatile: true,
  },
  {
    name: "tool_control_plane",
    description:
      "Inspect tool priority, degraded-mode policy, and enforcement decisions for MCP tools",
    inputSchema: zodToMcpSchema(toolControlPlaneSchema),
    defer_loading: true,
    priority: "high",
    execution_class: "diagnostic",
    cost_tier: "cheap",
    volatile: true,
  },
  {
    name: "ci_batch_triage",
    description: "Trigger and/or triage recent GitHub Actions runs across multiple repositories",
    inputSchema: zodToMcpSchema(ciBatchTriageSchema),
    defer_loading: true,
    priority: "high",
    execution_class: "diagnostic",
    cost_tier: "moderate",
    volatile: true,
  },
];

function rankTools<T>(toolMetrics: T[], topN: number, selector: (metric: T) => number) {
  return [...toolMetrics].sort((a, b) => selector(b) - selector(a)).slice(0, topN);
}

export function createProfessionalToolHandlers(deps: ProfessionalToolDeps) {
  const runCommand =
    deps.runCommand ||
    (async (program: string, args: string[], options: { cwd: string }) => {
      const result = await execa(program, args, {
        cwd: options.cwd,
        reject: false,
        preferLocal: true,
      });
      return {
        exitCode: result.exitCode ?? 0,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    });

  return {
    async server_health(rawArgs: unknown) {
      const args = serverHealthSchema.parse(rawArgs ?? {});
      const status = await deps.getServerStatus(false);
      const projectRoot = deps.getProjectRoot();

      const [projectRootReadable, packageJsonPresent, flakePresent, buildPresent, gitSummary] =
        await Promise.all([
          safeAccess(projectRoot),
          safeAccess(path.join(projectRoot, "package.json")),
          safeAccess(path.join(projectRoot, "flake.nix")),
          safeAccess(path.join(projectRoot, "build")),
          args.include_git ? getGitSummary(projectRoot) : Promise.resolve({ available: false }),
        ]);

      const externalServices = args.include_external_services
        ? await Promise.all([
            checkHttpHealth(
              `${process.env.PHANTOM_URL ?? "http://localhost:8008"}/health`,
              args.timeout_ms
            ),
            checkHttpHealth(
              `${process.env.CEREBRO_RERANKER_URL ?? "http://localhost:8016"}/health`,
              args.timeout_ms
            ),
          ])
        : [];

      const warnings: string[] = [];
      if (!projectRootReadable) warnings.push("Project root is not readable");
      if (!packageJsonPresent) warnings.push("package.json not found in project root");
      if (!buildPresent) warnings.push("Build artifacts directory not found");
      for (const service of externalServices) {
        if (!service.ok) {
          warnings.push(`External service unhealthy: ${service.url}`);
        }
      }

      const overallStatus = warnings.length === 0 ? "healthy" : "degraded";

      return {
        content: [
          {
            type: "text",
            text: stringifyGeneric({
              overall_status: overallStatus,
              warnings,
              runtime: status,
              workspace: {
                project_root: projectRoot,
                readable: projectRootReadable,
                package_json_present: packageJsonPresent,
                flake_present: flakePresent,
                build_present: buildPresent,
              },
              git: gitSummary,
              external_services: externalServices,
              memory: {
                rss_bytes: process.memoryUsage().rss,
                heap_used_bytes: process.memoryUsage().heapUsed,
                heap_total_bytes: process.memoryUsage().heapTotal,
              },
              timestamp: new Date().toISOString(),
            }),
          },
        ],
      };
    },

    async workspace_quality_gate(rawArgs: unknown) {
      const args = workspaceQualityGateSchema.parse(rawArgs ?? {});
      const projectRoot = deps.getProjectRoot();
      const scripts = await readPackageScripts(projectRoot);
      const configuredSteps = selectQualityCommands(scripts, args.profile);
      const steps: QualityGateStep[] = [];

      for (const step of configuredSteps) {
        steps.push(
          await runQualityStep(
            projectRoot,
            step.name,
            step.command,
            args.max_output_chars,
            args.timeout_ms
          )
        );
      }

      const summary = summarizeQualityGate(steps);
      const git = args.include_git_status ? await getGitSummary(projectRoot) : undefined;
      const recommendations = [
        ...(summary.failed > 0
          ? ["Fix failed quality gate steps before merging or releasing this workspace."]
          : ["Workspace quality gate passed for the selected profile."]),
        ...(summary.skipped > 0
          ? ["Some steps were skipped because matching npm scripts are not configured."]
          : []),
      ];

      return {
        content: [
          {
            type: "text",
            text: stringifyGeneric({
              profile: args.profile,
              summary,
              recommendations,
              scripts_detected: Object.keys(scripts).sort(),
              steps,
              git,
              timestamp: new Date().toISOString(),
            }),
          },
        ],
        isError: summary.overall_status === "failed",
      };
    },

    async performance_report(rawArgs: unknown) {
      const args = performanceReportSchema.parse(rawArgs ?? {});
      const status = await deps.getServerStatus(true);
      const statusMetrics = (status.metrics || {}) as Record<string, unknown>;
      const rawToolMetrics = (statusMetrics.toolMetrics || {}) as Record<
        string,
        Record<string, unknown>
      >;
      const metricsList: ToolMetricRecord[] = Object.entries(rawToolMetrics).map(
        ([toolName, metric]) => ({
          toolName,
          ...metric,
        })
      );

      const topLatency = rankTools(metricsList, args.top_n, (metric) =>
        Number(metric.averageLatency || 0)
      ).map((metric) => ({
        tool: metric.toolName,
        average_latency_ms: Math.round(Number(metric.averageLatency || 0)),
        p95_latency_ms: Math.round(
          Number((metric.latencyPercentiles as Record<string, unknown>)?.p95 || 0)
        ),
        requests: Number(metric.totalRequests || 0),
      }));

      const topTokenSavings = rankTools(metricsList, args.top_n, (metric) =>
        Number(metric.totalCompactionTokensSaved || 0)
      ).map((metric) => ({
        tool: metric.toolName,
        compacted_tokens_saved: Number(metric.totalCompactionTokensSaved || 0),
        compacted_fields: Number(metric.compactionAppliedCount || 0),
        compaction_rate: Number(metric.compactionRate || 0),
      }));

      const topCompactionCandidates = rankTools(
        metricsList,
        args.top_n,
        (metric) =>
          Number(metric.averageOriginalResponseSize || 0) -
          Number(metric.averageCompactedResponseSize || 0)
      ).map((metric) => ({
        tool: metric.toolName,
        average_original_response_bytes: Math.round(
          Number(metric.averageOriginalResponseSize || 0)
        ),
        average_compacted_response_bytes: Math.round(
          Number(metric.averageCompactedResponseSize || metric.averageResponseSize || 0)
        ),
        bytes_saved_per_response: Math.round(
          Number(metric.averageOriginalResponseSize || 0) -
            Number(metric.averageCompactedResponseSize || metric.averageResponseSize || 0)
        ),
      }));

      const recommendations = args.include_recommendations
        ? [
            ...(topLatency.length > 0 && topLatency[0].average_latency_ms > 500
              ? [
                  `Investigate high-latency tool '${topLatency[0].tool}' for extra caching, lighter shell execution, or reduced upstream I/O.`,
                ]
              : []),
            ...(topCompactionCandidates.some((item) => item.bytes_saved_per_response > 0)
              ? [
                  "Expand response compaction patterns for tools with the largest byte deltas to reduce output token cost further.",
                ]
              : []),
            ...(topTokenSavings.some((item) => item.compacted_tokens_saved > 0)
              ? [
                  "Prioritize heavily-used tools with high compaction savings for richer summaries and stable cache keys.",
                ]
              : []),
            ...(metricsList.length === 0
              ? [
                  "Collect runtime traffic first so the performance report has tool metrics to analyze.",
                ]
              : []),
          ]
        : [];

      return {
        content: [
          {
            type: "text",
            text: stringifyGeneric({
              generated_at: new Date().toISOString(),
              project_root: deps.getProjectRoot(),
              totals: {
                analyzed_tools: metricsList.length,
                requests_observed: metricsList.reduce(
                  (sum, metric) => sum + Number(metric.totalRequests || 0),
                  0
                ),
                compaction_tokens_saved: metricsList.reduce(
                  (sum, metric) => sum + Number(metric.totalCompactionTokensSaved || 0),
                  0
                ),
                semantic_cache_tokens_saved: Number(
                  ((statusMetrics.semanticCache as Record<string, unknown> | undefined)
                    ?.tokensSaved as number | undefined) || 0
                ),
              },
              top_latency_tools: topLatency,
              top_token_savers: topTokenSavings,
              top_compaction_candidates: topCompactionCandidates,
              recommendations,
            }),
          },
        ],
      };
    },

    async cache_tuning_advisor(rawArgs: unknown) {
      const args = cacheTuningAdvisorSchema.parse(rawArgs ?? {});
      const status = await deps.getServerStatus(true);
      const statusMetrics = (status.metrics || {}) as Record<string, unknown>;
      const rawToolMetrics = (statusMetrics.toolMetrics || {}) as Record<
        string,
        Record<string, unknown>
      >;
      const metricsList: ToolMetricRecord[] = Object.entries(rawToolMetrics).map(
        ([toolName, metric]) => ({
          toolName,
          ...metric,
        })
      );

      const cacheCandidates = rankTools(
        metricsList.filter((metric) => Number(metric.cacheMisses || 0) > 0),
        args.top_n,
        (metric) => Number(metric.cacheMisses || 0) * Number(metric.averageLatency || 0)
      ).map((metric) => ({
        tool: metric.toolName,
        cache_misses: Number(metric.cacheMisses || 0),
        average_latency_ms: Math.round(Number(metric.averageLatency || 0)),
        suggestion:
          Number(metric.cacheHits || 0) === 0
            ? "Consider making this tool more cache-friendly or explicitly excluding it if results are highly volatile."
            : "Consider raising TTL or stabilizing cache keys to improve hit rate.",
      }));

      const compactionCandidates = rankTools(
        metricsList.filter((metric) => Number(metric.averageOriginalResponseSize || 0) > 0),
        args.top_n,
        (metric) =>
          Number(metric.averageOriginalResponseSize || 0) - Number(metric.averageResponseSize || 0)
      ).map((metric) => ({
        tool: metric.toolName,
        average_original_response_bytes: Math.round(
          Number(metric.averageOriginalResponseSize || 0)
        ),
        average_compacted_response_bytes: Math.round(Number(metric.averageResponseSize || 0)),
        compaction_rate: Number(metric.compactionRate || 0),
        suggestion:
          Number(metric.compactionAppliedCount || 0) > 0
            ? "Response compaction is already helping; consider tailoring tool-specific summaries for even better compression."
            : "Large responses without compaction suggest a good candidate for custom summarization.",
      }));

      const volatileCandidates = rankTools(metricsList, args.top_n, (metric) =>
        Number(metric.averageLatency || 0)
      )
        .filter(
          (metric) =>
            Number(metric.cacheHits || 0) === 0 &&
            Number(metric.cacheMisses || 0) > 0 &&
            Number(metric.averageLatency || 0) > 200
        )
        .map((metric) => ({
          tool: metric.toolName,
          cache_hit_rate:
            Number(metric.totalRequests || 0) > 0
              ? Number(metric.cacheHits || 0) / Number(metric.totalRequests || 0)
              : 0,
          average_latency_ms: Math.round(Number(metric.averageLatency || 0)),
          suggestion:
            "If this tool is time-sensitive or stateful, consider excluding it from semantic cache to avoid lookup overhead.",
        }));

      return {
        content: [
          {
            type: "text",
            text: stringifyGeneric({
              generated_at: new Date().toISOString(),
              semantic_cache_defaults: {
                threshold: process.env.SEMANTIC_CACHE_THRESHOLD || "0.85",
                ttl_seconds: process.env.SEMANTIC_CACHE_TTL || "3600",
                max_response_bytes: process.env.SEMANTIC_CACHE_MAX_RESPONSE_BYTES || "131072",
              },
              cache_candidates: cacheCandidates,
              compaction_candidates: compactionCandidates,
              volatile_or_low_yield_tools: volatileCandidates,
              recommendations: [
                ...(cacheCandidates.length > 0
                  ? [
                      "Prioritize the highest miss x latency tools for cache-key stabilization or TTL tuning.",
                    ]
                  : []),
                ...(compactionCandidates.length > 0
                  ? [
                      "The largest original-vs-compacted payload gaps are the best places for custom summaries.",
                    ]
                  : []),
                ...(volatileCandidates.length > 0
                  ? [
                      "Some tools may cost more to look up in cache than they save; consider explicit exclusion.",
                    ]
                  : []),
              ],
            }),
          },
        ],
      };
    },

    async change_impact(rawArgs: unknown) {
      const args = changeImpactSchema.parse(rawArgs ?? {});
      const projectRoot = deps.getProjectRoot();
      const impact = await collectChangeImpact(projectRoot, args.target, args.max_files);

      const risk =
        impact.summary.reExporters > 0
          ? "high"
          : impact.summary.directImporters > 8
            ? "high"
            : impact.summary.directImporters > 3 || impact.summary.symbolReferences > 8
              ? "medium"
              : "low";

      return {
        content: [
          {
            type: "text",
            text: stringifyGeneric({
              generated_at: new Date().toISOString(),
              target: impact.target,
              target_type: impact.targetType,
              estimated_risk: risk,
              summary: impact.summary,
              related_files: impact.relatedFiles,
              guidance: [
                "Review direct importers first; they are the most likely to break behaviorally.",
                "Re-exporters increase blast radius because they fan changes into wider module surfaces.",
                "Symbol-reference matches are heuristic and best used as review hints rather than definitive dependency edges.",
              ],
            }),
          },
        ],
      };
    },

    async ci_failure_summary(rawArgs: unknown) {
      const args = ciFailureSummarySchema.parse(rawArgs ?? {});
      const projectRoot = deps.getProjectRoot();

      let logText = args.log_text || "";
      let source = "inline";

      if (!logText && args.log_file) {
        const safeLogPath = validatePath(args.log_file, projectRoot);
        logText = (await safeReadText(safeLogPath)) || "";
        source = path.relative(projectRoot, safeLogPath).replaceAll(path.sep, "/");
      }

      if (!logText && args.run_id) {
        const result = await runCommand("gh", ["run", "view", args.run_id, "--log"], {
          cwd: projectRoot,
        });

        if (result.exitCode !== 0 || !result.stdout.trim()) {
          return {
            content: [
              {
                type: "text",
                text: stringifyGeneric({
                  source: `gh run ${args.run_id}`,
                  summary: "Unable to fetch CI logs",
                  likely_cause:
                    result.stderr.trim() ||
                    "GitHub CLI could not fetch the workflow log. Check authentication, run ID, and repository context.",
                  category: "github_actions",
                  confidence: 0.2,
                  failure_signals: [],
                  suggested_fixes: [
                    "Verify `gh auth status`, repository permissions, and that the run ID exists in this repository.",
                  ],
                }),
              },
            ],
            isError: true,
          };
        }

        logText = result.stdout;
        source = `gh run ${args.run_id}`;
      }

      const trimmedLog = trimLogForAnalysis(logText, args.max_log_chars);
      const summary = summarizeCiFailure(trimmedLog, {
        maxEntries: args.max_structured_entries,
        levelFilter: args.log_level_filter,
      });
      let githubRun = null as ReturnType<typeof summarizeGithubRunMetadata> | null;

      if (args.run_id && args.include_github_metadata) {
        const metadataResult = await runCommand(
          "gh",
          [
            "run",
            "view",
            args.run_id,
            "--json",
            "workflowName,name,conclusion,status,event,headBranch,number,url,jobs",
          ],
          { cwd: projectRoot }
        );

        if (metadataResult.exitCode === 0 && metadataResult.stdout.trim()) {
          try {
            githubRun = summarizeGithubRunMetadata(JSON.parse(metadataResult.stdout));
          } catch {
            githubRun = null;
          }
        }
      }

      return {
        content: [
          {
            type: "text",
            text: stringifyGeneric({
              generated_at: new Date().toISOString(),
              source,
              analyzed_chars: trimmedLog.length,
              ...summary,
              github_actions_step: summary.github_actions_context.likelyStepName,
              github_actions_annotations: summary.github_actions_context.annotations,
              runner_context: summary.github_actions_context.runnerLines,
              github_run: githubRun,
              guidance: [
                "Start from the first concrete compiler, test, or module error rather than the final exit-code line.",
                "If the same error repeats across many files, fix the earliest upstream type or export breakage first.",
                ...(summary.github_actions_context.likelyStepName
                  ? [
                      `Prioritize the workflow step '${summary.github_actions_context.likelyStepName}' before investigating downstream steps.`,
                    ]
                  : []),
                ...(githubRun?.failed_job?.name
                  ? [
                      `Start with the failed job '${githubRun.failed_job.name}' before reviewing successful jobs.`,
                    ]
                  : []),
                ...(summary.structured_log.duration_ms !== null
                  ? [
                      `This span ran for ~${Math.round(summary.structured_log.duration_ms / 1000)}s before failing, based on the log timestamps.`,
                    ]
                  : []),
              ],
            }),
          },
        ],
        isError: summary.confidence < 0.35,
      };
    },

    async tool_control_plane(rawArgs: unknown) {
      const args = toolControlPlaneSchema.parse(rawArgs ?? {});
      const status = await deps.getServerStatus(true);
      const governance = deps.getToolGovernanceSummary?.(args.include_tools) || {};

      return {
        content: [
          {
            type: "text",
            text: stringifyGeneric({
              generated_at: new Date().toISOString(),
              governance,
              metrics_available: Boolean(
                (status.metrics as Record<string, unknown> | undefined)?.toolMetrics
              ),
              recommendations: [
                "Keep critical diagnostics and incident-response tools in high priority so they bypass degraded-mode surprises.",
                "Mark expensive batch-style tools carefully; they are the safest first candidates to shed during incident load.",
                "Use degraded mode only as a temporary protection mechanism, then review blocked tools through this report.",
              ],
            }),
          },
        ],
      };
    },

    async ci_batch_triage(rawArgs: unknown) {
      const args = ciBatchTriageSchema.parse(rawArgs ?? {});
      const projectRoot = deps.getProjectRoot();
      const repoReports: Array<Record<string, unknown>> = [];
      const categoryCounts = new Map<string, number>();
      const failedJobs = new Map<string, number>();
      const triggerFailures: string[] = [];

      for (const repo of args.repos) {
        let triggerResult: { success: boolean; stderr?: string } | null = null;

        if (args.action === "trigger_and_triage" && args.workflow) {
          const trigger = await runCommand(
            "gh",
            ["workflow", "run", args.workflow, "--repo", repo, "--ref", args.branch],
            { cwd: projectRoot }
          );
          triggerResult = {
            success: trigger.exitCode === 0,
            stderr: trigger.stderr.trim() || undefined,
          };

          if (trigger.exitCode !== 0) {
            triggerFailures.push(`${repo}: ${trigger.stderr.trim() || "trigger failed"}`);
          }
        }

        const runListArgs = [
          "run",
          "list",
          "--repo",
          repo,
          "--limit",
          String(args.limit_per_repo),
          "--json",
          "databaseId,workflowName,displayTitle,conclusion,status,url,headBranch,event",
        ];
        if (args.workflow) {
          runListArgs.push("--workflow", args.workflow);
        }

        const runListResult = await runCommand("gh", runListArgs, { cwd: projectRoot });
        if (runListResult.exitCode !== 0) {
          repoReports.push({
            repo,
            trigger: triggerResult,
            error: runListResult.stderr.trim() || "Unable to list workflow runs for repository.",
            runs: [],
          });
          continue;
        }

        let runs: GithubRunListItem[] = [];
        try {
          runs = JSON.parse(runListResult.stdout);
        } catch {
          runs = [];
        }

        const triagedRuns: Array<Record<string, unknown>> = [];
        for (const run of runs) {
          if (!run.databaseId) continue;
          const triagedRun = await triageGithubRun(
            projectRoot,
            repo,
            String(run.databaseId),
            args.max_log_chars,
            runCommand
          );

          triagedRuns.push({
            workflow_name: run.workflowName || null,
            display_title: run.displayTitle || null,
            conclusion: run.conclusion || null,
            status: run.status || null,
            url: run.url || null,
            head_branch: run.headBranch || null,
            event: run.event || null,
            ...triagedRun,
          });

          categoryCounts.set(
            String(triagedRun.category),
            (categoryCounts.get(String(triagedRun.category)) || 0) + 1
          );

          const failedJobName = (triagedRun.github_run as { failed_job?: { name?: string } } | null)
            ?.failed_job?.name;
          if (failedJobName) {
            failedJobs.set(failedJobName, (failedJobs.get(failedJobName) || 0) + 1);
          }
        }

        repoReports.push({
          repo,
          trigger: triggerResult,
          runs: triagedRuns,
        });
      }

      const topCategories = Array.from(categoryCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([category, count]) => ({ category, count }));

      const topFailedJobs = Array.from(failedJobs.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([job, count]) => ({ job, count }));

      const allRuns = repoReports.flatMap(
        (repoReport) => (repoReport.runs as Array<Record<string, unknown>>) || []
      );

      return {
        content: [
          {
            type: "text",
            text: stringifyGeneric({
              generated_at: new Date().toISOString(),
              action: args.action,
              workflow: args.workflow || null,
              branch: args.branch,
              repo_count: args.repos.length,
              trigger_failures: triggerFailures,
              top_categories: topCategories,
              top_failed_jobs: topFailedJobs,
              totals: {
                repos_analyzed: repoReports.length,
                runs_analyzed: allRuns.length,
                failures_detected: allRuns.filter((run) => run.conclusion === "failure").length,
              },
              recommendations: [
                "Start with the most repeated failure category across repositories before drilling into repo-specific edge cases.",
                "If one failed job dominates across repos, fix that job template or shared action first.",
                ...(triggerFailures.length > 0
                  ? [
                      "Some workflow triggers failed immediately; check workflow name, branch, and repository permissions first.",
                    ]
                  : []),
              ],
              repositories: repoReports,
            }),
          },
        ],
      };
    },
  };
}

export const professionalToolTestHelpers = {
  selectQualityCommands,
  summarizeQualityGate,
  readPackageScripts,
  buildCommand,
  safeAccess,
  hasBuildDirectory(projectRoot: string) {
    return existsSync(path.join(projectRoot, "build"));
  },
};
