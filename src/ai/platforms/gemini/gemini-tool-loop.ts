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
 * (gemini-round-runner.ts), which retries a failed attempt in place. Each
 * branch below only works out the next round's request; the loop top sends
 * it. Round 1's fallbacks live in the runner, and what round 1 finally sent
 * is the base every later round builds on.
 */
import { match, P } from 'ts-pattern';
import { FinishReason, type GenerateContentResponse } from '@google/genai';
import type { GroundingData, StreamChunk } from '../../types.js';
import { createRoundTextSeparator } from '../../tools/round-text-separator.js';
import {
    budgetExhaustedReason,
    createToolTimeClock,
    FREE_TOOL_ROUNDS_MAX,
    TOOL_LOOP_DEADLINE_MS,
    TOOL_LOOP_WALL_MS,
} from '../../tools/tool-loop.js';
import {
    createToolUsageTally,
    runToolRound,
    toolTimeSpentMs,
    withToolBudget,
    type ToolUsageTally,
} from '../../tools/tool-round.js';
import { filterTurnTools } from '../../tools/turn-tools.js';
import { isTimeFreeToolName } from '../../../reply/tools/tool-names.js';
import type { TurnTools } from '../../tools/tool-types.js';
import { mergeGroundingData } from './gemini-grounding.js';
import { FRESH_REPLY_RECOVERY } from './gemini-recovery-policy.js';
import {
    buildFunctionCallingOffParts,
    buildFunctionResponseParts,
    buildRoundContents,
    toToolCalls,
    withoutFunctionCallParts,
    type GeminiToolRound,
} from './gemini-round-contents.js';
import type { OpenGeminiRound } from './gemini-round-open.js';
import { runRecoverableRound, type RoundRecovery } from './gemini-round-runner.js';
import type { CollectedGeminiRound } from './gemini-round-stream.js';
import { hasFunctionDeclarations, type GeminiRoundRequest } from './gemini-tool-request.js';
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

