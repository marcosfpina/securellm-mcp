/**
 * Web Search Tools for MCP Server
 *
 * Enhanced version with:
 * - Native fetch (no curl dependency)
 * - Intelligent formatted outputs
 * - Actionable summaries
 * - Source credibility indicators
 */
import type { ExtendedTool } from "../types/mcp-tool-extensions.js";
export declare function getNixCacheStats(): {
    size: number;
    hits: number;
    misses: number;
    hitRate: number;
};
export interface WebSearchArgs {
    query: string;
    search_type?: "general" | "nixos" | "github" | "stackoverflow" | "reddit";
    limit?: number;
}
export interface NixSearchArgs {
    package_name?: string;
    query?: string;
    channel?: "stable" | "unstable";
    type?: "packages" | "options";
}
export interface GithubSearchArgs {
    query: string;
    type?: "repositories" | "issues" | "code";
    language?: string;
    sort?: "stars" | "updated" | "relevance";
}
export interface TechNewsArgs {
    topic: string;
    source?: "hackernews" | "reddit" | "lobsters" | "all";
    time_range?: "day" | "week" | "month";
}
/**
 * Web search tool schemas for MCP
 */
export declare const webSearchTools: ExtendedTool[];
/**
 * Execute web search using native fetch
 */
export declare function handleWebSearch(args: WebSearchArgs): Promise<{
    success: boolean;
    query: string;
    source: string;
    summary: string;
    result_count: number;
    results: any[];
    quick_answer: any;
    top_urls: any[];
} | {
    success: boolean;
    error: any;
    message: string;
    suggestion: string;
}>;
/**
 * Search GitHub using native fetch
 */
export declare function handleGithubSearch(args: GithubSearchArgs): Promise<{
    success: boolean;
    query: string;
    source: string;
    summary: string;
    result_count: number;
    results: any[];
    quick_answer: any;
    top_urls: any[];
} | {
    success: boolean;
    error: any;
    message: string;
}>;
/**
 * Search NixOS packages using nix command (local) or fallback URL
 */
export declare function handleNixSearch(args: NixSearchArgs): Promise<{
    success: boolean;
    query: string;
    source: string;
    summary: string;
    result_count: number;
    results: any[];
    quick_answer: any;
    top_urls: any[];
} | {
    success: boolean;
    query: string;
    source: string;
    message: string;
    search_url: string;
    quick_action: string;
    error?: undefined;
} | {
    success: boolean;
    error: any;
    message: string;
    query?: undefined;
    source?: undefined;
    search_url?: undefined;
    quick_action?: undefined;
}>;
/**
 * Search tech news using native fetch
 */
export declare function handleTechNewsSearch(args: TechNewsArgs): Promise<{
    success: boolean;
    query: string;
    source: string;
    summary: string;
    result_count: number;
    results: any[];
    quick_answer: any;
    top_urls: any[];
} | {
    success: boolean;
    error: any;
    message: string;
}>;
/**
 * Search NixOS Discourse using native fetch
 */
export declare function handleDiscourseSearch(args: {
    query: string;
    category?: string;
}): Promise<{
    success: boolean;
    query: string;
    source: string;
    summary: string;
    result_count: number;
    results: any[];
    quick_answer: any;
    top_urls: any[];
} | {
    success: boolean;
    error: any;
    message: string;
}>;
/**
 * Search Stack Overflow using native fetch
 */
export declare function handleStackOverflowSearch(args: {
    query: string;
    tags?: string[];
    sort?: string;
}): Promise<{
    success: boolean;
    query: string;
    source: string;
    summary: string;
    result_count: number;
    results: any[];
    quick_answer: any;
    top_urls: any[];
} | {
    success: boolean;
    error: any;
    message: string;
}>;
//# sourceMappingURL=web-search.d.ts.map