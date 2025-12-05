/**
 * DeepSeek platform implementation
 */
import OpenAI from 'openai';
import type { Stream } from 'openai/streaming';
import type { ChatCompletionChunk } from 'openai/resources';
import { BasePlatform } from './base-platform';
import { transformToOpenAI, mergeConsecutiveMessages } from '../message-transformer';
import type {
    PlatformType,
    UnifiedMessage,
    PlatformConfig,
    StreamChunk,
    ModelCapabilities,
} from '../types';

// DeepSeek specific delta type with reasoning_content
interface DeepSeekDelta {
    content?: string | null;
    reasoning_content?: string | null;
}

interface DeepSeekChoice {
    delta: DeepSeekDelta;
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call' | null;
    index: number;
}

interface DeepSeekChunk extends ChatCompletionChunk {
    choices: DeepSeekChoice[];
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

        return {
            supportsImageInput: false,
            supportsImageOutput: false,
            supportsSystemPrompt: true,
            requiresMessageMerge: isReasoner,
            supportsThinking: isReasoner,
            supportsGrounding: false,
        };
    }

    async sendMessage(
        messages: UnifiedMessage[],
        config: PlatformConfig
    ): Promise<AsyncIterable<StreamChunk>> {
        const { model, systemPrompt, timeout = 85000, maxRetries = 3 } = config;
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

        const stream = await this.sendWithRetry(
            () =>
                this.client.chat.completions.create({
                    model,
                    messages: openaiMessages,
                    stream: true,
                }),
            { timeout, maxRetries }
        );

        return this.processStream(stream as Stream<DeepSeekChunk>);
    }

    private async *processStream(
        stream: Stream<DeepSeekChunk>
    ): AsyncIterable<StreamChunk> {
        for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta;

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
