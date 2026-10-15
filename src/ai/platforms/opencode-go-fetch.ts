/**
 * Request rewriting for the OpenCode Go subscription endpoint.
 *
 * OpenCode Go serves Gemini 4 Argon on its own Google-native route
 * (`{base}/inference/go/v1/models/<model>:generateContent`) authenticated with
 * `Authorization: Bearer <key>` plus a stable `x-opencode-session` header. The
 * Google GenAI SDK speaks `{base}/v1beta/models/<model>:<action>` and
 * authenticates with `x-goog-api-key`, so every request is rewritten here rather
 * than forking the platform's stream handling: the body passes through untouched
 * (systemInstruction, safetySettings, generationConfig and tools are all
 * accepted upstream) and only the path, the model id and the headers change.
 *
 * This endpoint is the only one that serves Argon: the same model id over
 * `/zen/go/v1/...`, `/inference/openai/...` or `/inference/anthropic/...` comes
 * back 400 "Model does not support this protocol", and a relay's model-name
 * mapping only renames the id -- it cannot convert protocols.
 */

/** Upstream ids differ from the ones `/model` exposes */
const DEFAULT_MODEL_MAP: Readonly<Record<string, string>> = {
    'gemini-4-argon': 'gemini-4-argon-contributor',
};

/** OpenCode requires clients to identify themselves instead of sending a library name */
const USER_AGENT = 'k-on-bot/1.0';

const SDK_PATH_PREFIX = '/v1beta/models/';
const GO_PATH_PREFIX = '/inference/go/v1/models/';

export interface OpenCodeGoRequestOptions {
    apiKey: string;
    /** Stable per-conversation id: upstream routes and caches on it */
    sessionId: string;
    /** request model id -> upstream model id */
    modelMap?: Readonly<Record<string, string>>;
}

/** "a=b,c=d" -> {a: b, c: d}; malformed pairs are ignored */
export const parseModelMap = (raw: string | undefined): Readonly<Record<string, string>> => {
    const map: Record<string, string> = { ...DEFAULT_MODEL_MAP };
    for (const pair of (raw ?? '').split(',')) {
        const [from, to] = pair.split('=').map((part) => part.trim());
        if (from && to) map[from] = to;
    }
    return map;
};

/** Same parameter types the SDK's fetcher contract uses */
type FetchArguments = Parameters<typeof fetch>;

/** The SDK request -> the same request as OpenCode Go expects it */
export const buildOpenCodeGoRequest = (
    input: FetchArguments[0],
    init: FetchArguments[1],
    options: OpenCodeGoRequestOptions
): Request => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    if (url.pathname.startsWith(SDK_PATH_PREFIX)) {
        const [model = '', action] = url.pathname.slice(SDK_PATH_PREFIX.length).split(':');
        const modelMap = options.modelMap ?? DEFAULT_MODEL_MAP;
        const upstreamModel = modelMap[model] ?? model;
        url.pathname = `${GO_PATH_PREFIX}${upstreamModel}${action ? `:${action}` : ''}`;
    }

    const headers = new Headers(request.headers);
    headers.delete('x-goog-api-key');
    headers.delete('x-goog-api-client');
    headers.set('authorization', `Bearer ${options.apiKey}`);
    headers.set('x-opencode-session', options.sessionId);
    headers.set('user-agent', USER_AGENT);

    // Streaming bodies need undici's duplex flag; it is absent from the DOM
    // RequestInit type, so carry it explicitly instead of casting.
    const rewritten: RequestInit & { duplex?: 'half' } = {
        method: request.method,
        headers,
        body: request.body,
        signal: request.signal,
        duplex: 'half',
    };

    return new Request(url, rewritten);
};

/** Fetch implementation handed to the GoogleGenAI client on the Go endpoint */
export const createOpenCodeGoFetch = (options: OpenCodeGoRequestOptions): typeof fetch => {
    return (input, init) => {
        const rewritten = buildOpenCodeGoRequest(input, init, options);
        // Hand the request over as (url, init): the process replaces global fetch
        // with the npm undici build (see shared/http-dispatcher.ts), and that fetch
        // cannot read a Request made by Node's built-in class -- it stringifies it
        // and dies with "Failed to parse URL from [object Request]".
        return fetch(rewritten.url, {
            method: rewritten.method,
            headers: rewritten.headers,
            body: rewritten.body,
            signal: rewritten.signal,
            duplex: 'half',
        });
    };
};

/** One id per conversation (reply tree), which is what upstream asks for */
export const openCodeGoSessionId = (chatId: number, rootMessageId: number): string =>
    `k-on-bot:${chatId}:${rootMessageId}`;

/** Argon (and any of its variants) is served by the Go subscription only */
export const isOpenCodeGoModel = (model: string): boolean =>
    /^gemini-4-argon/.test(model.toLowerCase());
