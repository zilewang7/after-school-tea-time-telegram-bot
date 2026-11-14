/**
 * Offline stand-ins for driving the bot end to end: a real grammY Api (and Bot)
 * whose transformer answers every call locally and records it (or refuses it
 * the way Telegram does, when the test asks for that), contexts for a
 * message or a button press, and a MiMo-shaped chat completions stub that
 * records each request and can hold its answer back.
 *
 * Imports nothing from src, so a test file can import it before
 * setupOfflineDb.
 */
import { Api, Bot, Context, type Transformer } from 'grammy';
import type { Chat, MessageEntity, Update, User, UserFromGetMe } from 'grammy/types';
import type { StubServer } from './support/stub-server.mts';

export interface TelegramCall {
    readonly method: string;
    readonly payload: Readonly<Record<string, unknown>>;
}

export interface FakeTelegram {
    readonly api: Api;
    readonly calls: TelegramCall[];
    readonly callsOf: (method: string) => TelegramCall[];
    /** Forget the calls so far */
    readonly reset: () => void;
}

/** What Telegram answers when it refuses a call; grammY turns it into a GrammyError */
export interface TelegramRefusal {
    readonly error_code: number;
    readonly description: string;
}

export interface FakeTelegramOptions {
    /**
     * Asked for every call after it is recorded: a refusal is answered as
     * `{ ok: false, … }`, null lets the call through
     */
    readonly refuse?: (call: TelegramCall) => TelegramRefusal | null;
}

const SENDING_METHODS: ReadonlySet<string> = new Set(['sendMessage', 'sendPhoto', 'sendDocument', 'sendRichMessage']);
let nextSentMessageId = 500_000;

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : {};

/** Install the answering transformer on an Api; returns the recorder */
const recordInto = (api: Api, options: FakeTelegramOptions = {}): FakeTelegram => {
    const calls: TelegramCall[] = [];
    const answer = async (method: string, payload: unknown) => {
        const fields = asRecord(payload);
        const call: TelegramCall = { method, payload: fields };
        calls.push(call);
        const refusal = options.refuse?.(call) ?? null;
        if (refusal !== null) {
            return { ok: false, error_code: refusal.error_code, description: refusal.description };
        }
        if (!SENDING_METHODS.has(method)) return { ok: true, result: true };
        nextSentMessageId += 1;
        const chatId = typeof fields.chat_id === 'number' ? fields.chat_id : 0;
        return {
            ok: true,
            result: { message_id: nextSentMessageId, date: 0, chat: { id: chatId, type: 'supergroup', title: '测试群' } },
        };
    };
    // The transformer is generic over every method: one cast at this boundary
    const offlineTransformer = (_previous: unknown, method: string, payload: unknown) => answer(method, payload);
    api.config.use(offlineTransformer as Transformer);
    return {
        api,
        calls,
        callsOf: (method) => calls.filter((call) => call.method === method),
        reset: () => {
            calls.length = 0;
        },
    };
};

export const BOT_ME: UserFromGetMe = {
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

export const createFakeTelegram = (options: FakeTelegramOptions = {}): FakeTelegram =>
    recordInto(new Api('0:offline-token'), options);

const refuseBotApiCall: Transformer = (_previous, method) => {
    // The code under test usually catches a failed Bot API call (a tool hands
    // the error to the model, a preview only warns), so the error alone would
    // go unnoticed. The exit code fails the file whatever the caller does.
    console.error(`[offline] unexpected Bot API call: ${method}`);
    process.exitCode = 1;
    throw new Error(`unexpected Bot API call in an offline test: ${method}`);
};

/**
 * A client for a fixture whose code under test is not supposed to call
 * Telegram. A bare `new Api(token)` would send the call to api.telegram.org;
 * this one fails the call on the spot, naming the method, and fails the file.
 */
export const createUnusedApi = (): Api => {
    const api = new Api('0:offline-token');
    api.config.use(refuseBotApiCall);
    return api;
};

/** A Bot that never polls: feed it updates with handleUpdate */
export const createFakeBot = (options: FakeTelegramOptions = {}): { bot: Bot; telegram: FakeTelegram } => {
    const bot = new Bot('0:offline-token', { botInfo: BOT_ME });
    return { bot, telegram: recordInto(bot.api, options) };
};

export const groupChat = (chatId: number): Chat.SupergroupChat => ({ id: chatId, type: 'supergroup', title: '测试群' });

export const userOf = (userId: number): User => ({ id: userId, is_bot: false, first_name: `user-${userId}` });

let nextUpdateId = 1;

/** A text message update; a leading `/command` gets its bot_command entity */
export const messageUpdate = (input: { chatId: number; messageId: number; userId: number; text: string }): Update => {
    const command = /^\/\S+/.exec(input.text)?.[0];
    const entities: MessageEntity[] = command ? [{ type: 'bot_command', offset: 0, length: command.length }] : [];
    return {
        update_id: (nextUpdateId += 1),
        message: {
            message_id: input.messageId,
            date: Math.floor(Date.now() / 1000),
            chat: groupChat(input.chatId),
            from: userOf(input.userId),
            text: input.text,
            ...(entities.length > 0 ? { entities } : {}),
        },
    };
};

/** A button press on a bot message */
export const callbackUpdate = (input: { chatId: number; messageId: number; userId: number; data: string }): Update => ({
    update_id: (nextUpdateId += 1),
    callback_query: {
        id: `offline-callback-${nextUpdateId}`,
        from: userOf(input.userId),
        chat_instance: 'offline',
        data: input.data,
        message: {
            message_id: input.messageId,
            date: 0,
            chat: groupChat(input.chatId),
            from: BOT_ME,
            text: 'bot message',
        },
    },
});

export const contextOf = (update: Update, telegram: FakeTelegram): Context => new Context(update, telegram.api, BOT_ME);

/** The text of the latest answerCallbackQuery, or undefined */
export const lastToastOf = (telegram: FakeTelegram): unknown => telegram.callsOf('answerCallbackQuery').at(-1)?.payload.text;

/** Wait until `condition` holds (or fail after `timeoutMs`) */
export const waitUntil = async (description: string, condition: () => boolean, timeoutMs = 5000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`timed out waiting for ${description}`);
};

