/**
 * The tool snapshot of one reply: MCP tools first, then the built-in ones this
 * turn is offered, in a fixed order so the declaration list stays byte-stable
 * for the same model and chat.
 *
 * All media tools of one reply share a single ReplyMediaState: the ids
 * find_image hands out are the ones fetch_image, send_image and
 * generate_image read, the drawn pictures wait there as g1…, and the
 * one-attachment-per-reply flag lives there too.
 */
import { getModelCapabilities, getPlatform } from '../../ai/platform-factory.js';
import type { ModelCapabilities } from '../../ai/types.js';
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
import {
    filterAvailableSkills,
    getSkillRegistry,
    WIDGET_ALLOW_HTML_FLAG,
    type SkillEntry,
} from '../skills/skill-registry.js';
import type { WorkspaceState } from '../workspace/workspace-state.js';
import { createCropImageTool } from './crop-image-tool.js';
import { createFetchImageTool, PRODUCTION_FETCH_DEPENDENCIES } from './fetch-image-tool.js';
import { createFindImageTool, THUMBNAIL_LIMITS } from './find-image-tool.js';
import { createGenerateImageTool } from './generate-image-tool.js';
import { createHarnessIssueTool } from './harness-issue-tool.js';
import type { HistoryState } from './history-state.js';
import { createHistoryTool } from './history-tool.js';
import { createLeaveHandoffTool } from './leave-handoff-tool.js';
import { createLoadSkillTool } from './load-skill-tool.js';
import { createReactToMessageTool } from './react-to-message-tool.js';
import type { ReplyToolContext } from './reply-tool-context.js';
import { createReplyToolState, type ReplyToolState } from './reply-tool-state.js';
import { createSendFileTool } from './send-file-tool.js';
import { createSendImageTool } from './send-image-tool.js';
import { createSendSmsTool } from './send-sms-tool.js';
import { createSendStickerTool } from './send-sticker-tool.js';
import { createSendWidgetTool } from './send-widget-tool.js';
import { resolveToolAvailability, type ToolAvailability } from './tool-availability.js';
import { RESERVED_TOOL_NAMES } from './tool-names.js';
import { createWorkspaceTool } from './workspace-tool.js';
import { createExtractFramesTool } from './video-frames-tool.js';

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
    /**
     * Repository skills gated and available for this reply; the volatile tail
     * renders the catalog from this exact list so declaration and tail match.
     */
    readonly availableSkills: readonly SkillEntry[];
}

export const createReplyTools = (
    model: string,
    context: ReplyToolContext,
    /** The chat's panel switches, taken with the rest of the reply settings */
    toolOverrides: ToolOverrides | null = null,
    /** The trigger user's tier: a trial turn loses the paid tools (design D3) */
    access: AccessTier = 'full',
    /** The state of the version a continue picks up; absent = a fresh one */
    carriedToolState?: ReplyToolState,
    /** Pre-resolved capabilities so every caller in the reply sees one snapshot */
    resolvedCapabilities?: ModelCapabilities
): ReplyTools => {
    const config = getToolConfig();
    const capabilities = resolvedCapabilities ?? getModelCapabilities(model);
    const availability = resolveToolAvailability(
        model,
        context.chatId,
        config,
        toolOverrides,
        access,
        capabilities
    );
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

    const beforeSkillHandlers: ToolHandler[] = [
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
                      // Drawn pictures are priced into this attempt's metrics row
                      ...(context.recordImageGeneration === undefined
                          ? {}
                          : { recordImageGeneration: context.recordImageGeneration }),
                  }),
              ]
            : []),
        ...(availability.imageSearch || availability.imageReverseSearch
            ? [
                  createFindImageTool({
                      state: mediaState,
                      webEnabled: availability.imageSearch,
                      reverseEnabled: availability.imageReverseSearch,
                      ...(availability.imageSearch
                          ? {
                                webDependencies: {
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
                            }
                          : {}),
                      ...(availability.imageReverseSearch ? { context } : {}),
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
        ...(availability.imageCrop ? [createCropImageTool({ state: mediaState, context })] : []),
        ...(availability.imageFrames ? [createExtractFramesTool({ state: mediaState, context })] : []),
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
    ];

    const afterSkillHandlers: ToolHandler[] = [
        ...(availability.workspace
            ? [
                  createWorkspaceTool({
                      state: workspaceState,
                      widgetLimits: widgetDraftLimits,
                      workspacePreview: availability.workspacePreview,
                      ...(availability.workspacePreview
                          ? {
                                previewLimits: {
                                    allowHtml: config.widgetAllowHtml,
                                    maxHtmlBytes: config.widgetMaxHtmlBytes,
                                    maxGzipBytes: config.widgetMaxGzipBytes,
                                },
                            }
                          : {}),
                  }),
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
        ...(availability.history
            ? [createHistoryTool(historyOptions(historyState, context, historyWiring))]
            : []),
        ...(availability.harnessIssues
            ? [createHarnessIssueTool({ state: harnessIssueState, chatId: context.chatId })]
            : []),
        // Appended last on purpose: the built-in declaration prefix stays put,
        // so only the tail of the snapshot grows.
        ...(availability.reaction ? [createReactToMessageTool(context)] : []),
    ];

    const baseDeclaredToolNames = new Set(
        [...beforeSkillHandlers, ...afterSkillHandlers].map((handler) => handler.definition.name)
    );
    const activeFlags = new Set<string>();
    if (config.widgetAllowHtml) activeFlags.add(WIDGET_ALLOW_HTML_FLAG);
    const isOwner =
        historyWiring.ownerUserId !== null && context.requester.userId === historyWiring.ownerUserId;
    const scope = context.chatId > 0 ? 'private' : 'group';
    const availableSkills: readonly SkillEntry[] = availability.skills
        ? filterAvailableSkills({
              skills: getSkillRegistry(config.skillsDir || undefined),
              declaredToolNames: baseDeclaredToolNames,
              activeFlags,
              scope,
              isOwner,
          })
        : [];

    const handlers: ToolHandler[] = [
        ...beforeSkillHandlers,
        ...(availableSkills.length > 0
            ? [createLoadSkillTool({ state: toolState.skills, availableSkills })]
            : []),
        ...afterSkillHandlers,
    ];

    return {
        tools: createTurnTools(handlers),
        availability,
        workspaceState,
        toolState,
        availableSkills,
    };
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
): Parameters<typeof createHistoryTool>[0] => ({
    state,
    context,
    service: wiring.service,
    channelId: wiring.channelId,
    ownerUserId: wiring.ownerUserId,
    botUserId: wiring.botUserId,
});
