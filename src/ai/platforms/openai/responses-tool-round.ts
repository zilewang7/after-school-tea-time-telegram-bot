/**
 * One tool round on the Responses API (OpenAI platform): collect the round's
 * stream, pick out its function calls, and replay the round as messages.
 */
import type {
    EasyInputMessage,
    Response,
    ResponseStreamEvent,
} from 'openai/resources/responses/responses';
import { toolResultText, type ExecutedToolCall, type ToolCall } from '../../tools/index.js';
import type { StreamChunk } from '../../types.js';
import {
    collectStreamedFunctionCall,
    reconcileFunctionCalls,
    toToolCall,
    type StreamedFunctionCalls,
} from '../responses/responses-function-calls.js';

/** Stands in for the assistant text when a round only called tools */
const CALLED_TOOLS_PLACEHOLDER = '[Called tools]';

export interface ResponsesRound {
    /** Text and thinking chunks in stream order */
    readonly chunks: readonly StreamChunk[];
    /** The round's visible text, replayed in the continuation */
    readonly text: string;
    readonly toolCalls: readonly ToolCall[];
    readonly completedResponse: Response | null;
}

/**
 * Consume one round's stream: text / thinking become chunks; the function
 * calls come from `response.completed`, or from the streamed
 * `response.output_item.done` items when it has none (reconcileFunctionCalls).
 */
export const collectResponsesRound = async (
    stream: AsyncIterable<ResponseStreamEvent>,
    round: number
): Promise<ResponsesRound> => {
    const chunks: StreamChunk[] = [];
    const streamedCalls: StreamedFunctionCalls = new Map();
    let text = '';
    let completedResponse: Response | null = null;

    for await (const event of stream) {
        if (event.type === 'response.output_text.delta' && event.delta) {
            text += event.delta;
            chunks.push({ type: 'text', content: event.delta });
            continue;
        }

        if (
            (event.type === 'response.reasoning_text.delta' ||
                event.type === 'response.reasoning_summary_text.delta') &&
            event.delta
        ) {
            chunks.push({ type: 'thinking', content: event.delta });
            continue;
        }

        if (event.type === 'response.output_item.done') {
            collectStreamedFunctionCall(streamedCalls, event);
            continue;
        }

        if (event.type === 'response.completed') {
            completedResponse = event.response;
            continue;
        }

        if (event.type === 'response.failed') {
            throw new Error(event.response.error?.message ?? 'OpenAI response failed');
        }

        if (event.type === 'error') {
            throw new Error(event.message || 'OpenAI stream error');
        }
    }

    const toolCalls = reconcileFunctionCalls(streamedCalls, completedResponse?.output, '[openai]')
        .filter(({ item }) => item.name)
        .map((indexedCall) => toToolCall(indexedCall, round));

    return { chunks, text, toolCalls, completedResponse };
};

/**
 * The round replayed for the next request. ephone rejects `function_call` /
 * `function_call_output` input items, so the round travels as messages: the
 * assistant's text plus a numbered call list, then one developer message per
 * result under the same number.
 */
export const buildToolRoundMessages = (
    roundText: string,
    executedCalls: readonly ExecutedToolCall[]
): EasyInputMessage[] => {
    const callList = executedCalls
        .map(({ call }, index) => `${index + 1}. ${call.name}(${call.argumentsJson})`)
        .join('\n');
    const assistantText = roundText.trim() === '' ? CALLED_TOOLS_PLACEHOLDER : roundText;

    const assistantMessage: EasyInputMessage = {
        type: 'message',
        role: 'assistant',
        content: `${assistantText}\n\n${callList}`,
    };
    const resultMessages = executedCalls.map(
        ({ call, result }, index): EasyInputMessage => ({
            type: 'message',
            role: 'developer',
            content: `Tool #${index + 1} "${call.name}" result:\n${toolResultText(result)}`,
        })
    );

    return [assistantMessage, ...resultMessages];
};
