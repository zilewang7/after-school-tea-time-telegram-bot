/**
 * The per-reply usage collector. A field stays null until some round reports
 * it, then it is the sum of what the rounds reported.
 */
import type {
    PriorityUsageTotals,
    ReplyUsageTotals,
    RoundUsage,
    UsageSink,
} from './usage-types.js';

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
    let roundRetries = 0;
    let tierRequested: 'priority' | null = null;
    let priority: PriorityUsageTotals | null = null;

    return {
        addRound: (usage, meta) => {
            rounds += 1;
            if (meta?.servedTier === 'priority') {
                // A priority round without usage still counts as a round served
                priority = {
                    rounds: (priority?.rounds ?? 0) + 1,
                    promptTokens: (priority?.promptTokens ?? 0) + (usage?.promptTokens ?? 0),
                    cachedTokens: (priority?.cachedTokens ?? 0) + (usage?.cachedTokens ?? 0),
                    outputTokens: (priority?.outputTokens ?? 0) + (usage?.outputTokens ?? 0),
                };
            }
            if (usage === null) return;
            for (const field of USAGE_FIELDS) {
                sums[field] = addCount(sums[field], usage[field]);
            }
        },
        setRoute: (lane) => {
            route = lane;
        },
        addRecovery: () => {
            roundRetries += 1;
        },
        setTierRequested: (tier) => {
            tierRequested = tier;
        },
        totals: (): ReplyUsageTotals => ({ ...sums, rounds, route, roundRetries, tierRequested, priority }),
    };
};
