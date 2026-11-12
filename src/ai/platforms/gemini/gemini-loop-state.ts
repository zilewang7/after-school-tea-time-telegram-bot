/**
 * The Gemini tool loop's state as one immutable value, and what follows a
 * round (design 2026-1112-1123 §6.2).
 *
 * The loop and its checkpoints go through the same transitions: a checkpoint
 * taken halfway through a round's calls is the round with the calls executed
 * so far, counted by the very function that counts a whole round. Such a
 * round is not over, though: the limits judge a round only once all its calls
 * ran, so the round after a partial one is of the same kind again (a resume
 * may re-issue what was interrupted). Pure: the time is passed in, nothing is
 * read or mutated, so a state handed out in a checkpoint never changes
 * afterwards.
 */
import type { FunctionCall, Part } from '@google/genai';
import type { GroundingData } from '../../types.js';
import { budgetExhaustedReasonAt, FREE_TOOL_ROUNDS_MAX } from '../../tools/tool-loop.js';
import { toolTimeSpentMs, withToolBudget, type ExecutedToolCall } from '../../tools/tool-round.js';
import type { ToolResult } from '../../tools/tool-types.js';
import {
    buildFunctionCallingOffParts,
    buildFunctionResponseParts,
    buildRoundContents,
    interruptedCallResult,
    type GeminiToolRound,
} from './gemini-round-contents.js';
import type { GeminiRoundRequest } from './gemini-tool-request.js';

export interface GeminiLoopState {
    /** The round `request` is for */
    readonly roundNumber: number;
    /** That round's request, ready to send */
    readonly request: GeminiRoundRequest;
    /** What round 1 finally sent (a 400 fallback may have changed it): every later round builds on it */
    readonly baseRequest: GeminiRoundRequest;
    /** Each kept round: its model turn verbatim and one answer per call */
    readonly toolRounds: readonly GeminiToolRound[];
    /** Search grounding of every finished round, merged once at the end */
    readonly groundings: readonly GroundingData[];
    /** Tool calls executed in this reply so far */
    readonly executedCallCount: number;
    /** Tool time charged to the budget so far */
    readonly toolTimeMs: number;
    /** Past the budget: only no-cost tools run, then the reply answers */
    readonly freeMode: boolean;
    readonly freeRounds: number;
    /** The one extra round for a final round that still called is not used yet */
    readonly mayAskAgain: boolean;
}

/** The limits of one reply's loop; they never change while it runs */
export interface GeminiLoopLimits {
    readonly deadlineMs: number;
    readonly wallMs: number;
    /** The turn offers no-cost tools: a used-up budget leads to no-cost rounds, not the final one */
    readonly hasFreeTools: boolean;
}

/** What a transition needs of a round whose stream completed */
export interface StreamedRound {
    readonly parts: readonly Part[];
    readonly functionCalls: readonly FunctionCall[];
}

export const initialLoopState = (firstRequest: GeminiRoundRequest): GeminiLoopState => ({
    roundNumber: 1,
    request: firstRequest,
    baseRequest: firstRequest,
    toolRounds: [],
    groundings: [],
    executedCallCount: 0,
    toolTimeMs: 0,
    freeMode: false,
    freeRounds: 0,
    mayAskAgain: true,
});

/** The round streamed through with `sentRequest` (round 1: maybe its fallback) and found this grounding */
export const afterRoundStreamed = (
    state: GeminiLoopState,
    sentRequest: GeminiRoundRequest,
    groundings: readonly GroundingData[]
): GeminiLoopState => ({
    ...state,
    request: sentRequest,
    baseRequest: state.roundNumber === 1 ? sentRequest : state.baseRequest,
    groundings: groundings.length === 0 ? state.groundings : [...state.groundings, ...groundings],
});

/** The next request: round 1's contents followed by these tool rounds */
const requestOn = (
    state: GeminiLoopState,
    toolRounds: readonly GeminiToolRound[],
    final: boolean
): GeminiRoundRequest => ({
    contents: buildRoundContents(state.baseRequest.contents, toolRounds),
    tools: state.baseRequest.tools,
    final,
});

/** Gemini could not produce a call: the same contents once more, as the final round */
export const afterFailedCall = (state: GeminiLoopState): GeminiLoopState => ({
    ...state,
    roundNumber: state.roundNumber + 1,
    request: { ...state.request, final: true },
});

/** A final round still called: its calls are answered as not run, and it is asked once more */
export const afterFinalCalls = (state: GeminiLoopState, round: StreamedRound): GeminiLoopState => {
    const toolRounds = [
        ...state.toolRounds,
        { modelParts: round.parts, responseParts: buildFunctionCallingOffParts(round.functionCalls) },
    ];
    return {
        ...state,
        roundNumber: state.roundNumber + 1,
        mayAskAgain: false,
        toolRounds,
        request: requestOn(state, toolRounds, true),
    };
};

