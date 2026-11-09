/**
 * Web login configuration (design §9).
 *
 * Read per call rather than frozen at import: offline cases set the env after
 * loading modules, and the bot command and the panel must agree on one answer.
 */
import { miniAppPanelLink, webappPublicUrl } from '../panel/share/share-urls.js';

/** WEB_LOGIN is not 0: `/web` and the browser login exist */
export const webLoginEnabled = (): boolean => process.env.WEB_LOGIN !== '0';

/** The public panel origin without a trailing slash; '' when not configured */
export const webLoginPublicUrl = (): string => webappPublicUrl();

/**
 * Secure cookies need https. Local http debugging (http://localhost) keeps the
 * cookie working by dropping the flag; production is always https.
 */
export const webLoginSecureCookies = (): boolean => webLoginPublicUrl().startsWith('https://');

/** `https://t.me/<bot>/<panel>`: the Mini App as the login page's fallback entry */
export const webLoginMiniAppLink = (): string | null => miniAppPanelLink();

/** `https://t.me/<bot>`: where the login page sends someone to get a code */
export const webLoginBotChatLink = (): string | null => {
    const botUserName = (process.env.BOT_USER_NAME ?? '').trim();
    return botUserName === '' ? null : `https://t.me/${botUserName}`;
};
