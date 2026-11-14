/**
 * A reply picked up from its kept checkpoint (design 2026-1112-1123 §6.5).
 * It runs like a retry, a new version in the same messages, with one
 * difference: nothing of the context is rebuilt. The request is the one the
 * checkpoint had ready, the tools get the state the interrupted version left,
 * and the platform replays what that version showed before it goes on.
 *
 * The checkpoint stays recoverable throughout. Until a new session exists, a
 * failure puts it back as it was. From then on the new ChatContext starts out
 * holding it, so a failure or a stop before the loop hands over a newer one
 * keeps the same checkpoint again, on the new version, through the normal
 * save paths.
 */
import type { Context } from 'grammy';
import { isOpenCodeGoModel, openCodeGoSessionId, sendMessage } from '../../ai/index.js';
import { getMessage } from '../../db/index.js';
import type { BotMessageSession } from '../../services/bot-message-service.js';
import { startRetry } from '../../services/index.js';
import {
    markRequestStarted,
    recordContextSize,
    recordResumedRounds,
    recordThinkingEffort,
} from '../../services/reply-metrics-draft.js';
import { to } from '../../shared/result.js';
import { setContextNumbering } from '../../state.js';
import { resolveContextRoot } from '../context-root.js';
import { priorityRequestOf } from '../priority-request.js';
import { thinkingRequestOf } from '../thinking-request.js';
import {
    createChatContextForRetry,
    handleResponseError,
    processStream,
    sendFinalResponse,
    type ChatContext,
} from '../response-handler.js';
import { buildReplyToolContext, createReplyTools } from '../tools/index.js';
import type { CheckpointRegistry } from './checkpoint-registry.js';
import type { ResumePlan } from './continue-checks.js';
import { checkpointSinkFor } from './keep-checkpoint.js';
import type { ReplyCheckpoint, ReplyResumeFacts } from './reply-checkpoint.js';

const factsOf = (entry: ReplyCheckpoint): ReplyResumeFacts => ({
    toolState: entry.toolState,
    context: entry.context,
    request: entry.request,
});

/**
 * The new attempt starts out as the interrupted one ended: its checkpoint at
 * hand, and on the metrics the rounds and tool calls that are not its own
 */
const seedFromCheckpoint = (chatContext: ChatContext, entry: ReplyCheckpoint): void => {
    chatContext.lastCheckpoint = entry.loop;
    chatContext.resumeFacts = factsOf(entry);
    recordResumedRounds(chatContext.session.metrics, entry.loop.completedRounds, entry.loop.toolUsage);
};

/** From the trigger read to the final delivery; every failure ends in handleResponseError */
const continueFromCheckpoint = async (
    ctx: Context,
    chatContext: ChatContext,
    entry: ReplyCheckpoint,
    plan: ResumePlan
): Promise<void> => {
    const { session } = chatContext;
    const { chatId, userMessageId } = entry;

    // The tools still act for the trigger's author
    const [msgErr, userMessage] = await to(getMessage(chatId, userMessageId));
    if (msgErr || !userMessage) {
        console.error('[resume] Failed to get user message:', msgErr);
        await handleResponseError(chatContext, msgErr ?? new Error('Original user message not found'));
        return;
    }
    const chat = ctx.chat;
    if (chat === undefined) {
        await handleResponseError(chatContext, new Error('The click carries no chat'));
        return;
    }

    // The `#N` links of the replayed text and of what follows resolve
    // against the context the checkpoint was built on
    setContextNumbering(chatId, userMessageId, new Map(entry.context.numbering));
    recordContextSize(session.metrics, entry.context.contextIndex);

    const { model } = plan;
    const openCodeGoSession = isOpenCodeGoModel(model)
        ? openCodeGoSessionId(chatId, await resolveContextRoot(chatId, userMessageId))
        : null;

    // The checkpoint's tool state, this attempt's signal and Bot API. No
    // workspace manifest is added: round 1 of the checkpoint already carries it
    const signal = session.streamController.signal;
    const { tools } = createReplyTools(
        model,
        buildReplyToolContext({
            chat,
            triggerMessage: userMessage,
            contextIndex: entry.context.contextIndex,
            conversationRootIds: entry.context.conversationRootIds,
            signal,
            api: ctx.api,
        }),
        plan.settings.toolOverrides,
        plan.access,
        entry.toolState
    );

    // The continue validated the setting against the checkpoint, so this is the
    // same thinking level the interrupted version asked for
    const thinking = thinkingRequestOf(model, plan.settings.thinkingEffort);
    recordThinkingEffort(session.metrics, thinking.facts);

    markRequestStarted(session.metrics);
    const [streamErr, stream] = await to(
        sendMessage([], {
            model,
            // Checked equal to what this click would build
            systemPrompt: entry.request.systemPrompt,
            ...(openCodeGoSession ? { sessionId: openCodeGoSession } : {}),
            signal,
            tools,
            usageSink: session.metrics.usage,
            checkpointSink: checkpointSinkFor(chatContext),
            resumeFrom: entry.loop,
            ...priorityRequestOf(plan.access, plan.settings.geminiPriority),
            ...thinking.platform,
        })
    );
    if (streamErr) {
        console.error('[resume] Failed to send message:', streamErr);
        await handleResponseError(chatContext, streamErr);
        return;
    }

    const [processErr, response] = await to(processStream(stream, chatContext));
    if (processErr) {
        console.error('[resume] Failed to process stream:', processErr);
        await handleResponseError(chatContext, processErr);
        return;
    }

    const [sendErr] = await to(sendFinalResponse(chatContext, response));
    if (sendErr) {
        console.error('[resume] Failed to send final response:', sendErr);
    }
};

/** startRetry, with the checkpoint put back when no new session came of it */
const startResumedSession = async (
    ctx: Context,
    entry: ReplyCheckpoint,
    plan: ResumePlan,
    registry: CheckpointRegistry
): Promise<BotMessageSession | null> => {
    const [startErr, session] = await to(startRetry(ctx, entry.firstMessageId, { model: plan.model }));
    if (startErr || !session) {
        console.error('[resume] Failed to start the resumed version; the checkpoint is kept:', startErr);
        registry.putBack(entry);
        return null;
    }
    return session;
};

/**
 * Run a taken checkpoint to the end of its new version. It deletes the
 * interrupted version's other messages (a stopped version's attachments
 * among them) and streams into the first one, as a retry does.
 */
export const resumeReply = async (
    ctx: Context,
    entry: ReplyCheckpoint,
    plan: ResumePlan,
    registry: CheckpointRegistry
): Promise<void> => {
    console.log(
        `[resume] continuing chat=${entry.chatId} first=${entry.firstMessageId} version=${entry.failedVersionId} rounds=${entry.loop.completedRounds}`
    );
    const session = await startResumedSession(ctx, entry, plan, registry);
    if (session === null) return;

    // The switch as the click found it: presentation only, the checks never compare it
    const chatContext = createChatContextForRetry(ctx, session, 'chat', { richReplies: plan.settings.richReplies });
    seedFromCheckpoint(chatContext, entry);

    const [flowErr] = await to(continueFromCheckpoint(ctx, chatContext, entry, plan));
    // Something the flow did not expect: still end the version, keeping the checkpoint
    if (flowErr && !chatContext.isFinalized) {
        console.error('[resume] Resumed reply failed unexpectedly:', flowErr);
        await handleResponseError(chatContext, flowErr);
    } else if (flowErr) {
        console.error('[resume] Resumed reply failed after its final delivery:', flowErr);
    }
};
