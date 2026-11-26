/**
 * Public panel and Telegram Mini App entry URLs, read from the env on every
 * call.
 *
 * Lives in the shared layer (not panel/share) so any layer can build public
 * panel or Direct Link URLs without an upward import; offline cases set the
 * env after loading modules, and production injects it through compose.
 */

/** BotFather short name of the Mini App when WEBAPP_BOT_SHORT_NAME is unset */
export const DEFAULT_MINI_APP_SHORT_NAME = 'panel';

/** The panel's public origin without a trailing slash; '' when not configured */
export const webappPublicUrl = (): string => (process.env.WEBAPP_PUBLIC_URL ?? '').trim().replace(/\/+$/, '');

/** The Mini App's BotFather short name (defaults to `panel`) */
export const miniAppShortName = (): string =>
    (process.env.WEBAPP_BOT_SHORT_NAME ?? '').trim() || DEFAULT_MINI_APP_SHORT_NAME;

/** `t.me/<bot>/<panel>`: the panel's Mini App entry, no start_param; null without a bot username */
export const miniAppPanelLink = (): string | null => {
    const botUserName = (process.env.BOT_USER_NAME ?? '').trim();
    if (botUserName === '') return null;
    return `https://t.me/${botUserName}/${miniAppShortName()}`;
};

/** `t.me/<bot>/<panel>?startapp=<startParam>` (or plain panel link when omitted); null without a bot username */
export const miniAppDirectLink = (startParam?: string): string | null => {
    const base = miniAppPanelLink();
    if (base === null) return null;
    return startParam === undefined || startParam === '' ? base : `${base}?startapp=${startParam}`;
};
