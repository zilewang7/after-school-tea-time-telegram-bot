/**
 * The client tool loop of the platforms that collect a whole round before
 * showing it (OpenAI, Anthropic, DeepSeek, MiMo). Each platform supplies how
 * a round is sent and how it extends the conversation; the loop owns the
 * rest: the deadline, tool execution, display and the closing done.
 *
 * Rounds run until one answers without calling tools. There is no round cap:
 * the wall clock (TOOL_LOOP_DEADLINE_MS) is what bounds a reply. Once the
 * deadline has passed, one final round goes out with tools switched off, so a
 * reply never ends with tool records but no answer. A stop ends the loop
 * between rounds.
 */
import type { StreamChunk } from '../types.js';
import { createRoundTextSeparator } from './round-text-separator.js';
import {
    createToolUsageTally,
    runToolRound,
    withToolBudget,
    type ExecutedToolCall,
    type ToolUsageTally,
} from './tool-round.js';
import type { ToolCall, TurnTools } from './tool-types.js';

/**
 * Wall-clock budget of one reply's tool loop, counted from its first request.
 *
 * Was 180s, then 300s, then 600s. The round count used to be the other bound
 * (12, then 28, then 50); it is gone, so this clock is the only one: a reply
 * may keep calling tools as long as the model keeps asking for them, and the
 * deadline is what turns the next round into the final, tool-less one.
 */
export const TOOL_LOOP_DEADLINE_MS = 600_000;

export interface CollectedToolRound {
    /** The round's text and thinking chunks, in stream order */
    readonly chunks: readonly StreamChunk[];
    /** Client tool calls the round asked for; none = the round is the answer */
    readonly toolCalls: readonly ToolCall[];
}

export interface ToolLoopOptions<Round extends CollectedToolRound> {
    readonly tools: TurnTools;
    /** Defaults to TOOL_LOOP_DEADLINE_MS */
    readonly deadlineMs?: number;
    readonly signal?: AbortSignal;
    /** Log prefix, e.g. `[openai]` */
    readonly logPrefix: string;
    /** Send and collect one round; `final` = the model may no longer call tools */
    readonly sendRound: (roundIndex: number, final: boolean) => Promise<Round>;
    /** Extend the conversation with a tool round and its results */
    readonly appendRound: (round: Round, executedCalls: readonly ExecutedToolCall[]) => void;
    /** Chunks that follow the answering round's own (e.g. images of the completed response) */
    readonly answerChunks?: (round: Round) => AsyncIterable<StreamChunk>;
    /** rawResponse of the closing done chunk */
    readonly rawResponseOf?: (round: Round) => unknown;
}

/**
 * Why the round about to be sent has to be the final, tool-less one, or null
 * while tools are still offered. Shared by every tool loop; the deadline is
 * the only bound, a reply has no round cap.
 */
export const finalRoundReason = (deadlineAt: number, deadlineMs: number): string | null => {
    if (Date.now() >= deadlineAt) return `Tool loop deadline (${Math.round(deadlineMs / 1000)}s) passed`;
    return null;
};

const doneChunk = (rawResponse: unknown, tally: ToolUsageTally): StreamChunk => {
    const toolUsage = tally.snapshot();
    return {
        type: 'done',
        ...(rawResponse === undefined ? {} : { rawResponse }),
        ...(toolUsage.length > 0 ? { agentStats: { toolUsage } } : {}),
    };
};

export async function* runToolLoop<Round extends CollectedToolRound>(
    options: ToolLoopOptions<Round>
): AsyncGenerator<StreamChunk, void, undefined> {
    const { tools, signal, logPrefix } = options;
    const deadlineMs = options.deadlineMs ?? TOOL_LOOP_DEADLINE_MS;
    const deadlineAt = Date.now() + deadlineMs;
    const tally = createToolUsageTally();
    const separator = createRoundTextSeparator();
    let executedCallCount = 0;

    for (let roundIndex = 0; ; roundIndex++) {
        // A stopped reply sends nothing further
        if (signal?.aborted) {
            yield doneChunk(undefined, tally);
            return;
        }

        const finalReason = finalRoundReason(deadlineAt, deadlineMs);
        if (finalReason !== null) {
            console.log(`${logPrefix} ${finalReason}, forcing final answer`);
        }

        const round = await options.sendRound(roundIndex, finalReason !== null);
        separator.startRound();
        for (const chunk of round.chunks) {
            yield separator.apply(chunk);
        }

        // The answer: a round without calls, or the final round whatever it asks for
        if (finalReason !== null || round.toolCalls.length === 0) {
            if (options.answerChunks) {
                yield* options.answerChunks(round);
            }
            yield doneChunk(options.rawResponseOf?.(round), tally);
            return;
        }

        const executedCalls = yield* runToolRound(tools, round.toolCalls, tally, signal);
        executedCallCount += executedCalls.length;
        // Judged after the calls ran: they may have used up the clock
        options.appendRound(
            round,
            withToolBudget(executedCalls, {
                toolCalls: executedCallCount,
                finalRound: finalRoundReason(deadlineAt, deadlineMs) !== null,
                elapsedMs: deadlineMs - Math.max(0, deadlineAt - Date.now()),
                deadlineMs,
            })
        );
    }
}
