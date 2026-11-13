/**
 * The Gemini client tool loop.
 *
 * Unlike the platforms on runToolLoop, Gemini rounds stream live: text and
 * thinking show while they arrive, and the round's parts are kept verbatim
 * for the next request. A round that calls functions has them run in order,
 * then the next request repeats round 1's contents plus every tool round so
 * far (model turn + function responses). A round after the deadline, and the
 * retry of a function call Gemini failed to produce, go out with function
 * calling switched off (mode NONE). There is no round cap: the wall clock is
 * what bounds a reply.
 *
 * Measured 2026-10-16, mode NONE drops the declarations from the prompt but
 * does not stop 3.8-flash or argon from calling a function they saw earlier
 * in the turn. So when the deadline makes the next round the final one, every
 * function response of the round just run says that no more calls are
 * available (LAST_TOOL_ROUND_NOTICE). Calls a final round still makes are
 * never run; the reply would end on them (or on a preface such as "let me
 * check"), so they are answered as not run (function calling is off) and the
 * model gets ONE more round with function calling still off. That round is
 * the answer whatever it asks for.
 *
 * Search grounding is merged across rounds and yielded once, right before
 * the single done chunk.
 *
 * Every round, round 1 included, is opened by runRecoverableRound
 * (gemini-round-runner.ts), which retries a failed attempt in place. The loop
 * state is one immutable value (gemini-loop-state.ts); each branch below only
 * works out the next state, whose request the loop top sends. Round 1's
 * fallbacks live in the runner, and what round 1 finally sent is the base
 * every later round builds on.
 *
 * Checkpoints (design 2026-1112-1123 §6.2). With a checkpointSink, the loop
 * hands over a checkpoint (gemini-checkpoint.ts) whenever the next round
 * could be sent as it is: (1) a round is dealt with and the next request is
 * worked out, before it opens; (2) a round's stream completed and its calls
 * are about to run; (3) after each call, before what it produced is yielded
 * (gemini-round-calls.ts). The consumer ends the loop by walking away at a
 * yield, and a failed round throws out of it, so each checkpoint is handed
 * over before the yields that follow it. A checkpoint's journal is what the
 * loop yielded up to then (gemini-loop-journal.ts): the half-finished output
 * of a round that later fails is never in it.
 *
 * Resume: started from a checkpoint, the loop first replays its journal
 * (chunks marked `replay`), shows a status line until the next round's
 * stream opens, and goes on with the checkpoint's counts, clock, tally and
 * separator. Only the automatic recovery budget starts afresh.
 */
import { match, P } from 'ts-pattern';
import { FinishReason, type GenerateContentResponse } from '@google/genai';
import type { AgentToolUsage, StreamChunk } from '../../types.js';
import {
    createRoundTextSeparator,
    type RoundTextSeparatorState,
} from '../../tools/round-text-separator.js';
import type { ToolLoopCheckpointSink } from '../../tools/tool-loop-checkpoint.js';
import { TOOL_LOOP_DEADLINE_MS, TOOL_LOOP_WALL_MS } from '../../tools/tool-loop.js';
import { createToolUsageTally, type ToolUsageTally } from '../../tools/tool-round.js';
import { filterTurnTools } from '../../tools/turn-tools.js';
import { isTimeFreeToolName, LEAVE_HANDOFF_TOOL_NAME } from '../../../reply/tools/tool-names.js';
import type { TurnTools } from '../../tools/tool-types.js';
import { toGeminiCheckpoint, type GeminiSnapshot } from './gemini-checkpoint.js';
import { mergeGroundingData } from './gemini-grounding.js';
import { journaled, replayJournal } from './gemini-loop-journal.js';
import {
    afterFailedCall,
    afterFinalCalls,
    afterFreeModeExit,
    afterRoundStreamed,
    initialLoopState,
    requestOn,
    type GeminiLoopLimits,
    type GeminiLoopState,
} from './gemini-loop-state.js';
import { resumingStatus } from './gemini-recovery-messages.js';
import { FRESH_REPLY_RECOVERY } from './gemini-recovery-policy.js';
import { runRoundCalls, type HandOverCheckpoint } from './gemini-round-calls.js';
import { withoutFunctionCallParts } from './gemini-round-contents.js';
import type { OpenGeminiRound } from './gemini-round-open.js';
import { runRecoverableRound, type RecoveredRound, type RoundRecovery } from './gemini-round-runner.js';
import type { CollectedGeminiRound } from './gemini-round-stream.js';
import {
    createThoughtSummaryFilter,
    thoughtSummaryLogLine,
    type ThoughtSummaryFilterState,
} from './gemini-thought-summary.js';
import {
    hasFunctionDeclarations,
    httpStatusOf,
    toGeminiToolList,
    type GeminiRoundRequest,
} from './gemini-tool-request.js';
import {
    formatGeminiTurnSummary,
    formatGeminiUsageLine,
    type GeminiRequestUsage,
} from './gemini-usage-log.js';
import { geminiServedTier, normalizeGeminiUsage } from '../../usage/normalize-gemini.js';
import type { UsageSink } from '../../usage/usage-types.js';

