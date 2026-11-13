/**
 * Six lane adapters: same SDK version and same base URL the production clients
 * use, but a raw request built by effort-wire and no platform fallback.
 *
 * Platform fallbacks (OpenAI xhigh→high, Gemini XHIGH→HIGH, Grok candidate
 * retries) would swallow exactly the 400 the probe is looking for, so the
 * adapters never reuse `src/ai/platforms`; they talk to the SDK clients
 * directly, disable the SDK's own retries, and record every exchange.
 *
 * A recorder wraps the injected fetch: it keeps the request body actually sent,
 * the HTTP status, the whitelisted headers and the raw error body. That raw
 * evidence is what the classifier turns into `rejected_effort` vs `auth_error`.
 */
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import { classifyProbeError, type ProbeErrorClass } from './effort-errors.mts';
import { laneConfigurationsOf, redactorOf, type ProbeLaneConfiguration } from './effort-env.mts';
import type { ProbeEnvironment } from './effort-env.mts';
import {
    EVIDENCE_LIMIT,
    LANE_HEADER_NAMES,
    PROBE_PROMPT,
    type ProbeCandidate,
    type ProbeObservation,
    type ProbePlatform,
} from './effort-types.mts';
import {
    accumulateAnthropic,
    accumulateChat,
    accumulateGemini,
    accumulateResponses,
    buildAnthropicParams,
    buildChatParams,
    buildGeminiParams,
    buildGrokResponsesParams,
    buildOpenAiResponsesParams,
    createStreamState,
    hitTokenCap,
    type BuildOptions,
    type StreamState,
} from './effort-wire.mts';

/**
 * The evidence observation plus the probe-cap flag. The extra field is written
 * into observations.json (the §7 results document never carries it), so a
 * capped answer is visible after the run; `effort-types.mts` stays untouched.
 */
interface TruncatedObservation extends ProbeObservation {
    /** The probe's own output cap stopped the answer, so its token count is a floor */
    readonly truncated: boolean;
}

/** The fetch signature both SDKs accept, so tests can inject a scripted one */
export type ProbeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface RecordedExchange {
    readonly url: string;
    readonly requestBodyText: string;
    status: number | null;
    headers: Record<string, string>;
    responseText: string | null;
    networkError: string | null;
    /** performance.now() when the headers arrived; null when the fetch threw */
    responseAt: number | null;
}

/** Routing/rate-limit headers only; nothing else from the wire is kept */
const headerWhitelist = (headers: Headers): Record<string, string> => {
    const picked: Record<string, string> = {};
    for (const name of LANE_HEADER_NAMES) {
        const value = headers.get(name);
        if (value !== null) picked[name] = value;
    }
    return picked;
};

const urlOf = (input: string | URL | Request): string => {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.toString();
    return input.url;
};

const requestBodyTextOf = (init: RequestInit | undefined): string => {
    const body = init?.body;
    if (typeof body === 'string') return body;
    if (body === undefined || body === null) return '';
    return '<non-string body>';
};

interface Recorder {
    readonly exchanges: RecordedExchange[];
    readonly fetch: ProbeFetch;
}

/** One recording fetch; each send call gets a fresh recorder */
export const createRecorder = (baseFetch: ProbeFetch): Recorder => {
    const exchanges: RecordedExchange[] = [];
    const recordingFetch: ProbeFetch = async (input, init) => {
        const exchange: RecordedExchange = {
            url: urlOf(input),
            requestBodyText: requestBodyTextOf(init),
            status: null,
            headers: {},
            responseText: null,
            networkError: null,
            responseAt: null,
        };
        exchanges.push(exchange);
        let response: Response;
        try {
            response = await baseFetch(input, init);
        } catch (error) {
            exchange.networkError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
            throw error;
        }
        exchange.status = response.status;
        exchange.headers = headerWhitelist(response.headers);
        exchange.responseAt = performance.now();
        if (!response.ok) {
            // Error bodies are small; keep them for the classifier and the evidence
            const text = await response.text();
            exchange.responseText = text;
            return new Response(text, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
            });
        }
        return response;
    };
    return { exchanges, fetch: recordingFetch };
};

