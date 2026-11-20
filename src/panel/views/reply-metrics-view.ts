/**
 * The `metrics` of the reply detail (design §6.2): every reply_metrics row of
 * one reply, grouped by the version it wrote. A version without a row was
 * generated before metrics existed, or its write failed: the page shows
 * "no metrics". Observers get no triggerUserId (the key is absent), nor any
 * other per-person field added later.
 *
 * Units: times ISO, durations milliseconds, cost USD at list price.
 */
import type {
    CapabilityEvent,
    ReplyMetricRecord,
    ReplyOutcome,
    RequestedTier,
    ToolUsageEntry,
} from '../../db/queries/reply-metrics.js';
import { findReplyMetricsByReply } from '../../db/queries/reply-metrics.js';
import { imageGenerationCostUsd, replyRowCostUsd, type PricingFlag } from '../../services/usage-cost.js';
import type { ErrorKind } from '../../shared/error-kind.js';
import { durationMsOf, firstChunkMsOf } from '../stats/metric-samples.js';
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
     * This attempt alone: chat tokens + the pictures it drew, priced like the
     * statistics (priority rounds at the priority price); null when nothing
     * was priced or reported
     */
    readonly costUsd: number | null;
    /** The image-generation part of costUsd; null when no generation was priced */
    readonly imageCostUsd: number | null;
    /** Pictures drawn inside this attempt (generate_image), whatever their usage */
    readonly imageGenerations: number;
    readonly pricing: PricingFlag;
    /** Priority rounds priced at the standard price: the model has no priority price */
    readonly priorityAtStandardPrice: boolean;
    /** Catalog content version active when this attempt resolved its traits */
    readonly catalogVersion: string | null;
    /** Capability rejection/fallback events observed during the attempt */
    readonly capabilityEvents: readonly CapabilityEvent[];
}

/** Members also see who triggered the attempt */
export interface MemberReplyMetricView extends ReplyMetricView {
    readonly triggerUserId: number | null;
}

/** versionId → that version's rows, oldest first (normally exactly one) */
export type ReplyMetricsByVersion = ReadonlyMap<number, readonly ReplyMetricView[]>;

export const toReplyMetricView = (row: ReplyMetricRecord): ReplyMetricView => {
    // This attempt alone, at the price in force when it started (design §4.2):
    // its chat tokens plus the pictures it drew
    const chat = replyRowCostUsd(row);
    const images = imageGenerationCostUsd(row);
    const totalUsd =
        chat.costUsd === null && images.costUsd === null ? null : (chat.costUsd ?? 0) + (images.costUsd ?? 0);
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
        costUsd: roundUsd(totalUsd),
        imageCostUsd: roundUsd(images.costUsd),
        imageGenerations: images.generations,
        pricing: chat.pricing,
        priorityAtStandardPrice: chat.priorityAtStandardPrice,
        catalogVersion: row.catalogVersion,
        capabilityEvents: row.capabilityEvents,
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
