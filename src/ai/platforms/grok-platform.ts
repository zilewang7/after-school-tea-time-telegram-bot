/**
 * Grok (xAI) platform implementation
 */
import OpenAI from 'openai';
import type { Stream } from 'openai/streaming';
import type {
    EasyInputMessage,
    ResponseCreateParamsStreaming,
    ResponseInputMessageContentList,
    ResponseStreamEvent,
} from 'openai/resources/responses/responses';
import { BasePlatform } from './base-platform.js';
import { toVisionImageMimeType } from '../supported-mime.js';
import { NO_TURN_TOOLS, type TurnTools } from '../tools/index.js';
import {
    buildCandidateRequests,
    buildSearchTools,
    describeTools,
    functionToolNames,
    grokReasoningFor,
    isGrokMultiAgentModel,
    isUnsupportedFeatureError,
    toGrokFunctionTools,
    type GrokResponseRequest,
} from './grok/grok-request.js';
import { runGrokToolLoop } from './grok/grok-tool-loop.js';
import type {
    PlatformType,
    UnifiedMessage,
    UnifiedContentPart,
    PlatformConfig,
    StreamChunk,
    ModelCapabilities,
} from '../types.js';

/** Round 1's stream and the candidate xAI accepted for it */
interface FirstRound {
    readonly stream: Stream<ResponseStreamEvent>;
    readonly request: GrokResponseRequest;
}

const errorMessageOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

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
        const supportsThinking =
            lowerModel.includes('reasoning') || lowerModel.includes('multi-agent');

        return {
            supportsImageInput: !noImageSupport,
            supportsImageOutput: false,
            supportsSystemPrompt: true,
            requiresMessageMerge: false,
            supportsThinking,
            supportsGrounding: true,
            supportsMediaInput: false,
            // Multi-agent models reject client-side tools (400 without beta access)
            supportsClientTools: !isGrokMultiAgentModel(model),
        };
    }

    /**
     * One reply, streamed live. With client tools (never on multi-agent
     * models) each round that calls them continues on the same response chain;
     * without, it is the single request it has always been.
     */
    async sendMessage(
        messages: UnifiedMessage[],
        config: PlatformConfig
    ): Promise<AsyncIterable<StreamChunk>> {
        const { model, systemPrompt, timeout = 85000, maxRetries = 3, signal } = config;
        const clientTools = this.clientToolsOf(config);
        const functionTools = clientTools ? toGrokFunctionTools(clientTools.definitions) : [];
        const tools = buildSearchTools();

        this.logMessageContents(messages);
        console.log(`[grok] Using model: ${model}`, {
            tools: tools.map((tool) => tool.type),
            clientTools: functionTools.length,
        });

        const request: GrokResponseRequest = {
            model,
            input: this.transformToResponsesInput(messages, systemPrompt),
            stream: true,
            tools,
            reasoning: grokReasoningFor(model),
            max_turns: 10,
            parallel_tool_calls: true,
        };
        const candidates = buildCandidateRequests(request, functionTools);
        const retryOptions = { timeout, maxRetries, signal };

        const startedAt = Date.now();
        const firstRound = await this.sendWithRetry(
            () => this.openFirstRound(candidates, functionTools.length > 0, signal),
            retryOptions
        );

        return runGrokToolLoop({
            model,
            firstStream: firstRound.stream,
            acceptedRequest: firstRound.request,
            tools: clientTools ?? NO_TURN_TOOLS,
            startedAt,
            signal,
            supportsImageInput: this.getModelCapabilities(model).supportsImageInput,
            openContinuation: (continuation) =>
                this.sendWithRetry(() => this.createResponseStream(continuation, signal), retryOptions),
        });
    }

    /** The turn's client tools; null without definitions or on a multi-agent model */
    private clientToolsOf({ model, tools }: PlatformConfig): TurnTools | null {
        if (!tools || tools.definitions.length === 0 || isGrokMultiAgentModel(model)) {
            return null;
        }
        return tools;
    }

    private transformToResponsesInput(
        messages: UnifiedMessage[],
        systemPrompt?: string
    ): EasyInputMessage[] {
        const input: EasyInputMessage[] = [];

        if (systemPrompt) {
            input.push({
                type: 'message',
                role: 'system',
                content: systemPrompt,
            });
        }

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

    private transformToResponseInputPart(
        part: UnifiedContentPart
    ): ResponseInputMessageContentList[number] {
        if (part.type === 'text') {
            return {
                type: 'input_text',
                text: part.text ?? '',
            };
        }

        if (part.type === 'media') {
            // Grok Responses input can't carry inline audio/video; use text placeholder
            return {
                type: 'input_text',
                text: `[media: ${part.mimeType ?? 'file'}]`,
            };
        }

        const mimeType = toVisionImageMimeType(part.mimeType);
        if (!mimeType) {
            return {
                type: 'input_text',
                text: `[image omitted: unsupported type ${part.mimeType ?? 'unknown'}]`,
            };
        }
        return {
            type: 'input_image',
            detail: 'auto',
            image_url: `data:${mimeType};base64,${part.imageData ?? ''}`,
        };
    }

    private async createResponseStream(
        request: GrokResponseRequest,
        signal?: AbortSignal
    ): Promise<Stream<ResponseStreamEvent>> {
        const requestOptions = signal ? { signal } : undefined;
        // The xAI-only fields (search tool flags, max_turns) are unknown to the SDK type
        const stream = await this.client.responses.create(
            request as unknown as ResponseCreateParamsStreaming,
            requestOptions
        );
        return stream;
    }

    /**
     * Round 1 walks the candidates until xAI accepts one. The accepted one is
     * returned with its stream: every later round of the reply reuses it.
     */
    private async openFirstRound(
        candidates: readonly GrokResponseRequest[],
        wantsFunctionTools: boolean,
        signal?: AbortSignal
    ): Promise<FirstRound> {
        let lastError: unknown;

        for (const candidate of candidates) {
            try {
                const stream = await this.createResponseStream(candidate, signal);
                if (wantsFunctionTools && functionToolNames(candidate.tools).length === 0) {
                    console.error('[grok] Every candidate with client tools was rejected, answering without them:', {
                        message: errorMessageOf(lastError),
                    });
                }
                return { stream, request: candidate };
            } catch (error) {
                lastError = error;
                if (!isUnsupportedFeatureError(error)) {
                    throw error;
                }

                console.warn('[grok] Falling back to a less feature-rich tool configuration:', {
                    message: errorMessageOf(error),
                    tools: describeTools(candidate.tools),
                    hasReasoning: Boolean(candidate.reasoning),
                    maxTurns: candidate.max_turns,
                });
            }
        }

        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
}
