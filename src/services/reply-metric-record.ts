/**
 * The reply_metrics row of one finalized attempt: built from the session and
 * from what finalize just stored, then written. Writing it never fails the
 * finalize; a lost row only shows as "no metrics" in the panel.
 */
import { match } from 'ts-pattern';
import type { AgentStats } from '../ai/types.js';
import {
    insertReplyMetric,
    type ReplyMetricInput,
    type ReplyOutcome,
    type ToolUsageEntry,
} from '../db/queries/reply-metrics.js';
import { summarizeErrorMessage, type ErrorKind } from '../shared/error-kind.js';
import { to } from '../shared/result.js';
import type { ReplyMetricsDraft } from './reply-metrics-draft.js';

/** The parts of a bot message session the row is built from */
export interface ReplyMetricSource {
    readonly chatId: number;
    readonly userMessageId: number;
    readonly firstMessageId: number;
    readonly model: string;
    readonly isRetry: boolean;
    /** The stored reply text */
    readonly textBuffer: string;
    /** Delivered images only: a failed send or an error clears them */
    readonly images: readonly Buffer[];
    readonly sticker?: unknown;
    readonly file?: unknown;
    readonly agentStats?: AgentStats;
    readonly metrics: ReplyMetricsDraft;
}

/** What finalize stored for this attempt */
export interface FinalizedAttempt {
    readonly versionId: number;
    readonly errorMessage: string | undefined;
    readonly errorKind: ErrorKind | undefined;
    readonly wasStoppedByUser: boolean;
    readonly finishedAt: Date;
}

interface OutcomeFacts {
    readonly failed: boolean;
    readonly stopped: boolean;
    readonly imageCommand: boolean;
    readonly imageCount: number;
    readonly hasText: boolean;
    readonly hasAttachment: boolean;
}

/**
 * error > stopped > empty > ok. Empty: nothing went out, a reply of thinking
 * only included; an image command that drew nothing is empty whatever it said.
 */
const outcomeOf = (facts: OutcomeFacts): ReplyOutcome =>
    match(facts)
        .returnType<ReplyOutcome>()
        .with({ failed: true }, () => 'error')
        .with({ stopped: true }, () => 'stopped')
        .with({ imageCommand: true, imageCount: 0 }, () => 'empty')
        .with({ hasText: false, hasAttachment: false }, () => 'empty')
        .otherwise(() => 'ok');

const toolUsageOf = (agentStats: AgentStats | undefined): ToolUsageEntry[] =>
    (agentStats?.toolUsage ?? []).map((usage) => ({
        name: usage.name,
        count: usage.count,
        failed: usage.failed ?? 0,
    }));

export const buildReplyMetricInput = (source: ReplyMetricSource, attempt: FinalizedAttempt): ReplyMetricInput => {
    const { metrics } = source;
    const usage = metrics.usage.totals();
    const toolUsage = toolUsageOf(source.agentStats);
    const failed = attempt.errorMessage !== undefined;
    const imageCount = source.images.length;
    const hasSticker = source.sticker !== undefined;
    const hasFile = source.file !== undefined;

    return {
        chatId: source.chatId,
        userMessageId: source.userMessageId,
        firstMessageId: source.firstMessageId,
        versionId: attempt.versionId,
        triggerUserId: metrics.triggerUserId,
        model: source.model,
        platform: metrics.platform,
        route: usage.route,
        commandType: metrics.commandType,
        isRetry: source.isRetry,
        startedAt: metrics.startedAt,
        requestStartedAt: metrics.requestStartedAt,
        firstChunkAt: metrics.firstChunkAt,
        finishedAt: attempt.finishedAt,
        outcome: outcomeOf({
            failed,
            stopped: attempt.wasStoppedByUser,
            imageCommand: metrics.commandType !== 'chat',
            imageCount,
            hasText: source.textBuffer.trim() !== '',
            hasAttachment: imageCount > 0 || hasSticker || hasFile,
        }),
        errorKind: failed ? attempt.errorKind ?? 'other' : null,
        errorSummary: attempt.errorMessage === undefined ? null : summarizeErrorMessage(attempt.errorMessage),
        rounds: usage.rounds,
        toolCalls: toolUsage.reduce((sum, entry) => sum + entry.count, 0),
        toolFailures: toolUsage.reduce((sum, entry) => sum + entry.failed, 0),
        toolUsage,
        promptTokens: usage.promptTokens,
        cachedTokens: usage.cachedTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        outputTokens: usage.outputTokens,
        thoughtsTokens: usage.thoughtsTokens,
        imageOutputTokens: usage.imageOutputTokens,
        contextMessages: metrics.contextMessages,
        contextImages: metrics.contextImages,
        textChars: source.textBuffer.length,
        thinkingChars: metrics.thinkingChars,
        hasImage: imageCount > 0,
        imageCount,
        hasSticker,
        hasFile,
    };
};

/** Build and write the row; a failure is logged, never thrown */
export const recordReplyMetric = async (source: ReplyMetricSource, attempt: FinalizedAttempt): Promise<void> => {
    const [error] = await to(
        Promise.resolve().then(() => insertReplyMetric(buildReplyMetricInput(source, attempt)))
    );
    if (error) {
        console.error(
            `[reply-metrics] could not record reply ${source.chatId}/${source.firstMessageId} v${attempt.versionId}:`,
            error
        );
    }
};
