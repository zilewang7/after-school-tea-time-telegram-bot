import { Suspense, useEffect, useMemo } from 'react';
import { Outlet, useLocation } from 'react-router';
import { LoadingView } from '../components/status-views';
import { TabBar } from '../components/tab-bar';
import { useChatScope } from '../context/chat-scope-context';
import { useMe } from '../context/me-context';
import { chatPath, chatTabPath, pathSegmentsOf } from '../routing/paths';
import { rememberChatTab, tabAtLayerPath } from '../routing/tab-choice';
import { CHAT_TABS } from '../tabs/chat-tabs';
import { tabBarItemsOf } from '../tabs/tab-bar-items';
import { TabLayerContext } from '../tabs/tab-layer-context';
import type { TabLayerValue } from '../tabs/tab-layer-context';
import type { TabVisibility } from '../tabs/tab-types';
import { ChatHeader } from './chat-header';

// "/c/:chatId/<tab>": the tab segment comes after "c" and the id
const CHAT_LAYER_PREFIX_LENGTH = 2;

/** The chat layer's tab pages: header, sticky tab bar, then the active tab */
export const ChatTabsLayout = () => {
    const { me } = useMe();
    const { chatId, header } = useChatScope();
    const { pathname } = useLocation();

    const access = header?.access ?? null;
    const visibility = useMemo<TabVisibility>(() => ({ isOwner: me.isOwner, access }), [me.isOwner, access]);
    const tabItems = useMemo(
        () => tabBarItemsOf(CHAT_TABS, visibility, (tabPath) => chatTabPath(chatId, tabPath)),
        [visibility, chatId]
    );
    const activeTab = useMemo(
        () => tabAtLayerPath(CHAT_TABS, pathSegmentsOf(pathname).slice(CHAT_LAYER_PREFIX_LENGTH)),
        [pathname]
    );
    const activeTabId = activeTab?.id ?? null;
    const layerValue = useMemo<TabLayerValue>(() => ({ visibility, rootPath: chatPath(chatId) }), [visibility, chatId]);

    // The chat reopens on this tab next time
    useEffect(() => {
        if (activeTabId !== null) rememberChatTab(chatId, activeTabId);
    }, [chatId, activeTabId]);

    return (
        <TabLayerContext.Provider value={layerValue}>
            <ChatHeader header={header} />
            <TabBar items={tabItems} activeId={activeTabId} />
            <Suspense fallback={<LoadingView />}>
                <Outlet />
            </Suspense>
        </TabLayerContext.Provider>
    );
};
