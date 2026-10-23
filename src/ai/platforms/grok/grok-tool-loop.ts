/**
 * The rounds of one Grok reply. Text and thinking stream live; a round that
 * calls client tools runs them and continues on the same response chain
 * (`previous_response_id`). Without client tools this is a single round.
 *
 * Only calls of the tools the accepted request offered run; every other
 * function call is answered with an error, so the chain never carries an
 * unanswered call and the model learns the tool is not there.
 *
 * At most MAX_ROUNDS rounds: once the last one is due, or the reply is past
 * its deadline, the next round goes out with `tool_choice: 'none'`, so a reply
 * never ends on tool records without an answer. A stop ends the loop between
 * rounds.
 */
import type { Response, ResponseStreamEvent } from 'openai/resources/responses/responses';
import {
    createRoundTextSeparator,
    createToolUsageTally,
    finalRoundReason,
    runToolRound,
    withToolBudget,
    TOOL_LOOP_DEADLINE_MS,
    type ToolCall,
    type TurnTools,
} from '../../tools/index.js';
import type { StreamChunk } from '../../types.js';
import { createGrokAgentStats } from './grok-agent-stats.js';
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

/** Rounds of one reply, the final tool-less one included */
/** Rounds of one reply, the final tool-less one included (12 may call tools) */
const MAX_ROUNDS = 13;

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
    readonly signal?: AbortSignal;
    /** Open a later round's stream (no candidate walk) */
    readonly openContinuation: (request: GrokResponseRequest) => Promise<AsyncIterable<ResponseStreamEvent>>;
    /** The model can see pictures, so tool images are replayed */
    readonly supportsImageInput: boolean;
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
    const deadlineAt = options.startedAt + deadlineMs;
    const clientToolNames = new Set(functionToolNames(acceptedRequest.tools));
    const separator = createRoundTextSeparator();
    const tally = createToolUsageTally();
    const stats = createGrokAgentStats(isGrokMultiAgentModel(model));

    let stream = options.firstStream;
    let final = false;
    let roundCount = 0;
    let lastResponse: Response | null = null;

    for (;;) {
        separator.startRound();
        const round = yield* streamGrokRound(stream, { roundIndex: roundCount, separator });
        roundCount++;
        lastResponse = round.response;

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
        if (final || round.functionCalls.length === 0 || round.incomplete || round.response === null) {
            break;
        }

        const offeredCalls = offeredCallsOf(round.functionCalls, clientToolNames, roundCount);
        console.log(`[grok] Round ${roundCount}: running ${offeredCalls.length} client tool call(s)`);
        const executedCalls = yield* runToolRound(tools, offeredCalls, tally, signal);

        // A stopped reply sends nothing further
        if (signal?.aborted) {
            break;
        }

        // roundCount rounds are done: the coming one has that 0-based index
        const finalReason = finalRoundReason(roundCount, MAX_ROUNDS - 1, deadlineAt, deadlineMs);
        if (finalReason !== null) {
            console.log(`[grok] ${finalReason}, forcing final answer`);
            final = true;
        }
        const roundsLeft = final ? 0 : Math.max(0, MAX_ROUNDS - 1 - roundCount);
        const answeredCalls = withToolBudget(executedCalls, {
            roundsLeft,
            elapsedMs: deadlineMs - Math.max(0, deadlineAt - Date.now()),
            deadlineMs,
        });
        stream = await options.openContinuation(
            buildContinuationRequest(
                acceptedRequest,
                round.response.id,
                buildFunctionCallOutputs(round.functionCalls, answeredCalls),
                final,
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
