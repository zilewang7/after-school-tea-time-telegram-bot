/**
 * JSON with every object's keys sorted, so two structurally equal values give
 * the same text whatever order their keys were written in. Array order is
 * kept: it carries meaning (the tool list order is part of the request).
 */
import type { ToolDefinition } from '../../ai/tools/tool-types.js';

const sortedKeysReplacer = (_key: string, value: unknown): unknown => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
    return Object.fromEntries(
        Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    );
};

export const canonicalJson = (value: unknown): string => JSON.stringify(value, sortedKeysReplacer) ?? '';

/** The tool definitions a request carried, as the click-time check compares them */
export const toolDefinitionsJsonOf = (definitions: readonly ToolDefinition[]): string =>
    canonicalJson(definitions);
