/**
 * Offline cases for how a reply's pictures are delivered: one picture keeps
 * the single-image message, several stills go out as one album after the text,
 * a body that is only pictures sends them one by one with the keyboard on the
 * last, and a rich body that could not take its inline pictures hands them
 * over as attachments without leaking a marker into the text.
 *
 * Telegram is the fake Api (every call recorded and answered locally), so the
 * delivery pipeline runs unmodified and the assertions read the call log.
 *
 * Run: npx tsx scripts/offline/reply-multi-image.mts
 */
import type { AIResponse } from '../../src/ai/types.js';
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
    type FakeTelegram,
    type TelegramCall,
} from './fake-telegram.mts';

process.env.BOT_USER_ID = '7777';

await setupOfflineDb();
const responseHandler = await import('../../src/reply/response-handler.js');
const { createReplyMediaState } = await import('../../src/reply/tools/reply-media-state.js');

const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlZkAAAAASUVORK5CYII=',
    'base64'
);

let nextChatId = -1006666000000;

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : {};
const json = (value: unknown): string => JSON.stringify(value);

const reply = (fields: Partial<AIResponse>): AIResponse => ({
    text: '',
    thinkingText: '',
    images: [],
    groundingData: [],
    ...fields,
});

const callsOf = (telegram: FakeTelegram, method: string): TelegramCall[] =>
    telegram.calls.filter((call) => call.method === method);

const refuseRich = (method: string) => (call: TelegramCall) =>
    call.payload.rich_message !== undefined
        ? { error_code: 400, description: `Bad Request: ${method} rich refused` }
        : null;

interface Delivered {
    readonly telegram: FakeTelegram;
    readonly chatContext: NonNullable<Awaited<ReturnType<typeof responseHandler.createChatContext>>>;
}

const deliver = async (
    response: AIResponse,
    options: {
        readonly richReplies?: boolean;
        readonly refuse?: (call: TelegramCall) => { error_code: number; description: string } | null;
        /** Pictures the reply's tool state already holds (the answer references them inline) */
        readonly fetchedPictures?: readonly string[];
        readonly before?: (chatContext: NonNullable<Delivered['chatContext']>) => void;
    } = {}
): Promise<Delivered> => {
    const telegram = createFakeTelegram(options.refuse === undefined ? {} : { refuse: options.refuse });
    const chatId = (nextChatId -= 1);
    const userMessageId = takeMessageId();
    const ctx = contextOf(
        messageUpdate({ chatId, messageId: userMessageId, userId: 42, text: '发几张图' }),
        telegram
    );
    const chatContext = await quietly(() =>
        responseHandler.createChatContext(ctx, {
            model: 'offline-model',
            richReplies: options.richReplies === true,
        })
    );
    if (chatContext === null) throw new Error('offline: no chat context');
    trackReply(chatContext);

    if (options.fetchedPictures !== undefined && options.fetchedPictures.length > 0) {
        const state = createReplyMediaState();
        for (const id of options.fetchedPictures) {
            // A distinct byte suffix keeps different ids from being the same picture
            const data = Buffer.concat([PNG_BYTES, Buffer.from(id)]);
            state.fetched.set(id, {
                id,
                data,
                mimeType: 'image/png',
                still: { data, mimeType: 'image/png' },
                sourcePage: `https://example.test/${id}`,
                title: `图片 ${id}`,
                imageUrl: `https://example.test/${id}.png`,
            });
        }
        chatContext.mediaState = state;
        chatContext.contextIndex = new Map();
    }
    options.before?.(chatContext);

    chatContext.session.textBuffer = response.text;
    chatContext.session.images = response.images;
    chatContext.session.imageCaptions = response.imageCaptions ?? [];
    await quietly(() => responseHandler.sendFinalResponse(chatContext, response));
    return { telegram, chatContext };
};

const results: CaseResult[] = [];

results.push(
    await runCase('one picture keeps the single-image delivery', async () => {
        const { telegram, chatContext } = await deliver(
            reply({ text: '图来了。', images: [PNG_BYTES], imageCaptions: ['一张图'] })
        );
        expect(callsOf(telegram, 'sendMediaGroup').length === 0, 'no album for one picture');
        const photos = callsOf(telegram, 'sendPhoto');
        expect(photos.length === 1, `one photo message (got ${photos.length})`);
        expect(photos[0]?.payload.caption === '一张图', 'with its caption');
        const session = chatContext.session;
        expect(session.mediaMessageIds?.length === 1, 'the picture message id is recorded');
        expect(session.currentMessageId === session.mediaMessageIds?.[0], 'the keyboard stays on the picture');
        expect(session.imageCaptions?.[0] === '一张图', 'the caption stays with the delivered picture');
    })
);

