/**
 * The `metrics` of the reply detail (design §6.2): every reply_metrics row of
 * one reply, grouped by the version it wrote. A version without a row was
 * generated before metrics existed, or its write failed: the page shows
 * "no metrics". Observers get no triggerUserId (the key is absent), nor any
 * other per-person field added later.
 *
 * Units: times ISO, durations milliseconds, cost USD at list price.
 */
import { findPriceAt } from '../../config/model-pricing.js';
import type {
    ReplyMetricRecord,
    ReplyOutcome,
    RequestedTier,
    ToolUsageEntry,
} from '../../db/queries/reply-metrics.js';
import { findReplyMetricsByReply, type UsageGroupRow } from '../../db/queries/reply-metrics.js';
import type { ErrorKind } from '../../shared/error-kind.js';
import { priceUsageGroup, type PricingFlag } from '../stats/cost-estimate.js';
import { durationMsOf, firstChunkMsOf, hasUsage } from '../stats/metric-samples.js';
import type { VisibleAccess } from '../types.js';
import { roundUsd } from './stats-view.js';

export interface ReplyMetricView {
    readonly id: number;
    readonly versionId: number;
    readonly model: string;
    readonly platform: string;
    readonly route: string | null;
    readonly commandType: string;
    readonly isRetry: boolean;
    readonly startedAt: string;
    readonly requestStartedAt: string | null;
    readonly firstChunkAt: string | null;
    readonly finishedAt: string;
    /** firstChunkAt - requestStartedAt */
    readonly firstChunkMs: number | null;
    /** finishedAt - startedAt */
    readonly durationMs: number;
    readonly outcome: ReplyOutcome;
    readonly errorKind: ErrorKind | null;
    readonly errorSummary: string | null;
    readonly rounds: number | null;
    readonly toolCalls: number;
    readonly toolFailures: number;
    readonly toolUsage: readonly ToolUsageEntry[];
    readonly promptTokens: number | null;
    readonly cachedTokens: number | null;
    readonly cacheWriteTokens: number | null;
    readonly outputTokens: number | null;
    readonly thoughtsTokens: number | null;
    readonly imageOutputTokens: number | null;
    readonly contextMessages: number | null;
    readonly contextImages: number | null;
    readonly textChars: number | null;
    readonly thinkingChars: number | null;
    readonly hasImage: boolean;
    readonly imageCount: number;
    readonly hasSticker: boolean;
    readonly hasFile: boolean;
    /** Failed round attempts retried automatically; null when none was */
    readonly roundRetries: number | null;
    /** 'priority' when the Priority PayGo header went out; null otherwise */
    readonly tierRequested: RequestedTier | null;
    /** Rounds served at the priority tier and their tokens; null when none was */
    readonly priorityRounds: number | null;
    readonly priorityPromptTokens: number | null;
    readonly priorityCachedTokens: number | null;
    readonly priorityOutputTokens: number | null;
    /** Rounds carried over from a checkpoint; null when the attempt is not a resume */
    readonly resumedRounds: number | null;
    /** Rounds the checkpoint saved when this attempt failed or stopped; null when none was saved */
    readonly checkpointRounds: number | null;
    /** The chat's thinking level when the attempt started; null = the model default */
    readonly thinkingEffortRequested: string | null;
    /** The level actually sent after clamping/fallback; null = nothing explicit went out */
    readonly thinkingEffortSent: string | null;
    /** The degradation chain, e.g. 'xhigh->high'; null = none */
    readonly thinkingEffortFallback: string | null;
    /**
     * This attempt alone, priced like the statistics (priority rounds at the
     * priority price); null when unpriced or without usage
     */
    readonly costUsd: number | null;
    readonly pricing: PricingFlag;
    /** Priority rounds priced at the standard price: the model has no priority price */
    readonly priorityAtStandardPrice: boolean;
}

/** Members also see who triggered the attempt */
export interface MemberReplyMetricView extends ReplyMetricView {
    readonly triggerUserId: number | null;
}

/** versionId → that version's rows, oldest first (normally exactly one) */
export type ReplyMetricsByVersion = ReadonlyMap<number, readonly ReplyMetricView[]>;

