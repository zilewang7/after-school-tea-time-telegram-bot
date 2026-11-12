/**
 * The `[gemini-usage]` log lines: one per request (per round in a tool loop),
 * plus one summary per tool loop turn.
 *
 * Token accounting. cached > 0 is the only proof that the prompt stayed
 * byte-identical long enough for an upstream prefix cache to hit, and
 * thoughts is billed as output — so each line carries both numbers the cache
 * work is judged by. `via` names the upstream channel: without it a
 * zero-cache request cannot be told apart from one that was routed somewhere
 * its prefix was never cached.
 *
 * Chunk cadence (`chunks`, `maxGap`): ttfb only covers the wait before the
 * first chunk, so a stream that goes quiet halfway through used to be invisible
 * in the logs. maxGap is the longest silence between two chunks of the round
 * and where it ended; a long one on a search round is the search running.
 *
 * `tier` is the tier Vertex served (Priority PayGo downgrades silently, so
 * only the response knows). An attempt whose stream broke and was retried
 * gets a `[gemini-usage-failed]` line instead, so the `[gemini-usage]` lines
 * still count the finished rounds.
 */
import type { GenerateContentResponse, GenerateContentResponseUsageMetadata } from '@google/genai';

/**
 * The relay reports which upstream channel served the request on a response
 * header. That is the only way to tell "the prompt broke the cache" apart from
 * "this request landed on a channel whose prefix cache was cold".
 */
export const headerOf = (
    chunk: GenerateContentResponse | null | undefined,
    name: string
): string | null => chunk?.sdkHttpResponse?.headers?.[name] ?? null;

export interface GeminiRequestUsage {
    /** Routed channel header, else the lane the platform picked, else '-' */
    readonly via: string;
    readonly fallbackAttempts: string | null;
    readonly usage: GenerateContentResponseUsageMetadata | undefined;
    readonly groundingCount: number;
    readonly groundingSources: number;
    // Measured from before the request is sent. The SDK resolves the await only
    // after the stream is open and the first chunk is buffered, so any timestamp
    // taken inside the consume loop reports ~0 and hides the real first-token wait.
    readonly requestStartedAt: number;
    readonly streamOpenedAt: number;
    readonly firstPartAt: number | null;
    readonly firstThinkAt: number | null;
    readonly firstTextAt: number | null;
    readonly finishedAt: number;
    /** Chunks the stream delivered for this request, empty ones included */
    readonly chunkCount: number;
    /** Longest silence between two chunks of this request (0 when it had <2) */
    readonly maxChunkGapMs: number;
    /** Offset from request start at which that silence ended, null when none */
    readonly maxChunkGapAtMs: number | null;
}

/** Which tool loop round a request was, and how many function calls it made */
export interface GeminiRoundLabel {
    readonly roundNumber: number;
    readonly callCount: number;
}

/** An attempt whose stream broke: which round, why, and which attempt of the round */
export interface GeminiFailedAttemptLabel {
    readonly roundNumber: number;
    readonly kind: string;
    readonly attempt: number;
}

/**
 * The tier Vertex actually served (`trafficType` of the last chunk, e.g.
 * ON_DEMAND or ON_DEMAND_PRIORITY); '-' when the response did not say
 */
const tierOf = (usage: GenerateContentResponseUsageMetadata | undefined): string => usage?.trafficType ?? '-';

