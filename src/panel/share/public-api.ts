/**
 * The public JSON form of a share (design §5.6/§5.7): what the Mini App reads
 * when it opens `?startapp=s<token>`.
 *
 * No initData, no cookies — the token is the permission, exactly like the SSR
 * page. The view itself (names, shapes, conversion) lives in `public-view.ts`,
 * so the reply layer can build the same view without importing this Hono
 * module; it is re-exported here for the API's callers.
 *
 * Every failure — disabled feature, malformed, unknown or revoked token — is
 * the same 404 JSON, so a caller cannot tell whether a token ever existed.
 */
import type { Context, Hono } from 'hono';
import type { PanelEnv } from '../context.js';
import { errorBody, PANEL_MESSAGES } from '../errors.js';
import { clientIpOf, createPublicRateLimiter, PUBLIC_RATE_LIMIT } from './public-routes.js';
import { toPublicShareView } from './public-view.js';
import { loadPublicShare } from './share-link-service.js';

export * from './public-view.js';

/** Same message for every 404: a caller learns nothing about a token */
const SHARE_NOT_FOUND_MESSAGE = '分享不存在或已撤销';

const NOINDEX = 'noindex, nofollow';
const NO_STORE = 'no-store';

const notFoundResponse = (context: Context<PanelEnv>): Response =>
    context.json(errorBody('not_found', SHARE_NOT_FOUND_MESSAGE), 404, {
        'Cache-Control': NO_STORE,
        'X-Robots-Tag': NOINDEX,
    });

const rateLimitedResponse = (context: Context<PanelEnv>): Response =>
    context.json(errorBody('rate_limited', PANEL_MESSAGES.rateLimited), 429, {
        'Cache-Control': NO_STORE,
        'Retry-After': '60',
        'X-Robots-Tag': NOINDEX,
    });

export interface PublicShareApiOptions {
    /** SHARE_ENABLED is not 0; off answers the same 404 as an unknown token */
    enabled: boolean;
    now?: () => number;
    rateLimit?: { limit: number; windowMs: number };
}

/**
 * `GET /api/public/shares/<token>`. Registered in front of the /api middleware
 * stack (no initData, no per-user rate limit); the per-IP limiter is the public
 * one the `/s/*` routes use.
 */
export const registerPublicShareApiRoutes = (app: Hono<PanelEnv>, options: PublicShareApiOptions): void => {
    const now = options.now ?? Date.now;
    const allow = createPublicRateLimiter({ ...(options.rateLimit ?? PUBLIC_RATE_LIMIT), now });

    app.get('/api/public/shares/:token', async (context) => {
        if (!options.enabled) return notFoundResponse(context);
        if (!allow(clientIpOf(context))) return rateLimitedResponse(context);
        const share = await loadPublicShare(context.req.param('token'));
        if (share === null) return notFoundResponse(context);
        return context.json({ share: toPublicShareView(share.row, share.content) }, 200, {
            'Cache-Control': NO_STORE,
            'X-Robots-Tag': NOINDEX,
        });
    });
};
