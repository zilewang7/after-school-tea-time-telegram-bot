/**
 * `/m/<payload>.<sig>`: the short-lived signed URLs a Mini App page loads its
 * images / videos / audio from (design §6). Registered outside the /api
 * middleware — an <img> cannot send initData headers, and the HMAC signature is
 * the permission.
 *
 * Every failure is the same 404: an expired or forged token learns nothing, and
 * media the 7-day retention already cleared is simply gone. Ranges are served
 * too, so a large video can stream from the GCS bucket.
 */
import type { Hono } from 'hono';
import { match } from 'ts-pattern';
import type { PanelEnv } from '../context.js';
import { resolveCachedMediaByKey, resolveMessageMedia, resolveVersionMedia, serveMedia } from '../media/media-content.js';
import type { SignedMediaSigner } from './signed-media.js';

export interface SignedMediaRouteOptions {
    signer: SignedMediaSigner;
}

const notFound = (): Response => new Response('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store' } });

export const registerSignedMediaRoute = (app: Hono<PanelEnv>, options: SignedMediaRouteOptions): void => {
    app.get('/m/:token', async (context) => {
        const payload = options.signer.verify(context.req.param('token'));
        if (payload === null) return notFound();
        // `i` is a picture's 0-based position; an old token has none and means the first
        const mediaIndex = payload.i ?? 0;
        const media = await match(payload)
            .with({ k: 'ver' }, () => resolveVersionMedia(payload.c, payload.m, payload.v ?? null, mediaIndex))
            .with({ k: 'cache' }, () => (payload.u === undefined ? Promise.resolve(null) : resolveCachedMediaByKey(payload.u)))
            .with({ k: 'msg' }, () => resolveMessageMedia(payload.c, payload.m, mediaIndex))
            .exhaustive();
        if (media === null) return notFound();
        return serveMedia(context, media);
    });
};
