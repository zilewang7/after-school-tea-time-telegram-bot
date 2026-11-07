/**
 * Sign and verify Telegram Mini App initData with a bot token, for offline
 * cases and the panel e2e (which signs for the test bot on the spot; no real
 * client needed).
 *
 * Signing is implemented here on its own, so a round trip through the panel's
 * verifier checks two implementations against each other; verification is
 * the panel's own (src/panel/auth/init-data.ts).
 *
 * Like real initData, every signed payload carries a `signature` field (the
 * Ed25519 one for third parties). It is part of the first-party HMAC: drop it
 * and the hash no longer matches.
 */
import { createHmac } from 'node:crypto';
import {
    READ_MAX_AGE_SECONDS,
    WRITE_MAX_AGE_SECONDS,
    verifyInitData,
    type InitDataVerification,
} from '../../src/panel/auth/init-data.js';

export { READ_MAX_AGE_SECONDS, WRITE_MAX_AGE_SECONDS };

/** The `user` field as Telegram serializes it */
export interface InitDataUserInput {
    id: number;
    first_name: string;
    last_name?: string;
    username?: string;
    language_code?: string;
    is_premium?: boolean;
    allows_write_to_pm?: boolean;
}

export interface SignInitDataInput {
    botToken: string;
    user: InitDataUserInput;
    /** Unix seconds */
    authDate: number;
    /** `startapp` of a Direct Link: `c<chatId>` / `i<issueId>` */
    startParam?: string;
    queryId?: string;
    /** Defaults to a fixed placeholder; it is signed like any other field */
    signature?: string;
    /** Any further fields (chat_type, chat_instance, ...) */
    extra?: Readonly<Record<string, string>>;
}

/** Stands in for Telegram's Ed25519 signature: only its presence matters here */
export const PLACEHOLDER_SIGNATURE = 'offlineSignaturePlaceholder_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const compareKeys = (left: string, right: string): number => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
};

/** HMAC_SHA256(HMAC_SHA256("WebAppData", token), sorted `key=value` lines without `hash`) */
export const hashInitDataFields = (fields: URLSearchParams, botToken: string): string => {
    const dataCheckString = [...fields.entries()]
        .filter(([key]) => key !== 'hash')
        .sort(([leftKey], [rightKey]) => compareKeys(leftKey, rightKey))
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');
    const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
    return createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
};

/** A raw initData query string, as `Telegram.WebApp.initData` would hold it */
export const signInitData = (input: SignInitDataInput): string => {
    const fields = new URLSearchParams();
    if (input.queryId !== undefined) fields.set('query_id', input.queryId);
    fields.set('user', JSON.stringify(input.user));
    fields.set('auth_date', String(input.authDate));
    if (input.startParam !== undefined) fields.set('start_param', input.startParam);
    for (const [key, value] of Object.entries(input.extra ?? {})) fields.set(key, value);
    fields.set('signature', input.signature ?? PLACEHOLDER_SIGNATURE);
    fields.set('hash', hashInitDataFields(fields, input.botToken));
    return fields.toString();
};

/** Re-sign after editing fields: `edit` gets the fields without the old hash */
export const resignInitData = (raw: string, botToken: string, edit: (fields: URLSearchParams) => void): string => {
    const fields = new URLSearchParams(raw);
    fields.delete('hash');
    edit(fields);
    fields.set('hash', hashInitDataFields(fields, botToken));
    return fields.toString();
};

/** Edit fields but keep the old hash, as a tampering client would */
export const tamperInitData = (raw: string, edit: (fields: URLSearchParams) => void): string => {
    const fields = new URLSearchParams(raw);
    edit(fields);
    return fields.toString();
};

export const verify = (
    raw: string,
    botToken: string,
    options: { maxAgeSeconds?: number; nowSeconds?: number } = {}
): InitDataVerification =>
    verifyInitData(raw, botToken, {
        maxAgeSeconds: options.maxAgeSeconds ?? READ_MAX_AGE_SECONDS,
        ...(options.nowSeconds !== undefined ? { nowSeconds: options.nowSeconds } : {}),
    });

export const unixNow = (): number => Math.floor(Date.now() / 1000);
