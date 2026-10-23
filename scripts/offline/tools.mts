/**
 * Offline cases for the client tool layer (no containers, no network beyond
 * local stubs).
 *
 * Run: pnpm test:offline (or `npx tsx scripts/offline/tools.mts` alone)
 *
 * Covers the per-turn tool snapshot (names, dispatch, rounds), MCP config and
 * calls against a local MCP stub, which tools a model gets in which chat (env
 * parsing included), the prompt line that comes with the SMS tool, the
 * transient tool status display, reply delivery bookkeeping, the context
 * index tools resolve `#N` with, and the Gemini image path (draft images
 * skipped, no stored parts, output knobs).
 *
 * Telegram is a real grammY Api whose transformer answers every call locally,
 * so the reply pipeline runs unmodified and the cases read what it sent.
 *
 * Every project module is imported dynamically AFTER the env below is set and
 * the scratch database is in place: several modules snapshot the env at import
 * time, and the db layer opens DB_PATH as soon as it is imported.
 */
import { spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Api, Context, type Transformer } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import {
    OFFLINE_CHAT_ID,
    expect,
    reportResults,
    runCase,
    setupOfflineDb,
    takeMessageId,
    type CaseResult,
} from './harness.mts';
import type { AIResponse, ResponseState, StreamChunk, ToolChatAction, ToolStatus, UnifiedMessage } from '../../src/ai/types.js';
import type { ToolCall, ToolHandler, ToolResult, TurnTools } from '../../src/ai/tools/tool-types.js';
import type { StreamingEditor, TypingIndicator } from '../../src/telegram/index.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : {};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The per-call tool-rounds line is injected by the loops; comparisons ignore it */
const withoutRoundsLeft = (text: string): string => text.replace(/\n\n\[工具轮次\][^\n]*(?:\n\[时间\][^\n]*)?/g, '');
const json = (value: unknown): string =>
    JSON.stringify(value, (_key, item: unknown) => (typeof item === 'string' ? withoutRoundsLeft(item) : item));

// ---------------------------------------------------------------------------
// Local stubs
// ---------------------------------------------------------------------------

const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlZkAAAAASUVORK5CYII=',
    'base64'
);

const readBody = (request: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });

const listen = async (server: Server): Promise<number> => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
        throw new Error('the stub server has no TCP port');
    }
    return address.port;
};

const closeServer = async (server: Server): Promise<void> => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
};

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties,
    required,
});

/** Tools each stub MCP server lists, keyed by server path */
const STUB_MCP_TOOLS: Record<string, Array<{ name: string; description: string; inputSchema: object }>> = {
    searxng: [
        { name: 'searxng_web_search', description: 'web search', inputSchema: objectSchema({ query: { type: 'string' } }, ['query']) },
        { name: 'web_url_read', description: 'read a page', inputSchema: objectSchema({ url: { type: 'string' } }, ['url']) },
    ],
    context7: [
        { name: 'resolve-library-id', description: 'resolve', inputSchema: objectSchema({ libraryName: { type: 'string' } }) },
        { name: 'query-docs', description: 'query', inputSchema: objectSchema({ query: { type: 'string' } }) },
        // Collides with the built-in image tool: must be renamed, never shadow it
        { name: 'generate_image', description: 'an MCP tool with a reserved name', inputSchema: objectSchema({}) },
        { name: 'odd.tool name', description: 'a name no provider accepts', inputSchema: objectSchema({}) },
        { name: 'slow_tool', description: 'answers after 3s', inputSchema: objectSchema({}) },
    ],
    retired: [{ name: 'old_tool', description: 'switched off by DISABLED_TOOLS', inputSchema: objectSchema({}) }],
};

interface StubMcpRequest {
    server: string;
    method: string;
    toolName?: unknown;
    toolArguments?: unknown;
    authorization?: string;
}
const stubMcpRequests: StubMcpRequest[] = [];

const stubToolResult = async (name: unknown, args: unknown): Promise<object> => {
    switch (name) {
        case 'searxng_web_search':
            return {
                content: [
                    { type: 'text', text: '[猫的百科](https://a.example/cat)\n[养猫指南](https://b.example/guide)' },
                ],
            };
        case 'resolve-library-id':
            return {
                content: [
                    { type: 'text', text: 'library id: /grammyjs/grammY' },
                    { type: 'image', data: PNG_BYTES.toString('base64'), mimeType: 'image/png' },
                    { type: 'resource_link', uri: 'https://docs.example/grammy', name: 'grammy docs' },
                ],
            };
        case 'query-docs':
            return { content: [{ type: 'text', text: 'quota exceeded' }], isError: true };
        case 'generate_image':
            return { content: [] };
        case 'odd.tool name':
            return { content: [{ type: 'text', text: `odd tool ran with ${json(args)}` }] };
        case 'slow_tool':
            await new Promise((resolve) => setTimeout(resolve, 3000));
            return { content: [{ type: 'text', text: 'too late' }] };
        default:
            return { content: [{ type: 'text', text: `ran ${String(name)}` }] };
    }
};

const stubMcpResult = async (server: string, method: unknown, params: Record<string, unknown>): Promise<object | null> => {
    if (method === 'initialize') {
        return {
            protocolVersion: params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: server, version: '1.0.0' },
        };
    }
    if (method === 'tools/list') return { tools: STUB_MCP_TOOLS[server] ?? [] };
    if (method === 'tools/call') return stubToolResult(params.name, params.arguments);
    return null;
};

/** Streamable-HTTP MCP server in JSON-response mode, one per path */
const mcpStub = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
    }
    const server = (request.url ?? '/').slice(1);
    const message = asRecord(JSON.parse(await readBody(request)));
    const params = asRecord(message.params);
    stubMcpRequests.push({
        server,
        method: String(message.method),
        toolName: params.name,
        toolArguments: params.arguments,
        authorization: request.headers.authorization,
    });
    if (message.id === undefined) {
        response.writeHead(202).end();
        return;
    }

    const result = await stubMcpResult(server, message.method, params);
    if (response.destroyed) return;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
        json(
            result === null
                ? { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }
                : { jsonrpc: '2.0', id: message.id, result }
        )
    );
});

/** Gemini-API-shaped stub: a thought image (draft), then the final image */
const DRAFT_IMAGE = Buffer.from('draft-image-bytes');
const FINAL_IMAGE = Buffer.from('final-image-bytes');
const geminiRequestBodies: Array<Record<string, unknown>> = [];
const geminiStub = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    geminiRequestBodies.push(asRecord(JSON.parse(await readBody(request))));
    const events = [
        { candidates: [{ content: { role: 'model', parts: [{ text: '先打个草稿', thought: true }] } }] },
        {
            candidates: [
                {
                    content: {
                        role: 'model',
                        parts: [{ inlineData: { mimeType: 'image/png', data: DRAFT_IMAGE.toString('base64') }, thought: true }],
                    },
                },
            ],
        },
        {
            candidates: [
                {
                    content: {
                        role: 'model',
                        parts: [
                            {
                                inlineData: { mimeType: 'image/png', data: FINAL_IMAGE.toString('base64') },
                                thoughtSignature: Buffer.from('a-very-large-signature').toString('base64'),
                            },
                        ],
                    },
                    finishReason: 'STOP',
                },
            ],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7, totalTokenCount: 12 },
        },
    ];
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(events.map((event) => `data: ${json(event)}\n\n`).join(''));
});

const mcpPort = await listen(mcpStub);
const geminiPort = await listen(geminiStub);
const mcpUrl = (server: string): string => `http://127.0.0.1:${mcpPort}/${server}`;

// ---------------------------------------------------------------------------
// Env (before any project import)
// ---------------------------------------------------------------------------

const WHITELISTED_CHAT_ID = -1004242424242;
const OTHER_CHAT_ID = -1007373737373;
const MCP_SECRET = 'mcp-secret-token-do-not-log';

