/**
 * MCP Client - manages connections to MCP servers and tool execution
 */
import { Client } from '@modelcontextprotocol/sdk/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig, McpTool, McpToolResult } from './types.js';

interface McpServerConnection {
    name: string;
    config: McpServerConfig;
    client: InstanceType<typeof Client>;
    tools: McpTool[];
    connected: boolean;
}

let connections: McpServerConnection[] = [];
let initialized = false;

/**
 * Parse MCP_SERVERS environment variable and initialize connections
 */
export async function initMcpClients(): Promise<void> {
    if (initialized) return;

    const serversJson = process.env.MCP_SERVERS;
    if (!serversJson) {
        console.log('[mcp] No MCP_SERVERS configured');
        initialized = true;
        return;
    }

    let servers: Record<string, McpServerConfig>;
    try {
        servers = JSON.parse(serversJson);
    } catch (error) {
        console.error('[mcp] Failed to parse MCP_SERVERS:', error);
        initialized = true;
        return;
    }

    const entries = Object.entries(servers);
    if (entries.length === 0) {
        initialized = true;
        return;
    }

    console.log(`[mcp] Initializing ${entries.length} MCP server(s): ${entries.map(([n]) => n).join(', ')}`);

    const connectPromises = entries.map(([name, config]) => connectServer(name, config));
    const results = await Promise.allSettled(connectPromises);

    for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
            connections.push(result.value);
        }
    }

    initialized = true;
    const totalTools = connections.reduce((sum, c) => sum + c.tools.length, 0);
    console.log(`[mcp] ${connections.length}/${entries.length} servers connected, ${totalTools} tools available`);
}

async function connectServer(name: string, config: McpServerConfig): Promise<McpServerConnection | null> {
    try {
        const client = new Client(
            { name: `k-on-bot-${name}`, version: '1.0.0' },
            { capabilities: {} }
        );

        const url = new URL(config.serverUrl);
        const transportOptions: { requestInit?: { headers: Record<string, string> } } = {};
        if (config.headers) {
            transportOptions.requestInit = { headers: config.headers };
        }
        const transport = new StreamableHTTPClientTransport(url, transportOptions);

        await client.connect(transport);

        // List tools
        const toolsResponse = await client.listTools();
        const tools: McpTool[] = (toolsResponse.tools ?? []).map((tool: { name: string; description?: string; inputSchema?: Record<string, unknown> }) => ({
            name: tool.name,
            serverName: name,
            description: tool.description,
            inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
        }));

        console.log(`[mcp] Server "${name}" connected: ${tools.length} tool(s) [${tools.map((t: McpTool) => t.name).join(', ')}]`);

        return { name, config, client, tools, connected: true };
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`[mcp] Failed to connect to "${name}":`, errorMsg);
        return null;
    }
}

/**
 * Get all available MCP tools
 */
export function getMcpTools(): McpTool[] {
    return connections.flatMap(c => c.tools);
}

/**
 * Execute an MCP tool call
 */
export async function executeMcpTool(toolName: string, argsJson: string): Promise<McpToolResult> {
    const connection = connections.find(c => c.tools.some(t => t.name === toolName));
    if (!connection) {
        throw new Error(`MCP tool "${toolName}" not found in any connected server`);
    }

    let args: Record<string, unknown> = {};
    try {
        args = argsJson ? JSON.parse(argsJson) : {};
    } catch {
        throw new Error(`Invalid JSON arguments for tool "${toolName}": ${argsJson}`);
    }

    console.log(`[mcp] Executing tool "${toolName}" on server "${connection.name}"`);

    const result = await connection.client.callTool({
        name: toolName,
        arguments: args,
    });

    const contentParts = Array.isArray(result.content) ? result.content : [];
    const textParts = contentParts
        .filter((p: unknown) => (p as { type: string }).type === 'text')
        .map((p: unknown) => (p as { text: string }).text);

    return {
        content: textParts.join('\n') || 'Tool executed successfully.',
        isError: result.isError === true,
    };
}

/**
 * Shutdown all MCP connections
 */
export async function shutdownMcp(): Promise<void> {
    for (const conn of connections) {
        try {
            await conn.client.close();
        } catch {
            // ignore close errors
        }
    }
    connections = [];
    initialized = false;
}
