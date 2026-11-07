/**
 * The bot's clock as seen through the Date header of API responses.
 * auth_date is stamped by Telegram, whose clock is right; a device clock that
 * runs ahead would otherwise make fresh initData look expired, and one that
 * lags would hide real expiry until the server says 401.
 */

/** Device time minus server time; 0 until a response has been seen */
let clockSkewMs = 0;

/** Note the server time from a response's Date header (1s resolution, good enough for a 30s margin) */
export const recordServerDate = (dateHeader: string | null): void => {
    if (dateHeader === null) return;
    const serverMs = Date.parse(dateHeader);
    if (Number.isNaN(serverMs)) return;
    clockSkewMs = Date.now() - serverMs;
};

/** Now, on the server's clock */
export const serverNowMs = (): number => Date.now() - clockSkewMs;
