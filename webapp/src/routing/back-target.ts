import { match, P } from 'ts-pattern';
import { HOME_PATH, pathSegmentsOf } from './paths';

/** Paths of each layer's tabs, one segment each; '' is the home chat list at "/" */
export interface LayerTabPaths {
    home: ReadonlySet<string>;
    chat: ReadonlySet<string>;
}

const chatParentOf = (chatId: string, rest: readonly string[], chatTabs: ReadonlySet<string>): string => {
    const [first] = rest;
    // "/c/:id" itself only redirects to a tab
    if (first === undefined) return HOME_PATH;
    // A reply belongs to a conversation: its logical parent is the conversation list
    if (first === 'replies') return `/c/${chatId}/conv`;
    // A drill-down under a segment that is not a tab: the chat's default tab
    if (!chatTabs.has(first)) return `/c/${chatId}`;
    // A tab goes up to home; a page below a tab goes back to that tab
    return rest.length === 1 ? HOME_PATH : `/c/${chatId}/${first}`;
};

const homeParentOf = (segments: readonly string[], homeTabs: ReadonlySet<string>): string | null => {
    const [first] = segments;
    if (first === undefined) return null;
    if (!homeTabs.has(first)) return HOME_PATH;
    return segments.length === 1 ? null : `/${first}`;
};

/**
 * The logical parent of a page: where Back leads when there is no in-app
 * history behind it (a page opened by start_param, lastRoute or "reload").
 * null means a home tab, where Back is hidden.
 *
 * - /c/:id and each chat tab -> home
 * - /c/:id/<tab>/... -> that tab; /c/:id/<not a tab>/... -> the chat's default tab
 * - /<home tab>/... -> that home tab; any other path -> home
 */
export const parentPathOf = (pathname: string, tabPaths: LayerTabPaths): string | null =>
    match(pathSegmentsOf(pathname))
        .with(['c', P.string, ...P.array(P.string)], ([, chatId, ...rest]) => chatParentOf(chatId, rest, tabPaths.chat))
        .otherwise((segments) => homeParentOf(segments, tabPaths.home));

/** Position of the current entry in the session history, as react-router's history records it; null when unknown */
export const historyIndexOf = (historyState: unknown): number | null =>
    typeof historyState === 'object' &&
    historyState !== null &&
    'idx' in historyState &&
    typeof historyState.idx === 'number'
        ? historyState.idx
        : null;

/**
 * Whether stepping back through history stays inside the panel. The launch
 * navigation replaces the first entry, so index 0 means "opened right here".
 */
export const canGoBackInApp = (historyState: unknown): boolean => (historyIndexOf(historyState) ?? 0) > 0;
