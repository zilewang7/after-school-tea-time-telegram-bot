/**
 * Authentication for every /api route but the public ones.
 *
 * Two credentials are accepted, in this order:
 *
 * 1. `X-Init-Data` (never a query parameter), as the Telegram Mini App sends
 *    it; verified with the age limit of the request kind — writes (PATCH / PUT /
 *    DELETE / POST, except the settings preview) need initData from the last 5
 *    minutes, reads from the last 24 hours.
 * 2. `kob_web` cookie, a browser session created by `POST /api/auth/code`
 *    (design §5.4). A cookie session is server-issued, not a replay, so it
 *    needs no short window; writes get a same-origin check instead.
 *
 * A present-but-invalid header never falls back to the cookie: one request,
 * one identity. A failure is logged by reason only; no credential is logged.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { isOwnerUser } from '../../config/owner.js';
import { touchPanelUserDebounced } from '../../db/queries/panel-registry.js';
import { createChatAccessResolver } from '../access/chat-access.js';
import type { MembershipChecker } from '../access/membership.js';
import { READ_MAX_AGE_SECONDS, WRITE_MAX_AGE_SECONDS, verifyInitData } from '../auth/init-data.js';
import { WEB_SESSION_COOKIE, type WebSessionStore } from '../auth/web-session.js';
import { panelUserOfWebSession } from '../auth/web-user.js';
import type { PanelEnv } from '../context.js';
import { PANEL_MESSAGES, PanelError } from '../errors.js';
import type { PanelUser } from '../types.js';

export const INIT_DATA_HEADER = 'X-Init-Data';

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** POST that only renders and stores nothing, so it keeps the read window */
const PREVIEW_PATH = /^\/api\/chats\/[^/]+\/settings\/preview$/;

export const isWriteRequest = (method: string, path: string): boolean => {
    if (READ_METHODS.has(method)) return false;
    return !(method === 'POST' && PREVIEW_PATH.test(path));
};

/**
 * Origin (or Referer) must name the same host this request targeted. Behind
 * Traefik the Host header is the public host; X-Forwarded-Host is the fallback.
 * A browser sends Origin on every POST, so a missing one is a non-browser
 * client — which has no cookie to abuse, but is refused anyway.
 */
/** Host header without its port; IPv6 literals keep their brackets */
const hostnameOfHostHeader = (host: string): string => {
    const trimmed = host.trim().toLowerCase();
    if (trimmed.startsWith('[')) {
        const end = trimmed.indexOf(']');
        return end === -1 ? trimmed : trimmed.slice(0, end + 1);
    }
    const colon = trimmed.indexOf(':');
    return colon === -1 ? trimmed : trimmed.slice(0, colon);
};

const isSameOriginWrite = (context: Context<PanelEnv>): boolean => {
    const source = context.req.header('origin') ?? context.req.header('referer');
    if (source === undefined || source === '') return false;
    const host = context.req.header('host') ?? context.req.header('x-forwarded-host');
    if (host === undefined || host === '') return false;
    try {
        // Ports are ignored on purpose: Traefik may keep :443 in Host while
        // Origin (and vice versa) omits it; the hostname is the trust boundary.
        return new URL(source).hostname.toLowerCase() === hostnameOfHostHeader(host);
    } catch {
        return false;
    }
};

export interface AuthMiddlewareOptions {
    botToken: string;
    checker: MembershipChecker;
    /** Clock in ms */
    now: () => number;
    /** Browser sessions; absent or null = cookie login is off */
    webSessions?: WebSessionStore | null;
}

export const createAuthMiddleware =
    (options: AuthMiddlewareOptions): MiddlewareHandler<PanelEnv> =>
    async (context, next) => {
        const headerValue = context.req.header(INIT_DATA_HEADER);
        const hasHeader = headerValue !== undefined && headerValue !== '';

        if (hasHeader) {
            const maxAgeSeconds = isWriteRequest(context.req.method, context.req.path)
                ? WRITE_MAX_AGE_SECONDS
                : READ_MAX_AGE_SECONDS;
            const verification = verifyInitData(headerValue, options.botToken, {
                maxAgeSeconds,
                nowSeconds: Math.floor(options.now() / 1000),
            });
            if (!verification.ok) {
                console.log(`[panel] auth rejected: ${verification.reason}`);
                throw new PanelError('unauthorized', PANEL_MESSAGES.unauthorized);
            }

            const verifiedUser = verification.data.user;
            const user: PanelUser = { ...verifiedUser, isOwner: isOwnerUser(verifiedUser.id) };
            // Display names of panel-only users come from here (60s debounce, never throws)
            touchPanelUserDebounced({
                id: user.id,
                first_name: user.firstName,
                last_name: user.lastName ?? undefined,
                username: user.username ?? undefined,
            });
            context.set('auth', {
                user,
                access: createChatAccessResolver(user, options.checker),
                startParam: verification.data.startParam,
                authenticatedBy: 'telegram',
            });
            await next();
            return;
        }

        const sessions = options.webSessions;
        const token = sessions === null || sessions === undefined ? undefined : getCookie(context, WEB_SESSION_COOKIE);
        if (sessions === null || sessions === undefined || token === undefined || token === '') {
            console.log('[panel] auth rejected: missing');
            throw new PanelError('unauthorized', PANEL_MESSAGES.unauthorized);
        }
        if (isWriteRequest(context.req.method, context.req.path) && !isSameOriginWrite(context)) {
            console.log('[panel] auth rejected: cross-origin write');
            throw new PanelError('forbidden', '请求来源不合法');
        }
        const session = await sessions.resolve(token);
        if (session === null) {
            console.log('[panel] auth rejected: web session unknown or expired');
            throw new PanelError('unauthorized', PANEL_MESSAGES.unauthorized);
        }
        const user = await panelUserOfWebSession(session.userId);
        await sessions.touch(token);
        context.set('auth', {
            user,
            access: createChatAccessResolver(user, options.checker),
            startParam: null,
            authenticatedBy: 'web',
        });
        await next();
    };
