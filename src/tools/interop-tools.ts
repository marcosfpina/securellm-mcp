/**
 * Interoperability Tools — schema_convert, project_bridge, data_transform
 *
 * Cross-project and cross-format interoperability:
 *
 *   schema_convert   — Convert between API schema formats (JSON Schema, TypeScript, OpenAPI fragments)
 *   project_bridge   — Cross-project dependency analysis, version alignment, shared config
 *   data_transform   — Data format conversion (JSON ↔ YAML ↔ TOML ↔ CSV)
 */

import { z } from "zod";
import * as fs from "fs/promises";
import { readFileSync, existsSync, statSync } from "fs";
import * as path from "path";
import type { ExtendedTool } from "../types/mcp-tool-extensions.js";
import { stringifyGeneric } from "../utils/json-schemas.js";
import type { McpToolResult } from "../server/wrap.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Minimal YAML parser for common use cases.
 * Supports scalar values, lists, nested objects, and comments.
 */
function parseSimpleYaml(content: string): Record<string, any> {
  const lines = content.split("\n").filter((l) => !l.trim().startsWith("#") && l.trim() !== "");
  const result: Record<string, any> = {};

  let currentKey = "";
  let currentIndent = 0;
  const stack: Array<{ key: string; obj: any; indent: number }> = [];

  for (const line of lines) {
    const indent = line.search(/\S/);
    const trimmed = line.trim();

    // List item
    if (trimmed.startsWith("- ")) {
      const value = trimmed.slice(2).trim();
      const parsed = parseYamlValue(value);
      if (Array.isArray(result[currentKey])) {
        result[currentKey].push(parsed);
      }
      continue;
    }

    // Key-value pair
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();

    // Pop stack to correct indent level
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    if (value === "" || value === "|" || value === ">") {
      // Nested object or block scalar
      const parent = stack.length > 0 ? stack[stack.length - 1].obj : result;
      parent[key] = {};
      stack.push({ key, obj: parent[key], indent });
      currentKey = key;
      currentIndent = indent;
    } else {
      const parent = stack.length > 0 ? stack[stack.length - 1].obj : result;
      const parsedValue = parseYamlValue(value);

      // Handle inline arrays
      if (value.startsWith("[") && value.endsWith("]")) {
        parent[key] = value
          .slice(1, -1)
          .split(",")
          .map((v) => parseYamlValue(v.trim()));
      } else {
        parent[key] = parsedValue;
      }
      currentKey = key;
      currentIndent = indent;
    }
  }

  return result;
}

function parseYamlValue(value: string): any {
  if (value === "true" || value === "yes") return true;
  if (value === "false" || value === "no") return false;
  if (value === "null" || value === "~") return null;
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
  // Remove quotes
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function stringifyYaml(obj: any, indent = 0): string {
  const prefix = "  ".repeat(indent);
  if (obj === null || obj === undefined) return "null";
  if (typeof obj === "boolean") return obj ? "true" : "false";
  if (typeof obj === "number") return String(obj);
  if (typeof obj === "string") {
    if (obj.includes("\n") || obj.includes(":") || obj.includes("#") || obj.includes('"')) {
      return `"${obj.replace(/"/g, '\\"')}"`;
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    if (obj.length === 0) return "[]";
    return obj
      .map((item) => `${prefix}- ${stringifyYaml(item, indent + 1).replace(/^\s+/, "")}`)
      .join("\n");
  }
  if (typeof obj === "object") {
    const keys = Object.keys(obj);
    if (keys.length === 0) return "{}";
    return keys
      .map((key) => {
        const value = obj[key];
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          return `${prefix}${key}:\n${stringifyYaml(value, indent + 1)}`;
        }
        if (Array.isArray(value)) {
          if (value.length === 0) return `${prefix}${key}: []`;
          return `${prefix}${key}:\n${stringifyYaml(value, indent + 1)}`;
        }
        return `${prefix}${key}: ${stringifyYaml(value)}`;
      })
      .join("\n");
  }
  return String(obj);
}

/**
 * Minimal TOML parser for common use cases.
 */
function parseSimpleToml(content: string): Record<string, any> {
  const result: Record<string, any> = {};
  const lines = content.split("\n");
  let currentSection = result;
  let currentTable: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    // Table header: [section] or [[array]]
    if (trimmed.startsWith("[[")) {
      const tableName = trimmed.slice(2, -2).trim();
      if (!result[tableName]) result[tableName] = [];
      result[tableName].push({});
      currentTable = tableName;
      currentSection = result[tableName][result[tableName].length - 1];
    } else if (trimmed.startsWith("[")) {
      const tableName = trimmed.slice(1, -1).trim();
      const parts = tableName.split(".");
      currentSection = result;
      for (const part of parts) {
        if (!currentSection[part]) currentSection[part] = {};
        currentSection = currentSection[part];
      }
      currentTable = tableName;
    } else {
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      currentSection[key] = parseTomlValue(value);
    }
  }

  return result;
}

