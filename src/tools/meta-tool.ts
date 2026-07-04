/**
 * Meta Tool — ADR-0007
 *
 * Declarative tool composition pipeline engine.
 * Chain multiple tool calls server-side, passing outputs between them.
 *
 * Features:
 *   - Sequential and parallel execution
 *   - Variable references ($alias.field.subfield)
 *   - Flow control: on_failure (stop/skip/continue)
 *   - Timeout per step and global
 *   - Result consolidation
 *
 * Example pipeline:
 *   [{ tool: "workspace_quality_gate", args: { profile: "quick" }, output_as: "q" },
 *    { tool: "git_sherlock", args: { action: "review_uncommitted" }, output_as: "g" },
 *    { tool: "notify_hook", args: { message: "Quality: $q.status | Files: $g.categories" } }]
 */

import { z } from "zod";
import type { ExtendedTool } from "../types/mcp-tool-extensions.js";

// ─── Schema ──────────────────────────────────────────────────────────────────

const pipelineStepSchema = z.object({
  tool: z.string().describe("Tool name to execute"),
  args: z
    .record(z.any())
    .optional()
    .default({})
    .describe("Arguments (can reference previous outputs with $prefix.field)"),
  output_as: z.string().optional().describe("Alias to reference this step's output later"),
  on_failure: z.enum(["stop", "skip", "continue"]).optional().default("stop"),
  timeout_ms: z.number().int().min(500).max(120000).optional().default(30000),
  condition: z.string().optional().describe("Execute only if: '$previous.success === true'"),
});

const metaToolSchema = z.object({
  pipeline: z
    .array(pipelineStepSchema)
    .min(1)
    .max(20)
    .describe("Sequence of tool calls to execute"),
  parallel: z
    .boolean()
    .optional()
    .default(false)
    .describe("Execute independent steps in parallel (steps must not reference each other)"),
  stop_on_first_failure: z.boolean().optional().default(true),
  max_total_timeout_ms: z.number().int().min(1000).max(600000).optional().default(120000),
});

// ─── Tool definition ──────────────────────────────────────────────────────────

export const metaToolTool: ExtendedTool = {
  name: "meta_tool",
  description:
    "Declarative tool composition pipeline: chain up to 20 tool calls server-side with variable references, flow control, and parallel execution. Results consolidated into a single response (ADR-0007).",
  defer_loading: true,
  inputSchema: {
    type: "object",
    properties: {
      pipeline: {
        type: "array",
        items: {
          type: "object",
          properties: {
            tool: { type: "string", description: "Tool name" },
            args: { type: "object", description: "Arguments ($prefix.field for references)" },
            output_as: { type: "string", description: "Reference alias" },
            on_failure: { type: "string", enum: ["stop", "skip", "continue"] },
            timeout_ms: { type: "number", description: "Per-step timeout" },
            condition: { type: "string", description: "Conditional execution" },
          },
          required: ["tool"],
        },
        description: "Sequence of tool calls",
      },
      parallel: { type: "boolean", description: "Execute independent steps in parallel" },
      stop_on_first_failure: { type: "boolean", description: "Stop pipeline on first failure" },
      max_total_timeout_ms: { type: "number", description: "Global timeout" },
    },
    required: ["pipeline"],
  },
};

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleMetaTool(
  args: z.infer<typeof metaToolSchema>,
  executeTool: (name: string, toolArgs: any) => Promise<any>
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const {
    pipeline,
    parallel = false,
    stop_on_first_failure = true,
    max_total_timeout_ms = 120000,
  } = args;

  const outputs: Record<string, any> = {};
  const results: any[] = [];
  const startTime = Date.now();

  try {
    if (parallel) {
      // Execute independent steps in parallel
      const parallelResults = await Promise.allSettled(
        pipeline.map(async (step) => {
          const resolvedArgs = resolveReferences(step.args || {}, outputs);
          const result = await executeWithTimeout(
            () => executeTool(step.tool, resolvedArgs),
            step.timeout_ms || 30000
          );
          return { step, result };
        })
      );

      for (let i = 0; i < pipeline.length; i++) {
        const step = pipeline[i];
        const settled = parallelResults[i];

        if (settled.status === "fulfilled") {
          if (step.output_as) outputs[step.output_as] = settled.value;
          results.push({
            step: step.tool,
            output_as: step.output_as,
            success: true,
            result: settled.value,
          });
        } else {
          results.push({
            step: step.tool,
            output_as: step.output_as,
            success: false,
            error: String(settled.reason),
          });
          if (step.on_failure === "stop" || stop_on_first_failure) break;
        }
      }
    } else {
      // Sequential execution
      for (const step of pipeline) {
        // Check global timeout
        if (Date.now() - startTime > max_total_timeout_ms) {
          results.push({ step: step.tool, success: false, error: "Global timeout exceeded" });
          break;
        }

        // Check condition
        if (step.condition) {
          try {
            const condResult = resolveExpression(step.condition, outputs);
            if (!condResult) {
              results.push({
                step: step.tool,
                success: false,
                error: `Condition not met: ${step.condition}`,
                skipped: true,
              });
              if (step.on_failure === "skip") continue;
              if (step.on_failure === "stop") break;
              continue;
            }
          } catch {
            results.push({
              step: step.tool,
              success: false,
              error: `Invalid condition: ${step.condition}`,
            });
            if (step.on_failure === "stop") break;
            continue;
          }
        }

        // Resolve variable references in args
        const resolvedArgs = resolveReferences(step.args || {}, outputs);

        try {
          const result = await executeWithTimeout(
            () => executeTool(step.tool, resolvedArgs),
            step.timeout_ms || 30000
          );

          if (step.output_as) outputs[step.output_as] = result;
          results.push({
            step: step.tool,
            output_as: step.output_as,
            success: true,
            result: summarizeResult(result),
          });
        } catch (err: any) {
          results.push({
            step: step.tool,
            output_as: step.output_as,
            success: false,
            error: err.message,
          });

          if (
            step.on_failure === "stop" ||
            (step.on_failure !== "skip" && step.on_failure !== "continue" && stop_on_first_failure)
          ) {
            break;
          }
          // on_failure = skip or continue: keep going
        }
      }
    }

    const totalMs = Date.now() - startTime;
    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success && !r.skipped).length;
    const skipped = results.filter((r) => r.skipped).length;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              pipeline_status: failed === 0 ? "success" : "partial_failure",
              total_steps: pipeline.length,
              executed: succeeded + failed,
              succeeded,
              failed,
              skipped,
              duration_ms: totalMs,
              outputs: Object.keys(outputs),
              results,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (err: any) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              pipeline_status: "error",
              error: err.message,
              duration_ms: Date.now() - startTime,
            },
            null,
            2
          ),
        },
      ],
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveReferences(obj: any, outputs: Record<string, any>): any {
  if (typeof obj === "string") {
    return resolveStringReferences(obj, outputs);
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => resolveReferences(item, outputs));
  }
  if (typeof obj === "object" && obj !== null) {
    const resolved: any = {};
    for (const [key, value] of Object.entries(obj)) {
      resolved[key] = resolveReferences(value, outputs);
    }
    return resolved;
  }
  return obj;
}

