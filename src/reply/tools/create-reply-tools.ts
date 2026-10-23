/**
 * The tool snapshot of one reply: MCP tools first, then the built-in ones this
 * turn is offered, in a fixed order so the declaration list stays byte-stable
 * for the same model and chat.
 *
 * All media tools of one reply share a single ReplyMediaState: the ids
 * search_images hands out are the ones fetch_image and send_image read, and the
 * one-image-per-reply flag lives there too.
 */
import { getModelCapabilities } from '../../ai/platform-factory.js';
import { buildMcpToolHandlers } from '../../ai/tools/mcp-tool-handlers.js';
import { createTurnTools } from '../../ai/tools/turn-tools.js';
import type { ToolHandler, TurnTools } from '../../ai/tools/tool-types.js';
import { getToolConfig } from '../../config/tool-config.js';
import { fetchImageBytes } from '../../services/image-fetch-service.js';
import { searchImages } from '../../services/image-search-service.js';
import { createFetchImageTool, PRODUCTION_FETCH_DEPENDENCIES } from './fetch-image-tool.js';
import { createGenerateImageTool } from './generate-image-tool.js';
import { createReplyMediaState } from './reply-media-state.js';
import { createSearchImagesTool, THUMBNAIL_LIMITS } from './search-images-tool.js';
import { createSendImageTool } from './send-image-tool.js';
import { createSendSmsTool } from './send-sms-tool.js';
import type { ReplyToolContext } from './reply-tool-context.js';
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
    const config = getToolConfig();
    const availability = resolveToolAvailability(model, context.chatId, config, request);
    const capabilities = getModelCapabilities(model);
    const mediaState = createReplyMediaState(context.triggerText);

    const handlers: ToolHandler[] = [
        ...buildMcpToolHandlers(availability.mcpServers, RESERVED_TOOL_NAMES, availability.isMcpToolEnabled),
        ...(availability.sms ? [createSendSmsTool(context)] : []),
        ...(availability.image ? [createGenerateImageTool(context, mediaState)] : []),
        ...(availability.imageSearch
            ? [
                  createSearchImagesTool({
                      state: mediaState,
                      dependencies: {
                          search: searchImages,
                          fetchThumbnail: (url) =>
                              fetchImageBytes(url, {
                                  maxBytes: THUMBNAIL_LIMITS.maxBytes,
                                  timeoutMs: THUMBNAIL_LIMITS.timeoutMs,
                                  signal: context.signal,
                              }),
                          baseUrl: config.imageSearchUrl,
                          engines: config.imageSearchEngines,
                          safesearch: config.imageSearchSafesearch,
                          canSeeImages: capabilities.supportsImageInput,
                      },
                  }),
              ]
            : []),
        ...(availability.imageFetch
            ? [
                  createFetchImageTool({
                      state: mediaState,
                      dependencies: { ...PRODUCTION_FETCH_DEPENDENCIES, signal: context.signal },
                      // An mp4 in a tool result only travels on the Gemini replay
                      canSeeAnimated: capabilities.supportsVideoToolResult === true,
                  }),
              ]
            : []),
        ...(availability.imageSearch
            ? [createSendImageTool({ state: mediaState, context })]
            : []),
    ];

    return { tools: createTurnTools(handlers), availability };
};