function parseTomlValue(value: string): any {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+\.\d+$/.test(value)) return parseFloat(value);
  if (/^-?\d+$/.test(value)) return parseInt(value, 10);
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n");
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((v) => parseTomlValue(v.trim()));
  }
  return value;
}

function stringifyToml(obj: any, prefix = ""): string {
  const lines: string[] = [];
  if (typeof obj !== "object" || obj === null) return String(obj);

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const section = prefix ? `${prefix}.${key}` : key;
      lines.push(`[${section}]`);
      for (const [k, v] of Object.entries(value)) {
        lines.push(`${k} = ${tomlValue(v)}`);
      }
      lines.push("");
    } else if (Array.isArray(value) && value.length > 0 && typeof value[0] === "object") {
      const section = prefix ? `${prefix}.${key}` : key;
      for (const item of value) {
        lines.push(`[[${section}]]`);
        for (const [k, v] of Object.entries(item)) {
          lines.push(`${k} = ${tomlValue(v)}`);
        }
        lines.push("");
      }
    } else {
      lines.push(`${key} = ${tomlValue(value)}`);
    }
  }
  return lines.join("\n").trim();
}

function tomlValue(value: any): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (value.includes('"') || value.includes("\n")) {
      return `"${value.replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
    }
    return `"${value}"`;
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => tomlValue(v)).join(", ")}]`;
  }
  return String(value);
}

/**
 * Minimal CSV parser (RFC 4180 simplified)
 */
function parseCsv(content: string): Array<Record<string, string>> {
  const lines = content.trim().split("\n");
  if (lines.length === 0) return [];

  const headers = parseCsvLine(lines[0]);
  const results: Array<Record<string, string>> = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] || "";
    });
    results.push(row);
  }

  return results;
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        result.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
  }
  result.push(current.trim());
  return result;
}

