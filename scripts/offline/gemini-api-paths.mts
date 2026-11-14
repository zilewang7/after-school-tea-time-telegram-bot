/**
 * Offline cases for the paths the non-Vertex Gemini clients request (no network).
 *
 * Run: `pnpm test:offline gemini-api-paths`
 *
 * @google/genai 3 sends a non-Vertex client's requests to /v1/... unless the
 * client pins its API version, and every non-Vertex lane of GeminiPlatform was
 * built on /v1beta: the GEMINI_API_URL relay, the large-media key, the image
 * endpoint, and OpenCode Go, whose rewrite only recognizes /v1beta/models/.
 * GeminiPlatform is built from the env with each lane on a local stub of its
 * own, and the cases assert the exact path, query and headers each stub got.
 */
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import { startStubServer, type StubServer } from './support/stub-server.mts';
import type { StreamChunk, UnifiedMessage } from '../../src/ai/types.js';

// ---------------------------------------------------------------------------
// Recording stubs, one per lane
// ---------------------------------------------------------------------------

interface ReceivedRequest {
    readonly method: string;
    readonly path: string;
    /** `?alt=sse` on a streaming call, '' without a query */
    readonly query: string;
    /** Names lower-cased (node does that already) */
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
}

interface RecordingStub {
    readonly name: string;
    readonly server: StubServer;
    readonly received: ReceivedRequest[];
}

const ANSWER_TEXT = 'Answered offline.';
/** One transparent pixel: the image lane must hand an image back */
const PIXEL_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const TEXT_ANSWER: readonly unknown[] = [{ text: ANSWER_TEXT }];
const IMAGE_ANSWER: readonly unknown[] = [
    { inlineData: { mimeType: 'image/png', data: PIXEL_PNG_BASE64 } },
    { text: ANSWER_TEXT },
];

const answerOf = (parts: readonly unknown[]): string =>
    JSON.stringify({
        candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
    });

/** Answers the two generate actions; any other path is a 404, never retried */
const answer = (response: ServerResponse, path: string, parts: readonly unknown[]): void => {
    if (path.endsWith(':streamGenerateContent')) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end(`data: ${answerOf(parts)}\n\n`);
    } else if (path.endsWith(':generateContent')) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(answerOf(parts));
    } else {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 404, message: `no route ${path}`, status: 'NOT_FOUND' } }));
    }
};

const headerRecordOf = (headers: IncomingHttpHeaders): Record<string, string> =>
    Object.fromEntries(
        Object.entries(headers).map(([name, value]): [string, string] => [
            name,
            Array.isArray(value) ? value.join(', ') : value ?? '',
        ])
    );

const startRecordingStub = async (name: string, answerParts: readonly unknown[] = TEXT_ANSWER): Promise<RecordingStub> => {
    const server = await startStubServer();
    const received: ReceivedRequest[] = [];
    server.handle((request, response) => {
        const bodyParts: Buffer[] = [];
        request.on('data', (part: Buffer) => bodyParts.push(part));
        request.on('end', () => {
            const url = new URL(request.url ?? '/', server.url);
            received.push({
                method: request.method ?? '',
                path: url.pathname,
                query: url.search,
                headers: headerRecordOf(request.headers),
                body: Buffer.concat(bodyParts).toString('utf8'),
            });
            answer(response, url.pathname, answerParts);
        });
    });
    return { name, server, received };
};

const relay = await startRecordingStub('relay');
const largeMedia = await startRecordingStub('large-media');
const imageEndpoint = await startRecordingStub('image', IMAGE_ANSWER);
const openCodeGo = await startRecordingStub('opencode-go');
const stubs = [relay, largeMedia, imageEndpoint, openCodeGo];

// ---------------------------------------------------------------------------
// Network guard: every request must reach one of the stubs above
// ---------------------------------------------------------------------------

const outboundRequests: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!stubs.some((stub) => url.startsWith(stub.server.url))) {
        outboundRequests.push(url);
        throw new Error(`offline: blocked a request to ${url}`);
    }
    return originalFetch(input, init);
};