/** One row as a cost group of its own, so the same pricing rules apply */
const asUsageGroup = (row: ReplyMetricRecord): UsageGroupRow => {
    const withUsage = hasUsage(row);
    const tokens = (value: number | null): number => (withUsage ? value ?? 0 : 0);
    return {
        model: row.model,
        route: row.route,
        replies: 1,
        repliesWithUsage: withUsage ? 1 : 0,
        promptTokens: tokens(row.promptTokens),
        cachedTokens: tokens(row.cachedTokens),
        cacheWriteTokens: tokens(row.cacheWriteTokens),
        outputTokens: tokens(row.outputTokens),
        thoughtsTokens: tokens(row.thoughtsTokens),
        imageOutputTokens: tokens(row.imageOutputTokens),
        unsplitImageOutputTokens:
            withUsage && row.imageOutputTokens === null && row.imageCount > 0 ? row.outputTokens ?? 0 : 0,
        imagesWithoutUsage: withUsage ? 0 : row.imageCount,
        imageRowsWithoutUsage: !withUsage && row.imageCount > 0 ? 1 : 0,
        // Same rules as the SQL aggregate: rounds always, tokens only with usage
        priorityRounds: row.priorityRounds ?? 0,
        priorityPromptTokens: tokens(row.priorityPromptTokens),
        priorityCachedTokens: tokens(row.priorityCachedTokens),
        priorityOutputTokens: tokens(row.priorityOutputTokens),
    };
};

export const toReplyMetricView = (row: ReplyMetricRecord): ReplyMetricView => {
    // This attempt alone, at the price in force when it started (design §4.2)
    const priced = priceUsageGroup(asUsageGroup(row), findPriceAt(row.model, row.startedAt));
    return {
        id: row.id,
        versionId: row.versionId,
        model: row.model,
        platform: row.platform,
        route: row.route,
        commandType: row.commandType,
        isRetry: row.isRetry,
        startedAt: row.startedAt.toISOString(),
        requestStartedAt: row.requestStartedAt?.toISOString() ?? null,
        firstChunkAt: row.firstChunkAt?.toISOString() ?? null,
        finishedAt: row.finishedAt.toISOString(),
        firstChunkMs: firstChunkMsOf(row),
        durationMs: durationMsOf(row),
        outcome: row.outcome,
        errorKind: row.errorKind,
        errorSummary: row.errorSummary,
        rounds: row.rounds,
        toolCalls: row.toolCalls,
        toolFailures: row.toolFailures,
        toolUsage: row.toolUsage,
        promptTokens: row.promptTokens,
        cachedTokens: row.cachedTokens,
        cacheWriteTokens: row.cacheWriteTokens,
        outputTokens: row.outputTokens,
        thoughtsTokens: row.thoughtsTokens,
        imageOutputTokens: row.imageOutputTokens,
        contextMessages: row.contextMessages,
        contextImages: row.contextImages,
        textChars: row.textChars,
        thinkingChars: row.thinkingChars,
        hasImage: row.hasImage,
        imageCount: row.imageCount,
        hasSticker: row.hasSticker,
        hasFile: row.hasFile,
        roundRetries: row.roundRetries,
        tierRequested: row.tierRequested,
        priorityRounds: row.priorityRounds,
        priorityPromptTokens: row.priorityPromptTokens,
        priorityCachedTokens: row.priorityCachedTokens,
        priorityOutputTokens: row.priorityOutputTokens,
        resumedRounds: row.resumedRounds,
        checkpointRounds: row.checkpointRounds,
        thinkingEffortRequested: row.thinkingEffortRequested,
        thinkingEffortSent: row.thinkingEffortSent,
        thinkingEffortFallback: row.thinkingEffortFallback,
        costUsd: roundUsd(priced.costUsd),
        pricing: priced.pricing,
        priorityAtStandardPrice: priced.priorityAtStandardPrice,
    };
};

const viewFor = (row: ReplyMetricRecord, access: VisibleAccess): ReplyMetricView | MemberReplyMetricView =>
    access === 'member' ? { ...toReplyMetricView(row), triggerUserId: row.triggerUserId } : toReplyMetricView(row);

/**
 * For the reply detail route (phase 2): `access` is the requester's level for
 * the chat, already checked by the route; `firstMessageId` the reply's key.
 */
export const listReplyMetricsByReply = async (
    chatId: number,
    firstMessageId: number,
    options: { readonly access: VisibleAccess }
): Promise<ReplyMetricsByVersion> => {
    const rows = await findReplyMetricsByReply(chatId, firstMessageId);
    const byVersion = new Map<number, ReplyMetricView[]>();
    for (const row of rows) {
        const list = byVersion.get(row.versionId) ?? [];
        list.push(viewFor(row, options.access));
        byVersion.set(row.versionId, list);
    }
    return byVersion;
};
