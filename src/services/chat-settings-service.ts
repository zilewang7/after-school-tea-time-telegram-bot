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
import { resolveChatModel } from '../config/chat-model.js';
import { resolveAccessTier } from './access-tier.js';
import {
    canEnableGeminiPriority,
    getChatSettings,
    resolveGeminiPriority,
    storeChatSettings,
    type ChatSettings,
} from './chat-settings-cache.js';
import {
    resolveChatSettingsPatch,
    type ChatSettingChange,
    type ChatSettingKey,
    type ChatSettingsPatch,
} from './chat-settings-rules.js';
import { ChatSettingsError, type SettingsActor } from './settings-errors.js';
import { ensureCacheLoaded, runSerialized } from './settings-write-queue.js';
import { canonicalToolOverridesJson, type ToolOverrides } from './tool-overrides.js';

export {
    loadChatSettingsCache,
    isChatSettingsCacheLoaded,
    getChatSettings,
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
    MODEL_ID_MAX_LENGTH,
    PROMPT_ADDENDUM_MAX_CODE_POINTS,
    countCodePoints,
    normalizeNullableFlag,
    normalizePromptAddendum,
    type ChatSettingKey,
    type ChatSettingsErrorCode,
    type ChatSettingsPatch,
} from './chat-settings-rules.js';
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

/** What one reply uses, taken once when the reply starts */
export interface ReplySettingsSnapshot {
    model: string;
    promptAddendum: string | null;
    /** The per-chat tool switches at the same moment; null = follow the env */
    toolOverrides: ToolOverrides | null;
    /** The effective Priority PayGo switch (chat value, global switch and whitelist resolved) */
    geminiPriority: boolean;
}

export interface ChatSettingsUpdateResult {
    settings: ChatSettings;
    /** Empty when every value already matched: nothing was written or audited */
    changedKeys: readonly ChatSettingKey[];
}

export const snapshotReplySettings = (chatId: number): ReplySettingsSnapshot => ({
    model: resolveChatModel(chatId),
    promptAddendum: getChatSettings(chatId)?.promptAddendum ?? null,
    toolOverrides: getChatSettings(chatId)?.toolOverrides ?? null,
    geminiPriority: resolveGeminiPriority(chatId),
});

/** What a chat without a settings row behaves as; updatedAt is the epoch, updatedBy null */
export const defaultChatSettings = (chatId: number): ChatSettings => ({
    chatId,
    model: null,
    promptAddendum: null,
    paused: false,
    settingsLocked: false,
    toolOverrides: null,
    geminiPriority: null,
    updatedAt: new Date(0),
    updatedBy: null,
});

/** The caller loaded another version than the current one (optimistic concurrency) */
const isStaleEdit = (current: ChatSettings, expectedUpdatedAt: Date | null | undefined): boolean =>
    expectedUpdatedAt !== undefined &&
    expectedUpdatedAt !== null &&
    current.updatedAt.getTime() !== expectedUpdatedAt.getTime();

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
                paused: settings.paused,
                settingsLocked: settings.settingsLocked,
                toolOverrides: canonicalToolOverridesJson(settings.toolOverrides),
                // Every column, or a value would live in the cache only and vanish on restart
                geminiPriority: settings.geminiPriority,
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
 * `invalid` for a malformed value, `conflict` when `expectedUpdatedAt` is given
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
        const current = getChatSettings(input.chatId) ?? defaultChatSettings(input.chatId);
        const resolution = resolveChatSettingsPatch(current, input.patch, {
            actorIsOwner: input.actor.isOwner,
            geminiPriorityCanEnable: canEnableGeminiPriority(input.chatId),
            actorIsTrial: !input.actor.isOwner && resolveAccessTier(input.actor.userId) === 'trial',
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
