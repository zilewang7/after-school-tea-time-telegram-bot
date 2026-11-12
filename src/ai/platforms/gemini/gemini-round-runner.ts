/**
 * One round of the Gemini tool loop, recovered in place (design 2026-1112-1123
 * §5.1): open an attempt, stream it, and when it fails ask the recovery
 * policy whether to wait and send the very same request again. The wait shows
 * as a status line; a stop ends it at once.
 *
 * What a failed attempt collected (parts, function calls, grounding) is
 * dropped with it, so its calls never run and never reach the next request;
 * the request sent again is the same object, so it goes out byte for byte as
 * before and the implicit cache still hits. Failed attempts never reach
 * usageSink.addRound. Round 1 may first fall back once on a 400
 * (gemini-first-round-fallback.ts), and the fallback request is then retried
 * like any other.
 *
 * Holds no loop state: it gets one round's request and the reply's recovery
 * counters, and returns the round, the request that streamed through, and
 * the counters after it.
 */
import type { StreamChunk } from '../../types.js';
import type { RoundTextSeparator } from '../../tools/round-text-separator.js';
import type { UsageSink } from '../../usage/usage-types.js';
import { firstRoundFallbackFor } from './gemini-first-round-fallback.js';
import {
    clearedStatus,
    formatGiveUpLine,
    formatNoFinishLine,
    formatRetryLine,
    retriedThinkingMarker,
    retryingStatus,
    waitingStatus,
} from './gemini-recovery-messages.js';
import {
    classifyRoundFailure,
    decideRecovery,
    FRESH_ROUND_RECOVERY,
    type RecoveryCounters,
    type ReplyRecoveryState,
    type RoundFailure,
} from './gemini-recovery-policy.js';
import type { OpenedGeminiRound, OpenGeminiRound } from './gemini-round-open.js';
import { consumeGeminiRound, type BrokenGeminiRound, type CollectedGeminiRound } from './gemini-round-stream.js';
import type { ThoughtSummaryFilter } from './gemini-thought-summary.js';
import type { GeminiRoundRequest } from './gemini-tool-request.js';
import { formatGeminiFailedUsageLine } from './gemini-usage-log.js';

/** How the reply waits between attempts; the same for every round */
export interface RoundRecovery {
    /** Rejects with Error('Aborted') once the signal fires (BasePlatform.sleep) */
    readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    /** In [0, 1): the jitter of every wait */
    readonly random: () => number;
}

export interface RecoverableRoundOptions {
    readonly model: string;
    readonly roundNumber: number;
    readonly request: GeminiRoundRequest;
    /** Round 1 only: the one-shot 400 fallbacks */
    readonly allowFallback: boolean;
    readonly openRound: OpenGeminiRound;
    readonly separator: RoundTextSeparator;
    /** The reply's thought-summary filter; a failed attempt leaves nothing held in it */
    readonly thoughtSummary: ThoughtSummaryFilter;
    readonly viaLabel: string | undefined;
    /** The reply's stop signal */
    readonly signal: AbortSignal | undefined;
    /** Null: one attempt, a failure ends the reply (maxRetries === 1) */
    readonly recovery: RoundRecovery | null;
    /** The reply's recovery counters before this round */
    readonly recoveryState: ReplyRecoveryState;
    readonly usageSink: UsageSink | undefined;
    /**
     * A status line is on screen as the round begins (a resume's): it goes
     * once the stream opens, and is replaced or cleared like a retry status
     */
    readonly statusOnScreen?: boolean;
}

export interface RecoveredRound {
    readonly round: CollectedGeminiRound;
    /** What the attempt that streamed through sent (round 1: maybe a fallback) */
    readonly request: GeminiRoundRequest;
    /** The reply's recovery counters after this round */
    readonly recoveryState: ReplyRecoveryState;
}

/** An attempt's own signal: it follows the reply's stop and is aborted once the attempt failed */
interface AttemptSignal {
    readonly signal: AbortSignal;
    abort(): void;
    release(): void;
}

const followStop = (stop: AbortSignal | undefined): AttemptSignal => {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (stop?.aborted) abort();
    else stop?.addEventListener('abort', abort, { once: true });
    return { signal: controller.signal, abort, release: () => stop?.removeEventListener('abort', abort) };
};

type AttemptOutcome =
    | { readonly kind: 'complete'; readonly round: CollectedGeminiRound }
    | {
          readonly kind: 'failed';
          readonly failure: RoundFailure;
          /** Null when the attempt never opened */
          readonly broken: BrokenGeminiRound | null;
      };

interface AttemptOptions {
    readonly openRound: OpenGeminiRound;
    readonly request: GeminiRoundRequest;
    readonly signal: AbortSignal | undefined;
    readonly separator: RoundTextSeparator;
    readonly thoughtSummary: ThoughtSummaryFilter;
    readonly viaLabel: string | undefined;
    /** Yielded as soon as the stream is open */
    readonly onOpen: readonly StreamChunk[];
    /** Yielded right before the attempt's first visible chunk */
    readonly leadingChunk: StreamChunk | null;
}

