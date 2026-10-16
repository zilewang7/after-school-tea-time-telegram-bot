/**
 * MCP (Model Context Protocol) type definitions
 */
import type { PlatformType } from '../types.js';

export interface McpServerConfig {
    serverUrl: string;
    headers?: Record<string, string>;
    /** Platforms that never get this server's tools (e.g. they bring their own search) */
    excludePlatforms?: PlatformType[];
}

export interface McpTool {
    /** Original MCP tool name */
    name: string;
    description?: string;
    /** JSON Schema for input parameters */
    inputSchema: Record<string, unknown>;
}

/** A connected server and the tools it listed at connect time */
export interface McpServerInfo {
    readonly name: string;
    readonly config: McpServerConfig;
    readonly tools: readonly McpTool[];
}

export interface McpToolResult {
    /** What the model reads back; a placeholder line when the tool returned nothing */
    content: string;
    /** False when the tool returned no content at all, so `content` is only that placeholder */
    hasContent: boolean;
    isError: boolean;
}

export interface McpCallOptions {
    /** Aborts the call (the reply was stopped) */
    readonly signal?: AbortSignal;
    /** Per-call timeout; the SDK default (60s) applies when absent */
    readonly timeoutMs?: number;
}
