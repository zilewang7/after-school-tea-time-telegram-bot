/**
 * The two public thinking entries (design §5.4/§6.1):
 * - `GET /api/public/thinking/<token>`, the JSON both pages read, registered in
 *   front of the `/api/*` initData middleware (the token is the permission);
 * - `GET /t/<token>`, the SSR fast page the link preview opens.
 *
 * Neither takes initData or cookies; every failure — malformed, unknown,
 * disabled, rate-limited — is uniform, so a caller learns nothing from it.
 * `THINKING_LINK=0` answers 404 on both (same handling as `SHARE_ENABLED=0`).
 */
import type { Context, Hono } from 'hono';
import type { PanelEnv } from '../context.js';
import { errorBody } from '../errors.js';
import { clientIpOf, createPublicRateLimiter, PUBLIC_RATE_LIMIT } from '../share/public-routes.js';
import { renderThinkingNotFoundPage, renderThinkingPage, THINKING_PAGE_CSP } from './thinking-page.js';
import type { PublicThinkingResponse } from './thinking-types.js';
import { loadThinkingDocument, parseThinkingAfter, toPublicThinkingResponse } from './thinking-view.js';
import { thinkingMiniAppDeepLink } from './thinking-urls.js';

const NOINDEX = 'noindex, nofollow';
const NO_STORE = 'no-store';

/**
 * The JSON is polled every 700ms while a thinking generates (~86 requests a
 * minute per reader), and mobile readers share carrier-NAT addresses, so the
 * `PUBLIC_RATE_LIMIT` budget would throttle a few simultaneous readers. The
 * token itself is the permission; the page route keeps the shared budget.
 */
const THINKING_API_RATE_LIMIT = { limit: 600, windowMs: 60_000 } as const;

/** Same message for every 404: nothing about a token's existence leaks */
const THINKING_NOT_FOUND_MESSAGE = '思考过程不存在';

const notFoundJsonResponse = (context: Context<PanelEnv>): Response =>
    context.json(errorBody('not_found', THINKING_NOT_FOUND_MESSAGE), 404, {
        'Cache-Control': NO_STORE,
        'X-Robots-Tag': NOINDEX,
    });

const rateLimitedJsonResponse = (context: Context<PanelEnv>): Response =>
    context.json(errorBody('rate_limited', '请求过于频繁，请稍后再试。'), 429, {
        'Cache-Control': NO_STORE,
        'Retry-After': '60',
        'X-Robots-Tag': NOINDEX,
    });

const jsonResponse = (context: Context<PanelEnv>, body: PublicThinkingResponse): Response =>
    context.json(body, 200, { 'Cache-Control': NO_STORE, 'X-Robots-Tag': NOINDEX });

const notFoundPageResponse = (context: Context<PanelEnv>): Response =>
    context.html(renderThinkingNotFoundPage(), 404, {
        'Cache-Control': NO_STORE,
        'Content-Security-Policy': THINKING_PAGE_CSP,
        'X-Robots-Tag': NOINDEX,
    });

const pageResponse = (body: string): Response =>
    new Response(body, {
        status: 200,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': NO_STORE,
            'Content-Security-Policy': THINKING_PAGE_CSP,
            'X-Robots-Tag': NOINDEX,
        },
    });

export interface ThinkingRouteOptions {
    /** THINKING_LINK is on and WEBAPP_PUBLIC_URL is set; off answers 404 like an unknown token */
    enabled: boolean;
    now?: () => number;
    rateLimit?: { limit: number; windowMs: number };
}

/**
 * `GET /api/public/thinking/<token>`. Registered before the `/api/*` middleware
 * stack: no initData, no per-user limit; a per-address limiter with a budget
 * sized for the 700ms poll (see THINKING_API_RATE_LIMIT).
 */
export const registerPublicThinkingApiRoutes = (
    app: Hono<PanelEnv>,
    options: ThinkingRouteOptions
): void => {
    const now = options.now ?? Date.now;
    const allow = createPublicRateLimiter({ ...(options.rateLimit ?? THINKING_API_RATE_LIMIT), now });

    app.get('/api/public/thinking/:token', async (context) => {
        if (!options.enabled) return notFoundJsonResponse(context);
        if (!allow(clientIpOf(context))) return rateLimitedJsonResponse(context);
        const document = await loadThinkingDocument(context.req.param('token'));
        if (document === null) return notFoundJsonResponse(context);
        const after = parseThinkingAfter(context.req.query('after'));
        return jsonResponse(context, toPublicThinkingResponse(document, after));
    });
};

/**
 * `GET /t/<token>`. Registered before the static catch-all so `/t` never serves
 * the SPA.
 */
export const registerThinkingPublicRoutes = (app: Hono<PanelEnv>, options: ThinkingRouteOptions): void => {
    const now = options.now ?? Date.now;
    const allow = createPublicRateLimiter({ ...(options.rateLimit ?? PUBLIC_RATE_LIMIT), now });

    app.get('/t/:token', async (context) => {
        if (!options.enabled) return context.text('Not Found', 404);
        if (!allow(clientIpOf(context))) return context.text('Too Many Requests', 429, { 'Retry-After': '60' });
        const document = await loadThinkingDocument(context.req.param('token'));
        if (document === null) return notFoundPageResponse(context);
        return pageResponse(
            renderThinkingPage({
                document,
                miniAppLink: thinkingMiniAppDeepLink(document.row.token),
            })
        );
    });
};
