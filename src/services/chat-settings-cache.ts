/**
 * In-memory copy of chat_settings and global_settings.
 *
 * Both tables are tiny and only two services write them: chat-settings-service
 * writes chat_settings, global-settings-service writes global_settings. So the
 * whole of each is loaded once at startup and kept in step by its writer: the
 * reply path reads settings synchronously and never touches the database for
 * them.
 * Before the load, every chat reads as "no settings" and the global default
 * model falls back to the env, which is what offline scripts rely on.
 *
 * The effective Priority PayGo switch is resolved here rather than in
 * src/config (next to resolveChatModel): config may not import services.
 */
import { match } from 'ts-pattern';
import { getToolConfig } from '../config/tool-config.js';
import { ChatSettingsRecord } from '../db/chatSettingsDTO.js';
import { GlobalSetting } from '../db/globalSettingDTO.js';
import { parseStoredToolOverrides, type ToolOverrides } from './tool-overrides.js';

export interface ChatSettings {
    chatId: number;
    /** null = follow the global default */
    model: string | null;
    /** null = none */
    promptAddendum: string | null;
    paused: boolean;
    settingsLocked: boolean;
    /** The panel's per-chat tool switches; null = every group follows the env */
    toolOverrides: ToolOverrides | null;
    /** Priority PayGo for Gemini; null = follow the global switch (see resolveGeminiPriority) */
    geminiPriority: boolean | null;
    updatedAt: Date;
    /** Telegram user id of the last writer */
    updatedBy: number | null;
}

/** global_settings key of the panel-set default model */
export const DEFAULT_MODEL_SETTING_KEY = 'defaultModel';

/** global_settings key of the global Priority PayGo switch: 'true' / 'false', no row = off */
export const DEFAULT_GEMINI_PRIORITY_SETTING_KEY = 'defaultGeminiPriority';

/** Last resort when DEFAULT_MODEL is unset or empty (`.env.example` leaves it empty) */
const FALLBACK_DEFAULT_MODEL = 'gpt-5';

const chatSettingsByChat = new Map<number, ChatSettings>();
const globalSettingsByKey = new Map<string, string>();
let cacheLoaded = false;
let inflightLoad: Promise<void> | null = null;

/** A nullable BOOLEAN column: NULL (or a row from before the column) stays unset */
const storedNullableFlag = (value: boolean | null | undefined): boolean | null =>
    value === null || value === undefined ? null : value === true;

const toChatSettings = (record: ChatSettingsRecord): ChatSettings => ({
    chatId: record.chatId,
    model: record.model ?? null,
    promptAddendum: record.promptAddendum ?? null,
    paused: record.paused === true,
    settingsLocked: record.settingsLocked === true,
    toolOverrides: parseStoredToolOverrides(record.toolOverrides ?? null),
    geminiPriority: storedNullableFlag(record.geminiPriority),
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

/** The global Priority PayGo switch; off unless the owner turned it on */
export const getGlobalGeminiPriority = (): boolean =>
    getStoredGlobalSetting(DEFAULT_GEMINI_PRIORITY_SETTING_KEY) === 'true';

/**
 * Whether the chat may have Priority PayGo on: always while the global switch
 * is on; with it off, only the chats of the env whitelist TOOL_CHAT_IDS (the
 * env list itself, not the panel's per-tool switches). The priority tier
 * costs the owner 1.8 times the standard price.
 */
export const canEnableGeminiPriority = (chatId: number): boolean =>
    getGlobalGeminiPriority() || getToolConfig().toolChatIds.has(chatId);

/**
 * Whether the chat's Gemini requests ask for Priority PayGo (design §8.2):
 *
 * | chat value | global on | global off                   |
 * | unset      | on        | off                          |
 * | off        | off       | off                          |
 * | on         | on        | on only for TOOL_CHAT_IDS    |
 *
 * A stored "on" that the global switch no longer allows stays in the row and
 * applies again once the global switch is back on.
 */
export const resolveGeminiPriority = (chatId: number): boolean =>
    match(getChatSettings(chatId)?.geminiPriority ?? null)
        .with(null, () => getGlobalGeminiPriority())
        .with(false, () => false)
        .with(true, () => canEnableGeminiPriority(chatId))
        .exhaustive();

/** Write-side: only chat-settings-service calls this, after the row is committed */
export const storeChatSettings = (settings: ChatSettings): void => {
    chatSettingsByChat.set(settings.chatId, settings);
};

/** Write-side: null removes the key. Only global-settings-service calls this */
export const storeGlobalSetting = (key: string, value: string | null): void => {
    if (value === null) {
        globalSettingsByKey.delete(key);
        return;
    }
    globalSettingsByKey.set(key, value);
};
