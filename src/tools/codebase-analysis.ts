import { z } from 'zod';
import { readFileSync, statSync, readdirSync } from 'fs';
import { join, extname } from 'path';

/**
 * Codebase Analysis Tools
 * Lightweight static analysis for performance and quality checks.
 */

// --- Tool Definitions ---

export const analyzeComplexitySchema = z.object({
  path: z.string().describe('Path to file or directory to analyze'),
});

export const findDeadCodeSchema = z.object({
  path: z.string().describe('Directory to search for potentially unused exports'),
});

export const mapDependenciesSchema = z.object({
  path: z.string().describe('Entry file to map dependencies from'),
  depth: z.number().optional().default(1).describe('Depth of dependency tree'),
});

// --- Implementations ---

/**
 * Calculate Cyclomatic Complexity (Simplified)
 * Counts branching statements (if, while, for, case, catch, etc.)
 */
function calculateComplexity(content: string): number {
  let complexity = 1;
  const checks = [
    /\bif\b/g, /\belse\b/g, /\bwhile\b/g, /\bfor\b/g,
    /\bcase\b/g, /\bcatch\b/g, /\?.?/g, /\|\|/g, /&&/g
  ];
  
  for (const regex of checks) {
    const matches = content.match(regex);
    if (matches) complexity += matches.length;
  }
  return complexity;
}

export async function analyzeComplexity(args: { path: string }) {
  const { path } = args;
  
  try {
    const stats = statSync(path);
    
    if (stats.isFile()) {
      const content = readFileSync(path, 'utf-8');
      const complexity = calculateComplexity(content);
      const lines = content.split('\n').length;
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              file: path,
              complexity,
              lines,
              rating: complexity > 20 ? 'HIGH' : complexity > 10 ? 'MEDIUM' : 'LOW'
            }, null, 2)
          }
        ]
      };
    }
    
    // Directory analysis (scan TS/JS files)
    const files = getAllFiles(path, ['.ts', '.js', '.tsx', '.jsx']);
    const results = files.map(f => {
      const content = readFileSync(f, 'utf-8');
      return {
        file: f,
        complexity: calculateComplexity(content),
        lines: content.split('\n').length
      };
    }).sort((a, b) => b.complexity - a.complexity).slice(0, 20); // Top 20 complex files
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            totalFiles: files.length,
            mostComplex: results
          }, null, 2)
        }
      ]
    };
    
  } catch (error: any) {
    return {
      content: [{ type: 'text', text: `Error analyzing complexity: ${error.message}` }],
      isError: true
    };
  }
}

/**
 * Heuristic Dead Code Detection
 * Scans for "export" and checks if it's imported elsewhere.
 * NOTE: This is a fast approximation, not a full AST parser.
 */
export async function findDeadCode(args: { path: string }) {
  const { path } = args;
  const files = getAllFiles(path, ['.ts', '.js']);
  
  // 1. Gather all exports
  const exports = new Map<string, string[]>(); // file -> [exported_names]
  
  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const exportMatches = content.matchAll(/export\s+(?:const|function|class|interface|type)\s+(\w+)/g);
    const fileExports: string[] = [];
    for (const match of exportMatches) {
      fileExports.push(match[1]);
    }
    if (fileExports.length > 0) {
      exports.set(file, fileExports);
    }
  }
  
  // 2. Scan all files for usage
  const unused: Record<string, string[]> = {};
  
  for (const [file, exportedNames] of exports.entries()) {
    const otherFiles = files.filter(f => f !== file);
    const fileUnused: string[] = [];
    
    for (const name of exportedNames) {
      let isUsed = false;
      // Check if 'name' appears in any other file
      // Very simple regex, might have false positives (which is safer than false negatives here)
      const usageRegex = new RegExp(`\b${name}\b`);
      
      for (const other of otherFiles) {
        const content = readFileSync(other, 'utf-8');
        if (usageRegex.test(content)) {
          isUsed = true;
          break;
        }
      }
      
      if (!isUsed) fileUnused.push(name);
    }
    
    if (fileUnused.length > 0) {
      unused[file] = fileUnused;
    }
  }
  
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          description: "Potentially unused exports (Heuristic Analysis)",
          unusedExports: unused
        }, null, 2)
      }
    ]
  };
}

/**
 * Helper: Recursive file lister
 */
function getAllFiles(dir: string, extensions: string[]): string[] {
  let results: string[] = [];
  const list = readdirSync(dir);
  
  for (const file of list) {
    if (file.includes('node_modules') || file.startsWith('.')) continue;
    
    const filePath = join(dir, file);
    const stat = statSync(filePath);
    
    if (stat && stat.isDirectory()) {
      results = results.concat(getAllFiles(filePath, extensions));
    } else {
      if (extensions.includes(extname(file))) {
        results.push(filePath);
      }
    }
  }
  return results;
}
