/**
 * DeepSeek platform implementation
 */
import OpenAI from 'openai';
import type { ChatCompletionChunk } from 'openai/resources';
import { BasePlatform } from './base-platform.js';
import { attemptRequestOptions } from './attempt-request-options.js';
import { transformToOpenAI, mergeConsecutiveMessages } from '../message-transformer.js';
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
import {
    INCLUDE_USAGE_STREAM_OPTIONS,
    usageOfChunk,
} from './chat-completions/chat-completions-usage.js';
import { normalizeChatCompletionsUsage } from '../usage/normalize-chat-completions.js';
import type { RoundUsage, UsageSink } from '../usage/usage-types.js';
import {
    effortWireOf,
    isParamRejection,
    logEffortFallback,
    openAIReasoningEffortOf,
    type EffortWire,
    type OpenAIReasoningEffort,
} from './thinking-effort-wire.js';
import type {
    PlatformType,
    UnifiedMessage,
    PlatformConfig,
    StreamChunk,
    ModelCapabilities,
} from '../types.js';

/** The extra chat.completions params a thinkingEffort sends */
interface ChatThinkingParams {
    readonly thinking?: { readonly type: 'enabled' | 'disabled' };
    readonly reasoning_effort?: OpenAIReasoningEffort;
}

/** A 400 that blames the thinking params; every other status keeps its classification */
const EFFORT_REJECTION = /thinking|reasoning|effort/i;

/** One collected tool-loop round */
interface DeepSeekToolRound {
    readonly chunks: readonly StreamChunk[];
    readonly text: string;
    /** Thinking text; thinking mode requires it back with the round's tool calls */
    readonly reasoning: string;
    readonly toolCalls: readonly ToolCall[];
    readonly usage: RoundUsage | null;
}

export class DeepSeekPlatform extends BasePlatform {
    readonly type: PlatformType = 'deepseek';
    private client: OpenAI;

    constructor() {
        super();
        const baseURL = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/v1';
        const apiKey = process.env.DEEPSEEK_API_KEY;

        // Fall back to OpenAI client if no DeepSeek API key
        if (apiKey) {
            this.client = new OpenAI({
                baseURL,
                apiKey,
            });
            console.log(`[deepseek] Using DeepSeek API at ${baseURL}`);
        } else {
            this.client = new OpenAI({
                baseURL: process.env.OPENAI_API_URL,
                apiKey: process.env.OPENAI_API_KEY,
            });
            console.log('[deepseek] Falling back to OpenAI API');
        }
    }

    supportsModel(model: string): boolean {
        return model.toLowerCase().startsWith('deepseek');
    }

    getModelCapabilities(model: string): ModelCapabilities {
        const lowerModel = model.toLowerCase();
        const isReasoner = lowerModel.includes('reasoner');
        // deepseek-flash (V4.1-Flash) reads pictures despite carrying no
        // "vision"/"image" marker in its id
        const supportsImageInput =
            lowerModel.includes('vision') ||
            lowerModel.includes('image') ||
            lowerModel === 'deepseek-flash';

        return {
            supportsImageInput,
            supportsImageOutput: false,
            supportsSystemPrompt: true,
            requiresMessageMerge: isReasoner,
            supportsThinking: isReasoner,
            supportsGrounding: false,
            supportsMediaInput: false,
            supportsClientTools: true,
        };
    }

    async sendMessage(
        messages: UnifiedMessage[],
        config: PlatformConfig
    ): Promise<AsyncIterable<StreamChunk>> {
        const { model, systemPrompt, timeout = 85000, maxRetries = 3, signal, tools, usageSink } = config;
        const capabilities = this.getModelCapabilities(model);

        this.logMessageContents(messages);
        console.log(`[deepseek] Using model: ${model}, requiresMessageMerge: ${capabilities.requiresMessageMerge}`);

        // Apply message merge if needed (for deepseek-reasoner)
        let processedMessages = messages;
        if (capabilities.requiresMessageMerge) {
            processedMessages = mergeConsecutiveMessages(messages);
        }

        const openaiMessages = transformToOpenAI(processedMessages, {
            includeSystemPrompt: true,
            systemPrompt,
        });

        const thinkingWire = effortWireOf(config);

        // Client tool loop
        if (tools && tools.definitions.length > 0) {
            return this.sendMessageWithTools(
                openaiMessages,
                model,
                tools,
                timeout,
                maxRetries,
                signal,
                usageSink,
                thinkingWire
            );
        }

        const stream = await this.openChatWithEffortFallback(
            () =>
                this.sendWithRetry(
                    (attemptSignal) =>
                        this.client.chat.completions.create({
                            model,
                            messages: openaiMessages,
                            stream: true,
                            stream_options: INCLUDE_USAGE_STREAM_OPTIONS,
                            ...this.thinkingParamsOf(thinkingWire),
                        }, attemptRequestOptions(attemptSignal)),
                    { timeout, maxRetries, signal }
                ),
            thinkingWire,
            model
        );

        return this.processStream(stream, usageSink);
    }

