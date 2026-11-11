/**
 * The rounds of one Grok reply. Text and thinking stream live; a round that
 * calls client tools runs them and continues on the same response chain
 * (`previous_response_id`). Without client tools this is a single round.
 *
 * Only calls of the tools the accepted request offered run; every other
 * function call is answered with an error, so the chain never carries an
 * unanswered call and the model learns the tool is not there.
 *
 * Rounds are unbounded: once the reply is past its deadline, the next round
 * goes out with `tool_choice: 'none'`, so a reply never ends on tool records
 * without an answer. A stop ends the loop between rounds.
 */
import type { Response, ResponseStreamEvent } from 'openai/resources/responses/responses';
import {
    budgetExhaustedReason,
    createRoundTextSeparator,
    createToolTimeClock,
    createToolUsageTally,
    FREE_TOOL_ROUNDS_MAX,
    runToolRound,
    toolTimeSpentMs,
    withToolBudget,
    TOOL_LOOP_DEADLINE_MS,
    TOOL_LOOP_WALL_MS,
    type ToolCall,
    type TurnTools,
} from '../../tools/index.js';
import { filterTurnTools } from '../../tools/turn-tools.js';
import { isTimeFreeToolName } from '../../../reply/tools/tool-names.js';
import type { StreamChunk } from '../../types.js';
import { normalizeResponsesUsage } from '../../usage/normalize-responses.js';
import type { UsageSink } from '../../usage/usage-types.js';
import { createGrokAgentStats } from './grok-agent-stats.js';
import { fieldOf } from './grok-response-fields.js';
import { extractGrokGrounding } from './grok-grounding.js';
import {
    buildContinuationRequest,
    buildFunctionCallOutputs,
    buildModelImagesInput,
    functionToolNames,
    isGrokMultiAgentModel,
    type GrokResponseRequest,
} from './grok-request.js';
import { streamGrokRound } from './grok-round.js';

export interface GrokToolLoopOptions {
    readonly model: string;
    /** Round 1's stream, opened by the candidate walk */
    readonly firstStream: AsyncIterable<ResponseStreamEvent>;
    /** The round-1 candidate xAI accepted; every later round reuses it */
    readonly acceptedRequest: GrokResponseRequest;
    /** The turn's client tools; only those the accepted request offers can run */
    readonly tools: TurnTools;
    /** When round 1 was sent; the deadline counts from here */
    readonly startedAt: number;
    /** Defaults to TOOL_LOOP_DEADLINE_MS */
    readonly deadlineMs?: number;
    /** Defaults to TOOL_LOOP_WALL_MS */
    readonly wallMs?: number;
    readonly signal?: AbortSignal;
    /** Open a later round's stream (no candidate walk) */
    readonly openContinuation: (request: GrokResponseRequest) => Promise<AsyncIterable<ResponseStreamEvent>>;
    /** The model can see pictures, so tool images are replayed */
    readonly supportsImageInput: boolean;
    /** Gets every round's usage as soon as the round has streamed */
    readonly usageSink?: UsageSink;
}

/** The calls that may run: those naming a tool the accepted request offered */
const offeredCallsOf = (
    functionCalls: readonly ToolCall[],
    clientToolNames: ReadonlySet<string>,
    roundNumber: number
): ToolCall[] => {
    const notOfferedNames = functionCalls.map(({ name }) => name).filter((name) => !clientToolNames.has(name));
    if (notOfferedNames.length > 0) {
        console.warn(
            `[grok] Round ${roundNumber}: answering function calls not offered this turn with an error: ` +
                notOfferedNames.join(', ')
        );
    }
    return functionCalls.filter(({ name }) => clientToolNames.has(name));
};

