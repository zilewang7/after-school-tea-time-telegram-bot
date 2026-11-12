/**
 * The bench of the "继续" cases (design 2026-1112-1123 §6, §11 第 3 期): the
 * real chat, retry and continue handlers on a fake Bot API, the real Gemini
 * platform on the fake Vertex endpoint, the real reply tools, a local MCP
 * server whose tools stand in for side effects, a local luoxu archive, and
 * the scratch database.
 *
 * Wiring is production's: menuLoad sets the retry handler, replyLoad the
 * continue handler, and every button press goes through bot.handleUpdate.
 * A question goes straight to handleReply (the bot's own message handler
 * would batch mentions).
 *
 * Nothing from src is imported at the top: createResumeBench() sets the env,
 * prepares the scratch database and only then imports src.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context, type Transformer } from 'grammy';
import type { Update } from 'grammy/types';
import { setupOfflineDb, takeMessageId } from '../harness.mts';
import { BOT_ME, callbackUpdate, createFakeBot, messageUpdate, waitUntil, type FakeTelegram } from '../fake-telegram.mts';
import {
    createFakeVertex,
    httpErrorReply,
    sseReply,
    stalledStreamReply,
    type FakeVertex,
    type RecordedRequest,
    type ScriptedReply,
} from './fake-vertex.mts';
import { callPart, event, roundEvents, textPart, thoughtPart, type ScriptedCall } from './gemini-loop-fixtures.mts';
import { scratchDirectoryOf } from './scratch-directory.mts';
import type { PlatformConfig, StreamChunk, UnifiedMessage } from '../../../src/ai/types.js';

export const RESUME_MODEL = 'gemini-4-carbon';
/** Full tier: a positive TOOL_CHAT_IDS entry */
export const FULL_USER_ID = 5150;
export const TRIAL_USER_ID = 6262;
export const OWNER_USER_ID = 4242;
/** The group of the luoxu fixture: its hits belong to this chat */
export const HISTORY_CHAT_ID = -1002311128579;

const CHAT_POOL: readonly number[] = Array.from({ length: 60 }, (_unused, index) => -1007600000001 - index);
let nextChat = 0;
/** A chat of its own for each case: replies, settings and exclusions never meet */
export const takeChatId = (): number => {
    const chatId = CHAT_POOL[nextChat];
    nextChat += 1;
    if (chatId === undefined) throw new Error('the bench ran out of chats');
    return chatId;
};

export const json = (value: unknown): string => JSON.stringify(value);

export const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : {};

export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

// ---------------------------------------------------------------------------
// Local servers: an MCP server and a luoxu archive
// ---------------------------------------------------------------------------

export interface McpCall {
    readonly name: string;
    readonly args: Record<string, unknown>;
}

const MCP_TOOLS = [
    {
        name: 'notify_owner',
        description: 'Stands in for send_sms_to_owner: tells the owner something, once',
        inputSchema: { type: 'object', properties: { content: { type: 'string' } } },
    },
    {
        name: 'slow_lookup',
        description: 'A lookup that takes its time',
        inputSchema: { type: 'object', properties: { topic: { type: 'string' } } },
    },
    {
        name: 'web_lookup',
        description: 'Searches the web',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    },
];

interface McpStub {
    readonly server: Server;
    readonly calls: McpCall[];
    /** End the held slow_lookup answers (they never answer on their own) */
    readonly releaseHeld: () => void;
}

const readBody = (request: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });

