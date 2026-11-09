/**
 * The public share routes (design §5.6): `/s/<token>` and the resources its
 * page needs. No initData, no cookies — the token is the permission. Every
 * response is `noindex`, and a token that is unknown, revoked or malformed
 * gets the same 404 page (never a hint about which).
 *
 * `SHARE_ENABLED=0` turns the whole set off (404), leaving the rest of the
 * panel untouched (design §7.4).
 */
import type { Context, Hono } from 'hono';
import type { PanelEnv } from '../context.js';
import { ensurePreviewImage, loadPublicShare, recordSharePageView } from './share-link-service.js';
import { loadShareMedia } from './share-media.js';
import { renderShareNotFoundPage, renderSharePage } from './share-page.js';
import { findShareRowByToken } from './share-store.js';
import { widgetsOfContent } from './share-content.js';
import { baseUrlOfRequest, miniAppShareLink } from './share-urls.js';
import { widgetDocumentOf } from './signed-widget.js';
import type { WidgetTheme } from '../../widget-image/index.js';

/** The share page allows our own inline style/script and same-origin iframes only */
export const SHARE_PAGE_CSP = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    "frame-src 'self'",
    "script-src 'unsafe-inline'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
].join('; ');

const NOINDEX = 'noindex, nofollow';

/** Requests per IP per window (design §5.6); the public share API reuses it */
export const PUBLIC_RATE_LIMIT = { limit: 120, windowMs: 60_000 } as const;
/** Above this many tracked addresses, finished windows are swept */
const SWEEP_THRESHOLD = 1000;

export interface PublicRateLimiterOptions {
    limit: number;
    windowMs: number;
    now: () => number;
}

/** A fixed-window per-key limiter; in memory, reset by a restart */
export const createPublicRateLimiter = (options: PublicRateLimiterOptions): ((key: string) => boolean) => {
    const windows = new Map<string, { startedAt: number; count: number }>();
    return (key) => {
        const now = options.now();
        if (windows.size > SWEEP_THRESHOLD) {
            for (const [trackedKey, window] of windows) {
                if (now - window.startedAt >= options.windowMs) windows.delete(trackedKey);
            }
        }
        const current = windows.get(key);
        const window =
            current !== undefined && now - current.startedAt < options.windowMs
                ? current
                : { startedAt: now, count: 0 };
        windows.set(key, window);
        window.count += 1;
        return window.count <= options.limit;
    };
};

/** The client address behind Traefik; 'unknown' when no proxy header is present */
export const clientIpOf = (context: Context<PanelEnv>): string => {
    const forwarded = context.req.header('x-forwarded-for');
    if (forwarded !== undefined && forwarded.trim() !== '') return forwarded.split(',')[0]?.trim() ?? 'unknown';
    const realIp = context.req.header('x-real-ip');
    return realIp !== undefined && realIp.trim() !== '' ? realIp.trim() : 'unknown';
};

const themeOf = (raw: string | undefined): WidgetTheme => (raw === 'dark' ? 'dark' : 'light');

const notFoundResponse = (context: Context<PanelEnv>): Response =>
    context.html(renderShareNotFoundPage(), 404, {
        'Cache-Control': 'no-store',
        'Content-Security-Policy': SHARE_PAGE_CSP,
        'X-Robots-Tag': NOINDEX,
    });

const disabledResponse = (context: Context<PanelEnv>): Response => context.text('Not Found', 404);

const rateLimitedResponse = (context: Context<PanelEnv>): Response =>
    context.text('Too Many Requests', 429, { 'Retry-After': '60' });

const pageResponse = (body: string): Response =>
    new Response(body, {
        status: 200,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Security-Policy': SHARE_PAGE_CSP,
            'X-Robots-Tag': NOINDEX,
        },
    });

const pngResponse = (data: Buffer, cacheControl: string): Response =>
    new Response(new Uint8Array(data), {
        status: 200,
        headers: {
            'Content-Type': 'image/png',
            'Cache-Control': cacheControl,
            'X-Robots-Tag': NOINDEX,
        },
    });

/** A widget document may only be framed by our own pages (the share page, the panel) */
const WIDGET_DOCUMENT_CSP = SHARE_PAGE_CSP.replace("frame-ancestors 'none'", "frame-ancestors 'self'");

const widgetDocumentResponse = (document: string): Response =>
    new Response(document, {
        status: 200,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Security-Policy': WIDGET_DOCUMENT_CSP,
            'X-Robots-Tag': NOINDEX,
        },
    });

const MESSAGE_ID_PATTERN = /^\d{1,15}$/;
const INDEX_PATTERN = /^\d{1,3}$/;

const parseMessageId = (raw: string): number | null => {
    if (!MESSAGE_ID_PATTERN.test(raw)) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
};

