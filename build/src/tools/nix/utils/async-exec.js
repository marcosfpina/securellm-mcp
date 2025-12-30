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
import { execa } from 'execa';
import { logger } from '../../../utils/logger.js';
/**
 * Execute Nix command asynchronously (non-blocking)
 *
 * @param args - Nix command arguments (e.g., ['flake', 'metadata', '--json'])
 * @param options - Execution options (cwd, timeout, etc.)
 * @returns Promise resolving to command stdout
 * @throws Error if command fails or times out
 */
export async function executeNixCommand(args, options = {}) {
    const { cwd = process.cwd(), timeout = 30000, // Default 30s (configurable per command)
    maxBuffer = 10 * 1024 * 1024, // 10MB default
    env = {}, } = options;
    const startTime = Date.now();
    try {
        logger.debug({
            command: 'nix',
            args,
            cwd,
            timeout
        }, "Executing Nix command");
        const result = await execa('nix', args, {
            cwd,
            timeout,
            maxBuffer,
            reject: false, // Don't throw, we handle errors manually
            env: {
                ...process.env,
                ...env,
            },
        });
        const duration = Date.now() - startTime;
        if (result.failed) {
            logger.error({
                args,
                stderr: result.stderr.substring(0, 500), // Truncate for logging
                exitCode: result.exitCode,
                durationMs: duration
            }, "Nix command failed");
            throw new Error(`Nix command failed: ${result.stderr}`);
        }
        logger.debug({
            args,
            exitCode: result.exitCode,
            durationMs: duration,
            stdoutLength: result.stdout.length
        }, "Nix command succeeded");
        return result.stdout;
    }
    catch (error) {
        const duration = Date.now() - startTime;
        if (error.name === 'ExecaError' && error.timedOut) {
            logger.warn({ args, timeout, durationMs: duration }, "Nix command timed out");
            throw new Error(`Nix command timed out after ${timeout}ms`);
        }
        // Re-throw other errors
        throw error;
    }
}
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
export async function executeNixCommandStreaming(args, options = {}, onStdout, onStderr) {
    const { cwd = process.cwd(), timeout = 120000, // 2 minutes for streaming (builds)
    env = {}, } = options;
    const startTime = Date.now();
    logger.info({ command: 'nix', args, cwd, timeout }, "Starting Nix command with streaming");
    try {
        const subprocess = execa('nix', args, {
            cwd,
            timeout,
            reject: false,
            env: {
                ...process.env,
                ...env,
            },
        });
        // Stream stdout
        if (onStdout && subprocess.stdout) {
            subprocess.stdout.on('data', (chunk) => {
                onStdout(chunk.toString());
            });
        }
        // Stream stderr
        if (onStderr && subprocess.stderr) {
            subprocess.stderr.on('data', (chunk) => {
                onStderr(chunk.toString());
            });
        }
        const result = await subprocess;
        const duration = Date.now() - startTime;
        logger.info({
            args,
            exitCode: result.exitCode,
            durationMs: duration,
            failed: result.failed,
            timedOut: result.timedOut
        }, "Nix streaming command completed");
        return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode || 0,
            timedOut: result.timedOut || false,
            failed: result.failed,
        };
    }
    catch (error) {
        const duration = Date.now() - startTime;
        logger.error({ err: error, args, durationMs: duration }, "Nix streaming command error");
        throw error;
    }
}
/**
 * Execute ripgrep command asynchronously (for file-scanner.ts)
 *
 * @param args - ripgrep arguments
 * @param options - Execution options
 * @returns Promise resolving to matching files (one per line)
 */
export async function executeRipgrep(args, options = {}) {
    const { cwd = process.cwd(), timeout = 5000, // 5s for file searches
     } = options;
    try {
        logger.debug({ args, cwd }, "Executing ripgrep");
        const result = await execa('rg', args, {
            cwd,
            timeout,
            reject: false,
        });
        if (result.failed && result.exitCode !== 1) {
            // Exit code 1 means "no matches found" which is OK
            throw new Error(`Ripgrep failed: ${result.stderr}`);
        }
        return result.stdout;
    }
    catch (error) {
        if (error.name === 'ExecaError' && error.timedOut) {
            logger.warn({ args, timeout }, "Ripgrep timed out");
            throw new Error(`Ripgrep timed out after ${timeout}ms`);
        }
        throw error;
    }
}
//# sourceMappingURL=async-exec.js.map