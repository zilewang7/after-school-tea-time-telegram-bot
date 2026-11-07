import type { ChatAccess, ChatDetailResponse, ChatSummary, ChatType } from '../api';
import type { ChatNameSource } from '../format';

/** What the chat layer's header shows */
export interface ChatHeaderInfo {
    name: ChatNameSource;
    type: ChatType;
    access: ChatAccess;
    paused: boolean;
    locked: boolean;
}

/**
 * The chat's own detail once loaded (it changes right after a save), else its
 * row in /api/me; null while neither knows the chat.
 */
export const chatHeaderOf = (summary: ChatSummary | null, detail: ChatDetailResponse | null): ChatHeaderInfo | null => {
    if (detail !== null) {
        return {
            name: detail.chat,
            type: detail.chat.type,
            access: detail.chat.access,
            paused: detail.settings.paused,
            locked: detail.settings.settingsLocked,
        };
    }
    if (summary !== null) {
        return {
            name: summary,
            type: summary.type,
            access: summary.access,
            paused: summary.paused,
            locked: summary.settingsLocked,
        };
    }
    return null;
};