/** Everything after the label fields: tokens, tier, grounding and timings */
const usageFields = (request: GeminiRequestUsage): string => {
    const { usage } = request;
    const sinceStart = (at: number | null) =>
        at === null ? '-' : String(at - request.requestStartedAt);
    return (
        `via=${request.via} fallback=${request.fallbackAttempts ?? '-'} ` +
        `prompt=${usage?.promptTokenCount ?? '?'} cached=${usage?.cachedContentTokenCount ?? 0} ` +
        `thoughts=${usage?.thoughtsTokenCount ?? 0} output=${usage?.candidatesTokenCount ?? 0} ` +
        `total=${usage?.totalTokenCount ?? '?'} tier=${tierOf(usage)} ` +
        `grounding=${request.groundingCount} sources=${request.groundingSources} ` +
        `chunks=${request.chunkCount} ` +
        `maxGap=${request.maxChunkGapMs}ms@${request.maxChunkGapAtMs === null ? '-' : `+${request.maxChunkGapAtMs}ms`} ` +
        `ttfb=${request.streamOpenedAt - request.requestStartedAt}ms ` +
        `firstPart=${sinceStart(request.firstPartAt)}ms firstThink=${sinceStart(request.firstThinkAt)}ms ` +
        `firstText=${sinceStart(request.firstTextAt)}ms dur=${request.finishedAt - request.requestStartedAt}ms`
    );
};

/**
 * Printed even when usage is missing: whether a request searched at all, and
 * how many sources it brought back, is the signal a missing GoogleSearch block
 * has to be judged by.
 */
export const formatGeminiUsageLine = (
    model: string,
    request: GeminiRequestUsage,
    round?: GeminiRoundLabel
): string => {
    const roundFields = round ? `round=${round.roundNumber} calls=${round.callCount} ` : '';
    return `[gemini-usage] model=${model} ${roundFields}${usageFields(request)}`;
};

/**
 * An attempt whose stream broke, with what its last chunk reported. A prefix
 * of its own keeps the `[gemini-usage]` lines one per finished round.
 */
export const formatGeminiFailedUsageLine = (
    model: string,
    request: GeminiRequestUsage,
    label: GeminiFailedAttemptLabel
): string =>
    `[gemini-usage-failed] model=${model} round=${label.roundNumber} kind=${label.kind} attempt=${label.attempt} ` +
    usageFields(request);

/** Rounds per served tier, e.g. ON_DEMAND:2,ON_DEMAND_PRIORITY:1 */
const tierCounts = (usages: readonly (GenerateContentResponseUsageMetadata | undefined)[]): string => {
    const counts = new Map<string, number>();
    for (const usage of usages) {
        const tier = tierOf(usage);
        counts.set(tier, (counts.get(tier) ?? 0) + 1);
    }
    return counts.size === 0 ? '-' : Array.from(counts, ([tier, count]) => `${tier}:${count}`).join(',');
};

const sumOf = (
    usages: readonly (GenerateContentResponseUsageMetadata | undefined)[],
    count: (usage: GenerateContentResponseUsageMetadata) => number | undefined
): number => usages.reduce((total, usage) => total + (usage ? count(usage) ?? 0 : 0), 0);

/**
 * The whole tool loop turn: rounds, executed calls and the tokens of every
 * round added up (each round resends the whole context, so prompt is what
 * the turn was billed for), and how many rounds each tier served. Marked
 * `summary` so it is never read as one more request.
 */
export const formatGeminiTurnSummary = (
    model: string,
    rounds: readonly GeminiRequestUsage[],
    executedCallCount: number,
    turnStartedAt: number,
    /** A resume: the rounds kept from the interrupted version; rounds and calls count only the new ones */
    resumedAfterRounds?: number
): string => {
    const usages = rounds.map((round) => round.usage);
    return (
        `[gemini-usage] model=${model} summary rounds=${rounds.length} calls=${executedCallCount} ` +
        `prompt=${sumOf(usages, (usage) => usage.promptTokenCount)} ` +
        `cached=${sumOf(usages, (usage) => usage.cachedContentTokenCount)} ` +
        `thoughts=${sumOf(usages, (usage) => usage.thoughtsTokenCount)} ` +
        `output=${sumOf(usages, (usage) => usage.candidatesTokenCount)} ` +
        `total=${sumOf(usages, (usage) => usage.totalTokenCount)} ` +
        `tiers=${tierCounts(usages)} ` +
        `dur=${Date.now() - turnStartedAt}ms` +
        (resumedAfterRounds === undefined ? '' : ` resumed=${resumedAfterRounds}`)
    );
};
