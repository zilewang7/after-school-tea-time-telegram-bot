/**
 * Keeping the checkpoint of a reply that failed or was stopped (design
 * 2026-1112-1123 §6.3). The only condition is a checkpoint at hand; the kind
 * of error does not matter.
 *
 * The order on both paths: prepare (decide whether the entry is kept, so the
 * metrics row can record it), finalize, keep (store it and mark the reply),
 * draw the buttons. The finalization clears the reply's earlier mark, so the
 * keep must come after it.
 */
import { concatMessages, type RenderedMessage } from 'telegram-md-entities';
import type { AgentToolUsage } from '../../ai/types.js';
import type { ToolLoopCheckpoint, ToolLoopCheckpointSink } from '../../ai/tools/tool-loop-checkpoint.js';
import type { BotMessageSession } from '../../services/bot-message-service.js';
import { recordCheckpointRounds } from '../../services/reply-metrics-draft.js';
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

/** The sink a reply passes to the platform: only the last checkpoint is remembered */
export const checkpointSinkFor = (holder: CheckpointHolder): ToolLoopCheckpointSink => (checkpoint) => {
    holder.lastCheckpoint = checkpoint;
};

/**
 * Before the finalization: the entry this failure or stop will keep, or null
 * (no checkpoint at hand, or one too big to be stored). A kept one is recorded
 * on the metrics draft now, because the finalization writes the row.
 */
export const prepareCheckpointKeep = (
    holder: CheckpointHolder,
    registry: CheckpointRegistry = checkpointRegistry
): PreparedCheckpoint | null => {
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
 * After every finalization, success included: store the prepared entry and
 * mark the reply resumable. The registry has no timers, so this is also where
 * it drops what expired or lost its mark (this finalization cleared the
 * reply's own) instead of holding it until the next click.
 */
export const keepPreparedCheckpoint = (
    prepared: PreparedCheckpoint | null,
    registry: CheckpointRegistry = checkpointRegistry
): void => {
    registry.prune();
    if (prepared !== null) registry.save(prepared);
};

/**
 * A failed reply's version and metrics row count the tools its kept rounds
 * ran; without this every failed row shows no tool calls.
 */
export const fillToolUsageFromCheckpoint = (session: BotMessageSession, checkpoint: ToolLoopCheckpoint): void => {
    const toolUsage: AgentToolUsage[] = checkpoint.toolUsage.map((usage) => ({ ...usage }));
    session.agentStats = { ...session.agentStats, toolUsage };
};

/**
 * A stopped reply has no tool usage of its own unless its stream ended (only
 * the done chunk carries it). With a checkpoint at hand it takes the kept
 * rounds' usage, as a failed one does, so the stopped version shows its tools
 * and its row counts them.
 */
export const fillStoppedToolUsage = (holder: CheckpointHolder): void => {
    const { session, lastCheckpoint } = holder;
    if (lastCheckpoint === undefined) return;
    if ((session.agentStats?.toolUsage?.length ?? 0) > 0) return;
    fillToolUsageFromCheckpoint(session, lastCheckpoint);
};

/** The error message of a failure whose checkpoint was kept says how much of it is kept */
export const withKeptRoundsLine = (message: RenderedMessage, rounds: number): RenderedMessage =>
    concatMessages(message, '\n', italicText(`已保留前 ${rounds} 轮`));
