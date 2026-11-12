/**
 * When a failed attempt of a Gemini tool loop round is tried again, and how
 * long to wait first (design 2026-1112-1123 §5.2). Pure: every number lives
 * here, the jitter comes from an injected random function, and the counters
 * are values the caller threads through.
 *
 * Why these numbers: right after a 429, a new request still fails 50-60% of
 * the time for about three minutes, so the 429 waits reach past that. A
 * timeout is not given longer or more attempts: in production no request
 * opened after 180 s, and a third attempt after two timeouts never opened.
 * A stream that broke midway is redone at most once a round and twice a
 * reply, because a 500 can be caused by the input and come back every time.
 */
import { match } from 'ts-pattern';
import { classifyErrorKind } from '../../../shared/error-kind.js';
import { httpStatusOf } from './gemini-tool-request.js';

/** The failures worth another attempt */
export type RecoverableKind = 'timeout' | 'rate_limit' | 'upstream' | 'network';

/** Never tried again: a stop, a 4xx other than 408/429, anything unknown */
export type FinalKind = 'stopped' | 'client_error' | 'other';

export type RoundFailureKind = RecoverableKind | FinalKind;

/** open = the request never produced a stream; stream = it broke while streaming */
export type RoundFailurePhase = 'open' | 'stream';

/** Waits before the 2nd, 3rd... attempt after failures of one kind in one round */
export const RECOVERY_WAITS_MS: Readonly<Record<RecoverableKind, readonly number[]>> = {
    // 3 attempts: the immediate retry never helped, a minute later might
    timeout: [2_000, 60_000],
    // 4 attempts: the last one lands 4-10 minutes after the first failure
    rate_limit: [15_000, 45_000, 120_000],
    upstream: [5_000, 20_000],
    network: [2_000, 5_000],
};

/** Attempts of one round, all kinds together */
export const ROUND_ATTEMPTS_MAX = 5;
/** A broken stream is redone once per round... */
export const STREAM_RETRIES_PER_ROUND = 1;
/** ...and twice per reply */
export const STREAM_RETRIES_PER_REPLY = 2;
/** Failed opening attempts plus every wait, per reply */
export const REPLY_RECOVERY_BUDGET_MS = 12 * 60_000;
/** Failed attempts (opening and streaming) per reply */
export const REPLY_FAILED_ATTEMPTS_MAX = 12;
/** Every wait is moved by up to this fraction either way */
export const WAIT_JITTER = 0.2;

/** Counters that live as long as the reply (a "continue" starts them afresh) */
export interface ReplyRecoveryState {
    /** Time spent in failed opening attempts plus every wait */
    readonly spentMs: number;
    readonly failedAttempts: number;
    /** Broken streams that were redone */
    readonly streamRetries: number;
}

export const FRESH_REPLY_RECOVERY: ReplyRecoveryState = { spentMs: 0, failedAttempts: 0, streamRetries: 0 };

/** Counters of one round */
export interface RoundRecoveryState {
    /** Failures of every kind, opening and streaming alike */
    readonly failures: number;
    readonly failuresByKind: Readonly<Record<RecoverableKind, number>>;
    readonly streamFailures: number;
}

export const FRESH_ROUND_RECOVERY: RoundRecoveryState = {
    failures: 0,
    failuresByKind: { timeout: 0, rate_limit: 0, upstream: 0, network: 0 },
    streamFailures: 0,
};

export interface RecoveryCounters {
    readonly reply: ReplyRecoveryState;
    readonly round: RoundRecoveryState;
}

/** One failed attempt */
export interface RoundFailure {
    readonly phase: RoundFailurePhase;
    readonly error: unknown;
    /** The reply's stop signal had fired */
    readonly stopped: boolean;
    /** The attempt showed text that is not blank, or an image */
    readonly showedAnswer: boolean;
    /** How long the attempt ran; only a failed opening charges it to the budget */
    readonly elapsedMs: number;
}

export type GiveUpReason =
    | 'stopped'
    | 'not_retryable'
    | 'showed_answer'
    | 'stream_round_limit'
    | 'stream_reply_limit'
    | 'kind_limit'
    | 'round_limit'
    | 'attempt_limit'
    | 'budget';

export type RecoveryDecision =
    | {
          readonly action: 'retry';
          readonly kind: RecoverableKind;
          /** Jittered, whole milliseconds */
          readonly waitMs: number;
          readonly counters: RecoveryCounters;
      }
    | {
          readonly action: 'give_up';
          readonly kind: RoundFailureKind;
          readonly reason: GiveUpReason;
      };

/** The SDK's text for a stream cut inside a JSON chunk */
const TRUNCATED_STREAM = 'Incomplete JSON segment';

const isStop = (error: unknown): boolean =>
    error instanceof Error && (error.name === 'AbortError' || error.message === 'Aborted');

