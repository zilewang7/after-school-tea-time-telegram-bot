/**
 * W0 stub lane traffic: the whole runner with zero network (design §7's W0).
 *
 * `--stub` swaps the base URLs for an in-process fetch that answers each
 * protocol with a small scripted stream. It exists to rehearse the pipeline
 * (plan → budget → classify → infer → files) without spending a cent and
 * without the test container; the real lanes never use it.
 */
import type { ProbeLaneConfiguration } from './effort-env.mts';
import { recordOf, type ProbePlatform } from './effort-types.mts';
import type { ProbeFetch } from './effort-lanes.mts';

interface StubReply {
    readonly status: number;
    readonly contentType: string;
    readonly body: string;
}

const JSON_TYPE = 'application/json';
const SSE_TYPE = 'text/event-stream';

/** Fake credentials and hosts; the stub never dials them */
export const stubLaneConfigurations = (): Readonly<Record<ProbePlatform, ProbeLaneConfiguration>> => {
    const laneOf = (platform: ProbePlatform): ProbeLaneConfiguration => ({
        platform,
        laneId: `stub:${platform}`,
        baseUrl: `http://stub.invalid/${platform}`,
        host: 'stub.invalid',
        apiKey: 'stub-key',
        vertexai: false,
        project: null,
        location: null,
        problems: [],
    });
    const record: Record<ProbePlatform, ProbeLaneConfiguration> = {
        gemini: {
            ...laneOf('gemini'),
            laneId: 'stub-vertex',
            vertexai: true,
            apiKey: 'stub-key',
            baseUrl: null,
            host: null,
        },
        openai: laneOf('openai'),
        anthropic: laneOf('anthropic'),
        grok: laneOf('grok'),
        deepseek: laneOf('deepseek'),
        mimo: laneOf('mimo'),
    };
    return record;
};

const json = (value: unknown): string => JSON.stringify(value);

const sseData = (payload: unknown): string => `data: ${json(payload)}\n\n`;

const namedEvent = (payload: Record<string, unknown>): string => `event: ${String(payload['type'])}\ndata: ${json(payload)}\n\n`;

const sse = (body: string): StubReply => ({ status: 200, contentType: SSE_TYPE, body });

const httpError = (status: number, message: string): StubReply => ({
    status,
    contentType: JSON_TYPE,
    body: json({ error: { message, type: 'invalid_request_error', code: status } }),
});

const STUB_ANSWER = '39872';
const STUB_THOUGHTS = 'Compute 137*291 = 39867, then add 5: 39872.';

interface StubModelBehavior {
    /** Default tokens of the vendor default level */
    readonly baselineReasoningTokens: number;
    /** Reasoning tokens per effort when the model has graded levels */
    readonly reasoningByEffort: Readonly<Record<string, number>>;
    /** Levels the stub pretends the lane accepts; empty = no graded levels */
    readonly acceptedLevels: readonly string[];
    /** Toggle behavior (DeepSeek/MiMo): does the stub accept the on/off switch */
    readonly toggle: boolean;
}

const GEMINI_BEHAVIOR: Readonly<Record<string, StubModelBehavior>> = {
    'gemini-4-hydrogen': {
        baselineReasoningTokens: 1200,
        reasoningByEffort: { LOW: 420, MEDIUM: 840, HIGH: 1200, XHIGH: 2400, MAX: 1200 },
        acceptedLevels: ['LOW', 'MEDIUM', 'HIGH', 'XHIGH'],
        toggle: false,
    },
    'gemini-4-argon': {
        baselineReasoningTokens: 800,
        reasoningByEffort: { LOW: 400, MEDIUM: 800, HIGH: 1280, XHIGH: 1280, MAX: 800 },
        acceptedLevels: ['LOW', 'MEDIUM', 'HIGH'],
        toggle: false,
    },
    'gemini-4-carbon': {
        baselineReasoningTokens: 800,
        reasoningByEffort: { LOW: 400, MEDIUM: 800, HIGH: 1280, XHIGH: 1280, MAX: 800 },
        acceptedLevels: ['LOW', 'MEDIUM', 'HIGH'],
        toggle: false,
    },
};

