/**
 * Estimated cost of replies, at query time from the list prices of
 * config/model-pricing.ts (design §6.5). Nothing here is stored: a price
 * change re-estimates history.
 *
 * Each (model, route) group gets one flag:
 * - unpriced: the model has no list price; cost null ("未定价")
 * - subscription: a flat-fee route (opencode-go); cost 0
 * - no_usage: priced, but no row reported usage and no image row can be
 *   priced per image; cost null, never shown as $0
 * - priced: everything else. Rows without usage add no token cost; image rows
 *   without usage are priced per image when the model has a per-image price
 *
 * Rounds served at Vertex's priority tier are priced at the model's priority
 * price (design §8.4). A model without one prices them at the standard price,
 * and its group says so with `priorityAtStandardPrice`.
 */
import { findModelPrice, SUBSCRIPTION_ROUTES, type ModelPrice, type TierPrice } from '../../config/model-pricing.js';
import type { UsageGroupRow } from '../../db/queries/reply-metrics.js';

export type PricingFlag = 'priced' | 'subscription' | 'unpriced' | 'no_usage';
/** A model across its routes: `partial` when some routes have a cost and others none */
export type ModelPricingFlag = PricingFlag | 'partial';

/** Every field is a number: the SQL coalesces empty sums to 0 */
export interface UsageTotals {
    readonly promptTokens: number;
    readonly cachedTokens: number;
    readonly cacheWriteTokens: number;
    readonly outputTokens: number;
    readonly imageOutputTokens: number;
    readonly unsplitImageOutputTokens: number;
    readonly imagesWithoutUsage: number;
    /** The priority-tier part of promptTokens, cachedTokens and outputTokens */
    readonly priorityPromptTokens: number;
    readonly priorityCachedTokens: number;
    readonly priorityOutputTokens: number;
}

const TOKENS_PER_PRICE_UNIT = 1_000_000;

/**
 * The priority part at the priority price, or at the standard price when the
 * model has none. Only text models are asked for the priority tier (design
 * D5), so all of its output is text and it has no cache writes.
 */
const priorityTokenCost = (price: ModelPrice, usage: UsageTotals): number => {
    const tierPrice: TierPrice = price.priority ?? price;
    const uncachedInput = usage.priorityPromptTokens - usage.priorityCachedTokens;
    return (
        uncachedInput * tierPrice.inputPerM +
        usage.priorityCachedTokens * tierPrice.cachedInputPerM +
        usage.priorityOutputTokens * tierPrice.outputPerM
    );
};

/** Everything but the priority part, at the standard prices */
const standardTokenCost = (price: ModelPrice, usage: UsageTotals): number => {
    const prompt = usage.promptTokens - usage.priorityPromptTokens;
    const cached = usage.cachedTokens - usage.priorityCachedTokens;
    const uncachedInput = prompt - cached - usage.cacheWriteTokens;
    const imageOutput = usage.imageOutputTokens + usage.unsplitImageOutputTokens;
    const textOutput = usage.outputTokens - usage.priorityOutputTokens - imageOutput; // includes reasoning tokens
    return (
        uncachedInput * price.inputPerM +
        cached * price.cachedInputPerM +
        usage.cacheWriteTokens * (price.cacheWritePerM ?? price.inputPerM) +
        textOutput * price.outputPerM +
        imageOutput * (price.imageOutputPerM ?? price.outputPerM)
    );
};

/**
 * (total - priority part) x standard price + priority part x priority price.
 * Thoughts are part of outputTokens and billed at the output price.
 */
export const estimateCostUsd = (price: ModelPrice, usage: UsageTotals): number => {
    const tokenCost = standardTokenCost(price, usage) + priorityTokenCost(price, usage);
    // Per-image price only for image rows with no usage, so an image is never billed twice
    const imageFallback = usage.imagesWithoutUsage * (price.perImageUsd ?? 0);
    return tokenCost / TOKENS_PER_PRICE_UNIT + imageFallback;
};

