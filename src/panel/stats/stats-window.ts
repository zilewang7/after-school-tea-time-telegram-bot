/**
 * The time window of a statistics request: `range` picks how far back, and
 * the bucket size follows from it (hours for 24h, days for everything else).
 */
import { match } from 'ts-pattern';

export type StatsRangeKey = '24h' | '7d' | '30d' | '90d' | 'all';
export type StatsBucket = 'hour' | 'day';

export const STATS_RANGE_KEYS: readonly StatsRangeKey[] = ['24h', '7d', '30d', '90d', 'all'];
export const DEFAULT_STATS_RANGE: StatsRangeKey = '7d';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface StatsWindow {
    readonly range: StatsRangeKey;
    /** Lower bound of the row query (the epoch for `all`) */
    readonly since: Date;
    /** Where the series starts: `since`, or the first row for `all` */
    readonly seriesStart: Date;
    readonly until: Date;
    readonly bucket: StatsBucket;
}

/** The range parameter; absent or empty means the default, anything unknown is null */
export const parseStatsRange = (raw: string | undefined): StatsRangeKey | null => {
    if (raw === undefined || raw === '') return DEFAULT_STATS_RANGE;
    return STATS_RANGE_KEYS.find((key) => key === raw) ?? null;
};

const lookbackMs = (range: Exclude<StatsRangeKey, 'all'>): number =>
    match(range)
        .with('24h', () => DAY_MS)
        .with('7d', () => 7 * DAY_MS)
        .with('30d', () => 30 * DAY_MS)
        .with('90d', () => 90 * DAY_MS)
        .exhaustive();

/**
 * `earliestRow` only matters for `all`: its series starts at the first row
 * (or now, when there is none) instead of 1970.
 */
export const resolveStatsWindow = (range: StatsRangeKey, now: Date, earliestRow: Date | null): StatsWindow => {
    if (range === 'all') {
        return {
            range,
            since: new Date(0),
            seriesStart: earliestRow ?? now,
            until: now,
            bucket: 'day',
        };
    }
    const since = new Date(now.getTime() - lookbackMs(range));
    return { range, since, seriesStart: since, until: now, bucket: range === '24h' ? 'hour' : 'day' };
};
