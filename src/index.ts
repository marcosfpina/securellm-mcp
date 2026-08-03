#!/usr/bin/env node

// Load SOPS-encrypted secrets into process.env before anything reads it
import { loadSecrets } from "./config/secrets-loader.js";
loadSecrets();

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs/promises";
import { createKnowledgeDatabase, type SQLiteKnowledgeDatabase } from "./knowledge/database.js";
import {
  type KnowledgeDatabase,
  type CreateSessionInput,
  type SaveKnowledgeInput,
  type SearchKnowledgeInput,
} from "./types/knowledge.js";
import type { ExtendedTool } from "./types/mcp-tool-extensions.js";
import { GuideManager } from "./resources/guides.js";
import * as path from "path";
import { SmartRateLimiter } from "./middleware/rate-limiter.js";
import { RATE_LIMIT_CONFIGS } from "./config/index.js";
import { PackageDiagnoseTool } from "./tools/package-diagnose.js";
import { PackageDownloadTool } from "./tools/package-download.js";
import { PackageConfigureTool } from "./tools/package-configure.js";
import { detectProjectRoot } from "./utils/project-detection.js";
import { detectNixOSHost } from "./utils/host-detection.js";
import { logger, logStartupError } from "./utils/logger.js";
import { ProjectWatcher } from "./system/watcher.js";
import { SemanticCache } from "./middleware/semantic-cache.js";
import { ContextManager } from "./reasoning/context-manager.js";
import { PreActionInterceptor } from "./reasoning/proactive/pre-action-interceptor.js";
import { stringifyGeneric } from "./utils/json-schemas.js";
import { ToolMetricsCollector, type ToolMetricsSnapshot } from "./middleware/tool-metrics.js";
import { ToolExecutionLimiter } from "./middleware/tool-limiter.js";
import { RequestDeduplicator, stableStringify } from "./middleware/request-deduplicator.js";
import { ADRHygieneMiddleware } from "./middleware/adr-hygiene.js";
import { createProfessionalToolHandlers } from "./tools/professional-tools.js";
import { ResponseSummarizer } from "./utils/response-summarizer.js";
import { shouldAttemptSemanticCache, shouldStoreSemanticCache } from "./utils/cache-policy.js";
import { ToolGovernanceManager } from "./utils/tool-governance.js";
import { applyActiveProfile } from "./config/profiles.js";
import { DisposableRegistry } from "./utils/disposable.js";
import crypto from "crypto";

import { buildToolCatalog } from "./server/tool-registry.js";
import { buildDispatchMap, type DispatchDeps } from "./server/dispatcher.js";
import type { McpToolResult } from "./server/wrap.js";
import { usageTracker } from "./telemetry/usage-tracker.js";

const shouldPrettyPrint = process.env.NODE_ENV === "development";
const SERVER_VERSION = process.env.SECURELLM_MCP_VERSION || "0.0.1";

function stringify(obj: unknown): string {
  if (shouldPrettyPrint) return JSON.stringify(obj, null, 2);
  return stringifyGeneric(obj as Record<string, unknown>);
}

const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();
const KNOWLEDGE_DB_PATH =
  process.env.KNOWLEDGE_DB_PATH ||
  path.join(
    process.env.HOME || process.env.USERPROFILE || ".",
    ".local/share/securellm/knowledge.db"
  );
const ENABLE_KNOWLEDGE = process.env.ENABLE_KNOWLEDGE !== "false";

const API_KEYS = {
  anthropic: process.env.ANTHROPIC_API_KEY || "",
  openai: process.env.OPENAI_API_KEY || "",
  deepseek: process.env.DEEPSEEK_API_KEY || "",
  gemini: process.env.GEMINI_API_KEY || "",
  openrouter: process.env.OPENROUTER_API_KEY || "",
  groq: process.env.GROQ_API_KEY || "",
  mistral: process.env.MISTRAL_API_KEY || "",
  nvidia: process.env.NVIDIA_API_KEY || "",
  replicate: process.env.REPLICATE_API_TOKEN || "",
};

class SecureLLMBridgeMCPServer {
  private server: Server;
  private db: KnowledgeDatabase | null = null;
  private guideManager: GuideManager;
  private rateLimiter: SmartRateLimiter;
  private projectWatcher: ProjectWatcher | null = null;
  private packageDiagnose!: PackageDiagnoseTool;
  private packageDownload!: PackageDownloadTool;
  private packageConfigure!: PackageConfigureTool;
  private projectRoot: string = PROJECT_ROOT;
  private hostname: string = "default";
  private semanticCache: SemanticCache | null = null;
  private contextManager: ContextManager | null = null;
  private preActionInterceptor: PreActionInterceptor | null = null;
  private adrHygieneMiddleware: ADRHygieneMiddleware | null = null;
  private toolMetricsCollector: ToolMetricsCollector;
  private toolLimiter: ToolExecutionLimiter;
  private requestDeduplicator: RequestDeduplicator;
  private disposables: DisposableRegistry = new DisposableRegistry();
  private professionalToolHandlers: ReturnType<typeof createProfessionalToolHandlers>;
  private toolGovernance: ToolGovernanceManager;

