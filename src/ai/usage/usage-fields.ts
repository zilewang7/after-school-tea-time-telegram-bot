/**
 * Loose readers for usage JSON. Relays and providers add, drop and rename
 * fields, so nothing here trusts an SDK type: every count is read from
 * `unknown` and must be a non-negative integer to count.
 */
import { isJsonObject } from '../../shared/json-object.js';

export type FieldPath = readonly string[];

/** The value at `path` inside nested objects; undefined anywhere along a missing path */
export const valueAt = (value: unknown, path: FieldPath): unknown =>
    path.reduce<unknown>((current, key) => (isJsonObject(current) ? current[key] : undefined), value);

/** A token count at `path`, or null when there is none */
export const tokenCountAt = (value: unknown, path: FieldPath): number | null => {
    const found = valueAt(value, path);
    return typeof found === 'number' && Number.isInteger(found) && found >= 0 ? found : null;
};

/** The count at the first path that has one */
export const firstTokenCount = (value: unknown, paths: readonly FieldPath[]): number | null => {
    for (const path of paths) {
        const count = tokenCountAt(value, path);
        if (count !== null) return count;
    }
    return null;
};

/** The larger of two cumulative counts; null only when neither is known */
export const largerCount = (first: number | null, second: number | null): number | null => {
    if (first === null) return second;
    if (second === null) return first;
    return Math.max(first, second);
};

/**
 * Whether a reported output count leaves the reasoning out. Providers differ
 * and none says so, but the total gives it away: total = input + output +
 * reasoning only when reasoning is not part of output. Without a total (or
 * without reasoning) output is taken as is, the OpenAI convention.
 */
export const outputExcludesReasoning = (counts: {
    readonly input: number | null;
    readonly output: number | null;
    readonly reasoning: number | null;
    readonly total: number | null;
}): boolean => {
    const { input, output, reasoning, total } = counts;
    if (input === null || output === null || reasoning === null || total === null || reasoning === 0) return false;
    return total === input + output + reasoning;
};
