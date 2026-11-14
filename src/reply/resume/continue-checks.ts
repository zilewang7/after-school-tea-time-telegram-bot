/**
 * The checks of a "继续" click (design 2026-1112-1123 §6.4), in the order of
 * the design's table. They only look at the kept checkpoint; the caller acts
 * on the outcome. Two outcomes mean the checkpoint can never be continued
 * (gone); the others are conditions that may hold again later (keep), so the
 * checkpoint, its mark and the buttons are left as they are.
 *
 * The model and the tier follow the retry's rule: the chat's settings at the
 * moment of the click, and the tier of whoever pressed the button (it is
 * their turn that is billed). An edit of a context message blocks nothing
 * (D11): the continue sends the request as it was.
 */
import type { Api, Context } from 'grammy';
import type { Chat } from 'grammy/types';
import { buildStaticSystemPrompt } from '../../ai/index.js';
import type { BotResponse } from '../../db/index.js';
import { loadContextExclusions } from '../../db/queries/context-queries.js';
import { effectiveReplyModel, resolveAccessTier, type AccessTier } from '../../services/access-tier.js';
import { snapshotReplySettings, type ReplySettingsSnapshot } from '../../services/chat-settings-service.js';
import { resumableMarkOf } from '../../state.js';
import { isCallbackChatPaused, PAUSED_CALLBACK_NOTICE } from '../chat-pause.js';
import { buildStaticPromptOptions } from '../static-prompt-options.js';
import { buildReplyToolContext, createReplyTools } from '../tools/index.js';
import { toolDefinitionsJsonOf } from './canonical-json.js';
import type { CheckpointRegistry } from './checkpoint-registry.js';
import type { ReplyCheckpoint } from './reply-checkpoint.js';
import {
    thinkingEffortRefusalNoticeOf,
    THINKING_EFFORT_CHANGED_NOTICE,
    THINKING_EFFORT_DATA_CHANGED_NOTICE,
} from './resume-facts.js';
export { THINKING_EFFORT_CHANGED_NOTICE, THINKING_EFFORT_DATA_CHANGED_NOTICE };

export const CHECKPOINT_GONE_NOTICE = '检查点已失效，请点重试';
export const SWITCH_TO_LATEST_NOTICE = '请先切回最新版本再继续';
export const MODEL_CHANGED_NOTICE = '当前模型与中断时不同，切回后可继续，或点重试';
export const TOOLS_CHANGED_NOTICE = '工具或提示词设置与中断时不同，恢复后可继续，或点重试';
export const ADDENDUM_CHANGED_NOTICE = '会话提示词已修改，改回后可继续，或点重试';
export const CONTEXT_EXCLUDED_NOTICE = '上下文里有消息已被移出，移回后可继续，或点重试';

/** What the click resumes with, decided once by the checks */
export interface ResumePlan {
    readonly model: string;
    /** The presser's tier */
    readonly access: AccessTier;
    /** The chat's settings as the click found them; the resumed request uses the same */
    readonly settings: ReplySettingsSnapshot;
}

export type ContinueCheck =
    | { readonly kind: 'ready'; readonly plan: ResumePlan }
    /**
     * missing: no entry, or it expired or lost its mark; superseded: the
     * failed version is no longer the latest one
     */
    | { readonly kind: 'gone'; readonly cause: 'missing' | 'superseded' }
    | { readonly kind: 'keep'; readonly notice: string };

const keep = (notice: string): ContinueCheck => ({ kind: 'keep', notice });

/** The entry, only while the mark still points at the version it was kept for */
const markedEntryOf = (registry: CheckpointRegistry, response: BotResponse): ReplyCheckpoint | undefined => {
    const entry = registry.peek(response.chatId, response.messageId);
    if (entry === undefined) return undefined;
    const mark = resumableMarkOf(response.chatId, response.messageId);
    return mark?.versionId === entry.failedVersionId ? entry : undefined;
};

/**
 * The tool definitions and the system prompt this click would send, built as
 * the reply would build them now and compared with the checkpoint's. The
 * tools are thrown away: their signal never fires and they never run. The
 * definitions do not depend on who wrote the trigger, so it is not read here.
 */
const sameToolsAndPrompt = (chat: Chat, api: Api, entry: ReplyCheckpoint, plan: ResumePlan): boolean => {
    const { tools, availability } = createReplyTools(
        plan.model,
        buildReplyToolContext({
            chat,
            triggerMessage: { messageId: entry.userMessageId, userId: null, userName: '', text: null },
            contextIndex: entry.context.contextIndex,
            conversationRootIds: entry.context.conversationRootIds,
            signal: new AbortController().signal,
            api,
        }),
        plan.settings.toolOverrides,
        plan.access
    );
    const systemPrompt = buildStaticSystemPrompt(plan.model, buildStaticPromptOptions(availability));
    return (
        toolDefinitionsJsonOf(tools.definitions) === entry.request.toolDefinitionsJson &&
        systemPrompt === entry.request.systemPrompt
    );
};

/** Whether a message of the stored context was taken out of the context in the panel since */
const anyContextMessageExcluded = async (entry: ReplyCheckpoint): Promise<boolean> => {
    const exclusions = await loadContextExclusions(entry.chatId);
    return entry.context.contextMessageIds.some((messageId) => exclusions.has(messageId));
};

export const checkContinue = async (
    ctx: Context,
    response: BotResponse,
    registry: CheckpointRegistry
): Promise<ContinueCheck> => {
    const entry = markedEntryOf(registry, response);
    if (entry === undefined) return { kind: 'gone', cause: 'missing' };

    const versions = response.getVersions();
    if (versions.at(-1)?.versionId !== entry.failedVersionId) return { kind: 'gone', cause: 'superseded' };
    if (versions[response.currentVersionIndex]?.versionId !== entry.failedVersionId) {
        return keep(SWITCH_TO_LATEST_NOTICE);
    }
    if (isCallbackChatPaused(ctx)) return keep(PAUSED_CALLBACK_NOTICE);

    const settings = snapshotReplySettings(response.chatId);
    // In an access group the click itself proves membership; elsewhere this asks Telegram
    const access = await resolveAccessTier(ctx.from?.id ?? null, response.chatId);
    const plan: ResumePlan = { model: effectiveReplyModel(access, settings.model), access, settings };
    // Thought signatures belong to the model that wrote them
    if (plan.model !== entry.request.model) return keep(MODEL_CHANGED_NOTICE);
    // The thinking level is part of the request shape the checkpoint expects;
    // the notice names whether the chat's setting or the model data changed
    const thinkingRefusal = thinkingEffortRefusalNoticeOf(settings, entry.request);
    if (thinkingRefusal !== null) return keep(thinkingRefusal);
    const chat = ctx.chat;
    if (chat === undefined || !sameToolsAndPrompt(chat, ctx.api, entry, plan)) return keep(TOOLS_CHANGED_NOTICE);
    if (settings.promptAddendum !== entry.context.promptAddendum) return keep(ADDENDUM_CHANGED_NOTICE);
    if (await anyContextMessageExcluded(entry)) return keep(CONTEXT_EXCLUDED_NOTICE);
    // Rich replies are not compared: presentation only, the request stays the same

    return { kind: 'ready', plan };
};
