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
 * What the model is told about the tool loop after a round: how many calls it
 * has made so far, so it can judge whether one more look is worth it. There is
 * no round cap to announce — the clock is the bound — but the round that used
 * the clock up says the next step has to be the answer.
 */
export const toolRoundNotice = (toolCalls: number, finalRound: boolean): string =>
    finalRound
        ? `[工具轮次] 本次回复已调用工具 ${toolCalls} 次；本次调用后不能再调用工具，下一步仅输出文字回复。`
        : `[工具轮次] 本次回复已调用工具 ${toolCalls} 次。`;

const secondsOf = (ms: number): number => Math.max(0, Math.round(ms / 1000));

/**
 * The same budget as a clock: a tool round can take a minute on a big
 * picture-heavy prompt, so the model needs to know how much wall clock is left
 * to spend on looking before it must send (live 1106627/1941: it believed it
 * had rounds left and ran into the tight deadline instead).
 */
export const toolTimeNotice = (timing: { elapsedMs: number; deadlineMs: number }): string =>
    `[时间] 已用 ${secondsOf(timing.elapsedMs)}s / 共 ${secondsOf(timing.deadlineMs)}s，` +
    `还剩 ${secondsOf(timing.deadlineMs - timing.elapsedMs)}s。`;

/** What a tool result tells the model about the tool loop it is in */
export interface ToolBudget {
    /** Tool calls executed in this reply so far, this round included */
    readonly toolCalls: number;
    /** The clock makes the next round the final, tool-less one */
    readonly finalRound: boolean;
    readonly elapsedMs: number;
    readonly deadlineMs: number;
}

/** The same results with the call count, the last-round notice and the clock appended */
export const withToolBudget = (
    executedCalls: readonly ExecutedToolCall[],
    budget: ToolBudget
): ExecutedToolCall[] =>
    executedCalls.map(({ call, result }) => ({
        call,
        result: {
            ...result,
            content:
                `${result.content}\n\n${toolRoundNotice(budget.toolCalls, budget.finalRound)}\n` +
                toolTimeNotice(budget),
        },
    }));

/** Per-reply call counts for agentStats.toolUsage */
export interface ToolUsageTally {
    count(name: string): void;
    /** The call just counted ended in an error result */
    fail(name: string): void;
    snapshot(): AgentToolUsage[];
}

export const createToolUsageTally = (): ToolUsageTally => {
    // Map keeps first-use order, which is the order the usage line shows
    const countsByName = new Map<string, number>();
    const failuresByName = new Map<string, number>();
    return {
        count: (name) => {
            countsByName.set(name, (countsByName.get(name) ?? 0) + 1);
        },
        fail: (name) => {
            failuresByName.set(name, (failuresByName.get(name) ?? 0) + 1);
        },
        snapshot: () =>
            Array.from(countsByName, ([name, count]) => {
                const failed = failuresByName.get(name) ?? 0;
                // Absent when nothing failed, so a clean reply keeps its shape
                return failed > 0 ? { name, count, failed } : { name, count };
            }),
    };
};

/**
 * Runs the calls strictly in order (they may have side effects) and streams
 * what they produce: a status before each call, then its images and record,
 * and a final status clear. Returns the calls with their results.
 *
 * A call naming a tool this turn does not offer still gets its error result,
 * but neither a status line nor a place in the usage tally: nothing ran. An
 * offered call that fails is counted, and marked as failed.
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
        const counted = offeredNames.has(call.name);
        if (counted) {
            tally.count(call.name);
            yield { type: 'status', status: tools.statusOf(call.name) };
            statusShown = true;
        }

        const result = await tools.execute(call, signal);
        if (counted && result.isError) tally.fail(call.name);
        for (const image of result.images) {
            yield {
                type: 'image',
                imageData: image.data,
                imageMimeType: image.mimeType,
                imageCaption: image.caption,
            };
        }
        for (const sticker of result.stickers ?? []) {
            yield { type: 'sticker', sticker };
        }
        for (const file of result.files ?? []) {
            yield { type: 'file', file };
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
