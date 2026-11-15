/**
 * Offline cases for how a reply's pictures are delivered: one picture keeps
 * the single-image message, several stills go out as one album after the text,
 * a body that is only pictures sends them one by one with the keyboard on the
 * last, and a rich body that could not take its inline pictures hands them
 * over as attachments without leaking a marker into the text.
 *
 * The storage cases pin the other half of the delivery contract: the version
 * and `message_media` keep exactly the pictures that reached the chat, once
 * each (no inline+attachment double store, no ghost attachment the send
 * dropped), in the order the chat received them, and within the reply's
 * 40MB budget.
 *
 * Telegram is the fake Api (every call recorded and answered locally), so the
 * delivery pipeline runs unmodified and the assertions read the call log.
 *
 * Run: npx tsx scripts/offline/reply-multi-image.mts
 */
import type { AIResponse } from '../../src/ai/types.js';
import type { ResponseVersion } from '../../src/db/botResponseDTO.js';
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
const dbIndex = await import('../../src/db/index.js');
const responseHandler = await import('../../src/reply/response-handler.js');
const { createReplyMediaState } = await import('../../src/reply/tools/reply-media-state.js');
const { MAX_REPLY_IMAGE_TOTAL_BYTES, replyMediaKeyOf } = await import('../../src/shared/reply-media.js');

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

