import { knowledgeTools } from "../tools/knowledge.js";
import type { KnowledgeDatabase } from "../types/knowledge.js";
import type { ExtendedTool } from "../types/mcp-tool-extensions.js";
import { emergencyTools } from "../tools/emergency/index.js";
import { laptopDefenseTools } from "../tools/laptop-defense/index.js";
import { webSearchTools } from "../tools/web-search.js";
import { researchAgentTool } from "../tools/research-agent.js";
import { analyzeComplexitySchema, findDeadCodeSchema } from "../tools/codebase-analysis.js";
import { advancedCodeAnalysisTool } from "../tools/advanced-code-analysis.js";
import { socketDebugReportTool } from "../tools/socket-debug-report.js";
import { zodToMcpSchema } from "../utils/schema-converter.js";
import { devTools } from "../tools/dev-tools.js";
import { professionalTools } from "../tools/professional-tools.js";
import {
  sshExecuteSchema,
  sshFileTransferSchema,
  sshMaintenanceCheckSchema,
  sshTunnelSchema,
  sshJumpHostSchema,
  sshSessionSchema,
} from "../tools/ssh/index.js";
import { executeInSandboxTool } from "../tools/secure-execution.js";
import {
  browserLaunchAdvancedSchema,
  browserExtractDataSchema,
  browserInteractFormSchema,
  browserMonitorChangesSchema,
  browserSearchAggregateSchema,
} from "../tools/browser/index.js";
import { adrTools } from "../tools/adr/index.js";
import { sessionBridgeTool } from "../tools/session-bridge.js";
import { nvimContextTool } from "../tools/nvim-context.js";
import { nixDaemonTool } from "../tools/nix-daemon.js";
import { gitSherlockTool } from "../tools/git-sherlock.js";
import { notifyHookTool } from "../tools/notify-hook.js";
import { metaToolTool } from "../tools/meta-tool.js";
import { linuxDebuggingTools } from "../tools/linux-debugging.js";
import { docTools } from "../tools/doc-tools.js";
import { interopTools } from "../tools/interop-tools.js";
import { ecosystemTools } from "../tools/ecosystem-tools.js";
import { umbrellaTools } from "../tools/umbrella-tools.js";

export function buildToolCatalog(
  db: KnowledgeDatabase | null,
  enableKnowledge: boolean
): ExtendedTool[] {
  return [
    {
      name: "server_status",
      description: "Get current MCP server status, feature flags, and runtime health",
      defer_loading: true,
      inputSchema: {
        type: "object",
        properties: {
          include_metrics: {
            type: "boolean",
            description: "Include per-tool metrics and queue state",
            default: true,
          },
        },
      },
    },
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
          provider: { type: "string", description: "Provider name" },
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
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "cache_stats",
      description: "Get cache statistics (Semantic Cache, Nix Package Cache)",
      defer_loading: true,
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "package_diagnose",
      description: "Diagnose package configuration issues",
      defer_loading: true,
      inputSchema: {
        type: "object",
        properties: {
          package_path: { type: "string", description: "Path to the package .nix file" },
          package_type: { type: "string", enum: ["tar", "deb", "js"] },
          build_test: { type: "boolean", default: true },
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
          package_name: { type: "string" },
          package_type: { type: "string", enum: ["tar", "deb", "js"] },
          source: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["github_release", "npm", "url"] },
              url: { type: "string" },
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
          package_name: { type: "string" },
          package_type: { type: "string", enum: ["tar", "deb", "js"] },
          storage_file: { type: "string" },
          sha256: { type: "string" },
          options: {
            type: "object",
            properties: {
              method: { type: "string", enum: ["auto", "native", "fhs"] },
              sandbox: { type: "boolean" },
              audit: { type: "boolean" },
              executable: { type: "string" },
              npm_flags: { type: "array", items: { type: "string" } },
            },
          },
        },
        required: ["package_name", "package_type", "storage_file", "sha256"],
      },
    },
    ...(enableKnowledge && db ? knowledgeTools : []),
    ...emergencyTools,
    ...laptopDefenseTools,
    ...webSearchTools,
    researchAgentTool,
    ...adrTools,
    {
      name: "analyze_complexity",
      description: "Analyze code complexity and file size statistics",
      defer_loading: true,
      inputSchema: zodToMcpSchema(analyzeComplexitySchema),
    },
    {
      name: "find_dead_code",
      description: "Heuristic search for unused exports (potentially dead code)",
      defer_loading: true,
      inputSchema: zodToMcpSchema(findDeadCodeSchema),
    },
    advancedCodeAnalysisTool,
    socketDebugReportTool,
    executeInSandboxTool,
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
    ...devTools,
    ...professionalTools,
    browserLaunchAdvancedSchema,
    browserExtractDataSchema,
    browserInteractFormSchema,
    browserMonitorChangesSchema,
    browserSearchAggregateSchema,
    sessionBridgeTool,
    nvimContextTool,
    nixDaemonTool,
    gitSherlockTool,
    notifyHookTool,
    metaToolTool,
    ...linuxDebuggingTools,
    ...docTools,
    ...interopTools,
    ...ecosystemTools,
    ...umbrellaTools,
  ] as ExtendedTool[]; // end buildToolCatalog
}
