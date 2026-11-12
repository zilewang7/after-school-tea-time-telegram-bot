/**
 * Gemini platform implementation
 */
import {
    GoogleGenAI,
    type Content,
    type GenerateContentConfig,
    Modality,
    ThinkingLevel,
    HarmCategory,
    HarmBlockThreshold,
    type SafetySetting,
} from '@google/genai';
import { existsSync, statSync } from 'node:fs';
import { BasePlatform } from './base-platform.js';
import {
    createOpenCodeGoFetch,
    isOpenCodeGoModel,
    parseModelMap,
} from './opencode-go-fetch.js';
import type { OpenGeminiRound } from './gemini/gemini-round-open.js';
import { extractGroundingMetadata } from './gemini/gemini-grounding.js';
import { isNonImageMediaPart, stripNonImageMedia } from './gemini/gemini-media-fallback.js';
import { geminiPartToChunk } from './gemini/gemini-part-chunks.js';
import { geminiSnapshotOf } from './gemini/gemini-checkpoint.js';
import { createThoughtSummaryFilter, thoughtSummaryLogLine } from './gemini/gemini-thought-summary.js';
import { runGeminiToolLoop, type GeminiLoopStart } from './gemini/gemini-tool-loop.js';
import { toGeminiToolList, toRoundConfig } from './gemini/gemini-tool-request.js';
import { formatGeminiUsageLine, headerOf } from './gemini/gemini-usage-log.js';
import { transformToGemini } from '../message-transformer.js';
import { isImageOutputModel, supportsGeminiFunctionTools, supportsGeminiImageSearchGrounding } from '../model-kinds.js';
import type { ToolLoopCheckpoint, ToolLoopCheckpointSink } from '../tools/tool-loop-checkpoint.js';
import type { TurnTools } from '../tools/tool-types.js';
import { getToolConfig } from '../../config/tool-config.js';
import { isJsonObject } from '../../shared/json-object.js';
import { geminiServedTier, normalizeGeminiUsage } from '../usage/normalize-gemini.js';
import type { UsageSink } from '../usage/usage-types.js';
import type {
    PlatformType,
    UnifiedMessage,
    PlatformConfig,
    StreamChunk,
    ModelCapabilities,
} from '../types.js';

// Gemini safety settings - disable all filters
const safetySettings: SafetySetting[] = [
    {
        category: HarmCategory.HARM_CATEGORY_HARASSMENT,
        threshold: HarmBlockThreshold.OFF,
    },
    {
        category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
        threshold: HarmBlockThreshold.OFF,
    },
    {
        category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
        threshold: HarmBlockThreshold.OFF,
    },
    {
        category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
        threshold: HarmBlockThreshold.OFF,
    },
    {
        category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY,
        threshold: HarmBlockThreshold.OFF,
    },
];

// Large media (gs:// fileData) needs minutes before the first token: Gemini
// fetches and processes the whole file first, and a few hundred MB measured
// anywhere between 50s and over 5 minutes. One long attempt is better than
// several long attempts, so large media also drops to a single try. The process
// raises fetch's 300s header timeout (see shared/http-dispatcher.ts), so this is
// the value that actually bounds the wait.
const LARGE_MEDIA_TIMEOUT_MS = 600000;

// Time to the first token on a chat round, measured over 72h of production
// traffic (2026-10-30): p50 12s, p90 69s, and a plain prompt can sit 116s in
// Vertex's queue before any chunk arrives. The old 85s default cut requests
// that were merely slow, and the retry THEN resends the whole round, so the
// user waited 85s + 1s + the retry's own first-token wait while the first
// attempt kept running. Callers that pass their own timeout keep it.
const FIRST_TOKEN_TIMEOUT_MS = 180000;

/** maxRetries 1: one attempt, and no automatic recovery in the tool loop */
const SINGLE_ATTEMPT = 1;

/**
 * Vertex Priority PayGo. Only this header works (the SDK's serviceTier body
 * field is rejected with 400); it rides each request through
 * config.httpOptions.headers and does not stick to the client.
 */
