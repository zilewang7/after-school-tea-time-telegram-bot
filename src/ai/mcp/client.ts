/**
 * MCP Client - manages connections to MCP servers and tool execution
 */
import { match, P } from 'ts-pattern';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { parseMcpServers } from './server-config.js';
import type {
    McpCallOptions,
    McpServerConfig,
    McpServerInfo,
    McpTool,
    McpToolResult,
} from './types.js';

type McpClient = InstanceType<typeof Client>;

/** A connected server: what it offers plus the client that reaches it */
export interface McpServerConnection extends McpServerInfo {
    readonly client: McpClient;
}

let connections: McpServerConnection[] = [];
let initialized = false;

const describeError = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

/**
 * Connect to one server and list its tools. Throws when the server cannot be
 * reached; also used by tools that manage their own connection.
 */
export const connectMcpServer = async (
    name: string,
    config: McpServerConfig
): Promise<McpServerConnection> => {
    const client = new Client({ name: `k-on-bot-${name}`, version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(
        new URL(config.serverUrl),
        config.headers ? { requestInit: { headers: config.headers } } : {}
    );

    try {
        await client.connect(transport);
        const toolsResponse = await client.listTools();
        const tools: McpTool[] = toolsResponse.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
        }));
        console.log(
            `[mcp] Server "${name}" connected: ${tools.length} tool(s) [${tools.map((tool) => tool.name).join(', ')}]`
        );
        return { name, config, client, tools };
    } catch (error) {
        await client.close().catch(() => undefined);
        throw error;
    }
};

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

    const entries = parseMcpServers(serversJson);
    if (entries.length === 0) {
        initialized = true;
        return;
    }

    console.log(
        `[mcp] Initializing ${entries.length} MCP server(s): ${entries.map((entry) => entry.name).join(', ')}`
    );

    const results = await Promise.allSettled(
        entries.map((entry) => connectMcpServer(entry.name, entry.config))
    );
    // allSettled keeps the input order, so connections stay in config order
    results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
            connections.push(result.value);
            return;
        }
        console.error(
            `[mcp] Failed to connect to "${entries[index]?.name}":`,
            describeError(result.reason)
        );
    });

    initialized = true;
    const totalTools = connections.reduce((sum, connection) => sum + connection.tools.length, 0);
    console.log(`[mcp] ${connections.length}/${entries.length} servers connected, ${totalTools} tools available`);
}

/**
 * Connected servers with their tools, in MCP_SERVERS order
 */
export const listMcpServers = (): McpServerInfo[] =>
    connections.map(({ name, config, tools }) => ({ name, config, tools }));

/** One content block as text: non-text blocks leave a placeholder line instead of vanishing */
const renderContentBlock = (block: unknown): string =>
    match(block)
        .with({ type: 'text', text: P.string }, ({ text }) => text)
        .with({ type: 'resource_link', uri: P.string }, ({ uri }) => `[resource link: ${uri}]`)
        .with(
            { type: P.string, mimeType: P.string },
            ({ type, mimeType }) => `[${type} content omitted (${mimeType})]`
        )
        .with({ type: P.string }, ({ type }) => `[${type} content omitted]`)
        .otherwise(() => '[unrecognized content omitted]');

/** Stands in for a tool result without any content */
const NO_CONTENT_PLACEHOLDER = 'Tool returned no content.';

/** A tool result's content blocks as text; empty when there are none */
const renderMcpToolContent = (content: unknown): string => {
    const blocks: unknown[] = Array.isArray(content) ? content : [];
    return blocks.map(renderContentBlock).join('\n');
};

/**
 * Call a tool through a client the caller holds (see connectMcpServer).
 * Transport failures, timeouts and aborts throw; a tool-level failure comes
 * back with isError.
 */
export const callConnectedMcpTool = async (
    client: McpClient,
    toolName: string,
    args: Readonly<Record<string, unknown>>,
    options: McpCallOptions = {}
): Promise<McpToolResult> => {
    const result = await client.callTool({ name: toolName, arguments: { ...args } }, undefined, {
        signal: options.signal,
        timeout: options.timeoutMs,
    });
    const text = renderMcpToolContent(result.content);
    const hasContent = text.trim() !== '';
    return {
        content: hasContent ? text : NO_CONTENT_PLACEHOLDER,
        hasContent,
        isError: result.isError === true,
    };
};

/**
 * Call a tool, by its original MCP name, on one of the connected servers
 */
export const callMcpTool = async (
    serverName: string,
    toolName: string,
    args: Readonly<Record<string, unknown>>,
    options: McpCallOptions = {}
): Promise<McpToolResult> => {
    const connection = connections.find((candidate) => candidate.name === serverName);
    if (!connection) {
        throw new Error(`MCP server "${serverName}" is not connected`);
    }
    return callConnectedMcpTool(connection.client, toolName, args, options);
};

/**
 * Shutdown all MCP connections
 */
export async function shutdownMcp(): Promise<void> {
    for (const connection of connections) {
        try {
            await connection.client.close();
        } catch {
            // ignore close errors
        }
    }
    connections = [];
    initialized = false;
}
