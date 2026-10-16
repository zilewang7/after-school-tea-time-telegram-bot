/**
 * One Grok round, streamed live: text and thinking go out as they arrive,
 * while the round's function calls and its closing response are collected
 * for the tool loop.
 */
import type { Response, ResponseStreamEvent } from 'openai/resources/responses/responses';
import { isJsonObject } from '../../../shared/json-object.js';
import type { RoundTextSeparator, ToolCall } from '../../tools/index.js';
import type { StreamChunk } from '../../types.js';
import {
    collectStreamedFunctionCall,
    reconcileFunctionCalls,
    toToolCall,
    type StreamedFunctionCalls,
} from '../responses/responses-function-calls.js';
import { isResponseObject } from './grok-response-fields.js';

export interface GrokRound {
    /** The response the round closed with; null when the stream ended without one */
    readonly response: Response | null;
    /** xAI cut the round short (`response.incomplete`) */
    readonly incomplete: boolean;
    /**
     * Every function_call item, in output order. All of them are client-side
     * (server-side calls are their own item types) and each needs an answer,
     * whether or not it names a tool the request offered.
     */
    readonly functionCalls: readonly ToolCall[];
}

export interface GrokRoundOptions {
    /** 0-based; part of the id synthesized for a call without one */
    readonly roundIndex: number;
    readonly separator: RoundTextSeparator;
}

interface ClosingResponse {
    readonly response: Response;
    readonly incomplete: boolean;
}

/** completed, incomplete and xAI's `response.done` (unknown to the SDK types) close a round */
const closingResponseOf = (event: ResponseStreamEvent): ClosingResponse | null => {
    if (event.type === 'response.completed') {
        return { response: event.response, incomplete: event.response.status === 'incomplete' };
    }
    if (event.type === 'response.incomplete') {
        return { response: event.response, incomplete: true };
    }

    const rawEvent: unknown = event;
    if (isJsonObject(rawEvent) && rawEvent.type === 'response.done' && isResponseObject(rawEvent.response)) {
        return { response: rawEvent.response, incomplete: rawEvent.response.status === 'incomplete' };
    }
    return null;
};

export async function* streamGrokRound(
    stream: AsyncIterable<ResponseStreamEvent>,
    options: GrokRoundOptions
): AsyncGenerator<StreamChunk, GrokRound, undefined> {
    const streamedCalls: StreamedFunctionCalls = new Map();
    let closing: ClosingResponse | null = null;

    for await (const event of stream) {
        if (event.type === 'response.output_text.delta' && event.delta) {
            yield options.separator.apply({
                type: 'text',
                content: event.delta,
            });
            continue;
        }

        if (
            (event.type === 'response.reasoning_text.delta' ||
                event.type === 'response.reasoning_summary_text.delta') &&
            event.delta
        ) {
            yield {
                type: 'thinking',
                content: event.delta,
            };
            continue;
        }

        if (event.type === 'response.output_item.done') {
            collectStreamedFunctionCall(streamedCalls, event);
            continue;
        }

        if (event.type === 'response.failed') {
            throw new Error(event.response.error?.message ?? 'Grok response failed');
        }

        if (event.type === 'error') {
            throw new Error(event.message || 'Grok stream error');
        }

        closing = closingResponseOf(event) ?? closing;
    }

    const response = closing?.response ?? null;
    return {
        response,
        incomplete: closing?.incomplete ?? false,
        functionCalls: reconcileFunctionCalls(streamedCalls, response?.output, '[grok]').map((call) =>
            toToolCall(call, options.roundIndex)
        ),
    };
}
