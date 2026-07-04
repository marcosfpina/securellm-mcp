import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as path from "path";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import type { KnowledgeDatabase } from "../types/knowledge.js";
import type { SmartRateLimiter } from "../middleware/rate-limiter.js";
import type { SemanticCache } from "../middleware/semantic-cache.js";
import type { PackageDiagnoseTool } from "../tools/package-diagnose.js";
import type { PackageDownloadTool } from "../tools/package-download.js";
import type { PackageConfigureTool } from "../tools/package-configure.js";
import type { createProfessionalToolHandlers } from "../tools/professional-tools.js";

import {
  handleEmergencyStatus,
  handleEmergencyAbort,
  handleEmergencyCooldown,
  handleEmergencyNuke,
  handleEmergencySwap,
  handleSystemHealthCheck,
  handleSafeRebuildCheck,
} from "../tools/emergency/index.js";
import {
  handleThermalCheck,
  handleRebuildSafetyCheck,
  handleThermalForensics,
  handleThermalWarroom,
  handleLaptopVerdict,
  handleFullInvestigation,
  handleForceCooldown,
  handleResetPerformance,
} from "../tools/laptop-defense/index.js";
import {
  handleWebSearch,
  handleNixSearch,
  handleGithubSearch,
  handleTechNewsSearch,
  handleDiscourseSearch,
  handleStackOverflowSearch,
  handleOsintDns,
  handleOsintSubdomains,
  handleOsintPortScan,
  handleWebCrawl,
  getNixCacheStats,
} from "../tools/web-search.js";
import { handleResearchAgent } from "../tools/research-agent.js";
import { analyzeComplexity, findDeadCode } from "../tools/codebase-analysis.js";
import { handleAdvancedCodeAnalysis } from "../tools/advanced-code-analysis.js";
import { handleSocketDebugReport } from "../tools/socket-debug-report.js";
import { devToolHandlers } from "../tools/dev-tools.js";
import {
  SSHExecuteTool,
  SSHFileTransferTool,
  SSHMaintenanceCheckTool,
  SSHTunnelTool,
  SSHJumpHostTool,
  SSHSessionTool,
} from "../tools/ssh/index.js";
import { handleExecuteInSandbox } from "../tools/secure-execution.js";
import {
  BrowserLaunchAdvancedTool,
  BrowserExtractDataTool,
  BrowserInteractFormTool,
  BrowserMonitorChangesTool,
  BrowserSearchAggregateTool,
} from "../tools/browser/index.js";
import { adrHandlers } from "../tools/adr/index.js";
import { handleSessionBridge } from "../tools/session-bridge.js";
import { handleNvimContext } from "../tools/nvim-context.js";
import { handleNixDaemon } from "../tools/nix-daemon.js";
import { handleGitSherlock } from "../tools/git-sherlock.js";
import { handleNotifyHook } from "../tools/notify-hook.js";
import { handleMetaTool } from "../tools/meta-tool.js";
import {
  handleJournalAnalyze,
  handleProcessInspect,
  handleSystemdDelta,
  handleNetworkDiag,
  handleDiskAnalyze,
  handleSecurityScan,
} from "../tools/linux-debugging.js";
import { handleDocGenerate, handleDocCoverage, handleDocValidate } from "../tools/doc-tools.js";
import {
  handleSchemaConvert,
  handleProjectBridge,
  handleDataTransform,
} from "../tools/interop-tools.js";
import {
  handleEcosystemMap,
  handleEcosystemTrace,
  handleEcosystemSearch,
} from "../tools/ecosystem-tools.js";
import {
  handleProjectContextSwitcher,
  handleCrossProjectSearch,
  handleDependencyGraphAnalyzer,
  handleContextWindowOptimizer,
} from "../tools/umbrella-tools.js";
import { type McpToolResult, wrapTool } from "./wrap.js";
import { usageTracker } from "../telemetry/usage-tracker.js";

const execAsync = promisify(exec);

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function nixDevelopShellCommand(projectRoot: string, command: string): string {
  return `nix develop ${shellQuote(projectRoot)} --command bash -lc ${shellQuote(command)}`;
}

