/**
 * Offline cases for the reply delivery ledger (`bot_reply_messages`, design
 * 2026-1123-1610 §3): the bot books one row per message it actually puts in the
 * chat, saying which part of the reply that message is. A reaction anywhere on
 * the reply — a later body segment, the CoT link, the folded search/Tools link,
 * a picture, the sticker, the file, the card — then resolves to the reply and
 * carries the part label.
 *
 * The cases drive the real delivery pipelines against the fake Telegram API and
 * a scratch database:
 * - `chunkPartsOf` numbering (body segments around the dedicated messages) and
 *   the part each dedicated formatter names;
 * - the final delivery: a split body, a CoT link laid out again, the CoT link
 *   emitted while streaming (continuation restarts the body at 1), folded
 *   search/Tools link messages;
 * - pictures (album, single, GIF), file, sticker, widget and widget link;
 * - `layOutChunks`' callbacks: a deleted surplus message stops being bookable,
 *   a refused delete keeps its row;
 * - a version switch and a refresh: new message ids booked, replaced old ones
 *   forgotten;
 * - a ledger write that throws costs the reply nothing (best-effort delivery).
 *
 * Run: npx tsx scripts/offline/reply-part-ledger.mts
 */
import { createServer } from 'node:http';
import type { Chat } from 'grammy/types';
import type { AIResponse } from '../../src/ai/types.js';

// Telegram / Mini App / widget switches: the delivery reads them at import.
process.env.BOT_USER_ID = '7777';
process.env.BOT_TOKEN = '123456789:AAFakeOfflineTokenForReplyPartLedger1';
process.env.WEBAPP_PUBLIC_URL = 'https://miniapp.test';
process.env.BOT_USER_NAME = 'k_on_test_bot';
process.env.WEBAPP_BOT_SHORT_NAME = 'panel';
process.env.WIDGET_ENABLE = '1';
process.env.WIDGET_GROUP_FALLBACK = '1';
process.env.SHARE_ENABLED = '1';
delete process.env.THINKING_LINK;

import {
    expect,
    reportResults,
    runCase,
    setupOfflineDb,
    takeMessageId,
    type CaseResult,
} from './harness.mts';
import {
    contextOf,
    createFakeTelegram,
    endOpenReplies,
    messageUpdate,
    quietly,
    trackReply,
    userOf,
    type FakeTelegram,
    type TelegramCall,
} from './fake-telegram.mts';

/** The chat the widget API stub answers for; a private chat takes native widgets */
const WIDGET_CHAT_ID = -1007777000001;
/** How many distinct chat ids the cases use; negative ids keep the fake chats apart */
let nextChatId = -1007777000010;
const nextChat = (): number => (nextChatId -= 1);

// A stand-in for the Bot API root that serves the widget methods: one native
// widget send per case answers with a message id. Nothing else reaches it.
const widgetServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
            JSON.stringify({
                ok: true,
                result: {
                    message_id: 880_001,
                    date: 0,
                    chat: { id: WIDGET_CHAT_ID, type: 'private', first_name: 'Owner' },
                },
            })
        );
    });
});
await new Promise<void>((ready) => widgetServer.listen(0, '127.0.0.1', ready));
const widgetAddress = widgetServer.address();
if (widgetAddress === null || typeof widgetAddress === 'string') {
    throw new Error('offline: the widget stub has no TCP address');
}
process.env.WIDGET_API_ROOT = `http://127.0.0.1:${widgetAddress.port}`;

await setupOfflineDb();
const dbIndex = await import('../../src/db/index.js');
const responseHandler = await import('../../src/reply/response-handler.js');
const botMessageService = await import('../../src/services/bot-message-service.js');
const replyPartQueries = await import('../../src/db/queries/reply-part-queries.js');
const { BotReplyMessage } = await import('../../src/db/botReplyMessageDTO.js');
const { layOutChunks, chunkPartsOf } = await import('../../src/telegram/final-message-layout.js');
const { plainText } = await import('../../src/telegram/formatters/entity-text.js');
const { toThinkingLinkChunk } = await import('../../src/telegram/formatters/thinking-link.js');
const { toSearchLinkChunk } = await import('../../src/telegram/formatters/google-search-link.js');
const { toToolLogLinkChunk } = await import('../../src/telegram/formatters/tool-log-link.js');
const { buildToolLogDocument } = await import('../../src/telegram/formatters/tool-log-document.js');

