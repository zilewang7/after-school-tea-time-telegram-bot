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
}

/** Which tool loop round a request was, and how many function calls it made */
export interface GeminiRoundLabel {
    readonly roundNumber: number;
    readonly callCount: number;
}

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
    const { usage } = request;
    const sinceStart = (at: number | null) =>
        at === null ? '-' : String(at - request.requestStartedAt);
    const roundFields = round ? `round=${round.roundNumber} calls=${round.callCount} ` : '';
    return (
        `[gemini-usage] model=${model} ${roundFields}via=${request.via} fallback=${request.fallbackAttempts ?? '-'} ` +
        `prompt=${usage?.promptTokenCount ?? '?'} cached=${usage?.cachedContentTokenCount ?? 0} ` +
        `thoughts=${usage?.thoughtsTokenCount ?? 0} output=${usage?.candidatesTokenCount ?? 0} ` +
        `total=${usage?.totalTokenCount ?? '?'} ` +
        `grounding=${request.groundingCount} sources=${request.groundingSources} ` +
        `ttfb=${request.streamOpenedAt - request.requestStartedAt}ms ` +
        `firstPart=${sinceStart(request.firstPartAt)}ms firstThink=${sinceStart(request.firstThinkAt)}ms ` +
        `firstText=${sinceStart(request.firstTextAt)}ms dur=${request.finishedAt - request.requestStartedAt}ms`
    );
};

const sumOf = (
    usages: readonly (GenerateContentResponseUsageMetadata | undefined)[],
    count: (usage: GenerateContentResponseUsageMetadata) => number | undefined
): number => usages.reduce((total, usage) => total + (usage ? count(usage) ?? 0 : 0), 0);

/**
 * The whole tool loop turn: rounds, executed calls and the tokens of every
 * round added up (each round resends the whole context, so prompt is what
 * the turn was billed for). Marked `summary` so it is never read as one more
 * request.
 */
export const formatGeminiTurnSummary = (
    model: string,
    rounds: readonly GeminiRequestUsage[],
    executedCallCount: number,
    turnStartedAt: number
): string => {
    const usages = rounds.map((round) => round.usage);
    return (
        `[gemini-usage] model=${model} summary rounds=${rounds.length} calls=${executedCallCount} ` +
        `prompt=${sumOf(usages, (usage) => usage.promptTokenCount)} ` +
        `cached=${sumOf(usages, (usage) => usage.cachedContentTokenCount)} ` +
        `thoughts=${sumOf(usages, (usage) => usage.thoughtsTokenCount)} ` +
        `output=${sumOf(usages, (usage) => usage.candidatesTokenCount)} ` +
        `total=${sumOf(usages, (usage) => usage.totalTokenCount)} ` +
        `dur=${Date.now() - turnStartedAt}ms`
    );
};