const startMcpStub = (): McpStub => {
    const calls: McpCall[] = [];
    const held: ServerResponse[] = [];
    const answer = (response: ServerResponse, id: unknown, result: object): void => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    };
    const releaseHeld = (): void => {
        for (const response of held.splice(0)) {
            if (!response.writableEnded) response.end();
        }
    };
    const server = createServer((request, response) => {
        if (request.method !== 'POST') {
            response.writeHead(405).end();
            return;
        }
        void readBody(request).then((body) => {
            const message = asRecord(JSON.parse(body || '{}'));
            const method = String(message.method);
            // A notification has no id; a cancelled call leaves its answer unwanted
            if (message.id === undefined) {
                if (method === 'notifications/cancelled') releaseHeld();
                response.writeHead(202).end();
                return;
            }
            const params = asRecord(message.params);
            if (method === 'initialize') {
                answer(response, message.id, {
                    protocolVersion: params.protocolVersion,
                    capabilities: { tools: {} },
                    serverInfo: { name: 'resume-stub', version: '1.0.0' },
                });
                return;
            }
            if (method === 'tools/list') {
                answer(response, message.id, { tools: MCP_TOOLS });
                return;
            }
            const name = String(params.name);
            const args = asRecord(params.arguments);
            calls.push({ name, args });
            if (name === 'slow_lookup') {
                held.push(response);
                return;
            }
            const text =
                name === 'web_lookup'
                    ? `Found [${String(args.query)} page](https://example.test/${encodeURIComponent(String(args.query))})`
                    : 'delivered to the owner';
            answer(response, message.id, { content: [{ type: 'text', text }] });
        });
    });
    return { server, calls, releaseHeld };
};

const LUOXU_FIXTURE = readFileSync(
    fileURLToPath(new URL('../fixtures/luoxu-search-2006.json', import.meta.url)),
    'utf8'
);

interface LuoxuStub {
    readonly server: Server;
    /** Paths asked for, query included */
    readonly requests: string[];
}

/** /search answers with the fixture, /messages and /stats with nothing */
const startLuoxuStub = (): LuoxuStub => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
        const path = request.url ?? '/';
        requests.push(path);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        if (path.startsWith('/search')) {
            response.end(LUOXU_FIXTURE);
        } else if (path.startsWith('/stats')) {
            response.end(JSON.stringify({ groups: [] }));
        } else {
            response.end(JSON.stringify({ messages: [] }));
        }
    });
    return { server, requests };
};

const listen = async (server: Server): Promise<string> => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('a stub has no TCP port');
    return `http://127.0.0.1:${address.port}`;
};

const closeServer = async (server: Server): Promise<void> => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlZkAAAAASUVORK5CYII=',
    'base64'
);
const WEBP_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBPVP8 offline webp')]);

/** What the image model answers: one picture */
export const imageReply = (): ScriptedReply => ({
    status: 200,
    contentType: 'text/event-stream',
    body: `data: ${JSON.stringify({
        candidates: [
            {
                content: { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: PNG_BYTES.toString('base64') } }] },
                finishReason: 'STOP',
            },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1290, totalTokenCount: 1300 },
    })}\n\n`,
});

export const BAD_REQUEST = 'Request contains an invalid argument.';

/** A round that fails at once and is not retried: the reply ends in an error */
export const failingRound = (): ScriptedReply => httpErrorReply(400, BAD_REQUEST);

export interface RoundScript {
    readonly label: string;
    readonly thinking?: readonly string[];
    readonly text?: readonly string[];
    readonly calls?: readonly ScriptedCall[];
    readonly grounding?: Record<string, unknown>;
}

/** One model round: its thinking chunks, then its text chunks, then its calls in one chunk */
export const roundOf = (script: RoundScript, onServe?: () => void): ScriptedReply =>
    sseReply(
        roundEvents(
            [
                ...(script.thinking ?? []).map((thinking) => [thoughtPart(thinking)]),
                ...(script.text ?? []).map((text) => [textPart(text)]),
                ...((script.calls ?? []).length > 0
                    ? [
                          (script.calls ?? []).map((call, index) =>
                              callPart(call.name, call.args ?? {}, `${script.label}-${index}`, `call_${script.label}_${index}`)
                          ),
                      ]
                    : []),
            ],
            script.grounding === undefined ? {} : { grounding: script.grounding }
        ),
        onServe
    );

export const webLookup = (query: string): ScriptedCall => ({ name: 'web_lookup', args: { query } });

/** A round whose stream starts and then hangs until the reply is stopped */
export const stalledRound = (thinking: string, text: string): ScriptedReply =>
    stalledStreamReply([event([thoughtPart(thinking)]), event([textPart(text)])]);

export interface FunctionAnswer {
    readonly name: string;
    readonly output?: string;
    readonly error?: string;
}