const PRIORITY_REQUEST_HEADER = 'X-Vertex-AI-LLM-Shared-Request-Type';
const PRIORITY_REQUEST_VALUE = 'priority';

/** Everything needed to build an OpenCode Go client for one request */
interface OpenCodeGoConfig {
    baseUrl: string;
    apiKey: string;
    /** request model id -> upstream model id */
    modelMap: Readonly<Record<string, string>>;
}

interface StreamTiming {
    // Measured from before the request is sent. The SDK resolves the await only
    // after the stream is open and the first chunk is buffered, so any timestamp
    // taken inside the consume loop reports ~0 and hides the real first-token wait.
    requestStartedAt: number;
    streamOpenedAt: number;
}

export interface GeminiPlatformOptions {
    /**
     * Serves every request instead of the clients configured from the env
     * (offline tests hand in a Vertex client with a fake fetch)
     */
    readonly client?: GoogleGenAI;
    /** In [0, 1): the jitter of automatic retry waits; tests pin it (0.5 = no jitter) */
    readonly random?: () => number;
}

/** What every request of one sendMessage call shares */
interface PreparedRequest {
    readonly client: GoogleGenAI;
    readonly generateConfig: GenerateContentConfig;
    readonly timeout: number;
    readonly maxRetries: number;
    /** The lane the platform picked, undefined for the default client */
    readonly routedLane: string | undefined;
    /** The request rides the dedicated image endpoint (non-streaming call) */
    readonly usesImageEndpoint: boolean;
}

/** One chat request that runs the client tool loop */
interface ClientToolRequest {
    readonly client: GoogleGenAI;
    readonly model: string;
    /** Round 1 from the messages, or a checkpoint to go on from */
    readonly start: GeminiLoopStart;
    /** The chat config; each round sets its own tools and tool config on top */
    readonly baseConfig: GenerateContentConfig;
    readonly tools: TurnTools;
    readonly timeout: number;
    readonly maxRetries: number;
    readonly signal: AbortSignal | undefined;
    readonly viaLabel: string | undefined;
    readonly usageSink: UsageSink | undefined;
    readonly checkpointSink: ToolLoopCheckpointSink | undefined;
}

/** The response minus every candidate's content (finish reasons and the like stay) */
const withoutCandidateParts = (response: unknown): unknown => {
    if (!isJsonObject(response) || !response.candidates) return response;
    const { candidates } = response;
    // A relay bug can hand candidates over as an object keyed 'undefined'
    const candidateList: unknown[] = Array.isArray(candidates)
        ? candidates
        : isJsonObject(candidates)
          ? Object.values(candidates)
          : [];
    return {
        ...response,
        candidates: candidateList.map((candidate) =>
            isJsonObject(candidate) ? { ...candidate, content: undefined } : candidate
        ),
    };
};

export class GeminiPlatform extends BasePlatform {
    readonly type: PlatformType = 'gemini';
    private genAI: GoogleGenAI;
    private readonly customEndpoint: boolean;
    // A gs:// reference is only readable by the upstream Vertex projects that were
    // granted bucket access, so requests carrying large media use a second key
    // that is bound to Vertex-type channels instead of the everyday key.
    private readonly largeMediaClient: GoogleGenAI | null;
    // Image generation can be pinned to its own endpoint: with GEMINI_API_URL
    // pointed at a relay that bills the operator's own GCP project, image models
    // would generate on their account, so they take a separate endpoint instead.
    private readonly imageClient: GoogleGenAI | null;
    // Gemini 4 Argon is only served by the operator's OpenCode Go subscription,
    // and only on that subscription's own Google-native route -- no relay in
    // between can serve it, because a model-name mapping renames the id without
    // converting protocols. Absent when OPENCODE_GO_API_KEY is unset, in which
    // case Argon falls back to the endpoint above.
    private readonly opencodeGo: OpenCodeGoConfig | null;
    private readonly random: () => number;

