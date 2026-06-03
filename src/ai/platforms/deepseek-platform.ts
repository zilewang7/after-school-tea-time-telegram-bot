/**
 * DeepSeek platform implementation
 */
import OpenAI from 'openai';
import type { Stream } from 'openai/streaming';
import type { ChatCompletionChunk } from 'openai/resources';
import { BasePlatform } from './base-platform.js';
import { transformToOpenAI, mergeConsecutiveMessages } from '../message-transformer.js';
import { getMcpTools, executeMcpTool, mcpToolsToOpenAI } from '../mcp/index.js';
import type {
    PlatformType,
    UnifiedMessage,
    PlatformConfig,
    StreamChunk,
    ModelCapabilities,
    AgentToolUsage,
} from '../types.js';

const MAX_MCP_ROUNDS = 5;

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
            supportsMediaInput: false,
        };
    }

    async sendMessage(
        messages: UnifiedMessage[],
        config: PlatformConfig
    ): Promise<AsyncIterable<StreamChunk>> {
        const { model, systemPrompt, timeout = 85000, maxRetries = 3, signal } = config;
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

        // MCP tool-enabled flow
        const mcpTools = getMcpTools();
        if (mcpTools.length > 0) {
            return this.sendMessageWithTools(openaiMessages, model, mcpTools, timeout, maxRetries, signal);
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

        return this.processStream(stream as Stream<DeepSeekChunk>);
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

            const stream = await this.sendWithRetry(
                () => this.client.chat.completions.create({
                    model,
                    messages: currentMessages,
                    tools: openaiTools,
                    stream: true,
                }, { signal }),
                { timeout, maxRetries, signal }
            );

            const { toolCalls, assistantText, chunks } = await this.collectStreamWithTools(stream as Stream<DeepSeekChunk>);

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

            // Append assistant message with tool calls
            currentMessages.push({
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
            });

            // Execute each tool and append results
            for (const tc of toolCalls) {
                const usage = toolUsage.find(u => u.name === tc.name);
                if (usage) {
                    usage.count++;
                } else {
                    toolUsage.push({ name: tc.name, count: 1 });
                }

                let resultContent: string;
                try {
                    console.log(`[deepseek] MCP tool call: ${tc.name}`);
                    const result = await executeMcpTool(tc.name, tc.arguments);
                    resultContent = result.content;
                } catch (error) {
                    const errorMsg = error instanceof Error ? error.message : String(error);
                    console.error(`[deepseek] MCP tool ${tc.name} failed:`, errorMsg);
                    resultContent = `Error: ${errorMsg}`;
                }

                currentMessages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: resultContent,
                });
            }
        }

        yield { type: 'done', agentStats: { toolUsage } };
    }

    private async collectStreamWithTools(
        stream: Stream<DeepSeekChunk>
    ): Promise<{
        toolCalls: Array<{ id: string; name: string; arguments: string }>;
        assistantText: string;
        chunks: StreamChunk[];
    }> {
        const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();
        let assistantText = '';
        const chunks: StreamChunk[] = [];

        for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta;

            // Handle reasoning content (thinking)
            if (delta?.reasoning_content) {
                chunks.push({ type: 'thinking', content: delta.reasoning_content });
            }

            // Handle regular content
            if (delta?.content) {
                assistantText += delta.content;
                chunks.push({ type: 'text', content: delta.content });
            }

            // Handle tool calls
            const rawChunk = chunk as unknown as { choices: Array<{ delta: { tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> } }> };
            if (rawChunk.choices[0]?.delta?.tool_calls) {
                for (const tc of rawChunk.choices[0].delta.tool_calls) {
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
        return { toolCalls, assistantText, chunks };
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