/** A function call Gemini could not produce: retried once as the final round */
const FAILED_CALL_FINISH_REASONS: ReadonlySet<FinishReason> = new Set([
    FinishReason.MALFORMED_FUNCTION_CALL,
    FinishReason.UNEXPECTED_TOOL_CALL,
]);

/**
 * - fresh: round 1 as built from the messages (the runner may fall back from
 *   it once); `startedAt` is epoch ms before it was first sent
 * - resume: a checkpoint's snapshot; its wall time goes on from there
 */
export type GeminiLoopStart =
    | { readonly kind: 'fresh'; readonly firstRequest: GeminiRoundRequest; readonly startedAt: number }
    | { readonly kind: 'resume'; readonly snapshot: GeminiSnapshot };

export interface GeminiToolLoopOptions {
    readonly model: string;
    readonly tools: TurnTools;
    readonly start: GeminiLoopStart;
    /** Opens one attempt of a round */
    readonly openRound: OpenGeminiRound;
    /** Null: no automatic recovery, every round gets one attempt (maxRetries === 1) */
    readonly recovery: RoundRecovery | null;
    /** Defaults to TOOL_LOOP_DEADLINE_MS */
    readonly deadlineMs?: number;
    /** Defaults to TOOL_LOOP_WALL_MS */
    readonly wallMs?: number;
    /** The lane the platform picked, for the usage lines */
    readonly viaLabel: string | undefined;
    readonly signal?: AbortSignal;
    /** Gets every round's usage as soon as the round has streamed */
    readonly usageSink?: UsageSink;
    /** Gets a new checkpoint each time the next round could be sent as it is */
    readonly checkpointSink?: ToolLoopCheckpointSink;
}

/**
 * - answer: the round ends the reply
 * - failed-call: Gemini could not produce a call; retried as the final round
 * - calls: run the calls, then the next round
 * - final-calls: a final round still called; answered as not run, asked once more
 */
type RoundOutcome = 'answer' | 'failed-call' | 'calls' | 'final-calls';

/**
 * The final round is the answer whatever it asks for, except once: when it
 * still called (whether or not some text came first) and the reply may
 * still ask again.
 */
const roundOutcome = (
    round: CollectedGeminiRound,
    request: GeminiRoundRequest,
    mayAskAgain: boolean
): RoundOutcome =>
    match({
        declared: hasFunctionDeclarations(request.tools),
        final: request.final,
        mayAskAgain,
        finishReason: round.finishReason,
        callCount: round.functionCalls.length,
    })
        .returnType<RoundOutcome>()
        .with({ declared: false }, () => 'answer')
        .with({ final: true, mayAskAgain: true, callCount: P.number.gt(0) }, () => 'final-calls')
        .with({ final: true }, () => 'answer')
        .with(
            { finishReason: P.when((reason) => reason !== undefined && FAILED_CALL_FINISH_REASONS.has(reason)) },
            () => 'failed-call'
        )
        .with({ callCount: 0 }, () => 'answer')
        .otherwise(() => 'calls');

/**
 * The next state of a round that runs no calls, or null when its calls run.
 * Past the budget, a round that did not call ends the no-cost rounds.
 */
const followWithoutCalls = (
    state: GeminiLoopState,
    outcome: Exclude<RoundOutcome, 'answer'>,
    round: CollectedGeminiRound
): GeminiLoopState | null =>
    match({ outcome, freeMode: state.freeMode })
        .returnType<GeminiLoopState | null>()
        .with({ outcome: 'calls' }, () => null)
        .with({ freeMode: true }, () => afterFreeModeExit(state))
        .with({ outcome: 'failed-call' }, () => afterFailedCall(state))
        .with({ outcome: 'final-calls' }, () => afterFinalCalls(state, round))
        .exhaustive();

const logFollowWithoutCalls = (
    outcome: Exclude<RoundOutcome, 'answer'>,
    freeMode: boolean,
    round: CollectedGeminiRound,
    roundNumber: number
): void => {
    if (freeMode) return;
    if (outcome === 'failed-call') {
        console.warn(`[gemini] round ${roundNumber} ended with ${round.finishReason}, forcing final answer`);
    } else if (outcome === 'final-calls') {
        console.warn(
            `[gemini] final round ${roundNumber} still made ${round.functionCalls.length} function call(s) ` +
                `${round.showedText ? 'after some text' : 'and no text'}; answered them as not run, asking once more`
        );
    }
};