const OPENAI_BEHAVIOR: Readonly<Record<string, StubModelBehavior>> = {
    'gpt-6-luna': {
        baselineReasoningTokens: 500,
        reasoningByEffort: { none: 20, minimal: 60, low: 200, medium: 500, high: 900, xhigh: 1600, max: 2400 },
        acceptedLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
        toggle: false,
    },
    'gpt-6-astra': {
        baselineReasoningTokens: 500,
        reasoningByEffort: { none: 20, minimal: 60, low: 200, medium: 500, high: 900, xhigh: 1600, max: 2400 },
        acceptedLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        toggle: false,
    },
    'gpt-6.1-sol': {
        baselineReasoningTokens: 500,
        reasoningByEffort: { none: 20, minimal: 60, low: 200, medium: 500, high: 900, xhigh: 1600, max: 2400 },
        acceptedLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        toggle: false,
    },
    'gpt-6.1-terra': {
        baselineReasoningTokens: 500,
        reasoningByEffort: { none: 20, minimal: 60, low: 200, medium: 500, high: 900, xhigh: 1600, max: 2400 },
        acceptedLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
        toggle: false,
    },
};

const ANTHROPIC_BEHAVIOR: StubModelBehavior = {
    baselineReasoningTokens: 900,
    reasoningByEffort: { minimal: 100, none: 50, low: 250, medium: 500, high: 900, xhigh: 1500, max: 2200 },
    acceptedLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    toggle: false,
};

const GROK_BEHAVIOR: StubModelBehavior = {
    baselineReasoningTokens: 500,
    reasoningByEffort: { minimal: 100, low: 150, medium: 300, high: 500, xhigh: 900 },
    acceptedLevels: ['low', 'medium', 'high', 'xhigh'],
    toggle: false,
};

const DEEPSEEK_BEHAVIOR: StubModelBehavior = {
    baselineReasoningTokens: 400,
    // minimal/xhigh are accepted by DeepSeek but mapped to low/high (inert)
    reasoningByEffort: { none: 0, minimal: 200, low: 200, high: 400, xhigh: 400, max: 900 },
    acceptedLevels: ['none', 'minimal', 'low', 'high', 'xhigh', 'max'],
    toggle: true,
};

const MIMO_BEHAVIOR: StubModelBehavior = {
    baselineReasoningTokens: 300,
    reasoningByEffort: { enabled: 300, disabled: 0 },
    acceptedLevels: [],
    toggle: true,
};

const behaviorOf = (platform: ProbePlatform, model: string): StubModelBehavior => {
    const lower = model.toLowerCase();
    if (platform === 'gemini') return GEMINI_BEHAVIOR[lower] ?? GEMINI_BEHAVIOR['gemini-4-hydrogen'] ?? MIMO_BEHAVIOR;
    if (platform === 'openai') return OPENAI_BEHAVIOR[lower] ?? OPENAI_BEHAVIOR['gpt-6-luna'] ?? MIMO_BEHAVIOR;
    if (platform === 'anthropic') return ANTHROPIC_BEHAVIOR;
    if (platform === 'grok') return GROK_BEHAVIOR;
    if (platform === 'deepseek') return DEEPSEEK_BEHAVIOR;
    return MIMO_BEHAVIOR;
};

/** Which platform the request URL belongs to */
const platformOfRequest = (url: string, model: string): ProbePlatform => {
    if (url.includes(':streamGenerateContent')) return 'gemini';
    if (url.includes('/responses')) return model.toLowerCase().startsWith('grok') ? 'grok' : 'openai';
    if (url.includes('/messages')) return 'anthropic';
    if (model.toLowerCase().startsWith('mimo')) return 'mimo';
    return 'deepseek';
};

const modelOf = (body: Record<string, unknown>): string => (typeof body['model'] === 'string' ? body['model'] : '');

/** The token cap the request carries; a wire without one gets a generous default */
const outputCapOf = (platform: ProbePlatform, body: Record<string, unknown>): number => {
    const candidates: unknown[] =
        platform === 'gemini'
            ? [recordOf(body['generationConfig'])?.['maxOutputTokens']]
            : [body['max_output_tokens'], body['max_tokens'], body['max_completion_tokens']];
    for (const candidate of candidates) {
        if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) return candidate;
    }
    return 2_048;
};

/** Stub streams never exceed the request's cap: the budget guard relies on it */
const clampTokens = (reasoningTokens: number, cap: number): number => Math.max(0, Math.min(reasoningTokens, cap - 12));

/** Gemini puts the model in the URL path, not in the body */
const modelFromUrl = (url: string): string => {
    const match = /\/models\/([^/:?]+)/.exec(new URL(url, 'http://stub.invalid').pathname);
    return match?.[1] ?? '';
};