/** Every function response a request sends, in order */
export const answersIn = (request: RecordedRequest | undefined): FunctionAnswer[] =>
    asArray(request?.body.contents)
        .flatMap((content) => asArray(asRecord(content).parts))
        .map((part) => asRecord(asRecord(part).functionResponse))
        .filter((functionResponse) => typeof functionResponse.name === 'string')
        .map((functionResponse) => {
            const response = asRecord(functionResponse.response);
            return {
                name: String(functionResponse.name),
                ...(typeof response.output === 'string' ? { output: response.output } : {}),
                ...(typeof response.error === 'string' ? { error: response.error } : {}),
            };
        });

/** The function responses' texts of a request, output or error */
export const answerTexts = (request: RecordedRequest | undefined): string[] =>
    answersIn(request).map((item) => item.output ?? item.error ?? '');

// ---------------------------------------------------------------------------
// The bench
// ---------------------------------------------------------------------------

export interface AskedReply {
    readonly chatId: number;
    readonly userMessageId: number;
    readonly firstMessageId: number;
}

export interface Gate {
    readonly opened: Promise<void>;
    readonly open: () => void;
}

export const gate = (): Gate => {
    let open: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => {
        open = resolve;
    });
    return { opened, open };
};

/** One hook into the fake Bot API: a method to hold or fail, by a test of its payload */
export interface TelegramHook {
    readonly method: string;
    readonly when: (payload: Record<string, unknown>) => boolean;
    /** Hold the call until this opens, then answer it as usual */
    readonly holdUntil?: Promise<void>;
    /** Fail the call */
    readonly fail?: boolean;
    /** Runs when the hook catches its call (once) */
    readonly onCaught?: () => Promise<void> | void;
}

