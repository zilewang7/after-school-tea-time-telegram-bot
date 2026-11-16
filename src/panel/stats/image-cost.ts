/**
 * In-reply image generation cost of a statistics window (design D6): every
 * reply_metrics row stores the `generate_image` calls of its reply per image
 * model (`imageGenerationUsage`), and this groups them per model, priced at the
 * price in force when each row started.
 *
 * The chat-token cost of a window keeps its price-segmented estimate (a reply
 * keeps the price it was made under); an image generation has no reply of its
 * own, so it is priced per row like the reply detail's single-row cost
 * (usage-cost.ts `imageGenerationEntryCost`). No extra SQL: the window's rows
 * already carry the JSON.
 */
import type { ReplyMetricRecord } from '../../db/queries/reply-metrics.js';
import { imageGenerationEntryCost, type PricingFlag } from '../../services/usage-cost.js';
import { roundUsd } from '../views/stats-view.js';

/** One image model's generations in the window, as the statistics API shows them */
export interface ImageCostGroupView {
    readonly model: string;
    /** Pictures drawn, whatever their usage */
    readonly generations: number;
    /** Pictures that reported token usage (priced by tokens rather than per image) */
    readonly generationsWithUsage: number;
    /** null when the model was unpriced for every generation */
    readonly costUsd: number | null;
    readonly pricing: PricingFlag;
}

/** The window's image cost: the per-model groups and their totals */
export interface ImageCostResult {
    readonly groups: readonly ImageCostGroupView[];
    /** Sum of every priced generation; null when no generation was priced */
    readonly imageCostUsd: number | null;
    readonly imageGenerations: number;
}

interface GroupAccumulator {
    generations: number;
    generationsWithUsage: number;
    costs: number[];
    flags: PricingFlag[];
}

const sumOf = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0);

/**
 * One flag per model across its rows: the flag when all agree, otherwise
 * `priced` when any generation had a cost, else the stricter of the two.
 */
const mergedFlagOf = (flags: readonly PricingFlag[], hasCost: boolean): PricingFlag => {
    const unique = new Set(flags);
    const [onlyFlag] = unique;
    if (unique.size === 1 && onlyFlag !== undefined) return onlyFlag;
    if (hasCost) return 'priced';
    return flags.includes('unpriced') ? 'unpriced' : 'no_usage';
};

/** Image generations of a window per model, priced per row; most pictures first */
export const buildImageCostGroups = (rows: readonly ReplyMetricRecord[]): ImageCostResult => {
    const byModel = new Map<string, GroupAccumulator>();
    const costs: number[] = [];
    let imageGenerations = 0;
    for (const row of rows) {
        for (const usage of row.imageGenerationUsage) {
            const entry = imageGenerationEntryCost(row, usage);
            imageGenerations += entry.generations;
            if (entry.costUsd !== null) costs.push(entry.costUsd);
            const accumulator = byModel.get(entry.model) ?? {
                generations: 0,
                generationsWithUsage: 0,
                costs: [],
                flags: [],
            };
            accumulator.generations += entry.generations;
            accumulator.generationsWithUsage += entry.generationsWithUsage;
            if (entry.costUsd !== null) accumulator.costs.push(entry.costUsd);
            accumulator.flags.push(entry.pricing);
            byModel.set(entry.model, accumulator);
        }
    }
    const groups = [...byModel.entries()]
        .map(([model, accumulator]): ImageCostGroupView => ({
            model,
            generations: accumulator.generations,
            generationsWithUsage: accumulator.generationsWithUsage,
            costUsd: roundUsd(accumulator.costs.length === 0 ? null : sumOf(accumulator.costs)),
            pricing: mergedFlagOf(accumulator.flags, accumulator.costs.length > 0),
        }))
        .sort((first, second) => second.generations - first.generations || first.model.localeCompare(second.model));
    return {
        groups,
        imageCostUsd: roundUsd(costs.length === 0 ? null : sumOf(costs)),
        imageGenerations,
    };
};
