/**
 * One round of client tool calls, shared by every platform's tool loop.
 */
import type { AgentToolUsage, StreamChunk } from '../types.js';
import { isTimeFreeToolName } from '../../reply/tools/tool-names.js';
import type { ToolCall, ToolResult, TurnTools } from './tool-types.js';

export interface ExecutedToolCall {
    readonly call: ToolCall;
    readonly result: ToolResult;
    /** Wall time the handler itself took; charged to the budget unless the tool is free */
    readonly durationMs: number;
}

/**
 * What the model is told about the tool loop after a round: how many calls it
 * has made so far, so it can judge whether one more look is worth it. There is
 * no round cap to announce — the clock is the bound — but the round that used
 * the clock up says the next step has to be the answer.
 */
export const toolRoundNotice = (
    toolCalls: number,
    finalRound: boolean,
    freeRound = false
): string => {
    if (freeRound) {
        return (
            `[工具轮次] 本次回复已调用工具 ${toolCalls} 次；时间已用完，只能再调用不产生开销的工具` +
            '（产物工具 generate_image / send_image / send_sticker / send_file / send_widget，' +
            '工作区工具 workspace_write / workspace_read / workspace_list / workspace_find / workspace_edit / workspace_copy / workspace_delete / workspace_preview，' +
            '以及 get_ui_guide / list_harness_issues / create_harness_issue），之后必须文字收尾。'
        );
    }
    return finalRound
        ? `[工具轮次] 本次回复已调用工具 ${toolCalls} 次；本次调用后不能再调用工具，下一步仅输出文字回复。`
        : `[工具轮次] 本次回复已调用工具 ${toolCalls} 次。`;
};

const secondsOf = (ms: number): number => Math.max(0, Math.round(ms / 1000));

/**
 * The tool budget as the model sees it: tool time spent (the only thing that
 * counts) next to the reply's actual wall time, so it can tell a slow provider
 * from its own tool use. No-cost-tool time is not charged, so a reply can
 * still hand its picture/card/file over after the budget is gone.
 */
export const toolTimeNotice = (timing: {
    readonly elapsedMs: number;
    readonly toolTimeMs: number;
    readonly deadlineMs: number;
}): string =>
    `[时间] 工具实际耗时 ${secondsOf(timing.toolTimeMs)}s / 预算 ${secondsOf(timing.deadlineMs)}s` +
    `（还剩 ${secondsOf(timing.deadlineMs - timing.toolTimeMs)}s）；本次回复实际已用 ` +
    `${secondsOf(timing.elapsedMs)}s。`;

/** What a tool result tells the model about the tool loop it is in */
export interface ToolBudget {
    /** Tool calls executed in this reply so far, this round included */
    readonly toolCalls: number;
    /** The clock makes the next round the final, tool-less one */
    readonly finalRound: boolean;
    /** Past the budget: only no-cost tools can run, and then it is the answer */
    readonly freeRound?: boolean;
    /** Reply wall time, for the model to see (never the budget) */
    readonly elapsedMs: number;
    /** Tool time spent so far, the number the budget is compared with */
    readonly toolTimeMs: number;
    readonly deadlineMs: number;
}

/** The same results with the call count, the last-round notice and the clock appended */
export const withToolBudget = (
    executedCalls: readonly ExecutedToolCall[],
    budget: ToolBudget
): ExecutedToolCall[] =>
    executedCalls.map(({ call, result, durationMs }) => ({
        call,
        durationMs,
        result: {
            ...result,
            content:
                `${result.content}\n\n${
                    toolRoundNotice(budget.toolCalls, budget.finalRound, budget.freeRound === true)
                }\n` +
                toolTimeNotice(budget),
        },
    }));

/**
 * Tool time the reply's budget should charge for: every call's handler time
 * except the free ones. No-cost tools are free on purpose: the product tools
 * hand over what the reply made, the workspace tools finish the draft it is
 * handing over, the harness issue tools report a tool that wasted the model's
 * time, and get_ui_guide reads a static guide — a reply must never be unable
 * to deliver or report because it spent its budget looking. All of them are
 * bounded by their own per-reply limits.
 */
export const toolTimeSpentMs = (executedCalls: readonly ExecutedToolCall[]): number =>
    executedCalls.reduce(
        (total, executed) => (isTimeFreeToolName(executed.call.name) ? total : total + executed.durationMs),
        0
    );

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

        const startedAt = Date.now();
        const result = await tools.execute(call, signal);
        const durationMs = Date.now() - startedAt;
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
        for (const widget of result.widgets ?? []) {
            yield { type: 'widget', widget };
        }
        if (result.record !== null) {
            yield { type: 'grounding', groundingMetadata: result.record };
        }

        executedCalls.push({ call, result, durationMs });
    }

    if (statusShown) {
        yield { type: 'status' };
    }
    return executedCalls;
}