export const createResumeBench = async () => {
    const mcpStub = startMcpStub();
    const luoxuStub = startLuoxuStub();
    const mcpUrl = await listen(mcpStub.server);
    const luoxuUrl = await listen(luoxuStub.server);

    const toolChats = [...CHAT_POOL, HISTORY_CHAT_ID, FULL_USER_ID];
    Object.assign(process.env, {
        DEFAULT_MODEL: RESUME_MODEL,
        BOT_USER_NAME: 'AfterSchoolTeatimeBot',
        BOT_USER_ID: '7777',
        OWNER_USER_ID: String(OWNER_USER_ID),
        TOOL_CHAT_IDS: toolChats.join(','),
        HISTORY_CHAT_IDS: String(HISTORY_CHAT_ID),
        LUOXU_PREVIEW_URL: luoxuUrl,
        STICKER_SET_NAME: 'ColorfulHachimi',
        WIDGET_ENABLE: '1',
        WIDGET_ALLOW_HTML: '1',
        WIDGET_GROUP_FALLBACK: '1',
        WIDGET_RENDER_URL: '',
        WORKSPACE_ENABLE: '1',
        WEBAPP_PUBLIC_URL: 'https://miniapp.test',
        WEBAPP_BOT_SHORT_NAME: 'panel',
        MCP_SERVERS: JSON.stringify({ stub: { serverUrl: `${mcpUrl}/mcp` } }),
    });
    delete process.env.GEMINI_CLIENT_TOOLS;
    delete process.env.THINKING_LINK;
    delete process.env.IMAGE_SEARCH_URL;

    await setupOfflineDb();
    const dbIndex = await import('../../../src/db/index.js');
    const { getPlatform } = await import('../../../src/ai/platform-factory.js');
    const { GeminiPlatform } = await import('../../../src/ai/platforms/gemini-platform.js');
    const { handleReply } = await import('../../../src/reply/chat-handler.js');
    const { menuLoad } = await import('../../../src/cmd/menu.js');
    const { replyLoad } = await import('../../../src/reply/loader.js');
    const { autoUpdate } = await import('../../../src/db/autoSave.js');
    const mcp = await import('../../../src/ai/mcp/index.js');
    const { STICKER_CATALOG } = await import('../../../src/services/sticker-catalog.js');
    const { checkpointRegistry } = await import('../../../src/reply/resume/checkpoint-registry.js');
    const state = await import('../../../src/state.js');
    const { findReplyMetricsByReply } = await import('../../../src/db/queries/reply-metrics.js');
    const { sequelize } = await import('../../../src/db/config.js');
    await mcp.initMcpClients();

    // ---- the model: the real Gemini platform on the fake Vertex endpoint ----

    const vertex: FakeVertex = createFakeVertex();
    /** Waits return at once, or (holdWaits) only when the request is stopped */
    class BenchGeminiPlatform extends GeminiPlatform {
        holdWaits = false;
        readonly waits: number[] = [];

        protected override sleep(ms: number, signal?: AbortSignal): Promise<void> {
            this.waits.push(ms);
            if (signal?.aborted) return Promise.reject(new Error('Aborted'));
            if (!this.holdWaits) return Promise.resolve();
            return new Promise<void>((_resolve, reject) => {
                signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
            });
        }
    }
    const gemini = new BenchGeminiPlatform({ client: vertex.client, random: () => 0.5 });
    const platform = getPlatform(RESUME_MODEL);
    /** Every sendMessage config the platform was handed, in order */
    const configs: PlatformConfig[] = [];
    platform.sendMessage = (messages: UnifiedMessage[], config: PlatformConfig): Promise<AsyncIterable<StreamChunk>> => {
        configs.push(config);
        return gemini.sendMessage(messages, config);
    };

    // ---- Telegram: one Bot whose API answers locally ----

    const { bot, telegram } = createFakeBot();
    let nextOwnMessageId = 700_000;
    const stickerFile = join(scratchDirectoryOf(process.pid), 'resume-sticker.webp');
    writeFileSync(stickerFile, WEBP_BYTES);
    const hooks: TelegramHook[] = [];

    /** What the fake answers for the calls the recorder cannot: the sticker pack, its file, a sent sticker */
    const answerOf = (method: string, fields: Record<string, unknown>): { ok: true; result: unknown } | null => {
        if (method === 'getStickerSet') {
            return {
                ok: true,
                result: {
                    stickers: STICKER_CATALOG.map((entry) => ({
                        file_id: `file-${entry.packIndex}`,
                        file_unique_id: entry.fileUniqueId,
                        thumbnail: { file_id: `thumb-${entry.packIndex}` },
                    })),
                },
            };
        }
        if (method === 'getFile') return { ok: true, result: { file_path: stickerFile } };
        if (method !== 'sendSticker') return null;
        nextOwnMessageId += 1;
        return {
            ok: true,
            result: { message_id: nextOwnMessageId, date: 0, chat: { id: fields.chat_id, type: 'supergroup', title: '测试群' } },
        };
    };

    // Installed after the recorder, so it runs first: every call is still recorded
    const benchAnswers: Transformer = async (previous, method, payload, signal) => {
        const fields = asRecord(payload);
        const hookIndex = hooks.findIndex((hook) => hook.method === method && hook.when(fields));
        const hook = hookIndex === -1 ? undefined : hooks.splice(hookIndex, 1)[0];
        if (hook !== undefined) {
            await hook.onCaught?.();
            if (hook.holdUntil !== undefined) await hook.holdUntil;
            if (hook.fail === true) throw new Error(`offline: ${method} failed on purpose`);
        }
        const recorded = await previous(method, payload, signal);
        const answer = answerOf(method, fields);
        // The recorder's answer is a fresh object per call; filling it in keeps its type
        return answer === null ? recorded : Object.assign(recorded, answer);
    };
    bot.api.config.use(benchAnswers);

    menuLoad(bot);
    replyLoad(bot);
    autoUpdate(bot);

    // ---- driving ----

    /** Store a question and run the whole reply to it (it may be stopped meanwhile) */
    const ask = async (
        chatId: number,
        text: string,
        options: { readonly userId?: number; readonly replyToId?: number } = {}
    ): Promise<AskedReply> => {
        const userId = options.userId ?? FULL_USER_ID;
        const userMessageId = takeMessageId();
        await dbIndex.saveMessage({
            chatId,
            messageId: userMessageId,
            userId,
            date: new Date(),
            userName: `user-${userId}`,
            message: text,
            ...(options.replyToId === undefined ? {} : { replyToId: options.replyToId }),
        });
        const update: Update = messageUpdate({ chatId, messageId: userMessageId, userId, text });
        await handleReply(new Context(update, bot.api, BOT_ME), { mention: true });
        const response = await dbIndex.BotResponse.findOne({ where: { chatId, userMessageId } });
        if (!response) throw new Error('the reply was not recorded');
        return { chatId, userMessageId, firstMessageId: response.messageId };
    };

    /** A question whose reply runs in the background, for cases that press stop meanwhile */
    const askInBackground = (
        chatId: number,
        text: string,
        options: { readonly userId?: number } = {}
    ): { readonly done: Promise<AskedReply> } => ({
        done: ask(chatId, text, options),
    });

    /**
     * A 继续 click works off the update loop. It has been handled once its
     * claim is free again (a notice, a gone checkpoint, a failed answer), or
     * once it has answered and taken the checkpoint: from there the resumed
     * reply runs on, and `settled` waits for its end.
     */
    const continueClickHandled = (reply: { readonly chatId: number; readonly firstMessageId: number }): boolean =>
        !state.isReplyRerunClaimed(reply.chatId, reply.firstMessageId) ||
        (toasts().includes('继续中...') && checkpointRegistry.peek(reply.chatId, reply.firstMessageId) === undefined);

    /** The update handler alone: it returns as Telegram's next update could be taken */
    const deliverPress = (
        reply: { readonly chatId: number; readonly firstMessageId: number },
        data: string,
        userId: number = FULL_USER_ID
    ): Promise<void> =>
        bot.handleUpdate(callbackUpdate({ chatId: reply.chatId, messageId: reply.firstMessageId, userId, data }));

    /** A button press as Telegram delivers it; what the handler threw comes back */
    const press = async (
        reply: { readonly chatId: number; readonly firstMessageId: number },
        data: string,
        userId: number = FULL_USER_ID
    ): Promise<unknown> => {
        try {
            await deliverPress(reply, data, userId);
            if (data === 'resp:continue') {
                // Counted in turns, not by the clock: some cases move Date.now
                for (let turn = 0; turn < 1500 && !continueClickHandled(reply); turn += 1) {
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
                if (!continueClickHandled(reply)) throw new Error('the 继续 click was never handled');
            }
            return null;
        } catch (error) {
            return error;
        }
    };

    /** The resume or retry a press started has ended (its claim is free again) */
    const settled = async (reply: AskedReply, description = 'the rerun to end'): Promise<void> => {
        await waitUntil(description, () => !state.isReplyRerunClaimed(reply.chatId, reply.firstMessageId), 15_000);
    };

    /** Press 继续 and wait for the resumed reply to end */
    const continueReply = async (reply: AskedReply, userId: number = FULL_USER_ID): Promise<unknown> => {
        const thrown = await press(reply, 'resp:continue', userId);
        await settled(reply, 'the resumed reply to end');
        return thrown;
    };

    const retryReply = async (reply: AskedReply, userId: number = FULL_USER_ID): Promise<unknown> => {
        const thrown = await press(reply, 'resp:retry', userId);
        // The retry is detached: wait for its claim, then for it to be free again
        await new Promise((resolve) => setTimeout(resolve, 20));
        await settled(reply, 'the retry to end');
        return thrown;
    };

    const stored = async (reply: AskedReply) => {
        const response = await dbIndex.getBotResponse(reply.chatId, reply.firstMessageId);
        if (!response) throw new Error('no stored reply');
        return response;
    };

    const latestVersion = async (reply: AskedReply) => {
        const version = (await stored(reply)).getVersions().at(-1);
        if (!version) throw new Error('the reply has no version');
        return version;
    };

    /** The reply of a chat's only question, as soon as its session exists */
    const runningReplyOf = async (chatId: number): Promise<AskedReply> => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            const response = await dbIndex.BotResponse.findOne({ where: { chatId } });
            if (response) return { chatId, userMessageId: response.userMessageId, firstMessageId: response.messageId };
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error('no running reply');
    };

    const stopReply = async (reply: AskedReply): Promise<void> => {
        const thrown = await press(reply, 'resp:stop');
        if (thrown !== null) throw new Error(`the stop click threw: ${String(thrown)}`);
    };

    /** A reply that ran round 1 as scripted and failed at round 2: its checkpoint keeps one round */
    const failedAfterRound1 = async (
        round1: RoundScript,
        options: { readonly chatId?: number; readonly question?: string; readonly userId?: number; readonly replyToId?: number } = {}
    ): Promise<AskedReply> => {
        vertex.reset([roundOf(round1), failingRound()]);
        telegram.reset();
        const reply = await ask(options.chatId ?? takeChatId(), options.question ?? '@AfterSchoolTeatimeBot 查一下', options);
        const kept = checkpointRegistry.peek(reply.chatId, reply.firstMessageId);
        if (kept?.loop.completedRounds !== 1) {
            throw new Error(`the failed reply kept no round-1 checkpoint (got ${json(kept?.loop.completedRounds)})`);
        }
        return reply;
    };

    const toasts = (): string[] =>
        telegram.callsOf('answerCallbackQuery').map((call) => String(call.payload.text ?? ''));

    const close = async (): Promise<void> => {
        mcpStub.releaseHeld();
        await mcp.shutdownMcp();
        await closeServer(mcpStub.server);
        await closeServer(luoxuStub.server);
        await sequelize.close();
    };

    return {
        bot,
        telegram,
        vertex,
        gemini,
        configs,
        mcpCalls: mcpStub.calls,
        releaseHeldMcpCalls: mcpStub.releaseHeld,
        luoxuRequests: luoxuStub.requests,
        hooks,
        dbIndex,
        state,
        registry: checkpointRegistry,
        rowsOf: (reply: AskedReply) => findReplyMetricsByReply(reply.chatId, reply.firstMessageId),
        entryOf: (reply: AskedReply) => checkpointRegistry.peek(reply.chatId, reply.firstMessageId),
        markOf: (reply: AskedReply) => state.resumableMarkOf(reply.chatId, reply.firstMessageId),
        ask,
        askInBackground,
        failedAfterRound1,
        runningReplyOf,
        stopReply,
        press,
        deliverPress,
        settled,
        continueReply,
        retryReply,
        stored,
        latestVersion,
        toasts,
        close,
    };
};

