/**
 * Wire shapes of the probe: one request builder and one stream accumulator per
 * protocol, written with the same SDK types production uses.
 *
 * The builders deliberately send raw requests: no system prompt, no built-in
 * paid tools (web_search / x_search / code_interpreter / Google Search
 * grounding), only a short prompt, a client function declaration when the
 * fidelity variant asks for one, and the thinking parameter under test.
 */
import {
    ThinkingLevel,
    type GenerateContentConfig,
    type GenerateContentParameters,
    type GenerateContentResponse,
    type ThinkingConfig,
} from '@google/genai';
import type { ChatCompletionChunk, ChatCompletionCreateParamsStreaming, ChatCompletionFunctionTool } from 'openai/resources/chat/completions';
import type { FunctionTool, ResponseCreateParamsStreaming, ResponseStreamEvent } from 'openai/resources/responses/responses';
import type Anthropic from '@anthropic-ai/sdk';
import { numberAt, recordOf, type EffortValue, type ProbeCandidate, type ProbeVariant } from './effort-types.mts';

/** The only tool a probe request may declare: a plain client function, no billing */
export const PROBE_TOOL_NAME = 'probe_echo';

const PROBE_TOOL_SCHEMA: Readonly<Record<string, unknown>> = {
    type: 'object',
    properties: {
        value: { type: 'string', description: 'echo this value back' },
    },
    required: ['value'],
    additionalProperties: false,
};

const PROBE_TOOL_DESCRIPTION = 'Echo a value back to the caller. Never called by the probe.';

/** Function tool in each provider's wire format (copied from src tool-wire-formats) */
const responsesFunctionTool: FunctionTool = {
    type: 'function',
    name: PROBE_TOOL_NAME,
    description: PROBE_TOOL_DESCRIPTION,
    parameters: PROBE_TOOL_SCHEMA,
    strict: false,
};

const chatFunctionTool: ChatCompletionFunctionTool = {
    type: 'function',
    function: { name: PROBE_TOOL_NAME, description: PROBE_TOOL_DESCRIPTION, parameters: PROBE_TOOL_SCHEMA },
};

const anthropicFunctionTool: Anthropic.Tool = {
    name: PROBE_TOOL_NAME,
    description: PROBE_TOOL_DESCRIPTION,
    input_schema: { ...PROBE_TOOL_SCHEMA, type: 'object' },
};

/** Native Gemini levels (the SDK enum); XHIGH/MAX go through httpOptions.extraBody */
const NATIVE_GEMINI_LEVELS: Partial<Record<EffortValue, ThinkingLevel>> = {
    minimal: ThinkingLevel.MINIMAL,
    low: ThinkingLevel.LOW,
    medium: ThinkingLevel.MEDIUM,
    high: ThinkingLevel.HIGH,
};

/** Gemini wire level text for the values the SDK enum lacks, or null */
const GEMINI_EXTRA_LEVELS: Partial<Record<EffortValue, string>> = {
    xhigh: 'XHIGH',
    max: 'MAX',
};

/**
 * OpenAI-family effort values. The probe's closed set has `ultra`, which no
 * wire protocol of this repo accepts; it is mapped down so the probe request
 * never carries a value outside the vendors' documented unions.
 */
type OpenAiWireEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const openAiEffortOf = (effort: EffortValue): OpenAiWireEffort => (effort === 'ultra' ? 'max' : effort);

export interface BuildOptions {
    /**
     * Output cap of one probe request. Production sends none of these caps
     * (Anthropic hard-codes max_tokens 16000; the other platforms send none),
     * so the cap is a probe-only budget guard. A truncated answer is still an
     * accepted 2xx, but it can hide how much a high effort would have thought:
     * the effect wave's cap must stay above the vendor default's thinking.
     */
    readonly maxOutputTokens: number;
    readonly prompt: string;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
}

/**
 * Gemini request. On Gemini 4 the baseline sends `includeThoughts` without a
 * level (the vendor default), while a pre-Gemini-4 model keeps production's
 * automatic `thinkingBudget: -1` (src/ai/platforms/gemini-platform.ts
 * prepareRequest branches on the gemini-4 prefix). A level candidate sends the
 * SDK enum when it has one, and the raw wire value through `extraBody` for
 * XHIGH/MAX, which the enum lacks. `budget` is the deliberate 400 sentinel.
 */
