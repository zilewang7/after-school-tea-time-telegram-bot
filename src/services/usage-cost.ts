/**
 * Estimated cost of replies, at query time from the list prices of
 * config/model-pricing.ts (design §6.5). Nothing here is stored: a price
 * change re-estimates history.
 *
 * Lives in services because two callers price rows with it: the panel's
 * statistics (which aggregates a window) and the trial quota (which sums one
 * user's rows). Both must use the same rules, so the primitives sit below the
 * panel layer; the reply path may import services too.
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
 *
 * In-reply image generations (`imageGenerationUsage`) are priced per row at the
 * price in force when the row started: a generation with usage by its tokens,
 * one without usage by the model's per-image price (design D4/D5).
 */
import { findModelPrice, findPriceAt, SUBSCRIPTION_ROUTES, type ModelPrice, type TierPrice } from '../config/model-pricing.js';
import type { ReplyMetricRecord, UsageGroupRow } from '../db/queries/reply-metrics.js';
import type { ImageGenerationUsage } from '../db/queries/reply-metric-rows.js';

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

/**
 * Cost of one (model, route) group. `price` overrides the current list price:
 * a price-segmented estimate passes the price in force when the group's rows
 * started. undefined = the current price (the existing callers), null = the
 * model was unpriced for those rows.
 */
export const priceUsageGroup = (group: UsageGroupRow, price?: ModelPrice | null): PricedUsageGroup => {
    const effectivePrice = price === undefined ? findModelPrice(group.model) : price;
    if (effectivePrice === null) {
        return { group, costUsd: null, pricing: 'unpriced', pricedReplies: 0, priorityAtStandardPrice: false };
    }

    const pricedReplies = group.repliesWithUsage + perImageRowsOf(effectivePrice, group);
    if (group.route !== null && SUBSCRIPTION_ROUTES.has(group.route)) {
        return { group, costUsd: 0, pricing: 'subscription', pricedReplies, priorityAtStandardPrice: false };
    }
    if (pricedReplies === 0) {
        return { group, costUsd: null, pricing: 'no_usage', pricedReplies: 0, priorityAtStandardPrice: false };
    }
    return {
        group,
        costUsd: estimateCostUsd(effectivePrice, group),
        pricing: 'priced',
        pricedReplies,
        priorityAtStandardPrice: group.priorityRounds > 0 && effectivePrice.priority === undefined,
    };
};

/** A row has usage when both prompt and output were reported (design §6.5) */
const hasUsage = (row: ReplyMetricRecord): boolean => row.promptTokens !== null && row.outputTokens !== null;

/**
 * One reply_metrics row as a cost group of its own, so the same pricing rules
 * apply: the reply detail, the trial quota and the image cost all price a
 * single attempt with this shape.
 */
export const replyRowUsageGroup = (row: ReplyMetricRecord): UsageGroupRow => {
    const withUsage = hasUsage(row);
    const tokens = (value: number | null): number => (withUsage ? value ?? 0 : 0);
    return {
        model: row.model,
        route: row.route,
        replies: 1,
        repliesWithUsage: withUsage ? 1 : 0,
        promptTokens: tokens(row.promptTokens),
        cachedTokens: tokens(row.cachedTokens),
        cacheWriteTokens: tokens(row.cacheWriteTokens),
        outputTokens: tokens(row.outputTokens),
        thoughtsTokens: tokens(row.thoughtsTokens),
        imageOutputTokens: tokens(row.imageOutputTokens),
        unsplitImageOutputTokens:
            withUsage && row.imageOutputTokens === null && row.imageCount > 0 ? row.outputTokens ?? 0 : 0,
        imagesWithoutUsage: withUsage ? 0 : row.imageCount,
        imageRowsWithoutUsage: !withUsage && row.imageCount > 0 ? 1 : 0,
        // Same rules as the SQL aggregate: rounds always, tokens only with usage
        priorityRounds: row.priorityRounds ?? 0,
        priorityPromptTokens: tokens(row.priorityPromptTokens),
        priorityCachedTokens: tokens(row.priorityCachedTokens),
        priorityOutputTokens: tokens(row.priorityOutputTokens),
    };
};

