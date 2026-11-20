/**
 * reply_metrics: one row per reply attempt, written once at finalize and read
 * by the panel (statistics, reply detail, the dashboard summary). Rows are
 * never updated and never cleaned.
 */
import { QueryTypes } from '@sequelize/core';
import type { CapabilityEvent } from '../../shared/capability-event.js';
import { isJsonObject } from '../../shared/json-object.js';
import { sequelize } from '../config.js';
import { ReplyMetric } from '../replyMetricDTO.js';
import {
    parseImageGenerationUsage,
    parseReplyMetricRow,
    serializeCapabilityEvents,
    serializeImageGenerationUsage,
    serializeToolUsage,
    storedDateOf,
    type ReplyMetricInput,
    type ReplyMetricRecord,
} from './reply-metric-rows.js';

export {
    REPLY_ACCESS_TIERS,
    REPLY_OUTCOMES,
    REQUESTED_TIERS,
    type CapabilityEvent,
    type ImageGenerationUsage,
    type ReplyAccessTier,
    type ReplyMetricInput,
    type ReplyMetricRecord,
    type ReplyOutcome,
    type RequestedTier,
    type ToolUsageEntry,
} from './reply-metric-rows.js';

/** Rows started at or after `since`; one chat, or every chat when chatId is null */
export interface MetricWindow {
    readonly since: Date;
    /**
     * Exclusive upper bound, for the slices of a price-segmented estimate: a
     * price window is priced from the rows that started inside it. undefined =
     * everything from `since` on (the existing callers).
     */
    readonly until?: Date;
    readonly chatId: number | null;
    /**
     * Only these bot replies (first message ids): one conversation tree's
     * statistics. undefined = every reply of the scope.
     */
    readonly firstMessageIds?: readonly number[];
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
    /** Rounds served at the priority tier, over every row of the group */
    readonly priorityRounds: number;
    /** The priority-tier part of the token sums above, over the same rows (those with usage) */
    readonly priorityPromptTokens: number;
    readonly priorityCachedTokens: number;
    readonly priorityOutputTokens: number;
}

export const insertReplyMetric = async (input: ReplyMetricInput): Promise<void> => {
    await ReplyMetric.create({
        ...input,
        accessTier: input.accessTier ?? null,
        toolUsage: serializeToolUsage(input.toolUsage),
        imageGenerationUsage: serializeImageGenerationUsage(input.imageGenerationUsage ?? []),
        catalogVersion: input.catalogVersion ?? null,
        capabilityEvents: serializeCapabilityEvents(input.capabilityEvents ?? []),
    });
};

const parseRows = (rows: readonly unknown[]): ReplyMetricRecord[] =>
    rows.flatMap((row) => {
        const record = parseReplyMetricRow(row);
        return record === null ? [] : [record];
    });

/** The window's WHERE clause; the chat form keeps to the (chatId, startedAt) index */
const windowCondition = (window: MetricWindow): string => {
    const bounds = window.until === undefined ? 'startedAt >= :since' : 'startedAt >= :since AND startedAt < :until';
    const scope = window.chatId === null ? bounds : `chatId = :chatId AND ${bounds}`;
    if (window.firstMessageIds === undefined) return scope;
    // Raw replacements do not expand arrays on sqlite; json_each turns the id list into rows
    return `${scope} AND firstMessageId IN (SELECT value FROM json_each(:firstMessageIdsJson))`;
};

