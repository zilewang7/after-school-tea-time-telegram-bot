/**
 * MIMO platform implementation (OpenAI-compatible API)
 * Docs: https://platform.xiaomimimo.com/docs/api/chat/openai-api
 */
import OpenAI from 'openai';
import type { Stream } from 'openai/streaming';
import type { ChatCompletionChunk } from 'openai/resources';
import { BasePlatform } from './base-platform.js';
import { transformToOpenAI } from '../message-transformer.js';
import { getMcpTools, executeMcpTool, mcpToolsToOpenAI } from '../mcp/index.js';
import type {
    PlatformType,
    UnifiedMessage,
    PlatformConfig,
    StreamChunk,
    ModelCapabilities,
    AgentToolUsage,
    GroundingData,
} from '../types.js';

const MAX_MCP_ROUNDS = 10;

export class MimoPlatform extends BasePlatform {
    readonly type: PlatformType = 'mimo';
    private client: OpenAI;

    constructor() {
        super();
        const baseURL = process.env.MIMO_API_URL || 'https://token-plan-cn.xiaomimimo.com/v1';
        const apiKey = process.env.MIMO_API_KEY || '';

        this.client = new OpenAI({ baseURL, apiKey });
        console.log(`[mimo] Using MIMO API at ${baseURL}`);
    }

    supportsModel(model: string): boolean {
        return model.toLowerCase().startsWith('mimo');
    }

    getModelCapabilities(model: string): ModelCapabilities {
        const lowerModel = model.toLowerCase();
        const isPro = lowerModel.includes('pro');

        return {
            supportsImageInput: !isPro,
            supportsImageOutput: false,
            supportsSystemPrompt: true,
            requiresMessageMerge: false,
            supportsThinking: true,
            supportsGrounding: false,
            supportsMediaInput: false,
        };
    }

    async sendMessage(
        messages: UnifiedMessage[],
        config: PlatformConfig
    ): Promise<AsyncIterable<StreamChunk>> {
        const { model, systemPrompt, timeout = 85000, maxRetries = 3, signal } = config;

        this.logMessageContents(messages);
        console.log(`[mimo] Using model: ${model}`);

        const openaiMessages = transformToOpenAI(messages, {
            includeSystemPrompt: true,
            systemPrompt,
        });

        const mcpTools = getMcpTools();
        if (mcpTools.length > 0) {
            return this.sendMessageWithTools(openaiMessages, model, mcpTools, timeout, maxRetries, signal);
        }

        return this.sendMessageDirect(openaiMessages, model, timeout, maxRetries, signal);
    }

    private getRequestBody(model: string) {
        return {
            model,
            // Enable thinking mode - returns reasoning_content in response
            thinking: { type: 'enabled' as const },
        };
    }

    private async *sendMessageDirect(
        messages: OpenAI.Chat.ChatCompletionMessageParam[],
        model: string,
        timeout: number,
        maxRetries: number,
        signal?: AbortSignal
    ): AsyncIterable<StreamChunk> {
        const stream = await this.sendWithRetry(
            () => this.client.chat.completions.create({
                ...this.getRequestBody(model),
                messages,
                stream: true,
            }, { signal }),
            { timeout, maxRetries, signal }
        );

        yield* this.processStream(stream as Stream<ChatCompletionChunk>);
    }