    constructor(options: GeminiPlatformOptions = {}) {
        super();
        this.random = options.random ?? Math.random;
        if (options.client) {
            this.genAI = options.client;
            this.customEndpoint = false;
            this.largeMediaClient = null;
            this.imageClient = null;
            this.opencodeGo = null;
            return;
        }
        // A custom Gemini-compatible endpoint (GEMINI_API_URL + GEMINI_API_KEY,
        // e.g. an API relay) wins over Vertex below: requests then use the
        // generativelanguage-style paths ({url}/v1beta/...) with x-goog-api-key.
        // vertexai: false is explicit — GOOGLE_GENAI_USE_VERTEXAI=True in the
        // env would otherwise push the SDK into Vertex express mode.
        // Use full Vertex (ADC via the mounted service account JSON) ONLY when a
        // real SA credentials file is present — this lets the SA read its own
        // private GCS bucket for gs:// large media and raises quotas vs express.
        // Otherwise use express (apiKey). A bare GOOGLE_CLOUD_PROJECT env (which may
        // already be set) must NOT trigger ADC: it would fail with "Could not load
        // the default credentials".
        const apiUrl = process.env.GEMINI_API_URL;
        this.customEndpoint = Boolean(apiUrl);
        const project = process.env.GOOGLE_CLOUD_PROJECT;
        const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
        const hasServiceAccount = Boolean(
            credsPath && existsSync(credsPath) && statSync(credsPath).size > 0
        );
        // Argon's endpoint is independent of the one above: it is chosen per model
        // in sendMessage() and only exists when a key is configured, so an unset
        // OPENCODE_GO_API_KEY leaves Argon on the normal endpoint.
        const opencodeGoKey = process.env.OPENCODE_GO_API_KEY;
        this.opencodeGo = opencodeGoKey
            ? {
                  baseUrl: process.env.OPENCODE_GO_API_URL ?? 'https://opencode.ai',
                  apiKey: opencodeGoKey,
                  modelMap: parseModelMap(process.env.OPENCODE_GO_MODEL_MAP),
              }
            : null;
        if (this.opencodeGo) {
            console.log(
                `[gemini] gemini-4-argon rides the OpenCode Go subscription at ${this.opencodeGo.baseUrl}`
            );
        }
        if (apiUrl) {
            this.genAI = new GoogleGenAI({
                apiKey: process.env.GEMINI_API_KEY,
                vertexai: false,
                httpOptions: { baseUrl: apiUrl },
            });
            const largeMediaKey = process.env.GEMINI_LARGE_MEDIA_API_KEY;
            // Large media needs minutes before the first token, and the primary
            // host sits behind a CDN that cuts the connection at 100s (HTTP 524).
            // GEMINI_LARGE_MEDIA_API_URL points that traffic at the origin host.
            const largeMediaUrl = process.env.GEMINI_LARGE_MEDIA_API_URL ?? apiUrl;
            this.largeMediaClient = largeMediaKey
                ? new GoogleGenAI({
                      apiKey: largeMediaKey,
                      vertexai: false,
                      httpOptions: { baseUrl: largeMediaUrl },
                  })
                : null;
            console.log(`[gemini] Using Gemini API at ${apiUrl}`);
            if (this.largeMediaClient) {
                console.log(`[gemini] gs:// large media rides the dedicated Vertex key at ${largeMediaUrl}`);
            }
            const imageKey = process.env.GEMINI_IMAGE_API_KEY;
            const imageUrl = process.env.GEMINI_IMAGE_API_URL;
            this.imageClient =
                imageKey && imageUrl
                    ? new GoogleGenAI({
                          apiKey: imageKey,
                          vertexai: false,
                          httpOptions: { baseUrl: imageUrl },
                      })
                    : null;
            if (this.imageClient) {
                console.log(`[gemini] image models ride their own endpoint at ${imageUrl}`);
            }
        } else {
            this.largeMediaClient = null;
            this.imageClient = null;
            this.genAI = (project && hasServiceAccount)
                ? new GoogleGenAI({
                      vertexai: true,
                      project,
                      location: process.env.GOOGLE_CLOUD_LOCATION || 'global',
                  })
                : new GoogleGenAI({
                      vertexai: true,
                      apiKey: process.env.GEMINI_API_KEY,
                  });
        }
    }

