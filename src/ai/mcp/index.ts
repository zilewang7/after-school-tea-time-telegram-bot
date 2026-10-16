/**
 * MCP module - Model Context Protocol client and tool integration
 */

export type {
    McpCallOptions,
    McpServerConfig,
    McpServerInfo,
    McpTool,
    McpToolResult,
} from './types.js';
export type { McpServerConnection } from './client.js';
export {
    initMcpClients,
    connectMcpServer,
    listMcpServers,
    callMcpTool,
    callConnectedMcpTool,
    shutdownMcp,
} from './client.js';
export { parseMcpServers } from './server-config.js';
export { extractGroundingFromToolResult } from './grounding.js';
