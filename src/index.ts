#!/usr/bin/env node

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
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import { createKnowledgeDatabase } from "./knowledge/database.js";
import { knowledgeTools } from "./tools/knowledge.js";
import type { KnowledgeDatabase, CreateSessionInput, SaveKnowledgeInput, SearchKnowledgeInput } from "./types/knowledge.js";
import type { ExtendedTool } from "./types/mcp-tool-extensions.js";
import { GuideManager } from "./resources/guides.js";
import * as path from "path";
import { SmartRateLimiter } from "./middleware/rate-limiter.js";
import { RATE_LIMIT_CONFIGS } from "./config/index.js";
import { PackageDiagnoseTool, packageDiagnoseSchema } from "./tools/package-diagnose.js";
import { PackageDownloadTool, packageDownloadSchema } from "./tools/package-download.js";
import { PackageConfigureTool, packageConfigureSchema } from "./tools/package-configure.js";
import { detectProjectRoot } from "./utils/project-detection.js";
import { detectNixOSHost } from "./utils/host-detection.js";
import { logger, logStartupError } from "./utils/logger.js";
import { ProjectWatcher } from "./system/watcher.js";
import {
  emergencyTools,
  handleEmergencyStatus,
  handleEmergencyAbort,
  handleEmergencyCooldown,
  handleEmergencyNuke,
  handleEmergencySwap,
  handleSystemHealthCheck,
  handleSafeRebuildCheck,
} from "./tools/emergency/index.js";
import {
  laptopDefenseTools,
  handleThermalCheck,
  handleRebuildSafetyCheck,
  handleThermalForensics,
  handleThermalWarroom,
  handleLaptopVerdict,
  handleFullInvestigation,
  handleForceCooldown,
  handleResetPerformance,
} from "./tools/laptop-defense/index.js";
import {
  webSearchTools,
  handleWebSearch,
  handleNixSearch,
  handleGithubSearch,
  handleTechNewsSearch,
  handleDiscourseSearch,
  handleStackOverflowSearch,
  getNixCacheStats,
} from "./tools/web-search.js";
import {
  researchAgentTool,
  handleResearchAgent,
} from "./tools/research-agent.js";
import {
  analyzeComplexity,
  findDeadCode,
  analyzeComplexitySchema,
  findDeadCodeSchema,
  mapDependenciesSchema,
} from "./tools/codebase-analysis.js";
import {
  sshTools,
  sshExecuteSchema,
  sshFileTransferSchema,
  sshMaintenanceCheckSchema,
  sshTunnelSchema,
  sshJumpHostSchema,
  sshSessionSchema,
  SSHExecuteTool,
  SSHFileTransferTool,
  SSHMaintenanceCheckTool,
  SSHTunnelTool,
  SSHJumpHostTool,
  SSHSessionTool,
} from "./tools/ssh/index.js";
import {
  executeInSandboxTool,
  handleExecuteInSandbox,
} from "./tools/secure-execution.js";
import { SemanticCache } from "./middleware/semantic-cache.js";
import { ContextManager } from "./reasoning/context-manager.js";
import { PreActionInterceptor } from "./reasoning/proactive/pre-action-interceptor.js";
import {
  stringifyToolResponse,
  stringifyKnowledgeEntries,
  stringifyGeneric,
} from './utils/json-schemas.js';

const shouldPrettyPrint = process.env.NODE_ENV === 'development';

function stringify(obj: any): string {
  if (shouldPrettyPrint) {
    return JSON.stringify(obj, null, 2);
  }
  return stringifyGeneric(obj);
}

const execAsync = promisify(exec);

// Legacy constants for backward compatibility - will be overridden by auto-detection
const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();
const KNOWLEDGE_DB_PATH = process.env.KNOWLEDGE_DB_PATH ||
  path.join(process.env.HOME || process.env.USERPROFILE || ".", ".local/share/securellm/knowledge.db");
const ENABLE_KNOWLEDGE = process.env.ENABLE_KNOWLEDGE !== 'false';

// Provider API keys from environment (loaded from SOPS-decrypted secrets)
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

interface ProviderTestArgs {
  provider: string;
  prompt: string;
  model?: string;
}

interface SecurityAuditArgs {
  config_file: string;
}

interface RateLimitCheckArgs {
  provider: string;
}

interface BuildAndTestArgs {
  test_type: "unit" | "integration" | "all";
}

interface ProviderConfigValidateArgs {
  provider: string;
  config_data: string;
}