  private parseToolConfig(envValue?: string): Record<string, number> {
    if (!envValue) return {};
    const config: Record<string, number> = {};
    for (const pair of envValue.split(",")) {
      const [tool, value] = pair.split(":").map((s) => s.trim());
      if (tool && value) {
        const numValue = parseInt(value, 10);
        if (!isNaN(numValue)) config[tool] = numValue;
      }
    }
    return config;
  }

  constructor() {
    const configMap = new Map(Object.entries(RATE_LIMIT_CONFIGS));
    this.rateLimiter = new SmartRateLimiter(configMap);
    this.guideManager = new GuideManager();
    this.toolMetricsCollector = new ToolMetricsCollector();
    this.toolLimiter = new ToolExecutionLimiter({
      globalMaxConcurrency: parseInt(process.env.TOOL_LIMITER_GLOBAL_MAX_CONCURRENCY || "50", 10),
      defaultToolTimeout: parseInt(process.env.TOOL_LIMITER_DEFAULT_TIMEOUT || "30000", 10),
      maxQueueSize: parseInt(process.env.TOOL_LIMITER_MAX_QUEUE_SIZE || "100", 10),
      toolTimeouts: this.parseToolConfig(process.env.TOOL_LIMITER_TIMEOUTS),
      toolConcurrency: this.parseToolConfig(process.env.TOOL_LIMITER_CONCURRENCY),
    });
    this.requestDeduplicator = new RequestDeduplicator(
      parseInt(process.env.REQUEST_DEDUPE_STALE_TIMEOUT || "60000", 10),
      parseInt(process.env.REQUEST_DEDUPE_CLEANUP_INTERVAL || "30000", 10)
    );
    // ADR-0061: resolve o profile do repo (cwd da sessão) e alimenta o
    // contrato de env da governança ANTES do manager nascer. Env explícito
    // vence; sem profiles.json a chamada é no-op.
    applyActiveProfile();
    this.toolGovernance = new ToolGovernanceManager();
    this.professionalToolHandlers = createProfessionalToolHandlers({
      getProjectRoot: () => this.projectRoot,
      getServerStatus: (includeMetrics: boolean) => this.buildServerStatus(includeMetrics),
      getToolGovernanceSummary: (includeTools: boolean) =>
        this.buildToolGovernanceSummary(includeTools),
    });

    this.server = new Server(
      { name: "securellm-mcp", version: SERVER_VERSION },
      { capabilities: { tools: {}, resources: {} } }
    );

    this.setupToolHandlers();
    this.setupResourceHandlers();

    this.server.onerror = (error) => logger.error({ err: error }, "MCP server error");

    this.disposables.register("mcp-server", () => this.server.close());
    this.disposables.register("request-deduplicator", () => this.requestDeduplicator.close());
    this.disposables.register("usage-tracker", () => usageTracker.close());

    const shutdownHandler = () => {
      logger.info("Received shutdown signal, cleaning up resources");
      this.disposables
        .disposeAll()
        .then(() => process.exit(0))
        .catch((error) => {
          logger.error({ err: error }, "Error during shutdown");
          process.exit(1);
        });
    };
    process.on("SIGINT", shutdownHandler);
    process.on("SIGTERM", shutdownHandler);
  }