export type ResumeBench = Awaited<ReturnType<typeof createResumeBench>>;

// ---------------------------------------------------------------------------
// Reading what happened
// ---------------------------------------------------------------------------

/** The labels of a reply_markup, or null when the call carried none */
export const keyboardLabels = (markup: unknown): string[] | null => {
    const rows: unknown = asRecord(markup).inline_keyboard;
    if (!Array.isArray(rows)) return null;
    return rows.flat().map((button: unknown) => String(asRecord(button).text));
};

/** The buttons the reply was left with: the last call that carried any */
export const finalButtonsOf = (telegram: FakeTelegram): string[] => {
    for (const call of [...telegram.calls].reverse()) {
        const labels = keyboardLabels(call.payload.reply_markup);
        if (labels !== null) return labels;
    }
    return [];
};

/** Calls that change what the chat shows */
export const visibleEditsOf = (telegram: FakeTelegram): string[] =>
    telegram.calls
        .map((call) => call.method)
        .filter((method) =>
            ['editMessageText', 'editMessageReplyMarkup', 'sendMessage', 'deleteMessage', 'sendPhoto', 'sendDocument', 'sendSticker'].includes(method)
        );

/** Console output of a case, kept instead of printed; shown when the case fails */
export interface CaseLog {
    readonly lines: string[];
    readonly has: (text: string) => boolean;
    readonly matching: (text: string) => string[];
}

const lineOf = (args: readonly unknown[]): string =>
    args.map((arg) => (arg instanceof Error ? arg.message : typeof arg === 'string' ? arg : json(arg))).join(' ');

/** Runs a case body with the console captured; on failure the tail is printed to stderr */
export const quietCase = (body: (log: CaseLog) => Promise<void>) => async (): Promise<void> => {
    const lines: string[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    const record = (...args: unknown[]): void => {
        lines.push(lineOf(args));
    };
    console.log = record;
    console.warn = record;
    console.error = record;
    const log: CaseLog = {
        lines,
        has: (text) => lines.some((line) => line.includes(text)),
        matching: (text) => lines.filter((line) => line.includes(text)),
    };
    try {
        await body(log);
    } catch (error) {
        Object.assign(console, original);
        process.stderr.write(`${lines.slice(-40).join('\n')}\n`);
        throw error;
    } finally {
        Object.assign(console, original);
    }
};