export async function* runGrokToolLoop(
    options: GrokToolLoopOptions
): AsyncGenerator<StreamChunk, void, undefined> {
    const { model, acceptedRequest, tools, signal } = options;
    const deadlineMs = options.deadlineMs ?? TOOL_LOOP_DEADLINE_MS;
    const wallMs = options.wallMs ?? TOOL_LOOP_WALL_MS;
    const clock = createToolTimeClock(deadlineMs, wallMs, options.startedAt);
    const freeTools = filterTurnTools(tools, (name) => isTimeFreeToolName(name));
    const hasFreeTools = freeTools.definitions.length > 0;
    const clientToolNames = new Set(functionToolNames(acceptedRequest.tools));
    const separator = createRoundTextSeparator();
    const tally = createToolUsageTally();
    const stats = createGrokAgentStats(isGrokMultiAgentModel(model));

    let stream = options.firstStream;
    let mode: 'normal' | 'free' | 'final' = 'normal';
    let freeRounds = 0;
    let roundCount = 0;
    let executedCallCount = 0;
    let lastResponse: Response | null = null;

    for (;;) {
        separator.startRound();
        const round = yield* streamGrokRound(stream, { roundIndex: roundCount, separator });
        roundCount++;
        lastResponse = round.response;
        // A round without a closing response still counts, with no usage
        options.usageSink?.addRound(normalizeResponsesUsage(fieldOf(round.response, 'usage')));

        if (round.response) {
            stats.addResponse(round.response);
            for (const groundingMetadata of extractGrokGrounding(round.response)) {
                yield { type: 'grounding', groundingMetadata };
            }
        }
        if (round.response === null || round.incomplete) {
            const ending = round.response === null
                ? 'without a closing response'
                : `incomplete (${round.response.incomplete_details?.reason ?? 'unknown'})`;
            const skipped = round.functionCalls.length > 0
                ? `, skipping its ${round.functionCalls.length} function call(s)`
                : '';
            console.warn(`[grok] Round ${roundCount} ended ${ending}${skipped}`);
        }

        // The answer: no function calls, the final round, or a round that cannot be continued
        if (mode === 'final' || round.functionCalls.length === 0 || round.incomplete || round.response === null) {
            break;
        }

        if (mode === 'free') {
            freeRounds += 1;
            const freeExecuted = yield* runToolRound(freeTools, round.functionCalls, tally, signal);
            executedCallCount += freeExecuted.length;
            if (signal?.aborted) break;
            const capReached = freeRounds >= FREE_TOOL_ROUNDS_MAX;
            const answeredFreeCalls = withToolBudget(freeExecuted, {
                toolCalls: executedCallCount,
                finalRound: capReached,
                freeRound: true,
                elapsedMs: Date.now() - options.startedAt,
                toolTimeMs: clock.toolTimeMs,
                deadlineMs,
            });
            stream = await options.openContinuation(
                buildContinuationRequest(
                    acceptedRequest,
                    round.response.id,
                    buildFunctionCallOutputs(round.functionCalls, answeredFreeCalls),
                    capReached,
                    options.supportsImageInput ? buildModelImagesInput(answeredFreeCalls) : []
                )
            );
            mode = capReached ? 'final' : 'free';
            continue;
        }

        const offeredCalls = offeredCallsOf(round.functionCalls, clientToolNames, roundCount);
        console.log(`[grok] Round ${roundCount}: running ${offeredCalls.length} client tool call(s)`);
        const executedCalls = yield* runToolRound(tools, offeredCalls, tally, signal);
        executedCallCount += executedCalls.length;
        clock.toolTimeMs += toolTimeSpentMs(executedCalls);

        // A stopped reply sends nothing further
        if (signal?.aborted) {
            break;
        }

        // Judged after the calls ran: they may have used up the budget
        const exhausted = budgetExhaustedReason(clock);
        if (exhausted !== null) {
            console.log(
                `[grok] ${exhausted}, ` +
                    (hasFreeTools ? 'no-cost tools only from here' : 'forcing final answer')
            );
            mode = hasFreeTools ? 'free' : 'final';
        } else {
            mode = 'normal';
        }
        const answeredCalls = withToolBudget(executedCalls, {
            toolCalls: executedCallCount,
            finalRound: mode === 'final',
            freeRound: mode === 'free',
            elapsedMs: Date.now() - options.startedAt,
            toolTimeMs: clock.toolTimeMs,
            deadlineMs,
        });
        stream = await options.openContinuation(
            buildContinuationRequest(
                acceptedRequest,
                round.response.id,
                buildFunctionCallOutputs(round.functionCalls, answeredCalls),
                mode === 'final',
                options.supportsImageInput ? buildModelImagesInput(answeredCalls) : []
            )
        );
    }

    yield {
        type: 'done',
        agentStats: stats.build(tally.snapshot()),
        // A response's output_text covers its own round only, so a reply of
        // several rounds is exactly what was streamed
        rawResponse: roundCount === 1 ? lastResponse : undefined,
    };
}