// ---------------------------------------------------------------------------
// Env: every lane configured, then src (GeminiPlatform reads it in its constructor)
// ---------------------------------------------------------------------------

const RELAY_KEY = 'offline-relay-key';
const LARGE_MEDIA_KEY = 'offline-large-media-key';
const IMAGE_KEY = 'offline-image-key';
const OPENCODE_GO_KEY = 'offline-go-key';
const SESSION_ID = 'k-on-bot:-100123:45';

type EnvValues = Readonly<Record<string, string | undefined>>;

const LANE_ENV: EnvValues = {
    GEMINI_API_URL: relay.server.url,
    GEMINI_API_KEY: RELAY_KEY,
    GEMINI_LARGE_MEDIA_API_URL: largeMedia.server.url,
    GEMINI_LARGE_MEDIA_API_KEY: LARGE_MEDIA_KEY,
    GEMINI_IMAGE_API_URL: imageEndpoint.server.url,
    GEMINI_IMAGE_API_KEY: IMAGE_KEY,
    OPENCODE_GO_API_URL: openCodeGo.server.url,
    OPENCODE_GO_API_KEY: OPENCODE_GO_KEY,
    // The built-in mapping (gemini-4-argon -> gemini-4-argon-contributor)
    OPENCODE_GO_MODEL_MAP: undefined,
    // 3.x reads it for every client that pins nothing; a case sets it on purpose
    GOOGLE_GENAI_API_VERSION: undefined,
    GOOGLE_GENAI_USE_VERTEXAI: undefined,
    GOOGLE_GEMINI_BASE_URL: undefined,
    GOOGLE_API_KEY: undefined,
};

const applyEnv = (values: EnvValues): void => {
    for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
};

applyEnv(LANE_ENV);

const { GeminiPlatform } = await import('../../src/ai/platforms/gemini-platform.js');
const { GEMINI_IMAGE_MODEL } = await import('../../src/config/models.js');

type GeminiPlatformInstance = InstanceType<typeof GeminiPlatform>;

/** A platform built from LANE_ENV plus `overrides`; the env is put back afterwards */
const platformWith = (overrides: EnvValues = {}): GeminiPlatformInstance => {
    const saved: EnvValues = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
    applyEnv(overrides);
    try {
        return new GeminiPlatform();
    } finally {
        applyEnv(saved);
    }
};

// ---------------------------------------------------------------------------
// One reply through the platform
// ---------------------------------------------------------------------------

const LARGE_VIDEO_URI = 'gs://offline-bucket/clip.mp4';

const userTurn = (text: string): UnifiedMessage[] => [{ role: 'user', content: [{ type: 'text', text }] }];

const largeVideoTurn = (): UnifiedMessage[] => [
    {
        role: 'user',
        content: [
            { type: 'text', text: 'Watch the clip.' },
            { type: 'media', fileUri: LARGE_VIDEO_URI, mimeType: 'video/mp4', durationSeconds: 30 },
        ],
    },
];

interface TurnRequest {
    readonly model: string;
    readonly messages?: UnifiedMessage[];
    readonly isImageModel?: boolean;
}

interface TurnResult {
    readonly chunks: StreamChunk[];
    /** The reply's error, null when it streamed to the end */
    readonly error: string | null;
}

/** One reply with the console quiet; a failed reply comes back as its message */
const sendTurn = async (platform: GeminiPlatformInstance, request: TurnRequest): Promise<TurnResult> => {
    const original = { log: console.log, warn: console.warn, error: console.error };
    const quiet = (): void => {};
    console.log = quiet;
    console.warn = quiet;
    console.error = quiet;
    const chunks: StreamChunk[] = [];
    try {
        const stream = await platform.sendMessage(request.messages ?? userTurn('Say hello offline.'), {
            model: request.model,
            systemPrompt: 'offline system prompt',
            maxRetries: 1,
            sessionId: SESSION_ID,
            ...(request.isImageModel === true ? { isImageModel: true } : {}),
        });
        for await (const chunk of stream) chunks.push(chunk);
        return { chunks, error: null };
    } catch (error) {
        return { chunks, error: error instanceof Error ? error.message : String(error) };
    } finally {
        console.log = original.log;
        console.warn = original.warn;
        console.error = original.error;
    }
};

