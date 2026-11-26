/**
 * The only write path for per-chat settings, shared by the panel and `/model`:
 * check → normalize → persist row and audit in one transaction → update the
 * in-memory cache. Reads are synchronous and come from the cache. The global
 * settings write lives in global-settings-service and is re-exported here.
 *
 * Writes for one scope run one at a time, so two concurrent patches of the
 * same chat never compute against the same stale snapshot (each row write
 * carries every column).
 */
import { sequelize } from '../db/config.js';
import { withBusyRetry } from '../db/busy-retry.js';
import { ChatSettingsRecord } from '../db/chatSettingsDTO.js';
import { chatAuditScope, writeSettingsAudit } from '../db/queries/settings-audit.js';
import { resolveChatModel } from './chat-model.js';
import { resolveAccessTier } from './access-tier.js';
import {
    canEnableGeminiPriority,
    getChatSettings,
    resolveGeminiPriority,
    storeChatSettings,
    type ChatSettings,
} from './chat-settings-cache.js';
import {
    CHAT_PROMPT_ADDENDUM_MAX_CODE_POINTS,
    resolveChatSettingsPatch,
    type ChatSettingChange,
    type ChatSettingKey,
    type ChatSettingValues,
    type ChatSettingsPatch,
} from './chat-settings-rules.js';
import { getPromptTemplate, ensurePromptTemplatesCacheLoaded } from './prompt-templates-cache.js';
import { canonicalTemplateIdListJson } from './prompt-template-ids.js';
import { ChatSettingsError, type SettingsActor } from './settings-errors.js';
import { ensureCacheLoaded, runSerialized } from './settings-write-queue.js';
import type { ThinkingEffortValue } from './thinking-effort-values.js';
import { canonicalToolOverridesJson, type ToolOverrides } from './tool-overrides.js';
import { countCodePoints } from '../shared/code-points.js';

export {
    loadChatSettingsCache,
    isChatSettingsCacheLoaded,
    getChatSettings,
    listChatSettings,
    isChatPaused,
    isChatSettingsLocked,
    getGlobalDefaultModel,
    getGlobalDefaultModelSource,
    DEFAULT_GEMINI_PRIORITY_SETTING_KEY,
    getGlobalGeminiPriority,
    canEnableGeminiPriority,
    resolveGeminiPriority,
    type ChatSettings,
} from './chat-settings-cache.js';
export {
    GEMINI_PRIORITY_NOT_ALLOWED_MESSAGE,
    IMAGE_MODEL_NOT_CHAT_MESSAGE,
    MODEL_ID_MAX_LENGTH,
    CHAT_PROMPT_ADDENDUM_MAX_CODE_POINTS,
    PROMPT_ADDENDUM_MAX_CODE_POINTS,
    countCodePoints,
    normalizeNullableFlag,
    normalizePromptAddendum,
    type ChatSettingKey,
    type ChatSettingsErrorCode,
    type ChatSettingsPatch,
} from './chat-settings-rules.js';
export { MAX_TEMPLATE_SELECTIONS } from './prompt-template-ids.js';
export { ChatSettingsError, type SettingsActor } from './settings-errors.js';
export {
    GLOBAL_SETTING_KEYS,
    type GlobalSettingKey,
    type GlobalSettingsPatch,
} from './global-settings-rules.js';
export {
    updateGlobalDefaultModel,
    updateGlobalSettings,
    type GlobalSettingsUpdateResult,
} from './global-settings-service.js';
export {
    TOOL_GROUP_KEYS,
    NO_TOOL_OVERRIDES,
    canonicalToolOverridesJson,
    normalizeToolOverrides,
    parseStoredToolOverrides,
    toolOverrideOf,
    type ToolGroupKey,
    type ToolOverrides,
} from './tool-overrides.js';
export {
    THINKING_EFFORT_DEFAULT_LABEL,
    THINKING_EFFORT_LABELS,
    THINKING_EFFORT_OFF,
    THINKING_EFFORT_VALUES,
    normalizeThinkingEffort,
    storedThinkingEffortOf,
    thinkingEffortOptionsOf,
    thinkingEffortSupportedOf,
    type ThinkingEffortOptionView,
    type ThinkingEffortValue,
} from './thinking-effort-values.js';

