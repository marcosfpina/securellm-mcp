/**
 * Async Nix Command Execution Utilities
 *
 * BLOCKER CRITICAL [MCP-2]: Replace blocking execSync with async execution
 *
 * This module provides async alternatives to execSync for Nix commands,
 * preventing event loop blocking that causes MCP server hangs.
 *
 * Before: execSync blocks for up to 120 seconds during nix build
 * After: execa runs async, event loop stays responsive
 */
export interface ExecOptions {
    cwd?: string;
    timeout?: number;
    maxBuffer?: number;
    input?: string;
    env?: Record<string, string>;
}
export interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
    failed: boolean;
}
/**
 * Execute Nix command asynchronously (non-blocking)
 *
 * @param args - Nix command arguments (e.g., ['flake', 'metadata', '--json'])
 * @param options - Execution options (cwd, timeout, etc.)
 * @returns Promise resolving to command stdout
 * @throws Error if command fails or times out
 */
export declare function executeNixCommand(args: string[], options?: ExecOptions): Promise<string>;
/**
 * Execute Nix command with streaming output (for long-running commands)
 *
 * Useful for commands that produce incremental output like builds.
 *
 * @param args - Nix command arguments
 * @param options - Execution options
 * @param onStdout - Callback for stdout chunks
 * @param onStderr - Callback for stderr chunks
 * @returns Promise resolving to full result
 */
export declare function executeNixCommandStreaming(args: string[], options?: ExecOptions, onStdout?: (chunk: string) => void, onStderr?: (chunk: string) => void): Promise<ExecResult>;
/**
 * Execute ripgrep command asynchronously (for file-scanner.ts)
 *
 * @param args - ripgrep arguments
 * @param options - Execution options
 * @returns Promise resolving to matching files (one per line)
 */
export declare function executeRipgrep(args: string[], options?: ExecOptions): Promise<string>;
//# sourceMappingURL=async-exec.d.ts.map