/**
 * Routes the next request to the recorder the send call just created. One lane
 * runs one request at a time (the runner is concurrency 1), so a single slot is
 * enough and the ADC-authenticated Gemini client can be reused across sends.
 */
class FetchDispatcher {
    private current: Recorder | null = null;

    use(recorder: Recorder): void {
        this.current = recorder;
    }

    readonly fetch: ProbeFetch = (input, init) => {
        const recorder = this.current;
        if (recorder === null) throw new Error('probe fetch used without a recorder');
        return recorder.fetch(input, init);
    };
}

export interface ProbeSendOptions {
    readonly maxOutputTokens: number;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
}

export interface ProbeLane {
    readonly platform: ProbePlatform;
    readonly configuration: ProbeLaneConfiguration;
    readonly ready: boolean;
    /** One wire request; never retries (the runner owns retries) */
    send(candidate: ProbeCandidate, options: ProbeSendOptions): Promise<ProbeObservation>;
}

interface SendContext {
    readonly platform: ProbePlatform;
    readonly laneId: string;
    readonly baseFetch: ProbeFetch;
    readonly dispatch: FetchDispatcher;
    readonly redact: (text: string) => string;
}

/** Mutable timing state of the request being consumed */
interface StreamRuntime {
    readonly state: StreamState;
    readonly startedAtMs: number;
    ttfbMs: number | null;
    firstThinkingMs: number | null;
}

const updateTrace = (runtime: StreamRuntime, thinkingBefore: number): void => {
    const elapsed = Math.round(performance.now() - runtime.startedAtMs);
    if (runtime.ttfbMs === null && runtime.state.events > 0) runtime.ttfbMs = elapsed;
    if (runtime.firstThinkingMs === null && runtime.state.thinkingChars > thinkingBefore) {
        runtime.firstThinkingMs = elapsed;
    }
};

/** Feed one provider stream through its accumulator, timing the first events */
const drain = async <T,>(
    runtime: StreamRuntime,
    events: AsyncIterable<T>,
    accumulate: (state: StreamState, event: T) => void
): Promise<void> => {
    for await (const event of events) {
        const thinkingBefore = runtime.state.thinkingChars;
        accumulate(runtime.state, event);
        updateTrace(runtime, thinkingBefore);
    }
};

const outcomeOf = (errorClass: ProbeErrorClass | null): ProbeObservation['outcome'] => {
    if (errorClass === null) return 'accepted';
    if (errorClass === 'rejected_effort' || errorClass === 'rejected_other') return 'rejected';
    return 'error';
};

interface FinalizeInput {
    readonly context: SendContext;
    readonly candidate: ProbeCandidate;
    readonly state: StreamState;
    readonly runtime: StreamRuntime;
    readonly startedAt: string;
    readonly exchanges: readonly RecordedExchange[];
    readonly thrown: unknown;
}