    /**
     * The chat.completions params a thinkingEffort adds over the legacy body:
     * nothing for the vendor default, the thinking switch plus
     * reasoning_effort for an explicit level, disabled for 'off'. A degraded
     * wire adds nothing (the provider default is the fallback).
     */
    private thinkingParamsOf(wire: EffortWire | null): ChatThinkingParams {
        if (wire === null || wire.mode === 'default' || wire.degraded) return {};
        if (wire.mode === 'off') return { thinking: { type: 'disabled' } };
        if (wire.value === null) return { thinking: { type: 'enabled' } };
        const effort = openAIReasoningEffortOf(wire.value);
        return {
            thinking: { type: 'enabled' },
            ...(effort === null ? {} : { reasoning_effort: effort }),
        };
    }

    /**
     * One chat request with the reply-wide one-shot thinking downgrade: a 400
     * that blames the thinking params retries the same request without them.
     * 401/404/429 are never a downgrade (see isParamRejection).
     */
    private async openChatWithEffortFallback<T>(
        open: () => Promise<T>,
        wire: EffortWire | null,
        model: string
    ): Promise<T> {
        try {
            return await open();
        } catch (error) {
            if (
                wire === null ||
                wire.degraded ||
                wire.mode === 'default' ||
                !isParamRejection(error, EFFORT_REJECTION)
            ) {
                throw error;
            }
            wire.degraded = true;
            logEffortFallback('deepseek', model, wire.value ?? wire.mode, 'the provider default', error);
            return await open();
        }
    }

    /**
     * Client tool loop (runToolLoop): the assistant message carries the calls
     * and the round's reasoning_content (required back while tools are
     * present), then one tool message per result; the final round sets
     * tool_choice none.
     */
    private async *sendMessageWithTools(
        initialMessages: OpenAI.Chat.ChatCompletionMessageParam[],
        model: string,
        tools: TurnTools,
        timeout: number,
        maxRetries: number,
        signal: AbortSignal | undefined,
        usageSink: UsageSink | undefined,
        thinkingWire: EffortWire | null
    ): AsyncGenerator<StreamChunk, void, undefined> {
        const chatTools = toChatCompletionTools(tools.definitions);
        const currentMessages = [...initialMessages];

        yield* runToolLoop<DeepSeekToolRound>({
            tools,
            signal,
            logPrefix: '[deepseek]',
            sendRound: async (roundIndex, final) => {
                const stream = await this.openChatWithEffortFallback(
                    () =>
                        this.sendWithRetry(
                            (attemptSignal) =>
                                this.client.chat.completions.create({
                                    model,
                                    messages: currentMessages,
                                    tools: chatTools,
                                    ...(final ? { tool_choice: 'none' as const } : {}),
                                    stream: true,
                                    stream_options: INCLUDE_USAGE_STREAM_OPTIONS,
                                    ...this.thinkingParamsOf(thinkingWire),
                                }, attemptRequestOptions(attemptSignal)),
                            { timeout, maxRetries, signal }
                        ),
                    thinkingWire,
                    model
                );
                const round = await this.collectToolRound(stream, roundIndex);
                usageSink?.addRound(round.usage);
                return round;
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

    /** Consume one tool-loop stream: chunks, text, reasoning and tool calls */
    private async collectToolRound(
        stream: AsyncIterable<ChatCompletionChunk>,
        round: number
    ): Promise<DeepSeekToolRound> {
        const toolCallCollector = createChatToolCallCollector();
        const chunks: StreamChunk[] = [];
        let text = '';
        let reasoning = '';
        let usage: unknown;

        for await (const chunk of stream) {
            usage = usageOfChunk(chunk) ?? usage;
            const delta: ReasoningChunkDelta | undefined = chunk.choices[0]?.delta;

            // Handle reasoning content (thinking)
            if (delta?.reasoning_content) {
                reasoning += delta.reasoning_content;
                chunks.push({ type: 'thinking', content: delta.reasoning_content });
            }

            // Handle regular content
            if (delta?.content) {
                text += delta.content;
                chunks.push({ type: 'text', content: delta.content });
            }

            toolCallCollector.add(delta?.tool_calls);
        }

        return {
            chunks,
            text,
            reasoning,
            toolCalls: toolCallCollector.toolCalls(round),
            usage: normalizeChatCompletionsUsage(usage),
        };
    }

    private async *processStream(
        stream: AsyncIterable<ChatCompletionChunk>,
        usageSink: UsageSink | undefined
    ): AsyncIterable<StreamChunk> {
        let usage: unknown;
        for await (const chunk of stream) {
            usage = usageOfChunk(chunk) ?? usage;
            const delta: ReasoningChunkDelta | undefined = chunk.choices[0]?.delta;

            // Handle reasoning content (thinking)
            if (delta?.reasoning_content) {
                yield {
                    type: 'thinking',
                    content: delta.reasoning_content,
                };
            }

            // Handle regular content
            if (delta?.content) {
                yield {
                    type: 'text',
                    content: delta.content,
                };
            }
        }
        usageSink?.addRound(normalizeChatCompletionsUsage(usage));

        yield {
            type: 'done',
        };
    }
}
