/**
 * Where the two thinking entries live (design §3/§6):
 * - the fast page `/t/<token>` on the public panel origin, opened by the link
 *   preview card and by any browser;
 * - the Mini App page `/think/<token>` (the webapp's own route), reached through
 *   the Direct Link `https://t.me/<bot>/<short name>?startapp=t<token>`.
 *
 * The env is read per call (same reason as share-urls.ts): offline cases set it.
 */
import { encodeStartParam } from '../../shared/contracts/start-param.js';
import { miniAppDirectLink, webappPublicUrl } from '../../shared/public-url.js';
import { isShareToken } from '../share/token.js';

/** The public path of one fast page */
export const thinkingFastPagePath = (token: string): string => `/t/${token}`;

/** The absolute public URL of one fast page; relative when WEBAPP_PUBLIC_URL is unset */
export const thinkingFastPageUrl = (token: string): string =>
    `${webappPublicUrl()}${thinkingFastPagePath(token)}`;

/** The Mini App page path; the webapp routes this itself, no public origin involved */
export const thinkingMiniAppPath = (token: string): string => `/think/${token}`;

/** `t.me/<bot>/<panel>?startapp=t<token>`; null when BOT_USER_NAME is not configured */
export const thinkingMiniAppDeepLink = (token: string): string | null =>
    miniAppDirectLink(encodeStartParam({ kind: 'thinking', token }));

/** The token of one of our own fast-page URLs (absolute or relative); null for anything else */
export const thinkingTokenOfUrl = (url: string): string | null => {
    const lastSegment = url.split('/').at(-1) ?? '';
    return isShareToken(lastSegment) ? lastSegment : null;
};