const textOf = (result: TurnResult): string =>
    result.chunks
        .filter((chunk) => chunk.type === 'text')
        .map((chunk) => chunk.content ?? '')
        .join('');

const resetStubs = (): void => {
    for (const stub of stubs) stub.received.length = 0;
    outboundRequests.length = 0;
};

/** The one request `stub` got; every other stub got none */
const onlyRequestTo = (stub: RecordingStub): ReceivedRequest | undefined => {
    const counts = stubs.map((each) => `${each.name}=${each.received.length}`).join(' ');
    expect(
        stub.received.length === 1 && stubs.every((each) => each === stub || each.received.length === 0),
        `exactly one request, to the ${stub.name} stub (got ${counts})`
    );
    expect(outboundRequests.length === 0, `nothing went anywhere else (got ${JSON.stringify(outboundRequests)})`);
    return stub.received[0];
};

const expectAnswered = (result: TurnResult): void => {
    expect(result.error === null, `the reply streamed to the end (got ${result.error ?? ''})`);
    expect(textOf(result) === ANSWER_TEXT, `and carries the stub's answer (got ${JSON.stringify(textOf(result))})`);
};

/** The path asserted first, so a version drift reads as such and not as a failed reply */
const expectPath = (request: ReceivedRequest | undefined, path: string, query: string): void => {
    expect(request?.path === path, `the path is ${path} (got ${request?.path ?? 'no request'})`);
    expect(request?.query === query, `the query is '${query}' (got '${request?.query ?? ''}')`);
    expect(request?.method === 'POST', `a POST (got ${request?.method ?? ''})`);
};

const expectOpenCodeGoRequest = (request: ReceivedRequest | undefined): void => {
    expectPath(request, '/inference/go/v1/models/gemini-4-argon-contributor:streamGenerateContent', '?alt=sse');
    expect(
        request?.headers['authorization'] === `Bearer ${OPENCODE_GO_KEY}`,
        `the Go key rides as a bearer token (got ${request?.headers['authorization'] ?? 'none'})`
    );
    expect(
        request?.headers['x-opencode-session'] === SESSION_ID,
        `the conversation's session id is attached (got ${request?.headers['x-opencode-session'] ?? 'none'})`
    );
    expect(request?.headers['x-goog-api-key'] === undefined, 'no SDK api key header reaches OpenCode Go');
    expect((request?.headers['user-agent'] ?? '').startsWith('k-on-bot/'), 'the client names itself, not the SDK');
};

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

interface TestCase {
    readonly name: string;
    readonly body: () => Promise<void>;
}

