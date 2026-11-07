import type { ChatSummary } from '../../api';
import { chatNameOf } from '../../format';

/** The search box appears once the list is longer than this */
export const CHAT_SEARCH_THRESHOLD = 8;

/**
 * Chats whose name, @username or id contains the query (case-insensitive).
 * A leading "@" only matches usernames; a blank query keeps every chat.
 */
export const filterChats = (chats: readonly ChatSummary[], query: string): readonly ChatSummary[] => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return chats;
    if (needle.startsWith('@')) {
        const usernameNeedle = needle.slice(1);
        return chats.filter((chat) => chat.username !== null && chat.username.toLowerCase().includes(usernameNeedle));
    }
    return chats.filter(
        (chat) =>
            chatNameOf(chat).toLowerCase().includes(needle) ||
            (chat.username !== null && chat.username.toLowerCase().includes(needle)) ||
            String(chat.chatId).includes(needle)
    );
};
