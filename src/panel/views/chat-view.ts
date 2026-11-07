/**
 * How a chat and its settings appear in API responses.
 */
import type { ChatRow, ChatType } from '../../db/queries/panel-registry.js';
import { defaultChatSettings, getChatSettings, type ChatSettings } from '../../services/chat-settings-service.js';
import type { ToolOverrides } from '../../services/tool-overrides.js';
import type { VisibleAccess } from '../types.js';

export interface ChatSettingsView {
    model: string | null;
    promptAddendum: string | null;
    paused: boolean;
    settingsLocked: boolean;
    /** The panel's per-chat tool switches; null = every group follows the env */
    toolOverrides: ToolOverrides | null;
    /** ISO time; the epoch when the chat has never been changed */
    updatedAt: string;
    updatedBy: number | null;
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
    updatedAt: settings.updatedAt.toISOString(),
    updatedBy: settings.updatedBy,
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
