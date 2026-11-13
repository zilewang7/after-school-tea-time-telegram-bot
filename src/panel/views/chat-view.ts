/**
 * How a chat and its settings appear in API responses.
 */
import type { ChatRow, ChatType } from '../../db/queries/panel-registry.js';
import { resolveModelTraits } from '../../ai/model-traits.js';
import {
    canEnableGeminiPriority,
    defaultChatSettings,
    getChatSettings,
    getGlobalGeminiPriority,
    resolveGeminiPriority,
    thinkingEffortOptionsOf,
    thinkingEffortSupportedOf,
    type ChatSettings,
    type ThinkingEffortOptionView,
    type ThinkingEffortValue,
} from '../../services/chat-settings-service.js';
import type { ToolOverrides } from '../../services/tool-overrides.js';
import type { VisibleAccess } from '../types.js';

export interface ChatSettingsView {
    model: string | null;
    promptAddendum: string | null;
    paused: boolean;
    settingsLocked: boolean;
    /** The panel's per-chat tool switches; null = every group follows the env */
    toolOverrides: ToolOverrides | null;
    /** The chat's own Priority PayGo value; null = follow the global switch */
    geminiPriority: boolean | null;
    /** The chat's thinking level; null = the model default, 'off', else a graded effort */
    thinkingEffort: ThinkingEffortValue | null;
    /** ISO time; the epoch when the chat has never been changed */
    updatedAt: string;
    updatedBy: number | null;
}

/** The Priority PayGo switch as the chat page shows it (design §8.2, §8.5) */
export interface GeminiPriorityView {
    /** Whether this chat's Gemini replies ask for the priority tier now */
    effectiveGeminiPriority: boolean;
    globalGeminiPriority: boolean;
    /** "On" can take effect here: the global switch is on, or the chat is in TOOL_CHAT_IDS */
    geminiPriorityCanEnable: boolean;
}

export interface ChatHeaderView {
    chatId: number;
    type: ChatType;
    /** Group title, or the private chat user's full name; null until named */
    title: string | null;
    /** Public @username of the group or user, without the @ */
    username: string | null;
    access: VisibleAccess;
}

/** The chat's settings, or the defaults when it has no row */
export const currentChatSettings = (chatId: number): ChatSettings =>
    getChatSettings(chatId) ?? defaultChatSettings(chatId);

export const toSettingsView = (settings: ChatSettings): ChatSettingsView => ({
    model: settings.model,
    promptAddendum: settings.promptAddendum,
    paused: settings.paused,
    settingsLocked: settings.settingsLocked,
    toolOverrides: settings.toolOverrides,
    geminiPriority: settings.geminiPriority,
    thinkingEffort: settings.thinkingEffort,
    updatedAt: settings.updatedAt.toISOString(),
    updatedBy: settings.updatedBy,
});

export const geminiPriorityViewOf = (chatId: number): GeminiPriorityView => ({
    effectiveGeminiPriority: resolveGeminiPriority(chatId),
    globalGeminiPriority: getGlobalGeminiPriority(),
    geminiPriorityCanEnable: canEnableGeminiPriority(chatId),
});

/** The chat's thinking level and what its effective model allows (design §5) */
export interface ThinkingEffortView {
    /** The chat's own value; null = the model default, 'off' = thinking off */
    value: ThinkingEffortValue | null;
    source: 'chat' | 'model-default';
    /** The vendor default effort when the chat has no choice; null = not known */
    effectiveDefault: string | null;
    /** Toggle models: the vendor default on/off; null = not known */
    enabledDefault: boolean | null;
    /** The graded efforts the model accepts, lowest first; empty = no graded efforts */
    options: readonly ThinkingEffortOptionView[];
    /** False when the model offers no graded effort */
    supported: boolean;
    /** The model can switch thinking off/on */
    toggle: boolean;
}

/**
 * The option list follows the chat's effective model (the same one the reply
 * uses), not the model a draft may be about to change to.
 */
export const thinkingEffortViewOf = (chatId: number, effectiveModel: string): ThinkingEffortView => {
    const value = getChatSettings(chatId)?.thinkingEffort ?? null;
    // The same source the menu and the request path resolve from (catalog row →
    // code seed → code), so a seed-only id without a catalog row still shows
    // its efforts instead of looking unsupported in the panel.
    const reasoning = resolveModelTraits(effectiveModel).capabilities?.reasoning ?? null;
    return {
        value,
        source: value === null ? 'model-default' : 'chat',
        effectiveDefault: reasoning?.defaultEffort ?? null,
        enabledDefault: reasoning?.defaultEnabled ?? null,
        options: thinkingEffortOptionsOf(reasoning),
        supported: thinkingEffortSupportedOf(reasoning),
        toggle: reasoning?.toggle === true,
    };
};

export const toChatHeaderView = (chat: ChatRow, access: VisibleAccess): ChatHeaderView => ({
    chatId: chat.chatId,
    type: chat.type,
    title: chat.title,
    username: chat.username,
    access,
});

/**
 * The title the runtime block gets: none for private chats, whose chats.title
 * holds the user's first name and would render as 「当前群聊：<名字>」 instead of
 * the real request's 「当前对话：私聊」.
 */
export const runtimeChatTitleOf = (chat: Pick<ChatRow, 'type' | 'title'>): string | null =>
    chat.type === 'private' ? null : chat.title;
