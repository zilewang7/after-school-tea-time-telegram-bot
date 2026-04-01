/**
 * OpenAI platform implementation
 */
import OpenAI from 'openai';
import type { Stream } from 'openai/streaming';
import type {
    EasyInputMessage,
    Response,
    ResponseCreateParamsStreaming,
    ResponseInputMessageContentList,
    ResponseStreamEvent,
} from 'openai/resources/responses/responses';
import { BasePlatform } from './base-platform';
import type {
    PlatformType,
    UnifiedMessage,
    UnifiedContentPart,
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
        const supportsThinking = this.isReasoningModel(_model);

        return {
            supportsImageInput: true,
            supportsImageOutput: false,
            supportsSystemPrompt: true,
            requiresMessageMerge: false,
            supportsThinking,
            supportsGrounding: false,
        };
    }

    async sendMessage(
        messages: UnifiedMessage[],
        config: PlatformConfig
    ): Promise<AsyncIterable<StreamChunk>> {
        const { model, systemPrompt, timeout = 85000, maxRetries = 3, signal } = config;
        const capabilities = this.getModelCapabilities(model);

        this.logMessageContents(messages);
        console.log(`[openai] Using model: ${model}, supportsThinking: ${capabilities.supportsThinking}`);

        const input = this.transformToResponsesInput(messages);

        const request: ResponseCreateParamsStreaming = {
            model,
            input,
            instructions: capabilities.supportsSystemPrompt ? systemPrompt ?? null : null,
            stream: true,
            ...(capabilities.supportsThinking
                ? {
                    reasoning: {
                        // Default to xhigh for reasoning-capable models; fallback to high if unsupported.
                        effort: 'xhigh',
                        // Request detailed reasoning summary for thinking output.
                        summary: 'detailed',
                    },
                }
                : {}),
        };

        const stream = await this.sendWithRetry(
            () => this.createResponseStream(request, signal),
            { timeout, maxRetries, signal }
        );

        return this.processStream(stream);
    }

    private isReasoningModel(model: string): boolean {
        const lowerModel = model.toLowerCase();

        // Chat variants are handled as non-reasoning in this app.
        if (lowerModel.includes('chat')) {
            return false;
        }

        // OpenAI reasoning model IDs are currently gpt-5* and o-series families.
        return (
            lowerModel.startsWith('gpt-5') ||
            lowerModel.startsWith('o1') ||
            lowerModel.startsWith('o3') ||
            lowerModel.startsWith('o4')
        );
    }

    private transformToResponsesInput(messages: UnifiedMessage[]): EasyInputMessage[] {
        const input: EasyInputMessage[] = [];

        for (const message of messages) {
            if (message.role === 'system') {
                continue;
            }

            if (message.role === 'assistant') {
                const assistantText = message.content
                    .map((part) => (part.type === 'text' ? (part.text ?? '') : '[assistant image]'))
                    .join('\n');

                input.push({
                    type: 'message',
                    role: 'assistant',
                    content: assistantText,
                });
                continue;
            }

            const content: ResponseInputMessageContentList = message.content.map((part) =>
                this.transformToResponseInputPart(part)
            );

            input.push({
                type: 'message',
                role: 'user',
                content,
            });
        }

        return input;
    }

    private transformToResponseInputPart(part: UnifiedContentPart): ResponseInputMessageContentList[number] {
        if (part.type === 'text') {
            return {
                type: 'input_text',
                text: part.text ?? '',
            };
        }

        return {
            type: 'input_image',
            detail: 'auto',
            image_url: `data:image/png;base64,${part.imageData ?? ''}`,
        };
    }

    private async createResponseStream(
        request: ResponseCreateParamsStreaming,
        signal?: AbortSignal
    ): Promise<Stream<ResponseStreamEvent>> {
        const requestOptions = signal ? { signal } : undefined;

        try {
            const stream = await this.client.responses.create(request, requestOptions);
            return stream as Stream<ResponseStreamEvent>;
        } catch (error) {
            // Some reasoning models don't accept xhigh; fallback to high once.
            if (
                request.reasoning?.effort === 'xhigh' &&
                this.shouldFallbackReasoningEffort(error)
            ) {
                console.warn(
                    `[openai] Model ${request.model} rejected reasoning.effort=xhigh, fallback to high`
                );

                const fallbackRequest: ResponseCreateParamsStreaming = {
                    ...request,
                    reasoning: {
                        ...request.reasoning,
                        effort: 'high',
                    },
                };

                const stream = await this.client.responses.create(fallbackRequest, requestOptions);
                return stream as Stream<ResponseStreamEvent>;
            }

            throw error;
        }
    }

    private shouldFallbackReasoningEffort(error: unknown): boolean {
        const e = error as { status?: number; message?: string; error?: { message?: string } };
        const message = `${e.message ?? ''} ${e.error?.message ?? ''}`.toLowerCase();

        return e.status === 400 && message.includes('reasoning') && message.includes('effort');
    }

    private async *processStream(
        stream: Stream<ResponseStreamEvent>
    ): AsyncIterable<StreamChunk> {
        let completedResponse: Response | null = null;

        for await (const event of stream) {
            if (event.type === 'response.output_text.delta' && event.delta) {
                yield {
                    type: 'text',
                    content: event.delta,
                };
                continue;
            }

            // Prefer full reasoning text, and keep summary as fallback.
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

        yield {
            type: 'done',
            rawResponse: completedResponse,
        };
    }
}
