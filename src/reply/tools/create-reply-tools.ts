/**
 * The tool snapshot of one reply: MCP tools first, then the built-in ones this
 * turn is offered, in a fixed order so the declaration list stays byte-stable
 * for the same model and chat.
 *
 * All media tools of one reply share a single ReplyMediaState: the ids
 * search_images hands out are the ones fetch_image, send_image and
 * generate_image read, the drawn pictures wait there as g1…, and the
 * one-attachment-per-reply flag lives there too.
 */
import { getModelCapabilities, getPlatform } from '../../ai/platform-factory.js';
import { buildMcpToolHandlers } from '../../ai/tools/mcp-tool-handlers.js';
import { createTurnTools } from '../../ai/tools/turn-tools.js';
import type { ToolHandler, TurnTools } from '../../ai/tools/tool-types.js';
import { getToolConfig } from '../../config/tool-config.js';
import { findTelegramUserIdByUsername } from '../../db/queries/user-queries.js';
import type { AccessTier } from '../../services/access-tier.js';
import { fetchImageBytes } from '../../services/image-fetch-service.js';
import { searchImages } from '../../services/image-search-service.js';
import { createHistoryService } from '../../services/luoxu-history-service.js';
import type { ToolOverrides } from '../../services/tool-overrides.js';
import { toLuoxuChannelId } from '../../services/luoxu-preview-service.js';
import { createFetchImageTool, PRODUCTION_FETCH_DEPENDENCIES } from './fetch-image-tool.js';
import { createGenerateImageTool } from './generate-image-tool.js';
import type { HistoryState } from './history-state.js';
import { createCreateHarnessIssueTool, createListHarnessIssuesTool } from './harness-issue-tool.js';
import { createReadHistoryTool } from './read-history-tool.js';
import { createReplyToolState, type ReplyToolState } from './reply-tool-state.js';
import { createSearchByImageTool } from './search-by-image-tool.js';
import { createSearchHistoryTool } from './search-history-tool.js';
import { createSearchImagesTool, THUMBNAIL_LIMITS } from './search-images-tool.js';
import { createSendFileTool } from './send-file-tool.js';
import { createSendImageTool } from './send-image-tool.js';
import { createSendStickerTool } from './send-sticker-tool.js';
import { createSendWidgetTool } from './send-widget-tool.js';
import { createWorkspaceCopyTool } from './workspace-copy-tool.js';
import { createWorkspaceDeleteTool } from './workspace-delete-tool.js';
import { createWorkspaceEditTool } from './workspace-edit-tool.js';
import { createWorkspaceFindTool } from './workspace-find-tool.js';
import { createWorkspaceListTool } from './workspace-list-tool.js';
import { createWorkspacePreviewTool } from './workspace-preview-tool.js';
import { createWorkspaceReadTool } from './workspace-read-tool.js';
import { createWorkspaceWriteTool } from './workspace-write-tool.js';
import { createLeaveHandoffTool } from './leave-handoff-tool.js';
import type { WorkspaceState } from '../workspace/workspace-state.js';
import { createUiGuideTool } from './ui-guide-tool.js';
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
    /**
     * Per-reply workspace tokens. The manifest builder uses it to register
     * the other conversations spliced into this context.
     */
    readonly workspaceState: WorkspaceState;
    /**
     * Every state object the tools of this reply share: the one passed in, or
     * the fresh one made for this reply. A failed reply keeps it with its
     * checkpoint, so a continue can hand it back.
     */
    readonly toolState: ReplyToolState;
}