export interface SharePublicRouteOptions {
    /** SHARE_ENABLED is not 0 */
    enabled: boolean;
    now?: () => number;
    rateLimit?: { limit: number; windowMs: number };
}

export const registerSharePublicRoutes = (app: Hono<PanelEnv>, options: SharePublicRouteOptions): void => {
    const now = options.now ?? Date.now;
    const allow = createPublicRateLimiter({ ...(options.rateLimit ?? PUBLIC_RATE_LIMIT), now });

    /** null when the request may proceed; the response to send otherwise */
    const blockedBy = (context: Context<PanelEnv>): Response | null => {
        if (!options.enabled) return disabledResponse(context);
        if (!allow(clientIpOf(context))) return rateLimitedResponse(context);
        return null;
    };

    // GET /s/<token>: the SSR page (design §5.7). `?preview=1` is the URL the
    // bot's group fallback previews (design §18): same page, minimal OG, and it
    // reveals the widget, since that preview is the reader's way in.
    app.get('/s/:token', async (context) => {
        const blocked = blockedBy(context);
        if (blocked !== null) return blocked;
        const share = await loadPublicShare(context.req.param('token'));
        if (share === null) return notFoundResponse(context);
        const previewMode = context.req.query('preview') === '1';
        // Telegram's crawler fetches the preview URL; that is not a reader
        if (!previewMode) recordSharePageView(share.row.token);
        const baseUrl = baseUrlOfRequest(context.req.url);
        // The footer button opens the share itself in the Mini App; the webapp
        // sends a member on to the reply/chat page and everyone else stays here
        const miniAppLink = miniAppShareLink(share.row.token);
        // Only a stored widget render is an og:image; text shares preview as text
        const preview =
            share.row.previewImageBase64 === null
                ? null
                : { width: share.row.previewWidth, height: share.row.previewHeight };
        return pageResponse(
            renderSharePage({
                token: share.row.token,
                baseUrl,
                content: share.content,
                preview,
                miniAppLink,
                ...(previewMode ? { mode: 'preview' as const } : {}),
            })
        );
    });

    // GET /s/<token>/og.png: the stored widget render; 404 when there is none.
    // A missing image is drawn on the first fetch, so a link created while the
    // renderer was down (and a row created before the image meant "the widget
    // itself") still previews once the crawler asks for it.
    app.get('/s/:token/og.png', async (context) => {
        const blocked = blockedBy(context);
        if (blocked !== null) return blocked;
        const token = context.req.param('token');
        const row = await findShareRowByToken(token);
        if (row === null || row.revokedAt !== null) return context.text('Not Found', 404);
        if (row.previewImageBase64 === null) {
            const rendered = await ensurePreviewImage(token);
            if (!rendered) return context.text('Not Found', 404);
        }
        const fresh = row.previewImageBase64 === null ? await findShareRowByToken(token) : row;
        if (fresh === null || fresh.previewImageBase64 === null) return context.text('Not Found', 404);
        return pngResponse(Buffer.from(fresh.previewImageBase64, 'base64'), 'public, max-age=300');
    });

    // GET /s/<token>/widget/<index>: the document a share page's iframe loads
    app.get('/s/:token/widget/:index', async (context) => {
        const blocked = blockedBy(context);
        if (blocked !== null) return blocked;
        const rawIndex = context.req.param('index');
        if (!INDEX_PATTERN.test(rawIndex)) return context.text('Not Found', 404);
        const index = Number(rawIndex);
        const share = await loadPublicShare(context.req.param('token'));
        if (share === null) return context.text('Not Found', 404);
        const widget = widgetsOfContent(share.content)[index];
        if (widget === undefined) return context.text('Not Found', 404);
        return widgetDocumentResponse(widgetDocumentOf(widget.html, themeOf(context.req.query('theme'))));
    });

    // GET /s/<token>/media/<messageId>/<slot>: one attachment of the shared content
    app.get('/s/:token/media/:messageId/:slot', async (context) => {
        const blocked = blockedBy(context);
        if (blocked !== null) return blocked;
        const messageId = parseMessageId(context.req.param('messageId'));
        if (messageId === null) return context.text('Not Found', 404);
        const row = await findShareRowByToken(context.req.param('token'));
        if (row === null || row.revokedAt !== null) return context.text('Not Found', 404);
        const media = await loadShareMedia(row, messageId, context.req.param('slot'));
        if (media === null) return context.text('Not Found', 404);
        return new Response(new Uint8Array(media.data), {
            status: 200,
            headers: {
                'Content-Type': media.mimeType,
                'Cache-Control': 'private, max-age=600',
                'X-Robots-Tag': NOINDEX,
            },
        });
    });
};
