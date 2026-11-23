/**
 * Offline cases for /picgrok moved from its own bot.command onto the reply
 * pipeline (design 2026-1123-0835): the command parses like /picbanana and
 * /picgpt, routes through chat-handler, generates one xAI picture (a local
 * loopback stub answers the OpenAI-compatible images API, no network), delivers
 * it through sendFinalResponse (placeholder replaced, stored version/message
 * row, context entry, reply metrics), turns a failure into the readable terminal
 * state with a retry button, retries from the original prompt, and keeps the
 * trial refusals.
 *
 * Run: npx tsx scripts/offline/picgrok.mts (or pnpm test:offline picgrok)
 */
import type { Update } from 'grammy/types';
import type { BotResponse as StoredBotResponse } from '../../src/db/botResponseDTO.js';
import {
    expect,
    reportResults,
    runCase,
    setupOfflineDb,
    takeMessageId,
    type CaseResult,
} from './harness.mts';
import {
    callbackUpdate,
    contextOf,
    createFakeBot,
    createFakeTelegram,
    endOpenReplies,
    messageUpdate,
    quietly,
    type FakeTelegram,
    type TelegramCall,
} from './fake-telegram.mts';
import { startStubServer } from './support/stub-server.mts';

const FULL_USER_ID = 5150;
const TRIAL_USER_ID = 6161;
const OWNER_ID = 4242;
const BOT_USER_ID = 7777;
const GROUP_CHAT_ID = -1005200000100;

process.env.BOT_USER_ID = String(BOT_USER_ID);
process.env.BOT_NAME = 'OfflineBot';
process.env.BOT_USER_NAME = 'AfterSchoolTeatimeBot';
process.env.OWNER_USER_ID = String(OWNER_ID);
process.env.DEFAULT_MODEL = 'gemini-4-argon';
// Tiering is off in the harness by default; the routing cases need the real tiers.
process.env.ACCESS_TIERS = '1';
// A positive entry is an explicitly full user; no group entries, so a stranger is trial
process.env.TOOL_CHAT_IDS = String(FULL_USER_ID);
delete process.env.ACCESS_GROUP_IDS;
delete process.env.WEBAPP_PUBLIC_URL;

const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlZkAAAAASUVORK5CYII=',
    'base64'
);
const PNG_BASE64 = PNG_BYTES.toString('base64');

// ---- the xAI stub: POST /v1/images/generations, GET /result.png ----
type StubMode = 'url' | 'b64' | 'error' | 'empty';
let stubMode: StubMode = 'url';
const stubRequests: { path: string; body: Record<string, unknown> }[] = [];

const stub = await startStubServer();
stub.handle((request, response) => {
    const path = new URL(request.url ?? '/', 'http://stub').pathname;
    if (request.method === 'GET' && path === '/result.png') {
        response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(PNG_BYTES.length) });
        response.end(PNG_BYTES);
        return;
    }
    const parts: Buffer[] = [];
    request.on('data', (part: Buffer) => parts.push(part));
    request.on('end', () => {
        const raw = Buffer.concat(parts).toString('utf8');
        const body: Record<string, unknown> = raw.startsWith('{')
            ? Object.fromEntries(Object.entries(JSON.parse(raw)))
            : {};
        stubRequests.push({ path, body });
        if (request.method !== 'POST' || path !== '/v1/images/generations') {
            response.writeHead(404, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ error: { message: `unexpected ${request.method} ${path}` } }));
            return;
        }
        if (stubMode === 'error') {
            response.writeHead(500, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ error: { message: 'offline upstream exploded', type: 'server_error' } }));
            return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        if (stubMode === 'empty') {
            response.end(JSON.stringify({ created: 0, data: [] }));
            return;
        }
        const item =
            stubMode === 'b64'
                ? { b64_json: PNG_BASE64 }
                : { url: `${stub.url}/result.png` };
        response.end(JSON.stringify({ created: 0, data: [item] }));
    });
});

// Read when the client is first built (lazily, inside the handler)
process.env.GROK_API_URL = `${stub.url}/v1`;
process.env.GROK_API_KEY = 'offline-stub';

