/**
 * Pure rules of a global settings change (design §8.5): owner only; every key
 * present is normalized before anything is decided, so one bad value refuses
 * the whole patch; keys whose value does not change are dropped. No I/O.
 */
import { match } from 'ts-pattern';
import { normalizeModelId, type ChatSettingsErrorCode } from './chat-settings-rules.js';

export interface GlobalSettingsPatch {
    /** A model id; null removes the panel value, so DEFAULT_MODEL applies again */
    defaultModel?: string | null;
    /** The global Priority PayGo switch; booleans only (no row reads as off) */
    defaultGeminiPriority?: boolean;
}

export type GlobalSettingKey = keyof GlobalSettingsPatch;

/** Fixed order of keys in writes and audit rows */
export const GLOBAL_SETTING_KEYS: readonly GlobalSettingKey[] = ['defaultModel', 'defaultGeminiPriority'];

export interface GlobalSettingChange {
    key: GlobalSettingKey;
    /** The stored text before (also the audit's old value); null = no row */
    oldValue: string | null;
    /** The text to store (also the audit's new value); null = remove the row */
    newValue: string | null;
}

export type GlobalPatchResolution =
    | { kind: 'rejected'; code: ChatSettingsErrorCode; message: string }
    | { kind: 'resolved'; changes: readonly GlobalSettingChange[] };

export interface GlobalPatchContext {
    actorIsOwner: boolean;
    /** The stored text of a key; null when it has no row */
    storedValueOf: (key: GlobalSettingKey) => string | null;
}

type Normalized<T> = { ok: true; value: T } | { ok: false; message: string };

/** The switch is stored as 'true' / 'false' */
const normalizeSwitchText = (raw: unknown, key: GlobalSettingKey): Normalized<string> =>
    typeof raw === 'boolean' ? { ok: true, value: String(raw) } : { ok: false, message: `${key} 必须是布尔值` };

/** The text a present key is stored as; null removes the row */
const storedTextOf = (key: GlobalSettingKey, patch: GlobalSettingsPatch): Normalized<string | null> =>
    match(key)
        .with('defaultModel', () => normalizeModelId(patch.defaultModel))
        .with('defaultGeminiPriority', () => normalizeSwitchText(patch.defaultGeminiPriority, key))
        .exhaustive();

const isChange = (change: GlobalSettingChange): boolean =>
    match(change.key)
        .with('defaultModel', () => change.oldValue !== change.newValue)
        // No row reads as off, so writing 'false' there changes nothing
        .with('defaultGeminiPriority', () => (change.oldValue === 'true') !== (change.newValue === 'true'))
        .exhaustive();

/**
 * Decide a patch: a non-owner → forbidden (before any value is looked at);
 * then the first malformed value → invalid, with nothing written for any key.
 * An empty patch, or one whose values all match, resolves to no change.
 */
export const resolveGlobalSettingsPatch = (
    patch: GlobalSettingsPatch,
    context: GlobalPatchContext
): GlobalPatchResolution => {
    if (!context.actorIsOwner) {
        return { kind: 'rejected', code: 'forbidden', message: '只有机主可以修改全局设置' };
    }
    const proposed: GlobalSettingChange[] = [];
    for (const key of GLOBAL_SETTING_KEYS.filter((candidate) => patch[candidate] !== undefined)) {
        const normalized = storedTextOf(key, patch);
        if (!normalized.ok) return { kind: 'rejected', code: 'invalid', message: normalized.message };
        proposed.push({ key, oldValue: context.storedValueOf(key), newValue: normalized.value });
    }
    return { kind: 'resolved', changes: proposed.filter(isChange) };
};
