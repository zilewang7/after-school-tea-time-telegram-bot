/**
 * Anthropic (Claude) platform implementation
 *
 * Web search: the default provider (OpenAI-compatible proxy, Anthropic-native
 * /v1/messages endpoint) only *emulates* Anthropic's server-side
 * web_search_20260209 — it echoes the user message as the query and dumps raw
 * results as the final text without synthesis (verified 2026-08-31). So this
 * platform uses the client-side MCP tool loop (searxng etc.) like
 * deepseek/openai/mimo instead of declaring server tools.
 */
import Anthropic from '@anthropic-ai/sdk';
import { BasePlatform } from './base-platform.js';
import { transformToAnthropic } from '../message-transformer.js';
import {
    getMcpTools,
    executeMcpTool,
    extractGroundingFromToolResult,
} from '../mcp/index.js';
import type {
    PlatformType,
    UnifiedMessage,
    PlatformConfig,
    StreamChunk,
    ModelCapabilities,
    AgentToolUsage,
    GroundingData,
} from '../types.js';

const MAX_MCP_ROUNDS = 5;
const MAX_OUTPUT_TOKENS = 16000;

interface CollectedStream {
    /** Raw assistant content blocks for history replay (thinking/text/tool_use) */
    assistantBlocks: Anthropic.ContentBlockParam[];
    toolCalls: Array<{ id: string; name: string; argsJson: string }>;
    stopReason: string | null;
    chunks: StreamChunk[];
}

export class AnthropicPlatform extends BasePlatform {
    readonly type: PlatformType = 'anthropic';
    private client: Anthropic;

    constructor() {
        super();
        // Default provider is the same OpenAI-compatible proxy: it also serves
        // the Anthropic-native /v1/messages endpoint. The SDK appends /v1/...
        // itself, so strip a trailing /v1 from OPENAI_API_URL.
        const baseURL =
            process.env.ANTHROPIC_API_URL ||
            process.env.OPENAI_API_URL?.replace(/\/v1\/?$/, '') ||
            undefined;
        const apiKey =
            process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || '';

        this.client = new Anthropic({ baseURL, apiKey });
        console.log(`[anthropic] Using Anthropic API at ${baseURL ?? 'default'}`);
    }

    supportsModel(model: string): boolean {
        return model.toLowerCase().startsWith('claude');
    }

    getModelCapabilities(_model: string): ModelCapabilities {
        return {
            supportsImageInput: true,
            supportsImageOutput: false,
            supportsSystemPrompt: true,
            requiresMessageMerge: false,
            supportsThinking: true,
            supportsGrounding: true,
            supportsMediaInput: false,
        };
    }

    async sendMessage(
        messages: UnifiedMessage[],
        config: PlatformConfig
    ): Promise<AsyncIterable<StreamChunk>> {
        const { model, systemPrompt, timeout = 85000, maxRetries = 3, signal } = config;

        this.logMessageContents(messages);
        console.log(`[anthropic] Using model: ${model}`);

        const anthropicMessages = transformToAnthropic(messages);
        const mcpTools = getMcpTools();
        const anthropicTools: Anthropic.ToolUnion[] = mcpTools.map((tool) => ({
            name: tool.name,
            description: tool.description ?? '',
            input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
        }));

        return this.runToolLoop(
            anthropicMessages,
            anthropicTools,
            { model, systemPrompt, timeout, maxRetries, signal }
        );
    }

    private buildRequest(
        messages: Anthropic.MessageParam[],
        tools: Anthropic.ToolUnion[],
        options: { model: string; systemPrompt?: string; forceNoTools?: boolean }
    ): Anthropic.MessageCreateParamsStreaming {
        return {
            model: options.model,
            max_tokens: MAX_OUTPUT_TOKENS,
            messages,
            stream: true,
            ...(options.systemPrompt ? { system: options.systemPrompt } : {}),
            // Claude 5 family: budget_tokens is removed, adaptive is the only
            // on-mode. 'summarized' returns readable thinking text when the
            // provider passes thinking blocks through.
            thinking: { type: 'adaptive', display: 'summarized' },
            ...(tools.length > 0
                ? {
                      tools,
                      ...(options.forceNoTools
                          ? { tool_choice: { type: 'none' as const } }
                          : {}),
                  }
                : {}),
        };
    }

