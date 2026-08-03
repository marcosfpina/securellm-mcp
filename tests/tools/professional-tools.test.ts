import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  createProfessionalToolHandlers,
  professionalToolTestHelpers,
} from "../../src/tools/professional-tools.js";
import { createTempDir, populateTempDir } from "../helpers/sandbox.js";

describe("professional tools", () => {
  it("should select expected quality gate commands by profile", () => {
    const scripts = {
      build: "tsc",
      lint: "eslint src",
      test: "node --test",
      "test:coverage": "c8 npm test",
      "format:check": "prettier --check .",
    };

    const quick = professionalToolTestHelpers.selectQualityCommands(scripts, "quick");
    const standard = professionalToolTestHelpers.selectQualityCommands(scripts, "standard");
    const full = professionalToolTestHelpers.selectQualityCommands(scripts, "full");

    assert.equal(quick.length, 3);
    assert.equal(standard.at(-1)?.name, "test");
    assert.equal(full.at(-1)?.name, "test_coverage");
    assert.deepEqual(full.at(-1)?.command?.args, ["run", "test:coverage"]);
  });

  it("should summarize quality gate results correctly", () => {
    const summary = professionalToolTestHelpers.summarizeQualityGate([
      {
        name: "lint",
        command: "npm run lint",
        status: "passed",
        duration_ms: 10,
        summary: "lint passed",
      },
      {
        name: "build",
        command: "npm run build",
        status: "failed",
        duration_ms: 12,
        summary: "build failed",
      },
      {
        name: "test",
        command: "not configured",
        status: "skipped",
        duration_ms: 0,
        summary: "skipped",
      },
    ]);

    assert.equal(summary.overall_status, "failed");
    assert.equal(summary.passed, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.skipped, 1);
  });

  it("should produce a server health report without external probes", async () => {
    const handlers = createProfessionalToolHandlers({
      getProjectRoot: () => process.cwd(),
      getServerStatus: async () => ({
        name: "securellm-mcp",
        version: "2.1.0",
        features: {
          knowledgeEnabled: true,
        },
      }),
    });

    const result = await handlers.server_health({
      include_external_services: false,
      include_git: false,
    });

    assert.ok(result.content[0]);
    assert.equal(result.content[0].type, "text");

    const payload = JSON.parse(result.content[0].text);
    assert.equal(
      payload.overall_status === "healthy" || payload.overall_status === "degraded",
      true
    );
    assert.equal(payload.workspace.project_root, process.cwd());
    assert.equal(Array.isArray(payload.warnings), true);
  });

  it("should produce a ranked performance report from collected tool metrics", async () => {
    const handlers = createProfessionalToolHandlers({
      getProjectRoot: () => process.cwd(),
      getServerStatus: async () => ({
        metrics: {
          semanticCache: {
            tokensSaved: 3200,
          },
          toolMetrics: {
            advanced_code_analysis: {
              totalRequests: 10,
              averageLatency: 720,
              latencyPercentiles: { p95: 1100 },
              totalCompactionTokensSaved: 1400,
              compactionAppliedCount: 5,
              compactionRate: 0.62,
              averageOriginalResponseSize: 18000,
              averageCompactedResponseSize: 7000,
              averageResponseSize: 7000,
            },
            socket_debug_report: {
              totalRequests: 4,
              averageLatency: 410,
              latencyPercentiles: { p95: 650 },
              totalCompactionTokensSaved: 2100,
              compactionAppliedCount: 4,
              compactionRate: 0.73,
              averageOriginalResponseSize: 24000,
              averageCompactedResponseSize: 6500,
              averageResponseSize: 6500,
            },
          },
        },
      }),
    });

    const result = await handlers.performance_report({ top_n: 2 });
    const payload = JSON.parse(result.content[0].text);

    assert.equal(payload.top_latency_tools[0].tool, "advanced_code_analysis");
    assert.equal(payload.top_token_savers[0].tool, "socket_debug_report");
    assert.equal(payload.totals.compaction_tokens_saved, 3500);
    assert.equal(payload.totals.semantic_cache_tokens_saved, 3200);
    assert.ok(Array.isArray(payload.recommendations));
  });

  it("should produce cache tuning recommendations from observed metrics", async () => {
    const handlers = createProfessionalToolHandlers({
      getProjectRoot: () => process.cwd(),
      getServerStatus: async () => ({
        metrics: {
          toolMetrics: {
            change_impact: {
              totalRequests: 12,
              averageLatency: 680,
              cacheHits: 1,
              cacheMisses: 9,
              averageOriginalResponseSize: 18000,
              averageResponseSize: 7000,
              compactionAppliedCount: 6,
              compactionRate: 0.61,
            },
            server_health: {
              totalRequests: 5,
              averageLatency: 320,
              cacheHits: 0,
              cacheMisses: 5,
              averageOriginalResponseSize: 0,
              averageResponseSize: 0,
              compactionAppliedCount: 0,
              compactionRate: 0,
            },
          },
        },
      }),
    });

    const result = await handlers.cache_tuning_advisor({ top_n: 3 });
    const payload = JSON.parse(result.content[0].text);

    assert.equal(payload.cache_candidates[0].tool, "change_impact");
    assert.equal(payload.compaction_candidates[0].tool, "change_impact");
    assert.equal(payload.volatile_or_low_yield_tools[0].tool, "server_health");
    assert.ok(Array.isArray(payload.recommendations));
    assert.equal(payload.semantic_cache_defaults.ttl_seconds, "3600");
  });

  it("should estimate change impact from direct imports and re-exports", async () => {
    const temp = await createTempDir("securellm-impact-");

    try {
      await populateTempDir(temp.path, {
        "src/core.ts": [
          "export const importantValue = 42;",
          "export function doWork() {",
          "  return importantValue;",
          "}",
        ].join("\n"),
        "src/consumer.ts": [
          'import { doWork } from "./core";',
          "export const output = doWork();",
        ].join("\n"),
        "src/barrel.ts": 'export * from "./core";',
        "src/usage.ts": [
          'import { importantValue } from "./core";',
          "export const mirrored = importantValue;",
        ].join("\n"),
      });

      const handlers = createProfessionalToolHandlers({
        getProjectRoot: () => temp.path,
        getServerStatus: async () => ({}),
      });

      const result = await handlers.change_impact({
        target: "src/core.ts",
        max_files: 10,
      });
      const payload = JSON.parse(result.content[0].text);
      const relatedFiles = payload.related_files.map((entry: { file: string }) => entry.file);

      assert.equal(payload.target, "src/core.ts");
      assert.equal(payload.target_type, "file");
      assert.equal(payload.estimated_risk, "high");
      assert.equal(payload.summary.reExporters, 1);
      assert.equal(payload.summary.directImporters, 2);
      assert.ok(relatedFiles.includes("src/barrel.ts"));
      assert.ok(relatedFiles.includes("src/consumer.ts"));
      assert.ok(relatedFiles.includes("src/usage.ts"));
    } finally {
      await temp.cleanup();
    }
  });

  it("should summarize inline TypeScript CI failures", async () => {
    const handlers = createProfessionalToolHandlers({
      getProjectRoot: () => process.cwd(),
      getServerStatus: async () => ({}),
    });

    const result = await handlers.ci_failure_summary({
      log_text: [
        "src/index.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
        "Error: Process completed with exit code 2.",
      ].join("\n"),
    });
    const payload = JSON.parse(result.content[0].text);

    assert.equal(payload.category, "typescript");
    assert.equal(payload.summary, "TypeScript compilation failure");
    assert.ok(payload.confidence >= 0.9);
    assert.ok(payload.failure_signals.some((line: string) => line.includes("TS2322")));
    assert.ok(payload.suggested_fixes.some((line: string) => line.includes("npm run build")));
  });

  it("should summarize CI failures from a local log file", async () => {
    const temp = await createTempDir("securellm-ci-log-");

    try {
      await populateTempDir(temp.path, {
        "logs/ci.log": [
          "TAP version 13",
          "not ok 1 - should return 200",
          "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
          "Error: Process completed with exit code 1.",
        ].join("\n"),
      });

      const handlers = createProfessionalToolHandlers({
        getProjectRoot: () => temp.path,
        getServerStatus: async () => ({}),
      });

      const result = await handlers.ci_failure_summary({
        log_file: "logs/ci.log",
      });
      const payload = JSON.parse(result.content[0].text);

      assert.equal(payload.source, "logs/ci.log");
      assert.equal(payload.category, "tests");
      assert.equal(payload.summary, "Test suite failure");
      assert.ok(payload.failure_signals.some((line: string) => line.includes("AssertionError")));
      assert.ok(Array.isArray(payload.guidance));
    } finally {
      await temp.cleanup();
    }
  });

  it("should detect the likely failing GitHub Actions step", async () => {
    const handlers = createProfessionalToolHandlers({
      getProjectRoot: () => process.cwd(),
      getServerStatus: async () => ({}),
      getToolGovernanceSummary: () => ({}),
    });

    const result = await handlers.ci_failure_summary({
      log_text: [
        "Current runner version: '2.327.1'",
        "##[group]Run npm run build",
        "npm run build",
        "src/index.ts(7,1): error TS2304: Cannot find name 'brokenSymbol'.",
        "##[error]Process completed with exit code 2.",
      ].join("\n"),
    });
    const payload = JSON.parse(result.content[0].text);

    assert.equal(payload.github_actions_step, "npm run build");
    assert.ok(
      payload.github_actions_annotations.some((line: string) => line.includes("exit code 2"))
    );
    assert.ok(payload.runner_context.some((line: string) => line.includes("runner version")));
  });

  it("should extract structured, timestamped log entries with job/step attribution", async () => {
    const handlers = createProfessionalToolHandlers({
      getProjectRoot: () => process.cwd(),
      getServerStatus: async () => ({}),
    });

    const result = await handlers.ci_failure_summary({
      log_text: [
        "build\tRun npm test\t2024-01-15T10:00:00.0000000Z ##[group]Run npm test",
        "build\tRun npm test\t2024-01-15T10:00:01.0000000Z npm test",
        "build\tRun npm test\t2024-01-15T10:00:05.0000000Z AssertionError [ERR_ASSERTION]: Expected true but got false.",
        "build\tRun npm test\t2024-01-15T10:00:06.0000000Z ##[warning]Retrying flaky step",
        "build\tRun npm test\t2024-01-15T10:00:10.0000000Z ##[error]Process completed with exit code 1.",
      ].join("\n"),
    });
    const payload = JSON.parse(result.content[0].text);

    assert.ok(payload.structured_log.error_count >= 2);
    assert.equal(payload.structured_log.warning_count, 1);
    assert.ok(
      payload.structured_log.entries.some(
        (entry: { job: string; step: string; level: string }) =>
          entry.job === "build" && entry.step === "Run npm test" && entry.level === "error"
      )
    );
    assert.equal(payload.structured_log.first_timestamp, "2024-01-15T10:00:00.0000000Z");
    assert.equal(payload.structured_log.last_timestamp, "2024-01-15T10:00:10.0000000Z");
    assert.ok((payload.structured_log.duration_ms as number) >= 10000);
    assert.ok(payload.guidance.some((line: string) => line.includes("This span ran for")));
  });

  it("should narrow structured log entries with log_level_filter", async () => {
    const handlers = createProfessionalToolHandlers({
      getProjectRoot: () => process.cwd(),
      getServerStatus: async () => ({}),
    });

    const result = await handlers.ci_failure_summary({
      log_text: [
        "2024-01-15T10:00:00.0000000Z ##[warning]Node 18 is deprecated for this action",
        "2024-01-15T10:00:01.0000000Z AssertionError [ERR_ASSERTION]: Expected true but got false.",
        "2024-01-15T10:00:02.0000000Z ##[error]Process completed with exit code 1.",
      ].join("\n"),
      log_level_filter: "error",
    });
    const payload = JSON.parse(result.content[0].text);

    assert.ok(payload.structured_log.entries.length > 0);
    assert.ok(
      payload.structured_log.entries.every(
        (entry: { level: string }) => entry.level === "error"
      )
    );
    // Aggregate counts still reflect the whole log, independent of the filter.
    assert.equal(payload.structured_log.warning_count, 1);
  });

  it("should expose tool governance through tool_control_plane", async () => {
    const handlers = createProfessionalToolHandlers({
      getProjectRoot: () => process.cwd(),
      getServerStatus: async () => ({ metrics: {} }),
      getToolGovernanceSummary: (includeTools: boolean) => ({
        degradedMode: false,
        blockedTools: includeTools ? ["web_crawl"] : [],
        priorities: { critical: 1, high: 2, normal: 3, low: 0 },
        executionClasses: { realtime: 1, interactive: 2, batch: 2, diagnostic: 1 },
        tools: includeTools
          ? [{ name: "ci_failure_summary", priority: "high", allowed: true }]
          : undefined,
      }),
    });

    const result = await handlers.tool_control_plane({ include_tools: true });
    const payload = JSON.parse(result.content[0].text);

    assert.equal(payload.governance.degradedMode, false);
    assert.ok(Array.isArray(payload.governance.tools));
    assert.ok(Array.isArray(payload.recommendations));
  });

  it("should enrich run_id summaries with GitHub Actions workflow and failed job metadata", async () => {
    const calls: Array<{ program: string; args: string[] }> = [];
    const handlers = createProfessionalToolHandlers({
      getProjectRoot: () => process.cwd(),
      getServerStatus: async () => ({}),
      runCommand: async (program, args) => {
        calls.push({ program, args });

        if (args.includes("--log")) {
          return {
            exitCode: 0,
            stdout: [
              "##[group]Run npm test",
              "npm test",
              "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
              "##[error]Process completed with exit code 1.",
            ].join("\n"),
            stderr: "",
          };
        }

        return {
          exitCode: 0,
          stdout: JSON.stringify({
            workflowName: "CI",
            name: "Node Test Matrix",
            conclusion: "failure",
            status: "completed",
            event: "pull_request",
            headBranch: "feature/ci-fix",
            url: "https://github.com/example/repo/actions/runs/123",
            jobs: [
              {
                name: "lint",
                conclusion: "success",
                status: "completed",
                steps: [{ name: "Run lint", conclusion: "success" }],
              },
              {
                name: "test",
                conclusion: "failure",
                status: "completed",
                steps: [
                  { name: "Install deps", conclusion: "success" },
                  { name: "Run tests", conclusion: "failure" },
                ],
              },
            ],
          }),
          stderr: "",
        };
      },
    });

    const result = await handlers.ci_failure_summary({
      run_id: "123",
    });
    const payload = JSON.parse(result.content[0].text);

    assert.equal(payload.github_run.workflow_name, "CI");
    assert.equal(payload.github_run.failed_job.name, "test");
    assert.ok(payload.github_run.failed_job.failed_steps.includes("Run tests"));
    assert.ok(payload.guidance.some((line: string) => line.includes("failed job 'test'")));
    assert.equal(calls.length, 2);
  });

  it("should triage recent CI runs across multiple repositories", async () => {
    const handlers = createProfessionalToolHandlers({
      getProjectRoot: () => process.cwd(),
      getServerStatus: async () => ({}),
      runCommand: async (_program, args) => {
        const repo = args[args.indexOf("--repo") + 1];

        if (args[0] === "workflow" && args[1] === "run") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }

        if (args[0] === "run" && args[1] === "list") {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                databaseId: repo === "org/repo-a" ? 101 : 202,
                workflowName: "CI",
                displayTitle: repo === "org/repo-a" ? "Repo A CI" : "Repo B CI",
                conclusion: "failure",
                status: "completed",
                url: `https://github.com/${repo}/actions/runs/1`,
                headBranch: "main",
                event: "push",
              },
            ]),
            stderr: "",
          };
        }

        if (args[0] === "run" && args[1] === "view" && args.includes("--log-failed")) {
          return {
            exitCode: 0,
            stdout:
              repo === "org/repo-a"
                ? "src/index.ts: error TS2304: Cannot find name 'broken'.\n##[error]Process completed with exit code 2."
                : "AssertionError [ERR_ASSERTION]: Expected true but got false.\n##[error]Process completed with exit code 1.",
            stderr: "",
          };
        }

        return {
          exitCode: 0,
          stdout: JSON.stringify({
            workflowName: "CI",
            name: repo === "org/repo-a" ? "Repo A CI" : "Repo B CI",
            conclusion: "failure",
            status: "completed",
            event: "push",
            headBranch: "main",
            url: `https://github.com/${repo}/actions/runs/1`,
            jobs: [
              {
                name: repo === "org/repo-a" ? "build" : "test",
                conclusion: "failure",
                status: "completed",
                steps: [
                  {
                    name: repo === "org/repo-a" ? "Compile" : "Run tests",
                    conclusion: "failure",
                  },
                ],
              },
            ],
          }),
          stderr: "",
        };
      },
    });

    const result = await handlers.ci_batch_triage({
      repos: ["org/repo-a", "org/repo-b"],
      action: "trigger_and_triage",
      workflow: "ci.yml",
      limit_per_repo: 1,
    });
    const payload = JSON.parse(result.content[0].text);

    assert.equal(payload.repo_count, 2);
    assert.equal(payload.totals.runs_analyzed, 2);
    assert.equal(payload.top_categories[0].count, 1);
    assert.ok(
      payload.top_categories.some((item: { category: string }) => item.category === "typescript")
    );
    assert.ok(
      payload.top_categories.some((item: { category: string }) => item.category === "tests")
    );
    assert.ok(payload.top_failed_jobs.some((item: { job: string }) => item.job === "build"));
    assert.ok(payload.top_failed_jobs.some((item: { job: string }) => item.job === "test"));
    assert.equal(payload.repositories.length, 2);

    for (const repoReport of payload.repositories) {
      for (const run of repoReport.runs) {
        assert.ok(Array.isArray(run.structured_log.entries));
        assert.ok(run.structured_log.entries.length <= 5);
      }
    }
  });
});
