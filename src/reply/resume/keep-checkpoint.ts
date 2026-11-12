/**
 * Keeping the checkpoint of a reply that failed or was stopped (design
 * 2026-1112-1123 §6.3). The only condition is a checkpoint at hand; the kind
 * of error does not matter.
 *
 * The order on both paths: prepare (decide whether the entry is kept, so the
 * metrics row can record it), finalize, keep (store it and mark the reply),
 * draw the buttons. The finalization clears the reply's earlier mark, so the
 * keep must come after it.
 *
 * Keeping is an extra on top of the reply and fails closed: a step that
 * throws is logged, and the reply goes on as one without a checkpoint (no
 * mark, no "继续"), its error or stop handled as if there had never been one.
 * One trace stays when the store itself throws: the metrics row is written by
 * the finalization, before the store, so it still names the rounds that were
 * about to be kept. The log line is what tells the two apart.
 */
import { concatMessages, type RenderedMessage } from 'telegram-md-entities';
import type { AgentToolUsage } from '../../ai/types.js';
import type { ToolLoopCheckpoint, ToolLoopCheckpointSink } from '../../ai/tools/tool-loop-checkpoint.js';
import type { BotMessageSession } from '../../services/bot-message-service.js';
import { recordCheckpointRounds } from '../../services/reply-metrics-draft.js';
import { clearReplyResumable } from '../../state.js';
import { italicText } from '../../telegram/formatters/entity-text.js';
import { checkpointRegistry, type CheckpointRegistry, type PreparedCheckpoint } from './checkpoint-registry.js';
import type { ReplyResumeFacts } from './reply-checkpoint.js';

/** What a running reply holds for a later keep; the ChatContext is one */
export interface CheckpointHolder {
    readonly session: BotMessageSession;
    /** The last checkpoint the tool loop handed over */
    lastCheckpoint?: ToolLoopCheckpoint;
    /** Captured where the context and the tools were built */
    resumeFacts?: ReplyResumeFacts;
}

const logKeepFailure = (error: unknown): void => {
    console.error(`[resume] keeping the checkpoint failed: ${error instanceof Error ? error.message : String(error)}`);
};

/**
 * A step failed: this reply keeps nothing. Without its facts a holder never
 * prepares an entry, and an older checkpoint must not be kept either: it
 * would run the rounds after it again.
 */
const giveUpKeeping = (holder: CheckpointHolder, error: unknown): void => {
    logKeepFailure(error);
    holder.resumeFacts = undefined;
};

/**
 * The sink a reply passes to the platform: only the last checkpoint is
 * remembered. The tool loop calls it in the middle of the reply, which a
 * failure here must not end.
 */
export const checkpointSinkFor = (holder: CheckpointHolder): ToolLoopCheckpointSink => (checkpoint) => {
    try {
        holder.lastCheckpoint = checkpoint;
    } catch (error) {
        giveUpKeeping(holder, error);
    }
};

const prepareEntry = (holder: CheckpointHolder, registry: CheckpointRegistry): PreparedCheckpoint | null => {
    const { session, lastCheckpoint, resumeFacts } = holder;
    if (lastCheckpoint === undefined || resumeFacts === undefined) return null;
    if (lastCheckpoint.completedRounds < 1) return null;
    const prepared = registry.prepare({
        ...resumeFacts,
        chatId: session.chatId,
        firstMessageId: session.firstMessageId,
        userMessageId: session.userMessageId,
        loop: lastCheckpoint,
        // The version this finalization is about to store
        failedVersionId: session.versionCount + 1,
        savedAt: Date.now(),
    });
    if (prepared !== null) recordCheckpointRounds(session.metrics, lastCheckpoint.completedRounds);
    return prepared;
};

/**
 * Before the finalization: the entry this failure or stop will keep, or null
 * (no checkpoint at hand, one too big to be stored, or a step failed). A kept
 * one is recorded on the metrics draft now, because the finalization writes
 * the row.
 */
export const prepareCheckpointKeep = (
    holder: CheckpointHolder,
    registry: CheckpointRegistry = checkpointRegistry
): PreparedCheckpoint | null => {
    try {
        return prepareEntry(holder, registry);
    } catch (error) {
        giveUpKeeping(holder, error);
        return null;
    }
};

/**
 * A failed reply's version and metrics row count the tools its kept rounds
 * ran; without this every failed row shows no tool calls.
 */
const fillToolUsageFromCheckpoint = (session: BotMessageSession, checkpoint: ToolLoopCheckpoint): void => {
    const toolUsage: AgentToolUsage[] = checkpoint.toolUsage.map((usage) => ({ ...usage }));
    session.agentStats = { ...session.agentStats, toolUsage };
};

/**
 * Before an error's finalization: with a checkpoint at hand the failed
 * version and its row count the tools of the kept rounds (kept or not), then
 * the entry is prepared as prepareCheckpointKeep does
 */
export const prepareErrorKeep = (
    holder: CheckpointHolder,
    registry: CheckpointRegistry = checkpointRegistry
): PreparedCheckpoint | null => {
    try {
        if (holder.lastCheckpoint !== undefined) fillToolUsageFromCheckpoint(holder.session, holder.lastCheckpoint);
        return prepareEntry(holder, registry);
    } catch (error) {
        giveUpKeeping(holder, error);
        return null;
    }
};

/**
 * After every finalization, success included: store the prepared entry and
 * mark the reply resumable; the entry when it is kept. The registry has no
 * timers, so this is also where it drops what expired or lost its mark (this
 * finalization cleared the reply's own) instead of holding it until the next
 * click.
 */
export const keepPreparedCheckpoint = (
    prepared: PreparedCheckpoint | null,
    registry: CheckpointRegistry = checkpointRegistry
): PreparedCheckpoint | null => {
    try {
        registry.prune();
        if (prepared === null) return null;
        registry.save(prepared);
        return prepared;
    } catch (error) {
        logKeepFailure(error);
        // However far the save got, the reply offers no "继续"
        if (prepared !== null) {
            const { chatId, firstMessageId, failedVersionId } = prepared.checkpoint;
            clearReplyResumable(chatId, firstMessageId, failedVersionId);
        }
        return null;
    }
};

/**
 * A stopped reply has no tool usage of its own unless its stream ended (only
 * the done chunk carries it). With a checkpoint at hand it takes the kept
 * rounds' usage, as a failed one does, so the stopped version shows its tools
 * and its row counts them.
 */
export const fillStoppedToolUsage = (holder: CheckpointHolder): void => {
    try {
        const { session, lastCheckpoint } = holder;
        if (lastCheckpoint === undefined) return;
        if ((session.agentStats?.toolUsage?.length ?? 0) > 0) return;
        fillToolUsageFromCheckpoint(session, lastCheckpoint);
    } catch (error) {
        giveUpKeeping(holder, error);
    }
};

/** The error message of a failure whose checkpoint was kept says how much of it is kept */
export const withKeptRoundsLine = (message: RenderedMessage, rounds: number): RenderedMessage =>
    concatMessages(message, '\n', italicText(`已保留前 ${rounds} 轮`));