/** Run `body` with the console captured: the delivery's own warnings are assertions here */
const captureConsole = async <T,>(body: () => Promise<T>): Promise<{ readonly result: T; readonly lines: string[] }> => {
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

/** The version the reply's finalize stored */
const storedVersionOf = async (chatId: number, firstMessageId: number): Promise<ResponseVersion | undefined> =>
    (await dbIndex.getBotResponse(chatId, firstMessageId))?.getVersions().at(-1);

/** The `message_media` rows of the reply's stored version, by ordinal */
const mediaRowsOf = async (chatId: number, firstMessageId: number) =>
    dbIndex.listMessageMedia(chatId, firstMessageId);

/** The media keys of the version's stored pictures, in stored order */
const mediaKeysOf = (version: ResponseVersion | undefined): string[] =>
    (version?.media ?? []).map((picture) => picture.mediaKey ?? '');

interface Delivered {
    readonly telegram: FakeTelegram;
    readonly chatContext: NonNullable<Awaited<ReturnType<typeof responseHandler.createChatContext>>>;
    /** Console lines of the final delivery (warnings the storage cases assert) */
    readonly logs: readonly string[];
}

const deliver = async (
    response: AIResponse,
    options: {
        readonly richReplies?: boolean;
        readonly refuse?: (call: TelegramCall) => { error_code: number; description: string } | null;
        /** Pictures the reply's tool state already holds (the answer references them inline) */
        readonly fetchedPictures?: readonly string[];
        /** Bytes per fetched picture; the default is the id-suffixed tiny PNG */
        readonly fetchedBytes?: ReadonlyMap<string, Buffer>;
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
            const data = options.fetchedBytes?.get(id) ?? Buffer.concat([PNG_BYTES, Buffer.from(id)]);
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
    const { lines } = await captureConsole(() => responseHandler.sendFinalResponse(chatContext, response));
    return { telegram, chatContext, logs: lines };
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

results.push(
    await runCase('overflow demote: a picture that is also an attachment is stored once', async () => {
        const inlineBytes = Buffer.concat([PNG_BYTES, Buffer.from('overflow-inline')]);
        // Over the rich source budget: the body is demoted to entities and the
        // resolved picture goes out as a trailing attachment
        const longText = `开头。\n\n![图注](img1)\n\n${'长'.repeat(30_500)}`;
        const { telegram, chatContext } = await deliver(
            reply({ text: longText, images: [inlineBytes], imageCaptions: ['附件图注'] }),
            {
                richReplies: true,
                fetchedPictures: ['img1'],
                fetchedBytes: new Map([['img1', inlineBytes]]),
            }
        );
        const version = await storedVersionOf(chatContext.chatId, chatContext.session.firstMessageId);
        expect(version !== undefined, 'the reply was versioned');
        expect(
            version?.delivery === undefined,
            `a demoted body is stored as entities (got ${version?.delivery})`
        );
        const stored = version?.media ?? [];
        expect(
            stored.length === 1,
            `the picture is stored once, not as inline and attachment (got ${stored.length})`
        );
        expect(
            stored[0]?.placement === 'attachment',
            `as the attachment it went out as (got ${stored[0]?.placement})`
        );
        expect(stored[0]?.mediaKey === replyMediaKeyOf(inlineBytes), 'with the bytes the chat received');
        const rows = await mediaRowsOf(chatContext.chatId, chatContext.session.firstMessageId);
        expect(rows.length === 1, `one message_media row (got ${rows.length})`);
        expect(rows[0]?.placement === 'attachment', 'the row keeps the attachment placement');
        expect(chatContext.session.inlineMedia?.length === 0, 'no inline picture is kept for the version');
        expect(version?.mediaMessageIds?.length === 1, 'the picture message id is recorded');
        expect(callsOf(telegram, 'sendPhoto').length === 1, 'the picture went out exactly once');
    })
);

results.push(
    await runCase('L1 inline delivery: the same bytes are one inline picture, no ghost attachment', async () => {
        const inlineBytes = Buffer.concat([PNG_BYTES, Buffer.from('l1-inline')]);
        const { telegram, chatContext } = await deliver(
            reply({
                text: '正文。\n\n![图注](img1)\n\n尾段。',
                images: [inlineBytes],
                imageCaptions: ['附件图注'],
            }),
            {
                richReplies: true,
                fetchedPictures: ['img1'],
                fetchedBytes: new Map([['img1', inlineBytes]]),
            }
        );
        const richEdit = callsOf(telegram, 'editMessageText')
            .filter((call) => call.payload.rich_message !== undefined)
            .at(-1);
        const inline = asRecord(richEdit?.payload.rich_message).media;
        expect(Array.isArray(inline) && inline.length === 1, 'the body carries the picture inline');
        expect(callsOf(telegram, 'sendMediaGroup').length === 0, 'no album for the duplicate attachment');
        expect(callsOf(telegram, 'sendPhoto').length === 0, 'and no separate picture message');
        const version = await storedVersionOf(chatContext.chatId, chatContext.session.firstMessageId);
        const stored = version?.media ?? [];
        expect(stored.length === 1, `the picture is stored once (got ${stored.length})`);
        expect(
            stored[0]?.placement === 'inline' && stored[0]?.id === 'img1',
            `as the inline picture the body shows (got ${json(stored[0])})`
        );
        expect(version?.delivery === 'rich', `the version records the rich body (got ${version?.delivery})`);
        const rows = await mediaRowsOf(chatContext.chatId, chatContext.session.firstMessageId);
        expect(
            rows.length === 1 && rows[0]?.placement === 'inline',
            `one inline message_media row (got ${json(rows.map((row) => row.placement))})`
        );
        expect(chatContext.session.images.length === 0, 'the session keeps no attachment the stream had produced');
    })
);

results.push(
    await runCase('inline pictures fill the budget: attachments over it leave no ghost', async () => {
        const inlineIds = Array.from({ length: 10 }, (_, index) => `img${index + 1}`);
        const inlineBytes = new Map(
            inlineIds.map((id) => [id, Buffer.concat([PNG_BYTES, Buffer.from(`inline-${id}`)])])
        );
        const attachments = [
            Buffer.concat([PNG_BYTES, Buffer.from('attachment-a')]),
            Buffer.concat([PNG_BYTES, Buffer.from('attachment-b')]),
        ];
        const text = `开头。\n\n${inlineIds
            .map((id, index) => `![内嵌图注${index + 1}](${id})`)
            .join('\n\n')}\n\n结尾。`;
        const { telegram, chatContext } = await deliver(
            reply({ text, images: attachments, imageCaptions: ['附件甲', '附件乙'] }),
            { richReplies: true, fetchedPictures: inlineIds, fetchedBytes: inlineBytes }
        );
        const richEdit = callsOf(telegram, 'editMessageText')
            .filter((call) => call.payload.rich_message !== undefined)
            .at(-1);
        const inline = asRecord(richEdit?.payload.rich_message).media;
        expect(Array.isArray(inline) && inline.length === 10, 'ten pictures are inline in the body');
        expect(callsOf(telegram, 'sendMediaGroup').length === 0, 'no album over the reply budget');
        expect(callsOf(telegram, 'sendPhoto').length === 0, 'and no single picture message');
        const version = await storedVersionOf(chatContext.chatId, chatContext.session.firstMessageId);
        const stored = version?.media ?? [];
        expect(
            stored.length === 10 && stored.every((picture) => picture.placement === 'inline'),
            `only the ten inline pictures are stored (got ${json(stored.map((picture) => picture.placement))})`
        );
        expect(version?.mediaMessageIds === undefined, 'no attachment message id is recorded');
        const rows = await mediaRowsOf(chatContext.chatId, chatContext.session.firstMessageId);
        expect(rows.length === 10, `ten message_media rows (got ${rows.length})`);
        expect(chatContext.session.images.length === 0, 'the session keeps no attachment the stream had produced');
        expect(chatContext.session.mediaMessageIds?.length === 0, 'no picture message is recorded in the session');
    })
);

results.push(
    await runCase('GIF and stills: the chat order is stills album first, and storage follows it', async () => {
        const gifBytes = Buffer.from('GIF89a offline gif');
        const stillOne = Buffer.concat([PNG_BYTES, Buffer.from('still-one')]);
        const stillTwo = Buffer.concat([PNG_BYTES, Buffer.from('still-two')]);
        const { telegram, chatContext } = await deliver(
            reply({
                text: '三张。',
                images: [gifBytes, stillOne, stillTwo],
                imageCaptions: ['动图', '静一', '静二'],
            })
        );
        const groupIndex = telegram.calls.findIndex((call) => call.method === 'sendMediaGroup');
        const animationIndex = telegram.calls.findIndex((call) => call.method === 'sendAnimation');
        expect(groupIndex !== -1, 'the two stills went out as one album');
        expect(
            animationIndex !== -1 && animationIndex > groupIndex,
            'the animation follows the album in the chat'
        );
        const session = chatContext.session;
        expect(session.images.length === 3, 'the session keeps all three pictures');
        expect(
            session.images[0]?.equals(stillOne) === true &&
                session.images[1]?.equals(stillTwo) === true &&
                session.images[2]?.equals(gifBytes) === true,
            'the session keeps the order the chat received'
        );
        expect(
            json(session.imageCaptions) === json(['静一', '静二', '动图']),
            `the captions follow the pictures (got ${json(session.imageCaptions)})`
        );
        const version = await storedVersionOf(chatContext.chatId, chatContext.session.firstMessageId);
        expect(
            json(mediaKeysOf(version)) ===
                json([replyMediaKeyOf(stillOne), replyMediaKeyOf(stillTwo), replyMediaKeyOf(gifBytes)]),
            `the version stores the delivery order (got ${json(mediaKeysOf(version))})`
        );
        const rows = await mediaRowsOf(chatContext.chatId, chatContext.session.firstMessageId);
        expect(json(rows.map((row) => row.ordinal)) === json([1, 2, 3]), 'message_media ordinals follow it');
        expect(json(rows.map((row) => row.caption)) === json(['静一', '静二', '动图']), 'and their captions');
    })
);

results.push(
    await runCase('an attachment is cut to the byte budget the inline pictures leave', async () => {
        // 30MB inline leaves 10MB of the reply's 40MB: the 20MB attachment cannot fit
        const inlineBytes = Buffer.alloc(30 * 1024 * 1024, 0x11);
        const attachmentBytes = Buffer.alloc(20 * 1024 * 1024, 0x22);
        const { telegram, chatContext, logs } = await deliver(
            reply({ text: '正文。\n\n![大图](img1)', images: [attachmentBytes], imageCaptions: ['超大附件'] }),
            {
                richReplies: true,
                fetchedPictures: ['img1'],
                fetchedBytes: new Map([['img1', inlineBytes]]),
            }
        );
        expect(
            callsOf(telegram, 'sendMediaGroup').length === 0 && callsOf(telegram, 'sendPhoto').length === 0,
            'the over-budget attachment never went out'
        );
        expect(
            chatContext.session.images.length === 0,
            `the session keeps no over-budget attachment (got ${chatContext.session.images.length})`
        );
        const version = await storedVersionOf(chatContext.chatId, chatContext.session.firstMessageId);
        const stored = version?.media ?? [];
        expect(
            stored.length === 1 && stored[0]?.placement === 'inline',
            `only the inline picture is stored (got ${json(stored.map((picture) => picture.placement))})`
        );
        const totalBytes = stored.reduce((total, picture) => total + picture.sizeBytes, 0);
        expect(totalBytes <= MAX_REPLY_IMAGE_TOTAL_BYTES, `the stored pictures stay within the budget (got ${totalBytes})`);
        expect(
            logs.some((line) => line.includes('byte budget')),
            `the dropped attachment is logged with its bytes (got ${json(logs.slice(-6))})`
        );
    })
);

results.push(
    await runCase('mixed pictures: the stills keep their own order, the animations follow them', async () => {
        const gifOne = Buffer.from('GIF89a offline gif one');
        const gifTwo = Buffer.from('GIF89a offline gif two');
        const stillOne = Buffer.concat([PNG_BYTES, Buffer.from('mixed-one')]);
        const stillTwo = Buffer.concat([PNG_BYTES, Buffer.from('mixed-two')]);
        const { telegram, chatContext } = await deliver(
            reply({
                text: '四张。',
                images: [stillOne, gifOne, stillTwo, gifTwo],
                imageCaptions: ['静一', '动一', '静二', '动二'],
            })
        );
        const media = callsOf(telegram, 'sendMediaGroup')[0]?.payload.media;
        expect(Array.isArray(media) && media.length === 2, 'the two stills are one album');
        const session = chatContext.session;
        expect(
            session.images[0]?.equals(stillOne) === true &&
                session.images[1]?.equals(stillTwo) === true &&
                session.images[2]?.equals(gifOne) === true &&
                session.images[3]?.equals(gifTwo) === true,
            'the session order is stills first, animations after, each group in input order'
        );
        const version = await storedVersionOf(chatContext.chatId, chatContext.session.firstMessageId);
        expect(
            json(mediaKeysOf(version)) ===
                json([stillOne, stillTwo, gifOne, gifTwo].map((bytes) => replyMediaKeyOf(bytes))),
            `the version follows it (got ${json(mediaKeysOf(version))})`
        );
        const rows = await mediaRowsOf(chatContext.chatId, chatContext.session.firstMessageId);
        expect(
            json(rows.map((row) => row.caption)) === json(['静一', '静二', '动一', '动二']),
            'the stored captions follow too'
        );
    })
);

results.push(
    await runCase('overflow demote: the fallback pictures spend the byte budget first', async () => {
        const inlineBytes = Buffer.alloc(30 * 1024 * 1024, 0x33);
        const attachmentBytes = Buffer.alloc(20 * 1024 * 1024, 0x44);
        const longText = `开头。\n\n![超大内嵌图](img1)\n\n${'长'.repeat(30_500)}`;
        const { telegram, chatContext, logs } = await deliver(
            reply({ text: longText, images: [attachmentBytes], imageCaptions: ['超大附件'] }),
            {
                richReplies: true,
                fetchedPictures: ['img1'],
                fetchedBytes: new Map([['img1', inlineBytes]]),
            }
        );
        const session = chatContext.session;
        expect(session.images.length === 1, `only the inline picture goes out (got ${session.images.length})`);
        expect(session.images[0]?.equals(inlineBytes) === true, 'as the attachment the entities path sends');
        expect(
            callsOf(telegram, 'sendPhoto').length === 1 && callsOf(telegram, 'sendMediaGroup').length === 0,
            'it went out exactly once, as a single picture'
        );
        const version = await storedVersionOf(chatContext.chatId, chatContext.session.firstMessageId);
        const stored = version?.media ?? [];
        expect(
            stored.length === 1 && stored[0]?.placement === 'attachment',
            `the fallback picture is stored as the attachment it is (got ${json(stored.map((picture) => picture.placement))})`
        );
        const totalBytes = stored.reduce((total, picture) => total + picture.sizeBytes, 0);
        expect(totalBytes <= MAX_REPLY_IMAGE_TOTAL_BYTES, `within the budget (got ${totalBytes})`);
        expect(logs.some((line) => line.includes('byte budget')), 'the dropped attachment is logged');
    })
);

endOpenReplies();
reportResults(results);
