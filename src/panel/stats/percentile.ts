/**
 * Percentiles of the samples a statistics query fetched, computed here rather
 * than in SQLite (design §6.5). Linear interpolation between the two closest
 * ranks, the usual definition (p50 of [1, 2] is 1.5).
 */

/** Of values sorted ascending; null without samples */
export const percentileOfSorted = (sortedValues: readonly number[], percent: number): number | null => {
    if (sortedValues.length === 0) return null;
    const position = ((sortedValues.length - 1) * percent) / 100;
    const lowerIndex = Math.floor(position);
    const upperIndex = Math.ceil(position);
    const lower = sortedValues[lowerIndex];
    const upper = sortedValues[upperIndex];
    if (lower === undefined || upper === undefined) return null;
    return lower + (upper - lower) * (position - lowerIndex);
};

export interface PercentileSummary {
    readonly p50: number | null;
    readonly p95: number | null;
    readonly samples: number;
}

/** p50 and p95, rounded to whole units (milliseconds for every caller) */
export const summarizeSamples = (values: readonly number[]): PercentileSummary => {
    const sorted = [...values].sort((first, second) => first - second);
    const rounded = (percent: number): number | null => {
        const value = percentileOfSorted(sorted, percent);
        return value === null ? null : Math.round(value);
    };
    return { p50: rounded(50), p95: rounded(95), samples: sorted.length };
};