const windowReplacements = (window: MetricWindow): Record<string, unknown> => ({
    since: window.since,
    ...(window.until === undefined ? {} : { until: window.until }),
    chatId: window.chatId,
    ...(window.firstMessageIds === undefined
        ? {}
        : { firstMessageIdsJson: JSON.stringify(window.firstMessageIds) }),
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

/**
 * The attempts one user was charged for as a trial user, oldest first: the
 * trial quota's data. Only rows with accessTier = 'trial' count, so nothing
 * spent before the quota existed (or while the user was full) is in it.
 */
export const findTrialReplyMetricsByUser = async (userId: number): Promise<ReplyMetricRecord[]> => {
    const rows: unknown[] = await sequelize.query(
        `SELECT * FROM reply_metrics
         WHERE triggerUserId = :userId AND accessTier = 'trial'
         ORDER BY startedAt, id`,
        { replacements: { userId }, type: QueryTypes.SELECT }
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
        priorityRounds: field('priorityRounds'),
        priorityPromptTokens: field('priorityPromptTokens'),
        priorityCachedTokens: field('priorityCachedTokens'),
        priorityOutputTokens: field('priorityOutputTokens'),
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
                SUM(CASE WHEN NOT hasUsage AND imageCount > 0 THEN 1 ELSE 0 END)   AS imageRowsWithoutUsage,
                COALESCE(SUM(priorityRounds), 0)                                   AS priorityRounds,
                COALESCE(SUM(CASE WHEN hasUsage THEN priorityPromptTokens END), 0) AS priorityPromptTokens,
                COALESCE(SUM(CASE WHEN hasUsage THEN priorityCachedTokens END), 0) AS priorityCachedTokens,
                COALESCE(SUM(CASE WHEN hasUsage THEN priorityOutputTokens END), 0) AS priorityOutputTokens
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
export const findEarliestReplyMetricStart = async (
    chatId: number | null,
    firstMessageIds?: readonly number[]
): Promise<Date | null> => {
    const conditions: string[] = [];
    const replacements: Record<string, unknown> = { chatId };
    if (chatId !== null) conditions.push('chatId = :chatId');
    if (firstMessageIds !== undefined) {
        conditions.push('firstMessageId IN (SELECT value FROM json_each(:firstMessageIdsJson))');
        replacements.firstMessageIdsJson = JSON.stringify(firstMessageIds);
    }
    const where = conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`;
    const rows: unknown[] = await sequelize.query(
        `SELECT MIN(startedAt) AS earliest FROM reply_metrics${where}`,
        { replacements, type: QueryTypes.SELECT }
    );
    const first = rows[0];
    return isJsonObject(first) ? storedDateOf(first.earliest) : null;
};

/**
 * Distinct model ids actively used since `since` (design 2026-1114-0510 §3.4):
 * includes both top-level `reply_metrics.model` and nested `imageGenerationUsage` models.
 */
export const listActiveModelIdsFromMetrics = async (since: Date): Promise<string[]> => {
    const [topRows, imageRows] = await Promise.all([
        sequelize.query(
            'SELECT DISTINCT model FROM reply_metrics WHERE startedAt >= :since',
            { replacements: { since }, type: QueryTypes.SELECT }
        ),
        sequelize.query(
            'SELECT DISTINCT imageGenerationUsage FROM reply_metrics WHERE startedAt >= :since AND imageGenerationUsage IS NOT NULL',
            { replacements: { since }, type: QueryTypes.SELECT }
        ),
    ]);
    const models = new Set<string>();
    for (const row of topRows) {
        if (isJsonObject(row) && typeof row.model === 'string' && row.model.trim() !== '') {
            models.add(row.model.trim());
        }
    }
    for (const row of imageRows) {
        if (!isJsonObject(row)) continue;
        for (const entry of parseImageGenerationUsage(row.imageGenerationUsage)) {
            if (entry.model.trim() !== '') models.add(entry.model.trim());
        }
    }
    return [...models].sort((first, second) => first.localeCompare(second));
};

/** One `reply_metrics` row that recorded runtime capability rejection/fallback events */
export interface ReplyMetricCapabilityEventRow {
    readonly id: number;
    readonly model: string;
    readonly platform: string;
    readonly route: string | null;
    readonly catalogVersion: string | null;
    readonly startedAt: Date;
    readonly thinkingEffortSent: string | null;
    readonly capabilityEvents: readonly CapabilityEvent[];
}

/** Recent `reply_metrics` rows carrying `capabilityEvents` for watch-run contradiction scanning */
export const listRecentCapabilityEventMetrics = async (since: Date): Promise<ReplyMetricCapabilityEventRow[]> => {
    const rows: unknown[] = await sequelize.query(
        `SELECT * FROM reply_metrics
         WHERE startedAt >= :since AND capabilityEvents IS NOT NULL
         ORDER BY startedAt ASC, id ASC`,
        { replacements: { since }, type: QueryTypes.SELECT }
    );
    const matched: ReplyMetricCapabilityEventRow[] = [];
    for (const row of rows) {
        const record = parseReplyMetricRow(row);
        if (record === null || record.capabilityEvents.length === 0) continue;
        matched.push({
            id: record.id,
            model: record.model,
            platform: record.platform,
            route: record.route,
            catalogVersion: record.catalogVersion,
            startedAt: record.startedAt,
            thinkingEffortSent: record.thinkingEffortSent,
            capabilityEvents: record.capabilityEvents,
        });
    }
    return matched;
};