export interface GeminiToolLoopOptions {
    readonly model: string;
    readonly tools: TurnTools;
    /** Round 1 as built from the messages; the runner may fall back from it once */
    readonly firstRequest: GeminiRoundRequest;
    /** Opens one attempt of a round */
    readonly openRound: OpenGeminiRound;
    /** Null: no automatic recovery, every round gets one attempt (maxRetries === 1) */
    readonly recovery: RoundRecovery | null;
    /** Epoch ms before round 1 was first sent; the deadline counts from here */
    readonly startedAt: number;
    /** Defaults to TOOL_LOOP_DEADLINE_MS */
    readonly deadlineMs?: number;
    /** Defaults to TOOL_LOOP_WALL_MS */
    readonly wallMs?: number;
    /** The lane the platform picked, for the usage lines */
    readonly viaLabel: string | undefined;
    readonly signal?: AbortSignal;
    /** Gets every round's usage as soon as the round has streamed */
    readonly usageSink?: UsageSink;
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

const doneChunk = (lastChunk: GenerateContentResponse | null, tally: ToolUsageTally): StreamChunk => {
    const toolUsage = tally.snapshot();
    return {
        type: 'done',
        rawResponse: lastChunk === null ? null : withoutFunctionCallParts(lastChunk),
        ...(toolUsage.length > 0 ? { agentStats: { toolUsage } } : {}),
    };
};

export async function* runGeminiToolLoop(
    options: GeminiToolLoopOptions
): AsyncGenerator<StreamChunk, void, undefined> {
    const { model, tools, openRound, recovery, startedAt, viaLabel, signal, usageSink } = options;
    const deadlineMs = options.deadlineMs ?? TOOL_LOOP_DEADLINE_MS;
    const wallMs = options.wallMs ?? TOOL_LOOP_WALL_MS;
    const clock = createToolTimeClock(deadlineMs, wallMs, startedAt);
    const freeTools = filterTurnTools(tools, (name) => isTimeFreeToolName(name));
    const hasFreeTools = freeTools.definitions.length > 0;
    let freeMode = false;
    let freeRounds = 0;
    const tally = createToolUsageTally();
    const separator = createRoundTextSeparator();
    const toolRounds: GeminiToolRound[] = [];
    const roundUsages: GeminiRequestUsage[] = [];
    const groundings: GroundingData[] = [];
    let executedCallCount = 0;
    // The one extra round for a final round that still called
    let mayAskAgain = true;
    // The next round's request; every branch below sets it, the loop top sends it
    let request = options.firstRequest;
    // What round 1 finally sent (a 400 fallback may have changed it): the
    // contents and tools every later round builds on
    let baseRequest: GeminiRoundRequest | null = null;
    // Automatic recovery is budgeted per reply, across rounds
    let recoveryState = FRESH_REPLY_RECOVERY;
    let lastChunk: GenerateContentResponse | null = null;

    for (let roundNumber = 1; ; roundNumber++) {
        separator.startRound();
        const recovered = yield* runRecoverableRound({
            model,
            roundNumber,
            request,
            allowFallback: roundNumber === 1,
            openRound,
            separator,
            viaLabel,
            signal,
            recovery,
            recoveryState,
            usageSink,
        });
        const { round } = recovered;
        request = recovered.request;
        recoveryState = recovered.recoveryState;
        const base: GeminiRoundRequest = baseRequest ?? recovered.request;
        baseRequest = base;

        lastChunk = round.lastChunk;
        groundings.push(...round.groundings);
        roundUsages.push(round.usage);
        usageSink?.addRound(normalizeGeminiUsage(round.usage.usage), {
            servedTier: geminiServedTier(round.usage.usage),
        });
        console.log(
            formatGeminiUsageLine(model, round.usage, {
                roundNumber,
                callCount: round.functionCalls.length,
            })
        );

        const outcome = roundOutcome(round, request, mayAskAgain);
        // A stopped reply sends nothing further and runs no tools
        if (outcome === 'answer' || signal?.aborted) {
            if (outcome === 'answer' && round.functionCalls.length > 0) {
                console.warn(
                    `[gemini] round ${roundNumber} still asked for ${round.functionCalls.length} function call(s) after function calling was off; not run`
                );
            }
            break;
        }

        if (freeMode) {
            // Past the budget: only no-cost tools run, and the reply then answers
            if (outcome !== 'calls') {
                request = { ...request, tools: base.tools, final: true };
                freeMode = false;
                continue;
            }
            freeRounds += 1;
            const freeCalls = toToolCalls(round.functionCalls, roundNumber);
            const freeExecuted = yield* runToolRound(freeTools, freeCalls, tally, signal);
            executedCallCount += freeExecuted.length;
            const capReached = freeRounds >= FREE_TOOL_ROUNDS_MAX;
            const answeredFreeCalls = withToolBudget(freeExecuted, {
                toolCalls: executedCallCount,
                finalRound: capReached,
                freeRound: true,
                elapsedMs: Date.now() - startedAt,
                toolTimeMs: clock.toolTimeMs,
                deadlineMs,
            });
            toolRounds.push({
                modelParts: round.parts,
                responseParts: buildFunctionResponseParts(
                    round.functionCalls,
                    answeredFreeCalls.map((executedCall) => executedCall.result),
                    { lastToolRound: capReached }
                ),
            });
            request = {
                contents: buildRoundContents(base.contents, toolRounds),
                tools: base.tools,
                final: capReached,
            };
            freeMode = !capReached;
            continue;
        }

        if (outcome === 'failed-call') {
            console.warn(
                `[gemini] round ${roundNumber} ended with ${round.finishReason}, forcing final answer`
            );
            request = { ...request, final: true };
            continue;
        }

        if (outcome === 'final-calls') {
            console.warn(
                `[gemini] final round ${roundNumber} still made ${round.functionCalls.length} function call(s) ` +
                    `${round.showedText ? 'after some text' : 'and no text'}; answered them as not run, asking once more`
            );
            mayAskAgain = false;
            toolRounds.push({
                modelParts: round.parts,
                responseParts: buildFunctionCallingOffParts(round.functionCalls),
            });
            request = {
                contents: buildRoundContents(base.contents, toolRounds),
                tools: base.tools,
                final: true,
            };
            continue;
        }

        const executedCalls = yield* runToolRound(
            tools,
            toToolCalls(round.functionCalls, roundNumber),
            tally,
            signal
        );
        executedCallCount += executedCalls.length;
        clock.toolTimeMs += toolTimeSpentMs(executedCalls);
        if (signal?.aborted) break;

        // Judged after the calls ran: they may have used up the budget
        const exhausted = budgetExhaustedReason(clock);
        if (exhausted !== null) {
            console.log(
                `[gemini] ${exhausted}, ` +
                    (hasFreeTools ? 'no-cost tools only from here' : 'forcing final answer') +
                    ` (notice on the round ${roundNumber} responses)`
            );
            freeMode = hasFreeTools;
        }
        // The call count rides in each result, like every other fact the
        // model has to plan around; the last-round notice stays separate.
        const answeredCalls = withToolBudget(executedCalls, {
            toolCalls: executedCallCount,
            finalRound: exhausted !== null && !hasFreeTools,
            freeRound: exhausted !== null && hasFreeTools,
            elapsedMs: Date.now() - startedAt,
            toolTimeMs: clock.toolTimeMs,
            deadlineMs,
        });
        toolRounds.push({
            modelParts: round.parts,
            responseParts: buildFunctionResponseParts(
                round.functionCalls,
                answeredCalls.map((executedCall) => executedCall.result),
                { lastToolRound: exhausted !== null && !hasFreeTools }
            ),
        });
        request = {
            contents: buildRoundContents(base.contents, toolRounds),
            tools: base.tools,
            final: exhausted !== null && !hasFreeTools,
        };
    }

    console.log(formatGeminiTurnSummary(model, roundUsages, executedCallCount, startedAt));
    const grounding = mergeGroundingData(groundings);
    if (grounding) {
        yield { type: 'grounding', groundingMetadata: grounding };
    }
    yield doneChunk(lastChunk, tally);
}