  async initialize(): Promise<void> {
    try {
      const rootDetection = await detectProjectRoot();
      this.projectRoot = rootDetection.projectRoot;
      logger.info(
        {
          projectRoot: this.projectRoot,
          method: rootDetection.method,
          flakeFound: rootDetection.flakeFound,
        },
        "Project root detected"
      );

      const availableKeys = Object.entries(API_KEYS)
        .filter(([_, key]) => key.length > 0)
        .map(([name, key]) => `${name}(${key.substring(0, 8)}...)`);
      if (availableKeys.length > 0) {
        logger.info({ apiKeys: availableKeys }, "API keys loaded");
      } else {
        logger.warn("No API keys loaded - provider tools will fail");
      }

      if (rootDetection.flakeFound) {
        try {
          const hostDetection = await detectNixOSHost(this.projectRoot);
          this.hostname = hostDetection.hostname;
          if (hostDetection.warnings.length > 0) {
            logger.warn({ warnings: hostDetection.warnings }, "Host detection warnings");
          }
        } catch (error) {
          logger.warn(
            { err: error, defaultHostname: "default" },
            "Failed to detect NixOS host, using default hostname"
          );
          this.hostname = "default";
        }
      } else {
        logger.warn({ defaultHostname: "default" }, "No flake.nix found, using default hostname");
        this.hostname = "default";
      }

      this.packageDiagnose = new PackageDiagnoseTool(this.projectRoot, this.hostname);
      this.packageDownload = new PackageDownloadTool(this.projectRoot);
      this.packageConfigure = new PackageConfigureTool(this.projectRoot);

      if (ENABLE_KNOWLEDGE) this.initKnowledge();

      this.initSemanticCache();

      const [phantomResult, rerankerResult] = await Promise.allSettled([
        fetch(`${process.env.PHANTOM_URL ?? "http://localhost:8008"}/health`, {
          signal: AbortSignal.timeout(2_000),
        })
          .then((r) => r.ok)
          .catch(() => false),
        fetch(`${process.env.CEREBRO_RERANKER_URL ?? "http://localhost:8016"}/health`, {
          signal: AbortSignal.timeout(2_000),
        })
          .then((r) => r.ok)
          .catch(() => false),
      ]);

      const phantomHealthy = phantomResult.status === "fulfilled" && phantomResult.value;
      const rerankerHealthy = rerankerResult.status === "fulfilled" && rerankerResult.value;

      if (phantomHealthy) {
        logger.info("✓ Semantic cache ACTIVE via PHANTOM (http://localhost:8008)");
      } else {
        logger.warn(
          "⚠ Semantic cache DEGRADED — PHANTOM unavailable, falling back to SQLite embeddings"
        );
      }
      logger.info(
        { phantomHealth: phantomHealthy, rerankerHealth: rerankerHealthy },
        "[Startup] Optional service health"
      );

      logger.info("MCP Server initialization complete");
    } catch (error) {
      logger.fatal({ err: error }, "Failed to initialize MCP server");
      throw error;
    }
  }

  private initKnowledge() {
    try {
      this.db = createKnowledgeDatabase(KNOWLEDGE_DB_PATH);
      this.disposables.register("knowledge-db", () => {
        if (this.db) {
          this.db.close();
          this.db = null;
        }
      });
      logger.info({ dbPath: KNOWLEDGE_DB_PATH }, "Knowledge database initialized");

      const isSystemDir =
        this.projectRoot.startsWith("/etc") ||
        this.projectRoot.startsWith("/usr") ||
        this.projectRoot.startsWith("/sys") ||
        this.projectRoot.startsWith("/proc") ||
        this.projectRoot === "/nix/store";
      const watcherExplicitlyEnabled = process.env.ENABLE_PROJECT_WATCHER === "true";
      const watcherExplicitlyDisabled = process.env.ENABLE_PROJECT_WATCHER === "false";
      const shouldStartWatcher =
        this.projectRoot &&
        (!isSystemDir || watcherExplicitlyEnabled) &&
        !watcherExplicitlyDisabled;

      if (shouldStartWatcher) {
        this.projectWatcher = new ProjectWatcher(this.projectRoot);
        this.projectWatcher.setDatabase(this.db);
        this.projectWatcher.start();
        this.disposables.register("project-watcher", () => {
          if (this.projectWatcher) {
            this.projectWatcher.stop();
            this.projectWatcher = null;
          }
        });
        this.contextManager = new ContextManager(
          this.projectRoot,
          this.db as SQLiteKnowledgeDatabase
        );
        this.preActionInterceptor = new PreActionInterceptor(this.contextManager);
        this.adrHygieneMiddleware = new ADRHygieneMiddleware();
        logger.info("Proactive Logic Layer initialized (incl. ADR Hygiene)");
      } else if (isSystemDir && !watcherExplicitlyEnabled) {
        this.contextManager = new ContextManager(
          this.projectRoot,
          this.db as SQLiteKnowledgeDatabase
        );
        this.preActionInterceptor = new PreActionInterceptor(this.contextManager);
        this.adrHygieneMiddleware = new ADRHygieneMiddleware();
        logger.info(
          { projectRoot: this.projectRoot },
          "ProjectWatcher skipped (system dir), Proactive Logic Layer initialized (DB-only mode)"
        );
      }
    } catch (error) {
      logger.error(
        { err: error, dbPath: KNOWLEDGE_DB_PATH },
        "Failed to initialize knowledge database"
      );
      this.db = null;
    }
  }