const dbIndex = await setupOfflineDb();
const { BotResponse } = await import('../../src/db/botResponseDTO.js');
const { findReplyMetricsByReply } = await import('../../src/db/queries/reply-metrics.js');
const { findBotReplyBodyMessageIds } = await import('../../src/db/queries/bot-reply-body-queries.js');
const { checkPicgrokCommand, handlePicgrokCommand } = await import(
    '../../src/reply/commands/picgrok-handler.js'
);
const { handleRetryRequest } = await import('../../src/reply/retry-handler.js');
const { registerChatHandler } = await import('../../src/reply/chat-handler.js');
const { listActiveSessions, stopResponse } = await import('../../src/services/bot-message-service.js');
const { TRIAL_COMMAND_REFUSAL_TEXT } = await import('../../src/reply/commands/trial-refusal.js');
const { GROK_IMAGE_MODEL } = await import('../../src/config/models.js');

const results: CaseResult[] = [];
const json = (value: unknown): string => JSON.stringify(value);

const fieldsOf = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : {};

/** One string field of a recorded payload (requests and stubs both use JSON objects) */
const stringFieldOf = (record: Record<string, unknown> | undefined, key: string): string | null => {
    const value = record?.[key];
    return typeof value === 'string' ? value : null;
};

const textOf = (call: TelegramCall | undefined): string =>
    typeof call?.payload.text === 'string' ? call.payload.text : '';

const callsOf = (telegram: FakeTelegram, method: string): TelegramCall[] =>
    telegram.callsOf(method);

const replyToOf = (call: TelegramCall | undefined): number | undefined => {
    const replyParameters = fieldsOf(call?.payload.reply_parameters);
    return typeof replyParameters.message_id === 'number' ? replyParameters.message_id : undefined;
};

/** Poll an async read until it answers; the routed paths finish in a detached task */
const waitForValue = async <T,>(
    description: string,
    read: () => Promise<T | null>,
    timeoutMs = 10_000
): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await read();
        if (value !== null) return value;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`timed out waiting for ${description}`);
};

/** An incoming command message as autoSave would have stored it */
const seedCommandMessage = async (chatId: number, userId: number, text: string): Promise<number> => {
    const messageId = takeMessageId();
    await dbIndex.saveMessage({
        chatId,
        messageId,
        userId,
        date: new Date(),
        userName: '测试用户',
        message: text,
    });
    return messageId;
};

/** A caption update: the command typed under a photo */
const captionUpdate = (input: {
    chatId: number;
    messageId: number;
    userId: number;
    caption: string;
}): Update => {
    const update = messageUpdate({ ...input, text: '' });
    if (update.message === undefined) throw new Error('the update carries no message');
    return { ...update, message: { ...update.message, text: undefined, caption: input.caption } };
};

const versionOf = (response: StoredBotResponse, index: number) => response.getVersions()[index];

interface CommandRun {
    readonly userMessageId: number;
    readonly telegram: FakeTelegram;
    readonly response: StoredBotResponse;
}

/** Run the command through its own entry point (no routing) and return the recorded reply */
const runCommand = async (input: {
    chatId: number;
    userId: number;
    prompt: string;
    mode: StubMode;
}): Promise<CommandRun> => {
    stubMode = input.mode;
    const text = `/picgrok ${input.prompt}`;
    const userMessageId = await seedCommandMessage(input.chatId, input.userId, text);
    const telegram = createFakeTelegram();
    const ctx = contextOf(
        messageUpdate({ chatId: input.chatId, messageId: userMessageId, userId: input.userId, text }),
        telegram
    );
    const [mention, data] = await checkPicgrokCommand(ctx);
    expect(mention === true, 'the command is recognized');
    if (!data) throw new Error('the command carried no prompt');
    await quietly(() => handlePicgrokCommand(ctx, data, 'full'));
    const response = await BotResponse.findOne({ where: { chatId: input.chatId, userMessageId } });
    if (response === null) throw new Error('the reply was not stored');
    return { userMessageId, telegram, response };
};