    private async *sendMessageWithTools(
        initialMessages: OpenAI.Chat.ChatCompletionMessageParam[],
        model: string,
        mcpTools: ReturnType<typeof getMcpTools>,
        timeout: number,
        maxRetries: number,
        signal?: AbortSignal
    ): AsyncIterable<StreamChunk> {
        const openaiTools = mcpToolsToOpenAI(mcpTools);
        let currentMessages = [...initialMessages];
        const toolUsage: AgentToolUsage[] = [];

        for (let round = 0; round < MAX_MCP_ROUNDS; round++) {
            if (signal?.aborted) break;
            console.log(`[mimo] MCP round ${round + 1}/${MAX_MCP_ROUNDS}, messages: ${currentMessages.length}`);

            const stream = await this.sendWithRetry(
                () => this.client.chat.completions.create({
                    ...this.getRequestBody(model),
                    messages: currentMessages,
                    tools: openaiTools,
                    stream: true,
                }, { signal }),
                { timeout, maxRetries, signal }
            );

            const { toolCalls, assistantText, reasoningText, chunks } =
                await this.collectStreamWithTools(stream);
            console.log(`[mimo] Round ${round + 1}: ${chunks.length} chunks, ${toolCalls.length} tools, text: ${assistantText.length}, thinking: ${reasoningText.length}`);

            for (const chunk of chunks) {
                yield chunk;
            }

            if (toolCalls.length === 0) {
                yield {
                    type: 'done',
                    ...(toolUsage.length > 0 ? { agentStats: { toolUsage } } : {}),
                };
                return;
            }

            // Build assistant message with tool calls + reasoning_content (per MIMO docs)
            const assistantMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
                role: 'assistant',
                content: assistantText || null,
                tool_calls: toolCalls.map(tc => ({
                    id: tc.id,
                    type: 'function' as const,
                    function: {
                        name: tc.name,
                        arguments: tc.arguments,
                    },
                })),
            };
            // MIMO docs: keep reasoning_content in history for multi-turn tool calls
            if (reasoningText) {
                (assistantMsg as unknown as Record<string, unknown>).reasoning_content = reasoningText;
            }
            currentMessages.push(assistantMsg);

            // Execute each tool call and append results
            const groundingData: GroundingData[] = [];
            for (const tc of toolCalls) {
                const usage = toolUsage.find(u => u.name === tc.name);
                if (usage) {
                    usage.count++;
                } else {
                    toolUsage.push({ name: tc.name, count: 1 });
                }

                let resultContent: string;
                try {
                    console.log(`[mimo] MCP tool: ${tc.name} (id: ${tc.id})`);
                    const result = await executeMcpTool(tc.name, tc.arguments);
                    resultContent = result.content;

                    // Extract grounding data from tool result
                    const grounding = this.extractGroundingFromToolResult(tc.name, tc.arguments, resultContent);
                    if (grounding) {
                        groundingData.push(grounding);
                    }
                } catch (error) {
                    const errorMsg = error instanceof Error ? error.message : String(error);
                    console.error(`[mimo] MCP tool ${tc.name} failed:`, errorMsg);
                    resultContent = `Error: ${errorMsg}`;
                }

                currentMessages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: resultContent,
                });
            }

            // Yield grounding data as stream chunks
            for (const gd of groundingData) {
                yield { type: 'grounding', groundingMetadata: gd };
            }
        }

        yield { type: 'done', agentStats: { toolUsage } };
    }

    /**
     * Extract grounding data from MCP tool result for display
     */
    private extractGroundingFromToolResult(
        toolName: string,
        argsJson: string,
        resultContent: string
    ): GroundingData | null {
        // Extract search query from tool arguments
        let searchQuery = '';
        try {
            const args = JSON.parse(argsJson);
            searchQuery = args.query || args.question || args.search || args.url || '';
        } catch {
            // ignore
        }

        // Extract URLs from result content
        const urlRegex = /https?:\/\/[^\s)"\]>]+/g;
        const urls = resultContent.match(urlRegex) ?? [];

        // Extract titles (lines before URLs or markdown links)
        const titleRegex = /\[([^\]]+)\]\(https?:\/\/[^)]+\)/g;
        const titles: string[] = [];
        let match;
        while ((match = titleRegex.exec(resultContent)) !== null) {
            titles.push(match[1] ?? '');
        }

        if (!searchQuery && urls.length === 0) return null;

        const citations = urls.slice(0, 10).map((uri, idx) => ({
            uri,
            title: titles[idx] || undefined,
        }));

        return {
            provider: 'mcp',
            searchQueries: searchQuery ? [`${toolName}: ${searchQuery}`] : [toolName],
            citations,
        };
    }

    /**
     * Collect stream, capturing text, thinking, and tool calls
     */
    private async collectStreamWithTools(
        stream: Stream<ChatCompletionChunk>
    ): Promise<{
        toolCalls: Array<{ id: string; name: string; arguments: string }>;
        assistantText: string;
        reasoningText: string;
        chunks: StreamChunk[];
    }> {
        const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();
        let assistantText = '';
        let reasoningText = '';
        const chunks: StreamChunk[] = [];

        for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta;

            // Handle reasoning/thinking content (MIMO thinking mode)
            const mimoDelta = delta as typeof delta & { reasoning_content?: string | null };
            if (mimoDelta?.reasoning_content) {
                reasoningText += mimoDelta.reasoning_content;
                chunks.push({ type: 'thinking', content: mimoDelta.reasoning_content });
            }

            // Handle regular text content
            if (delta?.content) {
                assistantText += delta.content;
                chunks.push({ type: 'text', content: delta.content });
            }

            // Handle tool calls
            if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                    const idx = tc.index;
                    if (!toolCallsMap.has(idx)) {
                        toolCallsMap.set(idx, {
                            id: tc.id || '',
                            name: tc.function?.name || '',
                            arguments: tc.function?.arguments || '',
                        });
                    } else {
                        const existing = toolCallsMap.get(idx)!;
                        if (tc.id) existing.id = tc.id;
                        if (tc.function?.name) existing.name = tc.function.name;
                        if (tc.function?.arguments) existing.arguments += tc.function.arguments;
                    }
                }
            }
        }

        const toolCalls = Array.from(toolCallsMap.values()).filter(tc => tc.name);
        return { toolCalls, assistantText, reasoningText, chunks };
    }

    /**
     * Process stream for direct (non-tool) messages
     */
    private async *processStream(
        stream: Stream<ChatCompletionChunk>
    ): AsyncIterable<StreamChunk> {
        for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta;
            const mimoDelta = delta as typeof delta & { reasoning_content?: string | null };

            // Handle reasoning/thinking content
            if (mimoDelta?.reasoning_content) {
                yield { type: 'thinking', content: mimoDelta.reasoning_content };
            }

            // Handle regular text content
            if (delta?.content) {
                yield { type: 'text', content: delta.content };
            }
        }

        yield { type: 'done' };
    }
}
