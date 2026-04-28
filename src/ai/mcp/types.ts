/**
 * MCP (Model Context Protocol) type definitions
 */

export interface McpServerConfig {
    serverUrl: string;
    headers?: Record<string, string>;
}

export interface McpTool {
    /** Original MCP tool name */
    name: string;
    /** Server this tool belongs to */
    serverName: string;
    description?: string;
    /** JSON Schema for input parameters */
    inputSchema: Record<string, unknown>;
}

export interface McpToolCall {
    /** Format: serverName__toolName */
    name: string;
    /** JSON string arguments */
    arguments: string;
}

export interface McpToolResult {
    content: string;
    isError?: boolean;
}