export const buildGeminiParams = (candidate: ProbeCandidate, options: BuildOptions): GenerateContentParameters => {
    const thinkingConfig: ThinkingConfig = { includeThoughts: true };
    const isGemini4 = candidate.model.toLowerCase().startsWith('gemini-4');
    let extraBody: Record<string, unknown> | null = null;
    if (candidate.variant === 'budget' || (candidate.variant !== 'level' && !isGemini4)) {
        // Pre-Gemini-4 models cannot take a level; production sends the
        // automatic budget in every mode, so the baseline mirrors that.
        thinkingConfig.thinkingBudget = -1;
    } else if (candidate.variant === 'level' && candidate.effort !== null) {
        const native = NATIVE_GEMINI_LEVELS[candidate.effort];
        const extra = GEMINI_EXTRA_LEVELS[candidate.effort];
        if (native !== undefined) {
            thinkingConfig.thinkingLevel = native;
        } else if (extra !== undefined) {
            extraBody = { generationConfig: { thinkingConfig: { thinkingLevel: extra } } };
        }
    }
    const config: GenerateContentConfig = {
        maxOutputTokens: options.maxOutputTokens,
        thinkingConfig,
        httpOptions: { timeout: options.timeoutMs, ...(extraBody === null ? {} : { extraBody }) },
        ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
        ...(candidate.withClientTools
            ? { tools: [{ functionDeclarations: [{ name: PROBE_TOOL_NAME, description: PROBE_TOOL_DESCRIPTION, parametersJsonSchema: PROBE_TOOL_SCHEMA }] }] }
            : {}),
    };
    return { model: candidate.model, contents: options.prompt, config };
};

/** OpenAI Responses request: baseline carries the production default summary only */
export const buildOpenAiResponsesParams = (
    candidate: ProbeCandidate,
    options: BuildOptions
): ResponseCreateParamsStreaming => {
    const reasoning: NonNullable<ResponseCreateParamsStreaming['reasoning']> =
        candidate.variant === 'level' && candidate.effort !== null
            ? { effort: openAiEffortOf(candidate.effort), summary: 'detailed' }
            : { summary: 'detailed' };
    return {
        model: candidate.model,
        input: options.prompt,
        stream: true,
        reasoning,
        max_output_tokens: options.maxOutputTokens,
        ...(candidate.withClientTools ? { tools: [responsesFunctionTool] } : {}),
    };
};

/**
 * Grok Responses request. Production sends no reasoning on grok-4.7 and an
 * explicit `effort: 'high'` on multi-agent models, in the default mode too
 * (src/ai/platforms/grok-platform.ts sendMessage → grokReasoningFor), so the
 * baseline must carry that high: a probe baseline without it would not be the
 * production default shape.
 */
export const buildGrokResponsesParams = (
    candidate: ProbeCandidate,
    options: BuildOptions
): ResponseCreateParamsStreaming => {
    const multiAgent = candidate.model.toLowerCase().includes('multi-agent');
    const reasoning: ResponseCreateParamsStreaming['reasoning'] =
        candidate.variant === 'level' && candidate.effort !== null
            ? { effort: openAiEffortOf(candidate.effort) }
            : multiAgent && candidate.variant === 'baseline'
              ? { effort: 'high' }
              : undefined;
    return {
        model: candidate.model,
        input: options.prompt,
        stream: true,
        ...(reasoning === undefined ? {} : { reasoning }),
        // xAI multi-agent rejects max_tokens; 4.7 accepts max_output_tokens
        ...(multiAgent ? {} : { max_output_tokens: options.maxOutputTokens }),
        ...(candidate.withClientTools && !multiAgent ? { tools: [responsesFunctionTool] } : {}),
    };
};

/**
 * Anthropic Messages request: adaptive thinking always on, effort under
 * output_config. The SDK's `OutputConfig.effort` union has no `none`/`minimal`,
 * while the probe must test them (they are the negative sentinels), so the
 * parameter is attached through a plain record — the same bytes reach the wire.
 */