/** What one reply uses, taken once when the reply starts */
export interface ReplySettingsSnapshot {
    model: string;
    promptAddendum: string | null;
    /** The manual template selection at the same moment; null = none */
    promptTemplateIds: number[] | null;
    /** The auto-load switch at the same moment; off unless the chat turned it on */
    promptTemplatesAuto: boolean;
    /** The per-chat tool switches at the same moment; null = follow the env */
    toolOverrides: ToolOverrides | null;
    /** The effective Priority PayGo switch (chat value, global switch and whitelist resolved) */
    geminiPriority: boolean;
    /** The thinking level as stored: null = the model default, 'off', else a graded effort */
    thinkingEffort: ThinkingEffortValue | null;
    /**
     * Experimental rich replies as the chat had them when the reply started.
     * Presentation only: the model request does not depend on it, so a 继续
     * does not compare it. Read here rather than from the cache, so a change
     * while a reply runs does not switch its form halfway.
     */
    richReplies: boolean;
}

export interface ChatSettingsUpdateResult {
    settings: ChatSettings;
    /** Empty when every value already matched: nothing was written or audited */
    changedKeys: readonly ChatSettingKey[];
}

export const snapshotReplySettings = (chatId: number): ReplySettingsSnapshot => ({
    model: resolveChatModel(chatId),
    promptAddendum: getChatSettings(chatId)?.promptAddendum ?? null,
    promptTemplateIds: getChatSettings(chatId)?.promptTemplateIds ?? null,
    promptTemplatesAuto: getChatSettings(chatId)?.promptTemplatesAuto === true,
    toolOverrides: getChatSettings(chatId)?.toolOverrides ?? null,
    geminiPriority: resolveGeminiPriority(chatId),
    thinkingEffort: getChatSettings(chatId)?.thinkingEffort ?? null,
    richReplies: getChatSettings(chatId)?.richReplies === true,
});

/** What a chat without a settings row behaves as; updatedAt is the epoch, updatedBy null */
export const defaultChatSettings = (chatId: number): ChatSettings => ({
    chatId,
    model: null,
    promptAddendum: null,
    promptTemplateIds: null,
    promptTemplatesAuto: false,
    paused: false,
    settingsLocked: false,
    toolOverrides: null,
    geminiPriority: null,
    thinkingEffort: null,
    richReplies: false,
    updatedAt: new Date(0),
    updatedBy: null,
});

/** The caller loaded another version than the current one (optimistic concurrency) */
const isStaleEdit = (current: ChatSettings, expectedUpdatedAt: Date | null | undefined): boolean =>
    expectedUpdatedAt !== undefined &&
    expectedUpdatedAt !== null &&
    current.updatedAt.getTime() !== expectedUpdatedAt.getTime();

/** The keys whose change re-checks the composed addendum's length */
const COMPOSED_ADDENDUM_KEYS: ReadonlySet<ChatSettingKey> = new Set([
    'promptAddendum',
    'promptTemplateIds',
    'promptTemplatesAuto',
]);

/**
 * The code points a reply would load from the chat's own selection: the content
 * of its manually enabled templates plus its own text. Unknown ids (a deleted
 * template) and disabled templates load nothing and count nothing.
 */
const composedAddendumCodePoints = (values: ChatSettingValues): number => {
    let total = 0;
    for (const id of values.promptTemplateIds ?? []) {
        const template = getPromptTemplate(id);
        if (template === undefined || !template.enabled) continue;
        total += countCodePoints(template.content);
    }
    if (values.promptAddendum !== null) total += countCodePoints(values.promptAddendum);
    return total;
};

/** The save-time guard of design D3: manual templates + own text fit one budget */
const assertComposedAddendumFits = (
    values: ChatSettingValues,
    changes: readonly ChatSettingChange[]
): void => {
    if (!changes.some((change) => COMPOSED_ADDENDUM_KEYS.has(change.key))) return;
    const composed = composedAddendumCodePoints(values);
    if (composed <= CHAT_PROMPT_ADDENDUM_MAX_CODE_POINTS) return;
    throw new ChatSettingsError(
        'invalid',
        `启用的模板与自定义附加提示词合计 ${composed} 字，超过上限 ${CHAT_PROMPT_ADDENDUM_MAX_CODE_POINTS} 字`
    );
};

