import { readStorage, writeStorage } from '../storage';

/** Tried in order after the remembered tab: 会话 once it exists, then 设置 */
const DEFAULT_CHAT_TAB_IDS: readonly string[] = ['conv', 'settings'];

/**
 * The tab a chat opens on: the remembered one, else 会话, else 设置, else the
 * first visible tab. Only visible tabs are candidates; null when there are none.
 */
export const chooseChatTab = <T extends { id: string }>(
    visibleTabs: readonly T[],
    rememberedTabId: string | null
): T | null => {
    const preferredIds = rememberedTabId === null ? DEFAULT_CHAT_TAB_IDS : [rememberedTabId, ...DEFAULT_CHAT_TAB_IDS];
    for (const tabId of preferredIds) {
        const tab = visibleTabs.find((candidate) => candidate.id === tabId);
        if (tab !== undefined) return tab;
    }
    return visibleTabs[0] ?? null;
};

/**
 * The tab shown at a path relative to its layer root: [] is the layer's index
 * (path ''), one segment is a tab, anything deeper is a drill-down (no tab).
 */
export const tabAtLayerPath = <T extends { path: string }>(
    tabs: readonly T[],
    layerSegments: readonly string[]
): T | null => {
    if (layerSegments.length > 1) return null;
    const tabPath = layerSegments[0] ?? '';
    return tabs.find((tab) => tab.path === tabPath) ?? null;
};

const rememberedTabKeyOf = (chatId: number): string => `chatTab:${chatId}`;

export const readRememberedChatTab = (chatId: number): string | null => readStorage(rememberedTabKeyOf(chatId));

export const rememberChatTab = (chatId: number, tabId: string): void => writeStorage(rememberedTabKeyOf(chatId), tabId);