export const buildAnthropicParams = (
    candidate: ProbeCandidate,
    options: BuildOptions
): Anthropic.MessageCreateParamsStreaming => {
    const base: Anthropic.MessageCreateParamsStreaming = {
        model: candidate.model,
        max_tokens: options.maxOutputTokens,
        stream: true,
        messages: [{ role: 'user', content: options.prompt }],
        thinking: { type: 'adaptive', display: 'summarized' },
        ...(candidate.withClientTools ? { tools: [anthropicFunctionTool] } : {}),
    };
    if (candidate.variant !== 'level' || candidate.effort === null) return base;
    const extra: Record<string, unknown> = { output_config: { effort: candidate.effort } };
    return { ...base, ...extra };
};

/** chat.completions params plus the `thinking` object DeepSeek/MiMo accept */
export type ChatProbeParams = ChatCompletionCreateParamsStreaming & {
    readonly thinking?: { readonly type: string };
    readonly max_completion_tokens?: number;
};

/**
 * DeepSeek / MiMo chat request, mirroring the production wire:
 * - DeepSeek sends nothing in the default mode, `thinking.type=enabled` plus
 *   `reasoning_effort` for an explicit level, and `thinking.type=disabled` for
 *   off (src/ai/platforms/deepseek-platform.ts thinkingParamsOf);
 * - MiMo always sends the switch (enabled for its default, disabled for off)
 *   and its graded effort is best-effort exactly like production, so a level
 *   candidate sends `reasoning_effort` too.
 * The invalid-shape candidate sends `thinking.type: "low"` to confirm the lane
 * rejects it; the toggle-on candidate is probe-only (production never sends the
 * bare enabled switch).
 */
export const buildChatParams = (candidate: ProbeCandidate, options: BuildOptions): ChatProbeParams => {
    const extra: { thinking?: { type: string }; max_completion_tokens?: number } = {};
    if (candidate.platform === 'mimo') {
        if (candidate.variant === 'toggle-off') extra.thinking = { type: 'disabled' };
        else if (candidate.variant === 'invalid-shape') extra.thinking = { type: 'low' };
        else extra.thinking = { type: 'enabled' };
        extra.max_completion_tokens = options.maxOutputTokens;
    } else {
        if (candidate.variant === 'toggle-off') extra.thinking = { type: 'disabled' };
        else if (candidate.variant === 'toggle-on' || candidate.variant === 'level') extra.thinking = { type: 'enabled' };
        extra.max_completion_tokens = options.maxOutputTokens;
    }
    const graded = candidate.variant === 'level' && candidate.effort !== null;
    const reasoning: ChatCompletionCreateParamsStreaming['reasoning_effort'] =
        graded && (candidate.platform === 'deepseek' || candidate.platform === 'mimo')
            ? openAiEffortOf(candidate.effort)
            : undefined;
    return {
        model: candidate.model,
        messages: [{ role: 'user', content: options.prompt }],
        stream: true,
        stream_options: { include_usage: true },
        ...(reasoning === undefined ? {} : { reasoning_effort: reasoning }),
        ...(candidate.withClientTools ? { tools: [chatFunctionTool] } : {}),
        ...extra,
    };
};

/** Mutable probe-side accumulation of one streamed response */
export interface StreamState {
    textChars: number;
    thinkingChars: number;
    inputTokens: number | null;
    /** Billable output tokens: for Gemini candidates + thoughts, else the API total */
    outputTokens: number | null;
    reasoningTokens: number | null;
    totalTokens: number | null;
    finishReason: string | null;
    streamError: string | null;
    events: number;
    unknownEvents: number;
    /** First characters of the answer text, for the evidence file */
    snippet: string;
    /** First characters of the thought text, for the evidence file */
    thinkingSnippet: string;
}

export const createStreamState = (): StreamState => ({
    textChars: 0,
    thinkingChars: 0,
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    finishReason: null,
    streamError: null,
    events: 0,
    unknownEvents: 0,
    snippet: '',
    thinkingSnippet: '',
});

const SNIPPET_LIMIT = 120;

const appendSnippet = (current: string, text: string): string =>
    current.length >= SNIPPET_LIMIT ? current : (current + text).slice(0, SNIPPET_LIMIT);

