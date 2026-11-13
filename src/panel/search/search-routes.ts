/**
 * The public Google-search fast page route (design 2026-1113-1831 §3.5).
 *
 * `GET /g/<token>`: the signed token is the permission, so the route takes no
 * initData and no cookie. Registered before the static catch-all so `/g` never
 * serves the SPA, and before nothing else — it sits next to `/t`.
 *
 * Every failure is uniform: a disabled switch answers a plain 404 like any
 * unknown path, and a bad, forged or dataless token answers the same 404 page,
 * so a caller learns nothing from it.
 */
import type { Context, Hono } from 'hono';
import type { PanelEnv } from '../context.js';
import { clientIpOf, createPublicRateLimiter, PUBLIC_RATE_LIMIT } from '../share/public-routes.js';
import { renderSearchNotFoundPage, SEARCH_PAGE_CSP } from './search-page.js';
import { searchPageTargetOfToken } from '../../shared/search-page.js';
import { findSearchLinkByToken } from './search-store.js';

const NOINDEX = 'noindex, nofollow';
const NO_STORE = 'no-store';

/** Same message for every miss: nothing about a token's existence leaks */
const notFoundPageResponse = (context: Context<PanelEnv>): Response =>
    context.html(renderSearchNotFoundPage(), 404, {
        'Cache-Control': NO_STORE,
        'Content-Security-Policy': SEARCH_PAGE_CSP,
        'X-Robots-Tag': NOINDEX,
    });

const rateLimitedResponse = (context: Context<PanelEnv>): Response =>
    context.text('Too Many Requests', 429, { 'Retry-After': '60' });

const pageResponse = (body: string): Response =>
    new Response(body, {
        status: 200,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': NO_STORE,
            'Content-Security-Policy': SEARCH_PAGE_CSP,
            'X-Robots-Tag': NOINDEX,
        },
    });

export interface SearchPublicRouteOptions {
    /** SEARCH_LINK is on and WEBAPP_PUBLIC_URL is set */
    enabled: boolean;
    now?: () => number;
    rateLimit?: { limit: number; windowMs: number };
}

export const registerSearchPublicRoutes = (
    app: Hono<PanelEnv>,
    options: SearchPublicRouteOptions
): void => {
    const now = options.now ?? Date.now;
    const allow = createPublicRateLimiter({ ...(options.rateLimit ?? PUBLIC_RATE_LIMIT), now });

    app.get('/g/:token', async (context) => {
        if (!options.enabled) return context.text('Not Found', 404);
        if (!allow(clientIpOf(context))) return rateLimitedResponse(context);
        const token = context.req.param('token');
        // The signature is the permission; a forged token never reaches the table
        if (searchPageTargetOfToken(token) === null) return notFoundPageResponse(context);
        const page = await findSearchLinkByToken(token);
        if (page === null) return notFoundPageResponse(context);
        return pageResponse(page.html);
    });
};
