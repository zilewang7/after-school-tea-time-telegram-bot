/**
 * The public tool-call log page: a stable signed pointer to one reply version's
 * tool records (design 2026-1119-1835 §13.2), built exactly like the
 * GoogleSearch fast page (`/g/`, design 2026-1113-1831 §3.6).
 *
 * No table here: the pointer is a signed payload of the reply identity, so the
 * same version always gets the same URL (a replay cannot drift) and the final
 * layout can build it synchronously, without a write. The signature is the
 * permission, exactly like the other public pages.
 *
 * The secret context differs from the search page's, so a token of one kind can
 * never be replayed as the other.
 *
 * Layer 0: the final layout (reply), the version replay (services) and the page
 * renderer (panel) all build or verify the same token.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isJsonObject } from './json-object.js';
import { webappPublicUrl } from './public-url.js';
import { shareSecretOf } from './share-secret.js';

/** What one page shows: the version of one bot reply */
export interface ToolLogPageTarget {
    readonly chatId: number;
    readonly firstMessageId: number;
    readonly versionId: number;
}

/** A page pointer as the chat message renders it */
export interface ToolLogPageLink {
    /** Signed page token: `<payload>.<signature>`; the route's path segment */
    readonly token: string;
    /** Absolute public URL of the fast page */
    readonly url: string;
}

/** Path prefix of the fast page; registered before the SPA catch-all */
export const TOOL_LOG_PAGE_PATH_PREFIX = '/x/';

/** Domain separation: a tool-log token can never be replayed as a `/g`, `/w`, `/m` or `/s` token */
const SECRET_CONTEXT = 'k-on-bot-tool-log-page';

/** The switch (on unless TOOL_LOG_LINK is exactly 0) and a public origin to point at */
export const toolLogLinkEnabled = (): boolean =>
    (process.env.TOOL_LOG_LINK ?? '').trim() !== '0' && webappPublicUrl() !== '';

/** The relative path of one page */
export const toolLogPagePathOf = (token: string): string => `${TOOL_LOG_PAGE_PATH_PREFIX}${token}`;

const toolLogSecretOf = (): Buffer =>
    createHmac('sha256', shareSecretOf(process.env.BOT_TOKEN ?? '', process.env.WEBAPP_SHARE_SECRET))
        .update(SECRET_CONTEXT)
        .digest();

const signatureOf = (payload: string): string =>
    createHmac('sha256', toolLogSecretOf()).update(payload).digest('base64url');

const tokenOfTarget = (target: ToolLogPageTarget): string => {
    const payload = Buffer.from(
        JSON.stringify({ c: target.chatId, m: target.firstMessageId, v: target.versionId }),
        'utf8'
    ).toString('base64url');
    return `${payload}.${signatureOf(payload)}`;
};

/** The signed token of one version, without the origin */
export const toolLogPageTokenOf = (target: ToolLogPageTarget): string => tokenOfTarget(target);

/** The page pointer of one version; null without a public origin to point at */
export const toolLogPageLinkOf = (target: ToolLogPageTarget): ToolLogPageLink | null => {
    const origin = webappPublicUrl();
    if (origin === '') return null;
    const token = tokenOfTarget(target);
    return { token, url: `${origin}${toolLogPagePathOf(token)}` };
};

const targetOfPayload = (value: unknown): ToolLogPageTarget | null => {
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
export const toolLogPageTargetOfToken = (token: string): ToolLogPageTarget | null => {
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
 * rewrites old links; without a public origin the replay keeps the inline block
 * (the page would not be reachable anyway).
 */
export const toolLogPageLinkOfToken = (token: string): ToolLogPageLink | null => {
    if (toolLogPageTargetOfToken(token) === null) return null;
    const origin = webappPublicUrl();
    if (origin === '') return null;
    return { token, url: `${origin}${toolLogPagePathOf(token)}` };
};
