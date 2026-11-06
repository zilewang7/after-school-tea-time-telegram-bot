/**
 * The only write path for per-chat and global settings, shared by the panel and
 * `/model`: check → normalize → persist row and audit in one transaction →
 * update the in-memory cache. Reads are synchronous and come from the cache.
 *
 * Writes for one scope run one at a time, so two concurrent patches of the
 * same chat never compute against the same stale snapshot (each row write
 * carries every column).
 */
import { sequelize } from '../db/config.js';
import { withBusyRetry } from '../db/busy-retry.js';
import { ChatSettingsRecord } from '../db/chatSettingsDTO.js';
import { GlobalSetting } from '../db/globalSettingDTO.js';
import { chatAuditScope, GLOBAL_AUDIT_SCOPE, writeSettingsAudit } from '../db/queries/settings-audit.js';
import { resolveChatModel } from '../config/chat-model.js';
import {
    DEFAULT_MODEL_SETTING_KEY,
    getChatSettings,
    getGlobalDefaultModel,
    getStoredGlobalSetting,
    isChatSettingsCacheLoaded,
    loadChatSettingsCache,
    storeChatSettings,
    storeGlobalSetting,
    type ChatSettings,
} from './chat-settings-cache.js';
import {
    normalizeModelId,
    resolveChatSettingsPatch,
    type ChatSettingChange,
    type ChatSettingKey,
    type ChatSettingsErrorCode,
    type ChatSettingsPatch,
} from './chat-settings-rules.js';

export {
    loadChatSettingsCache,
    isChatSettingsCacheLoaded,
    getChatSettings,
    isChatPaused,
    isChatSettingsLocked,
    getGlobalDefaultModel,
    getGlobalDefaultModelSource,
    type ChatSettings,
} from './chat-settings-cache.js';
export {
    MODEL_ID_MAX_LENGTH,
    PROMPT_ADDENDUM_MAX_CODE_POINTS,
    countCodePoints,
    type ChatSettingKey,
    type ChatSettingsErrorCode,
    type ChatSettingsPatch,
} from './chat-settings-rules.js';

/** What one reply uses, taken once when the reply starts */
export interface ReplySettingsSnapshot {
    model: string;
    promptAddendum: string | null;
}

export interface SettingsActor {
    userId: number;
    isOwner: boolean;
}

export interface ChatSettingsUpdateResult {
    settings: ChatSettings;
    /** Empty when every value already matched: nothing was written or audited */
    changedKeys: readonly ChatSettingKey[];
}

export class ChatSettingsError extends Error {
    readonly code: ChatSettingsErrorCode;

    constructor(code: ChatSettingsErrorCode, message: string) {
        super(message);
        this.name = 'ChatSettingsError';
        this.code = code;
    }
}

export const snapshotReplySettings = (chatId: number): ReplySettingsSnapshot => ({
    model: resolveChatModel(chatId),
    promptAddendum: getChatSettings(chatId)?.promptAddendum ?? null,
});

/** What a chat without a settings row behaves as; updatedAt is the epoch, updatedBy null */
export const defaultChatSettings = (chatId: number): ChatSettings => ({
    chatId,
    model: null,
    promptAddendum: null,
    paused: false,
    settingsLocked: false,
    updatedAt: new Date(0),
    updatedBy: null,
});

/** Tail of the write queue per scope */
const writeQueues = new Map<string, Promise<unknown>>();

/** Run `task` after every earlier task of the same scope has settled */
const runSerialized = <T>(scope: string, task: () => Promise<T>): Promise<T> => {
    const previous = writeQueues.get(scope) ?? Promise.resolve();
    const current = previous.then(task, task);
    const tail = current.catch(() => undefined);
    writeQueues.set(scope, tail);
    void tail.then(() => {
        if (writeQueues.get(scope) === tail) writeQueues.delete(scope);
    });
    return current;
};

/** Writes before startup's load (a script, a test) still diff against the database */
const ensureCacheLoaded = async (): Promise<void> => {
    if (!isChatSettingsCacheLoaded()) await loadChatSettingsCache();
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
                paused: settings.paused,
                settingsLocked: settings.settingsLocked,
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
 * `forbidden` when a non-owner touches settingsLocked, `invalid` for a
 * malformed value. Unchanged keys are dropped; with nothing left, nothing is
 * written and changedKeys is empty.
 */
export const updateChatSettings = (input: {
    chatId: number;
    patch: ChatSettingsPatch;
    actor: SettingsActor;
}): Promise<ChatSettingsUpdateResult> =>
    runSerialized(chatAuditScope(input.chatId), async () => {
        await ensureCacheLoaded();
        const current = getChatSettings(input.chatId) ?? defaultChatSettings(input.chatId);
        const resolution = resolveChatSettingsPatch(current, input.patch, input.actor.isOwner);
        if (resolution.kind === 'rejected') {
            throw new ChatSettingsError(resolution.code, resolution.message);
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

const persistGlobalDefaultModel = async (
    model: string | null,
    previous: string | null,
    actorId: number
): Promise<void> => {
    await sequelize.transaction(async (transaction) => {
        if (model === null) {
            await GlobalSetting.destroy({ where: { key: DEFAULT_MODEL_SETTING_KEY }, transaction });
        } else {
            await GlobalSetting.upsert(
                { key: DEFAULT_MODEL_SETTING_KEY, value: model, updatedAt: new Date(), updatedBy: actorId },
                { transaction }
            );
        }
        await writeSettingsAudit(
            {
                actorId,
                scope: GLOBAL_AUDIT_SCOPE,
                key: DEFAULT_MODEL_SETTING_KEY,
                oldValue: previous,
                newValue: model,
            },
            { transaction }
        );
    });
};

/**
 * Owner only. A model id sets the panel default; null removes it, so
 * DEFAULT_MODEL applies again. Returns the effective global default afterwards.
 * Setting the value it already has writes nothing.
 */
export const updateGlobalDefaultModel = (model: string | null, actor: SettingsActor): Promise<string> =>
    runSerialized(GLOBAL_AUDIT_SCOPE, async () => {
        if (!actor.isOwner) {
            throw new ChatSettingsError('forbidden', '只有机主可以修改全局默认模型');
        }
        const normalized = normalizeModelId(model);
        if (!normalized.ok) throw new ChatSettingsError('invalid', normalized.message);

        await ensureCacheLoaded();
        const previous = getStoredGlobalSetting(DEFAULT_MODEL_SETTING_KEY);
        if (previous === normalized.value) return getGlobalDefaultModel();

        await withBusyRetry(
            () => persistGlobalDefaultModel(normalized.value, previous, actor.userId),
            'global default model'
        );
        storeGlobalSetting(DEFAULT_MODEL_SETTING_KEY, normalized.value);
        return getGlobalDefaultModel();
    });
