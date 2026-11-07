/**
 * The per-reply usage collector. A field stays null until some round reports
 * it, then it is the sum of what the rounds reported.
 */
import type { ReplyUsageTotals, RoundUsage, UsageSink } from './usage-types.js';

type UsageField = keyof RoundUsage;

const USAGE_FIELDS: readonly UsageField[] = [
    'promptTokens',
    'cachedTokens',
    'cacheWriteTokens',
    'outputTokens',
    'thoughtsTokens',
    'imageOutputTokens',
];

const addCount = (total: number | null, count: number | null): number | null => {
    if (count === null) return total;
    return (total ?? 0) + count;
};

export const createUsageSink = (): UsageSink => {
    const sums: Record<UsageField, number | null> = {
        promptTokens: null,
        cachedTokens: null,
        cacheWriteTokens: null,
        outputTokens: null,
        thoughtsTokens: null,
        imageOutputTokens: null,
    };
    let rounds = 0;
    let route: string | null = null;

    return {
        addRound: (usage) => {
            rounds += 1;
            if (usage === null) return;
            for (const field of USAGE_FIELDS) {
                sums[field] = addCount(sums[field], usage[field]);
            }
        },
        setRoute: (lane) => {
            route = lane;
        },
        totals: (): ReplyUsageTotals => ({ ...sums, rounds, route }),
    };
};
