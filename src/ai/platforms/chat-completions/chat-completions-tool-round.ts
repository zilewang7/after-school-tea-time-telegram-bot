/**
 * One tool round on chat.completions, shared by the OpenAI-compatible
 * platforms (DeepSeek, MiMo): merge the streamed tool call deltas, and replay
 * the round as an assistant message plus one tool message per result.
 */
import type OpenAI from 'openai';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import { toolResultText, type ExecutedToolCall, type ToolCall } from '../../tools/index.js';

/** The assistant message of a tool round, plus the DeepSeek / MiMo `reasoning_content` extension */
type AssistantToolCallMessage = OpenAI.Chat.ChatCompletionAssistantMessageParam & {
    reasoning_content?: string;
};

interface PendingToolCall {
    id: string;
    name: string;
    argumentsJson: string;
}

export interface ChatToolCallCollector {
    /** Merge one chunk's tool call deltas (keyed by their `index`) */
    add(deltas: readonly ChatCompletionChunk.Choice.Delta.ToolCall[] | undefined): void;
    /** Named calls in index order; a missing id is synthesized from round and index */
    toolCalls(round: number): ToolCall[];
}

export const createChatToolCallCollector = (): ChatToolCallCollector => {
    const pendingByIndex = new Map<number, PendingToolCall>();

    return {
        add: (deltas) => {
            for (const delta of deltas ?? []) {
                const pending = pendingByIndex.get(delta.index);
                if (!pending) {
                    pendingByIndex.set(delta.index, {
                        id: delta.id ?? '',
                        name: delta.function?.name ?? '',
                        argumentsJson: delta.function?.arguments ?? '',
                    });
                    continue;
                }
                if (delta.id) pending.id = delta.id;
                if (delta.function?.name) pending.name = delta.function.name;
                if (delta.function?.arguments) pending.argumentsJson += delta.function.arguments;
            }
        },
        toolCalls: (round) =>
            Array.from(pendingByIndex)
                .sort(([firstIndex], [secondIndex]) => firstIndex - secondIndex)
                .filter(([, pending]) => pending.name !== '')
                .map(([index, pending]) => ({
                    id: pending.id || `call_${round}_${index}`,
                    name: pending.name,
                    argumentsJson: pending.argumentsJson,
                })),
    };
};

/**
 * The round replayed for the next request: the assistant message carrying the
 * calls, with the round's reasoning (thinking-mode providers reject a tool
 * continuation without it), then one tool message per result.
 */
export const buildChatToolTurn = (
    round: { readonly text: string; readonly reasoning: string },
    executedCalls: readonly ExecutedToolCall[]
): OpenAI.Chat.ChatCompletionMessageParam[] => {
    const assistantMessage: AssistantToolCallMessage = {
        role: 'assistant',
        content: round.text || null,
        tool_calls: executedCalls.map(({ call }) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.argumentsJson },
        })),
        ...(round.reasoning ? { reasoning_content: round.reasoning } : {}),
    };
    const toolMessages = executedCalls.map(
        ({ call, result }): OpenAI.Chat.ChatCompletionToolMessageParam => ({
            role: 'tool',
            tool_call_id: call.id,
            content: toolResultText(result),
        })
    );

    return [assistantMessage, ...toolMessages];
};
