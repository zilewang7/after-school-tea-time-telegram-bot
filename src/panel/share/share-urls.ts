/**
 * Where share links point: the public panel URL for `/s/<token>`, and the
 * Telegram Mini App Direct Link the share page's footer button uses
 * (`startapp=s<token>`, design §5.10). The bot's group link fallback keeps its
 * own pure builders (reply/widget-link-fallback.ts), so its cases need no env.
 *
 * The env is read per call rather than once: offline cases set it, and the
 * production values come from compose (WEBAPP_PUBLIC_URL, BOT_USER_NAME).
 */
import { webappPublicUrl } from '../../shared/public-url.js';
import { isShareToken } from './token.js';

export { webappPublicUrl };

/** BotFather short name of the Mini App when WEBAPP_BOT_SHORT_NAME is unset (as /panel) */
const DEFAULT_SHORT_NAME = 'panel';

/** The public path of one share (always starts with /s/) */
export const sharePathOf = (token: string): string => `/s/${token}`;

/** The absolute public URL of one share */
export const shareUrlOf = (token: string): string => `${webappPublicUrl()}${sharePathOf(token)}`;

/** The token of one of our own share URLs (absolute or relative); null for anything else */
export const shareTokenOfUrl = (url: string): string | null => {
    const lastSegment = url.split('/').at(-1) ?? '';
    return isShareToken(lastSegment) ? lastSegment : null;
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

const miniAppDirectLink = (startParam: string): string | null => {
    const botUserName = (process.env.BOT_USER_NAME ?? '').trim();
    if (botUserName === '') return null;
    const shortName = (process.env.WEBAPP_BOT_SHORT_NAME ?? '').trim() || DEFAULT_SHORT_NAME;
    return `https://t.me/${botUserName}/${shortName}?startapp=${startParam}`;
};

/** `t.me/<bot>/<panel>?startapp=s<token>`: the public share, in the Mini App; null without a bot username */
export const miniAppShareLink = (token: string): string | null => miniAppDirectLink(`s${token}`);

/** `t.me/<bot>/<panel>`: the panel's Mini App entry, no start_param; null without a bot username */
export const miniAppPanelLink = (): string | null => {
    const botUserName = (process.env.BOT_USER_NAME ?? '').trim();
    if (botUserName === '') return null;
    const shortName = (process.env.WEBAPP_BOT_SHORT_NAME ?? '').trim() || DEFAULT_SHORT_NAME;
    return `https://t.me/${botUserName}/${shortName}`;
};
