import * as path from "path";
import * as fs from "fs";

export interface PathContext {
  env: string;
  projectRoot: string;
  [key: string]: string;
}

export class PathResolutionEngine {
  private aliases: Map<string, string> = new Map();
  private context: PathContext;

  constructor(context: PathContext) {
    this.context = context;
  }

  /**
   * Register a path alias (e.g., "@data" -> "/var/lib/data")
   */
  registerAlias(alias: string, value: string): void {
    this.aliases.set(alias, value);
  }

  /**
   * Register multiple aliases at once
   */
  registerAliases(aliases: Record<string, string>): void {
    Object.entries(aliases).forEach(([alias, value]) => {
      this.registerAlias(alias, value);
    });
  }

  /**
   * Resolve a path with alias and variable substitution
   * Supports:
   * - Aliases: @data/file.txt
   * - Variables: {root}/src, {env}/config
   */
  resolve(inputPath: string): string {
    let resolved = inputPath;

    // 1. Alias Substitution
    // Sort aliases by length (descending) to match longest prefix first
    const sortedAliases = Array.from(this.aliases.entries())
      .sort((a, b) => b[0].length - a[0].length);

    for (const [alias, value] of sortedAliases) {
      if (resolved.startsWith(alias)) {
        const remainder = resolved.slice(alias.length);
        // Ensure alias matches distinct path segment or full string
        if (remainder === "" || remainder.startsWith("/") || remainder.startsWith(path.sep)) {
          // Resolve the alias value first (it might contain variables)
          const resolvedValue = this.resolveVariables(value);
          resolved = path.join(resolvedValue, remainder);
          break; // Only resolve one alias at the start
        }
      }
    }

    // 2. Variable Substitution
    resolved = this.resolveVariables(resolved);

    return path.resolve(resolved);
  }

  private resolveVariables(input: string): string {
    return input.replace(/\{(\w+)\}/g, (match, key) => {
      if (key in this.context) {
        return this.context[key];
      }
      return match;
    });
  }

  /**
   * Validate that a path exists and returns resolution details
   */
  validate(inputPath: string): { valid: boolean; resolved: string; error?: string } {
    try {
      const resolved = this.resolve(inputPath);
      const exists = fs.existsSync(resolved);
      return { valid: exists, resolved };
    } catch (error: any) {
      return { valid: false, resolved: "", error: error.message };
    }
  }

  /**
   * Ensure a directory exists (mkdir -p)
   */
  ensureDir(inputPath: string): string {
    const resolved = this.resolve(inputPath);
    if (!fs.existsSync(resolved)) {
      fs.mkdirSync(resolved, { recursive: true });
    }
    return resolved;
  }
}