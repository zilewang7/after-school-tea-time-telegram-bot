/**
 * GET /api/stats as the API returns it. Flat on purpose: `kpis` feeds the
 * cards, `models` the per-model table, `series` the bar / stacked charts
 * (every line has one value per bucket, zeros included).
 *
 * Units: durations in milliseconds, costs in USD, ratios in 0..1, times as
 * ISO strings (bucket labels local to `timeZone`). A null means "no data"
 * (no samples, no replies, no price), never zero. No response carries a user
 * id or display name; chat titles appear only in the all-chats view.
 */
import type { PriceSource, PriceTier } from '../../config/model-pricing.js';
import type { ReplyOutcome } from '../../db/queries/reply-metrics.js';
import type { ErrorKind } from '../../shared/error-kind.js';
import type { ModelPricingFlag, PricingFlag } from '../stats/cost-estimate.js';
import type { StatsBucket, StatsRangeKey } from '../stats/stats-window.js';

/**
 * Priority PayGo hits (design §8.4). The hit rate counts only replies that
 * asked for the priority tier: a chat with the switch off would otherwise
 * pull it down. Priority rounds of replies that never asked are kept apart
 * in `strayPriorityRounds` (billed at the priority price nobody chose).
 */
export interface PriorityHitCounts {
    /** Replies that asked for the priority tier (tierRequested = 'priority') */
    readonly priorityReplies: number;
    /** Their rounds, rounds without usage included: the hit rate's denominator */
    readonly priorityRequestedRounds: number;
    /** Their rounds Vertex served at the priority tier: the numerator */
    readonly priorityHitRounds: number;
    /** priorityHitRounds / priorityRequestedRounds; null when no round asked */
    readonly priorityHitRate: number | null;
    /** Priority rounds of replies that did not ask for it; never part of the hit rate */
    readonly strayPriorityRounds: number;
}

export interface StatsKpis extends PriorityHitCounts {
    // Volume
    readonly replies: number;
    readonly retries: number;
    readonly retryRatio: number | null;
    /** Distinct users who triggered a reply (a count only) */
    readonly triggerUsers: number;
    // Errors
    readonly errorReplies: number;
    readonly errorRate: number | null;
    // Speed: first chunk = firstChunkAt - requestStartedAt; duration = finishedAt - startedAt
    readonly firstChunkP50Ms: number | null;
    readonly firstChunkP95Ms: number | null;
    readonly durationP50Ms: number | null;
    readonly durationP95Ms: number | null;
    // Tools
    readonly toolCalls: number;
    readonly toolFailures: number;
    readonly toolFailureRate: number | null;
    readonly avgRounds: number | null;
    readonly avgToolCalls: number | null;
    // Tokens (rows that reported usage) and context size
    readonly repliesWithUsage: number;
    readonly promptTokens: number;
    readonly cachedTokens: number;
    readonly cacheWriteTokens: number;
    readonly outputTokens: number;
    readonly thoughtsTokens: number;
    readonly imageOutputTokens: number;
    readonly avgPromptTokens: number | null;
    readonly avgOutputTokens: number | null;
    /** cachedTokens / promptTokens */
    readonly cacheHitRate: number | null;
    readonly avgContextMessages: number | null;
    readonly avgContextImages: number | null;
    // Cost (estimate at list price, see costGroups)
    readonly costUsd: number | null;
    readonly pricedReplyRatio: number | null;
}

export type OutcomeCounts = Readonly<Record<ReplyOutcome, number>>;

/** One model across its routes */
export interface ModelStatsRow extends PriorityHitCounts {
    readonly model: string;
    readonly platform: string;
    readonly replies: number;
    readonly retries: number;
    readonly errorReplies: number;
    readonly errorRate: number | null;
    readonly stoppedReplies: number;
    readonly emptyReplies: number;
    readonly firstChunkP50Ms: number | null;
    readonly firstChunkP95Ms: number | null;
    readonly durationP50Ms: number | null;
    readonly durationP95Ms: number | null;
    /** Σ textChars / Σ (finishedAt - firstChunkAt) of replies that streamed text */
    readonly outputCharsPerSecond: number | null;
    readonly avgRounds: number | null;
    readonly toolCalls: number;
    readonly toolFailures: number;
    readonly repliesWithUsage: number;
    readonly promptTokens: number;
    readonly cachedTokens: number;
    readonly cacheWriteTokens: number;
    readonly outputTokens: number;
    readonly thoughtsTokens: number;
    readonly imageOutputTokens: number;
    readonly avgPromptTokens: number | null;
    readonly avgOutputTokens: number | null;
    readonly cacheHitRate: number | null;
    readonly costUsd: number | null;
    readonly pricing: ModelPricingFlag;
    /** Priority rounds priced at the standard price: the model has no priority price */
    readonly priorityAtStandardPrice: boolean;
}

/** The token sums one cost group is priced from */
export interface CostGroupUsage {
    readonly promptTokens: number;
    readonly cachedTokens: number;
    readonly cacheWriteTokens: number;
    readonly outputTokens: number;
    readonly thoughtsTokens: number;
    readonly imageOutputTokens: number;
    readonly unsplitImageOutputTokens: number;
    readonly imagesWithoutUsage: number;
    readonly imageRowsWithoutUsage: number;
    /** Rounds served at the priority tier, and the priority part of the token sums above */
    readonly priorityRounds: number;
    readonly priorityPromptTokens: number;
    readonly priorityCachedTokens: number;
    readonly priorityOutputTokens: number;
}

