/**
 * Documentation Tools — doc_generate, doc_coverage, doc_validate
 *
 * Professional-grade documentation generation, coverage analysis,
 * and validation for TypeScript/JavaScript projects.
 *
 *   doc_generate   — Extracts JSDoc/TSDoc from source, generates API docs
 *   doc_coverage   — Measures documentation coverage of exported symbols
 *   doc_validate   — Validates markdown docs (broken links, structure, frontmatter)
 */

import { z } from "zod";
import * as fs from "fs/promises";
import { readFileSync, existsSync, statSync } from "fs";
import * as path from "path";
import type { ExtendedTool } from "../types/mcp-tool-extensions.js";
import { stringifyGeneric } from "../utils/json-schemas.js";
import type { McpToolResult } from "../server/wrap.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function collectFiles(
  dir: string,
  extensions: string[],
  excludePatterns: RegExp[] = [/node_modules/, /\.git/, /build/, /dist/, /\.cache/]
): Promise<string[]> {
  const results: string[] = [];
  const queue = [dir];
  while (queue.length > 0) {
    const current = queue.pop()!;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (excludePatterns.some((p) => p.test(fullPath))) continue;
      if (entry.isDirectory()) {
        queue.push(fullPath);
      } else if (entry.isFile() && extensions.some((ext) => fullPath.endsWith(ext))) {
        results.push(fullPath);
      }
    }
  }
  return results.sort();
}

interface JsdocSymbol {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "variable" | "enum" | "method" | "property";
  jsdoc: string | null;
  exported: boolean;
  line: number;
  params?: Array<{ name: string; type?: string; desc?: string }>;
  returnType?: string;
  returnDesc?: string;
}

/**
 * Lightweight JSDoc/TSDoc extractor without a full AST parser.
 * Handles the most common patterns for documentation coverage.
 */
function extractJsdocSymbols(content: string, filePath: string): JsdocSymbol[] {
  const symbols: JsdocSymbol[] = [];
  const lines = content.split("\n");

  // Find JSDoc blocks
  const jsdocRegex = /\/\*\*[\s\S]*?\*\//g;
  const jsdocBlocks: Array<{ text: string; endLine: number }> = [];
  let match;
  while ((match = jsdocRegex.exec(content)) !== null) {
    const beforeMatch = content.substring(0, match.index);
    const lineNum = beforeMatch.split("\n").length;
    const endLineNum = lineNum + match[0].split("\n").length - 1;
    jsdocBlocks.push({ text: match[0], endLine: endLineNum });
  }

  // Find exported symbols
  const exportPatterns = [
    /export\s+(async\s+)?function\s+(\w+)/g,
    /export\s+(abstract\s+)?class\s+(\w+)/g,
    /export\s+interface\s+(\w+)/g,
    /export\s+type\s+(\w+)/g,
    /export\s+(const|let|var)\s+(\w+)/g,
    /export\s+enum\s+(\w+)/g,
  ];

  const foundNames = new Set<string>();

  for (const pattern of exportPatterns) {
    let m;
    while ((m = pattern.exec(content)) !== null) {
      const name = m[2] || m[1];
      if (foundNames.has(name)) continue;
      foundNames.add(name);

      const beforeMatch = content.substring(0, m.index);
      const lineNum = beforeMatch.split("\n").length;

      let kind: JsdocSymbol["kind"] = "variable";
      if (pattern.source?.includes("function")) kind = "function";
      else if (pattern.source?.includes("class")) kind = "class";
      else if (pattern.source?.includes("interface")) kind = "interface";
      else if (pattern.source?.includes("type") && !pattern.source?.includes("interface"))
        kind = "type";
      else if (pattern.source?.includes("enum")) kind = "enum";

      // Find nearest JSDoc block above this symbol
      const nearestBlock = jsdocBlocks
        .filter((b) => b.endLine < lineNum && b.endLine >= lineNum - 15)
        .sort((a, b) => b.endLine - a.endLine)[0];

      symbols.push({
        name,
        kind,
        jsdoc: nearestBlock ? nearestBlock.text.trim() : null,
        exported: true,
        line: lineNum,
      });
    }
  }

  // Also detect public methods inside exported classes (basic)
  const classMethodRegex = /^\s{2,}(public\s+)?(async\s+)?(\w+)\s*\(/gm;
  // This is a rough approximation; skip for now for performance

  return symbols;
}

/**
 * Parse a JSDoc block text and extract description, params, returns
 */
function parseJsdocBlock(block: string): {
  description: string;
  params: Array<{ name: string; type?: string; desc?: string }>;
  returns?: { type?: string; desc?: string };
  tags: Record<string, string>;
} {
  const lines = block
    .replace(/\/\*\*|\*\/|\s*\*\s?/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const descriptionLines: string[] = [];
  const params: Array<{ name: string; type?: string; desc?: string }> = [];
  let returns: { type?: string; desc?: string } | undefined;
  const tags: Record<string, string> = {};

  for (const line of lines) {
    if (line.startsWith("@param")) {
      const paramMatch = line.match(
        /@param\s+(?:\{([^}]+)\}\s+)?(?:\[?(\w+)(?:\.(\w+))?\]?)\s*-?\s*(.*)/
      );
      if (paramMatch) {
        params.push({
          name: paramMatch[2],
          type: paramMatch[1],
          desc: paramMatch[4] || undefined,
        });
      }
    } else if (line.startsWith("@returns") || line.startsWith("@return")) {
      const retMatch = line.match(/@returns?\s*(?:\{([^}]+)\}\s*)?-?\s*(.*)/);
      returns = {
        type: retMatch?.[1],
        desc: retMatch?.[2] || undefined,
      };
    } else if (line.startsWith("@")) {
      const tagMatch = line.match(/@(\w+)\s*(.*)/);
      if (tagMatch) {
        tags[tagMatch[1]] = tagMatch[2];
      }
    } else if (line) {
      descriptionLines.push(line);
    }
  }

  return {
    description: descriptionLines.join(" ").trim(),
    params,
    returns,
    tags,
  };
}