/** Simulated acceptance decision; returns an error reply or the reasoning tokens */
const decide = (
    platform: ProbePlatform,
    model: string,
    body: Record<string, unknown>
): { readonly error: StubReply } | { readonly reasoningTokens: number } => {
    const behavior = behaviorOf(platform, model);
    if (platform === 'gemini') {
        const config = recordOf(body['generationConfig']);
        const thinking = config === null ? null : recordOf(config['thinkingConfig']);
        if (thinking === null) return { reasoningTokens: behavior.baselineReasoningTokens };
        if (thinking['thinkingBudget'] !== undefined) {
            return { error: httpError(400, 'Thinking budget is not supported for this model') };
        }
        const level = thinking['thinkingLevel'];
        if (level === undefined) return { reasoningTokens: behavior.baselineReasoningTokens };
        if (typeof level !== 'string' || !behavior.acceptedLevels.includes(level)) {
            return { error: httpError(400, `Thinking level is unsupported: THINKING_LEVEL_${String(level)}`) };
        }
        return { reasoningTokens: behavior.reasoningByEffort[level] ?? behavior.baselineReasoningTokens };
    }
    if (platform === 'openai') {
        const reasoning = recordOf(body['reasoning']);
        const effort = reasoning?.['effort'];
        if (effort === undefined || effort === null) return { reasoningTokens: behavior.baselineReasoningTokens };
        if (typeof effort !== 'string' || !behavior.acceptedLevels.includes(effort)) {
            return { error: httpError(400, `Unsupported parameter: 'reasoning.effort' (got ${String(effort)})`) };
        }
        return { reasoningTokens: behavior.reasoningByEffort[effort] ?? behavior.baselineReasoningTokens };
    }
    if (platform === 'anthropic') {
        const outputConfig = recordOf(body['output_config']);
        const effort = outputConfig?.['effort'];
        if (effort === undefined || effort === null) return { reasoningTokens: behavior.baselineReasoningTokens };
        if (typeof effort !== 'string' || !behavior.acceptedLevels.includes(effort)) {
            return { error: httpError(400, `output_config.effort: Input should be 'low', 'medium', 'high', 'xhigh' or 'max'`) };
        }
        return { reasoningTokens: behavior.reasoningByEffort[effort] ?? behavior.baselineReasoningTokens };
    }
    if (platform === 'grok') {
        const reasoning = recordOf(body['reasoning']);
        const effort = reasoning?.['effort'];
        if (effort === undefined || effort === null) return { reasoningTokens: behavior.baselineReasoningTokens };
        if (typeof effort !== 'string' || !behavior.acceptedLevels.includes(effort)) {
            return { error: httpError(400, `Argument not supported: reasoning.effort (got ${String(effort)})`) };
        }
        return { reasoningTokens: behavior.reasoningByEffort[effort] ?? behavior.baselineReasoningTokens };
    }
    const thinking = recordOf(body['thinking']);
    if (platform === 'mimo') {
        const type = thinking?.['type'];
        if (type === undefined) return { reasoningTokens: behavior.baselineReasoningTokens };
        if (type === 'disabled') return { reasoningTokens: 0 };
        if (type === 'enabled') return { reasoningTokens: behavior.baselineReasoningTokens };
        return { error: httpError(400, `Invalid value for 'thinking.type': ${String(type)}`) };
    }
    // DeepSeek: reasoning_effort and the thinking switch
    if (thinking?.['type'] === 'disabled') return { reasoningTokens: 0 };
    const effort = body['reasoning_effort'];
    if (effort === undefined) return { reasoningTokens: behavior.baselineReasoningTokens };
    if (typeof effort !== 'string' || !behavior.acceptedLevels.includes(effort)) {
        return { error: httpError(400, `Unrecognized request argument supplied: reasoning_effort (got ${String(effort)})`) };
    }
    return { reasoningTokens: behavior.reasoningByEffort[effort] ?? behavior.baselineReasoningTokens };
};

const geminiStream = (reasoningTokens: number): StubReply => {
    const chunks = [
        {
            candidates: [{ content: { role: 'model', parts: [{ text: STUB_THOUGHTS, thought: true }] } }],
        },
        {
            candidates: [{ content: { role: 'model', parts: [{ text: STUB_ANSWER }] }, finishReason: 'STOP' }],
            usageMetadata: {
                promptTokenCount: 100,
                candidatesTokenCount: 12,
                thoughtsTokenCount: reasoningTokens,
                totalTokenCount: 112 + reasoningTokens,
            },
        },
    ];
    return sse(chunks.map(sseData).join(''));
};

