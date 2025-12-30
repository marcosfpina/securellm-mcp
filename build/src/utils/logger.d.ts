/**
 * Pino-based Async Logger for MCP Server
 *
 * CRITICAL: MCP servers use STDIO for JSON-RPC 2.0 protocol.
 * Any console.log/error output breaks the protocol.
 *
 * This logger writes to file asynchronously (non-blocking) and only
 * uses stderr during fatal startup errors (before MCP initialization).
 */
/**
 * Main logger - writes to file asynchronously
 */
export declare const logger: any;
/**
 * Startup logger - ONLY for critical errors before MCP initialization
 * Uses stderr synchronously, safe to use ONLY during startup phase
 */
export declare function logStartupError(message: string, error?: Error): void;
/**
 * Graceful shutdown - flush pending logs
 */
export declare function flushLogs(): Promise<void>;
//# sourceMappingURL=logger.d.ts.map