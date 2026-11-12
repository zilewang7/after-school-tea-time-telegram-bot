/**
 * The client tool loop of the platforms that collect a whole round before
 * showing it (OpenAI, Anthropic, DeepSeek, MiMo). Each platform supplies how
 * a round is sent and how it extends the conversation; the loop owns the
 * rest: the budget, tool execution, display and the closing done.
 *
 * Rounds run until one answers without calling tools. There is no round cap.
 * The budget is the model's *tool* time — the wall time its tool calls took —
 * not the reply's wall clock: a slow provider (a long googleSearch round, a
 * 429 retry, a stalled first token) must not eat the budget the model needs to
 * look around. A large absolute wall cap still bounds the whole reply.
 *
 * Once the tool budget is used up (or the absolute wall is reached), up to
 * FREE_TOOL_ROUNDS_MAX no-cost rounds are allowed: only the tools that cost
 * the reply nothing run — the product tools (generate_image / send_image /
 * send_sticker / send_file / send_widget), the workspace tools (so it can
 * finish a draft it already has), the harness issue tools and get_ui_guide —
 * so a reply never ends unable to hand over what it made or to report a tool
 * that wasted its time. Then the final, tool-less round answers.
 */
import type { StreamChunk } from '../types.js';
import { isTimeFreeToolName } from '../../reply/tools/tool-names.js';
import { createRoundTextSeparator } from './round-text-separator.js';
import {
    createToolUsageTally,
    runToolRound,
    toolTimeSpentMs,
    withToolBudget,
    type ExecutedToolCall,
    type ToolUsageTally,
} from './tool-round.js';
import { filterTurnTools } from './turn-tools.js';
import type { ToolCall, TurnTools } from './tool-types.js';

/**
 * Tool-time budget of one reply: only time spent inside tool calls counts.
 *
 * Was 180s, then 300s, then 600s of wall clock. Wall clock proved wrong under
 * a slow provider: one googleSearch round can stall for minutes (or a 429
 * retry), and the model then got only a couple of tool calls before the final
 * round took its tools away. The clock now measures the tool calls themselves
 * (the no-cost tools are excluded), so the same 600s buys the same exploration
 * no matter how slow the model or the search backend is.
 */
export const TOOL_LOOP_DEADLINE_MS = 600_000;

/**
 * Absolute wall cap of one reply: even while the tool budget stays untouched
 * (slow provider), a reply must end. Generous on purpose — the tool budget is
 * the real bound; this only stops a pathological reply.
 */
export const TOOL_LOOP_WALL_MS = 20 * 60_000;

/**
 * How many no-cost rounds are allowed once the budget is used up. Five rather
 * than three: a reply that ran out of time while finishing a draft needs room
 * to trim it, preview it and still hand it over.
 */
export const FREE_TOOL_ROUNDS_MAX = 5;

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
    /** Defaults to TOOL_LOOP_WALL_MS */
    readonly wallMs?: number;
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

/** Tool time and wall time of one reply; both are checked before a round */
export interface ToolTimeClock {
    readonly startedAt: number;
    /** Tool-time budget; only time inside charged tool calls is added */
    readonly deadlineMs: number;
    /** Absolute wall cap, independent of the tool budget */
    readonly wallMs: number;
    toolTimeMs: number;
}

export const createToolTimeClock = (
    deadlineMs: number,
    wallMs: number,
    startedAt: number = Date.now()
): ToolTimeClock => ({ startedAt, deadlineMs, wallMs, toolTimeMs: 0 });

/** Why the next round has to be the no-cost/final one, or null */
export const budgetExhaustedReason = (clock: ToolTimeClock): string | null => {
    if (clock.toolTimeMs >= clock.deadlineMs) {
        return `Tool budget (${Math.round(clock.deadlineMs / 1000)}s of tool time) used up`;
    }
    if (Date.now() - clock.startedAt >= clock.wallMs) {
        return `Reply wall clock (${Math.round(clock.wallMs / 1000)}s) reached`;
    }
    return null;
};

const freeToolsOf = (tools: TurnTools): TurnTools =>
    filterTurnTools(tools, (name) => isTimeFreeToolName(name));

const hasFreeToolsOf = (tools: TurnTools): boolean =>
    tools.definitions.some((definition) => isTimeFreeToolName(definition.name));

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
    const wallMs = options.wallMs ?? TOOL_LOOP_WALL_MS;
    const clock = createToolTimeClock(deadlineMs, wallMs);
    const tally = createToolUsageTally();
    const separator = createRoundTextSeparator();
    const freeTools = freeToolsOf(tools);
    const hasFreeTools = hasFreeToolsOf(tools);
    let executedCallCount = 0;
    let freeMode = false;
    let freeRounds = 0;
    let forceFinal = false;

    for (let roundIndex = 0; ; roundIndex++) {
        // A stopped reply sends nothing further
        if (signal?.aborted) {
            yield doneChunk(undefined, tally);
            return;
        }

        let mode: 'normal' | 'free' | 'final' = 'normal';
        if (forceFinal) {
            mode = 'final';
        } else if (freeMode) {
            mode = 'free';
        } else {
            const exhausted = budgetExhaustedReason(clock);
            if (exhausted !== null) {
                console.log(
                    `${logPrefix} ${exhausted}, ` +
                        (hasFreeTools ? 'no-cost tools only from here' : 'forcing final answer')
                );
                if (hasFreeTools) {
                    freeMode = true;
                    mode = 'free';
                } else {
                    mode = 'final';
                }
            }
        }

        const round = await options.sendRound(roundIndex, mode === 'final');
        separator.startRound();
        for (const chunk of round.chunks) {
            yield separator.apply(chunk);
        }

        // The answer: a round without calls, or the final round whatever it asks for
        if (mode === 'final' || round.toolCalls.length === 0) {
            if (options.answerChunks) {
                yield* options.answerChunks(round);
            }
            yield doneChunk(options.rawResponseOf?.(round), tally);
            return;
        }

        const activeTools = mode === 'free' ? freeTools : tools;
        const executedCalls = yield* runToolRound(activeTools, round.toolCalls, tally, signal);
        executedCallCount += executedCalls.length;
        if (mode === 'normal') clock.toolTimeMs += toolTimeSpentMs(executedCalls);
        if (mode === 'free') {
            freeRounds += 1;
            if (freeRounds >= FREE_TOOL_ROUNDS_MAX) forceFinal = true;
        }

        const exhaustedAfter = budgetExhaustedReason(clock);
        // Judged after the calls ran: they may have used up the budget
        options.appendRound(
            round,
            withToolBudget(executedCalls, {
                toolCalls: executedCallCount,
                finalRound: exhaustedAfter !== null && !hasFreeTools,
                freeRound: mode === 'free' || (exhaustedAfter !== null && hasFreeTools),
                elapsedMs: Date.now() - clock.startedAt,
                toolTimeMs: clock.toolTimeMs,
                deadlineMs,
            })
        );
    }
}