process.env.MCP_SERVERS = json({
    searxng: { serverUrl: mcpUrl('searxng'), excludePlatforms: ['gemini', 'grok'] },
    broken: { serverUrl: 'definitely not a url', headers: { Authorization: `Bearer ${MCP_SECRET}` } },
    context7: { serverUrl: mcpUrl('context7'), headers: { Authorization: `Bearer ${MCP_SECRET}` } },
    misspelt: { serverUrl: mcpUrl('context7'), excludePlatforms: ['gemni'] },
    // A misspelt key must not quietly hand the server to the excluded platforms
    typo: { serverUrl: mcpUrl('context7'), excludePlatform: ['gemini'] },
    retired: { serverUrl: mcpUrl('retired') },
});
process.env.TOOL_CHAT_IDS = `${WHITELISTED_CHAT_ID}, not-a-number`;
// A server key and two MCP tools by their original names (one the model sees renamed)
process.env.DISABLED_TOOLS = 'retired, query-docs, odd.tool name';
// Never contacted: the SMS tool is not executed here
process.env.OWNER_SMS_MCP_URL = 'http://127.0.0.1:9/never-contacted';
process.env.OWNER_SMS_MCP_TOKEN = '';
process.env.OWNER_USER_ID = '1234567';
process.env.OWNER_DISPLAY_NAME = '测试 主人';
process.env.OWNER_SHORT_NAME = '阿主';
delete process.env.OWNER_SMS_ALLOW_TEST;
delete process.env.TEST_INSTANCE;
delete process.env.GEMINI_CLIENT_TOOLS;
// The bot's own rows (finalize stores the reply as a message of this user)
process.env.BOT_USER_ID = '7777';
// Gemini goes to the local stub; no side route may take the image model elsewhere
process.env.GEMINI_API_URL = `http://127.0.0.1:${geminiPort}`;
process.env.GEMINI_API_KEY = 'offline-stub';
for (const key of ['GEMINI_IMAGE_API_KEY', 'GEMINI_IMAGE_API_URL', 'GEMINI_LARGE_MEDIA_API_KEY', 'OPENCODE_GO_API_KEY']) {
    delete process.env[key];
}

const db = await setupOfflineDb();
const { Message, putCachedMedia } = db;

const { isImageOutputModel } = await import('../../src/ai/model-kinds.js');
const { carriesLargeMedia } = await import('../../src/ai/large-media.js');
const { GEMINI_IMAGE_MODEL, OPENAI_IMAGE_MODEL } = await import('../../src/config/models.js');
const { toToolName, stripSchemaMeta } = await import('../../src/ai/tools/tool-wire-formats.js');
const { createTurnTools } = await import('../../src/ai/tools/turn-tools.js');
const { runToolRound, createToolUsageTally } = await import('../../src/ai/tools/tool-round.js');
const { buildMcpToolHandlers } = await import('../../src/ai/tools/mcp-tool-handlers.js');
const mcp = await import('../../src/ai/mcp/index.js');
const replyTools = await import('../../src/reply/tools/index.js');
const toolConfig = await import('../../src/config/tool-config.js');
const responseHandler = await import('../../src/reply/response-handler.js');
const telegramModule = await import('../../src/telegram/index.js');
const { getBotResponse } = await import('../../src/db/index.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run `body` with console output captured instead of printed */
const captureConsole = async <T,>(body: () => Promise<T>): Promise<{ result: T; lines: string[] }> => {
    const lines: string[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    const record = (...args: unknown[]): void => {
        lines.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
    };
    console.log = record;
    console.warn = record;
    console.error = record;
    try {
        return { result: await body(), lines };
    } finally {
        console.log = original.log;
        console.warn = original.warn;
        console.error = original.error;
    }
};

const okResult = (content: string, extra: Partial<ToolResult> = {}): ToolResult => ({
    content,
    isError: false,
    images: [],
    record: null,
    ...extra,
});

const call = (name: string, argumentsJson = '{}', id = `call-${name}`): ToolCall => ({ id, name, argumentsJson });

const drain = async <T, R>(generator: AsyncGenerator<T, R, void>): Promise<{ items: T[]; returned: R }> => {
    const items: T[] = [];
    for (;;) {
        const next = await generator.next();
        if (next.done) return { items, returned: next.value };
        items.push(next.value);
    }
};

const emptyState = (): ResponseState => ({
    textBuffer: '',
    thinkingBuffer: '',
    fullText: '',
    fullThinking: '',
    thinkingTruncatedChars: 0,
    images: [],
    groundingData: [],
    agentStats: undefined,
    modelParts: undefined,
    rawResponse: undefined,
    isDone: false,
});

const reply = (fields: Partial<AIResponse>): AIResponse => ({
    text: '',
    thinkingText: '',
    images: [],
    groundingData: [],
    ...fields,
});

const waitFor = async (condition: () => boolean, timeoutMs = 3000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (condition()) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return condition();
};

const DRAWING: ToolStatus = { text: '🎨 正在画图…', chatAction: 'upload_photo' };

const toolContext = (chatId: number) =>
    replyTools.buildReplyToolContext({
        chat: { id: chatId, type: 'supergroup', title: '测试群' },
        triggerMessage: { messageId: 1, userId: 42, userName: '张三', text: '找张狗头表情包' },
        contextIndex: new Map(),
        signal: new AbortController().signal,
    });

// ---- fake Telegram: a real grammY Api whose transformer answers locally ----

interface TelegramCall {
    readonly method: string;
    readonly payload: Readonly<Record<string, unknown>>;
}

interface FakeTelegram {
    readonly api: Api;
    readonly calls: TelegramCall[];
    /** Methods answered with a 400, e.g. sendPhoto to force the document fallback */
    readonly failingMethods: Set<string>;
    /** Ids of the messages sent through `method`, in order */
    readonly sentIds: (method: string) => number[];
}

const SENDING_METHODS: ReadonlySet<string> = new Set(['sendMessage', 'sendPhoto', 'sendDocument']);
let nextFakeMessageId = 90_000;

const fakeChat = (chatId: number) => ({ id: chatId, type: 'supergroup' as const, title: '测试群' });

const createFakeTelegram = (chatId: number): FakeTelegram => {
    const calls: TelegramCall[] = [];
    const failingMethods = new Set<string>();
    const sent: Array<{ readonly method: string; readonly messageId: number }> = [];

    const answer = async (method: string, payload: unknown) => {
        calls.push({ method, payload: asRecord(payload) });
        if (failingMethods.has(method)) {
            return { ok: false, error_code: 400, description: `Bad Request: ${method} refused offline` };
        }
        if (!SENDING_METHODS.has(method)) return { ok: true, result: true };
        nextFakeMessageId += 1;
        sent.push({ method, messageId: nextFakeMessageId });
        return { ok: true, result: { message_id: nextFakeMessageId, date: 0, chat: fakeChat(chatId) } };
    };

    const api = new Api('0:offline-token');
    // The transformer is generic over every method: one cast at this boundary
    const offlineTransformer = (_previous: unknown, method: string, payload: unknown) => answer(method, payload);
    api.config.use(offlineTransformer as Transformer);

    return {
        api,
        calls,
        failingMethods,
        sentIds: (method) => sent.filter((message) => message.method === method).map((message) => message.messageId),
    };
};

const editsOf = (telegram: FakeTelegram, messageId: number | undefined): string[] =>
    telegram.calls
        .filter((telegramCall) => telegramCall.method === 'editMessageText' && telegramCall.payload.message_id === messageId)
        .map((telegramCall) => String(telegramCall.payload.text ?? ''));

const BOT_ME: UserFromGetMe = {
    id: 7777,
    is_bot: true,
    first_name: 'Bot',
    username: 'AfterSchoolTeatimeBot',
    can_join_groups: true,
    can_read_all_group_messages: true,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
};

/** A chat context exactly as a real trigger message creates it */
const startChat = async (chatId: number) => {
    const telegram = createFakeTelegram(chatId);
    const userMessageId = takeMessageId();
    const ctx = new Context(
        {
            update_id: userMessageId,
            message: {
                message_id: userMessageId,
                date: 0,
                chat: fakeChat(chatId),
                from: { id: 42, is_bot: false, first_name: '张三' },
                text: '画一只猫',
            },
        },
        telegram.api,
        BOT_ME
    );
    const { result: chatContext } = await captureConsole(() => responseHandler.createChatContext(ctx));
    if (!chatContext) throw new Error('the chat context was not created');
    return { telegram, chatContext };
};

interface RecordingEditor extends StreamingEditor {
    readonly statusCalls: Array<string | undefined>;
    readonly contents: string[];
}

const createRecordingEditor = (): RecordingEditor => {
    const statusCalls: Array<string | undefined> = [];
    const contents: string[] = [];
    let stopped = false;
    return {
        statusCalls,
        contents,
        updateContent: async (content) => {
            contents.push(content);
            return true;
        },
        updateStatusOnly: async () => true,
        setStatus: (statusText) => {
            statusCalls.push(statusText);
        },
        stop: () => {
            stopped = true;
        },
        isStopped: () => stopped,
        delete: async () => true,
        getIds: () => ({ chatId: 0, messageId: 0 }),
    };
};

interface RecordingTyping extends TypingIndicator {
    readonly actions: ToolChatAction[];
}

const createRecordingTyping = (): RecordingTyping => {
    const actions: ToolChatAction[] = [];
    let active = true;
    return {
        actions,
        start: () => {
            active = true;
        },
        stop: () => {
            active = false;
        },
        isActive: () => active,
        setAction: (action) => {
            actions.push(action);
        },
    };
};

/** One run of GeminiPlatform.getModelCapabilities in a fresh process with `env` */
const GEMINI_SWITCH_PROBE =
    "const { GeminiPlatform } = await import('./src/ai/platforms/gemini-platform.ts');" +
    "console.log(String(new GeminiPlatform().getModelCapabilities('gemini-4-argon').supportsClientTools));";

const probeGeminiClientTools = (env: Record<string, string>): string => {
    const probe = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', GEMINI_SWITCH_PROBE], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
            PATH: process.env.PATH ?? '',
            HOME: process.env.HOME ?? '',
            GEMINI_API_KEY: 'offline-stub',
            GEMINI_API_URL: 'http://127.0.0.1:9',
            ...env,
        },
    });
    return probe.stdout.trim().split('\n').at(-1) ?? `(no output: ${probe.stderr.trim()})`;
};