  private initSemanticCache() {
    try {
      const cacheDbPath =
        process.env.SEMANTIC_CACHE_DB_PATH ||
        path.join(
          process.env.HOME || process.env.USERPROFILE || ".",
          ".local/share/securellm/semantic_cache.db"
        );

      this.semanticCache = new SemanticCache(cacheDbPath, {
        enabled: process.env.ENABLE_SEMANTIC_CACHE !== "false",
        similarityThreshold: parseFloat(process.env.SEMANTIC_CACHE_THRESHOLD || "0.85"),
        ttlSeconds: parseInt(process.env.SEMANTIC_CACHE_TTL || "3600", 10),
        llamaCppUrl: process.env.LLAMA_CPP_URL || "http://localhost:8081",
      });
      this.disposables.register("semantic-cache", () => {
        if (this.semanticCache) {
          this.semanticCache.close();
          this.semanticCache = null;
        }
      });
      logger.info({ dbPath: cacheDbPath }, "Semantic cache initialized");
    } catch (error) {
      logger.error({ err: error }, "Failed to initialize semantic cache");
      this.semanticCache = null;
    }
  }

  // ── Knowledge dispatcher (consolidates 7 DB handlers) ────────────────────────

  private async dispatchKnowledge(
    name: string,
    args: Record<string, unknown>
  ): Promise<McpToolResult> {
    if (!this.db) {
      return {
        content: [{ type: "text", text: "Knowledge database not available" }],
        isError: true,
      };
    }
    try {
      let result: unknown;
      switch (name) {
        case "create_session":
          result = {
            session: await this.db.createSession(args as unknown as CreateSessionInput),
            message: "Session created successfully",
          };
          break;
        case "save_knowledge":
          result = {
            entry: await this.db.saveKnowledge(args as unknown as SaveKnowledgeInput),
            message: "Knowledge saved successfully",
          };
          break;
        case "search_knowledge": {
          const results = await this.db.searchKnowledge(args as unknown as SearchKnowledgeInput);
          result = { results, count: results.length };
          break;
        }
        case "load_session": {
          const sessionId = args.session_id as string;
          const session = await this.db.getSession(sessionId);
          if (!session)
            return { content: [{ type: "text", text: "Session not found" }], isError: true };
          const entries = await this.db.getRecentKnowledge(sessionId, 100);
          result = { session, entries, count: entries.length };
          break;
        }
        case "list_sessions": {
          const limit = (args.limit as number) || 20;
          const offset = (args.offset as number) || 0;
          const sessions = await this.db.listSessions(limit, offset);
          result = { sessions, count: sessions.length };
          break;
        }
        case "get_recent_knowledge": {
          const sessionId = args.session_id as string;
          const limit = (args.limit as number) || 20;
          const entries = await this.db.getRecentKnowledge(sessionId, limit);
          result = { entries, count: entries.length };
          break;
        }
        case "knowledge_maintenance":
          await this.db.maintenance();
          result = {
            message: "Maintenance completed successfully",
            stats: await this.db.getStats(),
          };
          break;
        default:
          return {
            content: [{ type: "text", text: `Unknown knowledge operation: ${name}` }],
            isError: true,
          };
      }
      return { content: [{ type: "text", text: stringify(result) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: stringify({ error: message }) }],
        isError: true,
      };
    }
  }

  // ── Rate limiter status ───────────────────────────────────────────────────────

  private async handleRateLimiterStatus(): Promise<McpToolResult> {
    try {
      const allMetrics = this.rateLimiter.getAllMetrics();
      const status: Record<string, unknown> = {};
      for (const [provider, metrics] of allMetrics.entries()) {
        const queueStatus = this.rateLimiter.getQueueStatus(provider);
        status[provider] = {
          performance: {
            totalRequests: metrics.totalRequests,
            successRate:
              metrics.totalRequests > 0
                ? `${((metrics.successfulRequests / metrics.totalRequests) * 100).toFixed(2)}%`
                : "0%",
            requestsPerMinute: metrics.requestsPerMinute.toFixed(1),
            retriedRequests: metrics.retriedRequests,
            averageRetries:
              metrics.retriedRequests > 0
                ? (metrics.totalRetries / metrics.retriedRequests).toFixed(1)
                : "0",
          },
          latency: {
            average: `${metrics.averageLatency.toFixed(0)}ms`,
            p50: `${metrics.latencyPercentiles.p50}ms`,
            p95: `${metrics.latencyPercentiles.p95}ms`,
            p99: `${metrics.latencyPercentiles.p99}ms`,
            max: `${metrics.latencyPercentiles.max}ms`,
          },
          errors: { total: metrics.failedRequests },
          queue: {
            current: queueStatus?.queueLength || 0,
            averageLength: metrics.queueMetrics.averageQueueLength.toFixed(1),
            maxLength: metrics.queueMetrics.maxQueueLength,
            averageWaitTime:
              metrics.totalRequests > 0
                ? `${(metrics.queueMetrics.totalTimeInQueue / metrics.totalRequests).toFixed(0)}ms`
                : "0ms",
          },
          timeWindow: {
            duration: `${(metrics.timeWindow.durationMs / 1000).toFixed(0)}s`,
            since: new Date(metrics.timeWindow.startTime).toISOString(),
          },
        };
      }
      return {
        content: [
          {
            type: "text",
            text: stringify({
              success: true,
              timestamp: new Date().toISOString(),
              providers: status,
            }),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: stringify({ success: false, error: message }) }],
        isError: true,
      };
    }
  }

