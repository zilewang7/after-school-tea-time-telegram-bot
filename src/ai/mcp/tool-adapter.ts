/**
 * MCP to OpenAI tool format adapter
 */
import type { ChatCompletionTool } from 'openai/resources';
import type { McpTool } from './types.js';

/**
 * Convert MCP tools to OpenAI ChatCompletionTool format
 */
export function mcpToolsToOpenAI(tools: McpTool[]): ChatCompletionTool[] {
    return tools.map(tool => ({
        type: 'function' as const,
        function: {
            name: tool.name,
            description: tool.description ?? '',
            parameters: tool.inputSchema,
        },
    }));
}
