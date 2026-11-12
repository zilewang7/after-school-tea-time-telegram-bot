/**
 * Table-driven cases for the recovery policy of the Gemini tool loop
 * (design 2026-1112-1123 §5.2): the classification order, the ladder of each
 * kind, the per-round and per-reply limits, the reply's 12-minute budget and
 * the jitter. Pure functions only; the random function is pinned.
 *
 * Run: npx tsx scripts/offline/gemini-recovery-policy.mts
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';

const policy = await import('../../src/ai/platforms/gemini/gemini-recovery-policy.js');
const { AppError } = await import('../../src/shared/errors.js');
const {
    classifyRoundFailure,
    decideRecovery,
    FRESH_REPLY_RECOVERY,
    FRESH_ROUND_RECOVERY,
    jitteredWaitMs,
    REPLY_RECOVERY_BUDGET_MS,
} = policy;

type RoundFailure = import('../../src/ai/platforms/gemini/gemini-recovery-policy.js').RoundFailure;
type RecoveryCounters = import('../../src/ai/platforms/gemini/gemini-recovery-policy.js').RecoveryCounters;
type RecoveryDecision = import('../../src/ai/platforms/gemini/gemini-recovery-policy.js').RecoveryDecision;

const json = (value: unknown): string => JSON.stringify(value);

/** 0.5 leaves every wait at its base value */
const noJitter = (): number => 0.5;

const statusError = (status: number, message = `status ${status}`): Error => Object.assign(new Error(message), { status });

const disconnect = (code: string): Error => {
    const cause = Object.assign(new Error('other side closed'), { code });
    return new TypeError('terminated', { cause });
};

const abortError = (): Error => {
    const error = new Error('This operation was aborted');
    error.name = 'AbortError';
    return error;
};

const rateLimit = (): Error => statusError(429, 'got status: RESOURCE_EXHAUSTED. Resource exhausted.');
const serverError = (): Error => statusError(503, 'got status: UNAVAILABLE. The model is overloaded.');
const timeout = (): Error => new Error('Timeout');
const network = (): Error => disconnect('UND_ERR_SOCKET');

const openFailure = (error: unknown, elapsedMs = 0): RoundFailure => ({
    phase: 'open',
    error,
    stopped: false,
    showedAnswer: false,
    elapsedMs,
});

const streamFailure = (error: unknown, elapsedMs = 0, showedAnswer = false): RoundFailure => ({
    phase: 'stream',
    error,
    stopped: false,
    showedAnswer,
    elapsedMs,
});

const FRESH: RecoveryCounters = { reply: FRESH_REPLY_RECOVERY, round: FRESH_ROUND_RECOVERY };

/** A new round in the same reply: the reply counters stay, the round ones restart */
const nextRound = (counters: RecoveryCounters): RecoveryCounters => ({ reply: counters.reply, round: FRESH_ROUND_RECOVERY });

interface Step {
    readonly decision: RecoveryDecision;
    readonly counters: RecoveryCounters;
}

/** Feeds failures one by one while the policy keeps retrying */
const runFailures = (
    failures: readonly RoundFailure[],
    start: RecoveryCounters = FRESH,
    random: () => number = noJitter
): Step[] => {
    const steps: Step[] = [];
    let counters = start;
    for (const failure of failures) {
        const decision = decideRecovery(failure, counters, random);
        if (decision.action === 'retry') counters = decision.counters;
        steps.push({ decision, counters });
        if (decision.action === 'give_up') break;
    }
    return steps;
};

const describeStep = (step: Step): string =>
    step.decision.action === 'retry'
        ? `retry:${step.decision.kind}:${step.decision.waitMs}`
        : `give_up:${step.decision.kind}:${step.decision.reason}`;

const describeSteps = (steps: readonly Step[]): string => json(steps.map(describeStep));

