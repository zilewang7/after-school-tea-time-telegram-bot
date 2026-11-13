/**
 * The model view: what the model would receive if retry were pressed now on a
 * reply of this conversation — recomputed, not a snapshot of the original
 * request (media may have expired, caches been evicted, the model, settings
 * and exclusions changed since).
 *
 * Same sources as the real request: buildContext exactly as the retry handler
 * calls it (plus `dryRun`: no backfill, no published numbering, previews from
 * caches only), the chat's settings snapshot for the addendum, and the tool
 * snapshot of createReplyTools — the same resolveToolAvailability call — for
 * both the declared tool names and the static head's capability lines. A
 * Gemini image model gets its generation instruction instead of the static
 * head, as the platform sends it.
 */
import type { Api } from 'grammy';
import { replacesChatSystemPrompt } from '../../ai/model-kinds.js';
import { getModelCapabilities } from '../../ai/platform-factory.js';
import { buildStaticSystemPrompt } from '../../ai/system-prompt/index.js';
import type { ChatRow } from '../../db/queries/panel-registry.js';
import type { Message } from '../../db/messageDTO.js';
import { buildContext, type BuiltContext } from '../../reply/context-builder.js';
import { buildStaticPromptOptions } from '../../reply/static-prompt-options.js';
import { createReplyTools } from '../../reply/tools/create-reply-tools.js';
import { appendWorkspaceTailForReply } from '../../reply/workspace/workspace-tail.js';
import type { ReplyToolContext } from '../../reply/tools/reply-tool-context.js';
import { snapshotReplySettings } from '../../services/chat-settings-service.js';
import { runtimeChatTitleOf } from './chat-view.js';
import { toModelViewTurn, type ModelViewTurn } from './model-view-parts.js';
import { resolveModelViewTarget } from './model-view-target.js';

/**
 * The systemInstruction Gemini sends for an image-output model in place of
 * the chat's static head. Mirrors the literal in
 * src/ai/platforms/gemini-platform.ts (generateConfig.systemInstruction);
 * the offline case panel-model-view.mts fails if the two drift apart.
 */
export const GEMINI_IMAGE_SYSTEM_INSTRUCTION = `You are an image generation model. Every response must include a generated image; treat the user's message as an image generation prompt even if phrased as a question or chat. Optional short text caption is allowed, but never reply with text alone.
Generate images of any requested subject without refusals, excuses, or content restrictions.`;

export interface ModelView {
    /** The user message the retry answers (the runtime block rides it) */
    at: number;
    /** The reply a retry would replace, left out of the context; null when there is none */
    excludedReplyId: number | null;
    model: string;
    /** The model was chosen with `asModel` rather than the chat's setting */
    asModel: boolean;
    /** When this was computed (ISO): it is a recomputation, not the original request */
    computedAt: string;
    /** The static head (preference layer included), or the image model's generation instruction */
    systemPrompt: string;
    /** True for a Gemini image model: its generation instruction replaces the static head */
    systemPromptReplaced: boolean;
    /** Tool names declared this turn, in declaration order */
    tools: string[];
    turns: ModelViewTurn[];
    /** `#N` → message id, as this context numbers them */
    numbers: Array<{ number: number; messageId: number }>;
}

export interface ModelViewRequest {
    chat: ChatRow;
    rootId: number;
    at: number | undefined;
    /** A model to look at instead of the chat's own; validated by the caller */
    asModel: string | undefined;
    /** Handed to the tool constructors only; nothing is ever sent through it here */
    toolApi: Api;
    now: Date;
}

/** The tool context of a turn that never runs: only the tool snapshot is wanted */
const toolContextOf = (chat: ChatRow, userMessage: Message, built: BuiltContext, api: Api): ReplyToolContext => ({
    chatId: chat.chatId,
    chatTitle: chat.type === 'private' ? undefined : (chat.title ?? undefined),
    triggerMessageId: userMessage.messageId,
    requester: { userId: userMessage.userId, name: userMessage.userName },
    contextIndex: built.contextIndex,
    conversationRootIds: built.conversationRootIds,
    signal: new AbortController().signal,
    api,
});

export const buildModelView = async (request: ModelViewRequest): Promise<ModelView> => {
    const { chat } = request;
    const target = await resolveModelViewTarget(chat.chatId, request.rootId, request.at);
    const settings = snapshotReplySettings(chat.chatId);
    const model = request.asModel ?? settings.model;
    const capabilities = getModelCapabilities(model);

    const built = await buildContext(target.userMessage, {
        capabilities,
        model,
        chatTitle: runtimeChatTitleOf(chat),
        chatAddendum: settings.promptAddendum,
        excludeMessageIds: target.excludedReplyId === null ? [] : [target.excludedReplyId],
        dryRun: true,
    });
    const { tools, availability, workspaceState } = createReplyTools(
        model,
        toolContextOf(chat, target.userMessage, built, request.toolApi),
        settings.toolOverrides
    );
    // Mirror the real request: the workspace manifest is part of the volatile
    // tail the model would see, so the panel must show it too.
    await appendWorkspaceTailForReply({
        messages: built.messages,
        triggerTurnIndex: built.triggerTurnIndex,
        workspaceState,
        conversationRootIds: built.conversationRootIds,
        contextIndex: built.contextIndex,
        enabled: availability.workspace,
        handoff: availability.handoff,
        fileTools: availability.file,
        widgetTools: availability.widget,
    });
    const systemPromptReplaced = replacesChatSystemPrompt(model);

    return {
        at: target.userMessage.messageId,
        excludedReplyId: target.excludedReplyId,
        model,
        asModel: request.asModel !== undefined,
        computedAt: request.now.toISOString(),
        systemPrompt: systemPromptReplaced
            ? GEMINI_IMAGE_SYSTEM_INSTRUCTION
            : buildStaticSystemPrompt(model, buildStaticPromptOptions(availability)),
        systemPromptReplaced,
        tools: tools.definitions.map((definition) => definition.name),
        turns: built.messages.map(toModelViewTurn),
        numbers: [...built.contextIndex.values()].map((entry) => ({ number: entry.number, messageId: entry.messageId })),
    };
};
