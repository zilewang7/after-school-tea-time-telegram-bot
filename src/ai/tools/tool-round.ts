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

/** The same results with the remaining tool rounds appended to what the model reads */
export const withToolRoundsLeft = (
    executedCalls: readonly ExecutedToolCall[],
    remaining: number
): ExecutedToolCall[] =>
    executedCalls.map(({ call, result }) => ({
        call,
        result: { ...result, content: `${result.content}\n\n${toolRoundsLeftNotice(remaining)}` },
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
