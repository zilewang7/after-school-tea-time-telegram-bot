/**
 * In-memory copy of chat_settings and global_settings.
 *
 * Both tables are tiny and only chat-settings-service writes them, so the whole
 * of each is loaded once at startup and kept in step by the service: the reply
 * path reads settings synchronously and never touches the database for them.
 * Before the load, every chat reads as "no settings" and the global default
 * model falls back to the env, which is what offline scripts rely on.
 */
import { ChatSettingsRecord } from '../db/chatSettingsDTO.js';
import { GlobalSetting } from '../db/globalSettingDTO.js';

export interface ChatSettings {
    chatId: number;
    /** null = follow the global default */
    model: string | null;
    /** null = none */
    promptAddendum: string | null;
    paused: boolean;
    settingsLocked: boolean;
    updatedAt: Date;
    /** Telegram user id of the last writer */
    updatedBy: number | null;
}

/** global_settings key of the panel-set default model */
export const DEFAULT_MODEL_SETTING_KEY = 'defaultModel';

/** Last resort when DEFAULT_MODEL is unset or empty (`.env.example` leaves it empty) */
const FALLBACK_DEFAULT_MODEL = 'gpt-5';

const chatSettingsByChat = new Map<number, ChatSettings>();
const globalSettingsByKey = new Map<string, string>();
let cacheLoaded = false;
let inflightLoad: Promise<void> | null = null;

const toChatSettings = (record: ChatSettingsRecord): ChatSettings => ({
    chatId: record.chatId,
    model: record.model ?? null,
    promptAddendum: record.promptAddendum ?? null,
    paused: record.paused === true,
    settingsLocked: record.settingsLocked === true,
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy ?? null,
});

const readAllSettings = async (): Promise<void> => {
    const [chatRecords, globalRecords] = await Promise.all([
        ChatSettingsRecord.findAll(),
        GlobalSetting.findAll(),
    ]);
    chatSettingsByChat.clear();
    for (const record of chatRecords) {
        chatSettingsByChat.set(record.chatId, toChatSettings(record));
    }
    globalSettingsByKey.clear();
    for (const record of globalRecords) {
        globalSettingsByKey.set(record.key, record.value);
    }
    cacheLoaded = true;
};

/**
 * Load both tables into memory. Call once after dbReady, before the bot takes
 * updates; concurrent calls share one load.
 */
export const loadChatSettingsCache = (): Promise<void> => {
    inflightLoad ??= readAllSettings().finally(() => {
        inflightLoad = null;
    });
    return inflightLoad;
};

export const isChatSettingsCacheLoaded = (): boolean => cacheLoaded;

/** undefined = the chat has no settings row, every default applies */
export const getChatSettings = (chatId: number): ChatSettings | undefined => chatSettingsByChat.get(chatId);

export const isChatPaused = (chatId: number): boolean => getChatSettings(chatId)?.paused === true;

export const isChatSettingsLocked = (chatId: number): boolean =>
    getChatSettings(chatId)?.settingsLocked === true;

/** The stored global value, null when the key has no row */
export const getStoredGlobalSetting = (key: string): string | null => globalSettingsByKey.get(key) ?? null;

/**
 * The panel-set default when there is one, otherwise DEFAULT_MODEL (`||`, so an
 * empty value counts as unset), otherwise gpt-5.
 */
export const getGlobalDefaultModel = (): string =>
    getStoredGlobalSetting(DEFAULT_MODEL_SETTING_KEY) ?? (process.env.DEFAULT_MODEL || FALLBACK_DEFAULT_MODEL);

export const getGlobalDefaultModelSource = (): 'panel' | 'env' =>
    getStoredGlobalSetting(DEFAULT_MODEL_SETTING_KEY) === null ? 'env' : 'panel';

/** Write-side: only chat-settings-service calls this, after the row is committed */
export const storeChatSettings = (settings: ChatSettings): void => {
    chatSettingsByChat.set(settings.chatId, settings);
};

/** Write-side: null removes the key. Only chat-settings-service calls this */
export const storeGlobalSetting = (key: string, value: string | null): void => {
    if (value === null) {
        globalSettingsByKey.delete(key);
        return;
    }
    globalSettingsByKey.set(key, value);
};
