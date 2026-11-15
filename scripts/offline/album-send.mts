/**
 * Offline cases for the album sender (`src/telegram/reply-images-send.ts`),
 * the one place a reply's pictures become trailing messages.
 *
 * Covers: one picture keeps the old single-image message (photo, caption, the
 * keyboard when the caller passes one); several stills become one media group
 * with a caption on each; a refused album degrades to one message per picture;
 * GIFs never enter the album and follow the stills as animations; an album is
 * not used when the caller says the keyboard needs a single message to land
 * on; and nothing sent at all is an error.
 *
 * Telegram is the fake Api from `fake-telegram.mts`, whose transformer records
 * every payload and answers locally, so uploads are visible but never leave.
 *
 * Run: npx tsx scripts/offline/album-send.mts
 */
import { InputFile } from 'grammy';
import {
    expect,
    reportResults,
    runCase,
    setupOfflineDb,
    type CaseResult,
} from './harness.mts';
import { createFakeTelegram, type TelegramCall } from './fake-telegram.mts';

await setupOfflineDb();
const { sendReplyImagesMessage } = await import('../../src/telegram/reply-images-send.js');
const { MAX_ALBUM_IMAGES } = await import('../../src/shared/reply-media.js');

/** Only the file signature matters to the sender's still/animation split */
const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlZkAAAAASUVORK5CYII=',
    'base64'
);
const GIF_BYTES = Buffer.from('GIF89a offline gif');

const CHAT_ID = -1007777000001;
const USER_MESSAGE_ID = 900_001;

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : {};

const captionOf = (index: number) => ({
    caption: `第${index + 1}张`,
    caption_entities: [{ type: 'bold' as const, offset: 0, length: 2 }],
});

/** The pictures the sender takes, with their captions rendered already */
const uploads = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ data: PNG_BYTES, captionFields: captionOf(index) }));

const callWith = (method: string, calls: readonly TelegramCall[]): TelegramCall | undefined =>
    calls.find((call) => call.method === method);

const results: CaseResult[] = [];

results.push(
    await runCase('one picture takes the single-image sender, caption and keyboard included', async () => {
        const telegram = createFakeTelegram();
        const sent = await sendReplyImagesMessage({
            api: telegram.api,
            chatId: CHAT_ID,
            images: uploads(1),
            target: {
                reply_parameters: { message_id: USER_MESSAGE_ID },
                reply_markup: { inline_keyboard: [[{ text: '停止', callback_data: 'resp:stop' }]] },
            },
            runApiCall: (operation) => operation(),
        });
        expect(sent[0] === null && sent[1]?.length === 1, `one id comes back (got ${JSON.stringify(sent[1])})`);
        expect(telegram.callsOf('sendMediaGroup').length === 0, 'no album for a single picture');
        const photo = callWith('sendPhoto', telegram.calls);
        expect(photo !== undefined, 'the picture goes out through sendPhoto');
        expect(photo?.payload.chat_id === CHAT_ID, 'to the chat');
        expect(photo?.payload.photo instanceof InputFile, 'as an upload');
        expect(photo?.payload.caption === '第1张', `with its caption (got ${String(photo?.payload.caption)})`);
        const captionEntities = photo?.payload.caption_entities;
        const firstCaptionEntity = Array.isArray(captionEntities) ? asRecord(captionEntities[0]) : undefined;
        expect(firstCaptionEntity?.type === 'bold', 'and caption entities');
        expect(asRecord(photo?.payload.reply_parameters).message_id === USER_MESSAGE_ID, 'replying to the question');
        expect(photo?.payload.reply_markup !== undefined, 'the keyboard rides the only picture');
    })
);

results.push(
    await runCase('several stills go out as one media group, each with its own caption', async () => {
        const telegram = createFakeTelegram();
        const sent = await sendReplyImagesMessage({
            api: telegram.api,
            chatId: CHAT_ID,
            images: uploads(3),
            target: { reply_parameters: { message_id: USER_MESSAGE_ID } },
            runApiCall: (operation) => operation(),
        });
        expect(sent[0] === null && sent[1]?.length === 3, `three ids come back (got ${JSON.stringify(sent[1])})`);
        expect(
            sent[1] !== undefined && sent[1][1] === (sent[1][0] ?? 0) + 1 && sent[1][2] === (sent[1][0] ?? 0) + 2,
            'the ids are the album messages in order'
        );
        const group = callWith('sendMediaGroup', telegram.calls);
        expect(group !== undefined && telegram.calls.length === 1, 'the album is the only call');
        const media = group?.payload.media;
        expect(Array.isArray(media) && media.length === 3, `three media items (got ${Array.isArray(media) ? media.length : 'none'})`);
        for (const [index, item] of (Array.isArray(media) ? media : []).entries()) {
            const entry = asRecord(item);
            expect(entry.type === 'photo', `item ${index} is a photo`);
            expect(entry.media instanceof InputFile, `item ${index} is an upload`);
            expect(entry.caption === `第${index + 1}张`, `item ${index} keeps its own caption (got ${String(entry.caption)})`);
            expect(Array.isArray(entry.caption_entities), `item ${index} keeps its caption entities`);
        }
        expect(group?.payload.reply_markup === undefined, 'an album carries no keyboard');
        expect(asRecord(group?.payload.reply_parameters).message_id === USER_MESSAGE_ID, 'the album replies to the question');
    })
);

