/**
 * GET /api/stats from reply_metrics: one query for the window's rows (the
 * samples every table and percentile is computed from in Node) and one for
 * the per-(model, route) usage sums the cost estimate prices.
 */
import {
    aggregateUsageByModelRoute,
    findEarliestReplyMetricStart,
    findReplyMetricsInWindow,
    type MetricWindow,
    type ReplyMetricRecord,
} from '../../db/queries/reply-metrics.js';
import { listChats, type ChatRow } from '../../db/queries/panel-registry.js';
import { roundRatio, roundUsd, type ChatStatsRow, type CostGroupView, type StatsResponse } from '../views/stats-view.js';
import { priceUsageGroup, rollupCostByModel, totalCost, type PricedUsageGroup } from './cost-estimate.js';
import { groupRowsBy } from './metric-samples.js';
import {
    buildErrorKindCounts,
    buildKpis,
    buildModelRows,
    buildRecentErrors,
    buildToolRows,
    countOutcomes,
} from './stats-aggregate.js';
import { buildSeries } from './stats-series.js';
import { resolveStatsWindow, type StatsRangeKey } from './stats-window.js';
import { STATS_TIME_ZONE } from './time-buckets.js';

export interface StatsRequest {
    /** null = every chat (the caller has checked the owner) */
    readonly chatId: number | null;
    readonly range: StatsRangeKey;
    readonly now: Date;
}

const toCostGroupView = ({ group, costUsd, pricing }: PricedUsageGroup): CostGroupView => ({
    model: group.model,
    route: group.route,
    replies: group.replies,
    repliesWithUsage: group.repliesWithUsage,
    usage: {
        promptTokens: group.promptTokens,
        cachedTokens: group.cachedTokens,
        cacheWriteTokens: group.cacheWriteTokens,
        outputTokens: group.outputTokens,
        thoughtsTokens: group.thoughtsTokens,
        imageOutputTokens: group.imageOutputTokens,
        unsplitImageOutputTokens: group.unsplitImageOutputTokens,
        imagesWithoutUsage: group.imagesWithoutUsage,
        imageRowsWithoutUsage: group.imageRowsWithoutUsage,
    },
    costUsd: roundUsd(costUsd),
    pricing,
});

/** Most replies first */
const buildChatRows = (rows: readonly ReplyMetricRecord[], chats: ReadonlyMap<number, ChatRow>): ChatStatsRow[] =>
    [...groupRowsBy(rows, (row) => row.chatId)]
        .map(([chatId, chatRows]) => {
            const chat = chats.get(chatId);
            return {
                chatId,
                type: chat?.type ?? null,
                title: chat?.title ?? null,
                username: chat?.username ?? null,
                replies: chatRows.length,
                errorReplies: chatRows.filter((row) => row.outcome === 'error').length,
            };
        })
        .sort((first, second) => second.replies - first.replies || first.chatId - second.chatId);

/** The chat registry by id, for the all-chats view only */
const chatDirectoryFor = async (chatId: number | null): Promise<Map<number, ChatRow> | null> =>
    chatId === null ? new Map((await listChats()).map((chat) => [chat.chatId, chat])) : null;

export const buildStats = async (request: StatsRequest): Promise<StatsResponse> => {
    const earliest = request.range === 'all' ? await findEarliestReplyMetricStart(request.chatId) : null;
    const window = resolveStatsWindow(request.range, request.now, earliest);
    const metricWindow: MetricWindow = { since: window.since, chatId: request.chatId };
    const [rows, groups, chats] = await Promise.all([
        findReplyMetricsInWindow(metricWindow),
        aggregateUsageByModelRoute(metricWindow),
        chatDirectoryFor(request.chatId),
    ]);

    const pricedGroups = groups.map(priceUsageGroup);
    const cost = totalCost(pricedGroups);
    const chatTitles = chats === null ? null : new Map([...chats].map(([chatId, chat]) => [chatId, chat.title]));

    return {
        chatId: request.chatId,
        range: window.range,
        from: window.seriesStart.toISOString(),
        to: window.until.toISOString(),
        bucket: window.bucket,
        timeZone: STATS_TIME_ZONE,
        kpis: buildKpis(rows, cost),
        outcomes: countOutcomes(rows),
        models: buildModelRows(rows, rollupCostByModel(pricedGroups)),
        costGroups: pricedGroups.map(toCostGroupView),
        cost: { costUsd: roundUsd(cost.costUsd), pricedReplyRatio: roundRatio(cost.pricedReplyRatio) },
        tools: buildToolRows(rows),
        errorKinds: buildErrorKindCounts(rows),
        chats: chats === null ? null : buildChatRows(rows, chats),
        series: buildSeries(rows, window, { chatTitles }),
        recentErrors: buildRecentErrors(rows, chatTitles),
    };
};
