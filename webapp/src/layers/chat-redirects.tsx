import { useMemo } from 'react';
import { Navigate } from 'react-router';
import { useChatScope } from '../context/chat-scope-context';
import { NotFoundPage } from '../pages/not-found-page';
import { chatSettingsAuditPath, chatTabPath } from '../routing/paths';
import { chooseChatTab, readRememberedChatTab } from '../routing/tab-choice';
import { CHAT_TABS } from '../tabs/chat-tabs';
import { useTabLayer } from '../tabs/tab-layer-context';

/** /c/:chatId (also phase 1's dashboard URL): on to the remembered or default tab */
export const ChatIndexRedirect = () => {
    const { chatId } = useChatScope();
    const { visibility } = useTabLayer();
    const target = useMemo(() => {
        const visibleTabs = CHAT_TABS.filter((tab) => tab.isVisible(visibility));
        const tab = chooseChatTab(visibleTabs, readRememberedChatTab(chatId));
        return tab === null ? null : chatTabPath(chatId, tab.path);
    }, [chatId, visibility]);

    if (target === null) return <NotFoundPage />;
    return <Navigate replace to={target} />;
};

/** Phase 1's /c/:chatId/audit */
export const LegacyChatAuditRedirect = () => {
    const { chatId } = useChatScope();
    return <Navigate replace to={chatSettingsAuditPath(chatId)} />;
};
