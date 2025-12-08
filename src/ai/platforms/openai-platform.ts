/**
 * OpenAI platform implementation
 */
import OpenAI from 'openai';
import type { Stream } from 'openai/streaming';
import type { ChatCompletion, ChatCompletionChunk } from 'openai/resources';
import { BasePlatform } from './base-platform';
import { transformToOpenAI } from '../message-transformer';
import type {
    PlatformType,
    UnifiedMessage,
    PlatformConfig,
    StreamChunk,
    ModelCapabilities,
} from '../types';

export class OpenAIPlatform extends BasePlatform {
    readonly type: PlatformType = 'openai';
    private client: OpenAI;

    constructor() {
        super();
        this.client = new OpenAI({
            baseURL: process.env.OPENAI_API_URL,
            apiKey: process.env.OPENAI_API_KEY,
        });
    }

    supportsModel(model: string): boolean {
        const lowerModel = model.toLowerCase();
        // OpenAI handles models that don't match other platforms
        return (
            !lowerModel.startsWith('gemini') &&
            !lowerModel.startsWith('deepseek') &&
            !lowerModel.startsWith('grok-')
        );
    }

    getModelCapabilities(_model: string): ModelCapabilities {
        return {
            supportsImageInput: true,
            supportsImageOutput: false,
            supportsSystemPrompt: true,
            requiresMessageMerge: false,
            supportsThinking: false,
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
        console.log(`[openai] Using model: ${model}`);

        const openaiMessages = transformToOpenAI(messages, {
            includeSystemPrompt: capabilities.supportsSystemPrompt,
            systemPrompt,
        });

        const isO1 = model.toLowerCase().startsWith('o1');

        const response = await this.sendWithRetry(
            () =>
                this.client.chat.completions.create({
                    model,
                    messages: openaiMessages,
                    stream: !isO1,
                }),
            { timeout, maxRetries }
        );

        return this.processResponse(response, isO1);
    }

    private async *processResponse(
        response: Stream<ChatCompletionChunk> | ChatCompletion,
        isO1: boolean
    ): AsyncIterable<StreamChunk> {
        if (isO1) {
            // Non-streaming response for O1 models
            const completion = response as ChatCompletion;
            const content = completion.choices[0]?.message.content;
            if (content) {
                yield {
                    type: 'text',
                    content,
                };
            }
        } else {
            // Streaming response
            const stream = response as Stream<ChatCompletionChunk>;
            for await (const chunk of stream) {
                const content = chunk.choices[0]?.delta?.content;
                if (content) {
                    yield {
                        type: 'text',
                        content,
                    };
                }
            }
        }

        yield {
            type: 'done',
            rawResponse: response,
        };
    }
}
