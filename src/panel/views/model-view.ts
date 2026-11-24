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
 * both the declared tool names and the static head's capability lines.
 */
import type { Api } from 'grammy';
import { capabilitiesOf, resolveRuntimeTraits } from '../../ai/model-traits.js';
import { buildStaticSystemPrompt } from '../../ai/system-prompt/index.js';
import type { ChatRow } from '../../db/queries/panel-registry.js';
import type { Message } from '../../db/messageDTO.js';
import { buildContext, type BuiltContext } from '../../reply/context-builder.js';
import { buildStaticPromptOptions } from '../../reply/static-prompt-options.js';
import { createReplyTools } from '../../reply/tools/create-reply-tools.js';
import { appendWorkspaceTailForReply } from '../../reply/workspace/workspace-tail.js';
import type { ReplyToolContext } from '../../reply/tools/reply-tool-context.js';
import { snapshotReplySettings } from '../../services/chat-settings-service.js';
import { resolveReplyAddendum } from '../../services/prompt-templates-service.js';
import { runtimeChatTitleOf } from './chat-view.js';
import { toModelViewTurn, type ModelViewTurn } from './model-view-parts.js';
import { resolveModelViewTarget } from './model-view-target.js';

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
    /** The static head (preference layer included) */
    systemPrompt: string;
    /** Tool names declared this turn, in declaration order */
    tools: string[];
    turns: ModelViewTurn[];
    /** `#N` → message id, as this context numbers them */
    numbers: Array<{ number: number; messageId: number }>;
    /** Prompt templates this request would load (auto ones follow the model) */
    addendumTemplates: Array<{ id: number; name: string }>;
    /** The chat's own addendum text is part of the runtime block too */
    addendumCustom: boolean;
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
    const capabilities = capabilitiesOf(resolveRuntimeTraits(model));
    // The same combination the reply would send: a different model can load
    // other auto templates, which is the point of looking at `asModel`.
    const addendum = await resolveReplyAddendum(
        chat.chatId,
        {
            custom: settings.promptAddendum,
            templateIds: settings.promptTemplateIds,
            auto: settings.promptTemplatesAuto,
        },
        model
    );

    const built = await buildContext(target.userMessage, {
        capabilities,
        model,
        chatTitle: runtimeChatTitleOf(chat),
        chatAddendum: addendum.text,
        excludeMessageIds: target.excludedReplyId === null ? [] : [target.excludedReplyId],
        dryRun: true,
    });
    const { tools, availability, workspaceState, availableSkills } = createReplyTools(
        model,
        toolContextOf(chat, target.userMessage, built, request.toolApi),
        settings.toolOverrides,
        'full',
        undefined,
        capabilities
    );
    // Mirror the real request: the skill catalog, workspace manifest and
    // rich-reply notes are part of the volatile tail the model would see, so
    // the panel must show them too.
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
        richInlineImages: settings.richReplies === true && availability.sendImage,
        richReplies: settings.richReplies,
        availableSkills,
    });

    return {
        at: target.userMessage.messageId,
        excludedReplyId: target.excludedReplyId,
        model,
        asModel: request.asModel !== undefined,
        computedAt: request.now.toISOString(),
        systemPrompt: buildStaticSystemPrompt(model, buildStaticPromptOptions(availability), capabilities),
        tools: tools.definitions.map((definition) => definition.name),
        turns: built.messages.map(toModelViewTurn),
        numbers: [...built.contextIndex.values()].map((entry) => ({ number: entry.number, messageId: entry.messageId })),
        addendumTemplates: addendum.applied.map((template) => ({ id: template.id, name: template.name })),
        addendumCustom: addendum.customIncluded,
    };
};
