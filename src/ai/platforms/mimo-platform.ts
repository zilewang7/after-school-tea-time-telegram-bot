/**
 * MIMO platform implementation (OpenAI-compatible API)
 * Docs: https://platform.xiaomimimo.com/docs/api/chat/openai-api
 */
import OpenAI from 'openai';
import type { Stream } from 'openai/streaming';
import type { ChatCompletionChunk } from 'openai/resources';
import { BasePlatform } from './base-platform.js';
import { transformToMimo, type MimoMessageParam } from '../message-transformer.js';
import { prepareMimoMedia } from './mimo-media.js';
import {
    buildMimoContentFilterError,
    isMimoContentFilterFinishReason,
    isMimoContentFilterNotice,
    isMimoContentFilterNoticePrefix,
} from './mimo-content-filter.js';
import {
    runToolLoop,
    toChatCompletionTools,
    type ToolCall,
    type TurnTools,
} from '../tools/index.js';
import {
    buildChatToolTurn,
    createChatToolCallCollector,
} from './chat-completions/chat-completions-tool-round.js';
import type { ReasoningChunkDelta } from '../../types/api-extensions.js';
import type {
    PlatformType,
    UnifiedMessage,
    PlatformConfig,
    StreamChunk,
    ModelCapabilities,
} from '../types.js';

/** Tool rounds before the forced final one; the model is told what is left */
const MAX_TOOL_ROUNDS = 12;

/** One collected tool-loop round */
interface MimoToolRound {
    readonly chunks: readonly StreamChunk[];
    readonly text: string;
    /** Thinking text; MiMo wants it back with the round's tool calls */
    readonly reasoning: string;
    readonly toolCalls: readonly ToolCall[];
    /** The provider answered with its moderation notice instead */
    readonly blocked: boolean;
}

/**
 * MiMo extends the OpenAI chat parts with `video_url` / `input_audio`, which the
 * OpenAI SDK types do not describe. Cast once, at the request boundary.
 */
const toChatMessageParams = (
    messages: MimoMessageParam[]
): OpenAI.Chat.ChatCompletionMessageParam[] =>
    messages as unknown as OpenAI.Chat.ChatCompletionMessageParam[];

export class MimoPlatform extends BasePlatform {
    readonly type: PlatformType = 'mimo';
    private client: OpenAI;

    constructor() {
        super();
        const baseURL = process.env.MIMO_API_URL || 'https://api.xiaomimimo.com/v1';
        const apiKey = process.env.MIMO_API_KEY || '';

        this.client = new OpenAI({ baseURL, apiKey });
        console.log(`[mimo] Using MIMO API at ${baseURL}`);
    }

    supportsModel(model: string): boolean {
        return model.toLowerCase().startsWith('mimo');
    }

    getModelCapabilities(model: string): ModelCapabilities {
        const lowerModel = model.toLowerCase();
        // mimo-v2.5-pro is text-only (image input answers 404 "No endpoints found
        // that support image input"). It is no longer in the menu but stays
        // routable: it is the text-only model the OCR-fallback e2e run needs.
        const isTextOnlyLegacy = lowerModel === 'mimo-v2.5-pro';

        return {
            supportsImageInput: !isTextOnlyLegacy,
            supportsImageOutput: false,
            supportsSystemPrompt: true,
            requiresMessageMerge: false,
            supportsThinking: true,
            supportsGrounding: false,
            // v2.6 flash / pro read audio and video natively (full-modal)
            supportsMediaInput: lowerModel.startsWith('mimo-v2.6'),
            supportsClientTools: true,
        };
    }

    async sendMessage(
        messages: UnifiedMessage[],
        config: PlatformConfig
    ): Promise<AsyncIterable<StreamChunk>> {
        const { model, systemPrompt, timeout = 85000, maxRetries = 3, signal, tools } = config;

        this.logMessageContents(messages);
        console.log(`[mimo] Using model: ${model}`);

        // Attachments MiMo cannot ingest are transcoded, signed or dropped here
        const preparedMessages = await prepareMimoMedia(messages);
        const openaiMessages = toChatMessageParams(
            transformToMimo(preparedMessages, {
                includeSystemPrompt: true,
                systemPrompt,
            })
        );

        if (tools && tools.definitions.length > 0) {
            return this.sendMessageWithTools(openaiMessages, model, tools, timeout, maxRetries, signal);
        }

        return this.sendMessageDirect(openaiMessages, model, timeout, maxRetries, signal);
    }

    private getRequestBody(model: string) {
        return {
            model,
            // Enable thinking mode - returns reasoning_content in response
            thinking: { type: 'enabled' as const },
        };
    }

    private async *sendMessageDirect(
        messages: OpenAI.Chat.ChatCompletionMessageParam[],
        model: string,
        timeout: number,
        maxRetries: number,
        signal?: AbortSignal
    ): AsyncIterable<StreamChunk> {
        const stream = await this.sendWithRetry(
            () => this.client.chat.completions.create({
                ...this.getRequestBody(model),
                messages,
                stream: true,
            }, { signal }),
            { timeout, maxRetries, signal }
        );

        yield* this.processStream(stream as Stream<ChatCompletionChunk>);
    }

