/**
 * MCP server tools as turn tool handlers.
 *
 * The model sees provider-safe names; each handler maps its name back to the
 * original MCP tool name and server when it runs.
 */
import { callMcpTool, extractGroundingFromToolResult, listMcpServers } from '../mcp/index.js';
import type { McpTool } from '../mcp/index.js';
import type { ToolHandler } from './tool-types.js';
import { toToolName } from './tool-wire-formats.js';

/** A stopped reply must not wait out the SDK's 60s default */
const MCP_CALL_TIMEOUT_MS = 30_000;

const createMcpToolHandler = (serverName: string, tool: McpTool, name: string): ToolHandler => ({
    definition: {
        name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema,
    },
    execute: async (args, signal) => {
        const result = await callMcpTool(serverName, tool.name, args, {
            signal,
            timeoutMs: MCP_CALL_TIMEOUT_MS,
        });
        return {
            content: result.content,
            isError: result.isError,
            images: [],
            record: extractGroundingFromToolResult(tool.name, JSON.stringify(args), result.content),
        };
    },
});

/**
 * One handler per enabled tool of the given servers, in MCP_SERVERS order.
 * `isToolEnabled` sees the original MCP name and runs before renaming, so a
 * disabled tool never shifts the `_2` suffixes of the others. Names in
 * `reservedNames` belong to built-in tools, so an MCP tool never takes them.
 */
export const buildMcpToolHandlers = (
    serverNames: readonly string[],
    reservedNames: readonly string[],
    isToolEnabled: (toolName: string) => boolean = () => true
): ToolHandler[] => {
    const allowedServers = new Set(serverNames);
    const takenNames = new Set(reservedNames);
    const handlers: ToolHandler[] = [];

    for (const server of listMcpServers()) {
        if (!allowedServers.has(server.name)) continue;
        for (const tool of server.tools) {
            if (!isToolEnabled(tool.name)) continue;
            const name = toToolName(tool.name, takenNames);
            takenNames.add(name);
            handlers.push(createMcpToolHandler(server.name, tool, name));
        }
    }

    return handlers;
};