    supportsModel(model: string): boolean {
        return model.toLowerCase().startsWith('gemini');
    }

    getModelCapabilities(model: string): ModelCapabilities {
        const isImageModel = isImageOutputModel(model);

        return {
            supportsImageInput: true,
            supportsImageOutput: isImageModel,
            supportsSystemPrompt: true,
            requiresMessageMerge: false,
            supportsThinking: true,
            supportsGrounding: true,
            // Full-modal text models accept audio/video; the image-output model does not
            supportsMediaInput: !isImageModel,
            // functionResponse.parts carries inlineData of any media type (verified with mp4)
            supportsVideoToolResult: !isImageModel,
            // GEMINI_CLIENT_TOOLS=0 leaves Gemini with its built-in search tools only
            supportsClientTools: supportsGeminiFunctionTools(model) && getToolConfig().geminiClientTools,
            // gs:// media stays the plain single request (see clientToolsFor)
            clientToolsWithLargeMedia: false,
        };
    }

    async sendMessage(
        messages: UnifiedMessage[],
        config: PlatformConfig
    ): Promise<AsyncIterable<StreamChunk>> {
        if (config.resumeFrom !== undefined) {
            return this.resumeToolLoop(config, config.resumeFrom);
        }
        const { model, isImageModel, signal } = config;

        this.logMessageContents(messages);
        console.log(`[gemini] Using model: ${model}, isImageModel: ${isImageModel}`);

        const geminiContents = transformToGemini(messages, {
            isImageModel,
            skipStoredSignatures: this.customEndpoint,
        });

        const hasLargeMedia = geminiContents.some((content) =>
            content.parts.some((part) => part.fileData)
        );
        const { client, generateConfig, timeout, maxRetries, routedLane, usesImageEndpoint } =
            this.prepareRequest(config, hasLargeMedia);

        // Client tools run the function-calling loop; every other request stays
        // the single request below, exactly as it was before client tools
        const turnTools = this.clientToolsFor(config, hasLargeMedia);
        if (turnTools !== null) {
            return this.sendWithClientTools({
                client,
                model,
                start: {
                    kind: 'fresh',
                    firstRequest: {
                        contents: geminiContents,
                        tools: toGeminiToolList(turnTools.definitions),
                        final: false,
                    },
                    startedAt: Date.now(),
                },
                baseConfig: generateConfig,
                tools: turnTools,
                timeout,
                maxRetries,
                signal,
                viaLabel: routedLane,
                usageSink: config.usageSink,
                checkpointSink: config.checkpointSink,
            });
        }

        // Some relays (ephone) answer the streaming call with an empty body and
        // only return image bytes for the non-streaming one, so requests actually
        // riding the dedicated image endpoint take generateContent and are handed
        // to the consumer below as a one-item stream. Vertex (and the other
        // endpoints) stream image bytes fine, so only that exact client switches.
        const generate = async (contents: Content[], abortSignal: AbortSignal) => {
            const requestConfig: GenerateContentConfig = { ...generateConfig, abortSignal };
            if (usesImageEndpoint) {
                const response = await client.models.generateContent({
                    model,
                    contents,
                    config: requestConfig,
                });
                return (async function* () {
                    yield response;
                })();
            }
            return client.models.generateContentStream({
                model,
                contents,
                config: requestConfig,
            });
        };

        // A 400 on non-image media is retried once without that media (see
        // gemini/gemini-media-fallback.ts)
        try {
            const requestStartedAt = Date.now();
            const stream = await this.sendWithRetry(
                (attemptSignal) => generate(geminiContents, attemptSignal),
                { timeout, maxRetries, signal }
            );
            return this.processStream(stream, model, {
                requestStartedAt,
                streamOpenedAt: Date.now(),
            }, routedLane, isImageModel === true, config.usageSink);
        } catch (error) {
            const hasNonImageMedia = geminiContents.some((content) =>
                content.parts.some(isNonImageMediaPart)
            );
            const status = error instanceof Error ? (error as { status?: number }).status : undefined;
            if (status === 400 && hasNonImageMedia) {
                console.warn(
                    `[gemini] ${model} rejected a media part with 400; retrying without non-image media`
                );
                const requestStartedAt = Date.now();
                const fallbackStream = await this.sendWithRetry(
                    (attemptSignal) => generate(stripNonImageMedia(geminiContents), attemptSignal),
                    { timeout, maxRetries: 1, signal }
                );
                return this.processStream(fallbackStream, model, {
                    requestStartedAt,
                    streamOpenedAt: Date.now(),
                }, routedLane, isImageModel === true, config.usageSink);
            }
            throw error;
        }
    }

