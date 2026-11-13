/**
 * The Gemini tool loop's checkpoints (design 2026-1112-1123 §6.2): what the
 * loop hands to checkpointSink, and how a resume reads one back.
 *
 * The state is plain data (objects, arrays, strings, numbers, booleans): the
 * reply layer measures a checkpoint by walking it and keeps it for hours, so
 * it never holds a signal, a client, a stream or a closure. It is a value:
 * the loop state is immutable, and the journal, the tool usage and the
 * separator state are copies taken at the hand-over.
 */
import { isMatching, P } from 'ts-pattern';
import type { AgentToolUsage, StreamChunk } from '../../types.js';
import type { RoundTextSeparatorState } from '../../tools/round-text-separator.js';
import type { ToolLoopCheckpoint } from '../../tools/tool-loop-checkpoint.js';
import type { GeminiLoopState } from './gemini-loop-state.js';
import type { ThoughtSummaryFilterState } from './gemini-thought-summary.js';

const GEMINI_CHECKPOINT_KIND = 'gemini-tool-loop';

/** ToolLoopCheckpoint.state of a Gemini checkpoint */
export interface GeminiCheckpointState {
    readonly kind: typeof GEMINI_CHECKPOINT_KIND;
    /** The next round, `loop.request`, is ready to send */
    readonly loop: GeminiLoopState;
    /** Reply wall time used at the snapshot; a resume's clock goes on from it */
    readonly elapsedMs: number;
    readonly separator: RoundTextSeparatorState;
    /** Whether the reply's thinking is a summarizer stream; decided once per reply */
    readonly thoughtSummary: ThoughtSummaryFilterState;
}

/** Everything a checkpoint holds, and everything a resume starts from */
export interface GeminiSnapshot {
    readonly loop: GeminiLoopState;
    readonly elapsedMs: number;
    readonly toolUsage: readonly AgentToolUsage[];
    readonly journal: readonly StreamChunk[];
    readonly separator: RoundTextSeparatorState;
    readonly thoughtSummary: ThoughtSummaryFilterState;
}

export const toGeminiCheckpoint = (snapshot: GeminiSnapshot): ToolLoopCheckpoint => {
    const state: GeminiCheckpointState = {
        kind: GEMINI_CHECKPOINT_KIND,
        loop: snapshot.loop,
        elapsedMs: snapshot.elapsedMs,
        separator: snapshot.separator,
        thoughtSummary: snapshot.thoughtSummary,
    };
    return {
        platform: 'gemini',
        completedRounds: snapshot.loop.roundNumber - 1,
        toolUsage: snapshot.toolUsage,
        journal: snapshot.journal,
        state,
    };
};

const roundRequestPattern = { contents: P.array(), tools: P.array(), final: P.boolean };

/** The shape a resume reads; the parts inside are sent as they are */
const checkpointStatePattern = {
    kind: GEMINI_CHECKPOINT_KIND,
    elapsedMs: P.number,
    separator: { textShown: P.boolean, separatorPending: P.boolean },
    thoughtSummary: { mode: P.union('detecting', 'filtering', 'passthrough'), emitted: P.boolean },
    loop: {
        roundNumber: P.number.int().gte(2),
        request: roundRequestPattern,
        baseRequest: roundRequestPattern,
        toolRounds: P.array({ modelParts: P.array(), responseParts: P.array() }),
        groundings: P.array(),
        executedCallCount: P.number,
        toolTimeMs: P.number,
        freeMode: P.boolean,
        freeRounds: P.number,
        handoffRound: P.boolean,
        mayAskAgain: P.boolean,
    },
};

export const isGeminiCheckpointState = (value: unknown): value is GeminiCheckpointState =>
    isMatching(checkpointStatePattern, value);

/**
 * The snapshot a resume starts from. Throws before anything is sent when the
 * checkpoint belongs to another platform or does not hold a Gemini loop state.
 */
export const geminiSnapshotOf = (checkpoint: ToolLoopCheckpoint): GeminiSnapshot => {
    if (checkpoint.platform !== 'gemini') {
        throw new Error(`Cannot resume a ${checkpoint.platform} checkpoint on the Gemini platform`);
    }
    const { state } = checkpoint;
    if (!isGeminiCheckpointState(state)) {
        throw new Error('Cannot resume: the checkpoint does not hold a Gemini tool loop state');
    }
    if (checkpoint.completedRounds !== state.loop.roundNumber - 1) {
        throw new Error(
            `Cannot resume: the checkpoint keeps ${checkpoint.completedRounds} round(s) but its loop opens round ${state.loop.roundNumber}`
        );
    }
    return {
        loop: state.loop,
        elapsedMs: state.elapsedMs,
        toolUsage: checkpoint.toolUsage,
        journal: checkpoint.journal,
        separator: state.separator,
        thoughtSummary: state.thoughtSummary,
    };
};