/** Gemini `streamGenerateContent` chunk (one SSE `data:` line each) */
export const accumulateGemini = (state: StreamState, chunk: GenerateContentResponse): void => {
    state.events += 1;
    const candidate = chunk.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    for (const part of parts) {
        const text = part.text;
        if (typeof text !== 'string' || text === '') continue;
        if (part.thought === true) {
            state.thinkingChars += text.length;
            state.thinkingSnippet = appendSnippet(state.thinkingSnippet, text);
        } else {
            state.textChars += text.length;
            state.snippet = appendSnippet(state.snippet, text);
        }
    }
    const finish = candidate?.finishReason;
    if (typeof finish === 'string' && finish !== 'FINISH_REASON_UNSPECIFIED') state.finishReason = finish;
    const usage = recordOf(chunk.usageMetadata);
    if (usage !== null) {
        const prompt = numberAt(usage['promptTokenCount']);
        const thoughts = numberAt(usage['thoughtsTokenCount']);
        const answer = numberAt(usage['candidatesTokenCount']);
        const total = numberAt(usage['totalTokenCount']);
        if (prompt !== null) state.inputTokens = prompt;
        if (thoughts !== null) state.reasoningTokens = thoughts;
        if (answer !== null) state.outputTokens = answer + (thoughts ?? 0);
        if (total !== null) state.totalTokens = total;
    }
};

const responseUsage = (response: unknown): { input: number | null; output: number | null; reasoning: number | null; total: number | null } => {
    const usage = recordOf(response) === null ? null : recordOf(recordOf(response)?.['usage']);
    return {
        input: numberAt(usage?.['input_tokens']),
        output: numberAt(usage?.['output_tokens']),
        reasoning: numberAt(recordOf(usage?.['output_tokens_details'])?.['reasoning_tokens']),
        total: numberAt(usage?.['total_tokens']),
    };
};

/** OpenAI / Grok Responses SSE event */
export const accumulateResponses = (state: StreamState, event: ResponseStreamEvent): void => {
    state.events += 1;
    switch (event.type) {
        case 'response.output_text.delta': {
            const delta = event.delta;
            if (typeof delta === 'string' && delta !== '') {
                state.textChars += delta.length;
                state.snippet = appendSnippet(state.snippet, delta);
            }
            return;
        }
        case 'response.reasoning_text.delta':
        case 'response.reasoning_summary_text.delta': {
            const delta = event.delta;
            if (typeof delta === 'string' && delta !== '') {
                state.thinkingChars += delta.length;
                state.thinkingSnippet = appendSnippet(state.thinkingSnippet, delta);
            }
            return;
        }
        case 'response.completed':
        case 'response.incomplete': {
            const response = event.response;
            const usage = responseUsage(response);
            if (usage.input !== null) state.inputTokens = usage.input;
            if (usage.output !== null) state.outputTokens = usage.output;
            if (usage.reasoning !== null) state.reasoningTokens = usage.reasoning;
            if (usage.total !== null) state.totalTokens = usage.total;
            // A probe-cap stop on the Responses API only shows up as
            // incomplete_details.reason; keep the reason so the sample is
            // flagged truncated instead of looking like a closed answer.
            const details = recordOf(recordOf(event.response)?.['incomplete_details']);
            const incompleteReason = details?.['reason'];
            state.finishReason =
                event.type === 'response.completed'
                    ? 'completed'
                    : typeof incompleteReason === 'string' && incompleteReason !== ''
                      ? incompleteReason
                      : 'incomplete';
            return;
        }
        case 'response.failed': {
            const error = recordOf(recordOf(event.response)?.['error']);
            const message = error?.['message'];
            state.streamError = typeof message === 'string' && message !== '' ? message : 'response.failed';
            state.finishReason = 'failed';
            return;
        }
        case 'error': {
            state.streamError = typeof event.message === 'string' && event.message !== '' ? event.message : 'stream error event';
            return;
        }
        default:
            state.unknownEvents += 1;
    }
};

