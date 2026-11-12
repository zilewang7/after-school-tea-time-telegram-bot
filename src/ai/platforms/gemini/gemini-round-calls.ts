/**
 * The calls of one Gemini tool loop round, with the checkpoints around them
 * (design 2026-1112-1123 §6.2, moments 2 and 3).
 *
 * Before the first call runs, and after each one before what it produced is
 * yielded, the loop hands over a checkpoint: the round as if it had ended
 * there. Calls not run yet are answered as interrupted. A call the stop
 * landed in comes back from tools.execute as an error result (the abort
 * reached the tool); its answer then says that it may have taken effect.
 * Until every call ran without a stop the round is not over, so the round a
 * resume opens is of the same kind (normal or no-cost) and may call again.
 */
import type { StreamChunk } from '../../types.js';
import { runToolRound, type ExecutedToolCall, type ToolUsageTally } from '../../tools/tool-round.js';
import type { TurnTools } from '../../tools/tool-types.js';
import { toToolCalls, withStoppedDuringCallNote } from './gemini-round-contents.js';
import {
    followExecutedRound,
    type FollowedRound,
    type GeminiLoopLimits,
    type GeminiLoopState,
    type StreamedRound,
} from './gemini-loop-state.js';

/**
 * Hands a checkpoint over: its next round comes from the state `stateAt`
 * works out, called right away and only when someone takes checkpoints;
 * `pendingProducts` are chunks not yielded yet
 */
export type HandOverCheckpoint = (stateAt: () => GeminiLoopState, pendingProducts?: readonly StreamChunk[]) => void;

export interface RoundCallsOptions {
    /** The state as the round's stream completed */
    readonly state: GeminiLoopState;
    readonly round: StreamedRound;
    /** The tools this round may run: all of them, or the no-cost ones */
    readonly tools: TurnTools;
    readonly tally: ToolUsageTally;
    readonly signal: AbortSignal | undefined;
    readonly limits: GeminiLoopLimits;
    /** Reply wall time now */
    readonly elapsedMs: () => number;
    readonly handOver: HandOverCheckpoint;
}

/** The answer a checkpoint keeps for an executed call */
const keptAnswerOf = (executed: ExecutedToolCall, stoppedDuringCall: boolean): ExecutedToolCall =>
    stoppedDuringCall && executed.result.isError
        ? { ...executed, result: withStoppedDuringCallNote(executed.result) }
        : executed;

/**
 * Runs the round's calls and returns what follows the round, or null when
 * the reply was stopped before the first call (the checkpoint taken right
 * before that check keeps the round).
 */
export async function* runRoundCalls(
    options: RoundCallsOptions
): AsyncGenerator<StreamChunk, FollowedRound | null, void> {
    const { state, round, limits, signal, handOver } = options;
    const follow = (executed: readonly ExecutedToolCall[], complete: boolean): FollowedRound =>
        followExecutedRound(state, { round, executed, elapsedMs: options.elapsedMs(), complete }, limits);

    // Before the stop check: a stop right after the stream completed still keeps the round
    handOver(() => follow([], false).state);
    // A stopped reply sends nothing further and runs no tools
    if (signal?.aborted) return null;

    const keptAnswers: ExecutedToolCall[] = [];
    const executedCalls = yield* runToolRound(
        options.tools,
        toToolCalls(round.functionCalls, state.roundNumber),
        options.tally,
        signal,
        {
            onCallExecuted: ({ executed, products, stoppedDuringCall }) => {
                keptAnswers.push(keptAnswerOf(executed, stoppedDuringCall));
                // With calls left, or once stopped, the round is not over: a
                // resume goes on with the same kind of round
                const complete = keptAnswers.length === round.functionCalls.length && signal?.aborted !== true;
                handOver(() => follow(keptAnswers, complete).state, products);
            },
        }
    );
    // After a stop the loop sends nothing further; its last checkpoint is the one above
    return follow(executedCalls, true);
}