const totalTokensOf = (reasoningTokens: number): number => 100 + 12 + reasoningTokens;

const responsesStream = (model: string, reasoningTokens: number): StubReply => {
    const completed = {
        id: 'resp_stub',
        object: 'response',
        created_at: 0,
        status: 'completed',
        model,
        output: [],
        usage: {
            input_tokens: 100,
            output_tokens: 12 + reasoningTokens,
            total_tokens: totalTokensOf(reasoningTokens),
            output_tokens_details: { reasoning_tokens: reasoningTokens },
        },
    };
    const body = [
        namedEvent({
            type: 'response.reasoning_summary_text.delta',
            item_id: 'rs_1',
            output_index: 0,
            summary_index: 0,
            delta: STUB_THOUGHTS,
        }),
        namedEvent({
            type: 'response.output_text.delta',
            item_id: 'msg_1',
            output_index: 1,
            content_index: 0,
            delta: STUB_ANSWER,
        }),
        namedEvent({ type: 'response.completed', response: completed }),
    ].join('');
    return sse(body);
};

const anthropicStream = (model: string, reasoningTokens: number): StubReply => {
    const body = [
        namedEvent({
            type: 'message_start',
            message: {
                id: 'msg_stub',
                type: 'message',
                role: 'assistant',
                model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 100, output_tokens: 0 },
            },
        }),
        namedEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
        namedEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: STUB_THOUGHTS } }),
        namedEvent({ type: 'content_block_stop', index: 0 }),
        namedEvent({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
        namedEvent({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: STUB_ANSWER } }),
        namedEvent({ type: 'content_block_stop', index: 1 }),
        namedEvent({
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 12 + reasoningTokens, output_tokens_details: { thinking_tokens: reasoningTokens } },
        }),
        namedEvent({ type: 'message_stop' }),
    ].join('');
    return sse(body);
};

const chatStream = (model: string, reasoningTokens: number): StubReply => {
    const chunk = (delta: Record<string, unknown>, finishReason: string | null = null): string =>
        sseData({
            id: 'chatcmpl-stub',
            object: 'chat.completion.chunk',
            created: 0,
            model,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
        });
    const body =
        chunk({ reasoning_content: STUB_THOUGHTS }) +
        chunk({ content: STUB_ANSWER }) +
        chunk({}, 'stop') +
        sseData({
            id: 'chatcmpl-stub',
            object: 'chat.completion.chunk',
            created: 0,
            model,
            choices: [],
            usage: {
                prompt_tokens: 100,
                completion_tokens: 12 + reasoningTokens,
                total_tokens: totalTokensOf(reasoningTokens),
                completion_tokens_details: { reasoning_tokens: reasoningTokens },
            },
        }) +
        'data: [DONE]\n\n';
    return sse(body);
};

/** An in-process fetch that answers each protocol like the real lane would */
export const createStubFetch = (): ProbeFetch => async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const rawBody = typeof init?.body === 'string' ? init.body : '{}';
    let body: Record<string, unknown> = {};
    try {
        const parsed: unknown = JSON.parse(rawBody);
        const record = recordOf(parsed);
        if (record !== null) body = record;
    } catch {
        return new Response(json({ error: { message: 'stub: request body is not JSON' } }), {
            status: 400,
            headers: { 'content-type': JSON_TYPE },
        });
    }
    const platform = platformOfRequest(url, modelOf(body));
    const model = platform === 'gemini' ? modelFromUrl(url) : modelOf(body);
    const decision = decide(platform, model, body);
    if ('error' in decision) {
        return new Response(decision.error.body, {
            status: decision.error.status,
            headers: { 'content-type': decision.error.contentType },
        });
    }
    const reasoningTokens = clampTokens(decision.reasoningTokens, outputCapOf(platform, body));
    const reply =
        platform === 'gemini'
            ? geminiStream(reasoningTokens)
            : platform === 'anthropic'
              ? anthropicStream(model, reasoningTokens)
              : platform === 'openai' || platform === 'grok'
                ? responsesStream(model, reasoningTokens)
                : chatStream(model, reasoningTokens);
    return new Response(reply.body, { status: reply.status, headers: { 'content-type': reply.contentType } });
};