  // ── Tool handlers setup ───────────────────────────────────────────────────────

  private setupToolHandlers() {
    // Live getters — deps read current values at call time, not at setup time
    const getDb = () => this.db;
    const getRateLimiter = () => this.rateLimiter;
    const getSemanticCache = () => this.semanticCache;
    const getProjectRoot = () => this.projectRoot;
    const getPackageDiagnose = () => this.packageDiagnose;
    const getPackageDownload = () => this.packageDownload;
    const getPackageConfigure = () => this.packageConfigure;
    const getProfessionalToolHandlers = () => this.professionalToolHandlers;
    const deps: DispatchDeps = {
      get db() {
        return getDb();
      },
      get rateLimiter() {
        return getRateLimiter();
      },
      get semanticCache() {
        return getSemanticCache();
      },
      get projectRoot() {
        return getProjectRoot();
      },
      get packageDiagnose() {
        return getPackageDiagnose();
      },
      get packageDownload() {
        return getPackageDownload();
      },
      get packageConfigure() {
        return getPackageConfigure();
      },
      get professionalToolHandlers() {
        return getProfessionalToolHandlers();
      },
      stringify,
      getServerStatus: (includeMetrics) => this.buildServerStatus(includeMetrics),
      getRateLimiterStatus: () => this.handleRateLimiterStatus(),
      handleKnowledge: (name, args) => this.dispatchKnowledge(name, args),
    };
    const dispatchMap = buildDispatchMap(deps);

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      // ADR-0061: a superfície listada respeita a mesma decisão de
      // governança da execução — tool bloqueada não é anunciada.
      tools: this.toolGovernance.sortTools(
        buildToolCatalog(this.db, ENABLE_KNOWLEDGE).filter(
          (tool) => this.toolGovernance.canExecute(tool).allowed
        )
      ),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const requestId = crypto.randomUUID();
      const startTime = Date.now();
      const { name, arguments: args } = request.params;
      const toolCatalog = buildToolCatalog(this.db, ENABLE_KNOWLEDGE) as ExtendedTool[];
      const toolDefinition = toolCatalog.find((tool) => tool.name === name) || { name };
      const governanceDecision = this.toolGovernance.canExecute(toolDefinition);

      if (!governanceDecision.allowed) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Tool '${name}' blocked by governance policy: ${governanceDecision.reason}`
        );
      }

      const cacheKey = stableStringify({ name, args });
      const requestSize = Buffer.byteLength(cacheKey, "utf8");
      const snapshot: {
        requestId: string;
        toolName: string;
        startTime: number;
        requestSize: number;
        cacheLookupTime?: number;
        cacheHit?: boolean;
        responseSize?: number;
        totalTime?: number;
        queueWaitTime?: number;
        error?: string;
        errorCategory?: string;
        preActionTime?: number;
        executionTime?: number;
        originalResponseSize?: number;
        compactionCharsSaved?: number;
        compactionTokensSaved?: number;
        compactionApplied?: boolean;
      } = { requestId, toolName: name, startTime, requestSize };
      let permit: { release: () => void } | null = null;

      try {
        // SEMANTIC CACHE: check before executing
        let cached: { response: unknown; metadata?: Record<string, unknown> } | null = null;
        if (this.semanticCache && shouldAttemptSemanticCache(name)) {
          const cacheLookupStart = Date.now();
          cached = await this.semanticCache.lookup({
            toolName: name,
            queryText: cacheKey,
            toolArgs: args,
          });
          snapshot.cacheLookupTime = Date.now() - cacheLookupStart;
          snapshot.cacheHit = cached !== null;
          if (cached) {
            try {
              snapshot.responseSize = Buffer.byteLength(stringify(cached), "utf8");
            } catch {
              snapshot.responseSize = JSON.stringify(cached).length;
            }
            snapshot.totalTime = Date.now() - startTime;
            snapshot.cacheHit = true;
            this.toolMetricsCollector.recordSnapshot(snapshot as ToolMetricsSnapshot);
            return cached;
          }
        }

        // BACKPRESSURE: acquire permit
        const queueWaitStart = Date.now();
        try {
          permit = await this.toolLimiter.acquire(name, requestId);
          snapshot.queueWaitTime = Date.now() - queueWaitStart;
        } catch (queueError) {
          snapshot.queueWaitTime = Date.now() - queueWaitStart;
          snapshot.error = queueError instanceof Error ? queueError.message : String(queueError);
          snapshot.errorCategory = "queue_full";
          snapshot.totalTime = Date.now() - startTime;
          this.toolMetricsCollector.recordSnapshot(snapshot as ToolMetricsSnapshot);
          throw queueError;
        }

        // PROACTIVE LOGIC: pre-action checks
        if (this.preActionInterceptor) {
          const preActionStart = Date.now();
          const interception = await this.preActionInterceptor.intercept(name, args);
          snapshot.preActionTime = Date.now() - preActionStart;
          if (!interception.shouldProceed) {
            throw new McpError(
              ErrorCode.InvalidParams,
              interception.reason || "Tool execution blocked by proactive checks"
            );
          }
        }

        // DEDUPLICATE + DISPATCH
        const executionStart = Date.now();
        const result = await this.requestDeduplicator.deduplicate(
          name,
          { toolName: name, args },
          async () => {
            const handler = dispatchMap[name];
            if (!handler) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
            return handler(args);
          }
        );
        snapshot.executionTime = Date.now() - executionStart;

        // ADR HYGIENE: periodic check (non-blocking)
        if (this.adrHygieneMiddleware) {
          try {
            const hygieneReport = await this.adrHygieneMiddleware.onToolCall();
            if (hygieneReport && result && Array.isArray(result.content)) {
              result.content.push({
                type: "text",
                text: `\n---\n${hygieneReport.summary}\n${hygieneReport.details.join("\n")}`,
              });
            }
          } catch {
            /* non-blocking */
          }
        }

        // RESPONSE COMPACTION
        let originalResponseSize = 0;
        try {
          originalResponseSize = Buffer.byteLength(stringify(result), "utf8");
        } catch {
          originalResponseSize = JSON.stringify(result).length;
        }
        const { result: compactedResult, stats: compactionStats } =
          ResponseSummarizer.compactToolResultWithStats(result);
        snapshot.originalResponseSize = originalResponseSize;
        snapshot.compactionCharsSaved = compactionStats.savedChars;
        snapshot.compactionTokensSaved = compactionStats.savedTokens;
        snapshot.compactionApplied = compactionStats.compactedFields > 0;
        try {
          snapshot.responseSize = Buffer.byteLength(stringify(compactedResult), "utf8");
        } catch {
          snapshot.responseSize = JSON.stringify(compactedResult).length;
        }

        // SEMANTIC CACHE: store result
        if (
          this.semanticCache &&
          compactedResult &&
          shouldStoreSemanticCache({
            toolName: name,
            result: compactedResult,
            responseSize: snapshot.responseSize,
          })
        ) {
          this.semanticCache
            .store({
              toolName: name,
              queryText: cacheKey,
              toolArgs: args,
              response: compactedResult,
              metadata: {
                tokensSaved: Math.max(
                  1,
                  Math.round((requestSize + (snapshot.responseSize || 0)) / 4)
                ),
                originalLatency: snapshot.totalTime,
              },
            })
            .catch((err) =>
              logger.warn({ err, toolName: name }, "Failed to store in semantic cache")
            );
        }

        snapshot.totalTime = Date.now() - startTime;
        this.toolMetricsCollector.recordSnapshot(snapshot as ToolMetricsSnapshot);

        // TELEMETRY: record successful invocation (fire-and-forget)
        void Promise.resolve().then(() =>
          usageTracker.record({
            session_id: requestId,
            tool_name: name,
            params_hash: crypto.createHash("sha256").update(cacheKey).digest("hex").slice(0, 16),
            started_at: startTime,
            duration_ms: snapshot.totalTime,
            success: true,
            cache_hit: snapshot.cacheHit === true,
          })
        );

        return compactedResult;
      } catch (error) {
        snapshot.totalTime = Date.now() - startTime;
        snapshot.error = error instanceof Error ? error.message : String(error);
        if (error instanceof McpError) {
          snapshot.errorCategory =
            error.code === (ErrorCode.InvalidParams as number) ? "invalid_params" : "mcp_error";
        } else if (error instanceof Error) {
          snapshot.errorCategory =
            error.message.includes("timeout") || error.message.includes("Timeout")
              ? "timeout"
              : error.message.includes("queue full")
                ? "queue_full"
                : "unknown";
        } else {
          snapshot.errorCategory = "unknown";
        }
        this.toolMetricsCollector.recordSnapshot(snapshot as ToolMetricsSnapshot);

        // TELEMETRY: record failed invocation
        void Promise.resolve().then(() =>
          usageTracker.record({
            session_id: requestId,
            tool_name: name,
            started_at: startTime,
            duration_ms: snapshot.totalTime,
            success: false,
            error_code: snapshot.errorCategory,
          })
        );

        if (error instanceof McpError) throw error;
        throw new McpError(
          ErrorCode.InternalError,
          `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        if (permit) permit.release();
      }
    });
  }

  // ── Resource handlers ─────────────────────────────────────────────────────────

  private setupResourceHandlers() {
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const dynamicResources = await this.guideManager.listAll();
      return {
        resources: [
          {
            uri: "server://status",
            name: "Server Status",
            description: "Current MCP server runtime status and enabled capabilities",
            mimeType: "application/json",
          },
          {
            uri: "config://current",
            name: "Current Configuration",
            description: "Current SecureLLM Bridge configuration",
            mimeType: "application/toml",
          },
          {
            uri: "logs://audit",
            name: "Audit Logs",
            description: "Recent audit log entries",
            mimeType: "application/json",
          },
          {
            uri: "metrics://usage",
            name: "Usage Metrics",
            description: "Provider usage statistics",
            mimeType: "application/json",
          },
          {
            uri: "metrics://prometheus",
            name: "Prometheus Metrics",
            description: "System metrics in Prometheus text format",
            mimeType: "text/plain",
          },
          {
            uri: "metrics://semantic-cache",
            name: "Semantic Cache Metrics",
            description: "Semantic cache performance statistics",
            mimeType: "application/json",
          },
          {
            uri: "docs://api",
            name: "API Documentation",
            description: "API documentation and examples",
            mimeType: "text/markdown",
          },
          ...dynamicResources.map(({ uri, name, description }) => ({
            uri,
            name,
            description,
            mimeType: "text/markdown",
          })),
        ],
      };
    });

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      try {
        if (uri.startsWith("guide://")) {
          const name = uri.replace("guide://", "");
          return {
            contents: [
              { uri, mimeType: "text/markdown", text: await this.guideManager.loadGuide(name) },
            ],
          };
        }
        if (uri.startsWith("skill://")) {
          const name = uri.replace("skill://", "");
          return {
            contents: [
              { uri, mimeType: "text/markdown", text: await this.guideManager.loadSkill(name) },
            ],
          };
        }
        if (uri.startsWith("prompt://")) {
          const name = uri.replace("prompt://", "");
          return {
            contents: [
              { uri, mimeType: "text/markdown", text: await this.guideManager.loadPrompt(name) },
            ],
          };
        }
        switch (uri) {
          case "server://status":
            return await this.readServerStatusResource();
          case "config://current":
            return await this.readCurrentConfig();
          case "logs://audit":
            return await this.readAuditLogs();
          case "metrics://usage":
            return await this.readUsageMetrics();
          case "metrics://prometheus":
            return {
              contents: [
                {
                  uri: "metrics://prometheus",
                  mimeType: "text/plain",
                  text: this.rateLimiter.getAggregatePrometheusMetrics(),
                },
              ],
            };
          case "metrics://semantic-cache":
            return {
              contents: [
                {
                  uri: "metrics://semantic-cache",
                  mimeType: "application/json",
                  text: stringify(
                    this.semanticCache?.getStats() || { error: "Semantic cache not initialized" }
                  ),
                },
              ],
            };
          case "docs://api":
            return await this.readApiDocs();
          default:
            throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${uri}`);
        }
      } catch (error) {
        if (error instanceof McpError) throw error;
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to read resource: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  // ── Server status builders ────────────────────────────────────────────────────

  private buildServerStatus(includeMetrics: boolean = true) {
    const guideInventory = this.guideManager.listAll();
    const uptimeMs = Math.max(0, Math.round(process.uptime() * 1000));
    const toolCatalog = buildToolCatalog(this.db, ENABLE_KNOWLEDGE);
    return Promise.resolve(guideInventory).then((resources) => ({
      name: "securellm-mcp",
      version: SERVER_VERSION,
      pid: process.pid,
      uptimeMs,
      projectRoot: this.projectRoot,
      hostname: this.hostname,
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        logLevel: process.env.LOG_LEVEL || "info",
      },
      features: {
        knowledgeEnabled: ENABLE_KNOWLEDGE,
        knowledgeReady: this.db !== null,
        semanticCacheEnabled: this.semanticCache !== null,
        proactiveReasoningEnabled: this.preActionInterceptor !== null,
        projectWatcherEnabled: this.projectWatcher !== null,
      },
      resources: {
        total: resources.length + 7,
        guides: resources.filter((r) => r.uri.startsWith("guide://")).length,
        skills: resources.filter((r) => r.uri.startsWith("skill://")).length,
        prompts: resources.filter((r) => r.uri.startsWith("prompt://")).length,
      },
      middleware: {
        rateLimiterProviders: this.rateLimiter.getAllMetrics().size,
        deduplicator: this.requestDeduplicator.getStats(),
        toolLimiter: includeMetrics ? this.toolLimiter.getStatus() : undefined,
      },
      governance: this.buildToolGovernanceSummary(includeMetrics),
      metrics: includeMetrics
        ? {
            semanticCache: this.semanticCache?.getStats() || null,
            toolMetrics: Object.fromEntries(this.toolMetricsCollector.getAllToolMetrics()),
          }
        : undefined,
      tools: { total: toolCatalog.length },
    }));
  }

  private buildToolGovernanceSummary(includeTools: boolean = false) {
    const toolCatalog = buildToolCatalog(this.db, ENABLE_KNOWLEDGE);
    const summary = this.toolGovernance.summarize(toolCatalog);
    if (!includeTools) return summary;
    return {
      ...summary,
      tools: toolCatalog.map((tool) => {
        const decision = this.toolGovernance.canExecute(tool);
        return { ...decision.metadata, allowed: decision.allowed, reason: decision.reason };
      }),
    };
  }

  private async readServerStatusResource() {
    const status = await this.buildServerStatus(true);
    return {
      contents: [{ uri: "server://status", mimeType: "application/json", text: stringify(status) }],
    };
  }

  private async readCurrentConfig() {
    try {
      const configPath = path.resolve(PROJECT_ROOT, "config.toml");
      const content = await fs.readFile(configPath, "utf-8");
      return {
        contents: [{ uri: "config://current", mimeType: "application/toml", text: content }],
      };
    } catch {
      return {
        contents: [
          { uri: "config://current", mimeType: "text/plain", text: "Configuration file not found" },
        ],
      };
    }
  }

  private async readAuditLogs() {
    const mockLogs = [
      {
        timestamp: new Date().toISOString(),
        request_id: "req_001",
        provider: "deepseek",
        model: "deepseek-chat",
        status: "success",
        duration_ms: 738,
        tokens: { prompt: 126, completion: 748 },
      },
    ];
    return {
      contents: [{ uri: "logs://audit", mimeType: "application/json", text: stringify(mockLogs) }],
    };
  }

  private async readUsageMetrics() {
    const mockMetrics = {
      providers: {
        deepseek: { requests: 10, errors: 0, avg_latency_ms: 750 },
        openai: { requests: 0, errors: 0, avg_latency_ms: 0 },
        anthropic: { requests: 0, errors: 0, avg_latency_ms: 0 },
        ollama: { requests: 0, errors: 0, avg_latency_ms: 0 },
      },
      total_requests: 10,
      total_errors: 0,
      uptime_seconds: 3600,
    };
    return {
      contents: [
        { uri: "metrics://usage", mimeType: "application/json", text: stringify(mockMetrics) },
      ],
    };
  }

  private async readApiDocs() {
    const docs = `# SecureLLM Bridge API Documentation\n\n## Provider Testing\nTest provider connectivity with sample queries.\n\n## Security Auditing\nRun security checks on configuration files.\n\n## Rate Limiting\nCheck current rate limit status for each provider.\n\n## Build & Test\nBuild the project and run test suites.\n\n## Configuration Validation\nValidate provider configuration format and completeness.\n\n## TLS Key Generation\nGenerate server and client TLS certificates.\n`;
    return { contents: [{ uri: "docs://api", mimeType: "text/markdown", text: docs }] };
  }

  // ── Run ───────────────────────────────────────────────────────────────────────

  async run() {
    const transport = new StdioServerTransport();
    const metricsPort = process.env.METRICS_PORT;
    if (metricsPort) {
      try {
        const http = await import("http");
        const metricsHost = process.env.METRICS_HOST || "0.0.0.0";
        http
          .createServer((req, res) => {
            if (req.url === "/metrics") {
              res.writeHead(200, { "Content-Type": "text/plain" });
              const rateLimiterMetrics = this.rateLimiter.getAggregatePrometheusMetrics();
              const toolMetrics = this.toolMetricsCollector.getPrometheusMetrics();
              res.end([rateLimiterMetrics, toolMetrics].filter(Boolean).join("\n\n"));
            } else if (req.url === "/health") {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  status: "ok",
                  timestamp: new Date().toISOString(),
                  limiter: this.toolLimiter.getStatus(),
                })
              );
            } else {
              res.writeHead(404);
              res.end();
            }
          })
          .listen(parseInt(metricsPort, 10), metricsHost, () => {
            logger.info(
              { port: metricsPort, host: metricsHost },
              "Prometheus metrics server running"
            );
          });
      } catch (err) {
        logger.error({ err }, "Failed to start metrics server");
      }
    }
    await this.server.connect(transport);
    logger.info({ transport: "stdio" }, "SecureLLM Bridge MCP server running");
  }
}

async function main() {
  const server = new SecureLLMBridgeMCPServer();
  try {
    await server.initialize();
    await server.run();
  } catch (error) {
    logStartupError("Failed to start MCP server", error as Error);
    process.exit(1);
  }
}

main();