interface CryptoKeyGenerateArgs {
  key_type: "server" | "client";
  output_path: string;
}

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

  constructor() {
    // Initialize smart rate limiter for API protection
    // Convert Record to Map for SmartRateLimiter
    const configMap = new Map(Object.entries(RATE_LIMIT_CONFIGS));
    this.rateLimiter = new SmartRateLimiter(configMap);
    this.guideManager = new GuideManager();

    this.server = new Server(
      {
        name: "securellm-mcp",
        version: "2.0.0",
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    );

    this.setupToolHandlers();
    this.setupResourceHandlers();

    this.server.onerror = (error) => logger.error({ err: error }, "MCP server error");
    process.on("SIGINT", async () => {
      logger.info("Received SIGINT, shutting down gracefully");
      if (this.db) {
        this.db.close();
      }
      if (this.semanticCache) {
        this.semanticCache.close();
      }
      await this.server.close();
      process.exit(0);
    });
  }

  /**
   * Initialize async resources (PROJECT_ROOT, hostname, knowledge DB)
   * Must be called before starting the server
   */
  async initialize(): Promise<void> {
    try {
      // Detect project root
      const rootDetection = await detectProjectRoot();
      this.projectRoot = rootDetection.projectRoot;
      logger.info(
        {
          projectRoot: this.projectRoot,
          method: rootDetection.method,
          flakeFound: rootDetection.flakeFound
        },
        "Project root detected"
      );

      // Log available API keys (masked)
      const availableKeys = Object.entries(API_KEYS)
        .filter(([_, key]) => key.length > 0)
        .map(([name, key]) => `${name}(${key.substring(0, 8)}...)`);
      if (availableKeys.length > 0) {
        logger.info({ apiKeys: availableKeys }, "API keys loaded");
      } else {
        logger.warn("No API keys loaded - provider tools will fail");
      }

      // Detect NixOS hostname
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
        logger.warn(
          { defaultHostname: "default" },
          "No flake.nix found, using default hostname - package tools may not work correctly"
        );
        this.hostname = "default";
      }

      // Initialize package tools with detected values
      this.packageDiagnose = new PackageDiagnoseTool(
        this.projectRoot,
        this.hostname
      );
      this.packageDownload = new PackageDownloadTool(this.projectRoot);
      this.packageConfigure = new PackageConfigureTool(this.projectRoot);

      // Initialize knowledge database if enabled
      if (ENABLE_KNOWLEDGE) {
        this.initKnowledge();
      }

      // Initialize Semantic Cache
      this.initSemanticCache();

      logger.info("MCP Server initialization complete");
    } catch (error) {
      logger.fatal({ err: error }, "Failed to initialize MCP server");
      throw error;
    }
  }

  private initKnowledge() {
    try {
      this.db = createKnowledgeDatabase(KNOWLEDGE_DB_PATH);
      logger.info({ dbPath: KNOWLEDGE_DB_PATH }, "Knowledge database initialized");

      // Initialize Project Watcher if we have a project root
      if (this.projectRoot) {
        this.projectWatcher = new ProjectWatcher(this.projectRoot);
        this.projectWatcher.setDatabase(this.db);
        this.projectWatcher.start();

        // Initialize Proactive Logic components
        this.contextManager = new ContextManager(this.projectRoot, this.db as any); // Cast to any to avoid type mismatch if different SQLite wrapper
        this.preActionInterceptor = new PreActionInterceptor(this.contextManager);
        logger.info("Proactive Logic Layer initialized");
      }

    } catch (error) {
      logger.error({ err: error, dbPath: KNOWLEDGE_DB_PATH }, "Failed to initialize knowledge database");
      this.db = null;
    }
  }

  private initSemanticCache() {
    try {
      const cacheDbPath = process.env.SEMANTIC_CACHE_DB_PATH ||
        path.join(
          process.env.HOME || process.env.USERPROFILE || ".",
          ".local/share/securellm/semantic_cache.db"
        );

      this.semanticCache = new SemanticCache(cacheDbPath, {
        enabled: process.env.ENABLE_SEMANTIC_CACHE !== 'false',
        similarityThreshold: parseFloat(process.env.SEMANTIC_CACHE_THRESHOLD || '0.85'),
        ttlSeconds: parseInt(process.env.SEMANTIC_CACHE_TTL || '3600', 10),
        llamaCppUrl: process.env.LLAMA_CPP_URL || 'http://localhost:8080',
      });

      logger.info({ dbPath: cacheDbPath }, "Semantic cache initialized");

      // Start periodic cleanup (every 10 minutes)
      setInterval(() => {
        if (this.semanticCache) {
          const deleted = this.semanticCache.cleanExpired();
          if (deleted > 0) {
            logger.info({ deleted }, "Cleaned expired semantic cache entries");
          }
        }
      }, 10 * 60 * 1000);

    } catch (error) {
      logger.error({ err: error }, "Failed to initialize semantic cache");
      this.semanticCache = null;
    }
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "provider_test",
          description: "Test LLM provider connectivity",
          defer_loading: true,
          inputSchema: {
            type: "object",
            properties: {
              provider: {
                type: "string",
                description: "Provider name (deepseek, openai, anthropic, ollama)",
                enum: ["deepseek", "openai", "anthropic", "ollama"],
              },
              prompt: {
                type: "string",
                description: "Test prompt to send to the provider",
              },
              model: {
                type: "string",
                description: "Model name (optional, uses default if not specified)",
              },
            },
            required: ["provider", "prompt"],
          },
        },
        {
          name: "security_audit",
          description: "Audit project configuration security",
          defer_loading: true,
          inputSchema: {
            type: "object",
            properties: {
              config_file: {
                type: "string",
                description: "Path to configuration file to audit",
              },
            },
            required: ["config_file"],
          },
        },
        {
          name: "rate_limit_check",
          description: "Check provider rate limit status",
          defer_loading: true,
          inputSchema: {
            type: "object",
            properties: {
              provider: {
                type: "string",
                description: "Provider name to check",
                enum: ["deepseek", "openai", "anthropic", "ollama"],
              },
            },
            required: ["provider"],
          },
        },
        {
          name: "build_and_test",
          description: "Build project and run tests",
          defer_loading: true,
          inputSchema: {
            type: "object",
            properties: {
              test_type: {
                type: "string",
                description: "Type of tests to run",
                enum: ["unit", "integration", "all"],
              },
            },
            required: ["test_type"],
          },
        },
        {
          name: "provider_config_validate",
          description: "Validate provider config format",
          defer_loading: true,
          inputSchema: {
            type: "object",
            properties: {
              provider: {
                type: "string",
                description: "Provider name",
              },
              config_data: {
                type: "string",
                description: "Configuration data in TOML format",
              },
            },
            required: ["provider", "config_data"],
          },
        },
        {
          name: "crypto_key_generate",
          description: "Generate TLS certificates and keys",
          defer_loading: true,
          inputSchema: {
            type: "object",
            properties: {
              key_type: {
                type: "string",
                description: "Type of key to generate",
                enum: ["server", "client"],
              },
              output_path: {
                type: "string",
                description: "Directory path where keys should be saved",
              },
            },
            required: ["key_type", "output_path"],
          },
        },
        {
          name: "rate_limiter_status",
          description: "Get rate limiter status for all providers",
          defer_loading: true,
          allowed_callers: ["code_execution_20250825"],
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "cache_stats",
          description: "Get cache statistics (Semantic Cache, Nix Package Cache)",
          defer_loading: true,
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "package_diagnose",
          description: "Diagnose package configuration issues",
          defer_loading: true,
          inputSchema: {
            type: "object",
            properties: {
              package_path: {
                type: "string",
                description: "Path to the package .nix file",
              },
              package_type: {
                type: "string",
                enum: ["tar", "deb", "js"],
                description: "Type of package system",
              },
              build_test: {
                type: "boolean",
                description: "Whether to perform a test build",
                default: true,
              },
            },
            required: ["package_path", "package_type"],
          },
        },
        {
          name: "package_download",
          description: "Download package from GitHub/npm/URL with automatic hash calculation",
          defer_loading: true,
          inputSchema: {
            type: "object",
            properties: {
              package_name: {
                type: "string",
                description: "Name of the package",
              },
              package_type: {
                type: "string",
                enum: ["tar", "deb", "js"],
                description: "Type of package system",
              },
              source: {
                type: "object",
                properties: {
                  type: {
                    type: "string",
                    enum: ["github_release", "npm", "url"],
                    description: "Source type",
                  },
                  url: {
                    type: "string",
                    description: "Direct URL (for type: url)",
                  },
                  github: {
                    type: "object",
                    properties: {
                      repo: { type: "string" },
                      tag: { type: "string" },
                      asset_pattern: { type: "string" },
                    },
                    required: ["repo"],
                  },
                  npm: {
                    type: "object",
                    properties: {
                      package: { type: "string" },
                      version: { type: "string" },
                    },
                    required: ["package"],
                  },
                },
                required: ["type"],
              },
            },
            required: ["package_name", "package_type", "source"],
          },
        },
        {
          name: "package_configure",
          description: "Generate Nix package configuration from downloaded file",
          defer_loading: true,
          inputSchema: {
            type: "object",
            properties: {
              package_name: {
                type: "string",
                description: "Name of the package",
              },
              package_type: {
                type: "string",
                enum: ["tar", "deb", "js"],
                description: "Type of package system",
              },
              storage_file: {
                type: "string",
                description: "Path to downloaded file in storage",
              },
              sha256: {
                type: "string",
                description: "SHA256 hash of the file",
              },
              options: {
                type: "object",
                properties: {
                  method: {
                    type: "string",
                    enum: ["auto", "native", "fhs"],
                  },
                  sandbox: { type: "boolean" },
                  audit: { type: "boolean" },
                  executable: { type: "string" },
                  npm_flags: {
                    type: "array",
                    items: { type: "string" },
                  },
                },
              },
            },
            required: ["package_name", "package_type", "storage_file", "sha256"],
          },
        },
        // Add knowledge tools if enabled
        ...(ENABLE_KNOWLEDGE && this.db ? knowledgeTools : []),
        // Add Emergency Framework tools
        ...emergencyTools,
        // Add Laptop Defense Framework tools
        ...laptopDefenseTools,
        // Add Web Search tools
        ...webSearchTools,
        // Add Research Agent tool
        researchAgentTool,
        // Add Codebase Analysis Tools
        {
          name: "analyze_complexity",
          description: "Analyze code complexity and file size statistics",
          defer_loading: true,
          inputSchema: analyzeComplexitySchema,
        },
        {
          name: "find_dead_code",
          description: "Heuristic search for unused exports (potentially dead code)",
          defer_loading: true,
          inputSchema: findDeadCodeSchema,
        },
        // Add Secure Execution Tool
        executeInSandboxTool,
        // Add SSH Tools
        {
          name: sshExecuteSchema.name,
          description: sshExecuteSchema.description,
          defer_loading: true,
          inputSchema: sshExecuteSchema.inputSchema,
        },
        {
          name: sshFileTransferSchema.name,
          description: sshFileTransferSchema.description,
          defer_loading: true,
          inputSchema: sshFileTransferSchema.inputSchema,
        },
        {
          name: sshMaintenanceCheckSchema.name,
          description: sshMaintenanceCheckSchema.description,
          defer_loading: true,
          inputSchema: sshMaintenanceCheckSchema.inputSchema,
        },
        {
          name: sshTunnelSchema.name,
          description: sshTunnelSchema.description,
          defer_loading: true,
          inputSchema: sshTunnelSchema.inputSchema,
        },
        {
          name: sshJumpHostSchema.name,
          description: sshJumpHostSchema.description,
          defer_loading: true,
          inputSchema: sshJumpHostSchema.inputSchema,
        },
        {
          name: sshSessionSchema.name,
          description: sshSessionSchema.description,
          defer_loading: true,
          inputSchema: sshSessionSchema.inputSchema,
        },
      ] as ExtendedTool[],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const { name, arguments: args } = request.params;

        // SEMANTIC CACHE: Check cache before executing tool
        if (this.semanticCache) {
          const cacheKey = JSON.stringify({ name, args });
          const cached = await this.semanticCache.lookup({
            toolName: name,
            queryText: cacheKey,
            toolArgs: args,
          });

          if (cached) {
            // Return cached response
            return cached;
          }
        }

        // PROACTIVE LOGIC: Pre-action checks
        if (this.preActionInterceptor) {
          const interception = await this.preActionInterceptor.intercept(name, args);
          if (!interception.shouldProceed) {
            throw new McpError(
              ErrorCode.InvalidParams,
              interception.reason || "Tool execution blocked by proactive checks"
            );
          }
          // If enrichedArgs were returned, we could use them here, but for now we stick to original args
          // or we could merge: args = interception.enrichedArgs || args;
        }

        // Execute tool
        let result;
        switch (name) {
          case "provider_test":
            result = await this.handleProviderTest(args as unknown as ProviderTestArgs);
            break;
          case "security_audit":
            result = await this.handleSecurityAudit(args as unknown as SecurityAuditArgs);
            break;
          case "rate_limit_check":
            result = await this.handleRateLimitCheck(args as unknown as RateLimitCheckArgs);
            break;
          case "build_and_test":
            result = await this.handleBuildAndTest(args as unknown as BuildAndTestArgs);
            break;
          case "provider_config_validate":
            result = await this.handleProviderConfigValidate(args as unknown as ProviderConfigValidateArgs);
            break;
          case "crypto_key_generate":
            result = await this.handleCryptoKeyGenerate(args as unknown as CryptoKeyGenerateArgs);
            break;
          case "rate_limiter_status":
            result = await this.handleRateLimiterStatus();
            break;
          case "cache_stats":
            result = {
              content: [
                {
                  type: "text",
                  text: stringify({
                    semantic_cache: this.semanticCache?.getStats() || null,
                    nix_cache: getNixCacheStats(),
                  }),
                },
              ],
            };
            break;
          case "package_diagnose":
            result = await this.handlePackageDiagnose(args);
            break;
          case "package_download":
            result = await this.handlePackageDownload(args);
            break;
          case "package_configure":
            result = await this.handlePackageConfigure(args);
            break;
          case "create_session":
            result = await this.handleCreateSession(args);
            break;
          case "save_knowledge":
            result = await this.handleSaveKnowledge(args);
            break;
          case "search_knowledge":
            result = await this.handleSearchKnowledge(args);
            break;
          case "load_session":
            result = await this.handleLoadSession(args);
            break;
          case "list_sessions":
            result = await this.handleListSessions(args);
            break;
          case "get_recent_knowledge":
            result = await this.handleGetRecentKnowledge(args);
            break;
          case "knowledge_maintenance":
            result = await this.handleKnowledgeMaintenance();
            break;

          // Emergency Framework handlers
          case "emergency_status":
            result = await this.handleEmergencyStatus();
            break;
          case "emergency_abort":
            result = await this.handleEmergencyAbort(args);
            break;
          case "emergency_cooldown":
            result = await this.handleEmergencyCooldown();
            break;
          case "emergency_nuke":
            result = await this.handleEmergencyNuke(args);
            break;
          case "emergency_swap":
            result = await this.handleEmergencySwap();
            break;
          case "system_health_check":
            result = await this.handleSystemHealthCheck(args);
            break;
          case "safe_rebuild_check":
            result = await this.handleSafeRebuildCheck();
            break;

          // Laptop Defense handlers
          case "thermal_check":
            result = await this.handleThermalCheck(args);
            break;
          case "rebuild_safety_check":
            result = await this.handleRebuildSafetyCheck();
            break;
          case "thermal_forensics":
            result = await this.handleThermalForensics(args);
            break;
          case "thermal_warroom":
            result = await this.handleThermalWarroom(args);
            break;
          case "laptop_verdict":
            result = await this.handleLaptopVerdict(args);
            break;
          case "full_investigation":
            result = await this.handleFullInvestigation();
            break;
          case "force_cooldown":
            result = await this.handleForceCooldown();
            break;
          case "reset_performance":
            result = await this.handleResetPerformance();
            break;

          // Web Search handlers
          case "web_search":
            result = await this.handleWebSearch(args);
            break;
          case "nix_search":
            result = await this.handleNixSearch(args);
            break;
          case "github_search":
            result = await this.handleGithubSearch(args);
            break;
          case "tech_news_search":
            result = await this.handleTechNewsSearch(args);
            break;
          case "nixos_discourse_search":
            result = await this.handleDiscourseSearch(args);
            break;
          case "stackoverflow_search":
            result = await this.handleStackOverflowSearch(args);
            break;

          // Research Agent handler
          case "research_agent":
            result = await handleResearchAgent(args as any);
            break;

          // Codebase Analysis handlers
          case "analyze_complexity":
            result = await analyzeComplexity(args as any);
            break;
          case "find_dead_code":
            result = await findDeadCode(args as any);
            break;

          // Secure Execution handler
          case "execute_in_sandbox":
            result = await handleExecuteInSandbox(args as any);
            break;

          // SSH Tool handlers
          case "ssh_execute":
            result = await new SSHExecuteTool().execute(args as any);
            break;
          case "ssh_file_transfer":
            result = await new SSHFileTransferTool().execute(args as any);
            break;
          case "ssh_maintenance_check":
            result = await new SSHMaintenanceCheckTool().execute(args as any);
            break;
          case "ssh_tunnel":
            result = await new SSHTunnelTool().execute(args as any);
            break;
          case "ssh_jump_host":
            result = await new SSHJumpHostTool().execute(args as any);
            break;
          case "ssh_session_manager":
            result = await new SSHSessionTool().execute(args as any);
            break;

          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${name}`
            );
        }

        // SEMANTIC CACHE: Store result for future lookups
        if (this.semanticCache && result) {
          const cacheKey = JSON.stringify({ name, args });
          await this.semanticCache.store({
            toolName: name,
            queryText: cacheKey,
            toolArgs: args,
            response: result,
          });
        }

        return result;

      } catch (error) {
        if (error instanceof McpError) throw error;
        throw new McpError(
          ErrorCode.InternalError,
          `Tool execution failed: ${error}`
        );
      }
    });
  }

  private setupResourceHandlers() {
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
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
      ],
    }));

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;

      try {
        // Handle guide/skill/prompt resources
        if (uri.startsWith('guide://')) {
          const name = uri.replace('guide://', '');
          const content = await this.guideManager.loadGuide(name);
          return {
            contents: [{
              uri,
              mimeType: "text/markdown",
              text: content,
            }],
          };
        }

        if (uri.startsWith('skill://')) {
          const name = uri.replace('skill://', '');
          const content = await this.guideManager.loadSkill(name);
          return {
            contents: [{
              uri,
              mimeType: "text/markdown",
              text: content,
            }],
          };
        }

        if (uri.startsWith('prompt://')) {
          const name = uri.replace('prompt://', '');
          const content = await this.guideManager.loadPrompt(name);
          return {
            contents: [{
              uri,
              mimeType: "text/markdown",
              text: content,
            }],
          };
        }

        // Handle existing resources
        switch (uri) {
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
            throw new McpError(
              ErrorCode.InvalidRequest,
              `Unknown resource: ${uri}`
            );
        }
      } catch (error) {
        if (error instanceof McpError) throw error;
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to read resource: ${error}`
        );
      }
    });
  }

  private async handleProviderTest(args: ProviderTestArgs) {
    const { provider, prompt, model } = args;

    try {
      // Wrap API call with rate limiter
      const result = await this.rateLimiter.execute(provider, async () => {
        const testScript = `
          cd "${PROJECT_ROOT}" && \
          cargo run --bin securellm -- test ${provider} --prompt "${prompt.replace(/"/g, '\\"')}"${model ? ` --model ${model}` : ''}
        `;

        const { stdout, stderr } = await execAsync(testScript, {
          cwd: PROJECT_ROOT,
          timeout: 30000,
        });

        return { stdout, stderr, success: true };
      });

      return {
        content: [
          {
            type: "text",
            text: stringify({
              provider,
              model: model || "default",
              prompt,
              status: "success",
              output: result.stdout,
              stderr: result.stderr || null,
            }),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              provider,
              status: "error",
              error: error.message,
              errorType: error.constructor.name,
            }, null, 2),
          },
        ],
        isError: true,
      };
    }
  }

  private async handleSecurityAudit(args: SecurityAuditArgs) {
    const { config_file } = args;
    const configPath = path.resolve(PROJECT_ROOT, config_file);

    try {
      const configContent = await fs.readFile(configPath, "utf-8");

      const issues: string[] = [];
      const warnings: string[] = [];
      const recommendations: string[] = [];

      // Check for hardcoded secrets
      if (configContent.match(/sk-[a-zA-Z0-9]{32,}/)) {
        issues.push("⚠️ CRITICAL: Hardcoded API keys detected in configuration");
      }

      // Check TLS configuration
      if (configContent.includes('enabled = false') && configContent.includes('[security.tls]')) {
        warnings.push("TLS is disabled - only use for development");
      }

      // Check rate limiting
      if (!configContent.includes('[security.rate_limit]')) {
        warnings.push("Rate limiting not configured");
      }

      // Check audit logging
      if (!configContent.includes('[security.audit]')) {
        recommendations.push("Consider enabling audit logging for production");
      }

      // Check for environment variable usage
      if (!configContent.includes('${') && configContent.includes('api_key')) {
        recommendations.push("Use environment variables for API keys instead of hardcoding");
      }

      const result = {
        config_file,
        status: issues.length > 0 ? "failed" : warnings.length > 0 ? "warning" : "passed",
        issues,
        warnings,
        recommendations,
        summary: `Found ${issues.length} critical issues, ${warnings.length} warnings, ${recommendations.length} recommendations`,
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "error",
              error: error.message,
            }, null, 2),
          },
        ],
        isError: true,
      };
    }
  }

  private async handleRateLimitCheck(args: RateLimitCheckArgs) {
    const { provider } = args;

    // This is a mock implementation - in production, this would query actual rate limit state
    const rateLimits: Record<string, any> = {
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
      ollama: {
        requests_per_minute: -1, // unlimited
        burst_size: -1,
        current_usage: 0,
        reset_time: null,
      },
    };

    const result = {
      provider,
      ...rateLimits[provider],
      remaining: rateLimits[provider].requests_per_minute - rateLimits[provider].current_usage,
      status: "ok",
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private async handleBuildAndTest(args: BuildAndTestArgs) {
    const { test_type } = args;

    let testCommand = "";
    switch (test_type) {
      case "unit":
        testCommand = "cargo test --lib";
        break;
      case "integration":
        testCommand = "cargo test --test '*'";
        break;
      case "all":
        testCommand = "cargo test";
        break;
    }

    try {
      // Wrap build operations with rate limiter to prevent spam
      const result = await this.rateLimiter.execute('build', async () => {
        const buildScript = `
          cd "${PROJECT_ROOT}" && \
          cargo build && \
          ${testCommand}
        `;

        const { stdout, stderr } = await execAsync(buildScript, {
          cwd: PROJECT_ROOT,
          timeout: 120000,
        });

        return { stdout, stderr, success: true };
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              test_type,
              status: "success",
              output: result.stdout,
              stderr: result.stderr || null,
            }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              test_type,
              status: "error",
              error: error.message,
              errorType: error.constructor.name,
            }, null, 2),
          },
        ],
        isError: true,
      };
    }
  }

  private async handleProviderConfigValidate(args: ProviderConfigValidateArgs) {
    const { provider, config_data } = args;

    const issues: string[] = [];
    const warnings: string[] = [];

    // Basic TOML validation
    if (!config_data.trim().startsWith("[providers.")) {
      issues.push("Configuration must start with [providers.PROVIDER_NAME]");
    }

    // Check required fields
    const requiredFields = ["enabled", "api_key", "base_url"];
    for (const field of requiredFields) {
      if (!config_data.includes(field)) {
        issues.push(`Missing required field: ${field}`);
      }
    }

    // Check for security issues
    if (config_data.match(/api_key\s*=\s*"sk-/)) {
      warnings.push("API key appears to be hardcoded - use environment variables");
    }

    const result = {
      provider,
      status: issues.length > 0 ? "invalid" : warnings.length > 0 ? "valid_with_warnings" : "valid",
      issues,
      warnings,
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private async handleCryptoKeyGenerate(args: CryptoKeyGenerateArgs) {
    const { key_type, output_path } = args;

    const outputDir = path.resolve(PROJECT_ROOT, output_path);

    try {
      // Wrap crypto operations with rate limiter (expensive operations)
      const result = await this.rateLimiter.execute('crypto', async () => {
        await fs.mkdir(outputDir, { recursive: true });

        let certCommand = "";
        if (key_type === "server") {
          certCommand = `
            openssl req -x509 -newkey rsa:4096 -keyout "${outputDir}/server.key" \
              -out "${outputDir}/server.crt" -days 365 -nodes \
              -subj "/C=US/ST=State/L=City/O=Org/CN=securellm-server"
          `;
        } else {
          certCommand = `
            openssl req -x509 -newkey rsa:4096 -keyout "${outputDir}/client.key" \
              -out "${outputDir}/client.crt" -days 365 -nodes \
              -subj "/C=US/ST=State/L=City/O=Org/CN=securellm-client"
          `;
        }

        await execAsync(certCommand);
        return { success: true };
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              key_type,
              output_path: outputDir,
              files: {
                certificate: `${key_type}.crt`,
                private_key: `${key_type}.key`,
              },
              status: "success",
              message: `Generated ${key_type} TLS certificate and key`,
            }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "error",
              error: error.message,
              errorType: error.constructor.name,
            }, null, 2),
          },
        ],
        isError: true,
      };
    }
  }

  private async readCurrentConfig() {
    try {
      const configPath = path.resolve(PROJECT_ROOT, "config.toml");
      const content = await fs.readFile(configPath, "utf-8");

      return {
        contents: [
          {
            uri: "config://current",
            mimeType: "application/toml",
            text: content,
          },
        ],
      };
    } catch (error) {
      return {
        contents: [
          {
            uri: "config://current",
            mimeType: "text/plain",
            text: "Configuration file not found",
          },
        ],
      };
    }
  }

  private async readAuditLogs() {
    // Mock audit log data - in production this would read from actual log files
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
      contents: [
        {
          uri: "logs://audit",
          mimeType: "application/json",
          text: JSON.stringify(mockLogs, null, 2),
        },
      ],
    };
  }

  private async readUsageMetrics() {
    // Mock usage metrics - in production this would aggregate real data
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
        {
          uri: "metrics://usage",
          mimeType: "application/json",
          text: JSON.stringify(mockMetrics, null, 2),
        },
      ],
    };
  }

  // ===== KNOWLEDGE MANAGEMENT HANDLERS =====

  private async handleCreateSession(args: any) {
    if (!this.db) {
      return {
        content: [{ type: "text", text: "Knowledge database not available" }],
        isError: true
      };
    }

    try {
      const session = await this.db.createSession(args as CreateSessionInput);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ session, message: "Session created successfully" }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: error.message }, null, 2) }],
        isError: true
      };
    }
  }

  private async handleSaveKnowledge(args: any) {
    if (!this.db) {
      return {
        content: [{ type: "text", text: "Knowledge database not available" }],
        isError: true
      };
    }

    try {
      const entry = await this.db.saveKnowledge(args as SaveKnowledgeInput);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ entry, message: "Knowledge saved successfully" }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: error.message }, null, 2) }],
        isError: true
      };
    }
  }

  private async handleSearchKnowledge(args: any) {
    if (!this.db) {
      return {
        content: [{ type: "text", text: "Knowledge database not available" }],
        isError: true
      };
    }

    try {
      const results = await this.db.searchKnowledge(args as SearchKnowledgeInput);
      return {
        content: [{
          type: "text",
          text: stringify({ results, count: results.length })
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: error.message }, null, 2) }],
        isError: true
      };
    }
  }

  private async handleLoadSession(args: any) {
    if (!this.db) {
      return {
        content: [{ type: "text", text: "Knowledge database not available" }],
        isError: true
      };
    }

    try {
      const session = await this.db.getSession(args.session_id);
      if (!session) {
        return {
          content: [{ type: "text", text: "Session not found" }],
          isError: true
        };
      }

      const entries = await this.db.getRecentKnowledge(args.session_id, 100);
      return {
        content: [{
          type: "text",
          text: stringify({ session, entries, count: entries.length })
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: error.message }, null, 2) }],
        isError: true
      };
    }
  }

  private async handleListSessions(args: any) {
    if (!this.db) {
      return {
        content: [{ type: "text", text: "Knowledge database not available" }],
        isError: true
      };
    }

    try {
      const sessions = await this.db.listSessions(args.limit || 20, args.offset || 0);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ sessions, count: sessions.length }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: error.message }, null, 2) }],
        isError: true
      };
    }
  }

  private async handleGetRecentKnowledge(args: any) {
    if (!this.db) {
      return {
        content: [{ type: "text", text: "Knowledge database not available" }],
        isError: true
      };
    }

    try {
      const entries = await this.db.getRecentKnowledge(args.session_id, args.limit || 20);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ entries, count: entries.length }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: error.message }, null, 2) }],
        isError: true
      };
    }
  }

  private async handleKnowledgeMaintenance() {
    if (!this.db) {
      return {
        content: [{ type: "text", text: "Knowledge database not available" }],
        isError: true
      };
    }

    try {
      await this.db.maintenance();
      const stats = await this.db.getStats();
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ message: "Maintenance completed successfully", stats }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: error.message }, null, 2) }],
        isError: true
      };
    }
  }

  private async handleRateLimiterStatus() {
    try {
      const allMetrics = this.rateLimiter.getAllMetrics();
      const status: Record<string, any> = {};

      for (const [provider, metrics] of allMetrics.entries()) {
        const queueStatus = this.rateLimiter.getQueueStatus(provider);
        status[provider] = {
          performance: {
            totalRequests: metrics.totalRequests,
            successRate: metrics.totalRequests > 0
              ? `${((metrics.successfulRequests / metrics.totalRequests) * 100).toFixed(2)}%`
              : '0%',
            requestsPerMinute: metrics.requestsPerMinute.toFixed(1),
            retriedRequests: metrics.retriedRequests,
            averageRetries: metrics.retriedRequests > 0
              ? (metrics.totalRetries / metrics.retriedRequests).toFixed(1)
              : '0',
          },
          latency: {
            average: `${metrics.averageLatency.toFixed(0)}ms`,
            p50: `${metrics.latencyPercentiles.p50}ms`,
            p95: `${metrics.latencyPercentiles.p95}ms`,
            p99: `${metrics.latencyPercentiles.p99}ms`,
            max: `${metrics.latencyPercentiles.max}ms`,
          },
          errors: {
            total: metrics.failedRequests,
            byCategory: metrics.errorsByCategory,
            circuitBreakerTrips: metrics.circuitBreakerActivations,
          },
          queue: {
            current: queueStatus || { queueLength: 0, processing: false },
            averageLength: metrics.queueMetrics.averageQueueLength.toFixed(1),
            maxLength: metrics.queueMetrics.maxQueueLength,
            averageWaitTime: metrics.totalRequests > 0
              ? `${(metrics.queueMetrics.totalTimeInQueue / metrics.totalRequests).toFixed(0)}ms`
              : '0ms',
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
            text: JSON.stringify({
              success: true,
              timestamp: new Date().toISOString(),
              providers: status,
            }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error: error.message,
            }, null, 2),
          },
        ],
        isError: true,
      };
    }
  }

  // ===== PACKAGE DEBUGGER HANDLERS =====

  private async handlePackageDiagnose(args: any) {
    try {
      const result = await this.packageDiagnose.diagnose(args);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error: error.message,
            }, null, 2),
          },
        ],
        isError: true,
      };
    }
  }

  private async handlePackageDownload(args: any) {
    try {
      const result = await this.packageDownload.download(args);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error: error.message,
            }, null, 2),
          },
        ],
        isError: true,
      };
    }
  }

  private async handlePackageConfigure(args: any) {
    try {
      const result = await this.packageConfigure.configure(args);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              error: error.message,
            }, null, 2),
          },
        ],
        isError: true,
      };
    }
  }

  private async readApiDocs() {
    const docs = `# SecureLLM Bridge API Documentation

## Provider Testing
Test provider connectivity with sample queries.

## Security Auditing
Run security checks on configuration files to identify potential issues.

## Rate Limiting
Check current rate limit status for each provider.

## Build & Test
Build the project and run test suites.

## Configuration Validation
Validate provider configuration format and completeness.

## TLS Key Generation
Generate server and client TLS certificates for secure communication.
`;

    return {
      contents: [
        {
          uri: "docs://api",
          mimeType: "text/markdown",
          text: docs,
        },
      ],
    };
  }

  // ===== EMERGENCY FRAMEWORK HANDLERS =====

  private async handleEmergencyStatus() {
    try {
      const result = await handleEmergencyStatus();
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: error.message }, null, 2) }],
        isError: true
      };
    }
  }

  private async handleEmergencyAbort(args: any) {
    try {
      const result = await handleEmergencyAbort(args.force || false);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: error.message }, null, 2) }],
        isError: true
      };
    }
  }

  private async handleEmergencyCooldown() {
    try {
      const result = await handleEmergencyCooldown();
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: error.message }, null, 2) }],
        isError: true
      };
    }
  }

  private async handleEmergencyNuke(args: any) {
    try {
      const result = await handleEmergencyNuke(args.confirm || false);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: error.message }, null, 2) }],
        isError: true
      };
    }
  }

  private async handleEmergencySwap() {
    try {
      const result = await handleEmergencySwap();
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: error.message }, null, 2) }],
        isError: true
      };
    }
  }

  private async handleSystemHealthCheck(args: any) {
    try {
      const result = await handleSystemHealthCheck(args.detailed || false);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: error.message }, null, 2) }],
        isError: true
      };
    }
  }

  private async handleSafeRebuildCheck() {
    try {
      const result = await handleSafeRebuildCheck();
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: error.message }, null, 2) }],
        isError: true
      };
    }
  }

  // ===== LAPTOP DEFENSE HANDLERS =====

  private async handleThermalCheck(args: any) {
    try {
      const result = await handleThermalCheck(args.max_temp || 75);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: error.message }, null, 2) }],
        isError: true
      };
    }
  }

  private async handleRebuildSafetyCheck() {
    try {
      const result = await handleRebuildSafetyCheck();
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: error.message }, null, 2) }],
        isError: true
      };
    }
  }

  private async handleThermalForensics(args: any) {
    try {
      const result = await handleThermalForensics(args.duration || 180, args.skip_rebuild || false);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: error.message }, null, 2) }],
        isError: true
      };
    }
  }

  private async handleThermalWarroom(args: any) {
    try {
      const result = await handleThermalWarroom(args.duration || 60);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: error.message }, null, 2) }],
        isError: true
      };
    }
  }

  private async handleLaptopVerdict(args: any) {
    try {
      const result = await handleLaptopVerdict(args.evidence_dir);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: error.message }, null, 2) }],
        isError: true
      };
    }
  }

  private async handleFullInvestigation() {
    try {
      const result = await handleFullInvestigation();
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: error.message }, null, 2) }],
        isError: true
      };
    }
  }

  private async handleForceCooldown() {
    try {
      const result = await handleForceCooldown();
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: error.message }, null, 2) }],
        isError: true
      };
    }
  }

  private async handleResetPerformance() {
    try {
      const result = await handleResetPerformance();
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: error.message }, null, 2) }],
        isError: true
      };
    }
  }

  // ===== WEB SEARCH HANDLERS =====

  private async handleWebSearch(args: any) {
    try {
      const result = await handleWebSearch(args);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: error.message }, null, 2) }],
        isError: true
      };
    }
  }

  private async handleNixSearch(args: any) {
    try {
      const result = await handleNixSearch(args);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: error.message }, null, 2) }],
        isError: true
      };
    }
  }

  private async handleGithubSearch(args: any) {
    try {
      const result = await handleGithubSearch(args);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: error.message }, null, 2) }],
        isError: true
      };
    }
  }

  private async handleTechNewsSearch(args: any) {
    try {
      const result = await handleTechNewsSearch(args);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: error.message }, null, 2) }],
        isError: true
      };
    }
  }

  private async handleDiscourseSearch(args: any) {
    try {
      const result = await handleDiscourseSearch(args);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: error.message }, null, 2) }],
        isError: true
      };
    }
  }

  private async handleStackOverflowSearch(args: any) {
    try {
      const result = await handleStackOverflowSearch(args);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: error.message }, null, 2) }],
        isError: true
      };
    }
  }

  async run() {
    const transport = new StdioServerTransport();

    // Start optional Prometheus metrics HTTP server
    const metricsPort = process.env.METRICS_PORT;
    if (metricsPort) {
      try {
        const http = await import('http');
        http.createServer((req, res) => {
          if (req.url === '/metrics') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end(this.rateLimiter.getAggregatePrometheusMetrics());
          } else {
            res.writeHead(404);
            res.end();
          }
        }).listen(parseInt(metricsPort, 10), '127.0.0.1', () => {
          logger.info({ port: metricsPort }, "Prometheus metrics server running");
        });
      } catch (err) {
        logger.error({ err }, "Failed to start metrics server");
      }
    }

    await this.server.connect(transport);
    logger.info({ transport: "stdio" }, "SecureLLM Bridge MCP server running");
  }
}

// Main entry point
async function main() {
  const server = new SecureLLMBridgeMCPServer();

  try {
    // Initialize async resources (project root, hostname, knowledge DB)
    await server.initialize();

    // Start MCP server
    await server.run();
  } catch (error) {
    // Use startup logger for fatal errors during initialization (before MCP connection)
    logStartupError("Failed to start MCP server", error as Error);
    process.exit(1);
  }
}

main();