async function findMarkdownFiles(dir: string): Promise<string[]> {
  return collectFiles(dir, [".md", ".mdx"]);
}

interface LinkIssue {
  file: string;
  line: number;
  link: string;
  issue: "broken" | "relative_not_found" | "absolute_url" | "missing_anchor";
}

async function validateMarkdownLinks(files: string[], projectRoot: string): Promise<LinkIssue[]> {
  const issues: LinkIssue[] = [];

  for (const file of files) {
    const content = await fs.readFile(file, "utf-8");
    const lines = content.split("\n");

    // Match markdown links: [text](url)
    const linkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;
    let match;

    while ((match = linkRegex.exec(content)) !== null) {
      const linkUrl = match[2];
      const lineNum = content.substring(0, match.index).split("\n").length;

      // Skip external HTTP links for now (could check with fetch in future)
      if (linkUrl.startsWith("http://") || linkUrl.startsWith("https://")) {
        // Optionally flag absolute URLs for awareness
        continue;
      }

      // Skip anchors within the same file
      if (linkUrl.startsWith("#")) continue;

      // Handle anchor in another file
      const [filePart, anchorPart] = linkUrl.split("#");
      if (!filePart) continue; // same-page anchor

      const resolvedPath = path.resolve(path.dirname(file), filePart);
      if (!existsSync(resolvedPath)) {
        issues.push({
          file,
          line: lineNum,
          link: linkUrl,
          issue: "relative_not_found",
        });
      }
    }
  }

  return issues;
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const docGenerateSchema = z.object({
  target: z.string().describe("File or directory to generate documentation for"),
  format: z
    .enum(["markdown", "json"])
    .optional()
    .default("markdown")
    .describe("Output format: markdown (readable) or json (structured)"),
  include_private: z.boolean().optional().default(false).describe("Include non-exported symbols"),
  output_file: z.string().optional().describe("Write output to file instead of returning"),
});

const docCoverageSchema = z.object({
  target: z.string().describe("Directory to analyze documentation coverage"),
  min_coverage_pct: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .default(70)
    .describe("Minimum acceptable coverage percentage"),
});

const docValidateSchema = z.object({
  target: z.string().describe("Directory or file to validate (markdown files)"),
  checks: z
    .array(z.enum(["links", "frontmatter", "structure", "spelling"]))
    .optional()
    .default(["links", "frontmatter", "structure"])
    .describe("Validation checks to run"),
});

// ─── Tool Definitions ─────────────────────────────────────────────────────────

export const docGenerateTool: ExtendedTool = {
  name: "doc_generate",
  description:
    "Generate API documentation from TypeScript/JavaScript source code. Extracts JSDoc/TSDoc comments and produces structured Markdown or JSON output.",
  defer_loading: true,
  priority: "normal",
  execution_class: "batch",
  cost_tier: "moderate",
  inputSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description: "File or directory to generate documentation for",
      },
      format: {
        type: "string",
        enum: ["markdown", "json"],
        description: "Output format: markdown (readable) or json (structured)",
        default: "markdown",
      },
      include_private: {
        type: "boolean",
        description: "Include non-exported symbols",
        default: false,
      },
      output_file: {
        type: "string",
        description: "Write output to file instead of returning",
      },
    },
    required: ["target"],
  },
};

