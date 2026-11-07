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

/** A whole reply: every round added up */
export interface ReplyUsageTotals extends RoundUsage {
    /** Rounds reported, with or without usage */
    readonly rounds: number;
    /** The lane that served the reply (Gemini); null elsewhere */
    readonly route: string | null;
}

/**
 * Collects one reply's usage while it streams. The platform reports every
 * round as soon as it finishes, so a stop, an error or a failing later round
 * keeps what the finished rounds already cost.
 */
export interface UsageSink {
    /** One finished round; null when it carried no usage */
    addRound(usage: RoundUsage | null): void;
    /** The lane the platform routed the reply to */
    setRoute(route: string | null): void;
    totals(): ReplyUsageTotals;
}
