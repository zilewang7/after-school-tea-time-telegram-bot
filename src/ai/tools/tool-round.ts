/**
 * One round of client tool calls, shared by every platform's tool loop.
 */
import type { AgentToolUsage, StreamChunk } from '../types.js';
import type { ToolCall, ToolResult, TurnTools } from './tool-types.js';

export interface ExecutedToolCall {
    readonly call: ToolCall;
    readonly result: ToolResult;
}

/**
 * What the model is told about the tool-loop budget after a round: the common
 * practice of putting the remaining budget in the tool result itself, so the
 * model can decide between one more look and sending/finishing.
 */
export const toolRoundsLeftNotice = (remaining: number): string =>
    remaining <= 0
        ? '[工具轮次] 本次调用后不能再调用工具了，下一步必须直接用文字回答。'
        : `[工具轮次] 本次调用后最多还能调用工具 ${remaining} 次（用完就只能用文字回答）。`;

const secondsOf = (ms: number): number => Math.max(0, Math.round(ms / 1000));

/**
 * The same budget as a clock: a tool round can take a minute on a big
 * picture-heavy prompt, so the model needs to know how much wall clock is left
 * to spend on looking before it must send (live 1106627/1941: it believed it
 * had rounds left and ran into the tight deadline instead).
 */
export const toolTimeNotice = (timing: { elapsedMs: number; deadlineMs: number }): string =>
    `[时间] 已用 ${secondsOf(timing.elapsedMs)}s / 共 ${secondsOf(timing.deadlineMs)}s，` +
    `还剩 ${secondsOf(timing.deadlineMs - timing.elapsedMs)}s（用尽会被强制收尾，图就发不出去）。`;

/** What a tool result tells the model about its remaining budget */
export interface ToolBudget {
    readonly roundsLeft: number;
    readonly elapsedMs: number;
    readonly deadlineMs: number;
}

/** The same results with the remaining rounds and wall clock appended */
export const withToolBudget = (
    executedCalls: readonly ExecutedToolCall[],
    budget: ToolBudget
): ExecutedToolCall[] =>
    executedCalls.map(({ call, result }) => ({
        call,
        result: {
            ...result,
            content:
                `${result.content}\n\n${toolRoundsLeftNotice(budget.roundsLeft)}\n` +
                toolTimeNotice(budget),
        },
    }));

/** Per-reply call counts for agentStats.toolUsage */
export interface ToolUsageTally {
    count(name: string): void;
    snapshot(): AgentToolUsage[];
}

export const createToolUsageTally = (): ToolUsageTally => {
    // Map keeps first-use order, which is the order the usage line shows
    const countsByName = new Map<string, number>();
    return {
        count: (name) => {
            countsByName.set(name, (countsByName.get(name) ?? 0) + 1);
        },
        snapshot: () => Array.from(countsByName, ([name, count]) => ({ name, count })),
    };
};

/**
 * Runs the calls strictly in order (they may have side effects) and streams
 * what they produce: a status before each call, then its images and record,
 * and a final status clear. Returns the calls with their results.
 *
 * A call naming a tool this turn does not offer still gets its error result,
 * but neither a status line nor a place in the usage tally: nothing ran.
 */
export async function* runToolRound(
    tools: TurnTools,
    calls: readonly ToolCall[],
    tally: ToolUsageTally,
    signal?: AbortSignal
): AsyncGenerator<StreamChunk, ExecutedToolCall[], void> {
    const offeredNames = new Set(tools.definitions.map((definition) => definition.name));
    const executedCalls: ExecutedToolCall[] = [];
    let statusShown = false;

    for (const call of calls) {
        if (offeredNames.has(call.name)) {
            tally.count(call.name);
            yield { type: 'status', status: tools.statusOf(call.name) };
            statusShown = true;
        }

        const result = await tools.execute(call, signal);
        for (const image of result.images) {
            yield {
                type: 'image',
                imageData: image.data,
                imageMimeType: image.mimeType,
                imageCaption: image.caption,
            };
        }
        if (result.record !== null) {
            yield { type: 'grounding', groundingMetadata: result.record };
        }

        executedCalls.push({ call, result });
    }

    if (statusShown) {
        yield { type: 'status' };
    }
    return executedCalls;
}
