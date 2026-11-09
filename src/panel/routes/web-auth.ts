/**
 * Web login routes (design §5): the browser trades a `/web` code for a session
 * cookie, and can log out again.
 *
 * The login route sits in front of the /api auth middleware — it exists to
 * create credentials, so it cannot require any. Its body is still capped by the
 * same body-limit middleware (mounted on /api/auth/*), and both routes are
 * registered even when WEB_LOGIN=0: the login answers the usual JSON 404 and
 * the config endpoint tells the page that only the Telegram entry is left.
 */
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Hono } from 'hono';
import type { Context } from 'hono';
import type { WebAuthRuntime } from '../auth/web-auth-runtime.js';
import { WEB_SESSION_COOKIE, WEB_SESSION_TTL_MS } from '../auth/web-session.js';
import { panelUserOfWebSession } from '../auth/web-user.js';
import { requireAuth, type PanelEnv } from '../context.js';
import { errorBody, PANEL_MESSAGES, PanelError } from '../errors.js';
import { clientIpOf, createPublicRateLimiter } from '../share/public-routes.js';

/** A wrong code is cheap to try; ten per ten minutes per address is plenty */
const LOGIN_RATE_LIMIT = { limit: 10, windowMs: 10 * 60_000 } as const;
/** The biggest code body we accept (the field itself is capped far lower) */
const MAX_CODE_BODY_CHARS = 256;

const readCodeOf = async (context: Context<PanelEnv>): Promise<string> => {
    let body: unknown;
    try {
        body = await context.req.json();
    } catch {
        throw new PanelError('invalid', '请求格式不正确');
    }
    if (typeof body !== 'object' || body === null || !('code' in body)) {
        throw new PanelError('invalid', '请求格式不正确');
    }
    const raw = body.code;
    if (typeof raw !== 'string' || raw.length > MAX_CODE_BODY_CHARS) {
        throw new PanelError('invalid', '身份码格式不正确');
    }
    return raw;
};

const disabledResponse = (context: Context<PanelEnv>): Response =>
    context.json(errorBody('not_found', PANEL_MESSAGES.notFound), 404);

/**
 * POST /api/auth/code: redeem a code and set the session cookie.
 * Registered before the /api auth middleware.
 */
export const registerPublicWebAuthRoutes = (app: Hono<PanelEnv>, auth: WebAuthRuntime): void => {
    const allowLoginAttempt = createPublicRateLimiter({ ...LOGIN_RATE_LIMIT, now: auth.now });

    // Who the login page should talk to; safe for anyone to read
    app.get('/api/public/web-config', (context) =>
        context.json({
            webLoginEnabled: auth.enabled,
            botUsername: (process.env.BOT_USER_NAME ?? '').trim() || null,
            miniAppUrl: auth.miniAppLink,
        })
    );

    app.post('/api/auth/code', async (context) => {
        if (!auth.enabled) return disabledResponse(context);
        if (!allowLoginAttempt(`login:${clientIpOf(context)}`)) {
            throw new PanelError('rate_limited', '尝试太频繁，请稍后再试', { retryAfterSeconds: 60 });
        }
        const code = await readCodeOf(context);
        const userId = auth.codes.redeem(code);
        if (userId === null) {
            throw new PanelError('unauthorized', '身份码无效或已过期');
        }
        const session = await auth.sessions.create(userId, WEB_SESSION_TTL_MS);
        const user = await panelUserOfWebSession(userId);
        setCookie(context, WEB_SESSION_COOKIE, session.token, {
            path: '/',
            httpOnly: true,
            secure: auth.secureCookies,
            sameSite: 'Lax',
            maxAge: Math.floor(WEB_SESSION_TTL_MS / 1000),
        });
        console.log(`[web-login] session created user=${userId}`);
        return context.json({
            user: {
                id: user.id,
                firstName: user.firstName,
                lastName: user.lastName,
                username: user.username,
            },
            isOwner: user.isOwner,
            expiresAt: session.expiresAt.toISOString(),
        });
    });
};

/**
 * POST /api/auth/logout: drop the session and clear the cookie. Registered
 * after the auth middleware, so it needs a valid cookie or initData.
 */
export const registerWebLogoutRoute = (app: Hono<PanelEnv>, auth: WebAuthRuntime): void => {
    app.post('/api/auth/logout', async (context) => {
        // requireAuth only proves the request is authenticated; the cookie is optional (Telegram)
        requireAuth(context);
        // Logging out does not depend on the switch: an old cookie must still be removable
        const token = getCookie(context, WEB_SESSION_COOKIE);
        if (token !== undefined && token !== '') {
            await auth.sessions.remove(token);
        }
        deleteCookie(context, WEB_SESSION_COOKIE, { path: '/' });
        if (token !== undefined && token !== '') console.log('[web-login] session removed');
        return context.json({ ok: true });
    });
};
