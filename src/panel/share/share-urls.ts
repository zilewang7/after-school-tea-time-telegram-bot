/**
 * Where share links point: the public panel URL for `/s/<token>`, and the
 * Telegram Mini App Direct Link the share page's footer button uses
 * (`startapp=s<token>`, design §5.10). The bot's group link fallback keeps its
 * own pure builders (reply/widget-link-fallback.ts), so its cases need no env.
 *
 * The env is read per call rather than once: offline cases set it, and the
 * production values come from compose (WEBAPP_PUBLIC_URL, BOT_USER_NAME).
 */
import { encodeStartParam } from '../../shared/contracts/start-param.js';
import { miniAppDirectLink, miniAppPanelLink, webappPublicUrl } from '../../shared/public-url.js';
import { isShareToken } from './token.js';

export { miniAppPanelLink, webappPublicUrl };

/** The public path of one share (always starts with /s/) */
export const sharePathOf = (token: string): string => `/s/${token}`;

/** The absolute public URL of one share */
export const shareUrlOf = (token: string): string => `${webappPublicUrl()}${sharePathOf(token)}`;

/** The token of one of our own share URLs (absolute or relative); null for anything else */
export const shareTokenOfUrl = (url: string): string | null => {
    const lastSegment = url.split('/').at(-1) ?? '';
    return isShareToken(lastSegment) ? lastSegment : null;
};

/** One of our own share URLs found in a message, and which page variant it names */
export interface OwnShareUrl {
    token: string;
    /** `/s/<token>` or the group-fallback variant `/s/<token>/preview` */
    variant: 'page' | 'preview';
}

/** An http(s) URL inside a text; same boundaries as the preview extractor */
const URL_IN_TEXT_PATTERN = /https?:\/\/[^\s<>"'()[\]]+/gi;

/** Sentence punctuation that may follow a URL; never part of one of our share paths */
const TRAILING_PUNCTUATION_PATTERN = /[.,;:!?。，；：！？、）】」』]+$/;

const trimUrlEnd = (url: string): string => url.replace(TRAILING_PUNCTUATION_PATTERN, '');

/**
 * One of our own share links, as found in a message: strict, because the reply
 * path uses it to decide whether to read the database. The origin must be
 * exactly WEBAPP_PUBLIC_URL's (no userinfo, which would make `new URL` accept
 * a lookalike), the path `/s/<token>` or `/s/<token>/preview`, the token a real
 * share token; query and fragment are ignored. Anything else — including a
 * path such as `/s/<token>/og.png` — is null. Returns null when no public URL
 * is configured (fail closed).
 */
export const ownShareTokenOfUrl = (url: string): OwnShareUrl | null => {
    const publicUrl = webappPublicUrl();
    if (publicUrl === '') return null;
    let base: URL;
    let parsed: URL;
    try {
        base = new URL(publicUrl);
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.username !== '' || parsed.password !== '') return null;
    if (parsed.origin !== base.origin) return null;
    // A deployment behind a path prefix keeps it in its public URLs
    const basePath = base.pathname.replace(/\/+$/, '');
    if (!parsed.pathname.startsWith(`${basePath}/s/`)) return null;
    const segments = parsed.pathname
        .slice(basePath.length)
        .split('/')
        .filter((segment) => segment !== '');
    const token = segments[1];
    if (segments[0] !== 's' || token === undefined || !isShareToken(token)) return null;
    if (segments.length === 2) return { token, variant: 'page' };
    if (segments.length === 3 && segments[2] === 'preview') return { token, variant: 'preview' };
    return null;
};

/**
 * Every own-share token in a message text, in first-appearance order and
 * deduplicated. Pure: it scans the text for http(s) URLs and applies the strict
 * rule above, so a link that is not ours never costs a database lookup.
 */
export const ownShareTokensInText = (text: string): string[] => {
    if (text === '') return [];
    const tokens: string[] = [];
    const seen = new Set<string>();
    for (const match of text.matchAll(URL_IN_TEXT_PATTERN)) {
        const own = ownShareTokenOfUrl(trimUrlEnd(match[0]));
        if (own === null || seen.has(own.token)) continue;
        seen.add(own.token);
        tokens.push(own.token);
    }
    return tokens;
};

/** Absolute URL from a request's own origin, for the OG tags when WEBAPP_PUBLIC_URL is unset */
export const baseUrlOfRequest = (requestUrl: string): string => {
    const configured = webappPublicUrl();
    if (configured !== '') return configured;
    try {
        return new URL(requestUrl).origin;
    } catch {
        return '';
    }
};

/** `t.me/<bot>/<panel>?startapp=s<token>`: the public share, in the Mini App; null without a bot username */
export const miniAppShareLink = (token: string): string | null =>
    miniAppDirectLink(encodeStartParam({ kind: 'share', token }));