export interface ReplyRowCost {
    /** null when the row's model was unpriced for it, or nothing was reported */
    readonly costUsd: number | null;
    readonly pricing: PricingFlag;
    /** Priority rounds priced at the standard price: the model has no priority price */
    readonly priorityAtStandardPrice: boolean;
}

/** One row's chat-token cost at the price in force when it started */
export const replyRowCostUsd = (row: ReplyMetricRecord): ReplyRowCost => {
    const priced = priceUsageGroup(replyRowUsageGroup(row), findPriceAt(row.model, row.startedAt));
    return {
        costUsd: priced.costUsd,
        pricing: priced.pricing,
        priorityAtStandardPrice: priced.priorityAtStandardPrice,
    };
};

/** One image model's generations within a row, as the group the pricing rules price */
const imageGenerationGroupOf = (usage: ImageGenerationUsage): UsageGroupRow => {
    const withoutUsage = Math.max(0, usage.generations - usage.generationsWithUsage);
    // A generation that reported its output as image tokens without the IMAGE
    // split was billed as image output: the same rule the row aggregate uses
    const unsplitImageOutput =
        usage.generationsWithUsage > 0 && usage.imageOutputTokens === null ? usage.outputTokens ?? 0 : 0;
    return {
        model: usage.model,
        route: 'image',
        replies: 0,
        repliesWithUsage: usage.generationsWithUsage,
        promptTokens: usage.promptTokens ?? 0,
        cachedTokens: usage.cachedTokens ?? 0,
        cacheWriteTokens: usage.cacheWriteTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        thoughtsTokens: usage.thoughtsTokens ?? 0,
        imageOutputTokens: usage.imageOutputTokens ?? 0,
        unsplitImageOutputTokens: unsplitImageOutput,
        imagesWithoutUsage: withoutUsage,
        imageRowsWithoutUsage: withoutUsage,
        priorityRounds: 0,
        priorityPromptTokens: 0,
        priorityCachedTokens: 0,
        priorityOutputTokens: 0,
    };
};

export interface ImageGenerationEntryCost {
    readonly model: string;
    readonly generations: number;
    readonly generationsWithUsage: number;
    /** null when the model was unpriced for this row, or no generation could be priced */
    readonly costUsd: number | null;
    readonly pricing: PricingFlag;
    /** Generations the price covers: those with usage, plus the per-image fallback ones */
    readonly pricedGenerations: number;
}

/** One image-model entry of a row, priced at the price in force when the row started */
export const imageGenerationEntryCost = (row: ReplyMetricRecord, usage: ImageGenerationUsage): ImageGenerationEntryCost => {
    const priced = priceUsageGroup(imageGenerationGroupOf(usage), findPriceAt(usage.model, row.startedAt));
    return {
        model: usage.model,
        generations: usage.generations,
        generationsWithUsage: usage.generationsWithUsage,
        costUsd: priced.costUsd,
        pricing: priced.pricing,
        pricedGenerations: priced.pricedReplies,
    };
};

export interface ImageGenerationCost {
    /** Sum of the priced entries; null when no generation of the row was priced */
    readonly costUsd: number | null;
    readonly generations: number;
    /** Generations the priced entries cover */
    readonly pricedGenerations: number;
}

/** The in-reply image generations of one row, priced at the price in force when it started */
export const imageGenerationCostUsd = (row: ReplyMetricRecord): ImageGenerationCost => {
    const costs: number[] = [];
    let generations = 0;
    let pricedGenerations = 0;
    for (const usage of row.imageGenerationUsage) {
        const entry = imageGenerationEntryCost(row, usage);
        generations += entry.generations;
        pricedGenerations += entry.pricedGenerations;
        if (entry.costUsd !== null) costs.push(entry.costUsd);
    }
    return {
        costUsd: costs.length === 0 ? null : sumOf(costs),
        generations,
        pricedGenerations,
    };
};

const groupKeyOf = (group: UsageGroupRow): string => JSON.stringify([group.model, group.route]);

