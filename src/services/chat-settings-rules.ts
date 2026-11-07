/**
 * Pure rules of a chat settings change: who may change what, how each value is
 * normalized and validated, and which keys actually change. No I/O, so the
 * service only persists what this decides.
 */
import {
    canonicalToolOverridesJson,
    normalizeToolOverrides,
    toolOverridesEqual,
    type ToolOverrides,
} from './tool-overrides.js';

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
    /** Per-chat tool switches; null = every group follows the env. Only the owner may touch `sms` */
    toolOverrides?: ToolOverrides | null;
}

export type ChatSettingKey = keyof ChatSettingsPatch;

/** Fixed order of keys in results and audit rows */
const CHAT_SETTING_KEYS: readonly ChatSettingKey[] = [
    'model',
    'promptAddendum',
    'paused',
    'settingsLocked',
    'toolOverrides',
];

/** `conflict`: the caller edited a version that someone else has since replaced */
export type ChatSettingsErrorCode = 'invalid' | 'forbidden' | 'locked' | 'conflict';

/** The values a patch can change */
export interface ChatSettingValues {
    model: string | null;
    promptAddendum: string | null;
    paused: boolean;
    settingsLocked: boolean;
    toolOverrides: ToolOverrides | null;
}

export interface ChatSettingChange {
    key: ChatSettingKey;
    /** Audit format: model id / full text / 'true' | 'false' / canonical overrides JSON; null = unset */
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

const unchanged = <T>(value: T): Normalized<T> => ({ ok: true, value });

/** Every key's audit text: booleans as 'true' / 'false', overrides as canonical JSON */
const auditValuesOf = (values: ChatSettingValues): Record<ChatSettingKey, string | null> => ({
    model: values.model,
    promptAddendum: values.promptAddendum,
    paused: String(values.paused),
    settingsLocked: String(values.settingsLocked),
    toolOverrides: canonicalToolOverridesJson(values.toolOverrides),
});

/** Whether one key's value actually changes (overrides compare as canonical JSON) */
const CHANGED: Record<ChatSettingKey, (current: ChatSettingValues, next: ChatSettingValues) => boolean> = {
    model: (current, next) => current.model !== next.model,
    promptAddendum: (current, next) => current.promptAddendum !== next.promptAddendum,
    paused: (current, next) => current.paused !== next.paused,
    settingsLocked: (current, next) => current.settingsLocked !== next.settingsLocked,
    toolOverrides: (current, next) => !toolOverridesEqual(current.toolOverrides, next.toolOverrides),
};

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
    const toolOverrides = patch.toolOverrides === undefined
        ? unchanged(current.toolOverrides)
        : normalizeToolOverrides(patch.toolOverrides);
    if (!toolOverrides.ok) return toolOverrides;
    return {
        ok: true,
        value: {
            model: model.value,
            promptAddendum: promptAddendum.value,
            paused: paused.value,
            settingsLocked: settingsLocked.value,
            toolOverrides: toolOverrides.value,
        },
    };
};

/** The SMS switch sends a real SMS to the owner, so only the owner may change it */
const smsChanged = (current: ToolOverrides | null, next: ToolOverrides | null): boolean =>
    (current?.sms ?? null) !== (next?.sms ?? null);

/**
 * Decide a patch against the current values. Checks run in this order:
 * 1. the chat is locked and the actor is not the owner → locked (before any
 *    value is looked at);
 * 2. a non-owner touches settingsLocked → forbidden;
 * 3. a value is malformed → invalid;
 * 4. a non-owner changes the sms switch → forbidden.
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
    if (!actorIsOwner && smsChanged(current.toolOverrides, next.toolOverrides)) {
        return { kind: 'rejected', code: 'forbidden', message: '只有机主可以开关本聊天的短信工具' };
    }

    const oldValues = auditValuesOf(current);
    const newValues = auditValuesOf(next);
    const changes = CHAT_SETTING_KEYS
        .filter((key) => CHANGED[key](current, next))
        .map((key) => ({ key, oldValue: oldValues[key], newValue: newValues[key] }));
    return { kind: 'resolved', next, changes };
};