/** Run `body` with console output swallowed (the reply pipeline logs a lot) */
export const quietly = async <T,>(body: () => Promise<T>): Promise<T> => {
    const original = { log: console.log, warn: console.warn, error: console.error };
    const lines: string[] = [];
    const record = (...args: unknown[]): void => {
        lines.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
    };
    console.log = record;
    console.warn = record;
    console.error = record;
    try {
        return await body();
    } catch (error) {
        original.error(lines.slice(-20).join('\n'));
        throw error;
    } finally {
        console.log = original.log;
        console.warn = original.warn;
        console.error = original.error;
    }
};

export interface ChatCompletionStub {
    /** Parsed request bodies, in arrival order */
    readonly requests: Record<string, unknown>[];
    /** Hold every answer until the returned function is called */
    readonly hold: () => () => void;
    readonly close: () => Promise<void>;
}

const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

const chunkOf = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
    id: 'offline-chunk',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'offline',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
});

/**
 * Makes `server` an OpenAI-style streaming endpoint (what MiMo speaks). Every
 * request is answered with `replyText` and a normal stop, until close().
 *
 * The server itself is started once per test file (see support/stub-server.mts)
 * because `src` snapshots the endpoint URL at import.
 */
export const startChatCompletionStub = async (server: StubServer, replyText = '好的'): Promise<ChatCompletionStub> => {
    const requests: Record<string, unknown>[] = [];
    let gate: Promise<void> = Promise.resolve();

    server.handle((request, response) => {
        const body: Buffer[] = [];
        request.on('data', (chunk: Buffer) => body.push(chunk));
        request.on('end', () => {
            requests.push(asRecord(JSON.parse(Buffer.concat(body).toString('utf8') || '{}')));
            void gate.then(() => {
                response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                response.end(
                    [
                        sse(chunkOf({ role: 'assistant', content: '' })),
                        sse(chunkOf({ content: replyText })),
                        sse(chunkOf({}, 'stop')),
                        'data: [DONE]\n\n',
                    ].join('')
                );
            });
        });
    });

    return {
        requests,
        hold: () => {
            let release: () => void = () => undefined;
            gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            return () => {
                release();
                gate = Promise.resolve();
            };
        },
        close: async () => {
            server.reset();
        },
    };
};

/** The two timers a reply keeps while it is open */
interface OpenReply {
    readonly typing: { stop(): void };
    readonly editor: { stop(): void };
}

const openReplies: OpenReply[] = [];

/**
 * Remembers a reply a case started (the chat context of `createChatContext`).
 * Many cases drive a reply only part of the way and never reach the code that
 * ends it, which leaves its spinner and typing timers running.
 */
export const trackReply = <Reply extends OpenReply>(reply: Reply): Reply => {
    openReplies.push(reply);
    return reply;
};

/** Stops the timers of every tracked reply; call before `reportResults`, or they keep the file running */
export const endOpenReplies = (): void => {
    // `editor` is read here, not when the reply was tracked: a continuation replaces it
    for (const reply of openReplies.splice(0)) {
        reply.typing.stop();
        reply.editor.stop();
    }
};

/** The system prompt of a recorded chat completions request */
export const systemPromptOf = (body: Record<string, unknown>): string => {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const system = messages.map(asRecord).find((message) => message.role === 'system');
    return typeof system?.content === 'string' ? system.content : '';
};