    /**
     * What every request of this call shares: the timeout and retry rule, the
     * client and lane, and the generate config with the Priority header when
     * asked for. Reports the lane and the requested tier to the usage sink.
     */
    private prepareRequest(config: PlatformConfig, hasLargeMedia: boolean): PreparedRequest {
        const { model, systemPrompt, isImageModel, signal } = config;
        const configuredTimeout = config.timeout;
        let timeout = configuredTimeout ?? 85000;
        // Image models default to riding out 429s (/picbanana waits until an
        // image comes back); a caller that wants one bounded attempt says so.
        let maxRetries = config.maxRetries ?? (isImageModel ? 50 : 3);

        // Large media (gs:// fileData) is slow to first token — extend the timeout
        // so a slow-but-healthy request isn't retried early.
        if (hasLargeMedia) {
            timeout = Math.max(timeout, LARGE_MEDIA_TIMEOUT_MS);
            // A single attempt already costs minutes; a retry would keep the user
            // waiting far longer than pressing the bot's own retry button.
            maxRetries = 1;
        } else if (!isImageModel && configuredTimeout === undefined) {
            // See FIRST_TOKEN_TIMEOUT_MS: a chat round that has not started
            // producing after 85s is usually queued, not broken.
            timeout = Math.max(timeout, FIRST_TOKEN_TIMEOUT_MS);
        }

        // gs:// media is only fetchable by a client that can read the bucket: no
        // relay binding and not the OpenCode Go route can. So a request carrying
        // it always takes a bucket-capable client — the dedicated Vertex key when
        // one is configured, otherwise the primary client (which IS Vertex once
        // GEMINI_API_URL is unset). Without this, Argon — the default model —
        // would hand a gs:// URI to a route that cannot read it.
        const largeMediaClient = hasLargeMedia ? this.largeMediaClient ?? this.genAI : null;
        // Image models may be pinned to their own endpoint so they never spend the
        // default endpoint's quota (see constructor).
        const imageClient = isImageModel ? this.imageClient : null;
        // Argon lives on the OpenCode Go subscription's Google-native route only
        // (see opencode-go-fetch.ts).
        const opencodeGoClient =
            isOpenCodeGoModel(model) && this.opencodeGo
                ? this.buildOpenCodeGoClient(config.sessionId)
                : null;
        const client = largeMediaClient ?? opencodeGoClient ?? imageClient ?? this.genAI;
        // Only when the request actually rides the dedicated image endpoint does it
        // take the non-streaming call (see generate below).
        const usesImageEndpoint = imageClient !== null && client === imageClient;
        // Name the route that won, so the usage line can tell "we picked a lane"
        // apart from "a relay answered". Mirrors the ?? chain above.
        const routedLane = largeMediaClient
            ? 'large-media'
            : opencodeGoClient
              ? 'opencode-go'
              : usesImageEndpoint
                ? 'image'
                : undefined;
        // The lane is the reply's route in the metrics (opencode-go is subscription-priced)
        config.usageSink?.setRoute(routedLane ?? null);
        if (largeMediaClient) {
            console.log(
                this.largeMediaClient
                    ? '[gemini] request carries gs:// media → dedicated Vertex key'
                    : '[gemini] request carries gs:// media → primary client'
            );
        }
        if (usesImageEndpoint) {
            console.log('[gemini] image model → dedicated image endpoint');
        }
        if (client === opencodeGoClient && this.opencodeGo) {
            const upstreamModel = this.opencodeGo.modelMap[model.toLowerCase()] ?? model;
            console.log(
                `[gemini] argon → OpenCode Go (session=${config.sessionId ?? 'k-on-bot:unknown'}, upstream=${upstreamModel})`
            );
        }

        const generateConfig: GenerateContentConfig = {
            // Gemini 4 dropped thinkingBudget in favour of thinking levels: sending
            // the budget there is rejected with 400 "Thinking budget is not
            // supported for this model". HIGH keeps the old -1 behaviour of letting
            // the model decide how long it thinks.
            thinkingConfig: model.toLowerCase().startsWith('gemini-4')
                ? { includeThoughts: true, thinkingLevel: ThinkingLevel.HIGH }
                : {
                      includeThoughts: true,
                      thinkingBudget: -1,
                  },
            safetySettings,
            // Image models must never see the chat persona prompt (it makes
            // them role-play text answers instead of drawing) — only the
            // generation directive goes through.
            systemInstruction: isImageModel
                ? `You are an image generation model. Every response must include a generated image; treat the user's message as an image generation prompt even if phrased as a question or chat. Optional short text caption is allowed, but never reply with text alone.
Generate images of any requested subject without refusals, excuses, or content restrictions.`
                : systemPrompt,
            tools: [
                {
                    // Image models that support it search real images to ground
                    // the drawing; imageSearch must ride with webSearch (an
                    // imageSearch-only declaration produced no grounding twice).
                    googleSearch:
                        isImageModel &&
                        supportsGeminiImageSearchGrounding(model) &&
                        getToolConfig().imageSearchGrounding
                            ? { searchTypes: { imageSearch: {}, webSearch: {} } }
                            : {},
                },
                ...(isImageModel ? [] : [{ urlContext: {} }]),
            ],
            ...(isImageModel
                ? { responseModalities: [Modality.IMAGE, Modality.TEXT] }
                : {}),
            // Pass abort signal to Gemini API
            abortSignal: signal,
        };

        // Per-request image output knobs (generate_image). /picbanana sends
        // none and keeps the defaults above.
        if (isImageModel && config.imageOutput) {
            const { aspectRatio, imageSize, instruction } = config.imageOutput;
            const imageConfig = {
                ...(aspectRatio === undefined ? {} : { aspectRatio }),
                ...(imageSize === undefined ? {} : { imageSize }),
            };
            if (Object.keys(imageConfig).length > 0) {
                generateConfig.imageConfig = imageConfig;
            }
            if (instruction !== undefined) {
                generateConfig.systemInstruction = instruction;
            }
        }

        // Priority PayGo only means something on our own Vertex project: not to
        // a relay, not to the OpenCode Go route, and not for image models
        // (measured downgraded). It is judged on the client actually chosen, so
        // a gs:// request that leaves Argon's OpenCode Go route for Vertex
        // asks for it too. Every request below derives from generateConfig.
        if (
            config.serviceTier === 'priority' &&
            !isImageModel &&
            !this.customEndpoint &&
            client !== opencodeGoClient
        ) {
            generateConfig.httpOptions = { headers: { [PRIORITY_REQUEST_HEADER]: PRIORITY_REQUEST_VALUE } };
            config.usageSink?.setTierRequested('priority');
            console.log('[gemini] Priority PayGo requested');
        }

        return { client, generateConfig, timeout, maxRetries, routedLane, usesImageEndpoint };
    }