/**
 * The marker before a retried round's thinking (§5.3). Once the filter has let
 * a summary out, it starts every later one with a blank line of its own, so
 * the marker leaves its trailing blank line out: one blank line follows it
 * either way.
 */
const retryMarkerFor = (roundNumber: number, thoughtSummary: ThoughtSummaryFilter): StreamChunk => {
    const marker = retriedThinkingMarker(roundNumber);
    if (!thoughtSummary.state().emitted) return marker;
    return { ...marker, content: (marker.content ?? '').replace(/\n\n$/, '') };
};

async function* runAttempt(options: AttemptOptions): AsyncGenerator<StreamChunk, AttemptOutcome, void> {
    const attemptSignal = followStop(options.signal);
    const startedAt = Date.now();
    const failureOf = (
        phase: RoundFailure['phase'],
        error: unknown,
        showedAnswer: boolean
    ): RoundFailure => ({
        phase,
        error,
        stopped: options.signal?.aborted === true,
        showedAnswer,
        elapsedMs: Date.now() - startedAt,
    });
    let completed = false;
    try {
        let opened: OpenedGeminiRound;
        try {
            opened = await options.openRound(options.request, attemptSignal.signal);
        } catch (error) {
            return { kind: 'failed', failure: failureOf('open', error, false), broken: null };
        }
        yield* options.onOpen;
        const consumed = yield* consumeGeminiRound(
            opened,
            options.separator,
            options.viaLabel,
            options.thoughtSummary,
            options.leadingChunk
        );
        if (consumed.kind === 'complete') {
            completed = true;
            return consumed;
        }
        return { kind: 'failed', failure: failureOf('stream', consumed.error, consumed.showedAnswer), broken: consumed };
    } finally {
        // The SDK leaves a broken stream's body open: without the abort the
        // old connection could stay up for minutes next to the retry. An
        // attempt the consumer walked away from is ended the same way.
        if (!completed) attemptSignal.abort();
        attemptSignal.release();
    }
}

export async function* runRecoverableRound(
    options: RecoverableRoundOptions
): AsyncGenerator<StreamChunk, RecoveredRound, void> {
    const { model, roundNumber, signal, recovery, usageSink } = options;
    let request = options.request;
    let fallbackAvailable = options.allowFallback;
    let counters: RecoveryCounters = { reply: options.recoveryState, round: FRESH_ROUND_RECOVERY };
    // A status line is on screen until the next attempt opens
    let statusShown = options.statusOnScreen === true;
    // A failed attempt showed thinking: the retry's thinking follows a marker
    let markerPending = false;

    for (let attempt = 1; ; attempt++) {
        if (signal?.aborted) throw new Error('Aborted');
        if (attempt > 1 && statusShown) yield retryingStatus(roundNumber, attempt);
        const outcome: AttemptOutcome = yield* runAttempt({
            openRound: options.openRound,
            request,
            signal,
            separator: options.separator,
            thoughtSummary: options.thoughtSummary,
            viaLabel: options.viaLabel,
            onOpen: statusShown ? [clearedStatus()] : [],
            leadingChunk: markerPending ? retryMarkerFor(roundNumber, options.thoughtSummary) : null,
        });
        if (outcome.kind === 'complete') {
            if (outcome.round.finishReason === undefined) {
                console.warn(formatNoFinishLine(roundNumber, attempt));
            }
            return { round: outcome.round, request, recoveryState: counters.reply };
        }

        const failure: RoundFailure = outcome.failure;
        const broken: BrokenGeminiRound | null = outcome.broken;
        if (broken !== null) {
            statusShown = false;
            markerPending = broken.showedThinking || (markerPending && !broken.leadingShown);
            const kind = classifyRoundFailure(failure.error, failure.stopped);
            if (kind !== 'stopped') {
                console.warn(formatGeminiFailedUsageLine(model, broken.usage, { roundNumber, kind, attempt }));
            }
        }

        if (failure.phase === 'open' && fallbackAvailable) {
            const fallbackRequest = firstRoundFallbackFor(request, failure.error, model);
            if (fallbackRequest !== null) {
                fallbackAvailable = false;
                request = fallbackRequest;
                continue;
            }
        }
        if (recovery === null) {
            // Only a resume's status line can be on screen here
            if (statusShown) yield clearedStatus();
            throw failure.error;
        }

        const decision = decideRecovery(failure, counters, recovery.random);
        const facts = { roundNumber, phase: failure.phase, kind: decision.kind, attempt };
        if (decision.action === 'give_up') {
            if (decision.reason !== 'stopped') {
                console.warn(formatGiveUpLine(facts, decision.reason, failure.error));
            }
            // The error line replaces the retry status, which must not linger
            if (statusShown) yield clearedStatus();
            // The last error as it was thrown: its kind and wording reach the user unchanged
            throw failure.error;
        }
        counters = decision.counters;
        console.warn(formatRetryLine(facts, decision.waitMs));
        usageSink?.addRecovery();
        yield waitingStatus(roundNumber, decision.kind, decision.waitMs, attempt + 1);
        statusShown = true;
        await recovery.sleep(decision.waitMs, signal);
    }
}