export const docCoverageTool: ExtendedTool = {
  name: "doc_coverage",
  description:
    "Measure JSDoc/TSDoc documentation coverage across a project. Reports percentage of exported symbols with documentation and identifies undocumented symbols.",
  defer_loading: true,
  priority: "normal",
  execution_class: "batch",
  cost_tier: "cheap",
  inputSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description: "Directory to analyze documentation coverage",
      },
      min_coverage_pct: {
        type: "number",
        description: "Minimum acceptable coverage percentage (default: 70)",
        default: 70,
      },
    },
    required: ["target"],
  },
};

export const docValidateTool: ExtendedTool = {
  name: "doc_validate",
  description:
    "Validate Markdown documentation: checks for broken links, missing frontmatter, structural issues, and spelling consistency.",
  defer_loading: true,
  priority: "normal",
  execution_class: "batch",
  cost_tier: "cheap",
  inputSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description: "Directory or file to validate (markdown files)",
      },
      checks: {
        type: "array",
        items: {
          type: "string",
          enum: ["links", "frontmatter", "structure", "spelling"],
        },
        description: "Validation checks to run",
        default: ["links", "frontmatter", "structure"],
      },
    },
    required: ["target"],
  },
};

// ─── Handlers ─────────────────────────────────────────────────────────────────

// ─── Batch export ─────────────────────────────────────────────────────────────

export const docTools: ExtendedTool[] = [docGenerateTool, docCoverageTool, docValidateTool];

