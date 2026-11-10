/**
 * Short-lived signed URLs for chat media (design §6).
 *
 * A Mini App <img>/<video> cannot send initData headers, so the panel API hands
 * the page `/m/<payload>.<sig>`: an HMAC-signed reference to one chat message
 * (or one bot reply version). The signature is the only permission, hence the
 * short TTL; the payload names the resource, never a path or a URL.
 *
 * Key: derived from the share secret (`WEBAPP_SHARE_SECRET`, else BOT_TOKEN)
 * with its own domain separation, so a `/w/` token can never be replayed as a
 * `/m/` token.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { shareSecretOf } from './signed-widget.js';

/**
 * What the token names: a message row's media (`msg`), one version of a bot
 * reply (`ver`), or one cached link-preview item (`cache`).
 */
export type SignedMediaKind = 'msg' | 'ver' | 'cache';

export interface SignedMediaPayload {
    /** chatId */
    c: number;
    /** messageId (a bot reply's first message id for k='ver') */
    m: number;
    /** 1-based version id; only present for k='ver' */
    v?: number;
    /** MediaCache key of a link-preview item; only present for k='cache' */
    u?: string;
    k: SignedMediaKind;
    /** expiry, epoch seconds */
    e: number;
}

export interface SignedMediaTarget {
    chatId: number;
    messageId: number;
    versionId?: number;
    /** Cache key of one link-preview attachment (kind 'cache') */
    mediaKey?: string;
    kind: SignedMediaKind;
}

export interface SignedMediaSigner {
    /** The relative `/m/…` path and its ISO expiry */
    sign(target: SignedMediaTarget): { path: string; expiresAt: string };
    /** The payload behind a token, or null when the signature/expiry is wrong */
    verify(token: string): SignedMediaPayload | null;
}

/** One hour: a page can stay open and still load lazy media below the fold */
export const SIGNED_MEDIA_TTL_SECONDS = 3600;

/** Domain separation for the key derived from the share secret */
const SECRET_CONTEXT = 'k-on-bot-media-url';

const mediaSecretOf = (botToken: string, configuredSecret: string | undefined): Buffer =>
    createHmac('sha256', shareSecretOf(botToken, configuredSecret)).update(SECRET_CONTEXT).digest();

const isPayload = (value: unknown): value is SignedMediaPayload => {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Record<string, unknown>;
    return (
        Number.isSafeInteger(candidate.c)
        && Number.isSafeInteger(candidate.m)
        && (candidate.v === undefined || Number.isSafeInteger(candidate.v))
        && (candidate.u === undefined || typeof candidate.u === 'string')
        && (candidate.k === 'msg' || candidate.k === 'ver' || candidate.k === 'cache')
        && Number.isSafeInteger(candidate.e)
    );
};

export interface MediaSignerOptions {
    botToken: string;
    /** Clock in ms (default Date.now) */
    now?: () => number;
    /** Overrides WEBAPP_SHARE_SECRET; tests use a fixed one */
    secret?: string;
}

export const createMediaSigner = (options: MediaSignerOptions): SignedMediaSigner => {
    const now = options.now ?? Date.now;
    const secret = mediaSecretOf(options.botToken, options.secret);

    const signatureOf = (encodedPayload: string): Buffer =>
        createHmac('sha256', secret).update(encodedPayload).digest();

    return {
        sign: (target) => {
            const expiresAtSeconds = Math.floor(now() / 1000) + SIGNED_MEDIA_TTL_SECONDS;
            const payload: SignedMediaPayload = {
                c: target.chatId,
                m: target.messageId,
                ...(target.versionId === undefined ? {} : { v: target.versionId }),
                ...(target.mediaKey === undefined ? {} : { u: target.mediaKey }),
                k: target.kind,
                e: expiresAtSeconds,
            };
            const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
            const signature = signatureOf(encodedPayload).toString('base64url');
            return {
                path: `/m/${encodedPayload}.${signature}`,
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