    /**
     * Client tool loop (runToolLoop). MIMO docs: keep reasoning_content in
     * history for multi-turn tool calls, so the assistant message carries it
     * with the calls; the final round sets tool_choice none.
     */
    private async *sendMessageWithTools(
        initialMessages: OpenAI.Chat.ChatCompletionMessageParam[],
        model: string,
        tools: TurnTools,
        timeout: number,
        maxRetries: number,
        signal?: AbortSignal
    ): AsyncGenerator<StreamChunk, void, undefined> {
        const chatTools = toChatCompletionTools(tools.definitions);
        const currentMessages = [...initialMessages];

        yield* runToolLoop<MimoToolRound>({
            tools,
            maxToolRounds: MAX_TOOL_ROUNDS,
            signal,
            logPrefix: '[mimo]',
            sendRound: async (roundIndex, final) => {
                const roundLabel = final ? 'final round' : `round ${roundIndex + 1}/${MAX_TOOL_ROUNDS}`;
                console.log(`[mimo] Tool ${roundLabel}, messages: ${currentMessages.length}`);

                const stream = await this.sendWithRetry(
                    () => this.client.chat.completions.create({
                        ...this.getRequestBody(model),
                        messages: currentMessages,
                        tools: chatTools,
                        ...(final ? { tool_choice: 'none' as const } : {}),
                        stream: true,
                    }, { signal }),
                    { timeout, maxRetries, signal }
                );

                const collected = await this.collectStreamWithTools(stream, roundIndex);
                console.log(`[mimo] Tool ${roundLabel}: ${collected.chunks.length} chunks, ${collected.toolCalls.length} tools, text: ${collected.text.length}, thinking: ${collected.reasoning.length}`);

                // The provider refused this round: fail the turn instead of showing
                // its moderation notice as if the bot had written it
                if (collected.blocked) {
                    console.warn('[mimo] the request was blocked by the provider content filter');
                    throw buildMimoContentFilterError();
                }
                return collected;
            },
            appendRound: (round, executedCalls) => {
                currentMessages.push(
                    ...buildChatToolTurn(round, executedCalls, {
                        supportsImageInput: this.getModelCapabilities(model).supportsImageInput,
                    })
                );
            },
        });
    }

    /**
     * Collect stream, capturing text, thinking, and tool calls.
     *
     * `blocked` is set when MiMo answers with its moderation notice instead of a
     * reply (`finish_reason: content_filter`); the notice text itself is never
     * kept, so it cannot be mistaken for an assistant turn inside the tool loop.
     */
    private async collectStreamWithTools(
        stream: AsyncIterable<ChatCompletionChunk>,
        round: number
    ): Promise<MimoToolRound> {
        const toolCallCollector = createChatToolCallCollector();
        let text = '';
        let reasoning = '';
        let heldNotice = '';
        let blocked = false;
        const chunks: StreamChunk[] = [];

        for await (const chunk of stream) {
            const choice = chunk.choices[0];
            const delta: ReasoningChunkDelta | undefined = choice?.delta;

            // Handle reasoning/thinking content (MIMO thinking mode)
            if (delta?.reasoning_content) {
                reasoning += delta.reasoning_content;
                chunks.push({ type: 'thinking', content: delta.reasoning_content });
            }

            const content = delta?.content ?? '';
            if (isMimoContentFilterFinishReason(choice?.finish_reason) || isMimoContentFilterNotice(content)) {
                blocked = true;
                break;
            }

            // Handle regular text content, holding anything that could still turn
            // out to be the filter notice
            if (content) {
                heldNotice += content;
                if (isMimoContentFilterNoticePrefix(heldNotice)) {
                    continue;
                }
                text += heldNotice;
                chunks.push({ type: 'text', content: heldNotice });
                heldNotice = '';
            }

            toolCallCollector.add(delta?.tool_calls);
        }

        // Text still held when the stream ends never became the notice: it is reply text
        if (!blocked && heldNotice) {
            text += heldNotice;
            chunks.push({ type: 'text', content: heldNotice });
        }

        return { toolCalls: toolCallCollector.toolCalls(round), text, reasoning, chunks, blocked };
    }

    /**
     * Process stream for direct (non-tool) messages
     */
    private async *processStream(
        stream: Stream<ChatCompletionChunk>
    ): AsyncIterable<StreamChunk> {
        let heldNotice = '';

        for await (const chunk of stream) {
            const choice = chunk.choices[0];
            const delta: ReasoningChunkDelta | undefined = choice?.delta;

            // Handle reasoning/thinking content
            if (delta?.reasoning_content) {
                yield { type: 'thinking', content: delta.reasoning_content };
            }

            const content = delta?.content ?? '';
            if (isMimoContentFilterFinishReason(choice?.finish_reason) || isMimoContentFilterNotice(content)) {
                console.warn('[mimo] the request was blocked by the provider content filter');
                throw buildMimoContentFilterError();
            }

            // Handle regular text content, holding anything that could still turn
            // out to be the filter notice (seen both whole and streamed in pieces)
            if (content) {
                heldNotice += content;
                if (isMimoContentFilterNoticePrefix(heldNotice)) {
                    continue;
                }
                yield { type: 'text', content: heldNotice };
                heldNotice = '';
            }
        }

        if (heldNotice) {
            yield { type: 'text', content: heldNotice };
        }

        yield { type: 'done' };
    }
}