function stringifyCsv(rows: Array<Record<string, any>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const lines: string[] = [headers.join(",")];

  for (const row of rows) {
    const values = headers.map((h) => {
      const val = String(row[h] ?? "");
      if (val.includes(",") || val.includes('"') || val.includes("\n")) {
        return `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    });
    lines.push(values.join(","));
  }

  return lines.join("\n");
}

/**
 * Collect package.json files across projects
 */
async function collectPackageJsons(dir: string): Promise<Array<{ path: string; data: any }>> {
  const results: Array<{ path: string; data: any }> = [];
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
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === "build" ||
        entry.name === "dist"
      )
        continue;
      if (entry.isDirectory()) {
        queue.push(fullPath);
      } else if (entry.name === "package.json") {
        try {
          const content = JSON.parse(readFileSync(fullPath, "utf-8"));
          results.push({ path: fullPath, data: content });
        } catch {
          // skip invalid JSON
        }
      }
    }
  }
  return results;
}

/**
 * Convert JSON Schema to TypeScript interface (simplified)
 */
function jsonSchemaToTypescript(schema: any, name = "Generated"): string {
  if (!schema || typeof schema !== "object") return `type ${name} = unknown;`;

  const lines: string[] = [];

  function resolveType(prop: any, propName: string, indent = 0): string {
    const pad = "  ".repeat(indent);
    if (!prop || typeof prop !== "object") return "unknown";

    if (prop.enum) {
      return prop.enum.map((v: any) => (typeof v === "string" ? `"${v}"` : String(v))).join(" | ");
    }

    switch (prop.type) {
      case "string":
        return "string";
      case "number":
      case "integer":
        return "number";
      case "boolean":
        return "boolean";
      case "null":
        return "null";
      case "array":
        if (prop.items) {
          const itemType = resolveType(prop.items, `${propName}Item`, indent);
          return `${itemType}[]`;
        }
        return "unknown[]";
      case "object":
        if (prop.properties) {
          const inner: string[] = [];
          const required = new Set(prop.required || []);
          for (const [key, value] of Object.entries(prop.properties)) {
            const optional = required.has(key) ? "" : "?";
            const typeStr = resolveType(value as any, key, indent + 1);
            if ((value as any).description) {
              inner.push(`${pad}  /** ${(value as any).description} */`);
            }
            inner.push(`${pad}  ${key}${optional}: ${typeStr};`);
          }
          return `{\n${inner.join("\n")}\n${pad}}`;
        }
        return "Record<string, unknown>";
      default:
        if (prop.$ref) {
          const refName = prop.$ref.split("/").pop()!;
          return refName;
        }
        if (prop.oneOf) {
          return (prop.oneOf as any[]).map((o) => resolveType(o, propName, indent)).join(" | ");
        }
        if (prop.allOf) {
          return (prop.allOf as any[]).map((o) => resolveType(o, propName, indent)).join(" & ");
        }
        return "unknown";
    }
  }

  if (schema.type === "object" && schema.properties) {
    const required = new Set(schema.required || []);
    lines.push(`interface ${name} {`);
    for (const [key, value] of Object.entries(schema.properties)) {
      const optional = required.has(key) ? "" : "?";
      if ((value as any).description) {
        lines.push(`  /** ${(value as any).description} */`);
      }
      lines.push(`  ${key}${optional}: ${resolveType(value as any, key, 1)};`);
    }
    lines.push("}");
  } else {
    lines.push(`type ${name} = ${resolveType(schema, name)};`);
  }

  return lines.join("\n");
}

/**
 * Convert TypeScript interface text to JSON Schema (simplified)
 */
function typescriptToJsonSchema(tsCode: string): any {
  const schema: any = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {},
  };

  // Match interface blocks
  const interfaceMatch = tsCode.match(/(?:export\s+)?interface\s+(\w+)\s*\{([^}]*)\}/s);
  if (!interfaceMatch) return schema;

  const body = interfaceMatch[2];
  const propRegex = /\/\*\*?\s*([\s\S]*?)\*\/\s*(\w+)(\?)?:\s*([^;\n]+)/g;
  let match;

  while ((match = propRegex.exec(body)) !== null) {
    const description = match[1]?.replace(/\s*\*\s?/g, " ").trim();
    const key = match[2];
    const optional = !!match[3];
    const typeStr = match[4].trim();

    const prop: any = {};
    if (description) prop.description = description;

    // Map TypeScript types to JSON Schema
    if (typeStr === "string") prop.type = "string";
    else if (typeStr === "number") prop.type = "number";
    else if (typeStr === "boolean") prop.type = "boolean";
    else if (typeStr.endsWith("[]")) prop.type = "array";
    else if (typeStr.startsWith("Record<")) prop.type = "object";
    else if (typeStr.includes("|")) {
      const options = typeStr.split("|").map((t) => t.trim());
      prop.enum = options
        .filter((o) => o.startsWith('"') || o.startsWith("'"))
        .map((o) => o.replace(/['"]/g, ""));
    } else {
      prop.type = "string"; // default for unknown types
    }

    schema.properties[key] = prop;
    if (!optional) {
      schema.required = schema.required || [];
      schema.required.push(key);
    }
  }

  return schema;
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const schemaConvertSchema = z.object({
  source: z.string().describe("Source schema text or file path"),
  from: z.enum(["json_schema", "typescript", "openapi_fragment"]).describe("Source format"),
  to: z.enum(["json_schema", "typescript", "openapi_fragment"]).describe("Target format"),
  name: z
    .string()
    .optional()
    .default("Generated")
    .describe("Name for the generated type/interface"),
  input_is_file: z
    .boolean()
    .optional()
    .default(false)
    .describe("Treat source as file path instead of inline text"),
});

const projectBridgeSchema = z.object({
  projects: z.array(z.string()).describe("List of project directories to analyze"),
  action: z
    .enum(["analyze", "diff_deps", "shared_config", "sync_versions"])
    .describe("Bridge action to perform"),
  output_file: z.string().optional().describe("Write report to file"),
});

const dataTransformSchema = z.object({
  source: z.string().describe("Source data or file path"),
  input_format: z.enum(["json", "yaml", "toml", "csv"]).describe("Input data format"),
  output_format: z.enum(["json", "yaml", "toml", "csv"]).describe("Desired output format"),
  input_is_file: z
    .boolean()
    .optional()
    .default(false)
    .describe("Treat source as file path instead of inline data"),
  output_file: z.string().optional().describe("Write transformed output to file"),
  pretty: z.boolean().optional().default(true).describe("Pretty-print output"),
});

// ─── Tool Definitions ─────────────────────────────────────────────────────────

export const schemaConvertTool: ExtendedTool = {
  name: "schema_convert",
  description:
    "Convert between API schema formats: JSON Schema ↔ TypeScript interfaces ↔ OpenAPI fragments. Supports both inline text and file inputs.",
  defer_loading: true,
  priority: "normal",
  execution_class: "interactive",
  cost_tier: "cheap",
  inputSchema: {
    type: "object",
    properties: {
      source: {
        type: "string",
        description: "Source schema text or file path",
      },
      from: {
        type: "string",
        enum: ["json_schema", "typescript", "openapi_fragment"],
        description: "Source format",
      },
      to: {
        type: "string",
        enum: ["json_schema", "typescript", "openapi_fragment"],
        description: "Target format",
      },
      name: {
        type: "string",
        description: "Name for the generated type/interface",
        default: "Generated",
      },
      input_is_file: {
        type: "boolean",
        description: "Treat source as file path instead of inline text",
        default: false,
      },
    },
    required: ["source", "from", "to"],
  },
};

export const projectBridgeTool: ExtendedTool = {
  name: "project_bridge",
  description:
    "Cross-project interoperability analysis: shared dependencies, version alignment, configuration drift detection across multiple projects.",
  defer_loading: true,
  priority: "normal",
  execution_class: "diagnostic",
  cost_tier: "moderate",
  inputSchema: {
    type: "object",
    properties: {
      projects: {
        type: "array",
        items: { type: "string" },
        description: "List of project directories to analyze",
      },
      action: {
        type: "string",
        enum: ["analyze", "diff_deps", "shared_config", "sync_versions"],
        description: "Bridge action to perform",
      },
      output_file: {
        type: "string",
        description: "Write report to file",
      },
    },
    required: ["projects", "action"],
  },
};

export const dataTransformTool: ExtendedTool = {
  name: "data_transform",
  description:
    "Convert data between formats: JSON ↔ YAML ↔ TOML ↔ CSV. Handles files and inline data with optional output file writing.",
  defer_loading: true,
  priority: "normal",
  execution_class: "interactive",
  cost_tier: "cheap",
  inputSchema: {
    type: "object",
    properties: {
      source: {
        type: "string",
        description: "Source data or file path",
      },
      input_format: {
        type: "string",
        enum: ["json", "yaml", "toml", "csv"],
        description: "Input data format",
      },
      output_format: {
        type: "string",
        enum: ["json", "yaml", "toml", "csv"],
        description: "Desired output format",
      },
      input_is_file: {
        type: "boolean",
        description: "Treat source as file path instead of inline data",
        default: false,
      },
      output_file: {
        type: "string",
        description: "Write transformed output to file",
      },
      pretty: {
        type: "boolean",
        description: "Pretty-print output",
        default: true,
      },
    },
    required: ["source", "input_format", "output_format"],
  },
};

// ─── Handlers ─────────────────────────────────────────────────────────────────

export async function handleSchemaConvert(
  args: z.infer<typeof schemaConvertSchema>
): Promise<McpToolResult> {
  try {
    let { source } = args;
    const { from, to, name, input_is_file } = args;

    if (input_is_file) {
      source = readFileSync(source, "utf-8");
    }

    let result: string;

    if (from === "json_schema" && to === "typescript") {
      const schema = JSON.parse(source);
      result = jsonSchemaToTypescript(schema, name);
    } else if (from === "typescript" && to === "json_schema") {
      const schema = typescriptToJsonSchema(source);
      result = JSON.stringify(schema, null, 2);
    } else if (from === "json_schema" && to === "openapi_fragment") {
      // OpenAPI 3.0 schema object is a JSON Schema subset
      const schema = JSON.parse(source);
      const fragment: any = {
        type: schema.type || "object",
      };
      if (schema.properties) fragment.properties = schema.properties;
      if (schema.required) fragment.required = schema.required;
      if (schema.description) fragment.description = schema.description;
      if (schema.enum) fragment.enum = schema.enum;
      if (schema.example) fragment.example = schema.example;
      result = JSON.stringify(fragment, null, 2);
    } else if (from === "typescript" && to === "openapi_fragment") {
      const schema = typescriptToJsonSchema(source);
      const fragment: any = {
        type: schema.type || "object",
      };
      if (schema.properties) fragment.properties = schema.properties;
      if (schema.required) fragment.required = schema.required;
      result = JSON.stringify(fragment, null, 2);
    } else if (from === "openapi_fragment" && to === "json_schema") {
      const fragment = JSON.parse(source);
      const schema: any = {
        $schema: "http://json-schema.org/draft-07/schema#",
      };
      if (fragment.type) schema.type = fragment.type;
      if (fragment.properties) schema.properties = fragment.properties;
      if (fragment.required) schema.required = fragment.required;
      if (fragment.description) schema.description = fragment.description;
      result = JSON.stringify(schema, null, 2);
    } else if (from === "openapi_fragment" && to === "typescript") {
      const fragment = JSON.parse(source);
      // Treat OpenAPI schema fragment as JSON Schema
      result = jsonSchemaToTypescript(fragment, name);
    } else {
      return {
        content: [
          {
            type: "text",
            text: stringifyGeneric({
              error: `Unsupported conversion: ${from} → ${to}`,
              supported: [
                "json_schema → typescript",
                "typescript → json_schema",
                "json_schema → openapi_fragment",
                "openapi_fragment → json_schema",
                "typescript → openapi_fragment",
                "openapi_fragment → typescript",
              ],
            }),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: stringifyGeneric({
            from,
            to,
            name,
            result,
          }),
        },
      ],
    };
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `Schema conversion error: ${err.message}` }],
      isError: true,
    };
  }
}

export async function handleProjectBridge(
  args: z.infer<typeof projectBridgeSchema>
): Promise<McpToolResult> {
  try {
    const { projects, action, output_file } = args;

    // Resolve all package.json files from each project
    const allPackages: Array<{ project: string; path: string; data: any }> = [];
    for (const projectDir of projects) {
      if (!existsSync(projectDir)) {
        return {
          content: [
            {
              type: "text",
              text: stringifyGeneric({ error: `Directory not found: ${projectDir}` }),
            },
          ],
          isError: true,
        };
      }
      const pkgs = await collectPackageJsons(projectDir);
      for (const pkg of pkgs) {
        allPackages.push({ project: projectDir, ...pkg });
      }
    }

    if (action === "analyze") {
      const report: any = {
        projects_analyzed: projects.length,
        packages_found: allPackages.length,
        packages: allPackages.map((p) => ({
          project: p.project,
          name: p.data.name || "unnamed",
          version: p.data.version || "0.0.0",
          path: path.relative(process.cwd(), p.path),
        })),
        shared_dependencies: {} as Record<string, string[]>,
      };

      // Find shared dependencies
      const depMap = new Map<string, Set<string>>();
      for (const pkg of allPackages) {
        const deps = { ...pkg.data.dependencies, ...pkg.data.devDependencies };
        for (const [dep, ver] of Object.entries(deps)) {
          if (!depMap.has(dep)) depMap.set(dep, new Set());
          depMap.get(dep)!.add(ver as string);
        }
      }

      for (const [dep, versions] of depMap) {
        if (versions.size > 1) {
          report.shared_dependencies[dep] = Array.from(versions);
        }
      }

      const output = stringifyGeneric(report);
      if (output_file) {
        await fs.writeFile(output_file, output, "utf-8");
        return {
          content: [{ type: "text", text: stringifyGeneric({ success: true, output_file }) }],
        };
      }
      return { content: [{ type: "text", text: output }] };
    }

    if (action === "diff_deps") {
      if (allPackages.length < 2) {
        return {
          content: [
            {
              type: "text",
              text: stringifyGeneric({ error: "Need at least 2 package.json files to diff" }),
            },
          ],
        };
      }

      const diffs: Array<{
        packages: string[];
        only_in_first: string[];
        only_in_second: string[];
        version_mismatches: Array<{ dep: string; versions: string[] }>;
      }> = [];

      for (let i = 0; i < allPackages.length - 1; i++) {
        for (let j = i + 1; j < allPackages.length; j++) {
          const a = allPackages[i];
          const b = allPackages[j];
          const aDeps = new Set(Object.keys({ ...a.data.dependencies, ...a.data.devDependencies }));
          const bDeps = new Set(Object.keys({ ...b.data.dependencies, ...b.data.devDependencies }));

          const onlyInA = [...aDeps].filter((d) => !bDeps.has(d));
          const onlyInB = [...bDeps].filter((d) => !aDeps.has(d));
          const shared = [...aDeps].filter((d) => bDeps.has(d));

          const mismatches: Array<{ dep: string; versions: string[] }> = [];
          for (const dep of shared) {
            const verA = (a.data.dependencies?.[dep] || a.data.devDependencies?.[dep]) as string;
            const verB = (b.data.dependencies?.[dep] || b.data.devDependencies?.[dep]) as string;
            if (verA !== verB) {
              mismatches.push({ dep, versions: [verA, verB] });
            }
          }

          diffs.push({
            packages: [a.data.name || a.path, b.data.name || b.path],
            only_in_first: onlyInA,
            only_in_second: onlyInB,
            version_mismatches: mismatches,
          });
        }
      }

      const output = stringifyGeneric({ diffs });
      if (output_file) {
        await fs.writeFile(output_file, output, "utf-8");
        return {
          content: [{ type: "text", text: stringifyGeneric({ success: true, output_file }) }],
        };
      }
      return { content: [{ type: "text", text: output }] };
    }

    if (action === "shared_config") {
      // Collect shared config patterns: tsconfig, eslint, prettier
      const configs: Record<string, Array<{ project: string; path: string }>> = {};

      for (const projectDir of projects) {
        const configFiles = [
          "tsconfig.json",
          ".eslintrc.json",
          ".prettierrc.json",
          "flake.nix",
          "Makefile",
        ];
        for (const cf of configFiles) {
          const fullPath = path.join(projectDir, cf);
          if (existsSync(fullPath)) {
            if (!configs[cf]) configs[cf] = [];
            configs[cf].push({ project: projectDir, path: fullPath });
          }
        }
      }

      const sharedConfigs = Object.entries(configs).filter(([, instances]) => instances.length > 1);

      const output = stringifyGeneric({
        shared_configs: sharedConfigs.map(([name, instances]) => ({
          config: name,
          present_in: instances.map((i) => i.project),
          paths: instances.map((i) => i.path),
        })),
      });

      if (output_file) {
        await fs.writeFile(output_file, output, "utf-8");
        return {
          content: [{ type: "text", text: stringifyGeneric({ success: true, output_file }) }],
        };
      }
      return { content: [{ type: "text", text: output }] };
    }

    if (action === "sync_versions") {
      // Detect version misalignments and suggest sync
      const depVersions = new Map<string, Array<{ project: string; version: string }>>();
      for (const pkg of allPackages) {
        const deps = { ...pkg.data.dependencies, ...pkg.data.devDependencies };
        for (const [dep, ver] of Object.entries(deps)) {
          if (!depVersions.has(dep)) depVersions.set(dep, []);
          depVersions.get(dep)!.push({ project: pkg.project, version: ver as string });
        }
      }

      const misaligned: Array<{
        dep: string;
        versions: Array<{ project: string; version: string }>;
        suggestion: string;
      }> = [];

      for (const [dep, instances] of depVersions) {
        const uniqueVersions = new Set(instances.map((i) => i.version));
        if (uniqueVersions.size > 1) {
          // Suggest the highest version
          const sorted = [...uniqueVersions].sort();
          misaligned.push({
            dep,
            versions: instances,
            suggestion: `Align to latest: ${sorted[sorted.length - 1]}`,
          });
        }
      }

      const output = stringifyGeneric({
        misaligned_count: misaligned.length,
        misaligned_dependencies: misaligned,
      });

      if (output_file) {
        await fs.writeFile(output_file, output, "utf-8");
        return {
          content: [{ type: "text", text: stringifyGeneric({ success: true, output_file }) }],
        };
      }
      return { content: [{ type: "text", text: output }] };
    }

    return {
      content: [{ type: "text", text: stringifyGeneric({ error: `Unknown action: ${action}` }) }],
    };
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `Project bridge error: ${err.message}` }],
      isError: true,
    };
  }
}

export async function handleDataTransform(
  args: z.infer<typeof dataTransformSchema>
): Promise<McpToolResult> {
  try {
    let { source } = args;
    const { input_format, output_format, input_is_file, output_file, pretty } = args;

    if (input_is_file) {
      source = readFileSync(source, "utf-8");
    }

    // Parse input
    let data: any;
    switch (input_format) {
      case "json":
        data = JSON.parse(source);
        break;
      case "yaml":
        data = parseSimpleYaml(source);
        break;
      case "toml":
        data = parseSimpleToml(source);
        break;
      case "csv":
        data = parseCsv(source);
        break;
      default:
        return {
          content: [
            {
              type: "text",
              text: stringifyGeneric({ error: `Unknown input format: ${input_format}` }),
            },
          ],
          isError: true,
        };
    }

    // Convert to output
    let output: string;
    switch (output_format) {
      case "json":
        output = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
        break;
      case "yaml":
        output = stringifyYaml(data);
        break;
      case "toml":
        output = stringifyToml(data);
        break;
      case "csv":
        if (Array.isArray(data)) {
          output = stringifyCsv(data);
        } else {
          // Wrap single object in array
          output = stringifyCsv([data]);
        }
        break;
      default:
        return {
          content: [
            {
              type: "text",
              text: stringifyGeneric({ error: `Unknown output format: ${output_format}` }),
            },
          ],
          isError: true,
        };
    }

    if (output_file) {
      await fs.writeFile(output_file, output, "utf-8");
      return {
        content: [
          {
            type: "text",
            text: stringifyGeneric({
              success: true,
              output_file,
              input_format,
              output_format,
              size_bytes: Buffer.byteLength(output, "utf-8"),
            }),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: stringifyGeneric({
            input_format,
            output_format,
            output,
          }),
        },
      ],
    };
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `Data transform error: ${err.message}` }],
      isError: true,
    };
  }
}

// ─── Batch export ─────────────────────────────────────────────────────────────

export const interopTools: ExtendedTool[] = [
  schemaConvertTool,
  projectBridgeTool,
  dataTransformTool,
];
