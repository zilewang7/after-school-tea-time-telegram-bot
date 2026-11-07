/**
 * One row of the chat list in /api/me.
 */
import type { ChatType } from '../../db/queries/panel-registry.js';
import type { AccessibleChat } from '../access/chat-access.js';
import type { VisibleAccess } from '../types.js';
import { currentChatSettings } from './chat-view.js';

export interface ChatListItem {
    chatId: number;
    type: ChatType;
    /** Group title, or the private chat user's full name; null until named */
    title: string | null;
    /** Public @username of the group or user, without the @ */
    username: string | null;
    access: VisibleAccess;
    /** The chat's own model; null = follows the global default */
    model: string | null;
    modelSource: 'chat' | 'global';
    paused: boolean;
    settingsLocked: boolean;
    openIssues: number;
    /** ISO time of the chat's latest registry touch */
    lastActivityAt: string;
}

export const toChatListItem = (
    { chat, access }: AccessibleChat,
    openIssuesByChat: ReadonlyMap<number, number>
): ChatListItem => {
    const settings = currentChatSettings(chat.chatId);
    return {
        chatId: chat.chatId,
        type: chat.type,
        title: chat.title,
        username: chat.username,
        access,
        model: settings.model,
        modelSource: settings.model === null ? 'global' : 'chat',
        paused: settings.paused,
        settingsLocked: settings.settingsLocked,
        openIssues: openIssuesByChat.get(chat.chatId) ?? 0,
        lastActivityAt: chat.lastSeenAt.toISOString(),
    };
};
