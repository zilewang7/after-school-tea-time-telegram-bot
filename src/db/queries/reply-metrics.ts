/**
 * reply_metrics: one row per reply attempt, written once at finalize and read
 * by the panel (statistics, reply detail, the dashboard summary). Rows are
 * never updated and never cleaned.
 */
import { QueryTypes } from '@sequelize/core';
import { isJsonObject } from '../../shared/json-object.js';
import { sequelize } from '../config.js';
import { ReplyMetric } from '../replyMetricDTO.js';
import {
    parseReplyMetricRow,
    serializeToolUsage,
    storedDateOf,
    type ReplyMetricInput,
    type ReplyMetricRecord,
} from './reply-metric-rows.js';

export {
    REPLY_OUTCOMES,
    type ReplyMetricInput,
    type ReplyMetricRecord,
    type ReplyOutcome,
    type ToolUsageEntry,
} from './reply-metric-rows.js';

/** Rows started at or after `since`; one chat, or every chat when chatId is null */
export interface MetricWindow {
    readonly since: Date;
    readonly chatId: number | null;
}

/**
 * One (model, route) group of a window with its token sums (design §6.5).
 * Token sums only count rows with usage (prompt and output both reported).
 */
export interface UsageGroupRow {
    readonly model: string;
    readonly route: string | null;
    readonly replies: number;
    readonly repliesWithUsage: number;
    readonly promptTokens: number;
    readonly cachedTokens: number;
    readonly cacheWriteTokens: number;
    readonly outputTokens: number;
    readonly thoughtsTokens: number;
    readonly imageOutputTokens: number;
    /** Output of image rows with usage but no IMAGE-modality split: priced as image output */
    readonly unsplitImageOutputTokens: number;
    /** Images of rows without usage: priced per image where the model has a per-image price */
    readonly imagesWithoutUsage: number;
    readonly imageRowsWithoutUsage: number;
}

export const insertReplyMetric = async (input: ReplyMetricInput): Promise<void> => {
    await ReplyMetric.create({ ...input, toolUsage: serializeToolUsage(input.toolUsage) });
};

const parseRows = (rows: readonly unknown[]): ReplyMetricRecord[] =>
    rows.flatMap((row) => {
        const record = parseReplyMetricRow(row);
        return record === null ? [] : [record];
    });

/** The window's WHERE clause; the chat form keeps to the (chatId, startedAt) index */
const windowCondition = (window: MetricWindow): string =>
    window.chatId === null ? 'startedAt >= :since' : 'chatId = :chatId AND startedAt >= :since';

const windowReplacements = (window: MetricWindow): Record<string, unknown> => ({
    since: window.since,
    chatId: window.chatId,
});

/** Every attempt of one reply, by version then insertion order */
export const findReplyMetricsByReply = async (chatId: number, firstMessageId: number): Promise<ReplyMetricRecord[]> => {
    const rows: unknown[] = await sequelize.query(
        `SELECT * FROM reply_metrics
         WHERE chatId = :chatId AND firstMessageId = :firstMessageId
         ORDER BY versionId, id`,
        { replacements: { chatId, firstMessageId }, type: QueryTypes.SELECT }
    );
    return parseRows(rows);
};

/** Every row of a window, oldest first */
export const findReplyMetricsInWindow = async (window: MetricWindow): Promise<ReplyMetricRecord[]> => {
    const rows: unknown[] = await sequelize.query(
        `SELECT * FROM reply_metrics WHERE ${windowCondition(window)} ORDER BY startedAt, id`,
        { replacements: windowReplacements(window), type: QueryTypes.SELECT }
    );
    return parseRows(rows);
};

const countOf = (value: unknown): number => {
    const count = Number(value ?? 0);
    return Number.isFinite(count) ? count : 0;
};

const toUsageGroupRow = (row: unknown): UsageGroupRow | null => {
    if (!isJsonObject(row) || typeof row.model !== 'string') return null;
    const field = (key: string): number => countOf(row[key]);
    return {
        model: row.model,
        route: typeof row.route === 'string' ? row.route : null,
        replies: field('replies'),
        repliesWithUsage: field('repliesWithUsage'),
        promptTokens: field('promptTokens'),
        cachedTokens: field('cachedTokens'),
        cacheWriteTokens: field('cacheWriteTokens'),
        outputTokens: field('outputTokens'),
        thoughtsTokens: field('thoughtsTokens'),
        imageOutputTokens: field('imageOutputTokens'),
        unsplitImageOutputTokens: field('unsplitImageOutputTokens'),
        imagesWithoutUsage: field('imagesWithoutUsage'),
        imageRowsWithoutUsage: field('imageRowsWithoutUsage'),
    };
};

/** Usage sums per (model, route), exactly the aggregation of design §6.5 */
export const aggregateUsageByModelRoute = async (window: MetricWindow): Promise<UsageGroupRow[]> => {
    const rows: unknown[] = await sequelize.query(
        `SELECT model, route,
                COUNT(*)                                                          AS replies,
                SUM(CASE WHEN hasUsage THEN 1 ELSE 0 END)                          AS repliesWithUsage,
                COALESCE(SUM(CASE WHEN hasUsage THEN promptTokens END), 0)         AS promptTokens,
                COALESCE(SUM(CASE WHEN hasUsage THEN cachedTokens END), 0)         AS cachedTokens,
                COALESCE(SUM(CASE WHEN hasUsage THEN cacheWriteTokens END), 0)     AS cacheWriteTokens,
                COALESCE(SUM(CASE WHEN hasUsage THEN outputTokens END), 0)         AS outputTokens,
                COALESCE(SUM(CASE WHEN hasUsage THEN thoughtsTokens END), 0)       AS thoughtsTokens,
                COALESCE(SUM(CASE WHEN hasUsage THEN imageOutputTokens END), 0)    AS imageOutputTokens,
                COALESCE(SUM(CASE WHEN hasUsage AND imageOutputTokens IS NULL AND imageCount > 0
                                  THEN outputTokens END), 0)                       AS unsplitImageOutputTokens,
                SUM(CASE WHEN NOT hasUsage THEN imageCount ELSE 0 END)             AS imagesWithoutUsage,
                SUM(CASE WHEN NOT hasUsage AND imageCount > 0 THEN 1 ELSE 0 END)   AS imageRowsWithoutUsage
         FROM (SELECT *, (promptTokens IS NOT NULL AND outputTokens IS NOT NULL) AS hasUsage
               FROM reply_metrics
               WHERE ${windowCondition(window)})
         GROUP BY model, route`,
        { replacements: windowReplacements(window), type: QueryTypes.SELECT }
    );
    return rows.flatMap((row) => {
        const group = toUsageGroupRow(row);
        return group === null ? [] : [group];
    });
};

/** When the first row of a chat (or of every chat) started; null without rows */
export const findEarliestReplyMetricStart = async (chatId: number | null): Promise<Date | null> => {
    const rows: unknown[] = await sequelize.query(
        `SELECT MIN(startedAt) AS earliest FROM reply_metrics${chatId === null ? '' : ' WHERE chatId = :chatId'}`,
        { replacements: { chatId }, type: QueryTypes.SELECT }
    );
    const first = rows[0];
    return isJsonObject(first) ? storedDateOf(first.earliest) : null;
};