/** Anthropic Messages SSE event */
export const accumulateAnthropic = (state: StreamState, event: Anthropic.MessageStreamEvent): void => {
    state.events += 1;
    switch (event.type) {
        case 'message_start': {
            const usage = event.message.usage;
            const input = numberAt(recordOf(usage)?.['input_tokens']);
            if (input !== null) state.inputTokens = input;
            return;
        }
        case 'content_block_start': {
            if (event.content_block.type === 'thinking' && event.content_block.thinking !== undefined) {
                state.thinkingChars += event.content_block.thinking.length;
            }
            return;
        }
        case 'content_block_delta': {
            const delta = event.delta;
            if (delta.type === 'text_delta') {
                state.textChars += delta.text.length;
                state.snippet = appendSnippet(state.snippet, delta.text);
            } else if (delta.type === 'thinking_delta') {
                state.thinkingChars += delta.thinking.length;
                state.thinkingSnippet = appendSnippet(state.thinkingSnippet, delta.thinking);
            }
            return;
        }
        case 'message_delta': {
            const usage = recordOf(event.usage);
            const output = numberAt(usage?.['output_tokens']);
            const thinking = numberAt(recordOf(usage?.['output_tokens_details'])?.['thinking_tokens']);
            if (output !== null) state.outputTokens = output;
            if (thinking !== null) state.reasoningTokens = thinking;
            if (event.delta?.stop_reason !== undefined && event.delta?.stop_reason !== null) {
                state.finishReason = event.delta.stop_reason;
            }
            return;
        }
        default:
            state.unknownEvents += 1;
    }
};

/** chat.completions chunk; `reasoning_content` is the DeepSeek/MiMo extension */
interface ChatReasoningDelta {
    readonly content?: string | null;
    readonly reasoning_content?: string | null;
}

export const accumulateChat = (state: StreamState, chunk: ChatCompletionChunk): void => {
    state.events += 1;
    const choice = chunk.choices[0];
    const delta: ChatReasoningDelta | undefined = choice?.delta;
    const reasoning = delta?.reasoning_content;
    if (typeof reasoning === 'string' && reasoning !== '') {
        state.thinkingChars += reasoning.length;
        state.thinkingSnippet = appendSnippet(state.thinkingSnippet, reasoning);
    }
    const content = delta?.content;
    if (typeof content === 'string' && content !== '') {
        state.textChars += content.length;
        state.snippet = appendSnippet(state.snippet, content);
    }
    const finish = choice?.finish_reason;
    if (typeof finish === 'string') state.finishReason = finish;
    const usage = recordOf(chunk.usage);
    if (usage !== null) {
        const input = numberAt(usage['prompt_tokens']);
        const output = numberAt(usage['completion_tokens']);
        const reasoningTokens = numberAt(recordOf(usage['completion_tokens_details'])?.['reasoning_tokens']);
        const total = numberAt(usage['total_tokens']);
        if (input !== null) state.inputTokens = input;
        if (output !== null) state.outputTokens = output;
        if (reasoningTokens !== null) state.reasoningTokens = reasoningTokens;
        if (total !== null) state.totalTokens = total;
    }
};

/** Total tokens as the provider bills them, when only parts are known */
export const billedOutputTokens = (state: StreamState): number | null => {
    if (state.outputTokens !== null) return state.outputTokens;
    if (state.reasoningTokens !== null) return state.reasoningTokens;
    return null;
};

/**
 * True when a finish reason says the model stopped at the request's token cap
 * (Gemini MAX_TOKENS, OpenAI/Anthropic/xAI max_tokens, chat.completions
 * length). The probe caps its own output to keep the budget bounded, so a
 * capped sample says nothing about how much the effort would have thought.
 */
export const isTokenCapFinishReason = (finishReason: string | null): boolean => {
    const reason = finishReason?.toLowerCase() ?? '';
    // Gemini MAX_TOKENS, Anthropic/xAI/chat max_tokens, Responses
    // incomplete_details.reason=max_output_tokens, chat finish_reason=length.
    return reason === 'length' || (reason.includes('max') && reason.includes('token'));
};

/** True when the model stopped because it hit the request's token cap */
export const hitTokenCap = (state: StreamState): boolean => isTokenCapFinishReason(state.finishReason);

/** The wire family a candidate exercises, for the plan table and evidence */
export const wireFamilyOf = (candidate: ProbeCandidate): string => {
    const variant: ProbeVariant = candidate.variant;
    switch (candidate.platform) {
        case 'gemini':
            return variant === 'budget' ? 'gemini-thinkingBudget' : 'gemini-thinkingLevel';
        case 'openai':
            return 'openai-reasoning.effort';
        case 'anthropic':
            return 'anthropic-output_config.effort';
        case 'grok':
            return 'xai-reasoning.effort';
        case 'deepseek':
            return variant === 'toggle-off' || variant === 'toggle-on' ? 'deepseek-thinking.type' : 'deepseek-reasoning_effort';
        case 'mimo':
            return variant === 'level' ? 'mimo-reasoning_effort' : 'mimo-thinking.type';
    }
};
