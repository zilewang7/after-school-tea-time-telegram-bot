import { ChatSettingsTab } from '../pages/chat-settings/chat-settings-tab';
import { ChatOpenIssuesBadge } from '../pages/issues/issue-tab-badges';
import { lazyPage } from './lazy-page';
import type { TabDefinition } from './tab-types';

const chatSettingsTab: TabDefinition = {
    id: 'settings',
    label: '设置',
    path: 'settings',
    isVisible: () => true,
    // The default tab until 会话 exists, and a direct-launch target: bundled, not lazy
    page: ChatSettingsTab,
};

/**
 * Tabs of the chat layer ("/c/:chatId"), in display order. Adding a tab = one
 * entry here (its route is derived by tabRoutesOf) plus its drill-down routes,
 * if any, in router.tsx. Insert new entries inside their slot only, so
 * parallel branches merge without conflicts.
 *
 * A chat opens on its remembered tab, else 'conv', else 'settings' (tab-choice.ts).
 */
export const CHAT_TABS: readonly TabDefinition[] = [
    // [F2 slot] 会话 (id 'conv', path 'conv')
    // [F2 slot end]
    chatSettingsTab,
    // [F3 slot] 统计 (id 'stats', path 'stats')
    // [F3 slot end]
    // [F4 slot] Issue (id 'issues', path 'issues')
    {
        id: 'issues',
        label: 'Issue',
        path: 'issues',
        isVisible: () => true,
        page: lazyPage(() => import('../pages/issues/issue-list/issue-tabs'), 'ChatIssuesTab'),
        badge: ChatOpenIssuesBadge,
    },
    // [F4 slot end]
];