// MCP connects once for the whole file; its log lines are checked below
const mcpInit = await captureConsole(() => mcp.initMcpClients());

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const cases: Array<{ name: string; body: () => Promise<void> }> = [
    {
        // The Nano Banana ids carry no "image": the substring rule alone sent
        // 2.1 the chat persona and urlContext, which it answers with 400
        name: 'image models are recognised by id, including Nano Banana 2.1',
        body: async () => {
            expect(GEMINI_IMAGE_MODEL === 'gemini-nano-banana-2.1', 'the menu/picbanana constant is 2.1');
            expect(isImageOutputModel('gemini-nano-banana-2.1'), 'gemini-nano-banana-2.1 is an image model');
            expect(isImageOutputModel('Gemini-Nano-Banana-2.1'), 'case does not matter');
            expect(isImageOutputModel('gemini-3-pro-image'), 'the previous image model still is one');
            expect(isImageOutputModel(OPENAI_IMAGE_MODEL), 'so is the OpenAI image model');
            expect(
                !isImageOutputModel('gemini-4-argon') && !isImageOutputModel('gemini-3.8-flash') && !isImageOutputModel('claude-sonnet-5'),
                'chat models are not'
            );
        },
    },
    {
        name: 'tool names are made provider-safe and unique',
        body: async () => {
            const validName = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
            const none = new Set<string>();
            expect(toToolName('searxng_web_search', none) === 'searxng_web_search', 'a valid name is kept as is');
            expect(toToolName('resolve-library-id', none) === 'resolve-library-id', 'dashes are fine');
            expect(toToolName('odd.tool name', none) === 'odd_tool_name', 'dots and spaces become underscores');
            expect(toToolName('1st-tool', none) === '_1st-tool', 'a leading digit gets an underscore in front');
            expect(toToolName('查询', none) === '__', `non-ASCII is replaced (got ${toToolName('查询', none)})`);
            expect(toToolName('', none) === '_', 'an empty name still yields a valid one');

            const long = 'x'.repeat(80);
            expect(toToolName(long, none).length === 64, 'long names are cut to 64');

            const taken = new Set(['generate_image', 'generate_image_2']);
            expect(toToolName('generate_image', taken) === 'generate_image_3', 'collisions count up from _2');
            const longTaken = new Set([long.slice(0, 64)]);
            const renamed = toToolName(long, longTaken);
            expect(renamed.length === 64 && renamed.endsWith('_2'), `a long duplicate stays within 64 (got ${renamed.length})`);
            expect(
                [renamed, toToolName('1st-tool', none), toToolName('odd.tool name', none)].every((name) => validName.test(name)),
                'every result matches the provider pattern'
            );
        },
    },
    {
        name: 'stripSchemaMeta drops only the top-level $schema',
        body: async () => {
            const schema = {
                $schema: 'http://json-schema.org/draft-07/schema#',
                type: 'object',
                properties: { nested: { $schema: 'kept', type: 'string' } },
            };
            const stripped = stripSchemaMeta(schema);
            expect(!('$schema' in stripped), 'the top-level key is gone');
            expect(json(stripped.properties) === json(schema.properties), 'nested schemas are untouched');
            expect('$schema' in schema, 'the input is not mutated');
        },
    },
    {
        name: 'turn tools never throw and never echo arguments',
        body: async () => {
            const received: Array<Readonly<Record<string, unknown>>> = [];
            let sideEffects = 0;
            const echo: ToolHandler = {
                definition: { name: 'echo', description: 'echo', inputSchema: { type: 'object' } },
                statusText: '🔁 正在复读…',
                execute: async (args) => {
                    sideEffects += 1;
                    received.push(args);
                    return okResult('echoed');
                },
            };
            const boom: ToolHandler = {
                definition: { name: 'boom', description: 'throws', inputSchema: { type: 'object' } },
                chatAction: 'upload_photo',
                execute: async () => {
                    throw new Error('kaboom');
                },
            };
            const shadow: ToolHandler = {
                definition: { name: 'echo', description: 'second echo', inputSchema: { type: 'object' } },
                execute: async () => okResult('shadow'),
            };

            const { result: tools, lines: setupLines } = await captureConsole(async () =>
                createTurnTools([echo, boom, shadow])
            );
            expect(
                json(tools.definitions.map((definition) => definition.description)) === '["echo","throws"]',
                'definitions keep handler order and the first of two same-named handlers'
            );
            expect(setupLines.some((line) => line.includes('Duplicate tool name echo')), 'the duplicate is logged');

            const { result: outcomes, lines } = await captureConsole(async () => ({
                unknown: await tools.execute(call('nope')),
                badJson: await tools.execute(call('echo', '{"token": "hunter2"')),
                notObject: await tools.execute(call('echo', '["hunter2"]')),
                empty: await tools.execute(call('echo', '  ')),
                thrown: await tools.execute(call('boom')),
            }));

            expect(outcomes.unknown.isError && outcomes.unknown.content === 'Unknown tool nope', 'an unknown name is an error result');
            expect(
                outcomes.badJson.isError && !outcomes.badJson.content.includes('hunter2'),
                `invalid JSON is an error that does not quote it (got ${json(outcomes.badJson.content)})`
            );
            expect(outcomes.notObject.isError && !outcomes.notObject.content.includes('hunter2'), 'so is a non-object');
            expect(
                !outcomes.empty.isError && received.length === 1 && json(received[0]) === '{}',
                'empty arguments reach the handler as {}'
            );
            expect(
                outcomes.thrown.isError && outcomes.thrown.content === 'Tool boom failed: kaboom',
                `a throwing handler becomes an error result (got ${json(outcomes.thrown.content)})`
            );
            expect(
                lines.filter((line) => line.startsWith('[tools] ')).length === 5 &&
                    lines.every((line) => !line.includes('hunter2')),
                'one log line per call, never with the arguments'
            );

            const stopped = new AbortController();
            stopped.abort();
            const afterStop = await captureConsole(() => tools.execute(call('echo'), stopped.signal));
            expect(afterStop.result.isError && sideEffects === 1, 'a stopped reply runs no further tools');

            expect(
                tools.statusOf('echo').text === '🔁 正在复读…' && tools.statusOf('echo').chatAction === 'typing',
                'the status text comes from the handler, typing by default'
            );
            expect(tools.statusOf('boom').chatAction === 'upload_photo', "the handler's chat action is used");
            expect(
                tools.statusOf('mystery').text === '⚙ 正在调用 mystery…',
                'a tool without its own line gets the generic one'
            );

            // Each call runs on a child of the reply's signal
            const replyStop = new AbortController();
            const seenSignals: AbortSignal[] = [];
            const watcher: ToolHandler = {
                definition: { name: 'watch', description: 'keeps its signal', inputSchema: { type: 'object' } },
                execute: async (_args, signal) => {
                    seenSignals.push(signal);
                    return okResult('watched');
                },
            };
            const watchTools = createTurnTools([watcher]);
            await captureConsole(async () => {
                await watchTools.execute(call('watch'), replyStop.signal);
                await watchTools.execute(call('watch'), replyStop.signal);
            });
            const [firstSignal, secondSignal] = seenSignals;
            expect(
                firstSignal !== undefined &&
                    secondSignal !== undefined &&
                    firstSignal !== replyStop.signal &&
                    firstSignal !== secondSignal &&
                    !firstSignal.aborted,
                'every call gets its own signal, not the shared stop signal'
            );
            replyStop.abort();
            expect(firstSignal?.aborted === true && secondSignal?.aborted === true, "and each still follows the reply's stop");
        },
    },
    {
        name: 'a tool round streams status, images and records, then clears the status',
        body: async () => {
            const offered = (name: string) => ({ name, description: name, inputSchema: { type: 'object' } });
            const tools: TurnTools = {
                definitions: [offered('draw'), offered('search')],
                execute: async (toolCall) =>
                    toolCall.name === 'draw'
                        ? okResult('drawn', {
                              images: [
                                  { data: PNG_BYTES, mimeType: 'image/png', caption: '第一张' },
                                  { data: Buffer.from('second'), mimeType: 'image/webp' },
                              ],
                              record: { provider: 'mcp', searchQueries: ['draw: cat'], citations: [] },
                          })
                        : okResult('searched'),
                statusOf: (name) => ({ text: `running ${name}`, chatAction: name === 'draw' ? 'upload_photo' : 'typing' }),
            };
            const tally = createToolUsageTally();
            const { items, returned } = await drain(
                runToolRound(tools, [call('draw'), call('search', '{}', 'a'), call('search', '{}', 'b')], tally)
            );

            const shape = items.map((chunk) => (chunk.type === 'status' ? `status:${chunk.status?.text ?? '-'}` : chunk.type));
            expect(
                json(shape) ===
                    json([
                        'status:running draw',
                        'image',
                        'image',
                        'grounding',
                        'status:running search',
                        'status:running search',
                        'status:-',
                    ]),
                `status → images → record per call, one clear at the end (got ${json(shape)})`
            );
            const firstImage = items[1];
            expect(
                firstImage?.type === 'image' &&
                    firstImage.imageData?.equals(PNG_BYTES) === true &&
                    firstImage.imageMimeType === 'image/png' &&
                    firstImage.imageCaption === '第一张',
                'image chunks carry the bytes, the real mime and the caption'
            );
            expect(items[0]?.status?.chatAction === 'upload_photo', 'the status names the chat action');
            expect(
                returned.map((executed) => executed.call.id).join(',') === 'call-draw,a,b',
                'the calls come back in order with their results'
            );
            expect(
                json(tally.snapshot()) === '[{"name":"draw","count":1},{"name":"search","count":2}]',
                `usage is tallied in first-use order (got ${json(tally.snapshot())})`
            );

            const nothing = await drain(runToolRound(tools, [], createToolUsageTally()));
            expect(nothing.items.length === 0 && nothing.returned.length === 0, 'no calls, no chunks');

            // A name the turn does not offer is answered, but nothing ran: no status, no usage
            const unknownTally = createToolUsageTally();
            const unknown = await drain(
                runToolRound(createTurnTools([]), [call('searxng_web_search')], unknownTally)
            );
            expect(
                unknown.items.length === 0 &&
                    unknown.returned[0]?.result.content === 'Unknown tool searxng_web_search' &&
                    unknownTally.snapshot().length === 0,
                `an unoffered call shows no status and is not tallied (got ${json(unknown.items)})`
            );
            const mixedTally = createToolUsageTally();
            const mixed = await drain(runToolRound(tools, [call('nope'), call('search')], mixedTally));
            expect(
                json(mixed.items.map((chunk) => chunk.status?.text ?? '-')) === json(['running search', '-']) &&
                    json(mixedTally.snapshot()) === '[{"name":"search","count":1}]' &&
                    mixed.returned.length === 2,
                `next to an offered one, only that one shows and counts (got ${json(mixed.items)})`
            );
        },
    },
    {
        name: 'MCP_SERVERS entries are validated one by one and never logged',
        body: async () => {
            const servers = mcp.listMcpServers();
            expect(
                servers.map((server) => server.name).join(',') === 'searxng,context7,retired',
                `bad entries are skipped, the rest connect in config order (got ${servers.map((server) => server.name).join(',')})`
            );
            const warnings = mcpInit.lines.filter((line) => line.includes('Skipping MCP server'));
            expect(
                warnings.some((line) => line.includes('"broken"')) && warnings.some((line) => line.includes('"misspelt"')),
                `each bad entry is named by its key (got ${json(warnings)})`
            );
            expect(
                warnings.some((line) => line.includes('"typo"') && line.includes('excludePlatform ')),
                `an unknown key skips the entry and is named (got ${json(warnings)})`
            );
            expect(
                mcpInit.lines.every(
                    (line) => !line.includes(MCP_SECRET) && !line.includes('definitely not a url') && !line.includes('gemni')
                ),
                'no value from the config reaches the logs'
            );
            expect(
                json(servers[0]?.config.excludePlatforms) === '["gemini","grok"]',
                'excludePlatforms is carried on the server config'
            );

            const { result: fromBrokenJson, lines } = await captureConsole(async () =>
                mcp.parseMcpServers(`{"x": {"serverUrl": "http://a", "headers": {"k": "${MCP_SECRET}"}`)
            );
            expect(fromBrokenJson.length === 0, 'broken JSON yields no server');
            expect(
                lines.length === 1 && !lines[0]?.includes(MCP_SECRET) && !lines[0]?.includes('serverUrl'),
                `and is reported without quoting it (got ${json(lines)})`
            );
        },
    },
    {
        name: 'MCP calls honour isError, keep non-text content and stop on time',
        body: async () => {
            const resolved = await mcp.callMcpTool('context7', 'resolve-library-id', { libraryName: 'grammy' });
            expect(
                !resolved.isError &&
                    resolved.hasContent &&
                    resolved.content ===
                        'library id: /grammyjs/grammY\n[image content omitted (image/png)]\n[resource link: https://docs.example/grammy]',
                `non-text blocks leave a placeholder line (got ${json(resolved.content)})`
            );
            const failed = await mcp.callMcpTool('context7', 'query-docs', { query: 'x' });
            expect(failed.isError && failed.content === 'quota exceeded', 'isError from the server is kept');
            const empty = await mcp.callMcpTool('context7', 'generate_image', {});
            expect(
                empty.content === 'Tool returned no content.' && !empty.hasContent,
                'empty content is said so, and flagged as no content'
            );
            expect(
                stubMcpRequests.some(
                    (request) => request.server === 'context7' && request.authorization === `Bearer ${MCP_SECRET}`
                ),
                'configured headers reach the server'
            );

            const timedOutAt = Date.now();
            const timedOut = await mcp
                .callMcpTool('context7', 'slow_tool', {}, { timeoutMs: 200 })
                .then(() => 'answered', (error: Error) => error.message);
            expect(
                /time/i.test(timedOut) && Date.now() - timedOutAt < 2000,
                `the per-call timeout applies (got ${json(timedOut)})`
            );

            const stop = new AbortController();
            setTimeout(() => stop.abort(), 100);
            const abortedAt = Date.now();
            const aborted = await mcp
                .callMcpTool('context7', 'slow_tool', {}, { signal: stop.signal })
                .then(() => 'answered', () => 'rejected');
            expect(aborted === 'rejected' && Date.now() - abortedAt < 2000, 'the stop signal cancels the call');

            const missing = await mcp
                .callMcpTool('nowhere', 'x', {})
                .then(() => 'answered', (error: Error) => error.message);
            expect(missing.includes('not connected'), 'an unknown server is an error');
        },
    },
    {
        name: 'MCP tools become turn tools under safe, collision-free names',
        body: async () => {
            const handlers = buildMcpToolHandlers(['context7', 'searxng'], replyTools.RESERVED_TOOL_NAMES);
            const names = handlers.map((handler) => handler.definition.name);
            expect(
                names.join(',') ===
                    'searxng_web_search,web_url_read,resolve-library-id,query-docs,generate_image_2,odd_tool_name,slow_tool',
                `config order, reserved and invalid names renamed (got ${names.join(',')})`
            );
            expect(
                '$schema' in (handlers[0]?.definition.inputSchema ?? {}),
                'the MCP schema is kept verbatim (wire formats adapt it)'
            );

            const tools = createTurnTools(handlers);
            const before = stubMcpRequests.length;
            const { result: searched } = await captureConsole(() =>
                tools.execute(call('searxng_web_search', '{"query":"猫"}'))
            );
            await captureConsole(() => tools.execute(call('generate_image_2')));
            await captureConsole(() => tools.execute(call('odd_tool_name', '{"a":1}')));
            const calledNames = stubMcpRequests
                .slice(before)
                .filter((request) => request.method === 'tools/call')
                .map((request) => request.toolName);
            expect(
                json(calledNames) === json(['searxng_web_search', 'generate_image', 'odd.tool name']),
                `each call reaches the original MCP name (got ${json(calledNames)})`
            );
            expect(
                json(searched.record?.searchQueries) === '["searxng_web_search: 猫"]' &&
                    searched.record?.citations?.length === 2,
                `a search call carries its record (got ${json(searched.record)})`
            );
            expect(
                buildMcpToolHandlers([], replyTools.RESERVED_TOOL_NAMES).length === 0,
                'no allowed server, no MCP tools'
            );

            // Switched off by original name before renaming: the rest keep their names
            const filtered = buildMcpToolHandlers(
                ['context7'],
                replyTools.RESERVED_TOOL_NAMES,
                (toolName) => toolName !== 'generate_image' && toolName !== 'odd.tool name'
            ).map((handler) => handler.definition.name);
            expect(
                filtered.join(',') === 'resolve-library-id,query-docs,slow_tool',
                `disabled tools leave no gap or shifted suffix (got ${filtered.join(',')})`
            );
        },
    },
    {
        name: 'which tools a turn gets follows the model, the chat and the config',
        body: async () => {
            const { resolveToolAvailability } = replyTools;
            const describe = (model: string, chatId: number): string => {
                const availability = resolveToolAvailability(model, chatId);
                return `${availability.mcpServers.join('+') || '-'}|sms=${availability.sms}|image=${availability.image}`;
            };

            expect(
                describe('gemini-4-argon', WHITELISTED_CHAT_ID) === 'context7|sms=true|image=true',
                `Gemini gets no searxng, the disabled server never shows (got ${describe('gemini-4-argon', WHITELISTED_CHAT_ID)})`
            );
            expect(
                describe('grok-4.20-0309-reasoning', WHITELISTED_CHAT_ID) === 'context7|sms=true|image=true',
                `Grok gets no searxng either (got ${describe('grok-4.20-0309-reasoning', WHITELISTED_CHAT_ID)})`
            );
            expect(
                describe('deepseek-reasoning', WHITELISTED_CHAT_ID) === 'searxng+context7|sms=true|image=true',
                `other platforms keep searxng (got ${describe('deepseek-reasoning', WHITELISTED_CHAT_ID)})`
            );
            expect(
                describe('grok-4.20-multi-agent-0309', WHITELISTED_CHAT_ID) === '-|sms=false|image=false',
                'grok multi-agent gets nothing'
            );
            expect(describe(GEMINI_IMAGE_MODEL, WHITELISTED_CHAT_ID) === '-|sms=false|image=false', 'the Gemini image model gets nothing');
            expect(describe(OPENAI_IMAGE_MODEL, WHITELISTED_CHAT_ID) === '-|sms=false|image=false', 'nor does the OpenAI one');
            expect(
                describe('gemini-2.5-flash', WHITELISTED_CHAT_ID) === '-|sms=false|image=false',
                'a Gemini model outside the verified list gets nothing'
            );
            expect(
                describe('gemini-4-argon', OTHER_CHAT_ID) === 'context7|sms=false|image=false',
                'outside TOOL_CHAT_IDS: no SMS, no image, MCP stays'
            );

            // Gemini sends a turn with gs:// media without client tools, so it is offered none
            const withLargeMedia = (model: string): string => {
                const availability = resolveToolAvailability(model, WHITELISTED_CHAT_ID, undefined, { carriesLargeMedia: true });
                return `${availability.mcpServers.join('+') || '-'}|sms=${availability.sms}|image=${availability.image}`;
            };
            expect(
                withLargeMedia('gemini-4-argon') === '-|sms=false|image=false',
                `a Gemini turn with large media gets no tools, so the prompt names none (got ${withLargeMedia('gemini-4-argon')})`
            );
            expect(
                withLargeMedia('deepseek-reasoning') === describe('deepseek-reasoning', WHITELISTED_CHAT_ID),
                'other platforms keep their tools'
            );
            const largeVideo: UnifiedMessage = {
                role: 'user',
                content: [{ type: 'media', mimeType: 'video/mp4', fileUri: 'gs://offline-bucket/video.mp4' }],
            };
            const inlineVideo: UnifiedMessage = {
                role: 'user',
                content: [{ type: 'text', text: '看看' }, { type: 'media', mimeType: 'video/mp4', mediaData: 'AAAA' }],
            };
            expect(
                carriesLargeMedia([inlineVideo, largeVideo]) && !carriesLargeMedia([inlineVideo]),
                'a gs:// media part counts as large media, inline media does not'
            );
            const largeMediaTurn = replyTools.createReplyTools('gemini-4-argon', toolContext(WHITELISTED_CHAT_ID), {
                carriesLargeMedia: true,
            });
            expect(
                largeMediaTurn.tools.definitions.length === 0 && !largeMediaTurn.availability.sms,
                'and the reply snapshot is empty'
            );

            process.env.TEST_INSTANCE = '1';
            try {
                expect(
                    describe('gemini-4-argon', WHITELISTED_CHAT_ID) === 'context7|sms=false|image=true',
                    'the test instance never gets SMS by default'
                );
            } finally {
                delete process.env.TEST_INSTANCE;
            }
        },
    },
    {
        name: 'tool settings parse from the env with safe defaults',
        body: async () => {
            const { readToolConfig } = toolConfig;
            const unset = readToolConfig({});
            expect(
                unset.toolChatIds.size === 0 && unset.disabledTools.size === 0 && unset.ownerSmsUrl === '',
                'nothing configured: no chat, nothing disabled, no SMS endpoint'
            );
            expect(unset.geminiClientTools && !unset.ownerSmsAllowTest, 'Gemini tools on, test-instance SMS off');
            expect(
                json(unset.owner) === json({ userId: null, displayName: '机主', shortName: null }),
                `an unnamed owner is 机主 without an id (got ${json(unset.owner)})`
            );

            const configured = readToolConfig({
                TOOL_CHAT_IDS: ' -100123 , 603, x, 0, 1.5,, 9007199254740993',
                DISABLED_TOOLS: ' generate_image ,context7-mcp,,',
                GEMINI_CLIENT_TOOLS: '0',
                OWNER_SMS_MCP_URL: '  http://sms.invalid/mcp  ',
                OWNER_SMS_ALLOW_TEST: '1',
                OWNER_USER_ID: ' 1234567 ',
                OWNER_DISPLAY_NAME: ' 测试 主人 ',
                OWNER_SHORT_NAME: '测试 主人',
            });
            expect(
                [...configured.toolChatIds].join(',') === '-100123,603',
                `chat ids: safe integers only (got ${[...configured.toolChatIds].join(',')})`
            );
            expect([...configured.disabledTools].join(',') === 'generate_image,context7-mcp', 'names are trimmed, blanks dropped');
            expect(!configured.geminiClientTools, 'GEMINI_CLIENT_TOOLS=0 switches Gemini tools off');
            expect(configured.ownerSmsUrl === 'http://sms.invalid/mcp' && configured.ownerSmsAllowTest, 'the SMS settings are read');
            expect(
                json(configured.owner) === json({ userId: '1234567', displayName: '测试 主人', shortName: null }),
                `a short name equal to the display name adds nothing (got ${json(configured.owner)})`
            );
        },
    },
    {
        name: 'SMS and image availability follow every switch',
        body: async () => {
            const { resolveToolAvailability } = replyTools;
            const { readToolConfig } = toolConfig;
            const baseEnv = { TOOL_CHAT_IDS: String(WHITELISTED_CHAT_ID), OWNER_SMS_MCP_URL: 'http://sms.invalid/mcp' };
            const availableWith = (env: Record<string, string>, model = 'deepseek-flash') =>
                resolveToolAvailability(model, WHITELISTED_CHAT_ID, readToolConfig({ ...baseEnv, ...env }));

            expect(availableWith({}).sms && availableWith({}).image, 'a whitelisted chat with an SMS endpoint gets both');
            expect(!availableWith({ OWNER_SMS_MCP_URL: ' ' }).sms, 'no SMS endpoint, no SMS tool');
            const smsOff = availableWith({ DISABLED_TOOLS: 'send_sms_to_owner' });
            expect(!smsOff.sms && smsOff.image, 'DISABLED_TOOLS=send_sms_to_owner leaves the image tool');
            const imageOff = availableWith({ DISABLED_TOOLS: 'generate_image' });
            expect(imageOff.sms && !imageOff.image, 'DISABLED_TOOLS=generate_image leaves SMS');

            process.env.TEST_INSTANCE = '1';
            try {
                expect(!availableWith({}).sms, 'the test instance gets no SMS');
                expect(availableWith({ OWNER_SMS_ALLOW_TEST: '1' }).sms, 'unless OWNER_SMS_ALLOW_TEST=1');
            } finally {
                delete process.env.TEST_INSTANCE;
            }

            const servers = (env: Record<string, string>): string => availableWith(env).mcpServers.join('+');
            expect(servers({}) === 'searxng+context7+retired', `every connected server (got ${servers({})})`);
            expect(servers({ DISABLED_TOOLS: 'context7' }) === 'searxng+retired', 'a server key switches the server off');
            expect(
                servers({ DISABLED_TOOLS: 'old_tool' }) === 'searxng+context7',
                'a server left without an enabled tool drops out'
            );
            const queryDocsOff = availableWith({ DISABLED_TOOLS: 'query-docs' });
            expect(
                !queryDocsOff.isMcpToolEnabled('query-docs') && queryDocsOff.isMcpToolEnabled('resolve-library-id'),
                'single MCP tools are switched off by their original name'
            );
        },
    },
    {
        name: 'GEMINI_CLIENT_TOOLS=0 takes the client tools away from Gemini',
        body: async () => {
            const enabled = probeGeminiClientTools({});
            expect(enabled === 'true', `gemini-4-argon takes client tools by default (got ${enabled})`);
            const switchedOff = probeGeminiClientTools({ GEMINI_CLIENT_TOOLS: '0' });
            expect(switchedOff === 'false', `and none with the switch off (got ${switchedOff})`);
        },
    },
    {
        name: 'a reply gets MCP tools first, then SMS, then image, byte-stable',
        body: async () => {
            const build = () => replyTools.createReplyTools('gemini-4-argon', toolContext(WHITELISTED_CHAT_ID));
            const first = build();
            const names = first.tools.definitions.map((definition) => definition.name);
            expect(
                names.join(',') ===
                    'resolve-library-id,generate_image_2,slow_tool,send_sms_to_owner,generate_image,search_images,fetch_image,send_image',
                `order, and DISABLED_TOOLS applied per tool by original name (got ${names.join(',')})`
            );
            expect(
                json(first.tools.definitions) === json(build().tools.definitions),
                'the declarations are byte-identical between turns'
            );

            const sms = first.tools.definitions.find((definition) => definition.name === 'send_sms_to_owner');
            expect(
                sms?.description === '给阿主（测试 主人，Telegram id 1234567）的手机发送一条短信',
                `the SMS tool names the owner from the env (got ${json(sms?.description)})`
            );
            const image = first.tools.definitions.find((definition) => definition.name === 'generate_image');
            const imageSchema = asRecord(image?.inputSchema);
            expect(
                json(imageSchema.required) === '["prompt","caption"]' &&
                    Object.keys(asRecord(imageSchema.properties)).join(',') ===
                        'prompt,caption,references,web_references,aspect_ratio',
                'generate_image requires prompt and caption'
            );
            expect(
                first.tools.statusOf('generate_image').text === '🎨 正在画图…' &&
                    first.tools.statusOf('generate_image').chatAction === 'upload_photo',
                'drawing shows its own status and the upload_photo action'
            );
            expect(first.tools.statusOf('send_sms_to_owner').text === '📨 正在发短信…', 'so does texting');

            const elsewhere = replyTools.createReplyTools('gemini-4-argon', toolContext(OTHER_CHAT_ID));
            expect(
                elsewhere.tools.definitions.every((definition) => !['send_sms_to_owner', 'generate_image'].includes(definition.name)),
                'outside the whitelist the built-in tools are absent'
            );
            const imageModel = replyTools.createReplyTools(GEMINI_IMAGE_MODEL, toolContext(WHITELISTED_CHAT_ID));
            expect(imageModel.tools.definitions.length === 0, 'an image model gets an empty snapshot');
        },
    },
    {
        name: 'the owner is named the same way wherever the model reads about them',
        body: async () => {
            const { formatOwnerLabel } = toolConfig;
            const { buildCapabilitiesSection } = await import('../../src/ai/system-prompt/sections.js');
            const full = { userId: '1234567', displayName: '测试 主人', shortName: '阿主' };
            const toolLabel = { idLabel: 'Telegram id', withShortName: true };
            const promptLabel = { idLabel: 'id', withShortName: false };

            expect(formatOwnerLabel(full, toolLabel) === '阿主（测试 主人，Telegram id 1234567）', 'tool: short name first');
            expect(formatOwnerLabel(full, promptLabel) === '测试 主人（id 1234567）', 'prompt: display name and id');
            expect(
                formatOwnerLabel({ ...full, shortName: null }, toolLabel) === '测试 主人（Telegram id 1234567）',
                'no short name: the display name leads'
            );
            expect(
                formatOwnerLabel({ ...full, userId: null }, toolLabel) === '阿主（测试 主人）',
                'no id: the id part drops out'
            );
            const unnamed = { userId: null, displayName: '机主', shortName: null };
            expect(formatOwnerLabel(unnamed, toolLabel) === '机主', 'nothing configured: a bare 机主');
            expect(
                buildCapabilitiesSection({ smsOwner: unnamed, imageTools: false, imageFetch: false }).endsWith(
                    '\n- 可以用 `send_sms_to_owner` 给机主发送短信'
                ),
                'and the prompt line reads the same'
            );
        },
    },
    {
        name: 'the tool context names the chat, or none in a private chat',
        body: async () => {
            const signal = new AbortController().signal;
            const triggerMessage = { messageId: 5, userId: null, userName: '李四', text: null };
            const group = replyTools.buildReplyToolContext({
                chat: { id: -100555, type: 'supergroup', title: '主群' },
                triggerMessage,
                contextIndex: new Map(),
                signal,
            });
            const privateChat = replyTools.buildReplyToolContext({
                chat: { id: 4242, type: 'private', first_name: '李四' },
                triggerMessage,
                contextIndex: new Map(),
                signal,
            });
            expect(group.chatTitle === '主群' && group.chatId === -100555, 'a group carries its title');
            expect(privateChat.chatTitle === undefined && privateChat.chatId === 4242, 'a private chat has no title');
            expect(
                json(privateChat.requester) === json({ userId: null, name: '李四' }) && privateChat.triggerMessageId === 5,
                'the requester is the trigger message row (an old row may lack its user id)'
            );
        },
    },
    {
        name: 'the system prompt is byte-stable and names the owner only with the SMS tool',
        body: async () => {
            const { buildStaticSystemPrompt } = await import('../../src/ai/system-prompt/index.js');
            const model = 'gemini-4-argon';
            const plain = buildStaticSystemPrompt(model);
            expect(plain === buildStaticSystemPrompt(model), 'the same model builds the same bytes');
            expect(
                plain === buildStaticSystemPrompt(model, {}) && plain === buildStaticSystemPrompt(model, { sms: false }),
                'no SMS option is exactly the one-argument prompt'
            );
            expect(!plain.includes('send_sms_to_owner'), 'and it never mentions the tool');

            const withSms = buildStaticSystemPrompt(model, { sms: true });
            expect(withSms === buildStaticSystemPrompt(model, { sms: true }), 'the SMS variant is byte-stable too');
            const bullet = '- 可以用 `send_sms_to_owner` 给测试 主人（id 1234567）发送短信';
            const addedLines = withSms.split('\n').filter((line) => !plain.split('\n').includes(line));
            expect(json(addedLines) === json([bullet]), `exactly one bullet is added (got ${json(addedLines)})`);
            expect(withSms.replace(`\n${bullet}`, '') === plain, 'and nothing else changes');
            const capabilities = withSms.indexOf('# 能力与输出');
            const notes = withSms.indexOf('# 注意');
            const bulletAt = withSms.indexOf(bullet);
            expect(capabilities < bulletAt && bulletAt < notes, 'the bullet sits in the capabilities section');
        },
    },
    {
        name: 'a status chunk sets and clears the tool status, never the text',
        body: async () => {
            const { processChunk } = responseHandler;
            const keep = (text: string): string => text;
            let state = processChunk({ type: 'status', status: DRAWING }, emptyState(), keep);
            expect(state.toolStatus === DRAWING, 'a status chunk sets the status');
            state = processChunk({ type: 'text', content: '好的' }, state, keep);
            expect(state.toolStatus === DRAWING && state.fullText === '好的', 'other chunks leave it alone');
            state = processChunk({ type: 'status' }, state, keep);
            expect(state.toolStatus === undefined, 'a bare status chunk clears it');
            expect(state.fullText === '好的' && state.textBuffer === '好的', 'and the status never enters the text');

            // Only the first image is delivered, so only its caption is kept
            state = processChunk({ type: 'image', imageData: PNG_BYTES, imageCaption: '配文一' }, state, keep);
            state = processChunk({ type: 'image', imageData: PNG_BYTES, imageCaption: '配文二' }, state, keep);
            expect(state.images.length === 2 && state.imageCaption === '配文一', 'the caption of the first image is kept');
        },
    },
    {
        name: 'the streaming editor shows a tool status in place of the spinner word',
        body: async () => {
            const chatId = -1003400000001;
            const messageId = 7;
            const telegram = createFakeTelegram(chatId);
            const edits = (): string[] => editsOf(telegram, messageId);
            const editor = telegramModule.createStreamingEditor({
                api: telegram.api,
                chatId,
                messageId,
                idleInterval: 600_000,
                initialContent: '✽ Thinking...',
                getButtons: () => ({ inline_keyboard: [] }),
            });
            editor.setStatus(DRAWING.text);
            expect(await waitFor(() => edits().includes(DRAWING.text)), `the status shows at once (got ${json(edits())})`);
            await editor.updateContent('正文');
            expect(
                await waitFor(() => edits().includes(`正文\n${DRAWING.text}`)),
                `content updates keep the tool status line (got ${json(edits())})`
            );
            editor.setStatus(undefined);
            expect(
                await waitFor(() => edits().includes('正文\n✽ Thinking...')),
                `clearing brings the spinner back (got ${json(edits())})`
            );
            editor.setStatus('⚙ 正在调用 x…');
            await editor.updateContent('最终答案', { isFinal: true });
            expect(edits().at(-1) === '最终答案', `the final render carries no status line (got ${json(edits().at(-1))})`);
            editor.stop();
        },
    },
    {
        name: 'the typing indicator switches its chat action at once, only on change',
        body: async () => {
            const chatId = -1003400000002;
            const telegram = createFakeTelegram(chatId);
            const actions = (): unknown[] =>
                telegram.calls.filter((telegramCall) => telegramCall.method === 'sendChatAction').map((telegramCall) => telegramCall.payload.action);
            const typing = telegramModule.createTypingIndicator(telegram.api, chatId, 600_000);
            typing.start();
            typing.setAction('upload_photo');
            typing.setAction('upload_photo');
            typing.setAction('typing');
            typing.stop();
            typing.setAction('upload_photo');
            await waitFor(() => actions().length >= 3, 1000);
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(
                json(actions()) === '["typing","upload_photo","typing"]',
                `only on change and only while active (got ${json(actions())})`
            );
        },
    },
    {
        name: 'the stream processor drives the status line and the chat action',
        body: async () => {
            const { chatContext } = await startChat(-1003500000001);
            // Recording stand-ins for the live editor and typing indicator
            chatContext.editor.stop();
            chatContext.typing.stop();
            const editor = createRecordingEditor();
            const typing = createRecordingTyping();
            chatContext.editor = editor;
            chatContext.typing = typing;

            async function* toolTurn(): AsyncGenerator<StreamChunk> {
                yield { type: 'text', content: '好的，我来画' };
                yield { type: 'status', status: DRAWING };
                yield { type: 'image', imageData: PNG_BYTES, imageMimeType: 'image/png', imageCaption: '一只猫' };
                yield { type: 'status' };
                yield { type: 'text', content: '，画好了' };
                yield { type: 'done' };
            }
            const { result: response } = await captureConsole(() => responseHandler.processStream(toolTurn(), chatContext, 60_000));
            expect(
                json(editor.statusCalls) === json([DRAWING.text, undefined]),
                `the status is shown once and cleared once (got ${json(editor.statusCalls)})`
            );
            expect(
                json(typing.actions) === '["upload_photo","typing"]',
                `the chat action follows it (got ${json(typing.actions)})`
            );
            expect(
                editor.contents.some((text) => text.includes('好的，我来画')),
                `the text before the tool is flushed despite the throttle (got ${json(editor.contents)})`
            );
            expect(
                response.text === '好的，我来画，画好了' && response.images.length === 1 && response.imageCaption === '一只猫',
                `the reply carries the text, the image and its caption (got ${json(response.text)})`
            );
            expect(
                chatContext.session.textBuffer === '好的，我来画，画好了',
                'the stored text never contains the status line'
            );
        },
    },
    {
        name: 'a running tool keeps its status line on a continuation message',
        body: async () => {
            const { telegram, chatContext } = await startChat(-1003600000001);
            const firstId = chatContext.session.firstMessageId;
            const longText = Array.from({ length: 600 }, (_, index) => `第${index}行文字`).join('\n');
            async function* longToolTurn(): AsyncGenerator<StreamChunk> {
                yield { type: 'status', status: DRAWING };
                yield { type: 'text', content: longText };
                yield { type: 'text', content: '\n尾声' };
                yield { type: 'done' };
            }
            const { result: response } = await captureConsole(() =>
                responseHandler.processStream(longToolTurn(), chatContext, 0)
            );

            const [continuationId] = telegram.sentIds('sendMessage').slice(1);
            expect(continuationId !== undefined, 'the reply moved on to a continuation message');
            expect(
                await waitFor(() => editsOf(telegram, continuationId).some((text) => text.includes(DRAWING.text)), 8000),
                `the continuation shows the running tool (got ${json(editsOf(telegram, continuationId))})`
            );
            expect(
                json(chatContext.session.messageIds) === json([firstId, continuationId]),
                `each message id is recorded once (got ${json(chatContext.session.messageIds)})`
            );

            await captureConsole(() => responseHandler.sendFinalResponse(chatContext, response));
            const finalEdit = editsOf(telegram, continuationId).at(-1) ?? '';
            expect(finalEdit.includes('尾声') && !finalEdit.includes(DRAWING.text), 'the final render drops the status line');
            expect(
                json(chatContext.session.messageIds) === json([firstId, continuationId]),
                'and the final delivery records nothing twice'
            );
        },
    },
    {
        name: 'a stop while a tool runs ends the reply without its status line',
        body: async () => {
            const { telegram, chatContext } = await startChat(-1003700000001);
            const firstId = chatContext.session.firstMessageId;
            async function* stoppedTurn(): AsyncGenerator<StreamChunk> {
                yield { type: 'text', content: '好的，我来画' };
                yield { type: 'status', status: DRAWING };
                // The user presses stop while the picture is being drawn
                chatContext.session.streamController.abort();
                yield { type: 'text', content: '这句不会出现' };
            }
            const { result: response } = await captureConsole(() =>
                responseHandler.processStream(stoppedTurn(), chatContext, 0)
            );
            expect(
                await waitFor(() =>
                    telegram.calls.some((telegramCall) => telegramCall.method === 'sendChatAction' && telegramCall.payload.action === 'upload_photo')
                ),
                'the drawing status switched the chat action'
            );

            await captureConsole(() => responseHandler.sendFinalResponse(chatContext, response));
            const finalEdit = editsOf(telegram, firstId).at(-1) ?? '';
            expect(
                finalEdit.includes('好的，我来画') && !finalEdit.includes(DRAWING.text) && !finalEdit.includes('这句不会出现'),
                `the final render keeps the text and drops the status (got ${json(finalEdit)})`
            );
            expect(!chatContext.typing.isActive(), 'the chat action stops with the reply');
            expect(!chatContext.session.textBuffer.includes(DRAWING.text), 'the status never reaches the stored text');
        },
    },
    {
        name: 'final delivery records every message id exactly once',
        body: async () => {
            const deliver = async (chatId: number, response: AIResponse, failingMethods: string[] = []) => {
                const { telegram, chatContext } = await startChat(chatId);
                failingMethods.forEach((method) => telegram.failingMethods.add(method));
                const { session } = chatContext;
                const processingId = session.firstMessageId;
                await captureConsole(() => responseHandler.sendFinalResponse(chatContext, response));
                const stored = await getBotResponse(chatId, processingId);
                return { telegram, session, processingId, version: stored?.getVersions().at(-1) };
            };

            // Text plus an image: the text stays in the processing message, the image follows
            const withImage = await deliver(-1003800000001, reply({ text: '画好了', images: [PNG_BYTES] }));
            const photoIds = withImage.telegram.sentIds('sendPhoto');
            expect(
                json(withImage.session.messageIds) === json([withImage.processingId, ...photoIds]) && photoIds.length === 1,
                `text and image are listed once each (got ${json(withImage.session.messageIds)})`
            );
            expect(withImage.session.currentMessageId === photoIds[0], 'the image is the last message');
            expect(
                json(withImage.version?.messageIds) === json(withImage.session.messageIds),
                'the stored version lists the same ids'
            );

            // Image only: the processing message is deleted and leaves the list
            const imageOnly = await deliver(-1003800000002, reply({ images: [PNG_BYTES] }));
            const deleted = imageOnly.telegram.calls.some(
                (telegramCall) => telegramCall.method === 'deleteMessage' && telegramCall.payload.message_id === imageOnly.processingId
            );
            expect(
                deleted && json(imageOnly.session.messageIds) === json(imageOnly.telegram.sentIds('sendPhoto')),
                `only the image remains (got ${json(imageOnly.session.messageIds)})`
            );
            expect(json(imageOnly.version?.messageIds) === json(imageOnly.session.messageIds), 'and is what gets stored');

            // A reply too long for one message, then the image
            const longText = Array.from({ length: 700 }, (_, index) => `第 ${index} 段：一段足够长的测试文字。`).join('\n\n');
            const split = await deliver(-1003800000003, reply({ text: longText, images: [PNG_BYTES] }));
            const continuationIds = split.telegram.sentIds('sendMessage').slice(1);
            const splitIds = split.session.messageIds;
            expect(continuationIds.length >= 1, `the text is split (got ${continuationIds.length} continuation(s))`);
            expect(
                json(splitIds) === json([split.processingId, ...continuationIds, ...split.telegram.sentIds('sendPhoto')]) &&
                    new Set(splitIds).size === splitIds.length,
                `every part is listed once, in order (got ${json(splitIds)})`
            );

            // sendPhoto refused: the document fallback is listed once
            const fallback = await deliver(-1003800000004, reply({ text: '画好了', images: [PNG_BYTES] }), ['sendPhoto']);
            expect(
                json(fallback.session.messageIds) === json([fallback.processingId, ...fallback.telegram.sentIds('sendDocument')]) &&
                    fallback.telegram.sentIds('sendDocument').length === 1,
                `the document stands in for the photo (got ${json(fallback.session.messageIds)})`
            );
        },
    },
    {
        name: 'the context index maps #N to messages and counts their images',
        body: async () => {
            const { buildContext } = await import('../../src/reply/context-builder.js');

            const albumUniqueId = `tools-album-${takeMessageId()}`;
            const albumSubUniqueId = `tools-album-sub-${takeMessageId()}`;
            for (const fileUniqueId of [albumUniqueId, albumSubUniqueId]) {
                await putCachedMedia({ fileUniqueId, data: PNG_BYTES, sizeBytes: PNG_BYTES.length, mime: 'image/png', kind: 'photo' });
            }
            const seed = async (fields: Record<string, unknown>): Promise<number> => {
                const messageId = takeMessageId();
                await Message.create({
                    chatId: OFFLINE_CHAT_ID,
                    messageId,
                    fromBotSelf: false,
                    userId: 1001,
                    date: new Date(messageId * 1000),
                    userName: 'Alice',
                    text: `message ${messageId}`,
                    quoteText: null,
                    file: null,
                    fileMime: null,
                    fileUniqueId: null,
                    replyToId: null,
                    chatCommand: null,
                    modelParts: null,
                    mediaHint: null,
                    forwardOrigin: null,
                    forwardFromId: null,
                    viaBot: null,
                    ocrText: null,
                    ...fields,
                });
                return messageId;
            };

            const album = await seed({ text: '两张猫', fileUniqueId: albumUniqueId, mediaHint: 'a picture' });
            await seed({ replyToId: album, text: `sub image of [${album}]`, fileUniqueId: albumSubUniqueId });
            const botImage = await seed({
                fromBotSelf: true,
                userId: null,
                userName: 'Bot',
                text: '画好了',
                file: PNG_BYTES,
                fileMime: 'image/png',
                replyToId: album,
            });
            const current = await seed({ text: '把刚才那张改成狗', replyToId: botImage });
            const row = await Message.findOne({ where: { chatId: OFFLINE_CHAT_ID, messageId: current } });
            if (!row) throw new Error('seeded message not found');

            const blind = {
                supportsImageInput: false,
                supportsImageOutput: false,
                supportsSystemPrompt: true,
                requiresMessageMerge: false,
                supportsThinking: false,
                supportsGrounding: false,
                supportsMediaInput: false,
            };
            const { contextIndex, messages } = await buildContext(row, { capabilities: blind, model: 'mimo-v2.5-pro' });
            const entries = [...contextIndex.values()].map(
                (entry) => `#${entry.number}:${entry.messageId === album ? 'album' : entry.messageId === botImage ? 'bot' : 'current'}:${entry.fromBot}:${entry.imageCount}`
            );
            expect(
                json(entries) === json(['#1:album:false:2', '#2:bot:true:1', '#3:current:false:0']),
                `numbers, authorship and image counts (got ${json(entries)})`
            );
            expect(
                [...contextIndex.keys()].join(',') === '1,2,3' && contextIndex.get(2)?.number === 2,
                'keyed by the number the model sees'
            );
            expect(
                messages.every((message) => message.content.every((part) => part.type !== 'image')),
                'images are counted even when the model cannot see them'
            );
        },
    },
    {
        name: 'the Gemini image model skips draft images, stores no parts and takes the output knobs',
        body: async () => {
            const { sendMessage } = await import('../../src/ai/platform-factory.js');

            const collect = async (config: { imageOutput?: { aspectRatio?: string; imageSize?: '1K'; instruction?: string } }): Promise<StreamChunk[]> => {
                const { result } = await captureConsole(async () => {
                    const stream = await sendMessage([{ role: 'user', content: [{ type: 'text', text: '画一只猫' }] }], {
                        model: GEMINI_IMAGE_MODEL,
                        maxRetries: 1,
                        ...config,
                    });
                    const chunks: StreamChunk[] = [];
                    for await (const chunk of stream) chunks.push(chunk);
                    return chunks;
                });
                return result;
            };

            const chunks = await collect({
                imageOutput: { aspectRatio: '16:9', imageSize: '1K', instruction: 'Draw exactly what is asked.' },
            });
            const images = chunks.filter((chunk) => chunk.type === 'image');
            expect(
                images.length === 1 && images[0]?.imageData?.equals(FINAL_IMAGE) === true,
                `only the final image is yielded (got ${images.length})`
            );
            expect(images[0]?.imageMimeType === 'image/png', 'with its real mime');
            expect(chunks.some((chunk) => chunk.type === 'thinking'), 'thinking text still streams');

            const done = chunks.find((chunk) => chunk.type === 'done');
            const finished = responseHandler.processChunk(done ?? { type: 'done' }, emptyState(), (text) => text);
            expect(finished.modelParts === undefined, 'no image parts or signature become modelParts');
            const firstCandidate = asRecord(asArray(asRecord(done?.rawResponse).candidates)[0]);
            expect(firstCandidate.finishReason === 'STOP', 'the finish reason survives');

            const knobbed = geminiRequestBodies.at(-1) ?? {};
            const knobbedImageConfig = asRecord(knobbed.generationConfig).imageConfig;
            expect(
                json(knobbedImageConfig) === '{"aspectRatio":"16:9","imageSize":"1K"}',
                `aspect ratio and size reach the request (got ${json(knobbedImageConfig)})`
            );
            const knobbedInstruction = json(knobbed.systemInstruction);
            expect(
                knobbedInstruction.includes('Draw exactly what is asked.') &&
                    !knobbedInstruction.includes('You are an image generation model'),
                `the instruction replaces the default (got ${knobbedInstruction})`
            );

            await collect({});
            const plain = geminiRequestBodies.at(-1) ?? {};
            expect(asRecord(plain.generationConfig).imageConfig === undefined, 'without knobs no imageConfig is sent');
            expect(
                json(plain.systemInstruction).includes('You are an image generation model'),
                'and the default image instruction stays'
            );
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}

await mcp.shutdownMcp();
await Promise.all([closeServer(mcpStub), closeServer(geminiStub)]);
const { sequelize } = await import('../../src/db/config.js');
await sequelize.close();

reportResults(results);
