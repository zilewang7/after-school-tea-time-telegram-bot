/**
 * GET /api/stats from reply_metrics: one query for the window's rows (the
 * samples every table and percentile is computed from in Node) and, for the
 * cost estimate, one usage aggregation per price segment of the window (design
 * §4.2, see price-segments.ts): a window that contains a price change is split
 * at the change instants, and each segment is priced at the price in force
 * when it started.
 */
import {
    findEarliestReplyMetricStart,
    findReplyMetricsInWindow,
    type MetricWindow,
    type ReplyMetricRecord,
} from '../../db/queries/reply-metrics.js';
import { listChats, type ChatRow } from '../../db/queries/panel-registry.js';
import { loadPriceTableMeta, type PriceTableMeta } from '../../services/model-price-service.js';
import { roundRatio, roundUsd, type ChatStatsRow, type CostGroupView, type PricingMeta, type StatsResponse } from '../views/stats-view.js';
import {
    mergePricedUsageGroups,
    rollupCostByModel,
    totalCost,
    type PricedUsageGroup,
} from './cost-estimate.js';
import { groupRowsBy } from './metric-samples.js';
import { pricedUsageGroupsInWindow } from './price-segments.js';
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
    /** The owner sees the pending price proposals count; everyone else gets 0 */
    readonly isOwner?: boolean;
    /** Only these bot replies (one conversation's); undefined = every reply of the scope */
    readonly firstMessageIds?: readonly number[];
}

/** The pricing block as this API shows it: the proposal count is the owner's */
const pricingOf = async (now: Date, isOwner: boolean): Promise<PricingMeta> => {
    const meta: PriceTableMeta = await loadPriceTableMeta(now);
    if (isOwner) return meta;
    return { ...meta, pendingProposals: 0 };
};

const toCostGroupView = ({ group, costUsd, pricing, priorityAtStandardPrice }: PricedUsageGroup): CostGroupView => ({
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
        priorityRounds: group.priorityRounds,
        priorityPromptTokens: group.priorityPromptTokens,
        priorityCachedTokens: group.priorityCachedTokens,
        priorityOutputTokens: group.priorityOutputTokens,
    },
    costUsd: roundUsd(costUsd),
    pricing,
    priorityAtStandardPrice,
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
    const earliest =
        request.range === 'all'
            ? await findEarliestReplyMetricStart(request.chatId, request.firstMessageIds)
            : null;
    const window = resolveStatsWindow(request.range, request.now, earliest);
    const metricWindow: MetricWindow = {
        since: window.since,
        chatId: request.chatId,
        ...(request.firstMessageIds === undefined ? {} : { firstMessageIds: request.firstMessageIds }),
    };
    const windowUntil = window.until;
    const rowWindow: MetricWindow = { ...metricWindow, until: windowUntil };
    const [rows, pricedGroups, chats, pricing] = await Promise.all([
        findReplyMetricsInWindow(rowWindow),
        pricedUsageGroupsInWindow(metricWindow, windowUntil),
        chatDirectoryFor(request.chatId),
        pricingOf(request.now, request.isOwner === true),
    ]);

    // One row per (model, route) whatever the price did inside the window
    const mergedPricedGroups = mergePricedUsageGroups(pricedGroups);
    const cost = totalCost(mergedPricedGroups);
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
        models: buildModelRows(rows, rollupCostByModel(mergedPricedGroups)),
        costGroups: mergedPricedGroups.map(toCostGroupView),
        cost: { costUsd: roundUsd(cost.costUsd), pricedReplyRatio: roundRatio(cost.pricedReplyRatio) },
        pricing,
        tools: buildToolRows(rows),
        errorKinds: buildErrorKindCounts(rows),
        chats: chats === null ? null : buildChatRows(rows, chats),
        series: buildSeries(rows, window, { chatTitles }),
        recentErrors: buildRecentErrors(rows, chatTitles),
    };
};
