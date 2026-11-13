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
import { normalizeThinkingEffort, type ThinkingEffortValue } from './thinking-effort-values.js';

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
    /**
     * Priority PayGo for Gemini; null = follow the global switch. Owner only;
     * true only where it can take effect (global on, or a TOOL_CHAT_IDS chat)
     */
    geminiPriority?: boolean | null;
    /**
     * Thinking level; null = the model default, 'off' = thinking off, else a
     * graded effort. A free string here (like model): the rules narrow it to
     * the closed set. Members may change it; trial users may not.
     */
    thinkingEffort?: string | null;
}

export type ChatSettingKey = keyof ChatSettingsPatch;

/** Fixed order of keys in results and audit rows */
const CHAT_SETTING_KEYS: readonly ChatSettingKey[] = [
    'model',
    'promptAddendum',
    'paused',
    'settingsLocked',
    'toolOverrides',
    'geminiPriority',
    'thinkingEffort',
];

/** `conflict`: the caller edited a version that someone else has since replaced */
export type ChatSettingsErrorCode = 'invalid' | 'forbidden' | 'locked' | 'conflict' | 'trial';

/** The values a patch can change */
export interface ChatSettingValues {
    model: string | null;
    promptAddendum: string | null;
    paused: boolean;
    settingsLocked: boolean;
    toolOverrides: ToolOverrides | null;
    geminiPriority: boolean | null;
    thinkingEffort: ThinkingEffortValue | null;
}

/** Who asks, and what the chat allows; the service reads both before the rules run */
export interface PatchContext {
    actorIsOwner: boolean;
    /** Priority PayGo may be switched on here: the global switch is on, or the chat is in TOOL_CHAT_IDS */
    geminiPriorityCanEnable: boolean;
    /** The actor is a trial user (access design D1-B); the owner is never one. Absent = not trial */
    actorIsTrial?: boolean;
}

/** The panel shows it next to the disabled "on" choice as well */
export const GEMINI_PRIORITY_NOT_ALLOWED_MESSAGE = '全局关闭时，只有工具白名单里的会话可以单独开启';

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

/** A three-state switch: true / false, or null for "not set, follow the global value" */
export const normalizeNullableFlag = (raw: unknown, key: ChatSettingKey): Normalized<boolean | null> =>
    raw === null || typeof raw === 'boolean'
        ? { ok: true, value: raw }
        : { ok: false, message: `${key} 必须是布尔值或 null` };

/** 'true' / 'false', and NULL for an unset three-state switch (never the text 'null') */
const nullableFlagAuditText = (value: boolean | null): string | null => (value === null ? null : String(value));

const unchanged = <T>(value: T): Normalized<T> => ({ ok: true, value });

/** Every key's audit text: booleans as 'true' / 'false', overrides as canonical JSON */
const auditValuesOf = (values: ChatSettingValues): Record<ChatSettingKey, string | null> => ({
    model: values.model,
    promptAddendum: values.promptAddendum,
    paused: String(values.paused),
    settingsLocked: String(values.settingsLocked),
    toolOverrides: canonicalToolOverridesJson(values.toolOverrides),
    geminiPriority: nullableFlagAuditText(values.geminiPriority),
    thinkingEffort: values.thinkingEffort,
});

/** Whether one key's value actually changes (overrides compare as canonical JSON) */
const CHANGED: Record<ChatSettingKey, (current: ChatSettingValues, next: ChatSettingValues) => boolean> = {
    model: (current, next) => current.model !== next.model,
    promptAddendum: (current, next) => current.promptAddendum !== next.promptAddendum,
    paused: (current, next) => current.paused !== next.paused,
    settingsLocked: (current, next) => current.settingsLocked !== next.settingsLocked,
    toolOverrides: (current, next) => !toolOverridesEqual(current.toolOverrides, next.toolOverrides),
    geminiPriority: (current, next) => current.geminiPriority !== next.geminiPriority,
    thinkingEffort: (current, next) => current.thinkingEffort !== next.thinkingEffort,
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
    const geminiPriority = patch.geminiPriority === undefined
        ? unchanged(current.geminiPriority)
        : normalizeNullableFlag(patch.geminiPriority, 'geminiPriority');
    if (!geminiPriority.ok) return geminiPriority;
    const thinkingEffort = patch.thinkingEffort === undefined
        ? unchanged(current.thinkingEffort)
        : normalizeThinkingEffort(patch.thinkingEffort);
    if (!thinkingEffort.ok) return thinkingEffort;
    return {
        ok: true,
        value: {
            model: model.value,
            promptAddendum: promptAddendum.value,
            paused: paused.value,
            settingsLocked: settingsLocked.value,
            toolOverrides: toolOverrides.value,
            geminiPriority: geminiPriority.value,
            thinkingEffort: thinkingEffort.value,
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
 * 4. a non-owner changes the sms switch → forbidden;
 * 5. a non-owner changes the Priority PayGo switch → forbidden;
 * 6. the Priority PayGo switch changes to on where it cannot take effect → forbidden;
 * 7. a trial user changes the model → trial (the model is the biggest cost);
 * 8. a trial user changes the thinking level → trial (it changes the cost too).
 * Keys whose normalized value equals the current one are not changes, so a
 * stored "on" the global switch no longer allows does not block other keys.
 */
export const resolveChatSettingsPatch = (
    current: ChatSettingValues,
    patch: ChatSettingsPatch,
    context: PatchContext
): PatchResolution => {
    const { actorIsOwner } = context;
    const actorIsTrial = context.actorIsTrial === true;
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
    // Priority PayGo is billed to the owner at 1.8 times the standard price
    const priorityChanged = CHANGED.geminiPriority(current, next);
    if (!actorIsOwner && priorityChanged) {
        return { kind: 'rejected', code: 'forbidden', message: '只有机主可以开关本聊天的 Priority PayGo' };
    }
    if (priorityChanged && next.geminiPriority === true && !context.geminiPriorityCanEnable) {
        return { kind: 'rejected', code: 'forbidden', message: GEMINI_PRIORITY_NOT_ALLOWED_MESSAGE };
    }

    const oldValues = auditValuesOf(current);
    const newValues = auditValuesOf(next);
    const changes = CHAT_SETTING_KEYS
        .filter((key) => CHANGED[key](current, next))
        .map((key) => ({ key, oldValue: oldValues[key], newValue: newValues[key] }));
    if (!actorIsOwner && actorIsTrial) {
        if (changes.some((change) => change.key === 'model')) {
            return {
                kind: 'rejected',
                code: 'trial',
                message: '体验用户不能修改本聊天的模型；申请准入后可以修改',
            };
        }
        if (changes.some((change) => change.key === 'thinkingEffort')) {
            return {
                kind: 'rejected',
                code: 'trial',
                message: '体验用户不能修改本聊天的思考等级；申请准入后可以修改',
            };
        }
    }
    return { kind: 'resolved', next, changes };
};