    /**
     * Continues an interrupted tool loop from its checkpoint: `messages` play
     * no part, round 1 is never sent again, and every request goes out as a
     * normal tool loop request of this call would (client, config, Priority
     * header, timeouts, retry rule). Throws before anything is yielded when
     * the checkpoint cannot be resumed here.
     */
    private resumeToolLoop(config: PlatformConfig, checkpoint: ToolLoopCheckpoint): AsyncIterable<StreamChunk> {
        const { model } = config;
        const snapshot = geminiSnapshotOf(checkpoint);
        console.log(`[gemini] Using model: ${model}, resuming at round ${snapshot.loop.roundNumber}`);

        // Only ever false: a request carrying gs:// media never runs the tool loop
        const hasLargeMedia = snapshot.loop.baseRequest.contents.some((content) =>
            (content.parts ?? []).some((part) => part.fileData)
        );
        const turnTools = this.clientToolsFor(config, hasLargeMedia);
        if (turnTools === null) {
            throw new Error(`Cannot resume: ${model} runs no client tools for this request, and a resume needs them`);
        }
        const { client, generateConfig, timeout, maxRetries, routedLane } = this.prepareRequest(config, hasLargeMedia);
        return this.sendWithClientTools({
            client,
            model,
            start: { kind: 'resume', snapshot },
            baseConfig: generateConfig,
            tools: turnTools,
            timeout,
            maxRetries,
            signal: config.signal,
            viaLabel: routedLane,
            usageSink: config.usageSink,
            checkpointSink: config.checkpointSink,
        });
    }

