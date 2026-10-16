/**
 * The function calls of one Responses API round, shared by OpenAI and Grok.
 *
 * A round reports its calls twice: one `response.output_item.done` event per
 * item while it streams, and the output list of the response it closes with.
 * Items are read loosely on both sides, since xAI's raw JSON may differ from
 * the SDK types (and relays may drop fields such as output_index).
 */
import type { ResponseFunctionToolCall } from 'openai/resources/responses/responses';
import { isJsonObject } from '../../../shared/json-object.js';
import type { ToolCall } from '../../tools/index.js';

export interface IndexedFunctionCall {
    readonly outputIndex: number;
    readonly item: ResponseFunctionToolCall;
}

/** The streamed function_call items of a round, keyed by output_index */
export type StreamedFunctionCalls = Map<number, ResponseFunctionToolCall>;

export const isFunctionCallItem = (item: unknown): item is ResponseFunctionToolCall =>
    isJsonObject(item) && item.type === 'function_call' && typeof item.name === 'string';

/** Keep the item of a `response.output_item.done` event when it is a function call */
export const collectStreamedFunctionCall = (
    streamedCalls: StreamedFunctionCalls,
    event: { readonly item: unknown; readonly output_index?: unknown }
): void => {
    if (!isFunctionCallItem(event.item)) return;
    // A relay that drops output_index still gets one key per call
    const outputIndex = typeof event.output_index === 'number' ? event.output_index : streamedCalls.size;
    streamedCalls.set(outputIndex, event.item);
};

/** Same calls in the same order: names and arguments match position by position */
const sameCalls = (first: readonly IndexedFunctionCall[], second: readonly IndexedFunctionCall[]): boolean =>
    first.length === second.length &&
    first.every(
        (call, position) =>
            call.item.name === second[position]?.item.name &&
            call.item.arguments === second[position]?.item.arguments
    );

/**
 * The round's function calls in output order, each listed once so it runs
 * once. The closing response is the final word whenever it lists calls:
 * merging it with the stream would run a call twice as soon as the two sides
 * disagree on its call_id (one of them missing it, or a relay minting its
 * own). The streamed items only stand in when the closing response lists no
 * calls (or never arrived). The mismatch warning carries counts only, never
 * arguments.
 */
export const reconcileFunctionCalls = (
    streamedCalls: ReadonlyMap<number, ResponseFunctionToolCall>,
    closingOutput: unknown,
    logPrefix: string
): IndexedFunctionCall[] => {
    const fromStream = Array.from(streamedCalls, ([outputIndex, item]) => ({ outputIndex, item })).sort(
        (first, second) => first.outputIndex - second.outputIndex
    );
    const outputItems: readonly unknown[] = Array.isArray(closingOutput) ? closingOutput : [];
    const fromResponse = outputItems.flatMap((item, outputIndex) =>
        isFunctionCallItem(item) ? [{ outputIndex, item }] : []
    );

    if (fromResponse.length === 0) return fromStream;
    if (!sameCalls(fromStream, fromResponse)) {
        console.warn(
            `${logPrefix} Streamed function calls (${fromStream.length}) differ from the closing response ` +
                `(${fromResponse.length}), using the response's`
        );
    }
    return fromResponse;
};

/** As the tool layer runs it; a call without call_id gets `call_<round>_<output index>` */
export const toToolCall = ({ outputIndex, item }: IndexedFunctionCall, roundIndex: number): ToolCall => ({
    id: item.call_id || `call_${roundIndex}_${outputIndex}`,
    name: item.name,
    argumentsJson: item.arguments ?? '',
});