results.push(
    await runCase('a refused album falls back to one message per picture', async () => {
        const telegram = createFakeTelegram({
            refuse: (call) =>
                call.method === 'sendMediaGroup'
                    ? { error_code: 400, description: 'Bad Request: album refused' }
                    : null,
        });
        const sent = await sendReplyImagesMessage({
            api: telegram.api,
            chatId: CHAT_ID,
            images: uploads(3),
            target: { reply_parameters: { message_id: USER_MESSAGE_ID } },
            runApiCall: (operation) => operation(),
        });
        expect(sent[0] === null && sent[1]?.length === 3, `all three still arrive (got ${JSON.stringify(sent[1])})`);
        expect(telegram.callsOf('sendPhoto').length === 3, 'one message per picture');
    })
);

results.push(
    await runCase('GIFs never enter the album and follow the stills as animations', async () => {
        const telegram = createFakeTelegram();
        const sent = await sendReplyImagesMessage({
            api: telegram.api,
            chatId: CHAT_ID,
            images: [
                { data: PNG_BYTES, captionFields: captionOf(0) },
                { data: GIF_BYTES },
                { data: PNG_BYTES, captionFields: captionOf(2) },
            ],
            target: { reply_parameters: { message_id: USER_MESSAGE_ID } },
            runApiCall: (operation) => operation(),
        });
        expect(sent[0] === null && sent[1]?.length === 3, `three messages go out (got ${JSON.stringify(sent[1])})`);
        const group = callWith('sendMediaGroup', telegram.calls);
        const media = group?.payload.media;
        expect(Array.isArray(media) && media.length === 2, 'the album holds the stills only');
        const animations = telegram.callsOf('sendAnimation');
        expect(animations.length === 1, 'the GIF goes out as an animation');
        expect(animations[0]?.payload.animation instanceof InputFile, 'uploaded as an animation');
        // The album messages come first in delivery order, the animation after them
        const groupIndex = group === undefined ? -1 : telegram.calls.indexOf(group);
        const animationIndex = animations[0] === undefined ? -1 : telegram.calls.indexOf(animations[0]);
        expect(groupIndex !== -1 && animationIndex > groupIndex, 'stills first, animation after');
        expect(
            sent[1] !== undefined && sent[1][2] !== undefined && sent[1][2] > (sent[1][1] ?? 0),
            'the last id is the animation message'
        );
    })
);

results.push(
    await runCase('without an album every still is its own message', async () => {
        const telegram = createFakeTelegram();
        const sent = await sendReplyImagesMessage({
            api: telegram.api,
            chatId: CHAT_ID,
            images: uploads(3),
            target: { reply_parameters: { message_id: USER_MESSAGE_ID } },
            runApiCall: (operation) => operation(),
            useAlbum: false,
        });
        expect(sent[0] === null && sent[1]?.length === 3, `three ids come back (got ${JSON.stringify(sent[1])})`);
        expect(telegram.callsOf('sendMediaGroup').length === 0, 'no album');
        expect(telegram.callsOf('sendPhoto').length === 3, 'one message per picture');
    })
);

results.push(
    await runCase('pictures past the album size are dropped and reported', async () => {
        const telegram = createFakeTelegram();
        const dropped: number[] = [];
        const sent = await sendReplyImagesMessage({
            api: telegram.api,
            chatId: CHAT_ID,
            images: uploads(MAX_ALBUM_IMAGES + 2),
            target: { reply_parameters: { message_id: USER_MESSAGE_ID } },
            runApiCall: (operation) => operation(),
            onDropped: (index) => dropped.push(index),
        });
        expect(sent[0] === null && sent[1]?.length === MAX_ALBUM_IMAGES, `one album of ${MAX_ALBUM_IMAGES} (got ${JSON.stringify(sent[1]?.length)})`);
        expect(dropped.length === 2 && dropped[0] === MAX_ALBUM_IMAGES, `the extras are reported (got ${JSON.stringify(dropped)})`);
    })
);

results.push(
    await runCase('no picture sent at all is an error, and every drop is reported', async () => {
        const telegram = createFakeTelegram({
            refuse: (call) =>
                call.method === 'sendPhoto' ||
                call.method === 'sendDocument' ||
                call.method === 'sendMediaGroup'
                    ? { error_code: 400, description: 'Bad Request: pictures refused' }
                    : null,
        });
        const dropped: number[] = [];
        const sent = await sendReplyImagesMessage({
            api: telegram.api,
            chatId: CHAT_ID,
            images: uploads(2),
            target: { reply_parameters: { message_id: USER_MESSAGE_ID } },
            runApiCall: (operation) => operation(),
            onDropped: (index) => dropped.push(index),
        });
        expect(sent[0] !== null && sent[1] === undefined, 'an error when nothing went out');
        expect(dropped.length === 2, `both pictures are reported dropped (got ${JSON.stringify(dropped)})`);
    })
);

reportResults(results);
