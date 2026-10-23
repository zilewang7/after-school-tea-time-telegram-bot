/**
 * The client tool loop of the platforms that collect a whole round before
 * showing it (OpenAI, Anthropic, DeepSeek, MiMo). Each platform supplies how
 * a round is sent and how it extends the conversation; the loop owns the
 * rest: round limit, deadline, tool execution, display and the closing done.
 *
 * Rounds run until one answers without calling tools. Once the tool rounds
 * are used up, or the reply is past its deadline, one final round goes out
 * with tools switched off, so a reply never ends with tool records but no
 * answer. A stop ends the loop between rounds.
 */
import type { StreamChunk } from '../types.js';
import { createRoundTextSeparator } from './round-text-separator.js';
import {
    createToolUsageTally,
    runToolRound,
    withToolRoundsLeft,
    type ExecutedToolCall,
    type ToolUsageTally,
} from './tool-round.js';
import type { ToolCall, TurnTools } from './tool-types.js';

/** Wall-clock budget of one reply's tool loop, counted from its first request */
export const TOOL_LOOP_DEADLINE_MS = 180_000;

export interface CollectedToolRound {
    /** The round's text and thinking chunks, in stream order */
    readonly chunks: readonly StreamChunk[];
    /** Client tool calls the round asked for; none = the round is the answer */
    readonly toolCalls: readonly ToolCall[];
}

export interface ToolLoopOptions<Round extends CollectedToolRound> {
    readonly tools: TurnTools;
    /** Rounds that may call tools before the final one */
    readonly maxToolRounds: number;
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
 * Why the round at `roundIndex` (0-based) has to be the final, tool-less one,
 * or null while tools are still offered: `maxToolRounds` rounds have already
 * called tools, or the reply is past its deadline. Shared by every tool loop.
 */
export const finalRoundReason = (
    roundIndex: number,
    maxToolRounds: number,
    deadlineAt: number,
    deadlineMs: number
): string | null => {
    if (roundIndex >= maxToolRounds) return 'Tool round limit reached';
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

/**
 * Tool rounds left after the round at `roundIndex`; 0 when the next one is
 * forced final by the count or the deadline.
 */
const roundsLeftAfter = (
    roundIndex: number,
    maxToolRounds: number,
    deadlineAt: number,
    deadlineMs: number
): number => {
    if (finalRoundReason(roundIndex + 1, maxToolRounds, deadlineAt, deadlineMs) !== null) return 0;
    return Math.max(0, maxToolRounds - roundIndex - 1);
};

export async function* runToolLoop<Round extends CollectedToolRound>(
    options: ToolLoopOptions<Round>
): AsyncGenerator<StreamChunk, void, undefined> {
    const { tools, maxToolRounds, signal, logPrefix } = options;
    const deadlineMs = options.deadlineMs ?? TOOL_LOOP_DEADLINE_MS;
    const deadlineAt = Date.now() + deadlineMs;
    const tally = createToolUsageTally();
    const separator = createRoundTextSeparator();

    for (let roundIndex = 0; ; roundIndex++) {
        // A stopped reply sends nothing further
        if (signal?.aborted) {
            yield doneChunk(undefined, tally);
            return;
        }

        const finalReason = finalRoundReason(roundIndex, maxToolRounds, deadlineAt, deadlineMs);
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
        options.appendRound(
            round,
            withToolRoundsLeft(executedCalls, roundsLeftAfter(roundIndex, maxToolRounds, deadlineAt, deadlineMs))
        );
    }
}