/** A no-cost round that did not call: the no-cost rounds end, the reply answers next */
export const afterFreeModeExit = (state: GeminiLoopState): GeminiLoopState => ({
    ...state,
    roundNumber: state.roundNumber + 1,
    freeMode: false,
    request: { ...state.request, tools: state.baseRequest.tools, final: true },
});

/** A round whose calls ran, all of them or the first few */
export interface ExecutedRoundStep {
    readonly round: StreamedRound;
    /** The calls executed so far, in call order; the calls after them are answered as interrupted */
    readonly executed: readonly ExecutedToolCall[];
    /** Reply wall time at this moment */
    readonly elapsedMs: number;
    /**
     * The round is over: every call ran and no stop landed in it. Only then is
     * the budget judged and a no-cost round counted; a partial step leaves the
     * next round the same kind as this one.
     */
    readonly complete: boolean;
}

export interface FollowedRound {
    readonly state: GeminiLoopState;
    /** Why the budget is used up after a normal round, or null */
    readonly exhausted: string | null;
}

/** One answer per call: the executed ones in order, then the interrupted ones */
const answersFor = (
    functionCalls: readonly FunctionCall[],
    answered: readonly ExecutedToolCall[]
): ToolResult[] => functionCalls.map((_call, index) => answered[index]?.result ?? interruptedCallResult);

const followToolRound = (
    state: GeminiLoopState,
    step: ExecutedRoundStep,
    limits: GeminiLoopLimits
): FollowedRound => {
    const executedCallCount = state.executedCallCount + step.executed.length;
    const toolTimeMs = state.toolTimeMs + toolTimeSpentMs(step.executed);
    // Judged after all the calls ran: they may have used up the budget
    const exhausted = step.complete
        ? budgetExhaustedReasonAt({
              toolTimeMs,
              elapsedMs: step.elapsedMs,
              deadlineMs: limits.deadlineMs,
              wallMs: limits.wallMs,
          })
        : null;
    const final = exhausted !== null && !limits.hasFreeTools;
    const freeMode = exhausted !== null && limits.hasFreeTools;
    // The call count rides in each result, like every other fact the
    // model has to plan around; the last-round notice stays separate.
    const answered = withToolBudget(step.executed, {
        toolCalls: executedCallCount,
        finalRound: final,
        freeRound: freeMode,
        elapsedMs: step.elapsedMs,
        toolTimeMs,
        deadlineMs: limits.deadlineMs,
    });
    const toolRounds = [
        ...state.toolRounds,
        {
            modelParts: step.round.parts,
            responseParts: buildFunctionResponseParts(
                step.round.functionCalls,
                answersFor(step.round.functionCalls, answered),
                { lastToolRound: final }
            ),
        },
    ];
    return {
        exhausted,
        state: {
            ...state,
            roundNumber: state.roundNumber + 1,
            executedCallCount,
            toolTimeMs,
            freeMode,
            toolRounds,
            request: requestOn(state, toolRounds, final),
        },
    };
};

/**
 * Past the budget: no tool time is charged, and the cap of no-cost rounds
 * makes the next one final. A partial no-cost round is not counted yet.
 */
const followFreeRound = (
    state: GeminiLoopState,
    step: ExecutedRoundStep,
    limits: GeminiLoopLimits
): FollowedRound => {
    const freeRounds = step.complete ? state.freeRounds + 1 : state.freeRounds;
    const executedCallCount = state.executedCallCount + step.executed.length;
    const capReached = step.complete && freeRounds >= FREE_TOOL_ROUNDS_MAX;
    const answered = withToolBudget(step.executed, {
        toolCalls: executedCallCount,
        finalRound: capReached,
        freeRound: true,
        elapsedMs: step.elapsedMs,
        toolTimeMs: state.toolTimeMs,
        deadlineMs: limits.deadlineMs,
    });
    const toolRounds = [
        ...state.toolRounds,
        {
            modelParts: step.round.parts,
            responseParts: buildFunctionResponseParts(
                step.round.functionCalls,
                answersFor(step.round.functionCalls, answered),
                { lastToolRound: capReached }
            ),
        },
    ];
    return {
        exhausted: null,
        state: {
            ...state,
            roundNumber: state.roundNumber + 1,
            executedCallCount,
            freeRounds,
            freeMode: !capReached,
            toolRounds,
            request: requestOn(state, toolRounds, capReached),
        },
    };
};

/**
 * What follows a round whose calls ran: the counts, the budget, and the next
 * request with one answer per call. The loop calls it once the round's calls
 * are done (complete); a checkpoint calls it with the calls executed so far.
 */
export const followExecutedRound = (
    state: GeminiLoopState,
    step: ExecutedRoundStep,
    limits: GeminiLoopLimits
): FollowedRound => (state.freeMode ? followFreeRound(state, step, limits) : followToolRound(state, step, limits));
