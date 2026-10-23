/**
 * The Gemini client tool loop.
 *
 * Unlike the platforms on runToolLoop, Gemini rounds stream live: text and
 * thinking show while they arrive, and the round's parts are kept verbatim
 * for the next request. A round that calls functions has them run in order,
 * then the next request repeats round 1's contents plus every tool round so
 * far (model turn + function responses). The last allowed round, a round
 * after the deadline, and the retry of a function call Gemini failed to
 * produce go out with function calling switched off (mode NONE).
 *
 * Measured 2026-10-16, mode NONE drops the declarations from the prompt but
 * does not stop 3.8-flash or argon from calling a function they saw earlier
 * in the turn. So when the round limit or the deadline makes the next round
 * the final one, every function response of the round just run says that no
 * more calls are available (LAST_TOOL_ROUND_NOTICE). Calls a final round
 * still makes are never run; the reply would end on them (or on a preface
 * such as "let me check"), so they are answered as not run (function calling
 * is off) and the model gets ONE more round with function calling still off.
 * That round is the answer whatever it asks for, so a reply runs at most
 * GEMINI_MAX_ROUNDS + 1 rounds.
 *
 * Search grounding is merged across rounds and yielded once, right before
 * the single done chunk.
 */
import { match, P } from 'ts-pattern';
import { FinishReason, type GenerateContentResponse } from '@google/genai';
import type { GroundingData, StreamChunk } from '../../types.js';
import { createRoundTextSeparator } from '../../tools/round-text-separator.js';
import { finalRoundReason, TOOL_LOOP_DEADLINE_MS } from '../../tools/tool-loop.js';
import {
    createToolUsageTally,
    runToolRound,
    withToolBudget,
    type ToolUsageTally,
} from '../../tools/tool-round.js';
import type { TurnTools } from '../../tools/tool-types.js';
import type { FirstGeminiRound, OpenGeminiRound } from './gemini-first-round.js';
import { mergeGroundingData } from './gemini-grounding.js';
import {
    buildFunctionCallingOffParts,
    buildFunctionResponseParts,
    buildRoundContents,
    toToolCalls,
    withoutFunctionCallParts,
    type GeminiToolRound,
} from './gemini-round-contents.js';
import { consumeGeminiRound, type CollectedGeminiRound } from './gemini-round-stream.js';
import { hasFunctionDeclarations, type GeminiRoundRequest } from './gemini-tool-request.js';
import {
    formatGeminiTurnSummary,
    formatGeminiUsageLine,
    type GeminiRequestUsage,
} from './gemini-usage-log.js';

/**
 * Rounds per reply; the last one may no longer call functions. Only a final
 * round that still calls gets one round more.
 *
 * Was 5 (4 tool rounds). The media tools added three call types (search, read,
 * send), so a reply could run out of rounds before sending the picture it had
 * already found (live 1106440). Twelve of the rounds may call tools: the model
 * decides how much to search and it is told what is left after every call, so
 * the count only has to be generous enough to finish in. The wall clock
 * (TOOL_LOOP_DEADLINE_MS) stays the real bound and is now told to the model in
 * every tool result, so it can send the picture before the time runs out.
 */
export const GEMINI_MAX_ROUNDS = 13;

/** A function call Gemini could not produce: retried once as the final round */
const FAILED_CALL_FINISH_REASONS: ReadonlySet<FinishReason> = new Set([
    FinishReason.MALFORMED_FUNCTION_CALL,
    FinishReason.UNEXPECTED_TOOL_CALL,
]);

export interface GeminiToolLoopOptions {
    readonly model: string;
    readonly tools: TurnTools;
    /** Round 1, already open (see openFirstGeminiRound) */
    readonly firstRound: FirstGeminiRound;
    readonly openRound: OpenGeminiRound;
    /** Epoch ms before round 1 was first sent; the deadline counts from here */
    readonly startedAt: number;
    /** Defaults to TOOL_LOOP_DEADLINE_MS */
    readonly deadlineMs?: number;
    /** The lane the platform picked, for the usage lines */
    readonly viaLabel: string | undefined;
    readonly signal?: AbortSignal;
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
    const { model, tools, firstRound, openRound, startedAt, viaLabel, signal } = options;
    const deadlineMs = options.deadlineMs ?? TOOL_LOOP_DEADLINE_MS;
    const deadlineAt = startedAt + deadlineMs;
    const tally = createToolUsageTally();
    const separator = createRoundTextSeparator();
    const toolRounds: GeminiToolRound[] = [];
    const roundUsages: GeminiRequestUsage[] = [];
    const groundings: GroundingData[] = [];
    let executedCallCount = 0;
    // The one extra round for a final round that still called
    let mayAskAgain = true;
    let request = firstRound.request;
    let opened = firstRound.opened;
    let lastChunk: GenerateContentResponse | null = null;

    for (let roundNumber = 1; ; roundNumber++) {
        separator.startRound();
        const round = yield* consumeGeminiRound(opened, separator, viaLabel);
        lastChunk = round.lastChunk;
        groundings.push(...round.groundings);
        roundUsages.push(round.usage);
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

        if (outcome === 'failed-call') {
            console.warn(
                `[gemini] round ${roundNumber} ended with ${round.finishReason}, forcing final answer`
            );
            request = { ...request, final: true };
        } else if (outcome === 'final-calls') {
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
                contents: buildRoundContents(firstRound.request.contents, toolRounds),
                tools: firstRound.request.tools,
                final: true,
            };
        } else {
            const executedCalls = yield* runToolRound(
                tools,
                toToolCalls(round.functionCalls, roundNumber),
                tally,
                signal
            );
            executedCallCount += executedCalls.length;
            if (signal?.aborted) break;

            // Judged after the calls ran: they may have used up the deadline. The
            // next round's 0-based index is this round's 1-based number.
            const finalReason = finalRoundReason(roundNumber, GEMINI_MAX_ROUNDS - 1, deadlineAt, deadlineMs);
            if (finalReason !== null) {
                console.log(
                    `[gemini] ${finalReason}, forcing final answer (notice on the round ${roundNumber} responses)`
                );
            }
            // The round budget rides in each result, like every other limit the
            // model has to plan around; the final-round notice stays separate.
            const roundsLeft =
                finalReason !== null
                    ? 0
                    : Math.max(0, GEMINI_MAX_ROUNDS - 1 - roundNumber);
            const answeredCalls = withToolBudget(executedCalls, {
                roundsLeft,
                elapsedMs: Date.now() - startedAt,
                deadlineMs,
            });
            toolRounds.push({
                modelParts: round.parts,
                responseParts: buildFunctionResponseParts(
                    round.functionCalls,
                    answeredCalls.map((executedCall) => executedCall.result),
                    { lastToolRound: finalReason !== null }
                ),
            });
            request = {
                contents: buildRoundContents(firstRound.request.contents, toolRounds),
                tools: firstRound.request.tools,
                final: finalReason !== null,
            };
        }

        opened = await openRound(request);
    }

    console.log(formatGeminiTurnSummary(model, roundUsages, executedCallCount, startedAt));
    const grounding = mergeGroundingData(groundings);
    if (grounding) {
        yield { type: 'grounding', groundingMetadata: grounding };
    }
    yield doneChunk(lastChunk, tally);
}