export interface DispatchDeps {
  db: KnowledgeDatabase | null;
  rateLimiter: SmartRateLimiter;
  semanticCache: SemanticCache | null;
  projectRoot: string;
  packageDiagnose: PackageDiagnoseTool;
  packageDownload: PackageDownloadTool;
  packageConfigure: PackageConfigureTool;
  professionalToolHandlers: ReturnType<typeof createProfessionalToolHandlers>;
  stringify: (obj: unknown) => string;
  // callbacks for server-internal state
  getServerStatus: (includeMetrics: boolean) => Promise<object>;
  getRateLimiterStatus: () => Promise<McpToolResult>;
  handleKnowledge: (name: string, args: any) => Promise<McpToolResult>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (args: any) => Promise<any>;

function requireDb(
  db: KnowledgeDatabase | null,
  stringify: (o: unknown) => string
): KnowledgeDatabase {
  if (!db) throw new McpError(ErrorCode.InvalidRequest, "Knowledge database not available");
  return db;
}

export function buildDispatchMap(deps: DispatchDeps): Record<string, Handler> {
  const { stringify } = deps;
  const w = <T>(fn: () => Promise<T>) => wrapTool(fn, stringify);

  const map: Record<string, Handler> = {
    // ── Server internals ──────────────────────────────────────────────────
    server_status: async (args) => ({
      content: [
        {
          type: "text",
          text: stringify(await deps.getServerStatus(args?.include_metrics !== false)),
        },
      ],
    }),
    rate_limiter_status: () => deps.getRateLimiterStatus(),
    cache_stats: async () => ({
      content: [
        {
          type: "text",
          text: stringify({
            semantic_cache: deps.semanticCache?.getStats() || null,
            nix_cache: getNixCacheStats(),
          }),
        },
      ],
    }),

    // ── Provider tools ────────────────────────────────────────────────────
    provider_test: (args) =>
      w(async () => {
        const { provider, prompt, model } = args;
        const testScript = nixDevelopShellCommand(
          deps.projectRoot,
          `cargo run --bin securellm -- test ${shellQuote(provider)} --prompt ${shellQuote(prompt)}${model ? ` --model ${shellQuote(model)}` : ""}`
        );
        const { stdout, stderr } = await execAsync(testScript, {
          cwd: deps.projectRoot,
          timeout: 30000,
          env: {
            ...process.env,
            PROJECT_ROOT: process.env.PROJECT_ROOT || deps.projectRoot,
            SECURELLM_MCP_QUIET: "1",
          },
        });
        return {
          provider,
          model: model || "default",
          prompt,
          status: "success",
          output: stdout,
          stderr: stderr || null,
        };
      }),
    security_audit: (args) =>
      w(async () => {
        const configPath = path.resolve(deps.projectRoot, args.config_file);
        const configContent = await fs.readFile(configPath, "utf-8");
        const issues: string[] = [];
        const warnings: string[] = [];
        const recommendations: string[] = [];
        if (configContent.match(/sk-[a-zA-Z0-9]{32,}/))
          issues.push("⚠️ CRITICAL: Hardcoded API keys detected");
        if (configContent.includes("enabled = false") && configContent.includes("[security.tls]"))
          warnings.push("TLS is disabled");
        if (!configContent.includes("[security.rate_limit]"))
          warnings.push("Rate limiting not configured");
        if (!configContent.includes("[security.audit]"))
          recommendations.push("Consider enabling audit logging");
        if (!configContent.includes("${") && configContent.includes("api_key"))
          recommendations.push("Use environment variables for API keys");
        return {
          config_file: args.config_file,
          status: issues.length > 0 ? "failed" : warnings.length > 0 ? "warning" : "passed",
          issues,
          warnings,
          recommendations,
          summary: `Found ${issues.length} critical issues, ${warnings.length} warnings, ${recommendations.length} recommendations`,
        };
      }),
    rate_limit_check: (args) =>
      w(async () => {
        const limits: Record<string, any> = {
          deepseek: {
            requests_per_minute: 60,
            burst_size: 10,
            current_usage: 0,
            reset_time: new Date(Date.now() + 60000).toISOString(),
          },
          openai: {
            requests_per_minute: 3500,
            burst_size: 100,
            current_usage: 0,
            reset_time: new Date(Date.now() + 60000).toISOString(),
          },
          anthropic: {
            requests_per_minute: 50,
            burst_size: 5,
            current_usage: 0,
            reset_time: new Date(Date.now() + 60000).toISOString(),
          },
          ollama: { requests_per_minute: -1, burst_size: -1, current_usage: 0, reset_time: null },
        };
        const lim = limits[args.provider] || { error: "Unknown provider" };
        return {
          provider: args.provider,
          ...lim,
          remaining: lim.requests_per_minute - lim.current_usage,
          status: "ok",
        };
      }),
    build_and_test: (args) =>
      w(async () => {
        const cmds: Record<string, string> = {
          unit: "cargo test --lib",
          integration: "cargo test --test '*'",
          all: "cargo test",
        };
        const buildScript = nixDevelopShellCommand(
          deps.projectRoot,
          `cargo build && ${cmds[args.test_type]}`
        );
        const { stdout, stderr } = await execAsync(buildScript, {
          cwd: deps.projectRoot,
          timeout: 120000,
          env: {
            ...process.env,
            PROJECT_ROOT: process.env.PROJECT_ROOT || deps.projectRoot,
            SECURELLM_MCP_QUIET: "1",
          },
        });
        return {
          test_type: args.test_type,
          status: "success",
          output: stdout,
          stderr: stderr || null,
        };
      }),
    provider_config_validate: (args) =>
      w(async () => {
        const issues: string[] = [];
        const warnings: string[] = [];
        if (!args.config_data.trim().startsWith("[providers."))
          issues.push("Configuration must start with [providers.PROVIDER_NAME]");
        for (const field of ["enabled", "api_key", "base_url"]) {
          if (!args.config_data.includes(field)) issues.push(`Missing required field: ${field}`);
        }
        if (args.config_data.match(/api_key\s*=\s*"sk-/))
          warnings.push("API key appears to be hardcoded");
        return {
          provider: args.provider,
          status:
            issues.length > 0 ? "invalid" : warnings.length > 0 ? "valid_with_warnings" : "valid",
          issues,
          warnings,
        };
      }),
    crypto_key_generate: (args) =>
      w(async () => {
        const outputDir = path.resolve(deps.projectRoot, args.output_path);
        await fs.mkdir(outputDir, { recursive: true });
        const certCommand =
          args.key_type === "server"
            ? `openssl req -x509 -newkey rsa:4096 -keyout "${outputDir}/server.key" -out "${outputDir}/server.crt" -days 365 -nodes -subj "/C=US/ST=State/L=City/O=Org/CN=securellm-server"`
            : `openssl req -x509 -newkey rsa:4096 -keyout "${outputDir}/client.key" -out "${outputDir}/client.crt" -days 365 -nodes -subj "/C=US/ST=State/L=City/O=Org/CN=securellm-client"`;
        await execAsync(certCommand);
        return {
          key_type: args.key_type,
          output_path: outputDir,
          files: { certificate: `${args.key_type}.crt`, private_key: `${args.key_type}.key` },
          status: "success",
        };
      }),

    // ── Package tools ─────────────────────────────────────────────────────
    package_diagnose: (args) => w(() => deps.packageDiagnose.diagnose(args)),
    package_download: (args) => w(() => deps.packageDownload.download(args)),
    package_configure: (args) => w(() => deps.packageConfigure.configure(args)),

    // ── Knowledge handlers (delegated back to server for DB access) ────────
    create_session: (args) => deps.handleKnowledge("create_session", args),
    save_knowledge: (args) => deps.handleKnowledge("save_knowledge", args),
    search_knowledge: (args) => deps.handleKnowledge("search_knowledge", args),
    load_session: (args) => deps.handleKnowledge("load_session", args),
    list_sessions: (args) => deps.handleKnowledge("list_sessions", args),
    get_recent_knowledge: (args) => deps.handleKnowledge("get_recent_knowledge", args),
    knowledge_maintenance: (args) => deps.handleKnowledge("knowledge_maintenance", args),

    // ── Emergency Framework ───────────────────────────────────────────────
    emergency_status: () => w(handleEmergencyStatus),
    emergency_abort: (args) => w(() => handleEmergencyAbort(args.force || false)),
    emergency_cooldown: () => w(handleEmergencyCooldown),
    emergency_nuke: (args) => w(() => handleEmergencyNuke(args.confirm || false)),
    emergency_swap: () => w(handleEmergencySwap),
    system_health_check: (args) => w(() => handleSystemHealthCheck(args.detailed || false)),
    safe_rebuild_check: () => w(handleSafeRebuildCheck),

    // ── Laptop Defense ────────────────────────────────────────────────────
    thermal_check: (args) => w(() => handleThermalCheck(args)),
    rebuild_safety_check: () => w(handleRebuildSafetyCheck),
    thermal_forensics: (args) => w(() => handleThermalForensics(args)),
    thermal_warroom: (args) => w(() => handleThermalWarroom(args)),
    laptop_verdict: (args) => w(() => handleLaptopVerdict(args)),
    full_investigation: () => w(handleFullInvestigation),
    force_cooldown: () => w(handleForceCooldown),
    reset_performance: () => w(handleResetPerformance),

    // ── Web Search ────────────────────────────────────────────────────────
    web_search: (args) => w(() => handleWebSearch(args)),
    nix_search: (args) => w(() => handleNixSearch(args)),
    github_search: (args) => w(() => handleGithubSearch(args)),
    tech_news_search: (args) => w(() => handleTechNewsSearch(args)),
    nixos_discourse_search: (args) => w(() => handleDiscourseSearch(args)),
    stackoverflow_search: (args) => w(() => handleStackOverflowSearch(args)),
    osint_dns: (args) => w(() => handleOsintDns(args)),
    osint_subdomains: (args) => w(() => handleOsintSubdomains(args)),
    osint_portscan: (args) => w(() => handleOsintPortScan(args)),
    web_crawl: (args) => w(() => handleWebCrawl(args)),

    // ── Research ──────────────────────────────────────────────────────────
    research_agent: (args) => handleResearchAgent(args),

    // ── ADR — dynamic dispatch via adrHandlers map ─────────────────────────
    ...Object.fromEntries(
      Object.keys(adrHandlers).map((name) => [
        name,
        (args: any) => adrHandlers[name as keyof typeof adrHandlers](args),
      ])
    ),

    // Override economics_report to include usage telemetry alongside ADR metrics
    economics_report: async (args) => {
      const [adrResult, usageSummary] = await Promise.allSettled([
        adrHandlers.economics_report(args as any),
        Promise.resolve(usageTracker.summary(args?.period_days || 7)),
      ]);
      const adr = adrResult.status === "fulfilled" ? adrResult.value : null;
      const usage = usageSummary.status === "fulfilled" ? usageSummary.value : null;
      // Merge into a unified economics response
      const merged = {
        ...(adr && (adr as any).content ? JSON.parse((adr as any).content[0]?.text || "{}") : {}),
        tool_usage: usage,
      };
      return { content: [{ type: "text", text: deps.stringify(merged) }] };
    },

    // ── Codebase Analysis ─────────────────────────────────────────────────
    analyze_complexity: (args) => analyzeComplexity(args),
    find_dead_code: (args) => findDeadCode(args),
    advanced_code_analysis: (args) => handleAdvancedCodeAnalysis(args),
    socket_debug_report: (args) => handleSocketDebugReport(args),

    // ── Secure Execution ──────────────────────────────────────────────────
    execute_in_sandbox: (args) => handleExecuteInSandbox(args),

    // ── SSH ───────────────────────────────────────────────────────────────
    ssh_execute: (args) => new SSHExecuteTool().execute(args),
    ssh_file_transfer: (args) => new SSHFileTransferTool().execute(args),
    ssh_maintenance_check: (args) => new SSHMaintenanceCheckTool().execute(args),
    ssh_tunnel: (args) => new SSHTunnelTool().execute(args),
    ssh_jump_host: (args) => new SSHJumpHostTool().execute(args),
    ssh_session_manager: (args) => new SSHSessionTool().execute(args),

    // ── DX Tools ──────────────────────────────────────────────────────────
    lint_code: (args) => devToolHandlers.lint_code(args),
    format_code: (args) => devToolHandlers.format_code(args),
    run_tests: (args) => devToolHandlers.run_tests(args),
    github_actions: (args) => devToolHandlers.github_actions(args),

    // ── Professional Operations ───────────────────────────────────────────
    server_health: (args) => deps.professionalToolHandlers.server_health(args),
    workspace_quality_gate: (args) => deps.professionalToolHandlers.workspace_quality_gate(args),
    performance_report: (args) => deps.professionalToolHandlers.performance_report(args),
    cache_tuning_advisor: (args) => deps.professionalToolHandlers.cache_tuning_advisor(args),
    change_impact: (args) => deps.professionalToolHandlers.change_impact(args),
    ci_failure_summary: (args) => deps.professionalToolHandlers.ci_failure_summary(args),
    tool_control_plane: (args) => deps.professionalToolHandlers.tool_control_plane(args),
    ci_batch_triage: (args) => deps.professionalToolHandlers.ci_batch_triage(args),

    // ── Browser ───────────────────────────────────────────────────────────
    browser_launch_advanced: (args) => new BrowserLaunchAdvancedTool().execute(args),
    browser_extract_data: (args) => new BrowserExtractDataTool().execute(args),
    browser_interact_form: (args) => new BrowserInteractFormTool().execute(args),
    browser_monitor_changes: (args) => new BrowserMonitorChangesTool().execute(args),
    browser_search_aggregate: (args) => new BrowserSearchAggregateTool().execute(args),

    // ── Session / Context / Misc ──────────────────────────────────────────
    session_bridge: (args) =>
      handleSessionBridge(args, {
        db: deps.db,
        semanticCache: deps.semanticCache,
        projectRoot: deps.projectRoot,
      }),
    nvim_context: (args) => handleNvimContext(args),
    nix_daemon: (args) => handleNixDaemon(args),
    git_sherlock: (args) => handleGitSherlock(args),
    notify_hook: (args) => handleNotifyHook(args),
    meta_tool: (args) =>
      handleMetaTool(args, async (toolName, toolArgs) => {
        const handler = map[toolName];
        if (!handler) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
        return handler(toolArgs);
      }),

    // ── Linux Debugging ───────────────────────────────────────────────────
    journal_analyze: (args) => handleJournalAnalyze(args),
    process_inspect: (args) => handleProcessInspect(args),
    systemd_delta: (args) => handleSystemdDelta(args),
    network_diag: (args) => handleNetworkDiag(args),
    disk_analyze: (args) => handleDiskAnalyze(args),
    security_scan: (args) => handleSecurityScan(args),

    // ── Documentation Tools ──────────────────────────────────────────
    doc_generate: (args) => handleDocGenerate(args),
    doc_coverage: (args) => handleDocCoverage(args),
    doc_validate: (args) => handleDocValidate(args),

    // ── Interoperability Tools ──────────────────────────────────────
    schema_convert: (args) => handleSchemaConvert(args),
    project_bridge: (args) => handleProjectBridge(args),
    data_transform: (args) => handleDataTransform(args),

    // ── Ecosystem Awareness ──────────────────────────────────────────
    ecosystem_map: (args) => handleEcosystemMap(args),
    ecosystem_trace: (args) => handleEcosystemTrace(args),
    ecosystem_search: (args) => handleEcosystemSearch(args),
    project_context_switcher: (args) => handleProjectContextSwitcher(args),
    cross_project_search: (args) => handleCrossProjectSearch(args),
    dependency_graph_analyzer: (args) => handleDependencyGraphAnalyzer(args),
    context_window_optimizer: (args) => handleContextWindowOptimizer(args),
  };

  return map;
}
