/**
 * The dashboard's "last 7 days" line (design §6.1): replies, error rate,
 * first-chunk p50 and the estimated cost with its priced share. Null when the
 * chat had no reply in the window: the dashboard then has nothing to show.
 */
import { aggregateUsageByModelRoute, findReplyMetricsInWindow, type MetricWindow } from '../../db/queries/reply-metrics.js';
import { ratioOf, roundRatio, roundUsd } from '../views/stats-view.js';
import { priceUsageGroup, totalCost } from './cost-estimate.js';
import { firstChunkMsOf, presentValues } from './metric-samples.js';
import { summarizeSamples } from './percentile.js';

export const CHAT_SUMMARY_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ChatSummaryView {
    readonly days: number;
    readonly replies: number;
    readonly errorReplies: number;
    /** 0..1 */
    readonly errorRate: number | null;
    /** firstChunkAt - requestStartedAt, ms */
    readonly firstChunkP50Ms: number | null;
    /** USD at list price; null when nothing in the window is priced */
    readonly costUsd: number | null;
    /** 0..1: replies the cost covers */
    readonly pricedReplyRatio: number | null;
}

export const buildChatSummary = async (chatId: number, now: Date): Promise<ChatSummaryView | null> => {
    const window: MetricWindow = { since: new Date(now.getTime() - CHAT_SUMMARY_DAYS * DAY_MS), chatId };
    const [rows, groups] = await Promise.all([findReplyMetricsInWindow(window), aggregateUsageByModelRoute(window)]);
    if (rows.length === 0) return null;

    const errorReplies = rows.filter((row) => row.outcome === 'error').length;
    const cost = totalCost(groups.map(priceUsageGroup));
    return {
        days: CHAT_SUMMARY_DAYS,
        replies: rows.length,
        errorReplies,
        errorRate: ratioOf(errorReplies, rows.length),
        firstChunkP50Ms: summarizeSamples(presentValues(rows, firstChunkMsOf)).p50,
        costUsd: roundUsd(cost.costUsd),
        pricedReplyRatio: roundRatio(cost.pricedReplyRatio),
    };
};
