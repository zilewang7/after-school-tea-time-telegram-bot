/**
 * Telegram Mini App initData verification (first-party HMAC).
 *
 * Algorithm (core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
 * drop `hash` only — `signature` (Bot API 8.0+) stays and is signed like any
 * other field —, sort the remaining `key=value` pairs by key in byte order,
 * join them with `\n`, and compare
 *   HMAC_SHA256(key = HMAC_SHA256(key = "WebAppData", data = botToken), data = dataCheckString)
 * with `hash` in constant time.
 *
 * initData is a bearer token: nothing here logs it, and callers must never
 * log it or put it into a URL. The rejection reason is for the server log
 * only; clients always get the same 401.
 *
 * Pure (node:crypto only), so scripts can sign and verify with it too.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isJsonRecord, optionalString, parseJson } from '../json.js';

/** Why a request's initData was refused (server log only) */
export type InitDataRejection = 'missing' | 'bad_hash' | 'expired' | 'future';

export interface InitDataUser {
    id: number;
    firstName: string;
    lastName: string | null;
    username: string | null;
}

export interface VerifiedInitData {
    user: InitDataUser;
    /** The signed `start_param` (from `startapp`); null when absent */
    startParam: string | null;
    /** Unix seconds */
    authDate: number;
}

export type InitDataVerification =
    | { ok: true; data: VerifiedInitData }
    | { ok: false; reason: InitDataRejection };

export interface VerifyInitDataOptions {
    /** Oldest accepted auth_date, as an age in seconds (reads 24h, writes 5 min) */
    maxAgeSeconds: number;
    /** Current time in Unix seconds; defaults to the clock */
    nowSeconds?: number;
}

/** Read requests accept initData up to a day old */
export const READ_MAX_AGE_SECONDS = 24 * 60 * 60;
/** Write requests need initData from the last five minutes */
export const WRITE_MAX_AGE_SECONDS = 5 * 60;
/** auth_date may run ahead of our clock by at most this much */
export const FUTURE_TOLERANCE_SECONDS = 300;

const HASH_PATTERN = /^[0-9a-f]{64}$/i;
const UNIX_SECONDS_PATTERN = /^\d{1,12}$/;

/** Byte-order comparison; never localeCompare (locale-dependent) */
const compareKeys = (left: string, right: string): number => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
};

/** Every field except `hash`, sorted by key, as `key=value` lines */
export const buildDataCheckString = (params: URLSearchParams): string =>
    [...params.entries()]
        .filter(([key]) => key !== 'hash')
        .sort(([leftKey], [rightKey]) => compareKeys(leftKey, rightKey))
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');

/** Lowercase hex HMAC of a data-check-string under the bot token */
export const computeInitDataHash = (dataCheckString: string, botToken: string): string => {
    const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
    return createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
};

const hashMatches = (receivedHex: string, expectedHex: string): boolean => {
    if (!HASH_PATTERN.test(receivedHex)) return false;
    const received = Buffer.from(receivedHex, 'hex');
    const expected = Buffer.from(expectedHex, 'hex');
    return received.length === expected.length && timingSafeEqual(received, expected);
};

const parseUser = (raw: string | null): InitDataUser | null => {
    if (raw === null) return null;
    const parsed = parseJson(raw);
    if (!isJsonRecord(parsed)) return null;
    const { id, first_name: firstName } = parsed;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return null;
    if (typeof firstName !== 'string') return null;
    return {
        id,
        firstName,
        lastName: optionalString(parsed.last_name),
        username: optionalString(parsed.username),
    };
};

/**
 * Verify raw initData (the query string from `Telegram.WebApp.initData`).
 * Checks, in order: present with a hash (`missing`), signature (`bad_hash`),
 * age (`expired`; an unparseable auth_date counts as expired, freshness cannot
 * be shown), not from the future (`future`), and a usable `user` (`missing`).
 */
export const verifyInitData = (
    raw: string | null | undefined,
    botToken: string,
    options: VerifyInitDataOptions
): InitDataVerification => {
    if (raw === null || raw === undefined || raw.length === 0) return { ok: false, reason: 'missing' };
    const params = new URLSearchParams(raw);
    const receivedHash = params.get('hash');
    if (receivedHash === null) return { ok: false, reason: 'missing' };
    // An empty token would accept anything signed with an empty key
    if (botToken.length === 0) return { ok: false, reason: 'bad_hash' };

    const expectedHash = computeInitDataHash(buildDataCheckString(params), botToken);
    if (!hashMatches(receivedHash, expectedHash)) return { ok: false, reason: 'bad_hash' };

    const rawAuthDate = params.get('auth_date');
    if (rawAuthDate === null || !UNIX_SECONDS_PATTERN.test(rawAuthDate)) return { ok: false, reason: 'expired' };
    const authDate = Number(rawAuthDate);
    const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (nowSeconds - authDate > options.maxAgeSeconds) return { ok: false, reason: 'expired' };
    if (authDate > nowSeconds + FUTURE_TOLERANCE_SECONDS) return { ok: false, reason: 'future' };

    const user = parseUser(params.get('user'));
    if (user === null) return { ok: false, reason: 'missing' };

    return { ok: true, data: { user, startParam: params.get('start_param'), authDate } };
};
