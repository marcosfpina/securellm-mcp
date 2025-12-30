/**
 * Pino-based Async Logger for MCP Server
 *
 * CRITICAL: MCP servers use STDIO for JSON-RPC 2.0 protocol.
 * Any console.log/error output breaks the protocol.
 *
 * This logger writes to file asynchronously (non-blocking) and only
 * uses stderr during fatal startup errors (before MCP initialization).
 */
import pino from 'pino';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync, existsSync } from 'fs';
// Determine log directory
const LOG_DIR = process.env.LOG_DIR || join(homedir(), '.local', 'state', 'securellm-mcp');
const LOG_FILE = join(LOG_DIR, 'mcp.log');
// Ensure log directory exists
if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
}
/**
 * Main logger - writes to file asynchronously
 */
export const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    formatters: {
        level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: {
        pid: process.pid,
        hostname: process.env.HOSTNAME || 'mcp-server',
    },
}, pino.destination({
    dest: LOG_FILE,
    sync: false, // CRITICAL: async writes - non-blocking
    mkdir: true,
}));
/**
 * Debug logger - optionally writes to stderr during development
 * ONLY enabled via DEBUG_TO_STDERR=true environment variable
 *
 * WARNING: Do not use in production MCP server!
 */
let stderrLogger = null;
if (process.env.DEBUG_TO_STDERR === 'true') {
    stderrLogger = pino({
        level: 'debug',
        transport: {
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'SYS:HH:MM:ss',
                ignore: 'pid,hostname',
            },
        },
    }, pino.destination({ dest: 2, sync: false }));
}
/**
 * Startup logger - ONLY for critical errors before MCP initialization
 * Uses stderr synchronously, safe to use ONLY during startup phase
 */
export function logStartupError(message, error) {
    const timestamp = new Date().toISOString();
    const errorMsg = error ? `${message}: ${error.message}` : message;
    // Write to stderr synchronously (acceptable during startup)
    process.stderr.write(`[${timestamp}] FATAL: ${errorMsg}\n`);
    if (error?.stack) {
        process.stderr.write(`${error.stack}\n`);
    }
}
/**
 * Graceful shutdown - flush pending logs
 */
export async function flushLogs() {
    return new Promise((resolve) => {
        logger.flush(() => {
            resolve();
        });
    });
}
// Auto-flush on process exit
process.on('beforeExit', async () => {
    await flushLogs();
});
// Log initialization
logger.info({
    logFile: LOG_FILE,
    logLevel: process.env.LOG_LEVEL || 'info',
    debugToStderr: process.env.DEBUG_TO_STDERR === 'true',
}, 'Logger initialized');
//# sourceMappingURL=logger.js.map