type ChatContext = NonNullable<Awaited<ReturnType<typeof responseHandler.createChatContext>>>;
type StoredReplyPart = Awaited<
    ReturnType<typeof replyPartQueries.listReplyPartsForCanonical>
>[number];

const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlZkAAAAASUVORK5CYII=',
    'base64'
);
/** Enough of a GIF header for the mime sniff: the chat gets an animation */
const GIF_BYTES = Buffer.concat([
    Buffer.from('GIF89a', 'ascii'),
    Buffer.from('001000100000000021f904000a0000002c00000000010001000002024c01003b', 'hex'),
]);

/** The page pointers the cases fabricate (the real ones are signed by a service) */
const THINKING_LINK_REF = {
    token: 't'.repeat(43),
    miniAppUrl: 'https://t.me/k_on_test_bot/panel?startapp=tabc',
    fastPageUrl: 'https://miniapp.test/t/abc',
};
const SEARCH_LINK_REF = {
    token: 'search.payload.signature',
    url: 'https://miniapp.test/g/search.payload.signature',
};
const TOOL_LOG_LINK_REF = {
    token: 'tools.payload.signature',
    url: 'https://miniapp.test/x/tools.payload.signature',
};

const reply = (fields: Partial<AIResponse>): AIResponse => ({
    text: '',
    thinkingText: '',
    images: [],
    groundingData: [],
    ...fields,
});

const json = (value: unknown): string => JSON.stringify(value);

