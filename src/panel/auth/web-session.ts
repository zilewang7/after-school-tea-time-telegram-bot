/**
 * Browser sessions for the panel's web login (design §6.2).
 *
 * The cookie carries 32 random bytes; the table keeps only their sha256, so a
 * database leak cannot be replayed as a session. Rows expire after
 * WEB_SESSION_TTL_MS; a sliding `lastSeenAt` is written at most once a minute
 * per session (a write on every request would hammer the shared SQLite file).
 *
 * Raw SQL like the share table: no sequelize model, so sync() never rebuilds it.
 */
import { createHash, randomBytes } from 'node:crypto';
import { QueryTypes } from '@sequelize/core';
import { sequelize } from '../../db/config.js';

/** Cookie name of the web session */
export const WEB_SESSION_COOKIE = 'kob_web';

/** How long a browser stays logged in (30 days, as approved in the design) */
export const WEB_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** lastSeenAt is refreshed at most this often per session */
const TOUCH_INTERVAL_MS = 60 * 1000;

export interface CreatedWebSession {
    /** Only handed to the client; never stored in plaintext */
    readonly token: string;
    readonly expiresAt: Date;
}

export interface ResolvedWebSession {
    readonly userId: number;
    readonly expiresAt: Date;
}

export interface WebSessionStore {
    create(userId: number, ttlMs?: number): Promise<CreatedWebSession>;
    resolve(token: string): Promise<ResolvedWebSession | null>;
    /** Refresh lastSeenAt (throttled); failures are logged, not thrown */
    touch(token: string): Promise<void>;
    /** Delete one session (logout) */
    remove(token: string): Promise<void>;
    /** Delete expired rows; returns how many were removed */
    sweep(): Promise<number>;
}

export interface WebSessionStoreOptions {
    /** Clock in ms, replaceable by tests */
    now?: () => number;
}

export const hashWebSessionToken = (token: string): string =>
    createHash('sha256').update(token).digest('hex');

interface SessionRow {
    userId: number;
    expiresAt: string;
}

const isSessionRow = (row: unknown): row is SessionRow =>
    typeof row === 'object'
    && row !== null
    && 'userId' in row
    && typeof row.userId === 'number'
    && 'expiresAt' in row
    && typeof row.expiresAt === 'string';

export const createSqlWebSessionStore = (options: WebSessionStoreOptions = {}): WebSessionStore => {
    const now = options.now ?? Date.now;
    /** tokenHash → last touch (ms): avoids a write attempt on every request */
    const touchedAt = new Map<string, number>();

    return {
        create: async (userId, ttlMs = WEB_SESSION_TTL_MS) => {
            const token = randomBytes(32).toString('base64url');
            const nowMs = now();
            const expiresAt = new Date(nowMs + ttlMs);
            const nowIso = new Date(nowMs).toISOString();
            await sequelize.query(
                `INSERT INTO panel_web_sessions (tokenHash, userId, createdAt, lastSeenAt, expiresAt)
                 VALUES (:tokenHash, :userId, :now, :now, :expiresAt)`,
                {
                    replacements: {
                        tokenHash: hashWebSessionToken(token),
                        userId,
                        now: nowIso,
                        expiresAt: expiresAt.toISOString(),
                    },
                }
            );
            return { token, expiresAt };
        },
        resolve: async (token) => {
            const rows: unknown[] = await sequelize.query(
                'SELECT userId, expiresAt FROM panel_web_sessions WHERE tokenHash = :tokenHash',
                { replacements: { tokenHash: hashWebSessionToken(token) }, type: QueryTypes.SELECT }
            );
            const row = rows.find(isSessionRow);
            if (row === undefined) return null;
            const expiresAt = new Date(row.expiresAt);
            if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now()) {
                await sequelize.query('DELETE FROM panel_web_sessions WHERE tokenHash = :tokenHash', {
                    replacements: { tokenHash: hashWebSessionToken(token) },
                });
                return null;
            }
            return { userId: row.userId, expiresAt };
        },
        touch: async (token) => {
            const nowMs = now();
            const tokenHash = hashWebSessionToken(token);
            const last = touchedAt.get(tokenHash);
            if (last !== undefined && nowMs - last < TOUCH_INTERVAL_MS) return;
            touchedAt.set(tokenHash, nowMs);
            try {
                await sequelize.query(
                    `UPDATE panel_web_sessions SET lastSeenAt = :now
                     WHERE tokenHash = :tokenHash AND lastSeenAt < :threshold`,
                    {
                        replacements: {
                            tokenHash,
                            now: new Date(nowMs).toISOString(),
                            threshold: new Date(nowMs - TOUCH_INTERVAL_MS).toISOString(),
                        },
                    }
                );
            } catch (error) {
                console.warn('[web-login] session touch failed:', error);
            }
        },
        remove: async (token) => {
            const tokenHash = hashWebSessionToken(token);
            touchedAt.delete(tokenHash);
            await sequelize.query('DELETE FROM panel_web_sessions WHERE tokenHash = :tokenHash', {
                replacements: { tokenHash },
            });
        },
        sweep: async () => {
            const nowIso = new Date(now()).toISOString();
            const counted: unknown[] = await sequelize.query(
                'SELECT COUNT(*) AS expired FROM panel_web_sessions WHERE expiresAt <= :now',
                { replacements: { now: nowIso }, type: QueryTypes.SELECT }
            );
            const first = counted[0];
            const expired =
                typeof first === 'object' && first !== null && 'expired' in first && typeof first.expired === 'number'
                    ? first.expired
                    : 0;
            if (expired === 0) return 0;
            await sequelize.query('DELETE FROM panel_web_sessions WHERE expiresAt <= :now', {
                replacements: { now: nowIso },
            });
            return expired;
        },
    };
};
