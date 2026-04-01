/**
 * Grok (xAI) platform implementation
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
    AgentStats,
    PlatformType,
    UnifiedMessage,
    UnifiedContentPart,
    PlatformConfig,
    StreamChunk,
    ModelCapabilities,
    GroundingData,
} from '../types';

type GrokWebSearchTool = {
    type: 'web_search';
    enable_image_understanding?: boolean;
};

type GrokXSearchTool = {
    type: 'x_search';
    enable_image_understanding?: boolean;
    enable_video_understanding?: boolean;
};

type GrokCodeInterpreterTool = {
    type: 'code_interpreter';
};

type GrokResponseTool =
    NonNullable<ResponseCreateParamsStreaming['tools']>[number] |
    GrokWebSearchTool |
    GrokXSearchTool |
    GrokCodeInterpreterTool;

type GrokResponseRequest = Omit<ResponseCreateParamsStreaming, 'tools' | 'reasoning'> & {
    tools: GrokResponseTool[];
    reasoning?: {
        effort: 'high';
    };
    max_turns?: number;
};

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
        };
    }

    async sendMessage(
        messages: UnifiedMessage[],
        config: PlatformConfig
    ): Promise<AsyncIterable<StreamChunk>> {
        const { model, systemPrompt, timeout = 85000, maxRetries = 3, signal } = config;
        const tools = this.getSearchTools(model);

        this.logMessageContents(messages);
        console.log(`[grok] Using model: ${model}`, { tools: tools.map((tool) => tool.type) });

        const input = this.transformToResponsesInput(messages, systemPrompt);

        const request: Omit<ResponseCreateParamsStreaming, 'tools'> & {
            tools: GrokResponseTool[];
            reasoning?: {
                effort: 'high';
            };
            max_turns?: number;
        } = {
            model,
            input,
            stream: true,
            tools,
            reasoning: this.getReasoningConfig(model),
            max_turns: 10,
            parallel_tool_calls: true,
        };

        const stream = await this.sendWithRetry(
            () => this.createResponseStream(request, signal),
            { timeout, maxRetries, signal }
        );

        return this.processStream(stream, model);
    }

    private isMultiAgentModel(model: string): boolean {
        return model.toLowerCase().includes('multi-agent');
    }

    private getSearchTools(_model: string): GrokResponseTool[] {
        return [
            {
                type: 'web_search',
                enable_image_understanding: true,
            },
            {
                type: 'x_search',
                enable_image_understanding: true,
                enable_video_understanding: true,
            },
            {
                type: 'code_interpreter',
            },
        ];
    }

    private getReasoningConfig(
        model: string
    ): GrokResponseRequest['reasoning'] | undefined {
        if (this.isMultiAgentModel(model)) {
            return { effort: 'high' };
        }

        return undefined;
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

        return {
            type: 'input_image',
            detail: 'auto',
            image_url: `data:image/png;base64,${part.imageData ?? ''}`,
        };
    }

    private async createResponseStream(
        request: GrokResponseRequest,
        signal?: AbortSignal
    ): Promise<Stream<ResponseStreamEvent>> {
        const requestOptions = signal ? { signal } : undefined;
        let lastError: unknown;

        for (const candidate of this.buildFallbackRequests(request)) {
            try {
                const stream = await this.client.responses.create(
                    candidate as unknown as ResponseCreateParamsStreaming,
                    requestOptions
                );
                return stream as unknown as Stream<ResponseStreamEvent>;
            } catch (error) {
                lastError = error;
                if (!this.shouldFallbackUnsupportedFeature(error)) {
                    throw error;
                }

                console.warn('[grok] Falling back to a less feature-rich tool configuration:', {
                    message: error instanceof Error ? error.message : String(error),
                    tools: candidate.tools.map((tool) => tool.type),
                    hasReasoning: Boolean(candidate.reasoning),
                    maxTurns: candidate.max_turns,
                });
            }
        }

        throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    private buildFallbackRequests(request: GrokResponseRequest): GrokResponseRequest[] {
        const plainComprehensiveTools: GrokResponseTool[] = [
            { type: 'web_search' },
            { type: 'x_search' },
            { type: 'code_interpreter' },
        ];
        const plainSearchTools: GrokResponseTool[] = [
            { type: 'web_search' },
            { type: 'x_search' },
        ];
        const webOnlyTools: GrokResponseTool[] = [{ type: 'web_search' }];

        const candidates: GrokResponseRequest[] = [
            request,
            {
                ...request,
                max_turns: undefined,
            },
            {
                ...request,
                tools: plainComprehensiveTools,
            },
            {
                ...request,
                tools: plainSearchTools,
                max_turns: undefined,
            },
            {
                ...request,
                tools: webOnlyTools,
                max_turns: undefined,
            },
            {
                ...request,
                tools: webOnlyTools,
                reasoning: undefined,
                max_turns: undefined,
            },
        ];

        const seen = new Set<string>();
        return candidates.filter((candidate) => {
            const signature = JSON.stringify({
                tools: candidate.tools,
                reasoning: candidate.reasoning,
                max_turns: candidate.max_turns ?? null,
                parallel_tool_calls: candidate.parallel_tool_calls ?? null,
            });
            if (seen.has(signature)) {
                return false;
            }
            seen.add(signature);
            return true;
        });
    }

    private shouldFallbackUnsupportedFeature(error: unknown): boolean {
        const e = error as { status?: number; message?: string; error?: { message?: string } };
        const message = `${e.message ?? ''} ${e.error?.message ?? ''}`.toLowerCase();

        if (e.status !== 400) {
            return false;
        }

        return [
            'tool',
            'x_search',
            'web_search',
            'code_interpreter',
            'reasoning',
            'max_turns',
            'parallel_tool_calls',
            'enable_image_understanding',
            'enable_video_understanding',
            'unsupported',
            'unknown parameter',
            'invalid parameter',
        ].some((pattern) => message.includes(pattern));
    }

    private extractGroundingData(response: Response | null): GroundingData[] {
        if (!response) {
            return [];
        }

        const citations = new Map<string, { uri: string; title?: string }>();
        const outputItems = Array.isArray((response as any).output) ? (response as any).output : [];

        for (const item of outputItems) {
            if (item?.type !== 'message' || !Array.isArray(item.content)) {
                continue;
            }

            for (const content of item.content) {
                if (content?.type !== 'output_text' || !Array.isArray(content.annotations)) {
                    continue;
                }

                for (const annotation of content.annotations) {
                    if (annotation?.type !== 'url_citation' || !annotation.url) {
                        continue;
                    }

                    citations.set(annotation.url, {
                        uri: annotation.url,
                        title: annotation.title,
                    });
                }
            }
        }

        const responseCitations = Array.isArray((response as any).citations)
            ? (response as any).citations
            : [];

        for (const citation of responseCitations) {
            if (typeof citation !== 'string' || !citation) {
                continue;
            }

            if (!citations.has(citation)) {
                citations.set(citation, { uri: citation });
            }
        }

        if (!citations.size) {
            return [];
        }

        return [
            {
                provider: 'xai',
                searchQueries: [],
                citations: [...citations.values()],
            },
        ];
    }

    private normalizeToolName(name: string): string {
        const lowerName = name.toLowerCase();

        if (lowerName.includes('code') && lowerName.includes('interpreter')) {
            return 'code_interpreter';
        }
        if (lowerName.includes('x_search') || lowerName === 'xsearch') {
            return 'x_search';
        }
        if (lowerName.includes('web_search')) {
            return 'web_search';
        }

        return name;
    }

    private summarizeCodeInterpreterCall(item: any): string {
        const outputs = Array.isArray(item?.outputs) ? item.outputs : [];
        const logOutputs = outputs.filter(
            (output: any) => output?.type === 'logs' && typeof output.logs === 'string'
        );
        const imageCount = outputs.filter((output: any) => output?.type === 'image').length;
        const firstLogLine = logOutputs
            .map((output: any) =>
                output.logs
                    .split('\n')
                    .map((line: string) => line.trim())
                    .find((line: string) => line.length > 0)
            )
            .find((line: string | undefined) => Boolean(line));

        const parts: string[] = [];
        if (logOutputs.length > 0) {
            parts.push(`${logOutputs.length} log block${logOutputs.length > 1 ? 's' : ''}`);
        }
        if (imageCount > 0) {
            parts.push(`${imageCount} image${imageCount > 1 ? 's' : ''}`);
        }
        if (firstLogLine) {
            parts.push(firstLogLine);
        }

        if (!parts.length) {
            const status = typeof item?.status === 'string' ? item.status : 'completed';
            return status === 'completed'
                ? 'completed (server-side output hidden)'
                : status;
        }

        return parts.join(' | ');
    }

    private extractAgentStats(response: Response | null, model: string): AgentStats | undefined {
        if (!response) {
            return undefined;
        }

        const toolUsage = new Map<string, number>();
        const codeInterpreterSummary: string[] = [];
        const recordToolUse = (name: string) => {
            if (!name) return;
            const normalizedName = this.normalizeToolName(name);
            toolUsage.set(normalizedName, (toolUsage.get(normalizedName) ?? 0) + 1);
        };

        const rawResponse = response as any;
        const rawToolCalls = Array.isArray(rawResponse.tool_calls) ? rawResponse.tool_calls : [];
        for (const toolCall of rawToolCalls) {
            const toolName = toolCall?.function?.name || toolCall?.name || toolCall?.type;
            if (typeof toolName === 'string') {
                recordToolUse(toolName);
            }
        }

        const outputItems = Array.isArray(rawResponse.output) ? rawResponse.output : [];
        for (const item of outputItems) {
            switch (item?.type) {
                case 'web_search_call':
                    recordToolUse('web_search');
                    break;
                case 'x_search_call':
                    recordToolUse('x_search');
                    break;
                case 'code_interpreter_call':
                    recordToolUse('code_interpreter');
                    codeInterpreterSummary.push(this.summarizeCodeInterpreterCall(item));
                    break;
                default:
                    break;
            }
        }

        if (!toolUsage.size) {
            const serverSideToolUsage = rawResponse.server_side_tool_usage;
            if (Array.isArray(serverSideToolUsage)) {
                for (const item of serverSideToolUsage) {
                    if (typeof item === 'string') {
                        recordToolUse(item);
                        continue;
                    }

                    if (item && typeof item === 'object') {
                        const toolName = item.name || item.tool || item.type;
                        const count = typeof item.count === 'number' ? item.count : 1;
                        if (typeof toolName === 'string') {
                            const normalizedName = this.normalizeToolName(toolName);
                            toolUsage.set(
                                normalizedName,
                                (toolUsage.get(normalizedName) ?? 0) + count
                            );
                        }
                    }
                }
            } else if (serverSideToolUsage && typeof serverSideToolUsage === 'object') {
                for (const [toolName, count] of Object.entries(serverSideToolUsage)) {
                    if (typeof count !== 'number') continue;
                    const normalizedName = this.normalizeToolName(toolName);
                    toolUsage.set(normalizedName, (toolUsage.get(normalizedName) ?? 0) + count);
                }
            }
        }

        const stats: AgentStats = {
            mode: this.isMultiAgentModel(model) ? '16 agents' : undefined,
            reasoningTokens:
                typeof rawResponse?.usage?.output_tokens_details?.reasoning_tokens === 'number'
                    ? rawResponse.usage.output_tokens_details.reasoning_tokens
                    : undefined,
            toolUsage: [...toolUsage.entries()]
                .map(([name, count]) => ({ name, count }))
                .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
            codeInterpreterSummary,
        };

        if (
            !stats.mode &&
            !stats.reasoningTokens &&
            !stats.toolUsage?.length &&
            !stats.codeInterpreterSummary?.length
        ) {
            return undefined;
        }

        return stats;
    }

    private async *processStream(
        stream: Stream<ResponseStreamEvent>,
        model: string
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
                const groundingData = this.extractGroundingData(completedResponse);
                for (const groundingMetadata of groundingData) {
                    yield {
                        type: 'grounding',
                        groundingMetadata,
                    };
                }
                continue;
            }

            if (event.type === 'response.failed') {
                throw new Error(event.response.error?.message ?? 'Grok response failed');
            }

            if (event.type === 'error') {
                throw new Error(event.message || 'Grok stream error');
            }
        }

        yield {
            type: 'done',
            agentStats: this.extractAgentStats(completedResponse, model),
            rawResponse: completedResponse,
        };
    }
}
