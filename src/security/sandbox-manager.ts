import { execa } from 'execa';
import { logger } from '../utils/logger.js';

export interface SandboxOptions {
  packages?: string[]; // List of packages e.g. ['git', 'rustc']
  inputsFrom?: string; // Path to a flake to use inputs from (e.g. '.')
  cwd?: string;
  timeout?: number;
  ignoreEnvironment?: boolean; // Equivalent to --ignore-environment / --pure
  env?: Record<string, string>;
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  failed: boolean;
  timedOut: boolean;
  command: string;
}

/**
 * Sandbox Manager
 * 
 * Provides ephemeral isolation for executing commands.
 * Uses 'nix shell' to create temporary environments with restricted dependencies.
 */
export class SandboxManager {
  
  /**
   * Execute a command inside a Nix Sandbox
   */
  async execute(command: string, options: SandboxOptions): Promise<SandboxResult> {
    const {
      packages = [],
      inputsFrom,
      cwd = process.cwd(),
      timeout = 60000,
      ignoreEnvironment = true, // Default to pure execution for safety
      env = {}
    } = options;

    const nixArgs = ['shell'];

    // If using inputs from a flake (e.g. local project)
    if (inputsFrom) {
      nixArgs.push('--inputs-from', inputsFrom);
    }

    // Explicit packages from nixpkgs
    packages.forEach(pkg => {
      // Handle "nixpkgs#pkg" or just "pkg"
      const pkgRef = pkg.includes('#') ? pkg : `nixpkgs#${pkg}`;
      nixArgs.push(pkgRef);
    });

    if (ignoreEnvironment) {
      nixArgs.push('--ignore-environment');
    }

    // The command execution part
    nixArgs.push('--command', 'bash', '-c', command);

    const startTime = Date.now();
    logger.info({
      type: 'SANDBOX_EXEC_START',
      command,
      packages,
      inputsFrom,
      cwd
    }, "Starting sandboxed execution");

    try {
      const result = await execa('nix', nixArgs, {
        cwd,
        timeout,
        reject: false,
        env: {
          ...env,
          // Minimal PATH if ignored, but we usually want basic tools
          // When --ignore-environment is used, env vars are cleared.
          // We might need to pass specific ones back in.
          TERM: 'xterm-256color' 
        }
      });

      const duration = Date.now() - startTime;
      
      logger.info({
        type: 'SANDBOX_EXEC_COMPLETE',
        exitCode: result.exitCode,
        durationMs: duration,
        failed: result.failed
      }, "Sandboxed execution finished");

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode ?? -1,
        failed: result.failed,
        timedOut: result.timedOut,
        command: `nix ${nixArgs.join(' ')}`
      };

    } catch (error: any) {
      const duration = Date.now() - startTime;
      
      logger.error({
        type: 'SANDBOX_EXEC_ERROR',
        error: error.message,
        durationMs: duration
      }, "Sandboxed execution crashed");

      return {
        stdout: '',
        stderr: error.message,
        exitCode: -1,
        failed: true,
        timedOut: error.timedOut || false,
        command: command
      };
    }
  }

  /**
   * Check if a command is safe to run without sandbox (allowlist)
   */
  isSafeCommand(command: string): boolean {
    const safePrefixes = ['ls', 'echo', 'cat', 'grep', 'rg', 'git status', 'git log'];
    return safePrefixes.some(prefix => command.startsWith(prefix));
  }
}

// Export singleton
export const sandboxManager = new SandboxManager();
