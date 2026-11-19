/**
 * The public tool-call log fast page route (design 2026-1119-1835 §13.2).
 *
 * `GET /x/<token>`: the signed token is the permission, so the route takes no
 * initData and no cookie. Registered before the static catch-all so `/x` never
 * serves the SPA, and next to the other public pages (`/g`, `/t`, `/s`).
 *
 * Every failure is uniform: a disabled switch answers a plain 404 like any
 * unknown path, and a bad, forged or dataless token answers the same 404 page,
 * so a caller learns nothing from it.
 */
import type { Context, Hono } from 'hono';
import type { PanelEnv } from '../context.js';
import { clientIpOf, createPublicRateLimiter, PUBLIC_RATE_LIMIT } from '../share/public-routes.js';
import { renderToolLogNotFoundPage, TOOL_LOG_PAGE_CSP } from './tool-log-page.js';
import { toolLogPageTargetOfToken } from '../../shared/tool-log-page.js';
import { findToolLogPageByToken } from './tool-log-store.js';

const NOINDEX = 'noindex, nofollow';
const NO_STORE = 'no-store';

/** Same message for every miss: nothing about a token's existence leaks */
const notFoundPageResponse = (context: Context<PanelEnv>): Response =>
    context.html(renderToolLogNotFoundPage(), 404, {
        'Cache-Control': NO_STORE,
        'Content-Security-Policy': TOOL_LOG_PAGE_CSP,
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
            'Content-Security-Policy': TOOL_LOG_PAGE_CSP,
            'X-Robots-Tag': NOINDEX,
        },
    });

export interface ToolLogPublicRouteOptions {
    /** TOOL_LOG_LINK is on and WEBAPP_PUBLIC_URL is set */
    enabled: boolean;
    now?: () => number;
    rateLimit?: { limit: number; windowMs: number };
}

export const registerToolLogPublicRoutes = (
    app: Hono<PanelEnv>,
    options: ToolLogPublicRouteOptions
): void => {
    const now = options.now ?? Date.now;
    const allow = createPublicRateLimiter({ ...(options.rateLimit ?? PUBLIC_RATE_LIMIT), now });

    app.get('/x/:token', async (context) => {
        if (!options.enabled) return context.text('Not Found', 404);
        if (!allow(clientIpOf(context))) return rateLimitedResponse(context);
        const token = context.req.param('token');
        // The signature is the permission; a forged token never reaches the table
        if (toolLogPageTargetOfToken(token) === null) return notFoundPageResponse(context);
        const page = await findToolLogPageByToken(token);
        if (page === null) return notFoundPageResponse(context);
        return pageResponse(page.html);
    });
};