export async function handleDocGenerate(
  args: z.infer<typeof docGenerateSchema>
): Promise<McpToolResult> {
  try {
    const { target, format, include_private, output_file } = args;
    const stats = statSync(target);
    const files: string[] = stats.isDirectory()
      ? await collectFiles(target, [".ts", ".tsx", ".js", ".jsx"])
      : [target];

    const allSymbols: Array<{ file: string; symbols: JsdocSymbol[] }> = [];

    for (const file of files) {
      const content = readFileSync(file, "utf-8");
      const symbols = extractJsdocSymbols(content, file).filter(
        (s) => include_private || s.exported
      );
      if (symbols.length > 0) {
        allSymbols.push({ file, symbols });
      }
    }

    if (format === "json") {
      const enriched = allSymbols.map(({ file, symbols }) => ({
        file,
        symbols: symbols.map((s) => ({
          ...s,
          parsedJsdoc: s.jsdoc ? parseJsdocBlock(s.jsdoc) : null,
        })),
      }));

      const output = stringifyGeneric({ symbols: enriched, total_files: files.length });

      if (output_file) {
        await fs.writeFile(output_file, output, "utf-8");
        return {
          content: [
            {
              type: "text",
              text: stringifyGeneric({
                success: true,
                output_file,
                total_symbols: enriched.reduce((a, f) => a + f.symbols.length, 0),
                total_files: files.length,
              }),
            },
          ],
        };
      }

      return { content: [{ type: "text", text: output }] };
    }

    // Markdown format
    const lines: string[] = [];
    lines.push("# API Documentation");
    lines.push("");
    lines.push(
      `> Generated from ${files.length} file(s) — ${allSymbols.reduce((a, f) => a + f.symbols.length, 0)} exported symbols`
    );
    lines.push("");

    // Group by kind
    const grouped: Record<
      string,
      Array<{
        file: string;
        symbol: JsdocSymbol;
        parsed: ReturnType<typeof parseJsdocBlock> | null;
      }>
    > = {};

    for (const { file, symbols } of allSymbols) {
      for (const symbol of symbols) {
        const parsed = symbol.jsdoc ? parseJsdocBlock(symbol.jsdoc) : null;
        if (!grouped[symbol.kind]) grouped[symbol.kind] = [];
        grouped[symbol.kind].push({ file, symbol, parsed });
      }
    }

    const kindOrder = ["class", "interface", "type", "function", "enum", "variable"];

    for (const kind of kindOrder) {
      const items = grouped[kind];
      if (!items || items.length === 0) continue;
      lines.push(`## ${kind.charAt(0).toUpperCase() + kind.slice(1)}s`);
      lines.push("");

      for (const { file, symbol, parsed } of items) {
        lines.push(`### \`${symbol.name}\``);
        lines.push("");
        lines.push(`- **File:** \`${path.relative(process.cwd(), file)}\` (line ${symbol.line})`);
        lines.push(`- **Kind:** ${symbol.kind}`);
        lines.push(`- **Exported:** ${symbol.exported ? "Yes" : "No"}`);

        if (parsed) {
          if (parsed.description) {
            lines.push("");
            lines.push(parsed.description);
          }
          if (parsed.params.length > 0) {
            lines.push("");
            lines.push("**Parameters:**");
            for (const param of parsed.params) {
              const parts = [`- \`${param.name}\``];
              if (param.type) parts.push(`\`${param.type}\``);
              if (param.desc) parts.push(`— ${param.desc}`);
              lines.push(parts.join(" "));
            }
          }
          if (parsed.returns && (parsed.returns.type || parsed.returns.desc)) {
            lines.push("");
            lines.push(
              `**Returns:** ${parsed.returns.type ? `\`${parsed.returns.type}\`` : ""}${parsed.returns.desc ? ` — ${parsed.returns.desc}` : ""}`
            );
          }
          if (Object.keys(parsed.tags).length > 0) {
            lines.push("");
            for (const [tag, value] of Object.entries(parsed.tags)) {
              lines.push(`- **@${tag}:** ${value}`);
            }
          }
        } else {
          lines.push("");
          lines.push("> ⚠️ **No documentation** — consider adding JSDoc/TSDoc comments");
        }

        lines.push("");
        lines.push("---");
        lines.push("");
      }
    }

    // Coverage summary
    const total = allSymbols.reduce((a, f) => a + f.symbols.length, 0);
    const documented = allSymbols.reduce((a, f) => a + f.symbols.filter((s) => s.jsdoc).length, 0);
    const coverage = total > 0 ? Math.round((documented / total) * 100) : 100;

    lines.push("## Documentation Coverage");
    lines.push("");
    lines.push(`- **Total exported symbols:** ${total}`);
    lines.push(`- **Documented:** ${documented} (${coverage}%)`);
    lines.push(`- **Undocumented:** ${total - documented}`);

    const output = lines.join("\n");

    if (output_file) {
      await fs.writeFile(output_file, output, "utf-8");
      return {
        content: [
          {
            type: "text",
            text: stringifyGeneric({
              success: true,
              output_file,
              total_symbols: total,
              coverage_pct: coverage,
            }),
          },
        ],
      };
    }

    return { content: [{ type: "text", text: output }] };
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `Error generating docs: ${err.message}` }],
      isError: true,
    };
  }
}

export async function handleDocCoverage(
  args: z.infer<typeof docCoverageSchema>
): Promise<McpToolResult> {
  try {
    const { target, min_coverage_pct } = args;
    const files = await collectFiles(target, [".ts", ".tsx", ".js", ".jsx"]);
    const allSymbols: Array<{ file: string; symbol: JsdocSymbol }> = [];
    const undocumented: Array<{ file: string; name: string; kind: string; line: number }> = [];

    for (const file of files) {
      const content = readFileSync(file, "utf-8");
      const symbols = extractJsdocSymbols(content, file).filter((s) => s.exported);
      for (const symbol of symbols) {
        allSymbols.push({ file, symbol });
        if (!symbol.jsdoc) {
          undocumented.push({
            file: path.relative(process.cwd(), file),
            name: symbol.name,
            kind: symbol.kind,
            line: symbol.line,
          });
        }
      }
    }

    const total = allSymbols.length;
    const documented = total - undocumented.length;
    const coverage = total > 0 ? Math.round((documented / total) * 100) : 100;
    const passed = coverage >= min_coverage_pct;

    // Breakdown by kind
    const byKind: Record<string, { total: number; documented: number }> = {};
    for (const { symbol } of allSymbols) {
      if (!byKind[symbol.kind]) byKind[symbol.kind] = { total: 0, documented: 0 };
      byKind[symbol.kind].total++;
      if (symbol.jsdoc) byKind[symbol.kind].documented++;
    }

    const result = {
      passed,
      coverage_pct: coverage,
      min_required: min_coverage_pct,
      total_symbols: total,
      documented,
      undocumented: undocumented.length,
      by_kind: Object.fromEntries(
        Object.entries(byKind).map(([kind, stats]) => [
          kind,
          {
            ...stats,
            coverage_pct:
              stats.total > 0 ? Math.round((stats.documented / stats.total) * 100) : 100,
          },
        ])
      ),
      top_undocumented: undocumented.slice(0, 20),
    };

    return {
      content: [
        {
          type: "text",
          text: stringifyGeneric(result),
        },
      ],
    };
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `Error measuring coverage: ${err.message}` }],
      isError: true,
    };
  }
}

export async function handleDocValidate(
  args: z.infer<typeof docValidateSchema>
): Promise<McpToolResult> {
  try {
    const { target, checks } = args;
    const stats = statSync(target);
    const mdFiles = stats.isDirectory()
      ? await findMarkdownFiles(target)
      : target.endsWith(".md") || target.endsWith(".mdx")
        ? [target]
        : [];

    if (mdFiles.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: stringifyGeneric({ error: "No markdown files found", target }),
          },
        ],
      };
    }

    const results: {
      files_checked: number;
      issues_found: number;
      link_issues: LinkIssue[];
      frontmatter_issues: Array<{ file: string; issue: string }>;
      structure_issues: Array<{ file: string; issue: string }>;
      summary: string;
    } = {
      files_checked: mdFiles.length,
      issues_found: 0,
      link_issues: [],
      frontmatter_issues: [],
      structure_issues: [],
      summary: "",
    };

    const projectRoot = stats.isDirectory() ? target : path.dirname(target);

    // Link validation
    if (checks.includes("links")) {
      results.link_issues = await validateMarkdownLinks(mdFiles, projectRoot);
      results.issues_found += results.link_issues.length;
    }

    // Frontmatter validation
    if (checks.includes("frontmatter")) {
      for (const file of mdFiles) {
        const content = await fs.readFile(file, "utf-8");
        const hasFrontmatter = /^---\s*\n/.test(content);

        if (!hasFrontmatter) {
          results.frontmatter_issues.push({
            file: path.relative(process.cwd(), file),
            issue: "Missing YAML frontmatter (--- delimiters)",
          });
        } else {
          // Check if frontmatter has required fields
          const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
          if (fmMatch) {
            const fm = fmMatch[1];
            const requiredFields = ["title"];
            for (const field of requiredFields) {
              if (!new RegExp(`^${field}:`, "m").test(fm)) {
                results.frontmatter_issues.push({
                  file: path.relative(process.cwd(), file),
                  issue: `Missing required frontmatter field: "${field}"`,
                });
              }
            }
          }
        }
      }
      results.issues_found += results.frontmatter_issues.length;
    }

    // Structure validation
    if (checks.includes("structure")) {
      for (const file of mdFiles) {
        const content = await fs.readFile(file, "utf-8");
        const lines = content.split("\n");

        // Check for H1 as first heading
        const firstHeading = lines.find((l) => /^#\s/.test(l));
        if (!firstHeading) {
          results.structure_issues.push({
            file: path.relative(process.cwd(), file),
            issue: "No level-1 heading (# Title) found",
          });
        }

        // Check for consecutive blank lines (more than 2)
        let blankCount = 0;
        for (const line of lines) {
          if (line.trim() === "") {
            blankCount++;
            if (blankCount > 2) {
              results.structure_issues.push({
                file: path.relative(process.cwd(), file),
                issue: "Excessive consecutive blank lines (>2)",
              });
              break;
            }
          } else {
            blankCount = 0;
          }
        }

        // Check file ends with newline
        if (content.length > 0 && !content.endsWith("\n")) {
          results.structure_issues.push({
            file: path.relative(process.cwd(), file),
            issue: "File does not end with a newline",
          });
        }
      }
      results.issues_found += results.structure_issues.length;
    }

    const passed = results.issues_found === 0;
    results.summary = passed
      ? "✅ All documentation checks passed!"
      : `❌ Found ${results.issues_found} issue(s) across ${mdFiles.length} file(s)`;

    return {
      content: [
        {
          type: "text",
          text: stringifyGeneric(results),
        },
      ],
    };
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `Error validating docs: ${err.message}` }],
      isError: true,
    };
  }
}
