/**
 * One Anthropic Messages stream: display chunks plus the raw assistant blocks
 * a tool_use turn is replayed with, and the tool_result blocks that answer it.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { match } from 'ts-pattern';
import { isJsonObject } from '../../../shared/json-object.js';
import { toolResultText, type ExecutedToolCall, type ToolCall } from '../../tools/index.js';
import type { StreamChunk } from '../../types.js';

export interface AnthropicRound {
    /**
     * The assistant turn to replay: thinking, redacted_thinking, text and
     * tool_use blocks verbatim and in order (dropping a thinking block can 400)
     */
    readonly assistantBlocks: Anthropic.ContentBlockParam[];
    readonly toolCalls: readonly ToolCall[];
    readonly stopReason: string | null;
    readonly chunks: readonly StreamChunk[];
}

type StreamEvent = Anthropic.RawMessageStreamEvent;
type StreamEventOf<Type extends StreamEvent['type']> = Extract<StreamEvent, { type: Type }>;

/** What one stream builds up while it is consumed */
interface RoundAccumulator {
    readonly assistantBlocks: Anthropic.ContentBlockParam[];
    /** stream index -> position in assistantBlocks */
    readonly blockPositions: Map<number, number>;
    /** stream index -> partial JSON of a tool_use input still arriving */
    readonly pendingToolJson: Map<number, string>;
    /** tool_use id -> its input JSON exactly as the model produced it */
    readonly toolInputJsonById: Map<string, string>;
    readonly chunks: StreamChunk[];
    stopReason: string | null;
}

const createRoundAccumulator = (): RoundAccumulator => ({
    assistantBlocks: [],
    blockPositions: new Map(),
    pendingToolJson: new Map(),
    toolInputJsonById: new Map(),
    chunks: [],
    stopReason: null,
});

/**
 * The streamed tool input as an object; undefined when it is not a JSON object
 * (the replayed block then keeps `{}`, and the dispatcher reports the bad input)
 */
const parseToolInput = (
    inputJson: string,
    toolName: string
): Record<string, unknown> | undefined => {
    try {
        const parsed: unknown = JSON.parse(inputJson);
        if (isJsonObject(parsed)) return parsed;
    } catch {
        // Reported below
    }
    // Never log the input itself: it may carry private text
    console.warn(`[anthropic] Invalid tool input JSON for ${toolName} (${inputJson.length} chars)`);
    return undefined;
};

const blockAt = (accumulator: RoundAccumulator, streamIndex: number): Anthropic.ContentBlockParam | undefined => {
    const position = accumulator.blockPositions.get(streamIndex);
    return position === undefined ? undefined : accumulator.assistantBlocks[position];
};

const openBlock = (accumulator: RoundAccumulator, streamIndex: number, block: Anthropic.ContentBlockParam): void => {
    accumulator.blockPositions.set(streamIndex, accumulator.assistantBlocks.length);
    accumulator.assistantBlocks.push(block);
};

/** A block starts: keep the kinds a replay needs, ignore the rest */
const onBlockStart = (accumulator: RoundAccumulator, event: StreamEventOf<'content_block_start'>): void =>
    match(event.content_block)
        .with({ type: 'text' }, (block) => openBlock(accumulator, event.index, { type: 'text', text: block.text ?? '' }))
        .with({ type: 'thinking' }, (block) =>
            openBlock(accumulator, event.index, {
                type: 'thinking',
                thinking: block.thinking ?? '',
                signature: block.signature ?? '',
            })
        )
        // Opaque and complete at start: replayed exactly as received
        .with({ type: 'redacted_thinking' }, (block) =>
            openBlock(accumulator, event.index, { type: 'redacted_thinking', data: block.data })
        )
        .with({ type: 'tool_use' }, (block) => {
            openBlock(accumulator, event.index, {
                type: 'tool_use',
                id: block.id,
                name: block.name,
                input: block.input ?? {},
            });
            accumulator.pendingToolJson.set(event.index, '');
        })
        .otherwise(() => undefined);