const cases: TestCase[] = [
    {
        name: 'relay (GEMINI_API_URL): a Gemini model streams from /v1beta/models/<id>',
        body: async () => {
            const result = await sendTurn(platformWith(), { model: 'gemini-3.8-flash' });
            const request = onlyRequestTo(relay);
            expectPath(request, '/v1beta/models/gemini-3.8-flash:streamGenerateContent', '?alt=sse');
            expect(request?.headers['x-goog-api-key'] === RELAY_KEY, 'with the relay key');
            expectAnswered(result);
        },
    },
    {
        name: 'OpenCode Go: gemini-4-argon goes to /inference/go/v1/models/<upstream id> with its own auth',
        body: async () => {
            const result = await sendTurn(platformWith(), { model: 'gemini-4-argon' });
            const request = onlyRequestTo(openCodeGo);
            expectOpenCodeGoRequest(request);
            expect(request?.body.includes('Say hello offline.') === true, 'the body passes through untouched');
            expectAnswered(result);
        },
    },
    {
        name: 'OpenCode Go unset: gemini-4-argon stays on the relay at /v1beta under its own id',
        body: async () => {
            const result = await sendTurn(platformWith({ OPENCODE_GO_API_KEY: undefined }), { model: 'gemini-4-argon' });
            const request = onlyRequestTo(relay);
            expectPath(request, '/v1beta/models/gemini-4-argon:streamGenerateContent', '?alt=sse');
            expect(request?.headers['x-goog-api-key'] === RELAY_KEY, 'with the relay key');
            expectAnswered(result);
        },
    },
    {
        name: 'large media: a gs:// turn rides the large-media key at /v1beta, Argon included',
        body: async () => {
            const result = await sendTurn(platformWith(), { model: 'gemini-3.8-flash', messages: largeVideoTurn() });
            const request = onlyRequestTo(largeMedia);
            expectPath(request, '/v1beta/models/gemini-3.8-flash:streamGenerateContent', '?alt=sse');
            expect(request?.headers['x-goog-api-key'] === LARGE_MEDIA_KEY, 'with the large-media key');
            expect(request?.body.includes(LARGE_VIDEO_URI) === true, 'the gs:// fileData rides along');
            expectAnswered(result);

            // OpenCode Go cannot read the bucket: Argon's gs:// turn leaves it,
            // unrewritten and under the id the model was asked by
            resetStubs();
            const argon = await sendTurn(platformWith(), { model: 'gemini-4-argon', messages: largeVideoTurn() });
            const argonRequest = onlyRequestTo(largeMedia);
            expectPath(argonRequest, '/v1beta/models/gemini-4-argon:streamGenerateContent', '?alt=sse');
            expect(argonRequest?.headers['x-goog-api-key'] === LARGE_MEDIA_KEY, 'with the large-media key');
            expectAnswered(argon);
        },
    },
    {
        name: 'large media without its own URL: the large-media key goes to the relay host at /v1beta',
        body: async () => {
            const result = await sendTurn(platformWith({ GEMINI_LARGE_MEDIA_API_URL: undefined }), {
                model: 'gemini-3.8-flash',
                messages: largeVideoTurn(),
            });
            const request = onlyRequestTo(relay);
            expectPath(request, '/v1beta/models/gemini-3.8-flash:streamGenerateContent', '?alt=sse');
            expect(request?.headers['x-goog-api-key'] === LARGE_MEDIA_KEY, 'with the large-media key, not the relay key');
            expectAnswered(result);
        },
    },
    {
        name: "image endpoint: the image model's non-streaming call goes to /v1beta/models/<id>:generateContent",
        body: async () => {
            const result = await sendTurn(platformWith(), { model: GEMINI_IMAGE_MODEL, isImageModel: true });
            const request = onlyRequestTo(imageEndpoint);
            expectPath(request, `/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent`, '');
            expect(request?.headers['x-goog-api-key'] === IMAGE_KEY, 'with the image key');
            expectAnswered(result);
            expect(result.chunks.some((chunk) => chunk.type === 'image'), 'and the image comes back');
        },
    },
    {
        name: 'GOOGLE_GENAI_API_VERSION in the env moves none of the pinned clients',
        body: async () => {
            // The SDK reads the variable whenever a client is built, and the
            // OpenCode Go client is built per request: it stays set for the replies
            const saved = process.env.GOOGLE_GENAI_API_VERSION;
            process.env.GOOGLE_GENAI_API_VERSION = 'v1';
            try {
                const platform = platformWith();
                const relayed = await sendTurn(platform, { model: 'gemini-3.8-flash' });
                expectPath(onlyRequestTo(relay), '/v1beta/models/gemini-3.8-flash:streamGenerateContent', '?alt=sse');
                expectAnswered(relayed);

                resetStubs();
                const argon = await sendTurn(platform, { model: 'gemini-4-argon' });
                expectOpenCodeGoRequest(onlyRequestTo(openCodeGo));
                expectAnswered(argon);
            } finally {
                if (saved === undefined) delete process.env.GOOGLE_GENAI_API_VERSION;
                else process.env.GOOGLE_GENAI_API_VERSION = saved;
            }
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    resetStubs();
    results.push(await runCase(testCase.name, testCase.body));
}
await Promise.all(stubs.map((stub) => stub.server.close()));
reportResults(results);
