import { match, P } from 'ts-pattern';
import type { StartTarget } from './api';
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
        // `unavailable` too: the dashboard gets the same 503 and retries until the lookup works
        .with({ kind: 'chat', access: P.union('member', 'observer', 'unavailable') }, ({ chatId }) => `/c/${chatId}`)
        // Phase 1 has no issue pages yet, so an issue link opens the chat it belongs to
        .with({ kind: 'issue', chatId: P.number, access: P.union('member', 'observer') }, ({ chatId }) => `/c/${chatId}`)
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
