/**
 * The public Google-search detail page: a stable signed pointer to one reply
 * version's search records (design 2026-1113-1831 §3.6).
 *
 * No table: the pointer is a signed payload of the reply identity, so the same
 * version always gets the same URL (a replay cannot drift) and the final layout
 * can build it synchronously, without a write. The signature is the permission,
 * exactly like the other public pages: chat id and message id are guessable, the
 * signature is not.
 *
 * Layer 0: the final layout (reply), the version replay (services) and the page
 * renderer (panel) all build or verify the same token.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isJsonObject } from './json-object.js';
import { webappPublicUrl } from './public-url.js';
import { shareSecretOf } from './share-secret.js';

/** What one page shows: the version of one bot reply */
export interface SearchPageTarget {
    readonly chatId: number;
    readonly firstMessageId: number;
    readonly versionId: number;
}

/** A page pointer as the chat message renders it */
export interface SearchPageLink {
    /** Signed page token: `<payload>.<signature>`; the route's path segment */
    readonly token: string;
    /** Absolute public URL of the fast page */
    readonly url: string;
}

/** Path prefix of the fast page; registered before the SPA catch-all */
export const SEARCH_PAGE_PATH_PREFIX = '/g/';

/** Domain separation: a search-page token can never be replayed as a `/w`, `/m` or `/s` token */
const SECRET_CONTEXT = 'k-on-bot-search-page';

/** The switch (on unless SEARCH_LINK is exactly 0) and a public origin to point at */
export const searchLinkEnabled = (): boolean =>
    (process.env.SEARCH_LINK ?? '').trim() !== '0' && webappPublicUrl() !== '';

/** The relative path of one page */
export const searchPagePathOf = (token: string): string => `${SEARCH_PAGE_PATH_PREFIX}${token}`;

const searchSecretOf = (): Buffer =>
    createHmac('sha256', shareSecretOf(process.env.BOT_TOKEN ?? '', process.env.WEBAPP_SHARE_SECRET))
        .update(SECRET_CONTEXT)
        .digest();

const signatureOf = (payload: string): string =>
    createHmac('sha256', searchSecretOf()).update(payload).digest('base64url');

const tokenOfTarget = (target: SearchPageTarget): string => {
    const payload = Buffer.from(
        JSON.stringify({ c: target.chatId, m: target.firstMessageId, v: target.versionId }),
        'utf8'
    ).toString('base64url');
    return `${payload}.${signatureOf(payload)}`;
};

/** The signed token of one version, without the origin */
export const searchPageTokenOf = (target: SearchPageTarget): string => tokenOfTarget(target);

/** The page pointer of one version; null without a public origin to point at */
export const searchPageLinkOf = (target: SearchPageTarget): SearchPageLink | null => {
    const origin = webappPublicUrl();
    if (origin === '') return null;
    const token = tokenOfTarget(target);
    return { token, url: `${origin}${searchPagePathOf(token)}` };
};

const targetOfPayload = (value: unknown): SearchPageTarget | null => {
    if (!isJsonObject(value)) return null;
    const chatId = value.c;
    const firstMessageId = value.m;
    const versionId = value.v;
    if (typeof chatId !== 'number' || !Number.isSafeInteger(chatId)) return null;
    if (typeof firstMessageId !== 'number' || !Number.isSafeInteger(firstMessageId)) return null;
    if (typeof versionId !== 'number' || !Number.isSafeInteger(versionId) || versionId < 1) return null;
    return { chatId, firstMessageId, versionId };
};

/** The target behind a token, or null when the signature or the payload is wrong */
export const searchPageTargetOfToken = (token: string): SearchPageTarget | null => {
    const dot = token.indexOf('.');
    if (dot <= 0 || dot === token.length - 1) return null;
    const payload = token.slice(0, dot);
    const given = Buffer.from(token.slice(dot + 1), 'base64url');
    const expected = Buffer.from(signatureOf(payload), 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let decoded: unknown;
    try {
        decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
    return targetOfPayload(decoded);
};

/**
 * The pointer a stored token replays. The origin is read now, so a domain move
 * rewrites old links; without a public origin the replay keeps today's inline
 * footer (the page would not be reachable anyway).
 */
export const searchPageLinkOfToken = (token: string): SearchPageLink | null => {
    if (searchPageTargetOfToken(token) === null) return null;
    const origin = webappPublicUrl();
    if (origin === '') return null;
    return { token, url: `${origin}${searchPagePathOf(token)}` };
};
