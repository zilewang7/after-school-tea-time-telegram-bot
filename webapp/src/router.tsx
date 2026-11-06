import { createBrowserRouter } from 'react-router';
import { AppShell } from './components/app-shell';
import type { LaunchState } from './launch';
import { ChatAuditRoute, GlobalAuditRoute } from './pages/audit/audit-routes';
import { ChatListPage } from './pages/chat-list/chat-list-page';
import { DashboardRoute } from './pages/dashboard/dashboard-route';
import { GlobalPage } from './pages/global/global-page';
import { NotFoundPage } from './pages/not-found-page';

/**
 * History routing only: Telegram puts #tgWebAppData in the URL hash, so hash routing would clobber it.
 * The bot serves index.html for these paths, which also makes Telegram's "reload page" work.
 */
export const createAppRouter = (launch: LaunchState) =>
    createBrowserRouter([
        {
            path: '/',
            element: <AppShell launch={launch} />,
            children: [
                { index: true, element: <ChatListPage /> },
                { path: 'c/:chatId', element: <DashboardRoute /> },
                { path: 'c/:chatId/audit', element: <ChatAuditRoute /> },
                { path: 'global', element: <GlobalPage /> },
                { path: 'audit', element: <GlobalAuditRoute /> },
                { path: '*', element: <NotFoundPage /> },
            ],
        },
    ]);

export type AppRouter = ReturnType<typeof createAppRouter>;
