/**
 * Token usage in the one shape every platform is normalized to (design
 * appendix B). A null field means the platform did not say; zero means it
 * said zero.
 */

/** One finished model round */
export interface RoundUsage {
    /** All input, cache hits and cache writes included */
    readonly promptTokens: number | null;
    /** The cache-hit part of promptTokens */
    readonly cachedTokens: number | null;
    /** The cache-write part of promptTokens (Anthropic only) */
    readonly cacheWriteTokens: number | null;
    /** Billed output, reasoning included */
    readonly outputTokens: number | null;
    /** The reasoning part of outputTokens; null when the platform gives no split */
    readonly thoughtsTokens: number | null;
    /** The image-modality part of outputTokens; null when the platform gives no split */
    readonly imageOutputTokens: number | null;
}

/**
 * The tier a round was actually served at (Vertex `usageMetadata.trafficType`).
 * A priority request is silently downgraded when there is no capacity, so
 * this is what gets billed, not what was asked for.
 */
export type ServedTier = 'standard' | 'priority';

/** Facts about a finished round that are not counts to add up */
export interface RoundMeta {
    readonly servedTier?: ServedTier;
}

/** The part of a reply's usage that was served at the priority tier */
export interface PriorityUsageTotals {
    readonly rounds: number;
    readonly promptTokens: number;
    readonly cachedTokens: number;
    /** Reasoning included, as in RoundUsage */
    readonly outputTokens: number;
}

/** A whole reply: every round added up */
export interface ReplyUsageTotals extends RoundUsage {
    /** Rounds reported, with or without usage */
    readonly rounds: number;
    /** The lane that served the reply (Gemini); null elsewhere */
    readonly route: string | null;
    /** Failed round attempts that were retried automatically */
    readonly roundRetries: number;
    /** 'priority' when the Priority PayGo header went out with the requests; null otherwise */
    readonly tierRequested: 'priority' | null;
    /** What the rounds served at the priority tier add up to; null when none was */
    readonly priority: PriorityUsageTotals | null;
}

/**
 * Collects one reply's usage while it streams. The platform reports every
 * round as soon as it finishes, so a stop, an error or a failing later round
 * keeps what the finished rounds already cost.
 */
export interface UsageSink {
    /** One finished round; null when it carried no usage */
    addRound(usage: RoundUsage | null, meta?: RoundMeta): void;
    /** The lane the platform routed the reply to */
    setRoute(route: string | null): void;
    /** One failed round attempt is being retried automatically */
    addRecovery(): void;
    /** The platform attached the Priority PayGo request header */
    setTierRequested(tier: 'priority'): void;
    totals(): ReplyUsageTotals;
}