export interface PricedUsageGroup {
    readonly group: UsageGroupRow;
    readonly costUsd: number | null;
    readonly pricing: PricingFlag;
    /** Replies the estimate covers: those with usage, plus image rows priced per image */
    readonly pricedReplies: number;
    /** Priced, with priority rounds the model has no priority price for: those were priced at the standard price */
    readonly priorityAtStandardPrice: boolean;
}

/** Image rows without usage that the per-image price covers */
const perImageRowsOf = (price: ModelPrice, group: UsageGroupRow): number =>
    price.perImageUsd === undefined ? 0 : group.imageRowsWithoutUsage;

export const priceUsageGroup = (group: UsageGroupRow): PricedUsageGroup => {
    const price = findModelPrice(group.model);
    if (price === null) {
        return { group, costUsd: null, pricing: 'unpriced', pricedReplies: 0, priorityAtStandardPrice: false };
    }

    const pricedReplies = group.repliesWithUsage + perImageRowsOf(price, group);
    if (group.route !== null && SUBSCRIPTION_ROUTES.has(group.route)) {
        return { group, costUsd: 0, pricing: 'subscription', pricedReplies, priorityAtStandardPrice: false };
    }
    if (pricedReplies === 0) {
        return { group, costUsd: null, pricing: 'no_usage', pricedReplies: 0, priorityAtStandardPrice: false };
    }
    return {
        group,
        costUsd: estimateCostUsd(price, group),
        pricing: 'priced',
        pricedReplies,
        priorityAtStandardPrice: group.priorityRounds > 0 && price.priority === undefined,
    };
};

export interface ModelCostRollup {
    readonly model: string;
    readonly costUsd: number | null;
    readonly pricing: ModelPricingFlag;
    /** Some route group priced priority rounds at the standard price */
    readonly priorityAtStandardPrice: boolean;
}

const sumOf = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0);

/** One model's flag across its route groups */
const rollupFlagOf = (groups: readonly PricedUsageGroup[]): ModelPricingFlag => {
    const flags = new Set(groups.map((priced) => priced.pricing));
    const [onlyFlag] = flags;
    if (flags.size === 1 && onlyFlag !== undefined) return onlyFlag;
    const withCost = groups.filter((priced) => priced.costUsd !== null).length;
    if (withCost === groups.length) return 'priced';
    if (withCost > 0) return 'partial';
    return flags.has('unpriced') ? 'unpriced' : 'no_usage';
};

/** Per model across routes (design D5: a cost per model) */
export const rollupCostByModel = (groups: readonly PricedUsageGroup[]): Map<string, ModelCostRollup> => {
    const groupsByModel = new Map<string, PricedUsageGroup[]>();
    for (const priced of groups) {
        const list = groupsByModel.get(priced.group.model) ?? [];
        list.push(priced);
        groupsByModel.set(priced.group.model, list);
    }
    const rollups = new Map<string, ModelCostRollup>();
    for (const [model, modelGroups] of groupsByModel) {
        const costs = modelGroups.flatMap((priced) => (priced.costUsd === null ? [] : [priced.costUsd]));
        rollups.set(model, {
            model,
            costUsd: costs.length === 0 ? null : sumOf(costs),
            pricing: rollupFlagOf(modelGroups),
            priorityAtStandardPrice: modelGroups.some((priced) => priced.priorityAtStandardPrice),
        });
    }
    return rollups;
};

export interface CostTotals {
    /** Sum of every group with a cost; null when none has one */
    readonly costUsd: number | null;
    /** Priced replies over all replies; null without replies */
    readonly pricedReplyRatio: number | null;
}

export const totalCost = (groups: readonly PricedUsageGroup[]): CostTotals => {
    const costs = groups.flatMap((priced) => (priced.costUsd === null ? [] : [priced.costUsd]));
    const replies = sumOf(groups.map((priced) => priced.group.replies));
    const pricedReplies = sumOf(groups.map((priced) => priced.pricedReplies));
    return {
        costUsd: costs.length === 0 ? null : sumOf(costs),
        pricedReplyRatio: replies === 0 ? null : pricedReplies / replies,
    };
};
