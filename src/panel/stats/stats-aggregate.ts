/**
 * The statistics tables computed from the rows of a window: KPIs, the
 * per-model table, tools, error kinds, outcomes and the latest errors.
 */
import type { ReplyMetricRecord, ReplyOutcome } from '../../db/queries/reply-metrics.js';
import { ERROR_KINDS } from '../../shared/error-kind.js';
import {
    averageOf,
    ratioOf,
    roundRatio,
    roundUsd,
    type ErrorKindCount,
    type ModelStatsRow,
    type OutcomeCounts,
    type RecentErrorRow,
    type StatsKpis,
    type ToolStatsRow,
} from '../views/stats-view.js';
import type { CostTotals, ModelCostRollup } from './cost-estimate.js';
import {
    durationMsOf,
    firstChunkMsOf,
    groupRowsBy,
    presentValues,
    streamingMsOf,
    sumOf,
    sumTokens,
} from './metric-samples.js';
import { summarizeSamples } from './percentile.js';
import { countPriorityHits } from './priority-hits.js';

export const RECENT_ERROR_LIMIT = 20;

const countWhere = (rows: readonly ReplyMetricRecord[], predicate: (row: ReplyMetricRecord) => boolean): number =>
    rows.filter(predicate).length;

export const countOutcomes = (rows: readonly ReplyMetricRecord[]): OutcomeCounts => {
    const counts: Record<ReplyOutcome, number> = { ok: 0, error: 0, stopped: 0, empty: 0 };
    for (const row of rows) counts[row.outcome] += 1;
    return counts;
};

export const buildKpis = (rows: readonly ReplyMetricRecord[], cost: CostTotals): StatsKpis => {
    const replies = rows.length;
    const retries = countWhere(rows, (row) => row.isRetry);
    const errorReplies = countWhere(rows, (row) => row.outcome === 'error');
    const firstChunk = summarizeSamples(presentValues(rows, firstChunkMsOf));
    const duration = summarizeSamples(rows.map(durationMsOf));
    const toolCalls = sumOf(rows.map((row) => row.toolCalls));
    const toolFailures = sumOf(rows.map((row) => row.toolFailures));
    const rounds = presentValues(rows, (row) => row.rounds);
    const tokens = sumTokens(rows);
    const contextMessages = presentValues(rows, (row) => row.contextMessages);
    const contextImages = presentValues(rows, (row) => row.contextImages);

    return {
        replies,
        retries,
        retryRatio: ratioOf(retries, replies),
        triggerUsers: new Set(presentValues(rows, (row) => row.triggerUserId)).size,
        errorReplies,
        errorRate: ratioOf(errorReplies, replies),
        firstChunkP50Ms: firstChunk.p50,
        firstChunkP95Ms: firstChunk.p95,
        durationP50Ms: duration.p50,
        durationP95Ms: duration.p95,
        toolCalls,
        toolFailures,
        toolFailureRate: ratioOf(toolFailures, toolCalls),
        avgRounds: averageOf(sumOf(rounds), rounds.length),
        avgToolCalls: averageOf(toolCalls, replies),
        repliesWithUsage: tokens.repliesWithUsage,
        promptTokens: tokens.promptTokens,
        cachedTokens: tokens.cachedTokens,
        cacheWriteTokens: tokens.cacheWriteTokens,
        outputTokens: tokens.outputTokens,
        thoughtsTokens: tokens.thoughtsTokens,
        imageOutputTokens: tokens.imageOutputTokens,
        avgPromptTokens: averageOf(tokens.promptTokens, tokens.repliesWithUsage),
        avgOutputTokens: averageOf(tokens.outputTokens, tokens.repliesWithUsage),
        cacheHitRate: ratioOf(tokens.cachedTokens, tokens.promptTokens),
        avgContextMessages: averageOf(sumOf(contextMessages), contextMessages.length),
        avgContextImages: averageOf(sumOf(contextImages), contextImages.length),
        costUsd: roundUsd(cost.costUsd),
        pricedReplyRatio: roundRatio(cost.pricedReplyRatio),
        ...countPriorityHits(rows),
    };
};

/** Characters per second over every reply that streamed text: Σ chars / Σ streaming time */
const outputCharsPerSecondOf = (rows: readonly ReplyMetricRecord[]): number | null => {
    const streamed = rows.flatMap((row) => {
        const streamingMs = streamingMsOf(row);
        return streamingMs === null || row.textChars === null || row.textChars === 0
            ? []
            : [{ chars: row.textChars, ms: streamingMs }];
    });
    const totalMs = sumOf(streamed.map((entry) => entry.ms));
    if (totalMs === 0) return null;
    return Math.round((sumOf(streamed.map((entry) => entry.chars)) / totalMs) * 1000 * 10) / 10;
};

