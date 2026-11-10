/**
 * The `thinking_links` table (design §5.1): raw SQL only, like share_links — the
 * migration is its single definition, so `sequelize.sync()` never rebuilds it.
 *
 * One row per reply version; a version that activates the link mode again (a
 * re-render of the same version) reuses its row and therefore its token.
 */
import { QueryTypes } from '@sequelize/core';
import { sequelize } from '../../db/config.js';
import { isJsonRecord } from '../json.js';
import { generateShareToken } from '../share/token.js';
import type { BeginThinkingLinkInput, ThinkingAttemptInput, ThinkingLinkRow } from './thinking-types.js';

/** How many tokens to try before giving up on the (astronomically unlikely) collision */
const TOKEN_ATTEMPTS = 3;

const nullableStringOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const nullableIntegerOf = (value: unknown): number | null => {
    if (value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
};

const isoStringOf = (value: unknown): string | null => {
    if (typeof value === 'string') return value;
    if (value instanceof Date) return value.toISOString();
    return null;
};

/** A thinking_links row from a raw query result; null when the shape is not ours */
const parseRow = (raw: unknown): ThinkingLinkRow | null => {
    if (!isJsonRecord(raw)) return null;
    const token = nullableStringOf(raw.token);
    const chatId = nullableIntegerOf(raw.chatId);
    const firstMessageId = nullableIntegerOf(raw.firstMessageId);
    const versionId = nullableIntegerOf(raw.versionId);
    const createdAt = isoStringOf(raw.createdAt);
    if (token === null || token === '' || chatId === null || firstMessageId === null) return null;
    if (versionId === null || createdAt === null) return null;
    return { token, chatId, firstMessageId, versionId, model: nullableStringOf(raw.model), createdAt };
};

const selectRows = async (sql: string, replacements: Record<string, unknown>): Promise<ThinkingLinkRow[]> => {
    const rows: unknown[] = await sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
    return rows.flatMap((row) => {
        const parsed = parseRow(row);
        return parsed === null ? [] : [parsed];
    });
};

export const findThinkingLinkByToken = async (token: string): Promise<ThinkingLinkRow | null> => {
    const rows = await selectRows('SELECT * FROM thinking_links WHERE token = :token', { token });
    return rows[0] ?? null;
};

/** The row of one reply version; one at most thanks to the unique target index */
export const findThinkingLink = async (input: ThinkingAttemptInput): Promise<ThinkingLinkRow | null> => {
    const rows = await selectRows(
        `SELECT * FROM thinking_links
          WHERE chatId = :chatId AND firstMessageId = :firstMessageId AND versionId = :versionId
          LIMIT 1`,
        { chatId: input.chatId, firstMessageId: input.firstMessageId, versionId: input.versionId }
    );
    return rows[0] ?? null;
};

/**
 * Insert the row of one version, retrying with a fresh token on a token
 * collision. A unique-target violation means a concurrent call created the row
 * first: that row is returned instead (one token per version, design §5.1).
 */
export const insertThinkingLink = async (
    input: BeginThinkingLinkInput,
    createdAt: string
): Promise<ThinkingLinkRow> => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < TOKEN_ATTEMPTS; attempt += 1) {
        const token = generateShareToken();
        try {
            await sequelize.query(
                `INSERT INTO thinking_links (token, chatId, firstMessageId, versionId, model, createdAt)
                 VALUES (:token, :chatId, :firstMessageId, :versionId, :model, :createdAt)`,
                {
                    replacements: {
                        token,
                        chatId: input.chatId,
                        firstMessageId: input.firstMessageId,
                        versionId: input.versionId,
                        model: input.model,
                        createdAt,
                    },
                }
            );
            const row = await findThinkingLinkByToken(token);
            if (row === null) throw new Error('thinking_links row vanished after insert');
            return row;
        } catch (error) {
            lastError = error;
            const existing = await findThinkingLink(input);
            if (existing !== null) return existing;
        }
    }
    throw lastError instanceof Error ? lastError : new Error('could not allocate a thinking link token');
};
