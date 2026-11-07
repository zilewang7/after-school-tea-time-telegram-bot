/**
 * Per-row facts the statistics are computed from: whether a row reported
 * usage, its timings, and token sums over a set of rows.
 */
import type { ReplyMetricRecord } from '../../db/queries/reply-metrics.js';

/** Design §6.5: a row has usage when both prompt and output were reported */
export const hasUsage = (row: ReplyMetricRecord): boolean => row.promptTokens !== null && row.outputTokens !== null;

/** firstChunkAt - requestStartedAt; null when either is missing */
export const firstChunkMsOf = (row: ReplyMetricRecord): number | null => {
    if (row.firstChunkAt === null || row.requestStartedAt === null) return null;
    const elapsed = row.firstChunkAt.getTime() - row.requestStartedAt.getTime();
    return elapsed >= 0 ? elapsed : null;
};

/** finishedAt - startedAt: the whole attempt, context building included */
export const durationMsOf = (row: ReplyMetricRecord): number =>
    Math.max(0, row.finishedAt.getTime() - row.startedAt.getTime());

/** Time spent streaming after the first chunk; null before any chunk */
export const streamingMsOf = (row: ReplyMetricRecord): number | null => {
    if (row.firstChunkAt === null) return null;
    const elapsed = row.finishedAt.getTime() - row.firstChunkAt.getTime();
    return elapsed > 0 ? elapsed : null;
};

export interface TokenSums {
    readonly repliesWithUsage: number;
    readonly promptTokens: number;
    readonly cachedTokens: number;
    readonly cacheWriteTokens: number;
    readonly outputTokens: number;
    readonly thoughtsTokens: number;
    readonly imageOutputTokens: number;
}

const EMPTY_TOKEN_SUMS: TokenSums = {
    repliesWithUsage: 0,
    promptTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    thoughtsTokens: 0,
    imageOutputTokens: 0,
};

/** Token columns summed over the rows with usage only, like the cost aggregation */
export const sumTokens = (rows: readonly ReplyMetricRecord[]): TokenSums =>
    rows.filter(hasUsage).reduce<TokenSums>(
        (sums, row) => ({
            repliesWithUsage: sums.repliesWithUsage + 1,
            promptTokens: sums.promptTokens + (row.promptTokens ?? 0),
            cachedTokens: sums.cachedTokens + (row.cachedTokens ?? 0),
            cacheWriteTokens: sums.cacheWriteTokens + (row.cacheWriteTokens ?? 0),
            outputTokens: sums.outputTokens + (row.outputTokens ?? 0),
            thoughtsTokens: sums.thoughtsTokens + (row.thoughtsTokens ?? 0),
            imageOutputTokens: sums.imageOutputTokens + (row.imageOutputTokens ?? 0),
        }),
        EMPTY_TOKEN_SUMS
    );

/** Values of `pick` that are present */
export const presentValues = <T,>(
    rows: readonly ReplyMetricRecord[],
    pick: (row: ReplyMetricRecord) => T | null
): T[] =>
    rows.flatMap((row) => {
        const value = pick(row);
        return value === null ? [] : [value];
    });

export const sumOf = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0);

/** Rows grouped by a key, in first-seen order */
export const groupRowsBy = <Key,>(
    rows: readonly ReplyMetricRecord[],
    keyOf: (row: ReplyMetricRecord) => Key
): Map<Key, ReplyMetricRecord[]> => {
    const groups = new Map<Key, ReplyMetricRecord[]>();
    for (const row of rows) {
        const key = keyOf(row);
        const group = groups.get(key) ?? [];
        group.push(row);
        groups.set(key, group);
    }
    return groups;
};