results.push(
    await runCase('the command parses like the other image commands (mention, caption, empty prompt)', async () => {
        const chatId = GROUP_CHAT_ID - 1;
        const telegram = createFakeTelegram();

        const plainId = takeMessageId();
        const plain = contextOf(
            messageUpdate({ chatId, messageId: plainId, userId: FULL_USER_ID, text: '/picgrok 一只戴墨镜的猫' }),
            telegram
        );
        const [plainMention, plainData] = await checkPicgrokCommand(plain);
        expect(
            plainMention === true && plainData?.prompt === '一只戴墨镜的猫',
            `the prompt is extracted (got ${json(plainData)})`
        );

        const mentionId = takeMessageId();
        const mentioned = contextOf(
            messageUpdate({
                chatId,
                messageId: mentionId,
                userId: FULL_USER_ID,
                text: '/picgrok@AfterSchoolTeatimeBot 猫',
            }),
            telegram
        );
        const [, mentionedData] = await checkPicgrokCommand(mentioned);
        expect(mentionedData?.prompt === '猫', `the mention suffix is stripped (got ${json(mentionedData)})`);

        const captionId = takeMessageId();
        const caption = contextOf(
            captionUpdate({ chatId, messageId: captionId, userId: FULL_USER_ID, caption: '/picgrok 打伞的猫' }),
            telegram
        );
        const [, captionData] = await checkPicgrokCommand(caption);
        expect(captionData?.prompt === '打伞的猫', `a caption command works (got ${json(captionData)})`);

        telegram.reset();
        const emptyId = takeMessageId();
        const empty = contextOf(
            messageUpdate({ chatId, messageId: emptyId, userId: FULL_USER_ID, text: '/picgrok' }),
            telegram
        );
        const emptyResult = await checkPicgrokCommand(empty);
        expect(emptyResult[0] === false && emptyResult[1] === undefined, 'an empty prompt is not a generation');
        expect(
            callsOf(telegram, 'sendMessage').some((call) => textOf(call) === '请输入图片描述'),
            `it answers 请输入图片描述 (got ${json(callsOf(telegram, 'sendMessage').map(textOf))})`
        );

        const otherId = takeMessageId();
        const other = contextOf(
            messageUpdate({ chatId, messageId: otherId, userId: FULL_USER_ID, text: '/picbanana 猫' }),
            telegram
        );
        const otherResult = await checkPicgrokCommand(other);
        expect(otherResult[0] === undefined && otherResult[1] === undefined, 'another command is left to its handler');
    })
);

results.push(
    await runCase('a successful /picgrok: the picture is delivered as a reply with a stored version and metrics', async () => {
        const chatId = GROUP_CHAT_ID - 10;
        const { userMessageId, telegram, response } = await runCommand({
            chatId,
            userId: FULL_USER_ID,
            prompt: '一只戴墨镜的猫',
            mode: 'url',
        });

        const generation = stubRequests.filter((entry) => entry.path === '/v1/images/generations').at(-1);
        expect(
            stringFieldOf(generation?.body, 'model') === GROK_IMAGE_MODEL &&
                stringFieldOf(generation?.body, 'prompt') === '一只戴墨镜的猫',
            `the images request names the model and prompt (got ${json(generation?.body)})`
        );

        const photos = callsOf(telegram, 'sendPhoto');
        expect(photos.length === 1, `one picture message (got ${photos.length})`);
        expect(replyToOf(photos[0]) === userMessageId, 'the picture answers the command message');
        expect(
            callsOf(telegram, 'deleteMessage').some((call) => Number(call.payload.message_id) === response.messageId),
            'the processing placeholder was deleted'
        );

        const metadata = response.getMetadata();
        expect(
            metadata.commandType === 'picgrok' && metadata.model === GROK_IMAGE_MODEL,
            `the metadata (got ${json(metadata)})`
        );
        const version = versionOf(response, 0);
        expect(
            version !== undefined && version.messageIds.length === 1,
            `one message in the version (got ${json(version?.messageIds)})`
        );
        const pictureMessageId = version?.messageIds[0];
        expect(
            pictureMessageId !== undefined && pictureMessageId !== response.messageId,
            'the version names the picture message'
        );
        expect(
            typeof version?.imageBase64 === 'string' && version.imageBase64.length > 0,
            'the version keeps the picture for replays and the next context'
        );

        const bodyIds = await findBotReplyBodyMessageIds(chatId, [response.messageId]);
        expect(
            bodyIds.get(response.messageId) === pictureMessageId,
            `a #N or reaction lands on the picture message (got ${json([...bodyIds])})`
        );

        const row = await dbIndex.Message.findOne({ where: { chatId, messageId: response.messageId } });
        expect(row !== null && row.fromBotSelf, 'the bot row is stored under the first message id');
        expect(row?.replyToId === userMessageId, 'answering the command message');
        expect(row?.mediaHint === 'a picture', `the row says it is a picture (got ${String(row?.mediaHint)})`);
        expect(row?.text === null, 'a picture-only reply stores no text');
        expect(row?.file !== null, 'the single picture bytes are on the row');

        const [metric] = await findReplyMetricsByReply(chatId, response.messageId);
        expect(
            metric !== undefined &&
                metric.commandType === 'picgrok' &&
                metric.model === GROK_IMAGE_MODEL &&
                metric.outcome === 'ok' &&
                metric.imageCount === 1 &&
                metric.hasImage === true &&
                metric.isRetry === false,
            `one image-command metrics row (got ${json(metric)})`
        );
    })
);

