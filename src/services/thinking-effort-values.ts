/**
 * The chat thinking-effort setting: its closed set, its Chinese labels and the
 * option list a model offers (thinking-effort design 2026-1113-1742 §1.2/§5).
 * Canonical values, labels, and normalization live in `shared/contracts/thinking-effort.ts`.
 *
 * The stored value is NULL (the model default), 'off' (thinking switched off)
 * or one of the graded efforts. Whether the current model accepts a value is
 * not decided here: the setting is free text relative to the model and the
 * runtime resolves what actually goes out.
 */
import type { ModelCatalogReasoning } from '../config/model-capabilities.js';
import {
    THINKING_EFFORT_DEFAULT_LABEL,
    THINKING_EFFORT_LABELS,
    THINKING_EFFORT_OFF,
    THINKING_EFFORT_VALUES,
    normalizeThinkingEffort,
    type ThinkingEffort,
    type ThinkingEffortNormalization,
    type ThinkingEffortOption,
} from '../shared/contracts/thinking-effort.js';

export {
    THINKING_EFFORT_DEFAULT_LABEL,
    THINKING_EFFORT_LABELS,
    THINKING_EFFORT_OFF,
    THINKING_EFFORT_VALUES,
    normalizeThinkingEffort,
    type ThinkingEffort,
    type ThinkingEffortNormalization,
};

export type ThinkingEffortValue = ThinkingEffort;

/** One graded effort of a model, as the panel's chips show it */
export type ThinkingEffortOptionView = ThinkingEffortOption;

/**
 * A stored value read back. Only this service writes the column, so a value
 * outside the closed set means a hand-edited database: say so and behave as
 * "the model default" rather than guess.
 */
export const storedThinkingEffortOf = (text: string | null): ThinkingEffortValue | null => {
    if (text === null) return null;
    const normalized = normalizeThinkingEffort(text);
    if (!normalized.ok) {
        console.warn(`[thinking-effort] ignoring an invalid stored value: ${text}`);
        return null;
    }
    return normalized.value;
};

/** The graded efforts a model's reasoning section offers, in catalog order */
export const thinkingEffortOptionsOf = (
    reasoning: ModelCatalogReasoning | null | undefined
): readonly ThinkingEffortOptionView[] =>
    (reasoning?.efforts ?? []).map((effort) => ({ value: effort, label: THINKING_EFFORT_LABELS[effort] }));

/** Whether the model offers any graded effort at all */
export const thinkingEffortSupportedOf = (reasoning: ModelCatalogReasoning | null | undefined): boolean =>
    (reasoning?.efforts ?? []).length > 0;
