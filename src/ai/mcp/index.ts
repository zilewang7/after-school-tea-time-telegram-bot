/**
 * MCP module - Model Context Protocol client and tool integration
 */

export type { McpServerConfig, McpTool, McpToolCall, McpToolResult } from './types.js';
export { initMcpClients, getMcpTools, executeMcpTool, shutdownMcp } from './client.js';
export { mcpToolsToOpenAI } from './tool-adapter.js';
