import { match, P } from 'ts-pattern';
import type { StartTarget } from './api';
import { chatPath, issuePath } from './routing/paths';
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
}

export const captureLaunchState = (webApp: TelegramWebApp): LaunchState => {
    const savedRoute = readStorage(LAST_ROUTE_KEY);
    return {
        initialPathname: window.location.pathname,
        startParam: readStartParam(webApp),
        savedRoute: savedRoute !== null && RESTORABLE_ROUTE.test(savedRoute) ? savedRoute : null,
    };
};

const routeOfStartTarget = (startTarget: StartTarget | null): string | null =>
    match(startTarget)
        // `unavailable` too: the chat's page gets the same 503 and retries until the lookup works.
        // "/c/:id" then opens the chat's remembered or default tab.
        .with({ kind: 'chat', access: P.union('member', 'observer', 'unavailable') }, ({ chatId }) => chatPath(chatId))
        // Whatever the access: the issue page asks the server, which answers 404 when the issue is hidden
        .with({ kind: 'issue' }, ({ issueId }) => issuePath(issueId))
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