export const createReplyTools = (
    model: string,
    context: ReplyToolContext,
    request?: ToolRequestTraits,
    /** The chat's panel switches, taken with the rest of the reply settings */
    toolOverrides: ToolOverrides | null = null,
    /** The trigger user's tier: a trial turn loses the paid tools (design D3) */
    access: AccessTier = 'full',
    /** The state of the version a continue picks up; absent = a fresh one */
    carriedToolState?: ReplyToolState
): ReplyTools => {
    const config = getToolConfig();
    const availability = resolveToolAvailability(model, context.chatId, config, request, toolOverrides, access);
    const capabilities = getModelCapabilities(model);
    const toolState =
        carriedToolState ??
        createReplyToolState(
            { chatId: context.chatId, conversationRootIds: context.conversationRootIds ?? [] },
            config
        );
    const mediaState = toolState.media;
    const workspaceState = toolState.workspace;
    const historyState = toolState.history;
    const harnessIssueState = toolState.harnessIssues;
    // HTML drafts are widget payloads: the write/edit/list results report the
    // zlib9 size only when this turn can actually send a widget.
    const widgetDraftLimits = availability.widget
        ? { maxHtmlBytes: config.widgetMaxHtmlBytes, maxGzipBytes: config.widgetMaxGzipBytes }
        : null;
    // One luoxu client per reply: the history tools and fetch_image's archive
    // lane read the same archive, so they share the client (and its cache).
    const historyWiring: HistoryWiring = {
        service: createHistoryService({ baseUrl: config.historyBaseUrl }),
        channelId: toLuoxuChannelId(context.chatId),
        ownerUserId: numericId(config.owner.userId),
        botUserId: numericId(process.env.BOT_USER_ID),
    };

    const handlers: ToolHandler[] = [
        ...buildMcpToolHandlers(availability.mcpServers, RESERVED_TOOL_NAMES, availability.isMcpToolEnabled),
        ...(availability.sms ? [createSendSmsTool(context)] : []),
        ...(availability.image
            ? [
                  createGenerateImageTool(context, mediaState, {
                      ...(availability.sticker
                          ? { sticker: { setName: config.stickerSetName, api: context.api } }
                          : {}),
                      // Trial users may draw, but only with banana (design D3)
                      ...(access === 'trial' ? { bananaOnly: true } : {}),
                  }),
              ]
            : []),
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
        ...(availability.imageReverseSearch
            ? [createSearchByImageTool({ state: mediaState, context })]
            : []),
        ...(availability.imageFetch
            ? [
                  createFetchImageTool({
                      state: mediaState,
                      dependencies: { ...PRODUCTION_FETCH_DEPENDENCIES, signal: context.signal },
                      // An mp4 in a tool result only travels on the Gemini replay
                      canSeeAnimated: capabilities.supportsVideoToolResult === true,
                      ...(availability.sticker
                          ? {
                                sticker: {
                                    setName: config.stickerSetName,
                                    api: context.api,
                                },
                            }
                          : {}),
                      ...(availability.history
                          ? {
                                history: {
                                    state: historyState,
                                    service: historyWiring.service,
                                    channelId: historyWiring.channelId,
                                    ownerUserId: historyWiring.ownerUserId,
                                    requesterUserId: context.requester.userId,
                                },
                            }
                          : {}),
                      avatar: {
                          chatId: context.chatId,
                          botUserId: numericId(process.env.BOT_USER_ID),
                          contextIndex: context.contextIndex,
                          dependencies: {
                              api: context.api,
                              lookupUsername: findTelegramUserIdByUsername,
                          },
                      },
                  }),
              ]
            : []),
        ...(availability.sendImage ? [createSendImageTool({ state: mediaState, context })] : []),
        ...(availability.sticker
            ? [
                  createSendStickerTool({
                      state: mediaState,
                      context,
                      setName: config.stickerSetName,
                      canPreview: availability.imageFetch,
                  }),
              ]
            : []),
        ...(availability.file
            ? [
                  createSendFileTool({
                      state: mediaState,
                      workspace: availability.workspace ? workspaceState : null,
                  }),
              ]
            : []),
        ...(availability.widget
            ? [
                  createSendWidgetTool({
                      state: mediaState,
                      limits: {
                          allowHtml: config.widgetAllowHtml,
                          maxHtmlBytes: config.widgetMaxHtmlBytes,
                          maxGzipBytes: config.widgetMaxGzipBytes,
                      },
                      workspace: availability.workspace ? workspaceState : null,
                  }),
              ]
            : []),
        ...(availability.widgetGuide ? [createUiGuideTool()] : []),
        ...(availability.workspace
            ? [
                  createWorkspaceWriteTool({ state: workspaceState, widgetLimits: widgetDraftLimits }),
                  createWorkspaceReadTool({ state: workspaceState }),
                  createWorkspaceListTool({ state: workspaceState, widgetLimits: widgetDraftLimits }),
                  createWorkspaceFindTool({ state: workspaceState }),
                  createWorkspaceEditTool({ state: workspaceState, widgetLimits: widgetDraftLimits }),
                  createWorkspaceCopyTool({ state: workspaceState }),
                  createWorkspaceDeleteTool({ state: workspaceState }),
              ]
            : []),
        ...(availability.handoff
            ? [
                  createLeaveHandoffTool({
                      state: workspaceState,
                      finalRoundTool: getPlatform(model).type === 'gemini',
                  }),
              ]
            : []),
        ...(availability.workspacePreview
            ? [
                  createWorkspacePreviewTool({
                      state: workspaceState,
                      limits: {
                          allowHtml: config.widgetAllowHtml,
                          maxHtmlBytes: config.widgetMaxHtmlBytes,
                          maxGzipBytes: config.widgetMaxGzipBytes,
                      },
                  }),
              ]
            : []),
        ...(availability.history
            ? [
                  createSearchHistoryTool(historyOptions(historyState, context, historyWiring)),
                  createReadHistoryTool(historyOptions(historyState, context, historyWiring)),
              ]
            : []),
        ...(availability.harnessIssues
            ? [
                  createListHarnessIssuesTool({ chatId: context.chatId }),
                  createCreateHarnessIssueTool({ state: harnessIssueState, chatId: context.chatId }),
              ]
            : []),
    ];

    return { tools: createTurnTools(handlers), availability, workspaceState, toolState };
};

/** Telegram ids arrive as strings in the env; a malformed one is simply absent */
const numericId = (value: string | null | undefined): number | null => {
    if (!value) return null;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
};

/** Everything the history tools read: one client, one chat mapping, two ids */
interface HistoryWiring {
    readonly service: ReturnType<typeof createHistoryService>;
    /** luoxu channel id of this chat; null when luoxu does not index it */
    readonly channelId: number | null;
    readonly ownerUserId: number | null;
    readonly botUserId: number | null;
}

/**
 * The two history tools share one per-reply id space and one luoxu client.
 * `channelId` is null for chats luoxu does not index (private chats), which the
 * gate already prevents; the tools still refuse rather than crash.
 */
const historyOptions = (
    state: HistoryState,
    context: ReplyToolContext,
    wiring: HistoryWiring
): Parameters<typeof createSearchHistoryTool>[0] => ({
    state,
    context,
    service: wiring.service,
    channelId: wiring.channelId,
    ownerUserId: wiring.ownerUserId,
    botUserId: wiring.botUserId,
});