const toModelRow = (model: string, rows: readonly ReplyMetricRecord[], rollup: ModelCostRollup | undefined): ModelStatsRow => {
    const replies = rows.length;
    const errorReplies = countWhere(rows, (row) => row.outcome === 'error');
    const firstChunk = summarizeSamples(presentValues(rows, firstChunkMsOf));
    const duration = summarizeSamples(rows.map(durationMsOf));
    const rounds = presentValues(rows, (row) => row.rounds);
    const tokens = sumTokens(rows);
    return {
        model,
        platform: rows[0]?.platform ?? '',
        replies,
        retries: countWhere(rows, (row) => row.isRetry),
        errorReplies,
        errorRate: ratioOf(errorReplies, replies),
        stoppedReplies: countWhere(rows, (row) => row.outcome === 'stopped'),
        emptyReplies: countWhere(rows, (row) => row.outcome === 'empty'),
        firstChunkP50Ms: firstChunk.p50,
        firstChunkP95Ms: firstChunk.p95,
        durationP50Ms: duration.p50,
        durationP95Ms: duration.p95,
        outputCharsPerSecond: outputCharsPerSecondOf(rows),
        avgRounds: averageOf(sumOf(rounds), rounds.length),
        toolCalls: sumOf(rows.map((row) => row.toolCalls)),
        toolFailures: sumOf(rows.map((row) => row.toolFailures)),
        repliesWithUsage: tokens.repliesWithUsage,
        promptTokens: tokens.promptTokens,
        cachedTokens: tokens.cachedTokens,
        cacheWriteTokens: tokens.cacheWriteTokens,
        outputTokens: tokens.outputTokens,
        thoughtsTokens: tokens.thoughtsTokens,
        imageOutputTokens: tokens.imageOutputTokens,
        avgPromptTokens: averageOf(tokens.promptTokens, tokens.repliesWithUsage),
        avgOutputTokens: averageOf(tokens.outputTokens, tokens.repliesWithUsage),
        cacheHitRate: ratioOf(tokens.cachedTokens, tokens.promptTokens),
        costUsd: roundUsd(rollup?.costUsd ?? null),
        pricing: rollup?.pricing ?? 'unpriced',
        priorityAtStandardPrice: rollup?.priorityAtStandardPrice ?? false,
        ...countPriorityHits(rows),
    };
};

/** One row per model, most replies first */
export const buildModelRows = (
    rows: readonly ReplyMetricRecord[],
    rollups: ReadonlyMap<string, ModelCostRollup>
): ModelStatsRow[] =>
    [...groupRowsBy(rows, (row) => row.model)]
        .map(([model, modelRows]) => toModelRow(model, modelRows, rollups.get(model)))
        .sort((first, second) => second.replies - first.replies || first.model.localeCompare(second.model));

/** Per tool, most calls first */
export const buildToolRows = (rows: readonly ReplyMetricRecord[]): ToolStatsRow[] => {
    const tallies = new Map<string, { calls: number; failures: number; replies: number }>();
    for (const row of rows) {
        for (const usage of row.toolUsage) {
            const tally = tallies.get(usage.name) ?? { calls: 0, failures: 0, replies: 0 };
            tally.calls += usage.count;
            tally.failures += usage.failed;
            tally.replies += 1;
            tallies.set(usage.name, tally);
        }
    }
    return [...tallies]
        .map(([name, tally]) => ({ name, ...tally, failureRate: ratioOf(tally.failures, tally.calls) }))
        .sort((first, second) => second.calls - first.calls || first.name.localeCompare(second.name));
};

/** Error kinds that occurred, most frequent first */
export const buildErrorKindCounts = (rows: readonly ReplyMetricRecord[]): ErrorKindCount[] =>
    ERROR_KINDS.map((kind) => ({ kind, count: countWhere(rows, (row) => row.errorKind === kind) }))
        .filter((entry) => entry.count > 0)
        .sort((first, second) => second.count - first.count);

/** The newest error rows; titles only when the caller passes them (all-chats view) */
export const buildRecentErrors = (
    rows: readonly ReplyMetricRecord[],
    chatTitles: ReadonlyMap<number, string | null> | null
): RecentErrorRow[] =>
    rows
        .filter((row) => row.outcome === 'error')
        .sort((first, second) => second.startedAt.getTime() - first.startedAt.getTime() || second.id - first.id)
        .slice(0, RECENT_ERROR_LIMIT)
        .map((row) => ({
            at: row.startedAt.toISOString(),
            chatId: row.chatId,
            chatTitle: chatTitles?.get(row.chatId) ?? null,
            model: row.model,
            errorKind: row.errorKind,
            errorSummary: row.errorSummary,
            firstMessageId: row.firstMessageId,
            versionId: row.versionId,
        }));
