/**
 * The public tool-log pages table (design 2026-1119-1835 §13.2): raw SQL only,
 * like search_links and thinking_links — the migration is its single
 * definition, so `sequelize.sync()` never rebuilds it.
 *
 * One row per reply version, keyed by the signed token of that version; the
 * version's stored `toolLogLinkToken` is the same string, so a replay never
 * needs to look the row up. A version that re-renders (refresh, version switch
 * target) finds its row already there and keeps the page generated the first
 * time: the crawler already has that card, and a page never changes after it
 * was generated.
 */
import { QueryTypes } from '@sequelize/core';
import { sequelize } from '../../db/config.js';
import { isJsonObject } from '../../shared/json-object.js';
import type { ToolLogPageTarget } from '../../shared/tool-log-page.js';
import type { ToolLogPageRow } from './tool-log-types.js';

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

/** A tool_log_pages row from a raw query result; null when the shape is not ours */
const parseRow = (raw: unknown): ToolLogPageRow | null => {
    if (!isJsonObject(raw)) return null;
    const token = nullableStringOf(raw.token);
    const chatId = nullableIntegerOf(raw.chatId);
    const firstMessageId = nullableIntegerOf(raw.firstMessageId);
    const versionId = nullableIntegerOf(raw.versionId);
    const createdAt = isoStringOf(raw.createdAt);
    const html = nullableStringOf(raw.html);
    if (token === null || token === '' || chatId === null || firstMessageId === null) return null;
    if (versionId === null || createdAt === null || html === null) return null;
    return { token, chatId, firstMessageId, versionId, model: nullableStringOf(raw.model), createdAt, html };
};

const rowsOf = (raw: unknown[]): ToolLogPageRow[] =>
    raw.flatMap((row) => {
        const parsed = parseRow(row);
        return parsed === null ? [] : [parsed];
    });

export const findToolLogPageByToken = async (token: string): Promise<ToolLogPageRow | null> => {
    const rows: unknown[] = await sequelize.query('SELECT * FROM tool_log_pages WHERE token = :token', {
        replacements: { token },
        type: QueryTypes.SELECT,
    });
    return rowsOf(rows)[0] ?? null;
};

/** The page already generated for one version; null when the version never folded */
export const findToolLogPage = async (target: ToolLogPageTarget): Promise<ToolLogPageRow | null> => {
    const rows: unknown[] = await sequelize.query(
        `SELECT * FROM tool_log_pages
          WHERE chatId = :chatId AND firstMessageId = :firstMessageId AND versionId = :versionId
          LIMIT 1`,
        {
            replacements: {
                chatId: target.chatId,
                firstMessageId: target.firstMessageId,
                versionId: target.versionId,
            },
            type: QueryTypes.SELECT,
        }
    );
    return rowsOf(rows)[0] ?? null;
};

/**
 * Store the generated page of one version. The token is derived from the
 * version, so the row's primary key and the target index agree; a unique-target
 * violation means a concurrent call stored the page first, and that page is
 * returned instead (one page per version, never rewritten).
 */
export const insertToolLogPage = async (row: ToolLogPageRow): Promise<ToolLogPageRow> => {
    try {
        await sequelize.query(
            `INSERT INTO tool_log_pages
                 (token, chatId, firstMessageId, versionId, model, createdAt, html)
             VALUES
                 (:token, :chatId, :firstMessageId, :versionId, :model, :createdAt, :html)`,
            { replacements: { ...row } }
        );
        const stored = await findToolLogPageByToken(row.token);
        if (stored === null) throw new Error('tool_log_pages row vanished after insert');
        return stored;
    } catch (error) {
        const existing = await findToolLogPage(row);
        if (existing !== null) return existing;
        throw error instanceof Error ? error : new Error('could not store the tool-log page');
    }
};
