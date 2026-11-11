/**
 * Per-chat tool switches (panel, owner-controlled).
 *
 * The panel may switch a group of tools on or off for one chat. Only the chat
 * whitelists (TOOL_CHAT_IDS / HISTORY_CHAT_IDS) are overridable; env kill
 * switches, URLs, model capabilities and the test instance's SMS guard stay
 * hard prerequisites (see resolveToolAvailability).
 *
 * Stored in chat_settings.toolOverrides as canonical JSON: keys in the order
 * below, only the keys the owner actually set, an empty object normalized to
 * NULL (nothing overridden). Unknown keys and non-boolean values are rejected.
 */
export const TOOL_GROUP_KEYS = [
    'sms',
    'image',
    'imageSearch',
    'imageFetch',
    'imageReverseSearch',
    'sticker',
    'file',
    'history',
    'harnessIssues',
    // Phase 0 gray: the whole widget pair is one switch
    'widget',
    // Appended last on purpose: this order is the canonical JSON/audit order
    'workspace',
] as const;

export type ToolGroupKey = (typeof TOOL_GROUP_KEYS)[number];

/** true = on for this chat, false = off, missing key = follow the env whitelist */
export type ToolOverrides = Partial<Record<ToolGroupKey, boolean>>;

/** No overrides at all: every group follows the env */
export const NO_TOOL_OVERRIDES: ToolOverrides = Object.freeze({});

const TOOL_GROUP_KEY_SET: ReadonlySet<string> = new Set(TOOL_GROUP_KEYS);

export const isToolGroupKey = (key: string): key is ToolGroupKey => TOOL_GROUP_KEY_SET.has(key);

export type ToolOverridesNormalization =
    | { ok: true; value: ToolOverrides | null }
    | { ok: false; message: string };

/** Fixed key order, so stored JSON and audit text are canonical */
const orderOverrides = (overrides: ToolOverrides): ToolOverrides => {
    const ordered: ToolOverrides = {};
    for (const key of TOOL_GROUP_KEYS) {
        const value = overrides[key];
        if (value !== undefined) ordered[key] = value;
    }
    return ordered;
};

/** null or an empty object means "follow the env"; bad shapes are rejected, never dropped */
export const normalizeToolOverrides = (raw: unknown): ToolOverridesNormalization => {
    if (raw === null) return { ok: true, value: null };
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, message: '工具开关必须是对象或 null' };
    }
    const overrides: ToolOverrides = {};
    let hasAnyKey = false;
    for (const [key, value] of Object.entries(raw)) {
        if (!isToolGroupKey(key)) return { ok: false, message: `未知的工具组：${key}` };
        if (typeof value !== 'boolean') return { ok: false, message: `工具开关 ${key} 必须是布尔值` };
        overrides[key] = value;
        hasAnyKey = true;
    }
    return { ok: true, value: hasAnyKey ? orderOverrides(overrides) : null };
};

/** The stored form: canonical JSON, or null when nothing is overridden */
export const canonicalToolOverridesJson = (overrides: ToolOverrides | null): string | null =>
    overrides === null ? null : JSON.stringify(orderOverrides(overrides));

export const toolOverridesEqual = (left: ToolOverrides | null, right: ToolOverrides | null): boolean =>
    canonicalToolOverridesJson(left) === canonicalToolOverridesJson(right);

/**
 * A stored value read back. Only this service writes the column, so bad data
 * means a hand-edited database: log it and behave as "no overrides".
 */
export const parseStoredToolOverrides = (text: string | null): ToolOverrides | null => {
    if (text === null) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        console.warn('[tool-overrides] ignoring an unparsable stored value');
        return null;
    }
    const normalized = normalizeToolOverrides(parsed);
    if (!normalized.ok) {
        console.warn(`[tool-overrides] ignoring an invalid stored value: ${normalized.message}`);
        return null;
    }
    return normalized.value;
};

/** The override of one group; null = follow the env */
export const toolOverrideOf = (overrides: ToolOverrides | null, key: ToolGroupKey): boolean | null => {
    if (overrides === null) return null;
    return overrides[key] ?? null;
};
