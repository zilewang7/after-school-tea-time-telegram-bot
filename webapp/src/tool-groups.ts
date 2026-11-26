/**
 * The tool groups of the panel's per-chat switches: labels, hints and canonical
 * order come from `src/shared/contracts/tool-groups.ts`. Also the parser for
 * the audit's canonical JSON value.
 */
import {
    TOOL_GROUP_HINTS,
    TOOL_GROUP_KEYS,
    TOOL_GROUP_LABELS,
    TOOL_GROUP_ORDER,
    isToolGroupKey,
    toolGroupHintOf,
    toolGroupLabelOf,
    type ToolGroupKey,
    type ToolOverrides,
} from '../../src/shared/contracts/tool-groups.js';

export {
    TOOL_GROUP_HINTS,
    TOOL_GROUP_KEYS,
    TOOL_GROUP_LABELS,
    TOOL_GROUP_ORDER,
    isToolGroupKey,
    toolGroupHintOf,
    toolGroupLabelOf,
    type ToolGroupKey,
    type ToolOverrides,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** The audit stores canonical JSON; null when absent or unreadable */
export const parseToolOverridesJson = (text: string | null): ToolOverrides | null => {
    if (text === null) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    if (!isRecord(parsed)) return null;
    const overrides: ToolOverrides = {};
    for (const key of TOOL_GROUP_ORDER) {
        const value = parsed[key];
        if (typeof value === 'boolean') overrides[key] = value;
    }
    return overrides;
};