const asRecoverableKind = (kind: string): RecoverableKind | null =>
    match(kind)
        .returnType<RecoverableKind | null>()
        .with('timeout', 'rate_limit', 'upstream', 'network', (recoverable) => recoverable)
        .otherwise(() => null);

const isClientError = (status: number | undefined): boolean =>
    status !== undefined && status >= 400 && status < 500 && status !== 429;

/**
 * Classification order matters: the HTTP status decides before the error
 * text, because classifyErrorKind reads "quota" in a 400/403 body as a rate
 * limit. isRetryableError is not used: it calls a dropped connection
 * (TypeError: terminated, cause UND_ERR_SOCKET / UND_ERR_BODY_TIMEOUT) final.
 */
export const classifyRoundFailure = (error: unknown, stopped: boolean): RoundFailureKind => {
    if (stopped || isStop(error)) return 'stopped';
    return match(httpStatusOf(error))
        .returnType<RoundFailureKind>()
        .with(408, () => 'timeout')
        .when(isClientError, () => 'client_error')
        .otherwise(() => {
            const recoverable = asRecoverableKind(classifyErrorKind(error));
            if (recoverable !== null) return recoverable;
            const message = error instanceof Error ? error.message : String(error);
            return message.includes(TRUNCATED_STREAM) ? 'network' : 'other';
        });
};

export const isRecoverableKind = (kind: RoundFailureKind): kind is RecoverableKind =>
    asRecoverableKind(kind) !== null;

/** base ± WAIT_JITTER; random() in [0, 1), 0.5 leaves the wait as it is */
export const jitteredWaitMs = (baseMs: number, random: () => number): number =>
    Math.round(baseMs * (1 + WAIT_JITTER * (2 * random() - 1)));

/** The counters with this failure added (the wait is added once it is known) */
const countFailure = (
    counters: RecoveryCounters,
    failure: RoundFailure,
    kind: RecoverableKind
): RecoveryCounters => {
    const streamed = failure.phase === 'stream';
    return {
        reply: {
            // A broken stream was showing thinking all along: only its count is limited
            spentMs: counters.reply.spentMs + (streamed ? 0 : failure.elapsedMs),
            failedAttempts: counters.reply.failedAttempts + 1,
            streamRetries: counters.reply.streamRetries,
        },
        round: {
            failures: counters.round.failures + 1,
            failuresByKind: { ...counters.round.failuresByKind, [kind]: counters.round.failuresByKind[kind] + 1 },
            streamFailures: counters.round.streamFailures + (streamed ? 1 : 0),
        },
    };
};

/** The limit this failure hits, or null when another attempt is allowed */
const limitReached = (
    before: RecoveryCounters,
    after: RecoveryCounters,
    failure: RoundFailure,
    kind: RecoverableKind
): GiveUpReason | null => {
    if (failure.phase === 'stream') {
        if (before.round.streamFailures >= STREAM_RETRIES_PER_ROUND) return 'stream_round_limit';
        if (before.reply.streamRetries >= STREAM_RETRIES_PER_REPLY) return 'stream_reply_limit';
    }
    if (after.round.failuresByKind[kind] > RECOVERY_WAITS_MS[kind].length) return 'kind_limit';
    if (after.round.failures >= ROUND_ATTEMPTS_MAX) return 'round_limit';
    if (after.reply.failedAttempts >= REPLY_FAILED_ATTEMPTS_MAX) return 'attempt_limit';
    return null;
};

export const decideRecovery = (
    failure: RoundFailure,
    counters: RecoveryCounters,
    random: () => number
): RecoveryDecision => {
    const kind = classifyRoundFailure(failure.error, failure.stopped);
    if (!isRecoverableKind(kind)) {
        return { action: 'give_up', kind, reason: kind === 'stopped' ? 'stopped' : 'not_retryable' };
    }
    // What the user already read cannot be taken back, so it is not redone
    if (failure.phase === 'stream' && failure.showedAnswer) {
        return { action: 'give_up', kind, reason: 'showed_answer' };
    }

    const counted = countFailure(counters, failure, kind);
    const limit = limitReached(counters, counted, failure, kind);
    if (limit !== null) return { action: 'give_up', kind, reason: limit };

    // The n-th failure of a kind in this round waits the n-th step of its ladder
    const baseWaitMs = RECOVERY_WAITS_MS[kind][counted.round.failuresByKind[kind] - 1] ?? 0;
    const waitMs = jitteredWaitMs(baseWaitMs, random);
    if (counted.reply.spentMs + waitMs > REPLY_RECOVERY_BUDGET_MS) {
        return { action: 'give_up', kind, reason: 'budget' };
    }
    return {
        action: 'retry',
        kind,
        waitMs,
        counters: {
            round: counted.round,
            reply: {
                spentMs: counted.reply.spentMs + waitMs,
                failedAttempts: counted.reply.failedAttempts,
                streamRetries: counted.reply.streamRetries + (failure.phase === 'stream' ? 1 : 0),
            },
        },
    };
};
