/**
 * How a chat and its settings appear in API responses.
 */
import type { ChatRow, ChatType } from '../../db/queries/panel-registry.js';
import {
    canEnableGeminiPriority,
    defaultChatSettings,
    getChatSettings,
    getGlobalGeminiPriority,
    resolveGeminiPriority,
    type ChatSettings,
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
    updatedAt: settings.updatedAt.toISOString(),
    updatedBy: settings.updatedBy,
});

export const geminiPriorityViewOf = (chatId: number): GeminiPriorityView => ({
    effectiveGeminiPriority: resolveGeminiPriority(chatId),
    globalGeminiPriority: getGlobalGeminiPriority(),
    geminiPriorityCanEnable: canEnableGeminiPriority(chatId),
});

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