function resolveStringReferences(str: string, outputs: Record<string, any>): any {
  // Match $alias.field.subfield patterns
  const refPattern = /\$([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)/g;

  // If the entire string is a single reference, return the raw value
  const trimmed = str.trim();
  if (/^\$[a-zA-Z_]/.test(trimmed) && !/\s/.test(trimmed)) {
    const match = trimmed.match(refPattern);
    if (match && match[0] === trimmed) {
      try {
        return resolveExpression(trimmed, outputs);
      } catch {
        return str; // fallback to string
      }
    }
  }

  // Otherwise, interpolate references into the string
  return str.replace(refPattern, (_, path: string) => {
    try {
      const val = resolveExpression("$" + path, outputs);
      return typeof val === "string" ? val : JSON.stringify(val);
    } catch {
      return "$" + path;
    }
  });
}

function resolveExpression(expr: string, outputs: Record<string, any>): any {
  // Simple variable resolution: $alias.field.subfield
  if (expr.startsWith("$")) {
    const path = expr.slice(1).split(".");
    let current: any = outputs;

    for (const segment of path) {
      if (current === null || current === undefined) {
        throw new Error(`Cannot resolve '${expr}': '${segment}' not found`);
      }

      // Try to parse JSON if the value is a string
      if (typeof current === "string") {
        try {
          current = JSON.parse(current);
        } catch {
          /* not JSON */
        }
      }

      if (typeof current === "object" && segment in current) {
        current = current[segment];
      } else {
        throw new Error(
          `Cannot resolve '${expr}': '${segment}' not found in ${JSON.stringify(Object.keys(current))}`
        );
      }
    }

    // Resolve nested string values
    if (typeof current === "string") {
      return resolveStringReferences(current, outputs);
    }

    return current;
  }

  // Boolean expressions like "$previous.success === true"
  if (expr.includes("===")) {
    const [left, right] = expr.split("===").map((s) => s.trim());
    return resolveExpression(left, outputs) === JSON.parse(right);
  }
  if (expr.includes("!==")) {
    const [left, right] = expr.split("!==").map((s) => s.trim());
    return resolveExpression(left, outputs) !== JSON.parse(right);
  }

  return expr;
}

async function executeWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);
    fn()
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function summarizeResult(result: any): any {
  // If result follows MCP content format, extract text
  if (result?.content && Array.isArray(result.content)) {
    const texts = result.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");

    // Try parse as JSON for structured access
    try {
      return JSON.parse(texts);
    } catch {
      return texts.length > 500 ? texts.slice(0, 500) + "..." : texts;
    }
  }
  return result;
}