results.push(
    await runCase('a base64 answer takes the same path as a URL answer', async () => {
        const chatId = GROUP_CHAT_ID - 11;
        const { telegram, response } = await runCommand({
            chatId,
            userId: FULL_USER_ID,
            prompt: 'base64 的猫',
            mode: 'b64',
        });
        expect(callsOf(telegram, 'sendPhoto').length === 1, 'the picture went out');
        const version = versionOf(response, 0);
        expect(
            typeof version?.imageBase64 === 'string' && version.imageBase64.length > 0,
            'the bytes came from b64_json'
        );
    })
);

results.push(
    await runCase('an upstream failure ends on a readable error with a retry button, stored as a version', async () => {
        const chatId = GROUP_CHAT_ID - 12;
        const { userMessageId, telegram, response } = await runCommand({
            chatId,
            userId: FULL_USER_ID,
            prompt: '会失败的猫',
            mode: 'error',
        });

        expect(callsOf(telegram, 'sendPhoto').length === 0, 'no picture is sent');
        const errorEdits = callsOf(telegram, 'editMessageText').filter((call) =>
            textOf(call).includes('生成图片失败')
        );
        expect(errorEdits.length >= 1, `a readable error edit (got ${errorEdits.length})`);
        expect(
            textOf(errorEdits.at(-1)).includes('offline upstream exploded'),
            `the upstream reason is readable (got ${JSON.stringify(textOf(errorEdits.at(-1)))})`
        );
        const keyboard = json(fieldsOf(errorEdits.at(-1)?.payload.reply_markup));
        expect(keyboard.includes('resp:retry'), `the retry button rides the error (got ${keyboard})`);
        expect(
            !callsOf(telegram, 'deleteMessage').some((call) => Number(call.payload.message_id) === response.messageId),
            'the placeholder stays as the terminal message'
        );

        const version = versionOf(response, 0);
        expect(
            version !== undefined &&
                typeof version.errorMessage === 'string' &&
                version.errorMessage.includes('生成图片失败'),
            `the failed version keeps the error (got ${json(version?.errorMessage)})`
        );
        expect(response.getMetadata().commandType === 'picgrok', 'the metadata still names the command');
        const [metric] = await findReplyMetricsByReply(chatId, response.messageId);
        expect(
            metric !== undefined && metric.outcome === 'error' && metric.imageCount === 0,
            `the metrics row records the failure (got ${json(metric)})`
        );
        expect(response.userMessageId === userMessageId, 'the reply answers the command');
    })
);

results.push(
    await runCase('a response with no image reads as its own readable error', async () => {
        const chatId = GROUP_CHAT_ID - 13;
        const { telegram } = await runCommand({
            chatId,
            userId: FULL_USER_ID,
            prompt: '空结果的猫',
            mode: 'empty',
        });
        const errorEdits = callsOf(telegram, 'editMessageText').filter((call) =>
            textOf(call).includes('生成图片失败')
        );
        expect(
            errorEdits.length >= 1 && textOf(errorEdits.at(-1)).includes('xAI 没有返回图片'),
            `the empty answer is named (got ${json(errorEdits.map(textOf))})`
        );
        expect(callsOf(telegram, 'sendPhoto').length === 0, 'nothing is sent');
    })
);

