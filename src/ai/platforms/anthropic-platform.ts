/**
 * Anthropic (Claude) platform implementation
 *
 * Web search: the default provider (OpenAI-compatible proxy, Anthropic-native
 * /v1/messages endpoint) only *emulates* Anthropic's server-side
 * web_search_20260209 — it echoes the user message as the query and dumps raw
 * results as the final text without synthesis (verified 2026-08-31). So this
 * platform runs the client-side tool loop (config.tools: searxng etc.) like
 * deepseek/openai/mimo instead of declaring server tools.
 */
import Anthropic from '@anthropic-ai/sdk';
import { BasePlatform } from './base-platform.js';
import { transformToAnthropic } from '../message-transformer.js';
import { runToolLoop, toAnthropicTools, type TurnTools } from '../tools/index.js';
import {
    collectAnthropicRound,
    toToolResultBlocks,
    type AnthropicRound,
} from './anthropic/anthropic-tool-round.js';
import type {
    PlatformType,
    UnifiedMessage,
    PlatformConfig,
    StreamChunk,
    ModelCapabilities,
} from '../types.js';

/** Tool rounds before the forced final one; the model is told what is left */
const MAX_TOOL_ROUNDS = 12;
const MAX_OUTPUT_TOKENS = 16000;

interface RequestOptions {
    model: string;
    systemPrompt?: string;
    timeout: number;
    maxRetries: number;
    signal?: AbortSignal;
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
            supportsClientTools: true,
        };
    }

    async sendMessage(
        messages: UnifiedMessage[],
        config: PlatformConfig
    ): Promise<AsyncIterable<StreamChunk>> {
        const { model, systemPrompt, timeout = 85000, maxRetries = 3, signal, tools } = config;

        this.logMessageContents(messages);
        console.log(`[anthropic] Using model: ${model}`);

        const anthropicMessages = transformToAnthropic(messages);
        const options: RequestOptions = { model, systemPrompt, timeout, maxRetries, signal };

        if (tools && tools.definitions.length > 0) {
            return this.sendMessageWithTools(anthropicMessages, tools, options);
        }
        return this.sendWithoutTools(anthropicMessages, options);
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

    /** One request with its stream collected; transport retries only reopen the stream */
    private async streamRound(
        messages: Anthropic.MessageParam[],
        tools: Anthropic.ToolUnion[],
        options: RequestOptions,
        roundOptions: { forceNoTools?: boolean } = {}
    ): Promise<AnthropicRound> {
        const { model, systemPrompt, timeout, maxRetries, signal } = options;
        const stream = await this.sendWithRetry(
            () => this.client.messages.create(
                this.buildRequest(messages, tools, {
                    model,
                    systemPrompt,
                    forceNoTools: roundOptions.forceNoTools,
                }),
                { signal }
            ),
            { timeout, maxRetries, signal }
        );
        return collectAnthropicRound(stream);
    }

    private async *sendWithoutTools(
        messages: Anthropic.MessageParam[],
        options: RequestOptions
    ): AsyncGenerator<StreamChunk, void, undefined> {
        const collected = await this.streamRound(messages, [], options);
        for (const chunk of collected.chunks) {
            yield chunk;
        }
        yield { type: 'done' };
    }

    /**
     * Client tool loop (runToolLoop): each tool_use turn is replayed verbatim
     * (thinking / redacted_thinking / text / tool_use blocks) and answered by
     * one user turn of tool_result blocks; the final round sets tool_choice none.
     */
    private async *sendMessageWithTools(
        initialMessages: Anthropic.MessageParam[],
        tools: TurnTools,
        options: RequestOptions
    ): AsyncGenerator<StreamChunk, void, undefined> {
        const anthropicTools = toAnthropicTools(tools.definitions);
        const currentMessages = [...initialMessages];

        yield* runToolLoop<AnthropicRound>({
            tools,
            maxToolRounds: MAX_TOOL_ROUNDS,
            signal: options.signal,
            logPrefix: '[anthropic]',
            sendRound: async (_roundIndex, final) => {
                const round = await this.streamRound(currentMessages, anthropicTools, options, {
                    forceNoTools: final,
                });
                // Only a turn that stopped for tool_use asks for tools: a
                // max_tokens cut can leave a half-written tool_use behind
                return round.stopReason === 'tool_use' ? round : { ...round, toolCalls: [] };
            },
            appendRound: (round, executedCalls) => {
                currentMessages.push(
                    { role: 'assistant', content: round.assistantBlocks },
                    { role: 'user', content: toToolResultBlocks(executedCalls) }
                );
            },
        });
    }
}