/** A delta: text and thinking stream out and grow their block; tool input JSON accumulates */
const onBlockDelta = (accumulator: RoundAccumulator, event: StreamEventOf<'content_block_delta'>): void => {
    const target = blockAt(accumulator, event.index);
    match(event.delta)
        .with({ type: 'text_delta' }, ({ text }) => {
            if (!text) return;
            accumulator.chunks.push({ type: 'text', content: text });
            if (target?.type === 'text') target.text += text;
        })
        .with({ type: 'thinking_delta' }, ({ thinking }) => {
            if (!thinking) return;
            accumulator.chunks.push({ type: 'thinking', content: thinking });
            if (target?.type === 'thinking') target.thinking += thinking;
        })
        .with({ type: 'signature_delta' }, ({ signature }) => {
            if (target?.type === 'thinking') target.signature = (target.signature ?? '') + signature;
        })
        .with({ type: 'input_json_delta' }, ({ partial_json }) => {
            const accumulated = accumulator.pendingToolJson.get(event.index);
            if (accumulated !== undefined) {
                accumulator.pendingToolJson.set(event.index, accumulated + partial_json);
            }
        })
        .otherwise(() => undefined);
};

/** A block ends: a tool_use input is complete and gets parsed into its block */
const onBlockStop = (accumulator: RoundAccumulator, event: StreamEventOf<'content_block_stop'>): void => {
    const inputJson = accumulator.pendingToolJson.get(event.index);
    const target = blockAt(accumulator, event.index);
    if (inputJson === undefined || target?.type !== 'tool_use') return;

    accumulator.pendingToolJson.delete(event.index);
    accumulator.toolInputJsonById.set(target.id, inputJson);
    const parsedInput = inputJson ? parseToolInput(inputJson, target.name) : undefined;
    if (parsedInput) {
        target.input = parsedInput;
    }
};

const onMessageDelta = (accumulator: RoundAccumulator, event: StreamEventOf<'message_delta'>): void => {
    accumulator.stopReason = event.delta.stop_reason ?? accumulator.stopReason;
    if (event.delta.stop_reason === 'refusal') {
        console.warn('[anthropic] Response stopped with refusal');
    }
};

const toolCallsOf = (accumulator: RoundAccumulator): ToolCall[] =>
    accumulator.assistantBlocks
        .filter((block): block is Anthropic.ToolUseBlockParam => block.type === 'tool_use')
        .map((block) => ({
            id: block.id,
            name: block.name,
            // The raw streamed JSON; a provider that sends the input whole at start has none
            argumentsJson: accumulator.toolInputJsonById.get(block.id) || JSON.stringify(block.input ?? {}),
        }));

/**
 * Consume one SSE stream: emit display chunks and rebuild the raw assistant
 * content blocks (needed to replay tool_use turns).
 */
export const collectAnthropicRound = async (
    stream: AsyncIterable<StreamEvent>
): Promise<AnthropicRound> => {
    const accumulator = createRoundAccumulator();

    for await (const event of stream) {
        match(event)
            .with({ type: 'content_block_start' }, (startEvent) => onBlockStart(accumulator, startEvent))
            .with({ type: 'content_block_delta' }, (deltaEvent) => onBlockDelta(accumulator, deltaEvent))
            .with({ type: 'content_block_stop' }, (stopEvent) => onBlockStop(accumulator, stopEvent))
            .with({ type: 'message_delta' }, (deltaEvent) => onMessageDelta(accumulator, deltaEvent))
            .otherwise(() => undefined);
    }

    return {
        assistantBlocks: accumulator.assistantBlocks,
        toolCalls: toolCallsOf(accumulator),
        stopReason: accumulator.stopReason,
        chunks: accumulator.chunks,
    };
};

/**
 * One tool_result per executed call, in call order, flagged by the result
 * itself. Pictures meant for the model ride inside the same block, ahead of
 * any later text, which is where the Messages API reads them.
 */
export const toToolResultBlocks = (
    executedCalls: readonly ExecutedToolCall[]
): Anthropic.ToolResultBlockParam[] =>
    executedCalls.map(({ call, result }) => {
        const images = result.modelImages ?? [];
        const text = toolResultText(result);
        return {
            type: 'tool_result',
            tool_use_id: call.id,
            content:
                images.length === 0
                    ? text
                    : [
                          { type: 'text', text },
                          ...images.map(
                              (image): Anthropic.ImageBlockParam => ({
                                  type: 'image',
                                  source: {
                                      type: 'base64',
                                      media_type: image.mimeType,
                                      data: image.data.toString('base64'),
                                  },
                              })
                          ),
                      ],
            is_error: result.isError,
        };
    });
