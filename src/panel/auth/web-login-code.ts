/**
 * One-time web login codes (design §6.1).
 *
 * A `/web` command issues a short code, the browser login page posts it back,
 * and the server trades it for a session cookie. The codes live in this
 * process's memory: five minutes of validity does not justify a table, and a
 * restart simply invalidates every outstanding code.
 *
 * Entropy is 40 bits (8 Crockford Base32 characters), the code is single-use
 * and at most one code per user exists; the login route adds a per-IP attempt
 * limit, which together makes guessing infeasible.
 */
import { createHash, randomInt } from 'node:crypto';

/** Crockford Base32: digits plus letters minus I, L, O, U (no look-alikes) */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
/** One issue per user per cooldown… */
const ISSUE_COOLDOWN_MS = 30 * 1000;
/** …and at most this many inside the window */
const ISSUE_WINDOW_MS = 60 * 60 * 1000;
const ISSUE_WINDOW_LIMIT = 5;

export type IssueWebLoginCodeResult =
    | { readonly ok: true; readonly code: string; readonly expiresAt: Date }
    | { readonly ok: false; readonly reason: 'rate_limited'; readonly retryAfterSeconds: number };

export interface WebLoginCodeStore {
    /** A new code for this user; the previous unused code stops working */
    issue(userId: number): IssueWebLoginCodeResult;
    /** The user id the code belonged to, or null (unknown / expired / burnt / wrong) */
    redeem(rawCode: string): number | null;
    /** Drop whatever code this user has outstanding */
    revoke(userId: number): void;
    /** Drop expired codes and stale issue stamps (also runs lazily on issue/redeem) */
    sweep(): void;
    /** Outstanding codes, for tests */
    size(): number;
}

export interface WebLoginCodeStoreOptions {
    /** Clock in ms, replaceable by tests */
    now?: () => number;
    ttlMs?: number;
}

interface CodeEntry {
    userId: number;
    expiresAtMs: number;
}

/** Uppercase, drop spaces and dashes, then fold the characters Crockford treats as one */
export const normalizeWebLoginCode = (raw: string): string =>
    raw
        .toUpperCase()
        .replace(/[\s-]/g, '')
        .replace(/[IL]/g, '1')
        .replace(/O/g, '0');

/** Group the stored form for display: `K7QM-3XPT` */
export const formatWebLoginCode = (code: string): string =>
    code.length === CODE_LENGTH ? `${code.slice(0, 4)}-${code.slice(4)}` : code;

const hashOf = (code: string): string => createHash('sha256').update(code).digest('hex');

const generateCode = (): string => {
    let code = '';
    for (let index = 0; index < CODE_LENGTH; index += 1) {
        code += ALPHABET[randomInt(0, ALPHABET.length)];
    }
    return code;
};

export const createWebLoginCodeStore = (options: WebLoginCodeStoreOptions = {}): WebLoginCodeStore => {
    const now = options.now ?? Date.now;
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    /** sha256(code) → entry; the plaintext code is never kept after issue */
    const codes = new Map<string, CodeEntry>();
    /** userId → issue timestamps inside the window */
    const issueTimes = new Map<number, number[]>();

    const sweepCodes = (nowMs: number): void => {
        for (const [hash, entry] of codes) {
            if (entry.expiresAtMs <= nowMs) codes.delete(hash);
        }
        for (const [userId, times] of issueTimes) {
            const fresh = times.filter((issuedAt) => nowMs - issuedAt < ISSUE_WINDOW_MS);
            if (fresh.length === 0) issueTimes.delete(userId);
            else issueTimes.set(userId, fresh);
        }
    };

    const rateLimitOf = (userId: number, nowMs: number): number | null => {
        const times = issueTimes.get(userId) ?? [];
        const last = times.at(-1);
        if (last !== undefined && nowMs - last < ISSUE_COOLDOWN_MS) {
            return Math.max(1, Math.ceil((last + ISSUE_COOLDOWN_MS - nowMs) / 1000));
        }
        if (times.length >= ISSUE_WINDOW_LIMIT) {
            const oldest = times[0] ?? nowMs;
            return Math.max(1, Math.ceil((oldest + ISSUE_WINDOW_MS - nowMs) / 1000));
        }
        return null;
    };

    const revoke = (userId: number): void => {
        for (const [hash, entry] of codes) {
            if (entry.userId === userId) codes.delete(hash);
        }
    };

    return {
        issue: (userId) => {
            const nowMs = now();
            sweepCodes(nowMs);
            const rateLimitedFor = rateLimitOf(userId, nowMs);
            if (rateLimitedFor !== null) {
                return { ok: false, reason: 'rate_limited', retryAfterSeconds: rateLimitedFor };
            }
            revoke(userId);
            const code = generateCode();
            codes.set(hashOf(code), { userId, expiresAtMs: nowMs + ttlMs });
            issueTimes.set(userId, [...(issueTimes.get(userId) ?? []), nowMs]);
            return { ok: true, code, expiresAt: new Date(nowMs + ttlMs) };
        },
        redeem: (rawCode) => {
            const nowMs = now();
            sweepCodes(nowMs);
            const normalized = normalizeWebLoginCode(rawCode);
            if (normalized.length !== CODE_LENGTH) return null;
            const hash = hashOf(normalized);
            const entry = codes.get(hash);
            // Looking the code up by hash IS the verification: a wrong code has
            // no entry, a right one is spent here and cannot be replayed.
            if (entry === undefined) return null;
            codes.delete(hash);
            return entry.expiresAtMs <= nowMs ? null : entry.userId;
        },
        revoke,
        sweep: () => sweepCodes(now()),
        size: () => codes.size,
    };
};
