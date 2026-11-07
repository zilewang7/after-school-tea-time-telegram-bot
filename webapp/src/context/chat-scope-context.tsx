import { createContext, useContext } from 'react';
import type { ChatDetailResponse, ChatSummary } from '../api';
import type { ApiQuery } from '../hooks/use-api-query';
import type { ChatHeaderInfo } from '../layers/chat-header-info';

/** Everything under /c/:chatId shares this; it lives as long as the user stays in the chat */
export interface ChatScopeValue {
    chatId: number;
    /** The chat's row in /api/me; null when the list does not have it (e.g. membership briefly unconfirmable) */
    summary: ChatSummary | null;
    /** GET /api/chats/:chatId, loaded once per visit and shared by the settings tab and its sub-pages */
    detail: ApiQuery<ChatDetailResponse>;
    /** Name and badges for headers: from `detail` once loaded, else from `summary` */
    header: ChatHeaderInfo | null;
}

export const ChatScopeContext = createContext<ChatScopeValue | null>(null);

export const useChatScope = (): ChatScopeValue => {
    const value = useContext(ChatScopeContext);
    if (value === null) throw new Error('ChatScopeContext is missing');
    return value;
};