/** Run `body` with the console captured: the delivery's own warnings are assertions here */
const captureConsole = async <T,>(
    body: () => Promise<T>
): Promise<{ readonly result: T; readonly lines: string[] }> => {
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

const callsOf = (telegram: FakeTelegram, method: string): TelegramCall[] =>
    telegram.calls.filter((call) => call.method === method);

/**
 * The shared fake answers a fixed list of message-creating methods; a sticker
 * send is not on it (it answers `true`), so this test answers that one call with
 * the message Telegram would return — the delivery reads its id for the ledger.
 */
const answerStickerSends = (telegram: FakeTelegram, chatId: number): void => {
    Object.assign(telegram.api, {
        sendSticker: async () => {
            const messageId = takeMessageId();
            telegram.calls.push({ method: 'sendSticker', payload: { chat_id: chatId } });
            return { message_id: messageId, date: 0, chat: { id: chatId, type: 'supergroup', title: '测试群' } };
        },
    });
};

/** A private-chat update: the widget path sends the native card only there */
const privateUpdate = (chatId: number, userMessageId: number) => {
    const chat: Chat.PrivateChat = { id: chatId, type: 'private', first_name: 'Owner' };
    return {
        update_id: 900_000 + userMessageId,
        message: {
            message_id: userMessageId,
            date: 0,
            chat,
            from: userOf(42),
            text: '做一张卡片',
        },
    };
};

interface Delivered {
    readonly telegram: FakeTelegram;
    readonly chatContext: ChatContext;
    /** Console lines of the final delivery (warnings the cases assert) */
    readonly logs: readonly string[];
    readonly chatId: number;
}

const deliver = async (
    response: AIResponse,
    options: {
        readonly richReplies?: boolean;
        readonly privateChat?: boolean;
        readonly chatId?: number;
        readonly answerSticker?: boolean;
        readonly refuse?: (call: TelegramCall) => { error_code: number; description: string } | null;
        readonly before?: (chatContext: ChatContext) => void;
    } = {}
): Promise<Delivered> => {
    const telegram = createFakeTelegram(options.refuse === undefined ? {} : { refuse: options.refuse });
    const chatId = options.chatId ?? nextChat();
    if (options.answerSticker === true) answerStickerSends(telegram, chatId);
    const userMessageId = takeMessageId();
    const ctx = contextOf(
        options.privateChat === true
            ? privateUpdate(chatId, userMessageId)
            : messageUpdate({ chatId, messageId: userMessageId, userId: 42, text: '写一段回复' }),
        telegram
    );
    const chatContext = await quietly(() =>
        responseHandler.createChatContext(ctx, {
            model: 'offline-model',
            ...(options.richReplies === true ? { richReplies: true } : {}),
        })
    );
    if (chatContext === null) throw new Error('offline: no chat context');
    trackReply(chatContext);

    chatContext.session.textBuffer = response.text;
    chatContext.session.images = response.images;
    chatContext.session.imageCaptions = response.imageCaptions ?? [];
    options.before?.(chatContext);

    const { lines } = await captureConsole(() =>
        responseHandler.sendFinalResponse(chatContext, response)
    );
    return { telegram, chatContext, logs: lines, chatId };
};

/** The ledger rows of one reply, in writing order */
const partsOf = async (chatId: number, canonicalMessageId: number): Promise<StoredReplyPart[]> =>
    replyPartQueries.listReplyPartsForCanonical(chatId, canonicalMessageId);

const partOf = (
    parts: readonly StoredReplyPart[],
    messageId: number
): StoredReplyPart | undefined => parts.find((part) => part.messageId === messageId);

/** Assert one message is booked as the given part (and index, when one is expected) */
const expectPart = (
    parts: readonly StoredReplyPart[],
    messageId: number,
    part: string,
    partIndex: number | null,
    description: string
): void => {
    const stored = partOf(parts, messageId);
    expect(
        stored !== undefined && stored.part === part && stored.partIndex === partIndex,
        `${description}: expected message ${messageId} to be ${part}/${partIndex}, got ${json(
            stored === undefined ? null : { part: stored.part, partIndex: stored.partIndex }
        )}`
    );
};

const results: CaseResult[] = [];

results.push(
    await runCase('chunkPartsOf numbers body segments around the dedicated messages', async () => {
        const toolLog = buildToolLogDocument(undefined, []);
        const chunks = [
            toThinkingLinkChunk(THINKING_LINK_REF),
            plainText('第一段'),
            plainText('第二段'),
            toSearchLinkChunk(SEARCH_LINK_REF, { queryCount: 1, sourceCount: 1 }),
            toToolLogLinkChunk(TOOL_LOG_LINK_REF, toolLog),
        ];
        const parts = chunkPartsOf(chunks);
        expect(
            json(parts) ===
                json([
                    { part: 'cot-link', partIndex: null },
                    { part: 'body', partIndex: 1 },
                    { part: 'body', partIndex: 2 },
                    { part: 'search-link', partIndex: null },
                    { part: 'tools-link', partIndex: null },
                ]),
            `the numbering is link, body 1, body 2, search link, tools link (got ${json(parts)})`
        );
    })
);

results.push(
    await runCase('the dedicated formatters name their part', async () => {
        const toolLog = buildToolLogDocument(undefined, []);
        expect(toThinkingLinkChunk(THINKING_LINK_REF).part === 'cot-link', 'the CoT link names cot-link');
        expect(
            toSearchLinkChunk(SEARCH_LINK_REF, { queryCount: 0, sourceCount: 0 }).part === 'search-link',
            'the folded search footer names search-link'
        );
        expect(
            toToolLogLinkChunk(TOOL_LOG_LINK_REF, toolLog).part === 'tools-link',
            'the folded Tools block names tools-link'
        );
        expect(
            chunkPartsOf([plainText('正文')])[0]?.part === 'body',
            'a body chunk without a part is numbered as body by the layout'
        );
    })
);

results.push(
    await runCase('a split body is booked as body 1..N', async () => {
        const { chatContext, chatId } = await deliver(reply({ text: `开头。${'内容'.repeat(4000)}` }));
        const canonical = chatContext.session.firstMessageId;
        const messageIds = chatContext.session.messageIds;
        expect(messageIds.length > 1, `the reply went out as several messages (got ${messageIds.length})`);

        const parts = await partsOf(chatId, canonical);
        expect(
            parts.length === messageIds.length,
            `one row per delivered message (got ${parts.length} for ${messageIds.length} messages)`
        );
        messageIds.forEach((messageId, index) => {
            expectPart(parts, messageId, 'body', index + 1, `message ${index + 1} is body segment ${index + 1}`);
        });
        expect(
            parts.every((part) => part.canonicalMessageId === canonical),
            'every row hangs on the reply first message'
        );
    })
);

results.push(
    await runCase('the CoT link laid out by the final delivery is booked as cot-link', async () => {
        const { chatContext, chatId } = await deliver(reply({ text: '正文从这里开始。' }), {
            // A link the stream never emitted: the final delivery lays it out as
            // the reply's first message (the hand-delivered branch)
            before: (context) => {
                context.session.thinkingLink = {
                    ...THINKING_LINK_REF,
                    key: 'offline-live-key',
                    emitted: false,
                };
            },
        });
        const canonical = chatContext.session.firstMessageId;
        const messageIds = chatContext.session.messageIds;
        expect(messageIds.length === 2, `the link message plus the body (got ${messageIds.length})`);

        const parts = await partsOf(chatId, canonical);
        expectPart(parts, messageIds[0] ?? 0, 'cot-link', null, 'the reply leads with its CoT link');
        expectPart(parts, messageIds[1] ?? 0, 'body', 1, 'the body restarts at segment 1 after the link');
    })
);

results.push(
    await runCase('a CoT link emitted while streaming books the link and restarts the body at 1', async () => {
        const telegram = createFakeTelegram();
        const chatId = nextChat();
        const userMessageId = takeMessageId();
        const ctx = contextOf(
            messageUpdate({ chatId, messageId: userMessageId, userId: 42, text: '想个难题' }),
            telegram
        );
        const chatContext = await quietly(() =>
            responseHandler.createChatContext(ctx, { model: 'offline-model' })
        );
        if (chatContext === null) throw new Error('offline: no chat context');
        trackReply(chatContext);

        // Six CoT sections fill more than one streaming message: the link mode
        // activates, the first body chunk emits it and opens the continuation
        const longThinking = (): string =>
            Array.from({ length: 6 }, (_, index) => `**S${index}**\n\n${'推理'.repeat(350)}`).join('\n\n');
        const steps: { type: 'thinking' | 'text'; content: string }[] = [];
        const thinking = longThinking();
        for (let index = 0; index < thinking.length; index += 500) {
            steps.push({ type: 'thinking', content: thinking.slice(index, index + 500) });
        }
        steps.push({ type: 'text', content: '答案来了。' });
        const stream = {
            async *[Symbol.asyncIterator]() {
                for (const step of steps) yield step;
            },
        };
        await quietly(() => responseHandler.processStream(stream, chatContext, 0));
        chatContext.typing.stop();

        const link = chatContext.session.thinkingLink;
        expect(link?.emitted === true, 'the stream emitted the link message');
        expect(chatContext.session.messageIds.length === 2, 'the link message and the continuation exist');

        const canonical = chatContext.session.firstMessageId;
        const parts = await partsOf(chatId, canonical);
        expectPart(parts, canonical, 'cot-link', null, 'the first message became the CoT link');
        const continuationId = chatContext.session.messageIds[1] ?? 0;
        expect(continuationId !== canonical, 'the body continues in a new message');
        expectPart(parts, continuationId, 'body', 1, 'the body restarts at segment 1');
    })
);

results.push(
    await runCase('folded search and Tools link messages are booked with their parts', async () => {
        const smallSearchGrounding = () => ({
            provider: 'google' as const,
            searchQueries: ['甲'],
            searchEntryPoint: {
                renderedContent: '<a href="https://www.google.com/search?q=a">甲</a>',
            },
            groundingChunks: [{ web: { uri: 'https://a.example', title: 'A' } }],
        });
        const searchDelivery = await deliver(
            reply({ text: '搜索一下。', groundingData: [smallSearchGrounding()] }),
            {
                before: (context) => {
                    context.session.searchLink = { ...SEARCH_LINK_REF };
                },
            }
        );
        const searchCanonical = searchDelivery.chatContext.session.firstMessageId;
        const searchIds = searchDelivery.chatContext.session.messageIds;
        const searchParts = await partsOf(searchDelivery.chatId, searchCanonical);
        expectPart(searchParts, searchIds[0] ?? 0, 'body', 1, 'the answer stays body 1');
        expectPart(
            searchParts,
            searchIds[searchIds.length - 1] ?? 0,
            'search-link',
            null,
            'the folded footer ends the reply as a search link'
        );

        const toolsDelivery = await deliver(reply({ text: '工具跑完了。' }), {
            before: (context) => {
                context.session.toolLogLink = { ...TOOL_LOG_LINK_REF };
            },
        });
        const toolsCanonical = toolsDelivery.chatContext.session.firstMessageId;
        const toolsIds = toolsDelivery.chatContext.session.messageIds;
        const toolsParts = await partsOf(toolsDelivery.chatId, toolsCanonical);
        expectPart(toolsParts, toolsIds[0] ?? 0, 'body', 1, 'the answer stays body 1');
        expectPart(
            toolsParts,
            toolsIds[toolsIds.length - 1] ?? 0,
            'tools-link',
            null,
            'the folded Tools block ends the reply as a tools link'
        );
    })
);

results.push(
    await runCase('pictures are booked per message: an album numbers its stills, a GIF is its own kind', async () => {
        const { chatContext, chatId } = await deliver(
            reply({
                text: '图来了。',
                images: [PNG_BYTES, PNG_BYTES, PNG_BYTES, GIF_BYTES],
                imageCaptions: ['一', '二', '三', '动图'],
            })
        );
        const canonical = chatContext.session.firstMessageId;
        const parts = await partsOf(chatId, canonical);
        expectPart(parts, canonical, 'body', 1, 'the text message is body 1');

        const mediaIds = chatContext.session.mediaMessageIds ?? [];
        expect(
            mediaIds.length === 4,
            `three stills and one animation are four messages (got ${mediaIds.length})`
        );
        expectPart(parts, mediaIds[0] ?? 0, 'picture', 1, 'the first still is picture 1');
        expectPart(parts, mediaIds[1] ?? 0, 'picture', 2, 'the second still is picture 2');
        expectPart(parts, mediaIds[2] ?? 0, 'picture', 3, 'the third still is picture 3');
        expectPart(parts, mediaIds[3] ?? 0, 'gif', null, 'the animation is its own kind');
    })
);

results.push(
    await runCase('a media-only reply books its pictures and forgets the deleted placeholder', async () => {
        const { chatContext, chatId } = await deliver(reply({ images: [PNG_BYTES] }));
        const canonical = chatContext.session.firstMessageId;
        const parts = await partsOf(chatId, canonical);
        const mediaIds = chatContext.session.mediaMessageIds ?? [];
        expect(mediaIds.length === 1, `one picture message (got ${mediaIds.length})`);
        expect(
            partOf(parts, canonical) === undefined,
            'the deleted placeholder is no longer bookable'
        );
        expectPart(parts, mediaIds[0] ?? 0, 'picture', 1, 'the picture is picture 1');
    })
);

results.push(
    await runCase('file, sticker, widget and widget link are booked with their parts', async () => {
        const fileDelivery = await deliver(
            reply({
                text: '文件在这。',
                files: [{ name: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('hi') }],
            })
        );
        const fileIds = fileDelivery.chatContext.session.messageIds;
        const fileParts = await partsOf(
            fileDelivery.chatId,
            fileDelivery.chatContext.session.firstMessageId
        );
        expectPart(
            fileParts,
            fileIds[fileIds.length - 1] ?? 0,
            'file',
            null,
            'the document message is the file part'
        );

        const stickerDelivery = await deliver(
            reply({
                text: '贴纸。',
                stickers: [
                    {
                        packIndex: 0,
                        label: '离线贴纸',
                        emoji: '🐱',
                        fileId: 'offline-sticker-file',
                        fileUniqueId: 'offline-sticker-unique',
                    },
                ],
            }),
            { answerSticker: true }
        );
        const stickerIds = stickerDelivery.chatContext.session.messageIds;
        const stickerParts = await partsOf(
            stickerDelivery.chatId,
            stickerDelivery.chatContext.session.firstMessageId
        );
        expectPart(
            stickerParts,
            stickerIds[stickerIds.length - 1] ?? 0,
            'sticker',
            null,
            'the sticker message is the sticker part'
        );

        const widgetDelivery = await deliver(
            reply({
                text: '卡片。',
                widgets: [
                    {
                        mode: 'html' as const,
                        html: '<div>卡片</div>',
                        htmlBytes: 20,
                        zlibBytes: 24,
                    },
                ],
            }),
            { privateChat: true, chatId: WIDGET_CHAT_ID }
        );
        const widgetIds = widgetDelivery.chatContext.session.messageIds;
        const widgetParts = await partsOf(
            widgetDelivery.chatId,
            widgetDelivery.chatContext.session.firstMessageId
        );
        expectPart(
            widgetParts,
            widgetIds[widgetIds.length - 1] ?? 0,
            'widget',
            null,
            'the private chat card is the widget part'
        );

        const widgetLinkDelivery = await deliver(
            reply({
                text: '卡片链接。',
                widgets: [
                    {
                        mode: 'html' as const,
                        html: '<div>卡片</div>',
                        htmlBytes: 20,
                        zlibBytes: 24,
                    },
                ],
            })
        );
        const widgetLinkIds = widgetLinkDelivery.chatContext.session.messageIds;
        const widgetLinkParts = await partsOf(
            widgetLinkDelivery.chatId,
            widgetLinkDelivery.chatContext.session.firstMessageId
        );
        expectPart(
            widgetLinkParts,
            widgetLinkIds[widgetLinkIds.length - 1] ?? 0,
            'widget-link',
            null,
            'the group card link is the widget-link part'
        );
    })
);

results.push(
    await runCase('layOutChunks forgets a deleted surplus message and keeps a refused one', async () => {
        const chatId = nextChat();
        const firstId = takeMessageId();
        const surplusId = takeMessageId();
        const canonical = firstId;
        const book = async (messageId: number): Promise<void> => {
            await replyPartQueries.setReplyPart({
                chatId,
                canonicalMessageId: canonical,
                messageId,
                part: 'body',
                partIndex: messageId === firstId ? 1 : 2,
            });
        };
        await book(firstId);
        await book(surplusId);

        const telegram = createFakeTelegram();
        const callbacks = {
            onChunkDelivered: async (delivery: { messageId: number; part: string; partIndex: number | null }) => {
                await replyPartQueries.setReplyPart({
                    chatId,
                    canonicalMessageId: canonical,
                    messageId: delivery.messageId,
                    part: 'body',
                    partIndex: delivery.partIndex,
                });
            },
            onMessageDeleted: async (messageId: number) => {
                await replyPartQueries.removeReplyPart(chatId, messageId);
            },
        };
        const laidOut = await layOutChunks({
            api: telegram.api,
            chatId,
            userMessageId: takeMessageId(),
            firstMessageId: firstId,
            messageIds: [firstId, surplusId],
            chunks: [plainText('合并后的一段')],
            ...callbacks,
        });
        expect(laidOut.allDelivered, 'the layout went through');
        expect(callsOf(telegram, 'deleteMessage').length === 1, 'the surplus message was deleted');
        let parts = await partsOf(chatId, canonical);
        expect(
            partOf(parts, surplusId) === undefined,
            'the deleted message is no longer bookable'
        );
        expectPart(parts, firstId, 'body', 1, 'the kept message is body 1');

        const refusedSurplusId = takeMessageId();
        await replyPartQueries.setReplyPart({
            chatId,
            canonicalMessageId: canonical,
            messageId: refusedSurplusId,
            part: 'body',
            partIndex: 2,
        });
        const refusingTelegram = createFakeTelegram({
            refuse: (call) =>
                call.method === 'deleteMessage'
                    ? { error_code: 400, description: 'Bad Request: message to delete not found' }
                    : null,
        });
        const refused = await captureConsole(() =>
            layOutChunks({
                api: refusingTelegram.api,
                chatId,
                userMessageId: takeMessageId(),
                firstMessageId: firstId,
                messageIds: [firstId, refusedSurplusId],
                chunks: [plainText('又是一段')],
                ...callbacks,
            })
        ).then((captured) => captured.result);
        expect(!refused.allDelivered, 'a refused delete makes the layout not fully delivered');
        parts = await partsOf(chatId, canonical);
        expectPart(
            parts,
            refusedSurplusId,
            'body',
            2,
            'a message whose delete was refused keeps its row (a reaction may still land on it)'
        );

        // A ledger callback that throws is bookkeeping noise, never a delivery failure
        const throwingTelegram = createFakeTelegram();
        const throwingFirstId = takeMessageId();
        const throwing = await captureConsole(() =>
            layOutChunks({
                api: throwingTelegram.api,
                chatId: nextChat(),
                userMessageId: takeMessageId(),
                firstMessageId: throwingFirstId,
                messageIds: [throwingFirstId],
                chunks: [plainText('一段'), plainText('又一段')],
                onChunkDelivered: () => {
                    throw new Error('injected bookkeeping failure');
                },
            })
        );
        expect(
            throwing.result.allDelivered,
            `a throwing ledger callback does not stop the layout (got ${json(throwing.lines.slice(-2))})`
        );
    })
);

results.push(
    await runCase('a version switch books the re-delivered messages and forgets the replaced ones', async () => {
        const delivered = await deliver(reply({ text: '第一版。' }));
        const { chatContext, chatId } = delivered;
        const first = chatContext.session.firstMessageId;

        // An older version that also had a second body message the switch replaces
        const replacedId = takeMessageId();
        await replyPartQueries.setReplyPart({
            chatId,
            canonicalMessageId: first,
            messageId: replacedId,
            part: 'body',
            partIndex: 2,
        });
        const response = await dbIndex.getBotResponse(chatId, first);
        if (response === null) throw new Error('offline: no bot response');
        const versions = response.getVersions();
        const firstVersion = versions[0];
        if (firstVersion === undefined) throw new Error('offline: no stored version');
        firstVersion.messageIds = [first, replacedId];
        // getVersions parses the stored JSON: the mutation must be written back
        response.setVersions(versions);
        const secondVersion = {
            versionId: 2,
            createdAt: new Date().toISOString(),
            model: 'offline-model',
            messageIds: [first],
            currentMessageId: first,
            text: `第二版开头。${'内容'.repeat(4000)}`,
            wasStoppedByUser: false,
        };
        response.addVersion(secondVersion);
        response.currentVersionIndex = 0;
        await response.save();

        const switched = await botMessageService.switchVersion(delivered.chatContext.ctx, first, 'next');
        expect(switched, 'the version switch went through');

        const parts = await partsOf(chatId, first);
        expect(
            partOf(parts, replacedId) === undefined,
            'the replaced old message is no longer bookable'
        );
        expectPart(parts, first, 'body', 1, 'the edited first message is body 1');
        const refreshed = await dbIndex.getBotResponse(chatId, first);
        const currentVersion = refreshed?.getCurrentVersion();
        const newIds = currentVersion?.messageIds ?? [];
        expect(newIds.length > 1, `the new version is split (got ${newIds.length} messages)`);
        expectPart(parts, newIds[1] ?? 0, 'body', 2, 'the re-sent second segment is body 2');
    })
);

results.push(
    await runCase('a refresh re-books the stored layout, booking its new messages and forgetting a surplus one', async () => {
        const delivered = await deliver(reply({ text: `刷新开头。${'内容'.repeat(4000)}` }));
        const { chatContext, chatId, telegram } = delivered;
        const first = chatContext.session.firstMessageId;

        // The stored version names only its first message: the refresh has to
        // send the second segment again, and the new message id must be booked
        const stored = await dbIndex.getBotResponse(chatId, first);
        if (stored === null) throw new Error('offline: no bot response');
        const storedVersions = stored.getVersions();
        const storedVersion = storedVersions[stored.currentVersionIndex];
        if (storedVersion === undefined) throw new Error('offline: no current version');
        storedVersion.messageIds = [first];
        stored.setVersions(storedVersions);
        await stored.save();

        const refreshedOnce = await botMessageService.refreshToFinalState(telegram.api, chatId, first);
        expect(refreshedOnce, 'the first refresh went through');
        const afterFirstRefresh = await dbIndex.getBotResponse(chatId, first);
        const refreshedIds = afterFirstRefresh?.getCurrentVersion()?.messageIds ?? [];
        expect(refreshedIds.length > 1, `the refresh re-sent the split segment (got ${refreshedIds.length} messages)`);
        const rerunParts = await partsOf(chatId, first);
        refreshedIds.forEach((messageId, index) => {
            expectPart(rerunParts, messageId, 'body', index + 1, `the refreshed message ${index + 1}`);
        });

        // A message the stored version still lists but the final layout no longer
        // needs: the refresh deletes it and its row stops being bookable
        const response = await dbIndex.getBotResponse(chatId, first);
        if (response === null) throw new Error('offline: no bot response');
        const versions = response.getVersions();
        const version = versions[response.currentVersionIndex];
        if (version === undefined) throw new Error('offline: no current version');
        const surplusId = takeMessageId();
        await replyPartQueries.setReplyPart({
            chatId,
            canonicalMessageId: first,
            messageId: surplusId,
            part: 'body',
            partIndex: version.messageIds.length + 1,
        });
        version.messageIds = [...version.messageIds, surplusId];
        response.setVersions(versions);
        await response.save();

        const refreshed = await botMessageService.refreshToFinalState(telegram.api, chatId, first);
        expect(refreshed, 'the second refresh went through');

        const parts = await partsOf(chatId, first);
        expect(partOf(parts, surplusId) === undefined, 'the surplus message stopped being bookable');
        version.messageIds
            .filter((messageId) => messageId !== surplusId)
            .forEach((messageId, index) => {
                expectPart(parts, messageId, 'body', index + 1, `the kept message ${index + 1}`);
            });
    })
);

results.push(
    await runCase('a ledger write that throws costs the reply nothing', async () => {
        const createDescriptor = Object.getOwnPropertyDescriptor(BotReplyMessage, 'create');
        Object.defineProperty(BotReplyMessage, 'create', {
            configurable: true,
            writable: true,
            value: async () => {
                throw new Error('injected ledger failure');
            },
        });
        try {
            const { chatContext, telegram, logs } = await deliver(reply({ text: '照样发出去。' }));
            expect(
                chatContext.session.messageIds.length >= 1,
                'the reply still went out'
            );
            expect(
                callsOf(telegram, 'editMessageText').some((call) =>
                    String(call.payload.text ?? '').includes('照样发出去')
                ),
                'the final text reached the chat'
            );
            expect(
                logs.some((line) => line.includes('[reply-part] register failed')),
                `the failed ledger write is warned about (got ${json(logs.slice(-4))})`
            );
        } finally {
            // Put the model's own method back: a patched class outlives the case
            Reflect.deleteProperty(BotReplyMessage, 'create');
            if (createDescriptor !== undefined) {
                Object.defineProperty(BotReplyMessage, 'create', createDescriptor);
            }
        }
    })
);

endOpenReplies();
await new Promise<void>((closed) => widgetServer.close(() => closed()));
reportResults(results);
