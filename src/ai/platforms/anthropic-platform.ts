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
import { attemptRequestOptions } from './attempt-request-options.js';
import { transformToAnthropic } from '../message-transformer.js';
import { runToolLoop, toAnthropicTools, type TurnTools } from '../tools/index.js';
import {
    collectAnthropicRound,
    toToolResultBlocks,
    type AnthropicRound,
} from './anthropic/anthropic-tool-round.js';
import { lowerMaxTokensAfter, maxTokensWireOf, type MaxTokensWire } from './anthropic/anthropic-max-tokens.js';
import type { UsageSink } from '../usage/usage-types.js';
import {
    anthropicEffortOf,
    effortWireOf,
    isParamRejection,
    logEffortFallback,
    type EffortWire,
} from './thinking-effort-wire.js';
import type {
    PlatformType,
    UnifiedMessage,
    PlatformConfig,
    StreamChunk,
    ModelCapabilities,
} from '../types.js';

/** A 400 that blames the requested effort; every other status keeps its classification */
const EFFORT_REJECTION = /effort|output[_\s]?config/i;

/**
 * Drop output_config.effort when `error` is a 400 that blames it and the reply
 * sent an explicit effort that was not dropped yet; true when the round should
 * be sent again (the adaptive thinking stays).
 */
const dropEffortAfter = (thinking: EffortWire | null, model: string, error: unknown): boolean => {
    if (
        thinking === null ||
        thinking.degraded ||
        thinking.mode !== 'explicit' ||
        !isParamRejection(error, EFFORT_REJECTION)
    ) {
        return false;
    }
    thinking.degraded = true;
    logEffortFallback('anthropic', model, thinking.value ?? 'explicit', 'adaptive thinking', error);
    return true;
};

interface RequestOptions {
    model: string;
    systemPrompt?: string;
    timeout: number;
    maxRetries: number;
    signal?: AbortSignal;
    usageSink?: UsageSink;
    /** The reply's thinking effort; null keeps the legacy adaptive-only request */
    thinking: EffortWire | null;
    /** The reply's max_tokens; every round of the reply shares it and its downgrade */
    output: MaxTokensWire;
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
        const { model, systemPrompt, timeout = 85000, maxRetries = 3, signal, tools, usageSink } = config;

        this.logMessageContents(messages);
        console.log(`[anthropic] Using model: ${model}`);

        const anthropicMessages = transformToAnthropic(messages);
        const options: RequestOptions = {
            model,
            systemPrompt,
            timeout,
            maxRetries,
            signal,
            usageSink,
            thinking: effortWireOf(config),
            output: maxTokensWireOf(model),
        };

        if (tools && tools.definitions.length > 0) {
            return this.sendMessageWithTools(anthropicMessages, tools, options);
        }
        return this.sendWithoutTools(anthropicMessages, options);
    }

    private buildRequest(
        messages: Anthropic.MessageParam[],
        tools: Anthropic.ToolUnion[],
        options: {
            model: string;
            maxTokens: number;
            systemPrompt?: string;
            forceNoTools?: boolean;
            thinking?: EffortWire | null;
        }
    ): Anthropic.MessageCreateParamsStreaming {
        const effort = options.thinking === undefined || options.thinking === null || options.thinking.degraded
            ? null
            : options.thinking.mode === 'explicit' && options.thinking.value !== null
                ? anthropicEffortOf(options.thinking.value)
                : null;
        return {
            model: options.model,
            max_tokens: options.maxTokens,
            messages,
            stream: true,
            ...(options.systemPrompt ? { system: options.systemPrompt } : {}),
            // Claude 5 family: budget_tokens is removed, adaptive is the only
            // on-mode. 'summarized' returns readable thinking text when the
            // provider passes thinking blocks through.
            thinking: { type: 'adaptive', display: 'summarized' },
            // The requested effort rides output_config; 'default' and 'off'
            // leave the provider default in place (design 2026-1113-1742 §3.3).
            ...(effort === null ? {} : { output_config: { effort } }),
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
        const stream = await this.openRoundStream(messages, tools, options, roundOptions);
        const round = await collectAnthropicRound(stream);
        // Both paths (with and without tools) collect every round here
        options.usageSink?.addRound(round.usage);
        return round;
    }

    /**
     * One Messages request with the reply-wide one-shot downgrades: a 400 that
     * blames max_tokens sends the same round again with the fallback limit, a
     * 400 that blames output_config.effort sends it again without the effort.
     * Each happens at most once per reply, in either order, and both state
     * flags live on `options`, so later tool rounds keep what was dropped.
     * 401/403/404/429/5xx are never a downgrade.
     */
    private async openRoundStream(
        messages: Anthropic.MessageParam[],
        tools: Anthropic.ToolUnion[],
        options: RequestOptions,
        roundOptions: { forceNoTools?: boolean }
    ): Promise<AsyncIterable<Anthropic.RawMessageStreamEvent>> {
        const open = () => this.sendWithRetry(
            (attemptSignal) => this.client.messages.create(
                this.buildRequest(messages, tools, {
                    model: options.model,
                    maxTokens: options.output.maxTokens,
                    systemPrompt: options.systemPrompt,
                    forceNoTools: roundOptions.forceNoTools,
                    thinking: options.thinking,
                }),
                attemptRequestOptions(attemptSignal)
            ),
            { timeout: options.timeout, maxRetries: options.maxRetries, signal: options.signal }
        );
        try {
            return await open();
        } catch (error) {
            // max_tokens is checked first: its messages are the more specific
            // ones. Every accepted downgrade flips a one-shot flag, so this
            // recursion sends a round at most three times.
            const lowered =
                lowerMaxTokensAfter(options.output, options.model, error) ||
                dropEffortAfter(options.thinking, options.model, error);
            if (!lowered) throw error;
            return await this.openRoundStream(messages, tools, options, roundOptions);
        }
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