results.push(
    await runCase('the stop button ends on [stopped] and keeps the retry button', async () => {
        const chatId = GROUP_CHAT_ID - 14;
        const userMessageId = await seedCommandMessage(chatId, FULL_USER_ID, '/picgrok 会被停止的猫');
        const telegram = createFakeTelegram();
        const ctx = contextOf(
            messageUpdate({ chatId, messageId: userMessageId, userId: FULL_USER_ID, text: '/picgrok 会被停止的猫' }),
            telegram
        );
        const handler = quietly(() =>
            handlePicgrokCommand(ctx, { prompt: '会被停止的猫' }, 'full', {
                generateImage: (_prompt, signal) => {
                    // The stop may land before this call: an already aborted
                    // signal never fires the listener, so reject up front
                    if (signal.aborted) return Promise.reject(new Error('Aborted'));
                    return new Promise<Buffer>((_resolve, reject) => {
                        signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
                    });
                },
            })
        );
        const session = await waitForValue('the reply session', async () => {
            const active = listActiveSessions().find((candidate) => candidate.chatId === chatId);
            return active === undefined ? null : active;
        });
        await stopResponse(chatId, session.firstMessageId);
        await handler;

        const response = await BotResponse.findOne({ where: { chatId, userMessageId } });
        if (response === null) throw new Error('the stopped reply was not stored');
        const lastEdit = textOf(callsOf(telegram, 'editMessageText').at(-1));
        expect(lastEdit.includes('[stopped]'), `the stop terminal state (got ${JSON.stringify(lastEdit)})`);
        expect(callsOf(telegram, 'sendPhoto').length === 0, 'no picture');
        const [metric] = await findReplyMetricsByReply(chatId, response.messageId);
        expect(metric !== undefined && metric.outcome === 'stopped', `the metrics row says stopped (got ${json(metric)})`);
    })
);

/** The reply the routing case delivers; the retry cases press its button */
let routedReply: { chatId: number; userMessageId: number; messageId: number } | null = null;

results.push(
    await runCase('chat-handler routes a full user’s /picgrok into the pipeline', async () => {
        const chatId = GROUP_CHAT_ID - 15;
        const userMessageId = await seedCommandMessage(chatId, FULL_USER_ID, '/picgrok 一只猫');
        stubMode = 'url';
        const { bot, telegram } = createFakeBot();
        registerChatHandler(bot);
        await quietly(() =>
            bot.handleUpdate(
                messageUpdate({ chatId, messageId: userMessageId, userId: FULL_USER_ID, text: '/picgrok 一只猫' })
            )
        );
        // The row exists from the moment the placeholder is sent; wait for the
        // finalized version (the delivery lands in the same detached task).
        await waitForValue('the finalized /picgrok reply', async () => {
            const stored = await BotResponse.findOne({ where: { chatId, userMessageId } });
            return stored !== null &&
                stored.getVersions().length === 1 &&
                callsOf(telegram, 'sendPhoto').length > 0
                ? stored
                : null;
        });
        const response = await BotResponse.findOne({ where: { chatId, userMessageId } });
        if (response === null) throw new Error('the routed reply vanished');

        expect(
            callsOf(telegram, 'sendMessage').some((call) => textOf(call) === '✽ Thinking...'),
            'the reply pipeline owns the placeholder'
        );
        expect(
            response.getMetadata().commandType === 'picgrok' &&
                response.getMetadata().hasImage === true &&
                versionOf(response, 0)?.messageIds.length === 1,
            `the routed command produced one stored version (got ${json(response.getMetadata())})`
        );
        routedReply = { chatId, userMessageId, messageId: response.messageId };
    })
);

results.push(
    await runCase('chat-handler refuses a trial user’s /picgrok before any generation', async () => {
        const chatId = GROUP_CHAT_ID - 16;
        const userMessageId = await seedCommandMessage(chatId, TRIAL_USER_ID, '/picgrok 一只猫');
        const generationRequestsBefore = stubRequests.length;
        const { bot, telegram } = createFakeBot();
        registerChatHandler(bot);
        await quietly(() =>
            bot.handleUpdate(
                messageUpdate({ chatId, messageId: userMessageId, userId: TRIAL_USER_ID, text: '/picgrok 一只猫' })
            )
        );
        await waitForValue('the trial refusal', async () =>
            callsOf(telegram, 'sendMessage').some((call) => textOf(call) === TRIAL_COMMAND_REFUSAL_TEXT)
                ? true
                : null
        );
        expect(callsOf(telegram, 'sendPhoto').length === 0, 'nothing is generated');
        expect(
            (await BotResponse.findOne({ where: { chatId, userMessageId } })) === null,
            'no reply row is created'
        );
        expect(stubRequests.length === generationRequestsBefore, 'xAI is never called');
    })
);

