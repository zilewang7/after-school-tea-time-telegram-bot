/**
 * The single web-login runtime shared by the bot command and the panel server.
 *
 * Both live in one process: `/web` issues a code into this store and the panel
 * redeems it. Keeping one lazily created instance (instead of wiring the store
 * through two entry points) also keeps the maintenance timer in one place.
 *
 * `enabled` is read from the env at creation; disabled means the panel keeps
 * the login routes but answers them as if web login did not exist, and never
 * authenticates a cookie.
 */
import {
    webLoginBotChatLink,
    webLoginEnabled,
    webLoginMiniAppLink,
    webLoginPublicUrl,
    webLoginSecureCookies,
} from '../../config/web-login.js';
import { createWebLoginCodeStore, type WebLoginCodeStore } from './web-login-code.js';
import { createSqlWebSessionStore, type WebSessionStore } from './web-session.js';

export interface WebAuthRuntime {
    readonly enabled: boolean;
    readonly codes: WebLoginCodeStore;
    readonly sessions: WebSessionStore;
    readonly now: () => number;
    readonly secureCookies: boolean;
    readonly publicUrl: string;
    readonly botChatLink: string | null;
    readonly miniAppLink: string | null;
}

export const createWebAuthRuntime = (now: () => number = Date.now): WebAuthRuntime => ({
    enabled: webLoginEnabled(),
    codes: createWebLoginCodeStore({ now }),
    sessions: createSqlWebSessionStore({ now }),
    now,
    secureCookies: webLoginSecureCookies(),
    publicUrl: webLoginPublicUrl(),
    botChatLink: webLoginBotChatLink(),
    miniAppLink: webLoginMiniAppLink(),
});

let runtime: WebAuthRuntime | undefined;

/** The process-wide runtime (created on first use) */
export const getWebAuthRuntime = (): WebAuthRuntime => {
    if (runtime === undefined) runtime = createWebAuthRuntime();
    return runtime;
};

/** Tests only: forget the singleton so a fresh env is picked up */
export const resetWebAuthRuntimeForTests = (): void => {
    runtime = undefined;
};

/** One minute is enough: codes live five, sessions expire after thirty days */
const MAINTENANCE_INTERVAL_MS = 60 * 1000;

/**
 * Periodic sweep of expired codes and sessions. Returns a stop function; the
 * panel server starts it once the HTTP server is listening.
 */
export const startWebAuthMaintenance = (auth: WebAuthRuntime): (() => void) => {
    let stopped = false;
    const run = (): void => {
        if (stopped) return;
        auth.codes.sweep();
        void auth.sessions.sweep().catch((error: unknown) => {
            console.warn('[web-login] session sweep failed:', error);
        });
    };
    const timer = setInterval(run, MAINTENANCE_INTERVAL_MS);
    timer.unref();
    run();
    return () => {
        stopped = true;
        clearInterval(timer);
    };
};