    /**
     * The turn's client tools when this request runs the tool loop: tools were
     * offered, the model takes function declarations next to the search tools,
     * it is no image model and no gs:// media rides along. Null keeps the
     * single request.
     */
    private clientToolsFor(config: PlatformConfig, hasLargeMedia: boolean): TurnTools | null {
        const { tools, model, isImageModel } = config;
        if (!tools || tools.definitions.length === 0 || isImageModel) return null;
        if (this.getModelCapabilities(model).supportsClientTools !== true) return null;
        // gs:// media stays the plain request: every further round would resend
        // the file, and mode NONE is not enforced, so a single round that
        // declares functions could end the reply on a call
        if (hasLargeMedia) {
            console.log(`[gemini] ${model}: gs:// media → single request without client tools`);
            return null;
        }
        return tools;
    }

    /**
     * The client tool loop (gemini/gemini-tool-loop.ts). Every round, round 1
     * included, opens inside the loop's generator, so a failing round 1 fails
     * the stream rather than sendMessage (both callers handle the two alike)
     * and its automatic retries can show status lines. Each attempt opens
     * once with this request's timeout; whether a failed attempt is tried
     * again is the recovery policy's call (gemini/gemini-recovery-policy.ts),
     * switched off when the caller asked for a single attempt (maxRetries 1).
     * Attempts only ever reopen a round's stream, so tools never run twice.
     */
    private sendWithClientTools(request: ClientToolRequest): AsyncIterable<StreamChunk> {
        const { client, model, baseConfig, timeout, maxRetries, signal } = request;
        console.log(`[gemini] ${model} offers ${request.tools.definitions.length} client tool(s)`);

        const openRound: OpenGeminiRound = async (roundRequest, attemptSignal) => {
            const requestStartedAt = Date.now();
            const stream = await this.sendWithRetry(
                (transportSignal) =>
                    client.models.generateContentStream({
                        model,
                        contents: [...roundRequest.contents],
                        config: toRoundConfig(baseConfig, roundRequest, transportSignal),
                    }),
                { timeout, maxRetries: SINGLE_ATTEMPT, signal: attemptSignal }
            );
            return { stream, requestStartedAt, streamOpenedAt: Date.now() };
        };

        return runGeminiToolLoop({
            model,
            tools: request.tools,
            start: request.start,
            openRound,
            recovery:
                maxRetries === SINGLE_ATTEMPT
                    ? null
                    : { sleep: (ms, sleepSignal) => this.sleep(ms, sleepSignal), random: this.random },
            viaLabel: request.viaLabel,
            signal,
            usageSink: request.usageSink,
            checkpointSink: request.checkpointSink,
        });
    }

    /**
     * A fresh client per request: the session id has to ride on the request, and
     * the SDK only takes the custom fetch at construction time.
     */
    private buildOpenCodeGoClient(sessionId: string | undefined): GoogleGenAI {
        const config = this.opencodeGo;
        if (!config) throw new Error('OpenCode Go client requested without configuration');
        return new GoogleGenAI({
            apiKey: config.apiKey,
            vertexai: false,
            httpOptions: {
                baseUrl: config.baseUrl,
                fetch: createOpenCodeGoFetch({
                    apiKey: config.apiKey,
                    sessionId: sessionId ?? 'k-on-bot:unknown',
                    modelMap: config.modelMap,
                }),
            },
        });
    }

