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

const IMAGE_PROXY_MODEL = 'gpt-5.4';

const IMAGE_GENERATION_TOOL = {
    type: 'function' as const,
    name: 'generate_image',
    description: 'Generate or edit an image. Use when the user requests image creation, editing, or modification.',
    parameters: {
        type: 'object' as const,
        properties: {
            prompt: {
                type: 'string' as const,
                description: 'Detailed image generation/editing prompt in English. IMPORTANT: Do NOT refer to images by index or number (e.g. "first image", "image 1"). Instead, describe each image by its visual characteristics (e.g. "the large mural portrait with aged wall texture", "the small imperial portrait in red robe"). This ensures the editing API correctly identifies each image regardless of order.',
            },
            reference_image_indices: {
                type: 'array' as const,
                items: { type: 'integer' as const },
                description: 'Indices of images to pass to the editing API (see image list in instructions). Put the base image (the one to be modified) LAST in the array; other reference images go before it. Omit for text-to-image generation from scratch.',
            },
        },
        required: ['prompt'],
    },
};

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
        let { model, systemPrompt, timeout = 85000, maxRetries = 3, signal, isImageModel } = config;
        const capabilities = this.getModelCapabilities(model);

        if (capabilities.supportsImageOutput) {
            // Chat flow: proxy through gpt-5.4 with image generation tool
            if (systemPrompt) {
                return this.sendImageChatMessage(messages, config);
            }
            // Direct image generation (/picgpt command)
            return this.generateImage(messages, config);
        }

        this.logMessageContents(messages);
        console.log(`[openai] Using model: ${model}, supportsThinking: ${capabilities.supportsThinking}, isImageModel: ${isImageModel}`);

        const input = this.transformToResponsesInput(messages);

        const request: ResponseCreateParamsStreaming = {
            model,
            input,
            instructions: capabilities.supportsSystemPrompt ? systemPrompt ?? null : null,
            stream: true,
            ...(capabilities.supportsThinking
                ? {
                    reasoning: {
                        effort: 'xhigh',
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

        // Extract images from completed response output items
        if (completedResponse?.output) {
            for (const item of completedResponse.output) {
                const imageData = await this.extractImageFromOutput(item);
                if (imageData) {
                    yield { type: 'image', imageData };
                }
            }
        }

        yield {
            type: 'done',
            rawResponse: completedResponse,
        };
    }

    private async *sendImageChatMessage(
        messages: UnifiedMessage[],
        config: PlatformConfig
    ): AsyncIterable<StreamChunk> {
        const { model, systemPrompt, timeout = 85000, maxRetries = 3, signal } = config;

        this.logMessageContents(messages);
        console.log(`[openai] Image chat mode: proxy ${model} through ${IMAGE_PROXY_MODEL} with tool`);

        const input = this.transformToResponsesInput(messages);
        const referenceImages = this.collectReferenceImages(messages);

        const imageMetaList: { size: number; source: string }[] = [];
        for (const message of messages) {
            for (const part of message.content) {
                if (part.type === 'image' && part.imageData) {
                    imageMetaList.push({
                        size: Math.round(part.imageData.length * 3 / 4 / 1024),
                        source: message.role === 'user' ? 'user upload' : 'generated',
                    });
                }
            }
        }

        const imageListStr = imageMetaList.length > 0
            ? '\nImages in conversation:\n' +
              imageMetaList.map((meta, i) =>
                  `  [${i}] ${meta.size}KB (${meta.source})`
              ).join('\n') +
              '\nSet reference_image_indices to select images for editing. Put the base image (to be modified) LAST; reference images go before it. Prefer original user uploads over previously generated images. Omit for text-to-image generation from scratch.'
            : '';

        const imageInstructions =
            'You have image generation capability via the generate_image tool. ' +
            'When the user asks to create, edit, or modify images, call the generate_image tool with a detailed English prompt. ' +
            'You may include a text reply alongside the tool call if you wish.' +
            imageListStr;

        const request: ResponseCreateParamsStreaming = {
            model: IMAGE_PROXY_MODEL,
            input,
            instructions: (systemPrompt || '') + '\n\n' + imageInstructions,
            stream: true,
            tools: [IMAGE_GENERATION_TOOL as any],
            ...(this.isReasoningModel(IMAGE_PROXY_MODEL)
                ? { reasoning: { effort: 'high', summary: 'detailed' } }
                : {}),
        };

        const stream = await this.sendWithRetry(
            () => this.createResponseStream(request, signal),
            { timeout, maxRetries, signal }
        );

        yield* this.processImageChatStream(stream, model, referenceImages, input, request.instructions ?? '', signal);
    }

    private async *processImageChatStream(
        stream: Stream<ResponseStreamEvent>,
        imageModel: string,
        referenceImages: string[],
        originalInput: EasyInputMessage[],
        instructions: string,
        signal?: AbortSignal
    ): AsyncIterable<StreamChunk> {
        let completedResponse: Response | null = null;
        let functionCallArgs = '';
        let functionCallName = '';
        let hasFunctionCall = false;
        let assistantText = '';

        for await (const event of stream) {
            if (event.type === 'response.output_text.delta' && event.delta) {
                assistantText += event.delta;
                yield { type: 'text', content: event.delta };
                continue;
            }

            if (
                (event.type === 'response.reasoning_text.delta' ||
                    event.type === 'response.reasoning_summary_text.delta') &&
                event.delta
            ) {
                yield { type: 'thinking', content: event.delta };
                continue;
            }

            if (event.type === 'response.function_call_arguments.delta') {
                functionCallArgs += (event as Record<string, any>).delta ?? '';
                continue;
            }

            if (event.type === 'response.function_call_arguments.done') {
                hasFunctionCall = true;
                const doneEvent = event as Record<string, any>;
                functionCallName = doneEvent.name || functionCallName;
                functionCallArgs = doneEvent.arguments ?? functionCallArgs;
                continue;
            }

            if (event.type === 'response.output_item.done') {
                const item = (event as Record<string, any>).item;
                if (item?.type === 'function_call') {
                    hasFunctionCall = true;
                    functionCallName = item.name ?? functionCallName;
                    functionCallArgs = item.arguments ?? functionCallArgs;
                }
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

        console.log('[openai] Image chat stream done:', { hasFunctionCall, functionCallName, argsLength: functionCallArgs.length, assistantTextLength: assistantText.length });

        if (hasFunctionCall && functionCallName === 'generate_image') {
            let toolOutput = 'Image generation failed.';
            try {
                const args = JSON.parse(functionCallArgs) as {
                    prompt: string;
                    reference_image_indices?: number[];
                };

                const indices = (args.reference_image_indices ?? [])
                    .filter(i => i >= 0 && i < referenceImages.length);
                const selectedImages = indices.map(i => referenceImages[i]!);

                console.log('[openai] Tool call generate_image:', {
                    prompt: args.prompt,
                    referenceImageIndices: indices.length > 0 ? indices : 'none (generate from scratch)',
                    apiOrder: indices.map(i => `[${i}] ${Math.round(referenceImages[i]!.length * 3 / 4 / 1024)}KB`),
                    allImages: referenceImages.map((img, i) => `[${i}] ${Math.round(img.length * 3 / 4 / 1024)}KB`),
                    imageModel,
                });
                const imageBuffer = await this.executeImageGeneration(imageModel, args.prompt, selectedImages, signal);
                yield { type: 'image', imageData: imageBuffer };
                toolOutput = 'Image generated and sent to the user successfully.';
            } catch (error) {
                console.error('[openai] Image generation tool failed:', error);
                const errorMsg = error instanceof Error ? error.message : String(error);
                toolOutput = `Image generation failed: ${errorMsg}`;
                yield { type: 'text', content: `\n\n[Image generation failed: ${errorMsg}]` };
            }

            // Tool result callback via regular messages (proxy doesn't support function_call items)
            try {
                console.log('[openai] Sending tool result callback as regular message');
                const continueInput: EasyInputMessage[] = [
                    ...originalInput,
                    {
                        role: 'assistant',
                        content: assistantText || '[Called generate_image tool]',
                    },
                    {
                        role: 'developer',
                        content: `The generate_image tool has been executed. ${toolOutput} The image is already delivered to the user alongside your message. You may now briefly comment on the result if appropriate.`,
                    },
                ];
                const continueRequest: ResponseCreateParamsStreaming = {
                    model: IMAGE_PROXY_MODEL,
                    input: continueInput,
                    instructions,
                    stream: true,
                };

                const continueStream = await this.createResponseStream(continueRequest, signal);

                for await (const event of continueStream) {
                    if (event.type === 'response.output_text.delta' && event.delta) {
                        yield { type: 'text', content: event.delta };
                        continue;
                    }
                    if (
                        (event.type === 'response.reasoning_text.delta' ||
                            event.type === 'response.reasoning_summary_text.delta') &&
                        event.delta
                    ) {
                        yield { type: 'thinking', content: event.delta };
                        continue;
                    }
                    if (event.type === 'response.completed') {
                        completedResponse = event.response;
                        continue;
                    }
                    if (event.type === 'response.failed') {
                        console.error('[openai] Tool callback response failed:', event.response.error);
                        break;
                    }
                    if (event.type === 'error') {
                        console.error('[openai] Tool callback stream error:', event.message);
                        break;
                    }
                }
            } catch (error) {
                console.error('[openai] Tool result callback failed:', error);
            }
        }

        if (completedResponse?.output) {
            for (const item of completedResponse.output) {
                const imageData = await this.extractImageFromOutput(item);
                if (imageData) {
                    yield { type: 'image', imageData };
                }
            }
        }

        yield { type: 'done', rawResponse: completedResponse };
    }

    private collectReferenceImages(messages: UnifiedMessage[]): string[] {
        const images: string[] = [];
        for (const message of messages) {
            for (const part of message.content) {
                if (part.type === 'image' && part.imageData) {
                    images.push(part.imageData);
                }
            }
        }
        return images;
    }

    private async executeImageGeneration(
        imageModel: string,
        prompt: string,
        referenceImages: string[],
        signal?: AbortSignal
    ): Promise<Buffer> {
        const imageFiles = referenceImages.map((img, i) => {
            const buffer = Buffer.from(img, 'base64');
            return new File([new Uint8Array(buffer)], `reference_${i}.png`, { type: 'image/png' });
        });

        const generateFn = async () => {
            if (imageFiles.length > 0) {
                console.log(`[openai] Tool: images.edit with ${imageFiles.length} reference image(s):`,
                    imageFiles.map((f, i) => `[${i}] ${f.name} ${Math.round(f.size / 1024)}KB`));
                return this.client.images.edit({
                    model: imageModel,
                    image: imageFiles as any,
                    prompt,
                    n: 1,
                    size: 'auto',
                });
            }
            console.log('[openai] Tool: images.generate');
            return this.client.images.generate({
                model: imageModel,
                prompt,
                n: 1,
                size: 'auto',
            });
        };

        const response = await this.sendWithRetry(generateFn, {
            timeout: 120000,
            maxRetries: 10,
            signal,
        });

        return this.extractImageBuffer(response);
    }

    private async extractImageBuffer(
        response: { data?: Array<{ url?: string | null; b64_json?: string | null }> }
    ): Promise<Buffer> {
        const item = response.data?.[0];
        if (!item) throw new Error('No image generated');

        if (item.url) {
            console.log('[openai] Downloading image from URL');
            const resp = await fetch(item.url);
            if (!resp.ok) throw new Error(`Failed to download image: ${resp.status}`);
            const buf = Buffer.from(await resp.arrayBuffer());
            console.log('[openai] Image buffer:', { size: buf.length, magicHex: buf.subarray(0, 8).toString('hex') });
            return buf;
        }

        if (item.b64_json) {
            const buf = Buffer.from(item.b64_json, 'base64');
            console.log('[openai] Image buffer (b64):', { size: buf.length, magicHex: buf.subarray(0, 8).toString('hex') });
            return buf;
        }

        throw new Error('No image URL or data in response');
    }

    private async *generateImage(
        messages: UnifiedMessage[],
        config: PlatformConfig
    ): AsyncIterable<StreamChunk> {
        const { model, signal } = config;

        this.logMessageContents(messages);
        console.log('[openai] Generating image with model:', model);

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

        if (!prompt) throw new Error('No prompt provided for image generation');

        console.log('[openai] Image generation:', { prompt, referenceImageCount: referenceImages.length });

        const imgBuffer = await this.executeImageGeneration(model, prompt, referenceImages, signal);
        yield { type: 'image' as const, imageData: imgBuffer };
        yield { type: 'done' };
    }

    private async extractImageFromOutput(item: unknown): Promise<Buffer | null> {
        const outputItem = item as Record<string, unknown>;

        if (outputItem.type === 'image_generation_call') {
            const result = outputItem.result;
            if (typeof result === 'string' && result.length > 0) {
                if (result.startsWith('http')) {
                    console.log('[openai] Downloading image from response output URL');
                    const resp = await fetch(result);
                    if (resp.ok) {
                        const buf = Buffer.from(await resp.arrayBuffer());
                        console.log('[openai] Image from output:', { size: buf.length, magicHex: buf.subarray(0, 8).toString('hex') });
                        return buf;
                    }
                }
                const buf = Buffer.from(result, 'base64');
                console.log('[openai] Image from output:', { size: buf.length, magicHex: buf.subarray(0, 8).toString('hex') });
                return buf;
            }
            console.log('[openai] image_generation_call without usable result:', JSON.stringify(outputItem).slice(0, 300));
        }

        return null;
    }

}