const persistChatSettings = async (
    settings: ChatSettings,
    changes: readonly ChatSettingChange[],
    actorId: number
): Promise<void> => {
    await sequelize.transaction(async (transaction) => {
        await ChatSettingsRecord.upsert(
            {
                chatId: settings.chatId,
                model: settings.model,
                promptAddendum: settings.promptAddendum,
                promptTemplateIds: canonicalTemplateIdListJson(settings.promptTemplateIds),
                promptTemplatesAuto: settings.promptTemplatesAuto,
                paused: settings.paused,
                settingsLocked: settings.settingsLocked,
                toolOverrides: canonicalToolOverridesJson(settings.toolOverrides),
                // Every column, or a value would live in the cache only and vanish on restart
                geminiPriority: settings.geminiPriority,
                thinkingEffort: settings.thinkingEffort,
                richReplies: settings.richReplies,
                updatedAt: settings.updatedAt,
                updatedBy: settings.updatedBy,
            },
            { transaction }
        );
        for (const change of changes) {
            await writeSettingsAudit(
                {
                    actorId,
                    scope: chatAuditScope(settings.chatId),
                    key: change.key,
                    oldValue: change.oldValue,
                    newValue: change.newValue,
                },
                { transaction }
            );
        }
    });
};

/**
 * Change some of a chat's settings. Throws ChatSettingsError: `locked` when
 * the chat is locked and the actor is not the owner (checked first),
 * `forbidden` when a non-owner touches settingsLocked, the sms tool switch or
 * the Priority PayGo switch, or when Priority PayGo is switched on where it
 * cannot take effect (global switch off, chat not in TOOL_CHAT_IDS),
 * `invalid` for a malformed value, `trial` when a trial user changes the model
 * or the thinking level, `conflict` when `expectedUpdatedAt` is given
 * and no longer matches (checked inside the write queue, so two editors of one
 * version cannot both win). Unchanged keys are dropped; with nothing left,
 * nothing is written and changedKeys is empty.
 */
export const updateChatSettings = (input: {
    chatId: number;
    patch: ChatSettingsPatch;
    actor: SettingsActor;
    /** The updatedAt the editor saw; a chat never saved reads as the epoch */
    expectedUpdatedAt?: Date | null;
}): Promise<ChatSettingsUpdateResult> =>
    runSerialized(chatAuditScope(input.chatId), async () => {
        await ensureCacheLoaded();
        // The composed-addendum length guard reads template contents, so the
        // template cache must be loaded before the patch is judged
        await ensurePromptTemplatesCacheLoaded();
        const current = getChatSettings(input.chatId) ?? defaultChatSettings(input.chatId);
        // The actor's tier needs a membership lookup; resolved here because the
        // chat being edited is the trigger chat for both /model and the panel
        const actorIsTrial =
            !input.actor.isOwner && (await resolveAccessTier(input.actor.userId, input.chatId)) === 'trial';
        const resolution = resolveChatSettingsPatch(current, input.patch, {
            actorIsOwner: input.actor.isOwner,
            geminiPriorityCanEnable: canEnableGeminiPriority(input.chatId),
            actorIsTrial,
        });
        if (resolution.kind === 'rejected') {
            throw new ChatSettingsError(resolution.code, resolution.message);
        }
        if (isStaleEdit(current, input.expectedUpdatedAt)) {
            throw new ChatSettingsError('conflict', '设置已被他人修改，请刷新后重试');
        }
        if (resolution.changes.length === 0) {
            return { settings: current, changedKeys: [] };
        }
        assertComposedAddendumFits(resolution.next, resolution.changes);

        const settings: ChatSettings = {
            chatId: input.chatId,
            ...resolution.next,
            updatedAt: new Date(),
            updatedBy: input.actor.userId,
        };
        await withBusyRetry(
            () => persistChatSettings(settings, resolution.changes, input.actor.userId),
            `chat settings ${input.chatId}`
        );
        storeChatSettings(settings);
        return { settings, changedKeys: resolution.changes.map((change) => change.key) };
    });
