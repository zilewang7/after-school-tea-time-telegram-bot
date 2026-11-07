/**
 * The time series of a statistics window: replies and errors per bucket,
 * plus stacked lines per model, per chat (all-chats view) and per error kind.
 * Every line has exactly one value per bucket, zeros included.
 */
import type { ReplyMetricRecord } from '../../db/queries/reply-metrics.js';
import type { SeriesLine, StatsSeries } from '../views/stats-view.js';
import { groupRowsBy } from './metric-samples.js';
import type { StatsWindow } from './stats-window.js';
import { bucketLabelOf, bucketLabelsBetween } from './time-buckets.js';

/** Bucket position of each row; rows outside the window's buckets are left out */
const bucketIndexer = (window: StatsWindow, buckets: readonly string[]) => {
    const indexByLabel = new Map(buckets.map((label, index) => [label, index]));
    return (row: ReplyMetricRecord): number | undefined =>
        indexByLabel.get(bucketLabelOf(row.startedAt, window.bucket));
};

const countPerBucket = (
    rows: readonly ReplyMetricRecord[],
    bucketCount: number,
    indexOf: (row: ReplyMetricRecord) => number | undefined
): number[] => {
    const values = new Array<number>(bucketCount).fill(0);
    for (const row of rows) {
        const index = indexOf(row);
        if (index !== undefined) values[index] = (values[index] ?? 0) + 1;
    }
    return values;
};

/** One line per key, largest total first */
const stackedLines = (
    groups: ReadonlyMap<string, readonly ReplyMetricRecord[]>,
    bucketCount: number,
    indexOf: (row: ReplyMetricRecord) => number | undefined,
    labelOf: (key: string) => string | null
): SeriesLine[] =>
    [...groups]
        .sort(([firstKey, first], [secondKey, second]) => second.length - first.length || firstKey.localeCompare(secondKey))
        .map(([key, rows]) => ({ key, label: labelOf(key), values: countPerBucket(rows, bucketCount, indexOf) }));

export interface SeriesOptions {
    /** Chat titles for the per-chat lines; null leaves the per-chat lines out */
    readonly chatTitles: ReadonlyMap<number, string | null> | null;
}

export const buildSeries = (
    rows: readonly ReplyMetricRecord[],
    window: StatsWindow,
    options: SeriesOptions
): StatsSeries => {
    const buckets = bucketLabelsBetween(window.seriesStart, window.until, window.bucket);
    const indexOf = bucketIndexer(window, buckets);
    const errorRows = rows.filter((row) => row.outcome === 'error');
    const { chatTitles } = options;

    return {
        buckets,
        replies: countPerBucket(rows, buckets.length, indexOf),
        errors: countPerBucket(errorRows, buckets.length, indexOf),
        byModel: stackedLines(groupRowsBy(rows, (row) => row.model), buckets.length, indexOf, () => null),
        byChat:
            chatTitles === null
                ? null
                : stackedLines(
                      groupRowsBy(rows, (row) => String(row.chatId)),
                      buckets.length,
                      indexOf,
                      (key) => chatTitles.get(Number(key)) ?? null
                  ),
        byErrorKind: stackedLines(
            groupRowsBy(errorRows, (row) => row.errorKind ?? 'other'),
            buckets.length,
            indexOf,
            () => null
        ),
    };
};
