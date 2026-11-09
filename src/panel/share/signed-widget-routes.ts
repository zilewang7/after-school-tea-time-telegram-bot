/**
 * `/w/<payload>.<sig>`: the short-lived signed URLs the panel's widget iframe
 * loads (design §5.5). Registered outside the /api middleware — an iframe
 * cannot send initData headers, and the HMAC signature is the permission.
 *
 * `k=doc` returns the complete widget document (CSP: no network, our origin
 * may frame it); `k=img` returns the version's stored 600px PNG, or renders
 * one when the renderer is configured.
 */
import type { Context, Hono } from 'hono';
import { isWidgetRenderConfigured, renderWidgetPng } from '../../widget-image/index.js';
import type { PanelEnv } from '../context.js';
import {
    loadSignedWidgetContent,
    splitSignedTokenAndTheme,
    widgetDocumentOf,
    WIDGET_DOC_CSP,
    type SignedWidgetSigner,
} from './signed-widget.js';

const NOINDEX = 'noindex, nofollow';

const documentResponse = (document: string): Response =>
    new Response(document, {
        status: 200,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': WIDGET_DOC_CSP,
            'Cache-Control': 'no-store',
            'X-Robots-Tag': NOINDEX,
        },
    });

const pngResponse = (data: Buffer): Response =>
    new Response(new Uint8Array(data), {
        status: 200,
        headers: {
            'Content-Type': 'image/png',
            'Cache-Control': 'private, max-age=600',
            'X-Robots-Tag': NOINDEX,
        },
    });

const notFound = (context: Context<PanelEnv>): Response => context.text('Not Found', 404);

export interface SignedWidgetRouteOptions {
    signer: SignedWidgetSigner;
}

export const registerSignedWidgetRoute = (app: Hono<PanelEnv>, options: SignedWidgetRouteOptions): void => {
    app.get('/w/:token', async (context) => {
        const { token, theme } = splitSignedTokenAndTheme(context.req.param('token'), context.req.query('theme'));
        const payload = options.signer.verify(token);
        if (payload === null) return notFound(context);
        const content = await loadSignedWidgetContent(payload);
        if (content === null) return notFound(context);

        if (payload.k === 'doc') return documentResponse(widgetDocumentOf(content.html, theme));
        if (content.imageBase64 !== null) return pngResponse(Buffer.from(content.imageBase64, 'base64'));

        if (!isWidgetRenderConfigured()) return notFound(context);
        const rendered = await renderWidgetPng(content.html, { width: 600, theme });
        return rendered === null ? notFound(context) : pngResponse(rendered.png);
    });
};
