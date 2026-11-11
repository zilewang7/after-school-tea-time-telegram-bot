import { match, P } from 'ts-pattern';
import type { StartTarget } from './api';
import {
    chatPath,
    issuePath,
    NO_ACCESS_PATH,
    replyPath,
    sharePath,
    thinkingPath,
} from './routing/paths';
import { readStorage } from './storage';
import { readStartParam } from './telegram';
import type { TelegramWebApp } from './telegram';

export const LAST_ROUTE_KEY = 'lastRoute';

// Only plain in-app paths are restored; anything else (e.g. "//host") is ignored
const RESTORABLE_ROUTE = /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;

/** Facts about how the panel was opened, captured before the app touches the URL or lastRoute */
export interface LaunchState {
    initialPathname: string;
    startParam: string | null;
    savedRoute: string | null;
    /**
     * Whether this is a real Telegram Mini App (initData present) rather than
     * the browser tab (web login or a public page). Only the Mini App remembers
     * the route the reader was last on; a browser tab opens where it was asked to.
     */
    insideTelegram: boolean;
}

export const captureLaunchState = (webApp: TelegramWebApp): LaunchState => {
    const insideTelegram = webApp.initData !== '';
    const savedRoute = insideTelegram ? readStorage(LAST_ROUTE_KEY) : null;
    return {
        initialPathname: window.location.pathname,
        startParam: readStartParam(webApp),
        savedRoute: savedRoute !== null && RESTORABLE_ROUTE.test(savedRoute) ? savedRoute : null,
        insideTelegram,
    };
};

const routeOfStartTarget = (startTarget: StartTarget | null): string | null =>
    match(startTarget)
        // `unavailable` too: the chat's page gets the same 503 and retries until the lookup works.
        // "/c/:id" then opens the chat's remembered or default tab.
        .with({ kind: 'chat', access: P.union('member', 'observer', 'unavailable') }, ({ chatId }) => chatPath(chatId))
        // Whatever the access: the issue page asks the server, which answers 404 when the issue is hidden
        .with({ kind: 'issue' }, ({ issueId }) => issuePath(issueId))
        // A reply link lands on the reply itself; `unavailable` opens it too, where the 503 retries
        .with({ kind: 'reply', access: P.union('member', 'observer', 'unavailable') }, ({ chatId, firstMessageId }) =>
            replyPath(chatId, firstMessageId)
        )
        // `none`: the reply stays hidden, so say so instead of opening a page that answers 403
        .with({ kind: 'reply', access: 'none' }, () => NO_ACCESS_PATH)
        // A share link: the page itself decides between the read-only view and the panel page
        .with({ kind: 'share' }, ({ token }) => sharePath(token))
        // A thinking link: the public CoT view, no membership involved
        .with({ kind: 'thinking' }, ({ token }) => thinkingPath(token))
        .otherwise(() => null);

/**
 * Where to go once /api/me has loaded, or null to stay.
 * Only applies when the panel opened at "/": a reload on /c/... keeps its own path.
 */
export const launchRouteOf = (launch: LaunchState, startTarget: StartTarget | null): string | null => {
    if (launch.initialPathname !== '/') return null;
    if (launch.startParam !== null) return routeOfStartTarget(startTarget);
    return launch.savedRoute;
};

// One launch navigation per page load. /share/:token sits outside AppShell (it must
// render without /api/me), so its member redirect remounts AppShell: without this flag
// the start_param target would run again and bounce the member back to the share page.
let launchNavigationTaken = false;

/** True the first time only; later calls mean the launch decision was already applied */
export const takeLaunchNavigation = (): boolean => {
    if (launchNavigationTaken) return false;
    launchNavigationTaken = true;
    return true;
};
