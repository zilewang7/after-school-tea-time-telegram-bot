import type { StatsRangeKey } from '../../api';

export const STATS_RANGES: ReadonlyArray<{ key: StatsRangeKey; label: string }> = [
    { key: '24h', label: '24 小时' },
    { key: '7d', label: '7 天' },
    { key: '30d', label: '30 天' },
    { key: '90d', label: '90 天' },
    { key: 'all', label: '全部' },
];

export const DEFAULT_STATS_RANGE: StatsRangeKey = '7d';

export const statsRangeLabel = (range: StatsRangeKey): string =>
    STATS_RANGES.find((option) => option.key === range)?.label ?? range;