const finalizeObservation = (input: FinalizeInput): ProbeObservation => {
    const totalMs = Math.round(performance.now() - input.runtime.startedAtMs);
    const lastExchange = input.exchanges[input.exchanges.length - 1] ?? null;
    const status = lastExchange?.status ?? null;
    const ttfbMs =
        input.runtime.ttfbMs ??
        (lastExchange?.responseAt === null || lastExchange?.responseAt === undefined
            ? null
            : Math.round(lastExchange.responseAt - input.runtime.startedAtMs));
    const requestExcerpt = input.context.redact(lastExchange?.requestBodyText ?? '').slice(0, EVIDENCE_LIMIT);
    const rawError = lastExchange?.responseText ?? lastExchange?.networkError ?? '';
    const thrownMessage =
        input.thrown instanceof Error ? input.thrown.message : input.thrown === null || input.thrown === undefined ? '' : String(input.thrown);
    const laneHeaders = lastExchange?.headers ?? {};

    if (input.thrown !== null && input.thrown !== undefined || input.state.streamError !== null) {
        const duringStream = status !== null && status >= 200 && status < 300;
        const classification = classifyProbeError(
            {
                platform: input.candidate.platform,
                status,
                raw: rawError,
                thrownMessage: input.state.streamError === null ? thrownMessage : `${input.state.streamError} ${thrownMessage}`,
                duringStream,
            },
            input.context.redact
        );
        const observation: TruncatedObservation = {
            candidateId: input.candidate.id,
            model: input.candidate.model,
            platform: input.candidate.platform,
            wave: input.candidate.wave,
            variant: input.candidate.variant,
            effort: input.candidate.effort,
            withClientTools: input.candidate.withClientTools,
            expectedRejection: input.candidate.expectedRejection ?? null,
            attempt: 1,
            startedAt: input.startedAt,
            totalMs,
            ttfbMs,
            firstThinkingMs: input.runtime.firstThinkingMs,
            status,
            outcome: outcomeOf(classification.errorClass),
            errorClass: classification.errorClass,
            errorFingerprint: classification.fingerprint,
            errorSummary: classification.summary,
            inputTokens: input.state.inputTokens,
            outputTokens: input.state.outputTokens,
            reasoningTokens: input.state.reasoningTokens,
            totalTokens: input.state.totalTokens,
            textChars: input.state.textChars,
            thinkingChars: input.state.thinkingChars,
            finishReason: input.state.finishReason,
            streamError: input.state.streamError,
            requestExcerpt,
            responseExcerpt: input.context.redact(`${rawError} ${thrownMessage}`).trim().slice(0, EVIDENCE_LIMIT),
            laneHeaders,
            laneId: input.context.laneId,
            estimatedCostUsd: input.candidate.estimatedCostUsd,
            costUsd: input.candidate.estimatedCostUsd,
            usageReported: input.state.inputTokens !== null || input.state.outputTokens !== null,
            truncated: hitTokenCap(input.state),
        };
        return observation;
    }

    const observation: TruncatedObservation = {
        candidateId: input.candidate.id,
        model: input.candidate.model,
        platform: input.candidate.platform,
        wave: input.candidate.wave,
        variant: input.candidate.variant,
        effort: input.candidate.effort,
        withClientTools: input.candidate.withClientTools,
        expectedRejection: input.candidate.expectedRejection ?? null,
        attempt: 1,
        startedAt: input.startedAt,
        totalMs,
        ttfbMs,
        firstThinkingMs: input.runtime.firstThinkingMs,
        status,
        outcome: status !== null && status >= 200 && status < 300 ? 'accepted' : 'error',
        errorClass: null,
        errorFingerprint: null,
        errorSummary: null,
        inputTokens: input.state.inputTokens,
        outputTokens: input.state.outputTokens,
        reasoningTokens: input.state.reasoningTokens,
        totalTokens: input.state.totalTokens,
        textChars: input.state.textChars,
        thinkingChars: input.state.thinkingChars,
        finishReason: input.state.finishReason,
        streamError: input.state.streamError,
        requestExcerpt,
        responseExcerpt: input.context.redact(
            JSON.stringify({
                text: input.state.snippet,
                thinking: input.state.thinkingSnippet,
                events: input.state.events,
                unknownEvents: input.state.unknownEvents,
            })
        ).slice(0, EVIDENCE_LIMIT),
        laneHeaders,
        laneId: input.context.laneId,
        estimatedCostUsd: input.candidate.estimatedCostUsd,
        costUsd: input.candidate.estimatedCostUsd,
        usageReported: input.state.inputTokens !== null || input.state.outputTokens !== null,
        truncated: hitTokenCap(input.state),
    };
    return observation;
};

/**
 * Opens one streamed request, consumes it through `consume`, and turns the
 * outcome into an observation. SDK retries are disabled by the clients, so at
 * most one exchange is recorded per call.
 */
const runRequest = async (
    context: SendContext,
    candidate: ProbeCandidate,
    open: (runtime: StreamRuntime) => Promise<() => Promise<void>>
): Promise<ProbeObservation> => {
    const startedAtMs = performance.now();
    const startedAt = new Date().toISOString();
    const recorder = createRecorder(context.baseFetch);
    context.dispatch.use(recorder);
    const runtime: StreamRuntime = {
        state: createStreamState(),
        startedAtMs,
        ttfbMs: null,
        firstThinkingMs: null,
    };
    let thrown: unknown = null;
    try {
        const consume = await open(runtime);
        await consume();
    } catch (error) {
        thrown = error;
    }
    return finalizeObservation({
        context,
        candidate,
        state: runtime.state,
        runtime,
        startedAt,
        exchanges: recorder.exchanges,
        thrown,
    });
};

