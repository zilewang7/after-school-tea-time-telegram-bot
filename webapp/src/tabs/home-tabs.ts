import { ChatListPage } from '../pages/chat-list/chat-list-page';
import { HomeOpenIssuesBadge } from '../pages/issues/issue-tab-badges';
import { lazyPage } from './lazy-page';
import type { TabDefinition } from './tab-types';

const HomeSettingsTab = lazyPage(() => import('../pages/home-settings/home-settings-tab'), 'HomeSettingsTab');

const chatListTab: TabDefinition = {
    id: 'chats',
    label: '聊天',
    path: '',
    isVisible: () => true,
    // First screen: bundled, not lazy
    page: ChatListPage,
};

const homeSettingsTab: TabDefinition = {
    id: 'settings',
    label: '设置',
    path: 'settings',
    isVisible: ({ isOwner }) => isOwner,
    page: HomeSettingsTab,
};

/**
 * Tabs of the home layer ("/"), in display order. Adding a tab = one entry
 * here (its route is derived by tabRoutesOf) plus its drill-down routes, if
 * any, in router.tsx. Insert new entries inside their slot only, so parallel
 * branches merge without conflicts.
 */
export const HOME_TABS: readonly TabDefinition[] = [
    chatListTab,
    // [F3 slot] 状态 (id 'status', path 'status') and 统计 (id 'stats', path 'stats'), owner only
    {
        id: 'status',
        label: '状态',
        path: 'status',
        isVisible: ({ isOwner }) => isOwner,
        page: lazyPage(() => import('../pages/status/status-tab'), 'HomeStatusTab'),
    },
    {
        id: 'stats',
        label: '统计',
        path: 'stats',
        isVisible: ({ isOwner }) => isOwner,
        page: lazyPage(() => import('../pages/stats/stats-tabs'), 'HomeStatsTab'),
    },
    // [F3 slot end]
    // [F4 slot] Issue (id 'issues', path 'issues')
    {
        id: 'issues',
        label: 'Issue',
        path: 'issues',
        // Everyone: non-owners see the issues of the chats they are a member of
        isVisible: () => true,
        page: lazyPage(() => import('../pages/issues/issue-list/issue-tabs'), 'HomeIssuesTab'),
        badge: HomeOpenIssuesBadge,
    },
    // [F4 slot end]
    // [F5 slot] 工具 (id 'tools', path 'tools'): the clipboard converter, everyone
    {
        id: 'tools',
        label: '工具',
        path: 'tools',
        // Everyone: a local-only utility that touches no chat data
        isVisible: () => true,
        page: lazyPage(() => import('../pages/tools/tools-tab'), 'ToolsTab'),
    },
    // [F5 slot end]
    homeSettingsTab,
];
