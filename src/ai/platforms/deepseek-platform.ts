/**
 * DeepSeek platform implementation
 */
import OpenAI from 'openai';
import type { ChatCompletionChunk } from 'openai/resources';
import { BasePlatform } from './base-platform.js';
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
import type {
    PlatformType,
    UnifiedMessage,
    PlatformConfig,
    StreamChunk,
    ModelCapabilities,
} from '../types.js';

const MAX_TOOL_ROUNDS = 5;

/** One collected tool-loop round */
interface DeepSeekToolRound {
    readonly chunks: readonly StreamChunk[];
    readonly text: string;
    /** Thinking text; thinking mode requires it back with the round's tool calls */
    readonly reasoning: string;
    readonly toolCalls: readonly ToolCall[];
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
        const { model, systemPrompt, timeout = 85000, maxRetries = 3, signal, tools } = config;
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

        // Client tool loop
        if (tools && tools.definitions.length > 0) {
            return this.sendMessageWithTools(openaiMessages, model, tools, timeout, maxRetries, signal);
        }

        const stream = await this.sendWithRetry(
            () =>
                this.client.chat.completions.create({
                    model,
                    messages: openaiMessages,
                    stream: true,
                }, { signal }),
            { timeout, maxRetries, signal }
        );

        return this.processStream(stream);
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
        signal?: AbortSignal
    ): AsyncGenerator<StreamChunk, void, undefined> {
        const chatTools = toChatCompletionTools(tools.definitions);
        const currentMessages = [...initialMessages];

        yield* runToolLoop<DeepSeekToolRound>({
            tools,
            maxToolRounds: MAX_TOOL_ROUNDS,
            signal,
            logPrefix: '[deepseek]',
            sendRound: async (roundIndex, final) => {
                const stream = await this.sendWithRetry(
                    () => this.client.chat.completions.create({
                        model,
                        messages: currentMessages,
                        tools: chatTools,
                        ...(final ? { tool_choice: 'none' as const } : {}),
                        stream: true,
                    }, { signal }),
                    { timeout, maxRetries, signal }
                );
                return this.collectToolRound(stream, roundIndex);
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

        for await (const chunk of stream) {
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

        return { chunks, text, reasoning, toolCalls: toolCallCollector.toolCalls(round) };
    }

    private async *processStream(
        stream: AsyncIterable<ChatCompletionChunk>
    ): AsyncIterable<StreamChunk> {
        for await (const chunk of stream) {
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

        yield {
            type: 'done',
        };
    }
}