const doneChunk = (lastChunk: GenerateContentResponse | null, tally: ToolUsageTally): StreamChunk => {
    const toolUsage = tally.snapshot();
    return {
        type: 'done',
        rawResponse: lastChunk === null ? null : withoutFunctionCallParts(lastChunk),
        ...(toolUsage.length > 0 ? { agentStats: { toolUsage } } : {}),
    };
};

/** Where the rounds begin: the state, the clock, and what was counted and shown before */
interface LoopBeginning {
    readonly state: GeminiLoopState;
    readonly startedAt: number;
    readonly toolUsage: readonly AgentToolUsage[];
    readonly separator: RoundTextSeparatorState | undefined;
    readonly thoughtSummary: ThoughtSummaryFilterState | undefined;
    /** A resume: the rounds kept from the interrupted version */
    readonly resumedAfterRounds: number | undefined;
}

const beginningOf = (start: GeminiLoopStart): LoopBeginning =>
    match(start)
        .returnType<LoopBeginning>()
        .with({ kind: 'fresh' }, (fresh) => ({
            state: initialLoopState(fresh.firstRequest),
            startedAt: fresh.startedAt,
            toolUsage: [],
            separator: undefined,
            thoughtSummary: undefined,
            resumedAfterRounds: undefined,
        }))
        .with({ kind: 'resume' }, ({ snapshot }) => ({
            state: snapshot.loop,
            // The wall time goes on from the checkpoint's: the gap before the resume does not count
            startedAt: Date.now() - snapshot.elapsedMs,
            toolUsage: snapshot.toolUsage,
            separator: snapshot.separator,
            thoughtSummary: snapshot.thoughtSummary,
            resumedAfterRounds: snapshot.loop.roundNumber - 1,
        }))
        .exhaustive();