    private async *runToolLoop(
        initialMessages: Anthropic.MessageParam[],
        tools: Anthropic.ToolUnion[],
        options: {
            model: string;
            systemPrompt?: string;
            timeout: number;
            maxRetries: number;
            signal?: AbortSignal;
        }
    ): AsyncIterable<StreamChunk> {
        const { model, systemPrompt, timeout, maxRetries, signal } = options;
        const currentMessages = [...initialMessages];
        const toolUsage: AgentToolUsage[] = [];

        for (let round = 0; round < MAX_MCP_ROUNDS; round++) {
            if (signal?.aborted) break;

            const stream = await this.sendWithRetry(
                () => this.client.messages.create(
                    this.buildRequest(currentMessages, tools, { model, systemPrompt }),
                    { signal }
                ),
                { timeout, maxRetries, signal }
            );

            const collected = await this.collectStream(stream);

            for (const chunk of collected.chunks) {
                yield chunk;
            }

            if (collected.stopReason !== 'tool_use' || collected.toolCalls.length === 0) {
                yield {
                    type: 'done',
                    ...(toolUsage.length > 0 ? { agentStats: { toolUsage } } : {}),
                };
                return;
            }

            // Replay the assistant turn (incl. thinking/tool_use blocks), then
            // append tool results as a user turn
            currentMessages.push({ role: 'assistant', content: collected.assistantBlocks });

            const toolResults: Anthropic.ToolResultBlockParam[] = [];
            const groundingData: GroundingData[] = [];
            for (const tc of collected.toolCalls) {
                const usage = toolUsage.find((u) => u.name === tc.name);
                if (usage) {
                    usage.count++;
                } else {
                    toolUsage.push({ name: tc.name, count: 1 });
                }

                let resultContent: string;
                let isError = false;
                try {
                    console.log(`[anthropic] MCP tool call: ${tc.name}`);
                    const result = await executeMcpTool(tc.name, tc.argsJson);
                    resultContent = result.content;

                    const grounding = extractGroundingFromToolResult(
                        tc.name,
                        tc.argsJson,
                        resultContent
                    );
                    if (grounding) {
                        groundingData.push(grounding);
                    }
                } catch (error) {
                    const errorMsg = error instanceof Error ? error.message : String(error);
                    console.error(`[anthropic] MCP tool ${tc.name} failed:`, errorMsg);
                    resultContent = `Error: ${errorMsg}`;
                    isError = true;
                }

                toolResults.push({
                    type: 'tool_result',
                    tool_use_id: tc.id,
                    content: resultContent,
                    ...(isError ? { is_error: true } : {}),
                });
            }
            currentMessages.push({ role: 'user', content: toolResults });

            for (const gd of groundingData) {
                yield { type: 'grounding', groundingMetadata: gd };
            }
        }

        // Round budget exhausted while the model still wants tools: force one
        // final answer with tool_choice 'none' so the reply never ends with
        // CoT + tool stats but an empty body.
        if (!signal?.aborted) {
            console.log('[anthropic] MCP round limit reached, forcing final answer');
            const finalStream = await this.sendWithRetry(
                () => this.client.messages.create(
                    this.buildRequest(currentMessages, tools, {
                        model,
                        systemPrompt,
                        forceNoTools: true,
                    }),
                    { signal }
                ),
                { timeout, maxRetries, signal }
            );

            const collected = await this.collectStream(finalStream);
            for (const chunk of collected.chunks) {
                yield chunk;
            }
        }

        yield { type: 'done', agentStats: { toolUsage } };
    }

    /**
     * Consume one SSE stream: emit display chunks and rebuild the raw
     * assistant content blocks (needed to replay tool_use turns).
     */
    private async collectStream(
        stream: AsyncIterable<Anthropic.RawMessageStreamEvent>
    ): Promise<CollectedStream> {
        const assistantBlocks: Anthropic.ContentBlockParam[] = [];
        // index -> accumulated partial JSON for tool_use inputs
        const pendingToolJson = new Map<number, string>();
        // index -> position in assistantBlocks
        const blockPositions = new Map<number, number>();
        const chunks: StreamChunk[] = [];
        let stopReason: string | null = null;

        for await (const event of stream) {
            if (event.type === 'content_block_start') {
                const block = event.content_block;
                if (block.type === 'text') {
                    blockPositions.set(event.index, assistantBlocks.length);
                    assistantBlocks.push({ type: 'text', text: block.text ?? '' });
                } else if (block.type === 'thinking') {
                    blockPositions.set(event.index, assistantBlocks.length);
                    assistantBlocks.push({
                        type: 'thinking',
                        thinking: block.thinking ?? '',
                        signature: block.signature ?? '',
                    });
                } else if (block.type === 'tool_use') {
                    blockPositions.set(event.index, assistantBlocks.length);
                    assistantBlocks.push({
                        type: 'tool_use',
                        id: block.id,
                        name: block.name,
                        input: block.input ?? {},
                    });
                    pendingToolJson.set(event.index, '');
                }
                continue;
            }

            if (event.type === 'content_block_delta') {
                const delta = event.delta;
                const position = blockPositions.get(event.index);
                const target = position !== undefined ? assistantBlocks[position] : undefined;

                if (delta.type === 'text_delta' && delta.text) {
                    chunks.push({ type: 'text', content: delta.text });
                    if (target?.type === 'text') {
                        target.text += delta.text;
                    }
                } else if (delta.type === 'thinking_delta' && delta.thinking) {
                    chunks.push({ type: 'thinking', content: delta.thinking });
                    if (target?.type === 'thinking') {
                        target.thinking += delta.thinking;
                    }
                } else if (delta.type === 'signature_delta' && target?.type === 'thinking') {
                    target.signature = (target.signature ?? '') + delta.signature;
                } else if (delta.type === 'input_json_delta' && pendingToolJson.has(event.index)) {
                    pendingToolJson.set(
                        event.index,
                        pendingToolJson.get(event.index)! + delta.partial_json
                    );
                }
                continue;
            }

            if (event.type === 'content_block_stop') {
                const json = pendingToolJson.get(event.index);
                const position = blockPositions.get(event.index);
                if (json !== undefined && position !== undefined) {
                    pendingToolJson.delete(event.index);
                    const target = assistantBlocks[position];
                    if (target?.type === 'tool_use' && json) {
                        try {
                            target.input = JSON.parse(json);
                        } catch {
                            console.warn(`[anthropic] Invalid tool input JSON: ${json.substring(0, 100)}`);
                        }
                    }
                }
                continue;
            }

            if (event.type === 'message_delta') {
                stopReason = event.delta.stop_reason ?? stopReason;
                if (event.delta.stop_reason === 'refusal') {
                    console.warn('[anthropic] Response stopped with refusal');
                }
            }
        }

        const toolCalls = assistantBlocks
            .filter((block): block is Anthropic.ToolUseBlockParam => block.type === 'tool_use')
            .map((block) => ({
                id: block.id,
                name: block.name,
                argsJson: JSON.stringify(block.input ?? {}),
            }));

        return { assistantBlocks, toolCalls, stopReason, chunks };
    }
}