const cases: Array<{ name: string; body: () => Promise<void> }> = [
    {
        name: 'classification order: stop, 4xx before the error text, 408, the recoverable kinds, a cut stream, the rest',
        body: async () => {
            const table: Array<[string, unknown, boolean, string]> = [
                ['the stop signal fired', rateLimit(), true, 'stopped'],
                ['an AbortError', abortError(), false, 'stopped'],
                ["base-platform's Aborted", new Error('Aborted'), false, 'stopped'],
                ['400', statusError(400), false, 'client_error'],
                ['401', statusError(401), false, 'client_error'],
                ['403', statusError(403), false, 'client_error'],
                ['404', statusError(404), false, 'client_error'],
                ['499', statusError(499), false, 'client_error'],
                ['a 400 whose body says quota', statusError(400, 'Quota exceeded for this project'), false, 'client_error'],
                ['a 403 whose body says RESOURCE_EXHAUSTED', statusError(403, 'RESOURCE_EXHAUSTED quota'), false, 'client_error'],
                ['408', statusError(408), false, 'timeout'],
                ['429', rateLimit(), false, 'rate_limit'],
                ['500', statusError(500, 'got status: INTERNAL.'), false, 'upstream'],
                ['503', serverError(), false, 'upstream'],
                ["base-platform's own attempt timeout", timeout(), false, 'timeout'],
                ['a dropped socket (UND_ERR_SOCKET)', network(), false, 'network'],
                ['a body timeout (UND_ERR_BODY_TIMEOUT)', disconnect('UND_ERR_BODY_TIMEOUT'), false, 'timeout'],
                ['a stream cut inside a JSON chunk', new Error('Incomplete JSON segment at the end'), false, 'network'],
                ['a content filter', new AppError('blocked', 'CONTENT_FILTER'), false, 'other'],
                ['a content policy text', new Error('Response blocked by the content policy'), false, 'other'],
                ['something unknown', new Error('boom'), false, 'other'],
                ['a thrown string', 'boom', false, 'other'],
            ];
            for (const [label, error, stopped, expected] of table) {
                const kind = classifyRoundFailure(error, stopped);
                expect(kind === expected, `${label} → ${expected} (got ${kind})`);
            }
        },
    },
    {
        name: 'final kinds give up on the first failure, and a stream that showed text is never redone',
        body: async () => {
            for (const [label, failure, reason] of [
                ['a stop', { ...openFailure(rateLimit()), stopped: true }, 'stopped'],
                ['a 400', openFailure(statusError(400)), 'not_retryable'],
                ['a 400 mid-stream', streamFailure(statusError(400)), 'not_retryable'],
                ['an unknown error', openFailure(new Error('boom')), 'not_retryable'],
                ['a mid-stream 429 after visible text', streamFailure(rateLimit(), 1_000, true), 'showed_answer'],
            ] as const) {
                const decision = decideRecovery(failure, FRESH, noJitter);
                expect(
                    decision.action === 'give_up' && decision.reason === reason,
                    `${label}: gives up with ${reason} (got ${json(decision)})`
                );
            }
        },
    },
    {
        name: 'each kind: its waits, then giving up after its attempts',
        body: async () => {
            const ladders: Array<[string, () => unknown, string]> = [
                ['timeout: 3 attempts, 2 s and 60 s', timeout, '["retry:timeout:2000","retry:timeout:60000","give_up:timeout:kind_limit"]'],
                [
                    '429: 4 attempts, 15 s, 45 s and 120 s',
                    rateLimit,
                    '["retry:rate_limit:15000","retry:rate_limit:45000","retry:rate_limit:120000","give_up:rate_limit:kind_limit"]',
                ],
                ['5xx: 3 attempts, 5 s and 20 s', serverError, '["retry:upstream:5000","retry:upstream:20000","give_up:upstream:kind_limit"]'],
                ['network: 3 attempts, 2 s and 5 s', network, '["retry:network:2000","retry:network:5000","give_up:network:kind_limit"]'],
            ];
            for (const [label, makeError, expected] of ladders) {
                const steps = runFailures(Array.from({ length: 6 }, () => openFailure(makeError())));
                expect(describeSteps(steps) === expected, `${label} (got ${describeSteps(steps)})`);
            }
        },
    },
    {
        name: 'mixed kinds count apart: timeout → 429 → 429 waits 2 s, then 429 steps 1 and 2',
        body: async () => {
            const steps = runFailures([openFailure(timeout()), openFailure(rateLimit()), openFailure(rateLimit())]);
            expect(
                describeSteps(steps) === '["retry:timeout:2000","retry:rate_limit:15000","retry:rate_limit:45000"]',
                `each kind uses its own ladder (got ${describeSteps(steps)})`
            );
            expect(steps.at(-1)?.counters.round.failures === 3, 'three failures in the round');
        },
    },
    {
        name: 'a round has at most 5 attempts, whatever the kinds',
        body: async () => {
            const steps = runFailures([
                openFailure(timeout()),
                openFailure(timeout()),
                openFailure(serverError()),
                openFailure(serverError()),
                openFailure(network()),
            ]);
            expect(
                describeSteps(steps) ===
                    '["retry:timeout:2000","retry:timeout:60000","retry:upstream:5000","retry:upstream:20000","give_up:network:round_limit"]',
                `the fifth failure ends the round (got ${describeSteps(steps)})`
            );
            const nextRoundStep = decideRecovery(openFailure(network()), nextRound(steps[3]?.counters ?? FRESH), noJitter);
            expect(nextRoundStep.action === 'retry', 'the next round starts its own count');
        },
    },
    {
        name: 'a broken stream: redone once per round and twice per reply; it uses the next step of its kind',
        body: async () => {
            const sameRound = runFailures([streamFailure(rateLimit()), streamFailure(rateLimit())]);
            expect(
                describeSteps(sameRound) === '["retry:rate_limit:15000","give_up:rate_limit:stream_round_limit"]',
                `a second broken stream in the round is final (got ${describeSteps(sameRound)})`
            );

            const thenOpen = runFailures([streamFailure(rateLimit()), openFailure(rateLimit()), openFailure(rateLimit())]);
            expect(
                describeSteps(thenOpen) === '["retry:rate_limit:15000","retry:rate_limit:45000","retry:rate_limit:120000"]',
                `a mid-stream 429 counts as the first 429: reopening then waits 45 s (got ${describeSteps(thenOpen)})`
            );
            const fourth = decideRecovery(openFailure(rateLimit()), thenOpen.at(-1)?.counters ?? FRESH, noJitter);
            expect(
                fourth.action === 'give_up' && fourth.reason === 'kind_limit',
                'and it counts against the 4 attempts of a 429'
            );

            const round1 = runFailures([streamFailure(serverError())]);
            const round2 = runFailures([streamFailure(serverError())], nextRound(round1.at(-1)?.counters ?? FRESH));
            const round3 = runFailures([streamFailure(serverError())], nextRound(round2.at(-1)?.counters ?? FRESH));
            expect(
                describeSteps([...round1, ...round2, ...round3]) ===
                    '["retry:upstream:5000","retry:upstream:5000","give_up:upstream:stream_reply_limit"]',
                `the third broken stream of a reply is final, even in a new round (got ${describeSteps([...round1, ...round2, ...round3])})`
            );
            expect(round2.at(-1)?.counters.reply.streamRetries === 2, 'two streams were redone');
        },
    },
    {
        name: 'the reply budget: failed openings plus waits up to 12 minutes; a long broken stream is not charged',
        body: async () => {
            // Two rounds of timeouts that each took the full 180 s
            const round1 = runFailures([openFailure(timeout(), 180_000), openFailure(timeout(), 180_000)]);
            expect(
                describeSteps(round1) === '["retry:timeout:2000","retry:timeout:60000"]' &&
                    round1.at(-1)?.counters.reply.spentMs === 422_000,
                `round 1: 180 + 2 + 180 + 60 s spent (got ${describeSteps(round1)}, ${round1.at(-1)?.counters.reply.spentMs})`
            );
            const round2 = runFailures(
                [openFailure(timeout(), 180_000), openFailure(timeout(), 180_000)],
                nextRound(round1.at(-1)?.counters ?? FRESH)
            );
            expect(
                describeSteps(round2) === '["retry:timeout:2000","give_up:timeout:budget"]',
                `round 2: a 60 s wait would end past 12 minutes (844 s), so it gives up (got ${describeSteps(round2)})`
            );

            // The worst 429 ladder of one round, each attempt queued 168 s, fits
            const queued = runFailures(Array.from({ length: 3 }, () => openFailure(rateLimit(), 168_000)));
            expect(
                describeSteps(queued) === '["retry:rate_limit:15000","retry:rate_limit:45000","retry:rate_limit:120000"]' &&
                    queued.at(-1)?.counters.reply.spentMs === 684_000,
                `684 s used before the 4th attempt (got ${queued.at(-1)?.counters.reply.spentMs})`
            );

            const nearlySpent: RecoveryCounters = {
                reply: { spentMs: REPLY_RECOVERY_BUDGET_MS - 10_000, failedAttempts: 0, streamRetries: 0 },
                round: FRESH_ROUND_RECOVERY,
            };
            const tooLong = decideRecovery(openFailure(rateLimit(), 0), nearlySpent, noJitter);
            expect(
                tooLong.action === 'give_up' && tooLong.reason === 'budget',
                'a wait longer than what is left gives up at once'
            );
            const shortEnough = decideRecovery(openFailure(timeout(), 0), nearlySpent, noJitter);
            expect(shortEnough.action === 'retry' && shortEnough.counters.reply.spentMs === REPLY_RECOVERY_BUDGET_MS - 8_000, 'a wait that fits still runs');

            const longStream = decideRecovery(streamFailure(rateLimit(), 600_000), nearlySpent, noJitter);
            expect(
                longStream.action === 'give_up' && longStream.reason === 'budget',
                'a broken stream only adds its wait (15 s here, more than the 10 s left)'
            );
            const streamed = decideRecovery(streamFailure(serverError(), 600_000), FRESH, noJitter);
            expect(
                streamed.action === 'retry' && streamed.counters.reply.spentMs === 5_000,
                `ten minutes of streaming leave the budget alone (got ${json(streamed)})`
            );
        },
    },
    {
        name: 'the reply has at most 12 failed attempts, across rounds',
        body: async () => {
            let counters = FRESH;
            const outcomes: string[] = [];
            for (let round = 1; round <= 6; round++) {
                const steps = runFailures([openFailure(network()), openFailure(network())], nextRound(counters));
                outcomes.push(...steps.map(describeStep));
                counters = steps.at(-1)?.counters ?? counters;
            }
            expect(outcomes.length === 12, `twelve failures were judged (got ${outcomes.length})`);
            expect(
                outcomes.slice(0, 11).every((outcome) => outcome.startsWith('retry:network')),
                `the first eleven were retried (got ${json(outcomes)})`
            );
            expect(outcomes[11] === 'give_up:network:attempt_limit', `the twelfth ends the reply (got ${outcomes[11]})`);
        },
    },
    {
        name: 'jitter: ±20% around the base wait, and the decision waits the jittered time',
        body: async () => {
            expect(jitteredWaitMs(45_000, () => 0) === 36_000, 'random 0: 80%');
            expect(jitteredWaitMs(45_000, () => 0.5) === 45_000, 'random 0.5: the base');
            expect(jitteredWaitMs(45_000, () => 0.999999) === 54_000, 'random just below 1: 120%');
            for (const random of [0, 0.1, 0.37, 0.5, 0.82, 0.999999]) {
                const decision = decideRecovery(openFailure(rateLimit()), FRESH, () => random);
                const inRange =
                    decision.action === 'retry' && decision.waitMs >= 12_000 && decision.waitMs <= 18_000 && Number.isInteger(decision.waitMs);
                expect(inRange, `random ${random}: a whole wait within 12-18 s (got ${json(decision)})`);
                expect(
                    decision.action === 'retry' && decision.counters.reply.spentMs === decision.waitMs,
                    'the budget is charged the wait actually taken'
                );
            }
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
reportResults(results);