/** Sum of two usage groups; every field of the row is additive */
const addUsageGroups = (first: UsageGroupRow, second: UsageGroupRow): UsageGroupRow => ({
    model: first.model,
    route: first.route,
    replies: first.replies + second.replies,
    repliesWithUsage: first.repliesWithUsage + second.repliesWithUsage,
    promptTokens: first.promptTokens + second.promptTokens,
    cachedTokens: first.cachedTokens + second.cachedTokens,
    cacheWriteTokens: first.cacheWriteTokens + second.cacheWriteTokens,
    outputTokens: first.outputTokens + second.outputTokens,
    thoughtsTokens: first.thoughtsTokens + second.thoughtsTokens,
    imageOutputTokens: first.imageOutputTokens + second.imageOutputTokens,
    unsplitImageOutputTokens: first.unsplitImageOutputTokens + second.unsplitImageOutputTokens,
    imagesWithoutUsage: first.imagesWithoutUsage + second.imagesWithoutUsage,
    imageRowsWithoutUsage: first.imageRowsWithoutUsage + second.imageRowsWithoutUsage,
    priorityRounds: first.priorityRounds + second.priorityRounds,
    priorityPromptTokens: first.priorityPromptTokens + second.priorityPromptTokens,
    priorityCachedTokens: first.priorityCachedTokens + second.priorityCachedTokens,
    priorityOutputTokens: first.priorityOutputTokens + second.priorityOutputTokens,
});

/**
 * One group per (model, route): the rows of the price segments added back
 * together, first-seen order kept. All fields are sums, so the merged row is
 * exactly what a single unsegmented aggregation would have returned.
 */
export const mergeUsageGroupRows = (groups: readonly UsageGroupRow[]): UsageGroupRow[] => {
    const merged = new Map<string, UsageGroupRow>();
    for (const group of groups) {
        const key = groupKeyOf(group);
        const existing = merged.get(key);
        merged.set(key, existing === undefined ? group : addUsageGroups(existing, group));
    }
    return [...merged.values()];
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

/**
 * A group's flag after its price segments merged. A price can appear or
 * disappear at a segment boundary (a model priced only after some of its rows),
 * so the flag follows the cost: some covered rows price the group.
 */
const mergedFlagOf = (segments: readonly PricedUsageGroup[], hasCost: boolean): PricingFlag => {
    const flags = new Set(segments.map((priced) => priced.pricing));
    const [onlyFlag] = flags;
    if (flags.size === 1 && onlyFlag !== undefined) return onlyFlag;
    if (hasCost) return 'priced';
    return flags.has('unpriced') ? 'unpriced' : 'no_usage';
};

/**
 * The (model, route) groups of a price-segmented estimate: each segment was
 * priced at the price in force when it started, so the merged group adds the
 * segment groups back together (usage sums, costs summed; null only when no
 * segment had a cost). This is the row the API returns and the model rollup
 * uses, so one model keeps one row whatever the price did inside the window.
 */
export const mergePricedUsageGroups = (segments: readonly PricedUsageGroup[]): PricedUsageGroup[] => {
    const byKey = new Map<string, PricedUsageGroup[]>();
    for (const priced of segments) {
        const key = groupKeyOf(priced.group);
        const list = byKey.get(key) ?? [];
        list.push(priced);
        byKey.set(key, list);
    }
    return [...byKey.values()].flatMap((segmentGroups) => {
        const group = mergeUsageGroupRows(segmentGroups.map((priced) => priced.group))[0];
        if (group === undefined) return [];
        const costs = segmentGroups.flatMap((priced) => (priced.costUsd === null ? [] : [priced.costUsd]));
        return [
            {
                group,
                costUsd: costs.length === 0 ? null : sumOf(costs),
                pricing: mergedFlagOf(segmentGroups, costs.length > 0),
                pricedReplies: sumOf(segmentGroups.map((priced) => priced.pricedReplies)),
                priorityAtStandardPrice: segmentGroups.some((priced) => priced.priorityAtStandardPrice),
            },
        ];
    });
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
