import { useCallback, useMemo } from 'react';
import { Outlet } from 'react-router';
import { ChatScopeContext } from '../context/chat-scope-context';
import type { ChatScopeValue } from '../context/chat-scope-context';
import { useMe } from '../context/me-context';
import { useApi } from '../context/panel-context';
import { useApiQuery } from '../hooks/use-api-query';
import { useChatIdParam } from '../hooks/use-chat-id-param';
import { NotFoundPage } from '../pages/not-found-page';
import { chatHeaderOf } from './chat-header-info';

interface ChatScopeProps {
    chatId: number;
}

/** Holds the chat's data while the user moves between its tabs and their sub-pages */
const ChatScope = ({ chatId }: ChatScopeProps) => {
    const api = useApi();
    const { me } = useMe();
    const loadChat = useCallback((signal: AbortSignal) => api.getChat(chatId, signal), [api, chatId]);
    const detail = useApiQuery(loadChat);

    const summary = useMemo(() => me.chats.find((chat) => chat.chatId === chatId) ?? null, [me.chats, chatId]);
    const detailData = detail.state.status === 'success' ? detail.state.data : null;
    const header = useMemo(() => chatHeaderOf(summary, detailData), [summary, detailData]);

    const value = useMemo<ChatScopeValue>(
        () => ({ chatId, summary, detail, header }),
        [chatId, summary, detail, header]
    );

    return (
        <ChatScopeContext.Provider value={value}>
            <Outlet />
        </ChatScopeContext.Provider>
    );
};

/** /c/:chatId and everything below it */
export const ChatScopeRoute = () => {
    const chatId = useChatIdParam();
    if (chatId === null) return <NotFoundPage />;
    // Keyed so switching chats starts from a clean state
    return <ChatScope key={chatId} chatId={chatId} />;
};
