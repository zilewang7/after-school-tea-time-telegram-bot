/**
 * The share_links table: raw SQL, because the table has no sequelize model
 * (the migration is its only definition) and every query here is a handful of
 * columns. The panel's share service is the only caller.
 *
 * `previewImageBase64` never leaves the server except through `/og.png`; the
 * panel API's record omits it (design §5.6).
 */
import { QueryTypes } from '@sequelize/core';
import { sequelize } from '../../db/config.js';
import { isJsonRecord } from '../json.js';
import type { PreviewImage, PreviewSource, ShareKind, ShareRow, ShareSource } from './share-types.js';
import { generateShareToken } from './token.js';

/** How many tokens to try before giving up on the (astronomically unlikely) collision */
const TOKEN_ATTEMPTS = 3;

const stringOf = (value: unknown): string => (typeof value === 'string' ? value : '');
const nullableStringOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const nullableIntegerOf = (value: unknown): number | null => {
    if (value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
};

const integerOf = (value: unknown): number => nullableIntegerOf(value) ?? 0;

const kindOf = (value: unknown): ShareKind | null => (value === 'reply' || value === 'conversation' ? value : null);
const sourceOf = (value: unknown): ShareSource => (value === 'system' ? 'system' : 'user');
const previewSourceOf = (value: unknown): PreviewSource | null =>
    value === 'widget' || value === 'image' || value === 'text' || value === 'raw-widget' ? value : null;

/** A share_links row from a raw query result; null when the shape is not ours */
const parseRow = (raw: unknown): ShareRow | null => {
    if (!isJsonRecord(raw)) return null;
    const token = stringOf(raw.token);
    const kind = kindOf(raw.kind);
    const chatId = nullableIntegerOf(raw.chatId);
    if (token === '' || kind === null || chatId === null) return null;
    return {
        id: integerOf(raw.id),
        token,
        kind,
        chatId,
        firstMessageId: nullableIntegerOf(raw.firstMessageId),
        rootId: nullableIntegerOf(raw.rootId),
        versionId: nullableIntegerOf(raw.versionId),
        createdBy: integerOf(raw.createdBy),
        source: sourceOf(raw.source),
        createdAt: stringOf(raw.createdAt),
        revokedAt: nullableStringOf(raw.revokedAt),
        previewImageBase64: nullableStringOf(raw.previewImageBase64),
        previewWidth: nullableIntegerOf(raw.previewWidth),
        previewHeight: nullableIntegerOf(raw.previewHeight),
        previewSource: previewSourceOf(raw.previewSource),
        viewCount: integerOf(raw.viewCount),
        lastViewedAt: nullableStringOf(raw.lastViewedAt),
    };
};

const selectRows = async (sql: string, replacements: Record<string, unknown>): Promise<ShareRow[]> => {
    const rows: unknown[] = await sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
    return rows.flatMap((row) => {
        const parsed = parseRow(row);
        return parsed === null ? [] : [parsed];
    });
};

export const findShareRowByToken = async (token: string): Promise<ShareRow | null> => {
    const rows = await selectRows('SELECT * FROM share_links WHERE token = :token', { token });
    return rows[0] ?? null;
};

/** The one target a row names, for the reuse lookup */
export interface ShareTargetFilter {
    kind: ShareKind;
    chatId: number;
    firstMessageId: number | null;
    rootId: number | null;
    versionId: number | null;
}

/** The active (not revoked) link for a target; the newest one when several exist */
export const findActiveShareRow = async (filter: ShareTargetFilter): Promise<ShareRow | null> => {
    const rows = await selectRows(
        `SELECT * FROM share_links
          WHERE kind = :kind
            AND chatId = :chatId
            AND firstMessageId IS :firstMessageId
            AND rootId IS :rootId
            AND versionId IS :versionId
            AND revokedAt IS NULL
          ORDER BY id DESC
          LIMIT 1`,
        {
            kind: filter.kind,
            chatId: filter.chatId,
            firstMessageId: filter.firstMessageId,
            rootId: filter.rootId,
            versionId: filter.versionId,
        }
    );
    return rows[0] ?? null;
};

/** Every active link of one reply (one per version at most); newest first */
export const findActiveReplyShareRows = async (
    chatId: number,
    firstMessageId: number
): Promise<ShareRow[]> =>
    selectRows(
        `SELECT * FROM share_links
          WHERE kind = 'reply' AND chatId = :chatId AND firstMessageId = :firstMessageId AND revokedAt IS NULL
          ORDER BY id DESC`,
        { chatId, firstMessageId }
    );

export interface NewShareRow {
    kind: ShareKind;
    chatId: number;
    firstMessageId: number | null;
    rootId: number | null;
    versionId: number | null;
    createdBy: number;
    source: ShareSource;
    createdAt: string;
}

/** Insert one row, retrying with a fresh token if the unique index says no */
export const insertShareRow = async (input: NewShareRow): Promise<ShareRow> => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < TOKEN_ATTEMPTS; attempt += 1) {
        const token = generateShareToken();
        try {
            await sequelize.query(
                `INSERT INTO share_links
                    (token, kind, chatId, firstMessageId, rootId, versionId, createdBy, source, createdAt, viewCount)
                 VALUES (:token, :kind, :chatId, :firstMessageId, :rootId, :versionId, :createdBy, :source, :createdAt, 0)`,
                {
                    replacements: {
                        token,
                        kind: input.kind,
                        chatId: input.chatId,
                        firstMessageId: input.firstMessageId,
                        rootId: input.rootId,
                        versionId: input.versionId,
                        createdBy: input.createdBy,
                        source: input.source,
                        createdAt: input.createdAt,
                    },
                }
            );
            const row = await findShareRowByToken(token);
            if (row === null) throw new Error('share_links row vanished after insert');
            return row;
        } catch (error) {
            lastError = error;
            // A token collision is the only expected failure; anything else is a real error
            if ((await findShareRowByToken(token)) === null) throw error;
        }
    }
    throw lastError instanceof Error ? lastError : new Error('could not allocate a share token');
};

/** Revoke an active link; false when it was already revoked or is unknown */
export const markShareRevoked = async (token: string, revokedAt: string): Promise<boolean> => {
    await sequelize.query(
        `UPDATE share_links SET revokedAt = :revokedAt WHERE token = :token AND revokedAt IS NULL`,
        { replacements: { token, revokedAt } }
    );
    const row = await findShareRowByToken(token);
    return row !== null && row.revokedAt === revokedAt;
};

/** Store the rendered preview card of an active link */
export const updateSharePreview = async (token: string, preview: PreviewImage): Promise<void> => {
    await sequelize.query(
        `UPDATE share_links
            SET previewImageBase64 = :base64, previewWidth = :width, previewHeight = :height, previewSource = :source
          WHERE token = :token`,
        {
            replacements: {
                token,
                base64: preview.base64,
                width: preview.width,
                height: preview.height,
                source: preview.source,
            },
        }
    );
};

/**
 * Count one page view, at most once per `throttleMs` per link: the share page
 * is cached by Telegram and by browsers, so the count is an approximation.
 */
export const recordShareView = async (token: string, now: Date, throttleMs: number): Promise<void> => {
    const cutoff = new Date(now.getTime() - throttleMs).toISOString();
    await sequelize.query(
        `UPDATE share_links
            SET viewCount = viewCount + 1, lastViewedAt = :now
          WHERE token = :token AND (lastViewedAt IS NULL OR lastViewedAt <= :cutoff)`,
        { replacements: { token, now: now.toISOString(), cutoff } }
    );
};