results.push(
    await runCase('several pictures with text go out as one album, the keyboard keeping the text message', async () => {
        const { telegram, chatContext } = await deliver(
            reply({
                text: '三张图。',
                images: [PNG_BYTES, PNG_BYTES, PNG_BYTES],
                imageCaptions: ['一', '二', '三'],
            })
        );
        const groups = callsOf(telegram, 'sendMediaGroup');
        expect(groups.length === 1, `one album call (got ${groups.length})`);
        const media = groups[0]?.payload.media;
        expect(Array.isArray(media) && media.length === 3, 'three pictures in the album');
        const captions = Array.isArray(media)
            ? media.map((item) => asRecord(item).caption).join('|')
            : 'none';
        expect(captions === '一|二|三', `each picture keeps its own caption (got ${json(captions)})`);
        expect(groups[0]?.payload.reply_markup === undefined, 'the album carries no keyboard');
        const session = chatContext.session;
        expect(session.mediaMessageIds?.length === 3, 'all album message ids are recorded');
        expect(
            session.currentMessageId === session.firstMessageId,
            `the keyboard stays on the text message (got current=${session.currentMessageId} first=${session.firstMessageId})`
        );
        expect(session.imageCaptions?.length === 3, 'all captions stay with the delivered pictures');
    })
);

results.push(
    await runCase('a body of only pictures sends them one by one, the keyboard on the last', async () => {
        const { telegram, chatContext } = await deliver(
            reply({ images: [PNG_BYTES, PNG_BYTES, PNG_BYTES], imageCaptions: ['一', '二', '三'] })
        );
        expect(callsOf(telegram, 'sendMediaGroup').length === 0, 'no album without a text message to hold the keyboard');
        const photos = callsOf(telegram, 'sendPhoto');
        expect(photos.length === 3, `one message per picture (got ${photos.length})`);
        const session = chatContext.session;
        const ids = session.mediaMessageIds ?? [];
        expect(ids.length === 3, 'all picture messages are recorded');
        expect(session.currentMessageId === ids[2], `the keyboard lands on the last picture (got ${session.currentMessageId})`);
        expect(
            callsOf(telegram, 'deleteMessage').some((call) => call.payload.message_id === session.firstMessageId),
            'the processing placeholder is gone'
        );
        expect(!session.messageIds.includes(session.firstMessageId), 'and no longer part of the reply');
    })
);

results.push(
    await runCase('a refused album degrades to one message per picture', async () => {
        const { telegram, chatContext } = await deliver(
            reply({ text: '两张。', images: [PNG_BYTES, PNG_BYTES], imageCaptions: ['一', '二'] }),
            {
                refuse: (call) =>
                    call.method === 'sendMediaGroup'
                        ? { error_code: 400, description: 'Bad Request: album refused' }
                        : null,
            }
        );
        expect(callsOf(telegram, 'sendPhoto').length === 2, 'each picture goes out on its own');
        const session = chatContext.session;
        expect(session.mediaMessageIds?.length === 2, 'both picture messages are recorded');
        expect(session.currentMessageId === session.firstMessageId, 'the keyboard stays on the text message');
    })
);

results.push(
    await runCase('a rich body with trailing pictures keeps the keyboard on the body message', async () => {
        const { telegram, chatContext } = await deliver(
            reply({ text: '正文。', images: [PNG_BYTES, PNG_BYTES], imageCaptions: ['一', '二'] }),
            { richReplies: true }
        );
        const richEdits = callsOf(telegram, 'editMessageText').filter(
            (call) => call.payload.rich_message !== undefined
        );
        expect(richEdits.length >= 1, 'the body went out rich');
        expect(callsOf(telegram, 'sendMediaGroup').length === 1, 'the pictures follow as one album');
        const session = chatContext.session;
        expect(
            session.currentMessageId === session.firstMessageId,
            `the keyboard stays on the body message (got ${session.currentMessageId})`
        );
        expect(session.mediaMessageIds?.length === 2, 'both album ids are recorded');
    })
);