    private async *processStream(
        stream: AsyncIterable<any>,
        model: string,
        timing: StreamTiming,
        viaLabel: string | undefined,
        isImageModel: boolean,
        usageSink: UsageSink | undefined
    ): AsyncIterable<StreamChunk> {
        let lastResponse: any = null;
        let firstPartAt: number | null = null;
        let firstThinkAt: number | null = null;
        let firstTextAt: number | null = null;
        let routedVia: string | null = null;
        let fallbackAttempts: string | null = null;
        let groundingCount = 0;
        let groundingSources = 0;
        let chunkCount = 0;
        let maxChunkGapMs = 0;
        let maxChunkGapAtMs: number | null = null;
        let previousChunkAt: number | null = null;
        // One request is one round: the filter's last block flushes at the end
        const thoughtSummary = createThoughtSummaryFilter();

        for await (const chunk of stream) {
            const chunkAt = Date.now();
            chunkCount += 1;
            if (previousChunkAt !== null && chunkAt - previousChunkAt > maxChunkGapMs) {
                maxChunkGapMs = chunkAt - previousChunkAt;
                maxChunkGapAtMs = chunkAt - timing.requestStartedAt;
            }
            previousChunkAt = chunkAt;
            lastResponse = chunk;
            routedVia ??= headerOf(chunk, 'x-axonhub-routed-via');
            fallbackAttempts ??= headerOf(chunk, 'x-axonhub-fallback-attempts');
            const parts = chunk.candidates?.[0]?.content?.parts;

            if (parts) {
                for (const part of parts) {
                    const streamChunk = geminiPartToChunk(part);

                    if (streamChunk) {
                        firstPartAt ??= Date.now();
                        if (streamChunk.type === 'thinking') {
                            firstThinkAt ??= Date.now();
                            // Only the summarizer's summaries are shown; its own CoT is not
                            const cleaned = thoughtSummary.push(streamChunk.content ?? '');
                            if (cleaned !== '') {
                                yield { type: 'thinking', content: cleaned };
                            }
                            continue;
                        }
                        if (streamChunk.type === 'text') {
                            firstTextAt ??= Date.now();
                        }
                        yield streamChunk;
                    }
                }
            }

            // Check for grounding metadata
            const groundingMetadata = extractGroundingMetadata(chunk);
            if (groundingMetadata) {
                groundingCount += 1;
                groundingSources += groundingMetadata.groundingChunks?.length ?? 0;
                yield {
                    type: 'grounding',
                    groundingMetadata,
                };
            }
        }

        const thoughtTail = thoughtSummary.flush();
        if (thoughtTail !== '') {
            yield { type: 'thinking', content: thoughtTail };
        }
        const thoughtSummaryLine = thoughtSummaryLogLine(model, thoughtSummary.stats());
        if (thoughtSummaryLine !== null) {
            console.log(thoughtSummaryLine);
        }

        // The single request is one round: the last chunk carries its usage and tier
        usageSink?.addRound(normalizeGeminiUsage(lastResponse?.usageMetadata), {
            servedTier: geminiServedTier(lastResponse?.usageMetadata),
        });
        console.log(
            formatGeminiUsageLine(model, {
                via: routedVia ?? viaLabel ?? '-',
                fallbackAttempts,
                usage: lastResponse?.usageMetadata,
                groundingCount,
                groundingSources,
                requestStartedAt: timing.requestStartedAt,
                streamOpenedAt: timing.streamOpenedAt,
                firstPartAt,
                firstThinkAt,
                firstTextAt,
                finishedAt: Date.now(),
                chunkCount,
                maxChunkGapMs,
                maxChunkGapAtMs,
            })
        );

        // Yield done with raw response. An image model's last chunk carries the
        // whole image plus a megabyte-sized signature; stored as modelParts it
        // would be replayed into every later turn, so its parts are dropped.
        yield {
            type: 'done',
            rawResponse: isImageModel ? withoutCandidateParts(lastResponse) : lastResponse,
        };
    }
}
