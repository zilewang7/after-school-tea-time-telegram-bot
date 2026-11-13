/**
 * Runtime resolution of a chat's thinking level against the model's catalog
 * data (thinking-effort design 2026-1113-1742 §3.2).
 *
 * The chat setting is free text relative to the model: it is stored as-is and
 * interpreted here every time, because the chat can switch models. The resolver
 * never throws and never sends a value the model does not offer:
 *
 * - `null` (the model default) → mode 'default', no explicit level;
 * - `'off'` → mode 'off' only for a toggle model, otherwise the model default;
 * - a graded effort inside the model's list → mode 'explicit' with that value;
 * - a graded effort outside the list → the highest supported level below it
 *   (the lowest supported level when it is below all of them), clamped;
 * - a toggle-only model (no graded levels) → the model default;
 * - a model with no catalog/seed data at all → the code fallback: source
 *   'code' means "do not add a request field", so the platform keeps sending
 *   exactly today's hard-coded knowledge-level behaviour (byte-identical).
 *
 * `clamped`/`source` are display and metrics facts: the request layer uses
 * `source === 'code'` to omit the platform field, and the reply metrics record
 * what was asked for, what went out and the degradation chain.
 */
import { match } from 'ts-pattern';
import type { ModelCatalogReasoning, ModelEffort } from '../config/model-capabilities.js';
import { isModelEffort, MODEL_EFFORTS } from '../config/model-capabilities.js';
import { THINKING_EFFORT_OFF } from '../services/thinking-effort-values.js';
import type { ThinkingEffortRequest } from './types.js';
import { resolveModelTraits } from './model-traits.js';

/** Where the resolved level came from: the chat setting, the model default, or code */
export type ThinkingEffortSource = 'chat' | 'model-default' | 'code';

export interface ResolvedThinkingEffort {
    readonly mode: ThinkingEffortRequest['mode'];
    /** Lower-case effort for mode 'explicit'; null for 'default'/'off' */
    readonly value: string | null;
    /** The requested level was lowered to one the model supports */
    readonly clamped: boolean;
    readonly source: ThinkingEffortSource;
}

const modelDefault = (): ResolvedThinkingEffort => ({
    mode: 'default',
    value: null,
    clamped: false,
    source: 'model-default',
});

/** No data for the model: keep the platform's current hard-coded behaviour */
const codeDefault = (): ResolvedThinkingEffort => ({
    mode: 'default',
    value: null,
    clamped: false,
    source: 'code',
});

/** The highest supported level not above `requested`, else the lowest supported one */
const clampedEffortOf = (requested: ModelEffort, efforts: readonly ModelEffort[]): ModelEffort => {
    const requestedRank = MODEL_EFFORTS.indexOf(requested);
    const below = efforts.filter((effort) => MODEL_EFFORTS.indexOf(effort) <= requestedRank);
    if (below.length > 0) {
        return below.reduce((highest, effort) =>
            MODEL_EFFORTS.indexOf(effort) > MODEL_EFFORTS.indexOf(highest) ? effort : highest
        );
    }
    return efforts.reduce((lowest, effort) =>
        MODEL_EFFORTS.indexOf(effort) < MODEL_EFFORTS.indexOf(lowest) ? effort : lowest
    );
};

/** The graded-value branch: inside the list, clamped, or not applicable */
const gradedResultOf = (
    reasoning: ModelCatalogReasoning,
    requested: string | null
): ResolvedThinkingEffort => {
    const efforts = reasoning.efforts ?? [];
    // An invalid stored value and a model without graded levels both fall back
    // to the model default (the setting is not refused at write time).
    if (requested === null || !isModelEffort(requested) || efforts.length === 0) return modelDefault();
    if (efforts.includes(requested)) {
        return { mode: 'explicit', value: requested, clamped: false, source: 'chat' };
    }
    return { mode: 'explicit', value: clampedEffortOf(requested, efforts), clamped: true, source: 'chat' };
};

/** Resolve one chat setting against one model; the reply, retry and continue share it */
export const resolveThinkingEffort = (model: string, requested: string | null): ResolvedThinkingEffort => {
    const traits = resolveModelTraits(model);
    const reasoning = traits.capabilities?.reasoning;
    // No capabilities, or capabilities whose reasoning section is unknown: the
    // code fallback keeps today's request byte-identical.
    if (traits.capabilities === null || reasoning === undefined) return codeDefault();
    return match(requested)
        .returnType<ResolvedThinkingEffort>()
        .with(null, () => modelDefault())
        .with(THINKING_EFFORT_OFF, () =>
            reasoning.toggle === true
                ? { mode: 'off', value: null, clamped: false, source: 'chat' }
                : modelDefault()
        )
        .otherwise((value) => gradedResultOf(reasoning, value));
};

/** The value a reply would record as sent for a resolved result; null = nothing explicit */
export const sentEffortOf = (resolved: ResolvedThinkingEffort): string | null =>
    match(resolved.mode)
        .returnType<string | null>()
        .with('explicit', () => resolved.value)
        .with('off', () => THINKING_EFFORT_OFF)
        .with('default', () => null)
        .exhaustive();

/** The degradation chain for the reply metrics, e.g. 'xhigh->high'; null = none */
export const effortFallbackOf = (requested: string | null, resolved: ResolvedThinkingEffort): string | null => {
    if (!resolved.clamped || requested === null || resolved.value === null) return null;
    return `${requested}->${resolved.value}`;
};
