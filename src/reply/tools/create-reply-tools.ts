/**
 * The tool snapshot of one reply: MCP tools first, then the built-in ones this
 * turn is offered.
 */
import { buildMcpToolHandlers } from '../../ai/tools/mcp-tool-handlers.js';
import { createTurnTools } from '../../ai/tools/turn-tools.js';
import type { ToolHandler, TurnTools } from '../../ai/tools/tool-types.js';
import { getToolConfig } from '../../config/tool-config.js';
import { createGenerateImageTool } from './generate-image-tool.js';
import type { ReplyToolContext } from './reply-tool-context.js';
import { createSendSmsTool } from './send-sms-tool.js';
import {
    resolveToolAvailability,
    type ToolAvailability,
    type ToolRequestTraits,
} from './tool-availability.js';
import { RESERVED_TOOL_NAMES } from './tool-names.js';

export interface ReplyTools {
    readonly tools: TurnTools;
    readonly availability: ToolAvailability;
}

export const createReplyTools = (
    model: string,
    context: ReplyToolContext,
    request?: ToolRequestTraits
): ReplyTools => {
    const availability = resolveToolAvailability(model, context.chatId, getToolConfig(), request);

    const handlers: ToolHandler[] = [
        ...buildMcpToolHandlers(availability.mcpServers, RESERVED_TOOL_NAMES, availability.isMcpToolEnabled),
        ...(availability.sms ? [createSendSmsTool(context)] : []),
        ...(availability.image ? [createGenerateImageTool(context)] : []),
    ];

    return { tools: createTurnTools(handlers), availability };
};