/** The rounds themselves; `journal` holds every chunk yielded so far but status lines */
async function* runRounds(
    options: GeminiToolLoopOptions,
    journal: readonly StreamChunk[]
): AsyncGenerator<StreamChunk, void, undefined> {
    const { model, tools, openRound, recovery, viaLabel, signal, usageSink, checkpointSink } = options;
    const freeTools = filterTurnTools(tools, (name) => isTimeFreeToolName(name));
    // The hand-off round offers the one tool the last reply may still call; the
    // turn does not offer it at all when the workspace (or the tool) is off.
    const handoffDefinition = tools.definitions.find(
        (definition) => definition.name === LEAVE_HANDOFF_TOOL_NAME
    );
    const handoffToolList =
        handoffDefinition === undefined ? null : toGeminiToolList([handoffDefinition]);
    const handoffOnlyTools = filterTurnTools(tools, (name) => name === LEAVE_HANDOFF_TOOL_NAME);
    const limits: GeminiLoopLimits = {
        deadlineMs: options.deadlineMs ?? TOOL_LOOP_DEADLINE_MS,
        wallMs: options.wallMs ?? TOOL_LOOP_WALL_MS,
        hasFreeTools: freeTools.definitions.length > 0,
        handoffToolList,
    };
    const beginning = beginningOf(options.start);
    const { startedAt } = beginning;
    // The summary's own clock: a resume's line covers this request only
    const summaryStartedAt = beginning.resumedAfterRounds === undefined ? startedAt : Date.now();
    const tally = createToolUsageTally(beginning.toolUsage);
    const separator = createRoundTextSeparator(beginning.separator);
    // One filter per reply: the summarizer-stream decision holds across rounds, and across a resume
    const thoughtSummary = createThoughtSummaryFilter(beginning.thoughtSummary);
    let state = beginning.state;
    const callsBefore = state.executedCallCount;
    const roundUsages: GeminiRequestUsage[] = [];
    // Automatic recovery is budgeted per reply, across rounds; a resume starts it afresh
    let recoveryState = FRESH_REPLY_RECOVERY;
    let lastChunk: GenerateContentResponse | null = null;
    // A resume's status line stays until the first round's stream opens
    let statusOnScreen = beginning.resumedAfterRounds !== undefined;
    const elapsedMs = (): number => Date.now() - startedAt;

    const handOver: HandOverCheckpoint = (stateAt, pendingProducts = []) => {
        if (!checkpointSink) return;
        checkpointSink(
            toGeminiCheckpoint({
                loop: stateAt(),
                elapsedMs: elapsedMs(),
                toolUsage: tally.snapshot(),
                journal: [...journal, ...pendingProducts],
                separator: separator.state(),
                thoughtSummary: thoughtSummary.state(),
            })
        );
    };

    // One downgrade per loop run: a 400 on the hand-off round ends as the
    // plain final round instead of failing the reply (design D10).
    let handoffFallbackUsed = false;

    for (;;) {
        separator.startRound();
        const journalBeforeRound = journal.length;
        if (state.handoffRound) {
            console.log(`[handoff] round offered model=${model} round=${state.roundNumber}`);
        }
        let recovered: RecoveredRound;
        try {
            recovered = yield* runRecoverableRound({
                model,
                roundNumber: state.roundNumber,
                request: state.request,
                allowFallback: state.roundNumber === 1,
                openRound,
                separator,
                thoughtSummary,
                viaLabel,
                signal,
                recovery,
                recoveryState,
                usageSink,
                statusOnScreen,
            });
        } catch (error) {
            // Only when this round produced nothing: already shown text must
            // not be followed by a second answer.
            if (
                !handoffFallbackUsed &&
                state.handoffRound &&
                httpStatusOf(error) === 400 &&
                journal.length === journalBeforeRound
            ) {
                handoffFallbackUsed = true;
                console.warn('[handoff] round rejected (400); falling back to the plain final round');
                state = {
                    ...state,
                    roundNumber: state.roundNumber + 1,
                    handoffRound: false,
                    request: requestOn(state, state.toolRounds, true),
                };
                continue;
            }
            throw error;
        }
        statusOnScreen = false;
        const { round } = recovered;
        recoveryState = recovered.recoveryState;
        state = afterRoundStreamed(state, recovered.request, round.groundings);

        lastChunk = round.lastChunk;
        roundUsages.push(round.usage);
        usageSink?.addRound(normalizeGeminiUsage(round.usage.usage), {
            servedTier: geminiServedTier(round.usage.usage),
        });
        console.log(
            formatGeminiUsageLine(model, round.usage, {
                roundNumber: state.roundNumber,
                callCount: round.functionCalls.length,
            })
        );

        const outcome = roundOutcome(round, state.request, state.mayAskAgain);
        if (outcome === 'answer') {
            if (round.functionCalls.length > 0) {
                console.warn(
                    `[gemini] round ${state.roundNumber} still asked for ${round.functionCalls.length} function call(s) after function calling was off; not run`
                );
            }
            break;
        }

        const followed = followWithoutCalls(state, outcome, round);
        if (followed !== null) {
            const roundState = state;
            state = followed;
            // Before the stop check: a stop right after the stream completed still keeps the round
            handOver(() => followed);
            // A stopped reply sends nothing further
            if (signal?.aborted) break;
            logFollowWithoutCalls(outcome, roundState.freeMode, round, roundState.roundNumber);
            continue;
        }

        const { roundNumber, freeMode: freeRound } = state;
        const afterCalls = yield* runRoundCalls({
            state,
            round,
            tools: state.handoffRound ? handoffOnlyTools : freeRound ? freeTools : tools,
            tally,
            signal,
            limits,
            elapsedMs,
            handOver,
        });
        if (afterCalls === null) break;
        state = afterCalls.state;
        if (signal?.aborted) {
            // The checkpoint after the last call stays the last one: it says
            // the stop landed in that call. A stopped no-cost round goes on to
            // the loop top, which ends it as stopped.
            if (freeRound) continue;
            break;
        }
        if (afterCalls.exhausted !== null) {
            console.log(
                `[gemini] ${afterCalls.exhausted}, ` +
                    (limits.hasFreeTools ? 'no-cost tools only from here' : 'forcing final answer') +
                    ` (notice on the round ${roundNumber} responses)`
            );
        }
        handOver(() => afterCalls.state);
    }

    const thoughtSummaryLine = thoughtSummaryLogLine(model, thoughtSummary.stats());
    if (thoughtSummaryLine !== null) {
        console.log(thoughtSummaryLine);
    }
    console.log(
        formatGeminiTurnSummary(
            model,
            roundUsages,
            state.executedCallCount - callsBefore,
            summaryStartedAt,
            beginning.resumedAfterRounds
        )
    );
    const grounding = mergeGroundingData(state.groundings);
    if (grounding) {
        yield { type: 'grounding', groundingMetadata: grounding };
    }
    yield doneChunk(lastChunk, tally);
}

/**
 * The loop, every chunk it yields but status lines journaled. A resume
 * replays the checkpoint's journal first and goes on journaling after it.
 */
export async function* runGeminiToolLoop(
    options: GeminiToolLoopOptions
): AsyncGenerator<StreamChunk, void, undefined> {
    const { start } = options;
    if (start.kind === 'resume') {
        yield* replayJournal(start.snapshot.journal);
        yield resumingStatus(start.snapshot.loop.roundNumber);
    }
    // A copy: the checkpoint resumed from stays as it was
    const journal: StreamChunk[] = start.kind === 'resume' ? [...start.snapshot.journal] : [];
    yield* journaled(runRounds(options, journal), journal);
}
