/**
 * Short-lived signed URLs for the panel's widget iframe (design §5.5).
 *
 * The panel cannot put a 32KB widget HTML into its JSON, and an iframe cannot
 * send initData headers, so the reply detail hands the browser `/w/<payload>.<sig>`:
 * a 10-minute HMAC-signed reference to (chat, reply, version, doc|img). The
 * signature is the only permission — no session, no chat membership check —
 * hence the short TTL.
 *
 * Secret: WEBAPP_SHARE_SECRET when set, otherwise derived from BOT_TOKEN. The
 * token itself never appears in a URL or a log.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { findBotResponseInChat } from '../../db/queries/context-queries.js';
import { shareSecretOf } from '../../shared/share-secret.js';
import { widgetDocument, type WidgetTheme } from '../../widget-image/index.js';
import { selectVersion } from './share-content.js';

export type SignedWidgetKind = 'doc' | 'img';

export interface SignedWidgetPayload {
    /** chatId */
    c: number;
    /** firstMessageId of the bot response */
    m: number;
    /** 1-based version id */
    v: number;
    /** expiry, epoch seconds */
    e: number;
    /** doc = the widget document an iframe loads; img = its 600px PNG */
    k: SignedWidgetKind;
}

export interface SignedWidgetTarget {
    chatId: number;
    firstMessageId: number;
    versionId: number;
    kind: SignedWidgetKind;
}

export interface SignedWidgetSigner {
    /** The relative `/w/…` path and its ISO expiry */
    sign(target: SignedWidgetTarget): { path: string; expiresAt: string };
    /** The payload behind a token, or null when the signature/expiry is wrong */
    verify(token: string): SignedWidgetPayload | null;
}

/** How long an iframe URL stays valid (design §5.5) */
export const SIGNED_WIDGET_TTL_SECONDS = 600;

/** The CSP of a widget document: no network, no images but data:, only our origin may frame it */
export const WIDGET_DOC_CSP = [
    "default-src 'none'",
    "img-src data:",
    "style-src 'unsafe-inline'",
    "script-src 'unsafe-inline'",
    "font-src data:",
    "media-src data:",
    "connect-src 'none'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
].join('; ');

/** HMAC key for the share family of signed URLs; the media signer derives its own key from it */
export { shareSecretOf };

const isPayload = (value: unknown): value is SignedWidgetPayload => {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Record<string, unknown>;
    return (
        Number.isSafeInteger(candidate.c) &&
        Number.isSafeInteger(candidate.m) &&
        Number.isSafeInteger(candidate.v) &&
        Number.isSafeInteger(candidate.e) &&
        (candidate.k === 'doc' || candidate.k === 'img')
    );
};

export interface WidgetSignerOptions {
    botToken: string;
    /** Clock in ms (default Date.now) */
    now?: () => number;
    /** Overrides WEBAPP_SHARE_SECRET; tests use a fixed one */
    secret?: string;
}

export const createWidgetSigner = (options: WidgetSignerOptions): SignedWidgetSigner => {
    const now = options.now ?? Date.now;
    const secret = shareSecretOf(options.botToken, options.secret);

    const signatureOf = (encodedPayload: string): Buffer =>
        createHmac('sha256', secret).update(encodedPayload).digest();

    return {
        sign: (target) => {
            const expiresAtSeconds = Math.floor(now() / 1000) + SIGNED_WIDGET_TTL_SECONDS;
            const payload: SignedWidgetPayload = {
                c: target.chatId,
                m: target.firstMessageId,
                v: target.versionId,
                e: expiresAtSeconds,
                k: target.kind,
            };
            const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
            const signature = signatureOf(encodedPayload).toString('base64url');
            return {
                path: `/w/${encodedPayload}.${signature}`,
                expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
            };
        },
        verify: (token) => {
            const dot = token.indexOf('.');
            if (dot <= 0 || dot === token.length - 1) return null;
            const encodedPayload = token.slice(0, dot);
            const signature = token.slice(dot + 1);
            const expected = signatureOf(encodedPayload);
            const actual = Buffer.from(signature, 'base64url');
            if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
            let parsed: unknown;
            try {
                parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
            } catch {
                return null;
            }
            if (!isPayload(parsed)) return null;
            if (parsed.e <= Math.floor(now() / 1000)) return null;
            return parsed;
        },
    };
};

/**
 * A `/w/<token>` path may arrive with a stray `&theme=…` (an early webapp
 * build appended it to a query-less URL); tolerate it and read the theme.
 */
export const splitSignedTokenAndTheme = (
    rawToken: string,
    queryTheme: string | undefined
): { token: string; theme: WidgetTheme } => {
    const amp = rawToken.indexOf('&');
    const token = amp === -1 ? rawToken : rawToken.slice(0, amp);
    const inlineTheme = amp === -1 ? undefined : new URLSearchParams(rawToken.slice(amp + 1)).get('theme') ?? undefined;
    const theme = (queryTheme ?? inlineTheme) === 'dark' ? 'dark' : 'light';
    return { token, theme };
};

/** What the iframe needs of one version */
export interface WidgetVersionContent {
    html: string;
    imageBase64: string | null;
}

/** The widget of the signed version; the current version when the id is gone */
export const loadSignedWidgetContent = async (payload: SignedWidgetPayload): Promise<WidgetVersionContent | null> => {
    const response = await findBotResponseInChat(payload.c, payload.m);
    if (response === null) return null;
    const selected = selectVersion(response, payload.v);
    const widget = selected?.version.widget;
    if (selected === null || widget === undefined) return null;
    return {
        html: widget.html,
        imageBase64: widget.imageBase64 !== undefined && widget.imageBase64 !== '' ? widget.imageBase64 : null,
    };
};

/** The complete document an iframe loads (theme variables + height report) */
export const widgetDocumentOf = (html: string, theme: WidgetTheme): string =>
    widgetDocument(html, { theme, reportHeight: true });