results.push(
    await runCase('retry regenerates the original prompt as a second version', async () => {
        const reply = routedReply;
        if (reply === null) throw new Error('the routing case did not deliver a reply');
        stubMode = 'url';
        const telegram = createFakeTelegram();
        const ctx = contextOf(
            callbackUpdate({ chatId: reply.chatId, messageId: reply.messageId, userId: FULL_USER_ID, data: 'resp:retry' }),
            telegram
        );
        await quietly(() => handleRetryRequest(ctx, reply.messageId));
        const response = await waitForValue('the second version', async () => {
            const stored = await BotResponse.findOne({
                where: { chatId: reply.chatId, messageId: reply.messageId },
            });
            return stored !== null && stored.getVersions().length === 2 ? stored : null;
        });

        const retried = versionOf(response, 1);
        expect(retried !== undefined && retried.versionId === 2, 'version 2 is stored');
        expect(retried !== undefined && retried.messageIds.length === 1, 'the retried picture has its own message');
        expect(
            retried?.messageIds[0] !== versionOf(response, 0)?.messageIds[0],
            'the retried picture is a new message, not the old one'
        );
        expect(
            callsOf(telegram, 'sendPhoto').length === 1,
            `the retried picture went out (got ${callsOf(telegram, 'sendPhoto').length})`
        );
        expect(
            stringFieldOf(
                stubRequests.filter((entry) => entry.path === '/v1/images/generations').at(-1)?.body,
                'prompt'
            ) === '一只猫',
            'the original prompt was regenerated'
        );
        const metrics = await findReplyMetricsByReply(reply.chatId, reply.messageId);
        expect(
            metrics.some((metric) => metric.isRetry === true && metric.versionId === 2),
            `the retry has its own metrics row (got ${json(metrics)})`
        );
    })
);

results.push(
    await runCase('a failed retry ends on the readable error and keeps the retry button', async () => {
        const reply = routedReply;
        if (reply === null) throw new Error('the routing case did not deliver a reply');
        stubMode = 'error';
        const telegram = createFakeTelegram();
        const ctx = contextOf(
            callbackUpdate({ chatId: reply.chatId, messageId: reply.messageId, userId: FULL_USER_ID, data: 'resp:retry' }),
            telegram
        );
        await quietly(() => handleRetryRequest(ctx, reply.messageId));
        const response = await waitForValue('the failed third version', async () => {
            const stored = await BotResponse.findOne({
                where: { chatId: reply.chatId, messageId: reply.messageId },
            });
            return stored !== null && stored.getVersions().length === 3 ? stored : null;
        });
        const failed = versionOf(response, 2);
        expect(
            failed !== undefined && typeof failed.errorMessage === 'string',
            `the failed retry keeps its error (got ${json(failed?.errorMessage)})`
        );
        expect(callsOf(telegram, 'sendPhoto').length === 0, 'no picture on the failed retry');
        const errorEdit = callsOf(telegram, 'editMessageText').filter((call) => textOf(call).includes('生成图片失败'));
        expect(errorEdit.length >= 1, 'a readable error edit');
        expect(
            json(fieldsOf(errorEdit.at(-1)?.payload.reply_markup)).includes('resp:retry'),
            'the retry button is offered again'
        );
    })
);

results.push(
    await runCase('a trial user cannot retry a /picgrok reply', async () => {
        const reply = routedReply;
        if (reply === null) throw new Error('the routing case did not deliver a reply');
        const before = await BotResponse.findOne({ where: { chatId: reply.chatId, messageId: reply.messageId } });
        const versionCount = before?.getVersions().length ?? 0;
        const telegram = createFakeTelegram();
        const ctx = contextOf(
            callbackUpdate({ chatId: reply.chatId, messageId: reply.messageId, userId: TRIAL_USER_ID, data: 'resp:retry' }),
            telegram
        );
        await quietly(() => handleRetryRequest(ctx, reply.messageId));
        expect(
            callsOf(telegram, 'sendMessage').some((call) => textOf(call) === TRIAL_COMMAND_REFUSAL_TEXT),
            'the trial refusal is sent'
        );
        expect(callsOf(telegram, 'sendPhoto').length === 0, 'nothing is generated');
        const after = await BotResponse.findOne({ where: { chatId: reply.chatId, messageId: reply.messageId } });
        expect(after?.getVersions().length === versionCount, 'no new version is created');
    })
);

endOpenReplies();
await stub.close();
reportResults(results);
