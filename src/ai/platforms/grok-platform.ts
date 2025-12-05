/**
 * Grok (xAI) platform implementation
 */
import OpenAI from 'openai';
import type { Stream } from 'openai/streaming';
import type { ChatCompletionChunk } from 'openai/resources';
import { BasePlatform } from './base-platform';
import { transformToOpenAI } from '../message-transformer';
import type {
    PlatformType,
    UnifiedMessage,
    PlatformConfig,
    StreamChunk,
    ModelCapabilities,
} from '../types';

export class GrokPlatform extends BasePlatform {
    readonly type: PlatformType = 'grok';
    private client: OpenAI;

    constructor() {
        super();
        this.client = new OpenAI({
            baseURL: process.env.GROK_API_URL,
            apiKey: process.env.GROK_API_KEY,
        });
    }

    supportsModel(model: string): boolean {
        return model.toLowerCase().startsWith('grok-');
    }

    getModelCapabilities(model: string): ModelCapabilities {
        const lowerModel = model.toLowerCase();
        // grok-3 and grok-code don't support images
        const noImageSupport =
            lowerModel.startsWith('grok-3') || lowerModel.startsWith('grok-code');

        return {
            supportsImageInput: !noImageSupport,
            supportsImageOutput: false,
            supportsSystemPrompt: true,
            requiresMessageMerge: false,
            supportsThinking: lowerModel.includes('reasoning'),
            supportsGrounding: false,
        };
    }

    async sendMessage(
        messages: UnifiedMessage[],
        config: PlatformConfig
    ): Promise<AsyncIterable<StreamChunk>> {
        const { model, systemPrompt, timeout = 85000, maxRetries = 3 } = config;

        this.logMessageContents(messages);
        console.log(`[grok] Using model: ${model}`);

        const openaiMessages = transformToOpenAI(messages, {
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

        return this.processStream(stream as Stream<ChatCompletionChunk>);
    }

    private async *processStream(
        stream: Stream<ChatCompletionChunk>
    ): AsyncIterable<StreamChunk> {
        for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content;
            if (content) {
                yield {
                    type: 'text',
                    content,
                };
            }
        }

        yield {
            type: 'done',
        };
    }
}