const buildOptionsOf = (options: ProbeSendOptions): BuildOptions => ({
    maxOutputTokens: options.maxOutputTokens,
    prompt: PROBE_PROMPT,
    timeoutMs: options.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
});

const requestOptionsOf = (options: ProbeSendOptions): { signal?: AbortSignal; timeout: number; maxRetries: number } => ({
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    timeout: options.timeoutMs,
    maxRetries: 0,
});

/** A lane whose client could not be built still exists, but is not ready */
const laneOf = (input: {
    readonly platform: ProbePlatform;
    readonly configuration: ProbeLaneConfiguration;
    readonly send: (candidate: ProbeCandidate, options: ProbeSendOptions) => Promise<ProbeObservation>;
}): ProbeLane => ({
    platform: input.platform,
    configuration: input.configuration,
    ready: input.configuration.problems.length === 0,
    send: input.send,
});

/**
 * Build the six lanes. Clients are created once (the ADC-based Gemini client
 * must not re-read credentials per request); a dispatcher forwards each
 * request's traffic to the recorder of that send call, since one run is
 * sequential.
 */
export const createProbeLanes = (
    environment: ProbeEnvironment,
    options: {
        readonly fetch?: ProbeFetch;
        readonly lanes?: Partial<Record<ProbePlatform, ProbeLaneConfiguration>>;
        readonly credentialsFileExists?: (path: string) => boolean;
    } = {}
): Readonly<Record<ProbePlatform, ProbeLane>> => {
    const baseFetch = options.fetch ?? ((input, init) => fetch(input, init));
    const redact = redactorOf(environment);
    const fallbackConfigurations =
        options.credentialsFileExists === undefined
            ? laneConfigurationsOf(environment)
            : laneConfigurationsOf(environment, { credentialsFileExists: options.credentialsFileExists });
    const lanes: Record<ProbePlatform, ProbeLaneConfiguration> = {
        gemini: options.lanes?.gemini ?? fallbackConfigurations.gemini,
        openai: options.lanes?.openai ?? fallbackConfigurations.openai,
        anthropic: options.lanes?.anthropic ?? fallbackConfigurations.anthropic,
        grok: options.lanes?.grok ?? fallbackConfigurations.grok,
        deepseek: options.lanes?.deepseek ?? fallbackConfigurations.deepseek,
        mimo: options.lanes?.mimo ?? fallbackConfigurations.mimo,
    };
    const dispatch = new FetchDispatcher();
    const ready = (platform: ProbePlatform): boolean => lanes[platform].problems.length === 0;
    const contextOf = (platform: ProbePlatform): SendContext => ({
        platform,
        laneId: lanes[platform].laneId,
        baseFetch,
        dispatch,
        redact,
    });

    const geminiConfiguration = lanes.gemini;
    const geminiClient = ready('gemini')
        ? new GoogleGenAI(
              geminiConfiguration.vertexai
                  ? geminiConfiguration.project === null
                      ? {
                            vertexai: true,
                            apiKey: geminiConfiguration.apiKey ?? undefined,
                            httpOptions: { fetch: dispatch.fetch, retryOptions: { attempts: 1 } },
                        }
                      : {
                            vertexai: true,
                            project: geminiConfiguration.project,
                            location: geminiConfiguration.location ?? 'global',
                            httpOptions: { fetch: dispatch.fetch, retryOptions: { attempts: 1 } },
                        }
                  : {
                        vertexai: false,
                        apiKey: geminiConfiguration.apiKey ?? undefined,
                        httpOptions: {
                            ...(geminiConfiguration.baseUrl === null ? {} : { baseUrl: geminiConfiguration.baseUrl }),
                            fetch: dispatch.fetch,
                            retryOptions: { attempts: 1 },
                        },
                    }
          )
        : null;

    const openAiStyleClient = (platform: ProbePlatform): OpenAI | null => {
        if (!ready(platform)) return null;
        const configuration = lanes[platform];
        return new OpenAI({
            apiKey: configuration.apiKey ?? '',
            baseURL: configuration.baseUrl ?? undefined,
            fetch: dispatch.fetch,
            maxRetries: 0,
        });
    };

    const openAiClient = openAiStyleClient('openai');
    const grokClient = openAiStyleClient('grok');
    const deepseekClient = openAiStyleClient('deepseek');
    const mimoClient = openAiStyleClient('mimo');

    const anthropicConfiguration = lanes.anthropic;
    const anthropicClient = ready('anthropic')
        ? new Anthropic({
              apiKey: anthropicConfiguration.apiKey ?? '',
              baseURL: anthropicConfiguration.baseUrl ?? 'https://api.anthropic.com',
              fetch: dispatch.fetch,
              maxRetries: 0,
          })
        : null;

    return {
        gemini: laneOf({
            platform: 'gemini',
            configuration: lanes.gemini,
            send: async (candidate, sendOptions) =>
                runRequest(contextOf('gemini'), candidate, async (runtime) => {
                    const client = geminiClient;
                    if (client === null) throw new Error('gemini lane is not configured');
                    const stream = await client.models.generateContentStream(buildGeminiParams(candidate, buildOptionsOf(sendOptions)));
                    return async () => {
                        await drain(runtime, stream, accumulateGemini);
                    };
                }),
        }),
        openai: laneOf({
            platform: 'openai',
            configuration: lanes.openai,
            send: async (candidate, sendOptions) =>
                runRequest(contextOf('openai'), candidate, async (runtime) => {
                    const client = openAiClient;
                    if (client === null) throw new Error('openai lane is not configured');
                    const stream = await client.responses.create(
                        buildOpenAiResponsesParams(candidate, buildOptionsOf(sendOptions)),
                        requestOptionsOf(sendOptions)
                    );
                    return async () => {
                        await drain(runtime, stream, accumulateResponses);
                    };
                }),
        }),
        anthropic: laneOf({
            platform: 'anthropic',
            configuration: lanes.anthropic,
            send: async (candidate, sendOptions) =>
                runRequest(contextOf('anthropic'), candidate, async (runtime) => {
                    const client = anthropicClient;
                    if (client === null) throw new Error('anthropic lane is not configured');
                    const stream = await client.messages.create(
                        buildAnthropicParams(candidate, buildOptionsOf(sendOptions)),
                        requestOptionsOf(sendOptions)
                    );
                    return async () => {
                        await drain(runtime, stream, accumulateAnthropic);
                    };
                }),
        }),
        grok: laneOf({
            platform: 'grok',
            configuration: lanes.grok,
            send: async (candidate, sendOptions) =>
                runRequest(contextOf('grok'), candidate, async (runtime) => {
                    const client = grokClient;
                    if (client === null) throw new Error('grok lane is not configured');
                    const stream = await client.responses.create(
                        buildGrokResponsesParams(candidate, buildOptionsOf(sendOptions)),
                        requestOptionsOf(sendOptions)
                    );
                    return async () => {
                        await drain(runtime, stream, accumulateResponses);
                    };
                }),
        }),
        deepseek: laneOf({
            platform: 'deepseek',
            configuration: lanes.deepseek,
            send: async (candidate, sendOptions) =>
                runRequest(contextOf('deepseek'), candidate, async (runtime) => {
                    const client = deepseekClient;
                    if (client === null) throw new Error('deepseek lane is not configured');
                    const stream = await client.chat.completions.create(
                        buildChatParams(candidate, buildOptionsOf(sendOptions)),
                        requestOptionsOf(sendOptions)
                    );
                    return async () => {
                        await drain(runtime, stream, accumulateChat);
                    };
                }),
        }),
        mimo: laneOf({
            platform: 'mimo',
            configuration: lanes.mimo,
            send: async (candidate, sendOptions) =>
                runRequest(contextOf('mimo'), candidate, async (runtime) => {
                    const client = mimoClient;
                    if (client === null) throw new Error('mimo lane is not configured');
                    const stream = await client.chat.completions.create(
                        buildChatParams(candidate, buildOptionsOf(sendOptions)),
                        requestOptionsOf(sendOptions)
                    );
                    return async () => {
                        await drain(runtime, stream, accumulateChat);
                    };
                }),
        }),
    };
};
