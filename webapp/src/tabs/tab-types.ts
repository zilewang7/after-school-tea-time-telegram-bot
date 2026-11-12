import type { ComponentType } from 'react';
import type { AccessTier, ChatAccess } from '../api';

/** What a tab's visibility rule may look at */
export interface TabVisibility {
    isOwner: boolean;
    /**
     * The requester's access to the chat on the chat layer. null on the home
     * layer, and on the chat layer while it is still unknown: rules should
     * treat null as "show", so a tab does not flicker away while loading.
     */
    access: ChatAccess | null;
    /**
     * The requester's access tier. null on the chat layer and when access
     * tiering is off: a tier-only tab treats null as "hide".
     */
    accessTier: AccessTier | null;
}

/** One entry of a layer's tab registry (home-tabs.ts / chat-tabs.ts) */
export interface TabDefinition {
    /** Stable id; a chat remembers its last tab by it */
    id: string;
    /** Text in the tab bar */
    label: string;
    /** One path segment under the layer root ("/" or "/c/:chatId"); '' is the layer's index */
    path: string;
    /** A hidden tab is left out of the bar, and its route redirects to the layer root */
    isVisible: (visibility: TabVisibility) => boolean;
    /** The tab's page; wrap pages off the first screen in lazyPage() */
    page: ComponentType;
    /** Optional marker after the label (a count, a dot); it renders null when there is nothing to show */
    badge?: ComponentType;
}
