/**
 * Pure rules of a chat settings change: who may change what, how each value is
 * normalized and validated, and which keys actually change. No I/O, so the
 * service only persists what this decides.
 */
export const MODEL_ID_MAX_LENGTH = 64;
export const PROMPT_ADDENDUM_MAX_CODE_POINTS = 2000;

export interface ChatSettingsPatch {
    /** null = follow the global default */
    model?: string | null;
    /** null or blank = none */
    promptAddendum?: string | null;
    paused?: boolean;
    /** Owner only */
    settingsLocked?: boolean;
}

export type ChatSettingKey = keyof ChatSettingsPatch;

/** Fixed order of keys in results and audit rows */
const CHAT_SETTING_KEYS: readonly ChatSettingKey[] = ['model', 'promptAddendum', 'paused', 'settingsLocked'];

/** `conflict`: the caller edited a version that someone else has since replaced */
export type ChatSettingsErrorCode = 'invalid' | 'forbidden' | 'locked' | 'conflict';

/** The values a patch can change */
export interface ChatSettingValues {
    model: string | null;
    promptAddendum: string | null;
    paused: boolean;
    settingsLocked: boolean;
}

export interface ChatSettingChange {
    key: ChatSettingKey;
    /** Audit format: model id / full text / 'true' | 'false'; null = unset */
    oldValue: string | null;
    newValue: string | null;
}

export type PatchResolution =
    | { kind: 'rejected'; code: ChatSettingsErrorCode; message: string }
    | { kind: 'resolved'; next: ChatSettingValues; changes: readonly ChatSettingChange[] };

type Normalized<T> = { ok: true; value: T } | { ok: false; message: string };

export const countCodePoints = (text: string): number => Array.from(text).length;

/** A model id: any trimmed non-empty string up to 64 characters; null = follow global */
export const normalizeModelId = (raw: unknown): Normalized<string | null> => {
    if (raw === null) return { ok: true, value: null };
    if (typeof raw !== 'string') return { ok: false, message: '模型 id 必须是字符串或 null' };
    const trimmed = raw.trim();
    if (trimmed.length === 0) return { ok: false, message: '模型 id 不能为空' };
    if (countCodePoints(trimmed) > MODEL_ID_MAX_LENGTH) {
        return { ok: false, message: `模型 id 不能超过 ${MODEL_ID_MAX_LENGTH} 个字符` };
    }
    return { ok: true, value: trimmed };
};

/**
 * CRLF becomes LF, surrounding whitespace goes, blank means none. Too long is
 * an error, never a silent cut.
 */
export const normalizePromptAddendum = (raw: unknown): Normalized<string | null> => {
    if (raw === null) return { ok: true, value: null };
    if (typeof raw !== 'string') return { ok: false, message: '附加提示词必须是字符串或 null' };
    const normalized = raw.replace(/\r\n/g, '\n').trim();
    if (normalized.length === 0) return { ok: true, value: null };
    const length = countCodePoints(normalized);
    if (length > PROMPT_ADDENDUM_MAX_CODE_POINTS) {
        return {
            ok: false,
            message: `附加提示词不能超过 ${PROMPT_ADDENDUM_MAX_CODE_POINTS} 字（当前 ${length} 字）`,
        };
    }
    return { ok: true, value: normalized };
};

const normalizeFlag = (raw: unknown, key: ChatSettingKey): Normalized<boolean> =>
    typeof raw === 'boolean' ? { ok: true, value: raw } : { ok: false, message: `${key} 必须是布尔值` };

const auditValueOf = (value: string | boolean | null): string | null =>
    typeof value === 'boolean' ? String(value) : value;

const unchanged = <T>(value: T): Normalized<T> => ({ ok: true, value });

/** Normalize every key present in the patch; absent keys keep `current`. The first bad value wins */
const applyPatchValues = (current: ChatSettingValues, patch: ChatSettingsPatch): Normalized<ChatSettingValues> => {
    const model = patch.model === undefined ? unchanged(current.model) : normalizeModelId(patch.model);
    if (!model.ok) return model;
    const promptAddendum = patch.promptAddendum === undefined
        ? unchanged(current.promptAddendum)
        : normalizePromptAddendum(patch.promptAddendum);
    if (!promptAddendum.ok) return promptAddendum;
    const paused = patch.paused === undefined ? unchanged(current.paused) : normalizeFlag(patch.paused, 'paused');
    if (!paused.ok) return paused;
    const settingsLocked = patch.settingsLocked === undefined
        ? unchanged(current.settingsLocked)
        : normalizeFlag(patch.settingsLocked, 'settingsLocked');
    if (!settingsLocked.ok) return settingsLocked;
    return {
        ok: true,
        value: {
            model: model.value,
            promptAddendum: promptAddendum.value,
            paused: paused.value,
            settingsLocked: settingsLocked.value,
        },
    };
};

/**
 * Decide a patch against the current values. Checks run in this order:
 * 1. the chat is locked and the actor is not the owner → locked (before any
 *    value is looked at);
 * 2. a non-owner touches settingsLocked → forbidden;
 * 3. a value is malformed → invalid.
 * Keys whose normalized value equals the current one are not changes.
 */
export const resolveChatSettingsPatch = (
    current: ChatSettingValues,
    patch: ChatSettingsPatch,
    actorIsOwner: boolean
): PatchResolution => {
    if (current.settingsLocked && !actorIsOwner) {
        return { kind: 'rejected', code: 'locked', message: '本聊天的设置已被机主锁定' };
    }
    if (patch.settingsLocked !== undefined && !actorIsOwner) {
        return { kind: 'rejected', code: 'forbidden', message: '只有机主可以锁定或解锁本聊天的设置' };
    }
    const applied = applyPatchValues(current, patch);
    if (!applied.ok) return { kind: 'rejected', code: 'invalid', message: applied.message };

    const next = applied.value;
    const changes = CHAT_SETTING_KEYS
        .filter((key) => next[key] !== current[key])
        .map((key) => ({
            key,
            oldValue: auditValueOf(current[key]),
            newValue: auditValueOf(next[key]),
        }));
    return { kind: 'resolved', next, changes };
};