/** One (model, route) group, design §6.5 */
export interface CostGroupView {
    readonly model: string;
    readonly route: string | null;
    readonly replies: number;
    readonly repliesWithUsage: number;
    readonly usage: CostGroupUsage;
    readonly costUsd: number | null;
    readonly pricing: PricingFlag;
    /** Priority rounds priced at the standard price: the model has no priority price */
    readonly priorityAtStandardPrice: boolean;
}

export interface ToolStatsRow {
    readonly name: string;
    readonly calls: number;
    readonly failures: number;
    readonly failureRate: number | null;
    /** Replies that called the tool at least once */
    readonly replies: number;
}

export interface ErrorKindCount {
    readonly kind: ErrorKind;
    readonly count: number;
}

/** All-chats view only */
export interface ChatStatsRow {
    readonly chatId: number;
    readonly type: string | null;
    readonly title: string | null;
    readonly username: string | null;
    readonly replies: number;
    readonly errorReplies: number;
}

/** One stacked line: a value per bucket of `series.buckets` */
export interface SeriesLine {
    readonly key: string;
    /** Display name when the key is an id (chat lines) */
    readonly label: string | null;
    readonly values: readonly number[];
}

export interface StatsSeries {
    /** Local labels: `YYYY-MM-DD` (day) or `YYYY-MM-DD HH:00` (hour) */
    readonly buckets: readonly string[];
    readonly replies: readonly number[];
    readonly errors: readonly number[];
    /** Replies per model */
    readonly byModel: readonly SeriesLine[];
    /** Replies per chat; all-chats view only */
    readonly byChat: readonly SeriesLine[] | null;
    /** Errors per kind */
    readonly byErrorKind: readonly SeriesLine[];
}

export interface RecentErrorRow {
    /** When the failed attempt started */
    readonly at: string;
    readonly chatId: number;
    /** All-chats view only; null in a chat's own statistics */
    readonly chatTitle: string | null;
    readonly model: string;
    readonly errorKind: ErrorKind | null;
    readonly errorSummary: string | null;
    /** Opens the reply detail */
    readonly firstMessageId: number;
    readonly versionId: number;
}

/** One price origin, with the newest date its values were checked */
export interface PricingSourceMeta {
    readonly kind: PriceSource;
    readonly checkedOn: string;
}

/** A price window that starts (or ends) within the next 30 days */
export interface PricingNextChange {
    readonly model: string;
    readonly tier: PriceTier;
    /** ISO instant of the change */
    readonly at: string;
    /** One line, e.g. `标准价 2.00/0.10/10.00 → 4.00/0.20/20.00` */
    readonly summary: string;
}

/**
 * The price table behind the estimate (design §4.3): which table version the
 * numbers were priced with, when it was last checked, what changes next and
 * which models still have no price. `pendingProposals` is the owner's count;
 * everyone else sees 0.
 */
export interface PricingMeta {
    readonly version: string;
    /** The oldest checkedOn in the table; null for an empty table */
    readonly checkedOn: string | null;
    readonly sources: readonly PricingSourceMeta[];
    readonly nextChanges: readonly PricingNextChange[];
    /** Models seen in the last 30 days of replies that still have no price row */
    readonly unpricedModels: readonly string[];
    readonly pendingProposals: number;
}

export interface StatsResponse {
    /** null = every chat (owner only) */
    readonly chatId: number | null;
    readonly range: StatsRangeKey;
    readonly from: string;
    readonly to: string;
    readonly bucket: StatsBucket;
    readonly timeZone: string;
    readonly kpis: StatsKpis;
    readonly outcomes: OutcomeCounts;
    /** Most replies first */
    readonly models: readonly ModelStatsRow[];
    readonly costGroups: readonly CostGroupView[];
    readonly cost: { readonly costUsd: number | null; readonly pricedReplyRatio: number | null };
    /** The price table the estimate used (design §4.3) */
    readonly pricing: PricingMeta;
    /** Most calls first */
    readonly tools: readonly ToolStatsRow[];
    /** Most frequent first */
    readonly errorKinds: readonly ErrorKindCount[];
    readonly chats: readonly ChatStatsRow[] | null;
    readonly series: StatsSeries;
    /** Newest first, at most 20 */
    readonly recentErrors: readonly RecentErrorRow[];
}

/** 0..1 with four decimals; null when there is nothing to divide by */
export const ratioOf = (part: number, whole: number): number | null =>
    whole === 0 ? null : Math.round((part / whole) * 10_000) / 10_000;

/** A ratio computed elsewhere, rounded the same way */
export const roundRatio = (value: number | null): number | null =>
    value === null ? null : Math.round(value * 10_000) / 10_000;

/** Averages keep one decimal */
export const averageOf = (sum: number, count: number): number | null =>
    count === 0 ? null : Math.round((sum / count) * 10) / 10;

/** Dollars to the micro-dollar, without float noise */
export const roundUsd = (value: number | null): number | null =>
    value === null ? null : Math.round(value * 1_000_000) / 1_000_000;
