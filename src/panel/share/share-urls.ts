/**
 * Where share links point: the public panel URL for `/s/<token>`, and the
 * Telegram Mini App Direct Link used by the reply deep link (design §5.10).
 *
 * Both read the env per call rather than once: offline cases set them, and the
 * production values come from compose (WEBAPP_PUBLIC_URL, BOT_USER_NAME).
 */

/** BotFather short name of the Mini App when WEBAPP_BOT_SHORT_NAME is unset (as /panel) */
const DEFAULT_SHORT_NAME = 'panel';

/** The public panel origin without a trailing slash; '' when not configured */
export const webappPublicUrl = (): string => (process.env.WEBAPP_PUBLIC_URL ?? '').trim().replace(/\/+$/, '');

/** The public path of one share (always starts with /s/) */
export const sharePathOf = (token: string): string => `/s/${token}`;

/** The absolute public URL of one share */
export const shareUrlOf = (token: string): string => `${webappPublicUrl()}${sharePathOf(token)}`;

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

/** `t.me/<bot>/<panel>?startapp=r<chatId>_<firstMessageId>`; null without a bot username */
export const miniAppReplyLink = (chatId: number, firstMessageId: number): string | null =>
    miniAppDirectLink(`r${chatId}_${firstMessageId}`);

/** The same link for a chat (`startapp=c<chatId>`), used by conversation shares */
export const miniAppChatLink = (chatId: number): string | null => miniAppDirectLink(`c${chatId}`);
