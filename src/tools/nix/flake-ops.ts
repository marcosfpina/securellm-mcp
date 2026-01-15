/**
 * Nix Flake Operations
 *
 * Provides operations for Nix flakes: build, check, update, etc.
 *
 * REFACTORED [MCP-2]: Async execution to prevent event loop blocking
 */

import { executeNixCommand, executeNixCommandStreaming } from './utils/async-exec.js';
import { logger } from '../../utils/logger.js';
import type { FlakeBuildResult, FlakeOperation, FlakeMetadata } from '../../types/nix-tools.js';
import { CacheManager } from '../../utils/cache-manager.js';

/**
 * Flake Operations
 */
export class FlakeOps {
  private projectRoot: string;
  private metadataCache = new CacheManager<string, FlakeMetadata>({
    max: 100,
    ttl: 600000,  // 10 min
  });

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  /**
   * Build a flake output
   */
  public async build(output: string = ''): Promise<FlakeBuildResult> {
    return this.executeFlakeCommand('build', output);
  }

  /**
   * Check flake (run all checks)
   */
  public async check(): Promise<FlakeBuildResult> {
    return this.executeFlakeCommand('check');
  }

  /**
   * Update flake inputs
   */
  public async update(input?: string): Promise<FlakeBuildResult> {
    const args = input ? [input] : [];
    return this.executeFlakeCommand('update', '', args);
  }

  public async show(): Promise<FlakeMetadata> {
    const cacheKey = `metadata:${this.projectRoot}`;

    // Check cache
    const cached = this.metadataCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const output = await executeNixCommand(
        ['flake', 'metadata', '--json'],
        {
          cwd: this.projectRoot,
          timeout: 10000,
        }
      );

      const metadata = JSON.parse(output);

      const result = {
        description: metadata.description || '',
        lastModified: metadata.lastModified || 0,
        revision: metadata.revision,
        inputs: this.parseInputs(metadata.locks?.nodes || {}),
        outputs: Object.keys(metadata.locks?.nodes?.root?.outputs || {}),
      };

      // Store in cache
      this.metadataCache.set(cacheKey, result);

      return result;
    } catch (error: any) {
      throw new Error(`Failed to show flake metadata: ${error.message}`);
    }
  }

  /**
   * Get cache statistics
   */
  public getCacheStats() {
    return {
      metadata: this.metadataCache.getStats(),
    };
  }

  /**
   * Evaluate Nix expression
   */
  public async eval(expression: string): Promise<string> {
    try {
      const output = await executeNixCommand(
        ['eval', '--raw', expression],
        {
          cwd: this.projectRoot,
          timeout: 5000,
        }
      );

      return output.trim();
    } catch (error: any) {
      throw new Error(`Failed to evaluate expression: ${error.message}`);
    }
  }

  /**
   * Enter development shell
   */
  public async develop(shell?: string): Promise<FlakeBuildResult> {
    const target = shell ? `.#${shell}` : '';
    return this.executeFlakeCommand('develop', target, ['--command', 'echo', 'Shell ready']);
  }

  /**
   * Execute flake command (async, non-blocking)
   */
  private async executeFlakeCommand(
    operation: FlakeOperation,
    target: string = '',
    extraArgs: string[] = []
  ): Promise<FlakeBuildResult> {
    const startTime = Date.now();
    const logs: string[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      const flakeRef = target ? `.#${target}` : '.';
      const args = ['flake', operation, flakeRef, ...extraArgs].filter(Boolean);

      // Use streaming for long operations (build, check)
      const useStreaming = ['build', 'check'].includes(operation);

      let output: string;

      if (useStreaming) {
        logger.info(
          { operation, target, args },
          "Starting long-running Nix flake operation"
        );

        const result = await executeNixCommandStreaming(
          args,
          {
            cwd: this.projectRoot,
            timeout: 120000,  // 2 minutes for builds
          },
          (chunk) => {
            // Stream stdout to logs
            logs.push(chunk);
          },
          (chunk) => {
            // Stream stderr (may contain warnings)
            const foundWarnings = this.extractWarnings(chunk);
            warnings.push(...foundWarnings);
          }
        );

        output = result.stdout;

        if (result.failed) {
          const foundErrors = this.extractErrors(result.stderr);
          errors.push(...foundErrors);

          return {
            operation,
            success: false,
            logs,
            errors,
            warnings,
            duration: Date.now() - startTime,
            exitCode: result.exitCode,
          };
        }
      } else {
        // For quick operations (update, develop), use simple execution
        output = await executeNixCommand(args, {
          cwd: this.projectRoot,
          timeout: 30000,  // 30s for non-build operations
        });

        logs.push(output);
      }

      // Parse output for paths
      const outputPath = this.extractOutputPath(output);

      // Parse warnings
      const foundWarnings = this.extractWarnings(output);
      warnings.push(...foundWarnings);

      return {
        operation,
        success: true,
        outputPath,
        logs,
        errors,
        warnings,
        duration: Date.now() - startTime,
        exitCode: 0,
      };
    } catch (error: any) {
      logger.error(
        { err: error, operation, target },
        "Nix flake operation failed"
      );

      const errorMessage = error.message || '';
      const foundErrors = this.extractErrors(errorMessage);
      errors.push(...foundErrors);

      return {
        operation,
        success: false,
        logs,
        errors,
        warnings,
        duration: Date.now() - startTime,
        exitCode: 1,
      };
    }
  }

  /**
   * Extract output path from build output
   */
  private extractOutputPath(output: string): string | undefined {
    const match = output.match(/\/nix\/store\/[a-z0-9]+-[^\s]+/);
    return match ? match[0] : undefined;
  }

  /**
   * Extract errors from output
   */
  private extractErrors(output: string): string[] {
    const errors: string[] = [];
    const lines = output.split('\n');
    
    for (const line of lines) {
      if (line.includes('error:') || line.includes('ERROR')) {
        errors.push(line.trim());
      }
    }
    
    return errors;
  }

  /**
   * Extract warnings from output
   */
  private extractWarnings(output: string): string[] {
    const warnings: string[] = [];
    const lines = output.split('\n');
    
    for (const line of lines) {
      if (line.includes('warning:') || line.includes('WARN')) {
        warnings.push(line.trim());
      }
    }
    
    return warnings;
  }

  /**
   * Parse flake inputs
   */
  private parseInputs(nodes: any): Record<string, any> {
    const inputs: Record<string, any> = {};
    
    for (const [name, node] of Object.entries(nodes)) {
      if (name === 'root') continue;
      
      const nodeData = node as any;
      inputs[name] = {
        type: nodeData.original?.type || 'unknown',
        url: nodeData.original?.url || nodeData.locked?.url || '',
        revision: nodeData.locked?.rev,
        lastModified: nodeData.locked?.lastModified,
      };
    }
    
    return inputs;
  }
}