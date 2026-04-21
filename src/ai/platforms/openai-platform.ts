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
        const isImageModel = this.isImageGenerationModel(_model);

        return {
            supportsImageInput: true,
            supportsImageOutput: isImageModel,
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

        // Handle image generation models separately
        if (capabilities.supportsImageOutput) {
            return this.generateImage(messages, config);
        }

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

    private isImageGenerationModel(model: string): boolean {
        const lowerModel = model.toLowerCase();
        return lowerModel.includes('image') || lowerModel.startsWith('dall-e');
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

    private async *generateImage(
        messages: UnifiedMessage[],
        config: PlatformConfig
    ): AsyncIterable<StreamChunk> {
        const { model, timeout = 120000, maxRetries = 50, signal } = config;

        console.log('[openai] Generating image with model:', model);

        // Extract prompt and reference images from messages
        let prompt = '';
        const referenceImages: string[] = [];

        for (const message of messages) {
            for (const part of message.content) {
                if (part.type === 'text') {
                    prompt += part.text ?? '';
                } else if (part.type === 'image' && part.imageData) {
                    referenceImages.push(part.imageData);
                }
            }
        }

        if (!prompt) {
            throw new Error('No prompt provided for image generation');
        }

        console.log('[openai] Image generation:', {
            promptLength: prompt.length,
            referenceImageCount: referenceImages.length,
        });

        // Generate image using OpenAI Images API
        const generateFn = async () => {
            // If we have reference images, use edit or variation
            if (referenceImages.length > 0 && referenceImages[0]) {
                // For now, use the first reference image for variation
                // Note: OpenAI's edit API requires a mask, so we use createVariation instead
                const imageBuffer = Buffer.from(referenceImages[0], 'base64');
                const uint8Array = new Uint8Array(imageBuffer);
                const imageBlob = new Blob([uint8Array], { type: 'image/png' });
                const imageFile = new File([imageBlob], 'image.png', { type: 'image/png' });

                // If we have a prompt, we can't use variation (it doesn't support prompts)
                // So we'll just do text-to-image and ignore the reference
                if (prompt) {
                    console.log('[openai] Reference image provided but using text-to-image (variation API does not support prompts)');
                    const response = await this.client.images.generate({
                        model,
                        prompt,
                        n: 1,
                        response_format: 'b64_json',
                        size: '1024x1024',
                    });

                    return response;
                } else {
                    // No prompt, use variation
                    const response = await this.client.images.createVariation({
                        model,
                        image: imageFile,
                        n: 1,
                        response_format: 'b64_json',
                        size: '1024x1024',
                    });

                    return response;
                }
            } else {
                // Text-to-image generation
                const response = await this.client.images.generate({
                    model,
                    prompt,
                    n: 1,
                    response_format: 'b64_json',
                    size: '1024x1024',
                });

                return response;
            }
        };

        // Use retry logic from base platform
        const response = await this.sendWithRetry(generateFn, { timeout, maxRetries, signal });

        // Convert response to stream chunks
        if (response.data && response.data.length > 0 && response.data[0]) {
            const imageData = response.data[0].b64_json;
            if (imageData) {
                yield {
                    type: 'image',
                    imageData: Buffer.from(imageData, 'base64'),
                };
            } else {
                throw new Error('No image data in response');
            }
        } else {
            throw new Error('No image generated');
        }

        yield {
            type: 'done',
            rawResponse: response,
        };
    }
}