results.push(
    await runCase('a rich body that cannot take its inline picture hands it over, no marker leaks', async () => {
        const inlineBytes = Buffer.concat([PNG_BYTES, Buffer.from('img1')]);
        const { telegram, chatContext } = await deliver(
            reply({ text: '答案。\n\n![一张图](img1)\n\n后面。', images: [inlineBytes], imageCaptions: ['附件'] }),
            { richReplies: true, fetchedPictures: ['img1'], refuse: refuseRich('editMessageText') }
        );
        // The body is demoted to entities; the answer text has no marker in it
        const textEdits = callsOf(telegram, 'editMessageText').filter(
            (call) => typeof call.payload.text === 'string'
        );
        const lastText = textEdits.at(-1)?.payload.text;
        expect(typeof lastText === 'string', 'an entities edit delivered the text');
        expect(
            typeof lastText === 'string' && !lastText.includes('![') && !lastText.includes('img1'),
            `the marker is not shown to the user (got ${json(lastText)})`
        );
        expect(typeof lastText === 'string' && lastText.includes('答案。'), 'the answer itself is kept');
        // The parsed picture goes out as a trailing attachment; the attachment
        // with the same bytes is not sent a second time
        expect(callsOf(telegram, 'sendPhoto').length === 1, 'the inline picture became exactly one attachment');
        const session = chatContext.session;
        expect(session.mediaMessageIds?.length === 1, 'the attachment message is recorded');
        expect(session.textBuffer.includes('![') === false, 'the stored text carries no marker');
    })
);

results.push(
    await runCase('a picture that is both inline and an attachment goes out once', async () => {
        const inlineBytes = Buffer.concat([PNG_BYTES, Buffer.from('img1')]);
        const { telegram } = await deliver(
            reply({
                text: '正文。\n\n![图](img1)\n\n尾段。',
                images: [inlineBytes],
                imageCaptions: ['重复的那张'],
            }),
            { richReplies: true, fetchedPictures: ['img1'] }
        );
        const richEdit = callsOf(telegram, 'editMessageText')
            .filter((call) => call.payload.rich_message !== undefined)
            .at(-1);
        const media = asRecord(richEdit?.payload.rich_message).media;
        expect(Array.isArray(media) && media.length === 1, 'the body carries the picture inline');
        expect(callsOf(telegram, 'sendMediaGroup').length === 0, 'no album for the duplicate attachment');
        expect(callsOf(telegram, 'sendPhoto').length === 0, 'and no separate picture message');
    })
);

results.push(
    await runCase('attachments fill only the budget the inline pictures leave', async () => {
        const inlineBytes = [
            Buffer.concat([PNG_BYTES, Buffer.from('img1')]),
            Buffer.concat([PNG_BYTES, Buffer.from('img2')]),
        ];
        const attachments = Array.from({ length: 10 }, (_, index) =>
            Buffer.concat([PNG_BYTES, Buffer.from(`attachment-${index}`)])
        );
        const { telegram, chatContext } = await deliver(
            reply({
                text: '两张内嵌。\n\n![一](img1)\n\n![二](img2)\n\n后面。',
                images: attachments,
                imageCaptions: attachments.map((_, index) => `附件${index}`),
            }),
            { richReplies: true, fetchedPictures: ['img1', 'img2'] }
        );
        const richEdit = callsOf(telegram, 'editMessageText')
            .filter((call) => call.payload.rich_message !== undefined)
            .at(-1);
        const inline = asRecord(richEdit?.payload.rich_message).media;
        expect(Array.isArray(inline) && inline.length === 2, 'two pictures are inline in the body');
        const groups = callsOf(telegram, 'sendMediaGroup');
        const media = groups[0]?.payload.media;
        expect(
            Array.isArray(media) && media.length === 8,
            `the album takes the eight the reply has room for (got ${Array.isArray(media) ? media.length : 'none'})`
        );
        expect(chatContext.session.mediaMessageIds?.length === 8, 'eight attachment messages are recorded');
        expect(chatContext.session.inlineMedia?.length === 2, 'two inline pictures are recorded for the version');
        expect(inlineBytes.length === 2, 'both inline pictures were parsed');
    })
);

endOpenReplies();
reportResults(results);
