import { createBrowserRouter, Navigate } from 'react-router';
import { AppShell } from './components/app-shell';
import { ChatIndexRedirect, LegacyChatAuditRedirect } from './layers/chat-redirects';
import { ChatScopeRoute } from './layers/chat-scope';
import { ChatTabsLayout } from './layers/chat-tabs-layout';
import { HomeLayer } from './layers/home-layer';
import type { LaunchState } from './launch';
import { NotFoundPage } from './pages/not-found-page';
import { GLOBAL_AUDIT_PATH, GLOBAL_SETTINGS_PATH } from './routing/paths';
import { CHAT_TABS } from './tabs/chat-tabs';
import { HOME_TABS } from './tabs/home-tabs';
import { lazyPage } from './tabs/lazy-page';
import { tabRoutesOf } from './tabs/tab-routes';

const GlobalAuditRoute = lazyPage(() => import('./pages/audit/audit-routes'), 'GlobalAuditRoute');
const ChatAuditRoute = lazyPage(() => import('./pages/audit/audit-routes'), 'ChatAuditRoute');
const ChatToolsPage = lazyPage(() => import('./pages/chat-tools/chat-tools-page'), 'ChatToolsPage');

/**
 * History routing only: Telegram puts #tgWebAppData in the URL hash, so hash routing would clobber it.
 * The bot serves index.html for these paths, which also makes Telegram's "reload page" work.
 *
 * Two tab layers: home ("/") and chat ("/c/:chatId"). Tab routes are derived from the registries
 * (tabs/home-tabs.ts, tabs/chat-tabs.ts); drill-down pages (full screen, no tab bar) are listed
 * here. Insert new routes inside their slot only, so parallel branches merge without conflicts.
 */
export const createAppRouter = (launch: LaunchState) =>
    createBrowserRouter([
        {
            path: '/',
            element: <AppShell launch={launch} />,
            children: [
                { element: <HomeLayer />, children: tabRoutesOf(HOME_TABS) },
                // Home drill-downs
                { path: 'settings/audit', element: <GlobalAuditRoute /> },
                // [F3 slot]
                // [F3 slot end]
                // [F4 slot] issues/:id
                // [F4 slot end]
                {
                    path: 'c/:chatId',
                    element: <ChatScopeRoute />,
                    children: [
                        {
                            element: <ChatTabsLayout />,
                            children: [{ index: true, element: <ChatIndexRedirect /> }, ...tabRoutesOf(CHAT_TABS)],
                        },
                        // Chat drill-downs
                        { path: 'settings/tools', element: <ChatToolsPage /> },
                        { path: 'settings/audit', element: <ChatAuditRoute /> },
                        // [F2 slot] conv/:rootId, replies/:firstMessageId
                        // [F2 slot end]
                        // [F3 slot]
                        // [F3 slot end]
                        // [F4 slot] issues/new
                        // [F4 slot end]
                        // Phase 1 URL, possibly still in lastRoute
                        { path: 'audit', element: <LegacyChatAuditRedirect /> },
                        { path: '*', element: <NotFoundPage /> },
                    ],
                },
                // Phase 1 URLs, possibly still in lastRoute
                { path: 'global', element: <Navigate replace to={GLOBAL_SETTINGS_PATH} /> },
                { path: 'audit', element: <Navigate replace to={GLOBAL_AUDIT_PATH} /> },
                { path: '*', element: <NotFoundPage /> },
            ],
        },
    ]);

export type AppRouter = ReturnType<typeof createAppRouter>;
