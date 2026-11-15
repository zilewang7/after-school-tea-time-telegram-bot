/**
 * Offline cases for the v5 reply media model on the version/replay side:
 * finalize writes the three delivery forms into the version, media_cache,
 * message_media and the bot row; version switching and the final-state refresh
 * re-deliver the stored pictures (single image, album, text-less pictures) and
 * rewrite the same places.
 *
 * The pictures here are tiny buffers whose signatures the sniffer accepts; no
 * Telegram traffic leaves the process (the fake Api transformer answers every
 * call). Every project module is imported after the env is set and the scratch
 * database is in place.
 *
 * Run: npx tsx scripts/offline/version-media.mts
 */
process.env.BOT_USER_ID = '7777';
process.env.BOT_NAME = 'OfflineBot';
process.env.WEBAPP_PUBLIC_URL = 'https://miniapp.test';
delete process.env.WIDGET_RENDER_URL;
delete process.env.STICKER_SET_NAME;

import {
    expect,
    reportResults,
    runCase,
    setupOfflineDb,
    takeMessageId,
    type CaseResult,
} from './harness.mts';
import type { BotResponse, ResponseVersion } from '../../src/db/botResponseDTO.js';

const db = await setupOfflineDb();
const dbIndex = await import('../../src/db/index.js');
const responseHandler = await import('../../src/reply/response-handler.js');
const botMessageService = await import('../../src/services/bot-message-service.js');
const { createFakeTelegram, contextOf, messageUpdate } = await import('./fake-telegram.mts');
const { putCachedMedia } = await import('../../src/services/media-cache-service.js');
const { replyMediaKeyOf } = await import('../../src/shared/reply-media.js');
const { ReplyMetric } = await import('../../src/db/replyMetricDTO.js');
const { MediaCache } = await import('../../src/db/mediaCacheDTO.js');

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : {};

/** The array's length, or undefined when the value is not an array (no cast) */
const listLengthOf = (value: unknown): number | undefined => (Array.isArray(value) ? value.length : undefined);

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

const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlZkAAAAASUVORK5CYII=',
    'base64'
);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF offline jpeg')]);
/** Different pictures for one reply: the cache is content-addressed, so they must differ */
const pictureBytes = (label: string): Buffer => Buffer.concat([PNG_BYTES, Buffer.from(`-${label}`)]);

const startSession = async (chatId: number) => {
    const userMessageId = takeMessageId();
    const telegram = createFakeTelegram();
    const ctx = contextOf(
        messageUpdate({ chatId, messageId: userMessageId, userId: 42, text: '画一张图' }),
        telegram
    );
    const { result: chatContext } = await captureConsole(() =>
        responseHandler.createChatContext(ctx, { model: 'offline-model' })
    );
    if (!chatContext) throw new Error('the chat context was not created');
    return { telegram, ctx, chatContext, userMessageId, firstMessageId: chatContext.session.firstMessageId };
};

/** Finalize a session and stop its typing interval (no delivery stops it here) */
const finalize = async (
    chatContext: Awaited<ReturnType<typeof startSession>>['chatContext'],
    options?: Parameters<Awaited<ReturnType<typeof startSession>>['chatContext']['session']['finalize']>[0]
): Promise<void> => {
    try {
        await chatContext.session.finalize(options);
    } finally {
        chatContext.editor.stop();
        chatContext.typing.stop();
    }
};

const storedVersionOf = async (chatId: number, firstMessageId: number): Promise<ResponseVersion | undefined> =>
    (await dbIndex.getBotResponse(chatId, firstMessageId))?.getVersions().at(-1);

const rowOf = (chatId: number, messageId: number) => db.Message.findOne({ where: { chatId, messageId } });

const metricsOf = (chatId: number, firstMessageId: number) =>
    ReplyMetric.findOne({ where: { chatId, firstMessageId } });

const seedRow = async (
    input: { chatId: number; messageId: number } & Partial<{
        text: string;
        file: Buffer;
        fileMime: string;
        fileUniqueId: string;
        replyToId: number;
    }>
): Promise<void> => {
    await db.Message.create({
        chatId: input.chatId,
        messageId: input.messageId,
        fromBotSelf: true,
        userId: 7777,
        userName: 'OfflineBot',
        date: new Date(),
        text: input.text ?? null,
        file: input.file ?? null,
        fileMime: input.fileMime ?? null,
        fileUniqueId: input.fileUniqueId ?? null,
        replyToId: input.replyToId ?? null,
    });
};

/** A stored reply with the given versions; the last one is current unless told otherwise */
const seedResponse = async (options: {
    chatId: number;
    firstMessageId: number;
    userMessageId: number;
    versions: Array<Partial<ResponseVersion>>;
    currentVersionIndex?: number;
    buttonState?: BotResponse['buttonState'];
}): Promise<void> => {
    const versions: ResponseVersion[] = options.versions.map((version, index) => ({
        versionId: index + 1,
        createdAt: new Date().toISOString(),
        messageIds: [options.firstMessageId],
        currentMessageId: options.firstMessageId,
        text: '',
        wasStoppedByUser: false,
        ...version,
    }));
    await dbIndex.BotResponse.create({
        messageId: options.firstMessageId,
        chatId: options.chatId,
        userMessageId: options.userMessageId,
        currentVersionIndex: options.currentVersionIndex ?? versions.length - 1,
        versions: JSON.stringify(versions),
        buttonState: options.buttonState ?? dbIndex.ButtonState.NONE,
        metadata: JSON.stringify({ model: 'offline-model', hasImage: false }),
    });
};

/** Let a fire-and-forget cache-touch save reach the database */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

/** Put one picture in media_cache and return its content-addressed key */
const cachePicture = async (picture: Buffer): Promise<string> => {
    const mediaKey = replyMediaKeyOf(picture);
    await putCachedMedia({ fileUniqueId: mediaKey, mime: 'image/png', kind: 'photo', data: picture, sizeBytes: picture.length });
    return mediaKey;
};

/** A stored version's attachment entry for one cached picture */
const attachmentMediaOf = (mediaKey: string, sizeBytes: number, caption?: string) => ({
    placement: 'attachment' as const,
    mediaKey,
    mimeType: 'image/png',
    sizeBytes,
    ...(caption === undefined ? {} : { caption }),
});

/** A 400 for any sending call: a switch's media can never reach the chat */
const refusingMediaSends = (call: { readonly method: string; readonly payload: Readonly<Record<string, unknown>> }) =>
    ['sendMediaGroup', 'sendPhoto', 'sendDocument', 'sendAnimation'].includes(call.method)
        ? { error_code: 400, description: 'Bad Request: offline test refuses media sends' }
        : null;

const cases: Array<{ name: string; body: () => Promise<void> }> = [
    {
        name: 'finalize: one static attachment keeps the legacy image slot and also writes media[]',
        body: async () => {
            const chatId = -1009300000001;
            const { chatContext } = await startSession(chatId);
            const session = chatContext.session;
            const photoId = takeMessageId();
            session.textBuffer = '画好了';
            session.messageIds.push(photoId);
            session.currentMessageId = photoId;
            session.mediaMessageIds = [photoId];
            session.images = [JPEG_BYTES];
            session.imageCaptions = ['**配文**'];

            await finalize(chatContext);

            const version = await storedVersionOf(chatId, session.firstMessageId);
            const media = version?.media ?? [];
            expect(version?.imageBase64 === JPEG_BYTES.toString('base64'), 'the legacy slot keeps the picture');
            expect(version?.imageCaption === '**配文**', `the legacy caption is stored (got ${version?.imageCaption})`);
            expect(version?.delivery === undefined, 'a plain reply has no rich delivery form');
            expect(
                media.length === 1 && media[0]?.placement === 'attachment'
                    && media[0]?.mediaKey === replyMediaKeyOf(JPEG_BYTES)
                    && media[0]?.mimeType === 'image/jpeg'
                    && media[0]?.caption === '**配文**',
                `media[] describes the delivered picture (got ${JSON.stringify(media)})`
            );
            expect(
                JSON.stringify(version?.mediaMessageIds) === JSON.stringify([photoId]),
                `the picture message is recorded (got ${JSON.stringify(version?.mediaMessageIds)})`
            );

            const row = await rowOf(chatId, session.firstMessageId);
            expect(
                row?.file?.equals(JPEG_BYTES) === true && row.fileMime === 'image/jpeg' && row.fileUniqueId === null,
                'the legacy row keeps the bytes in its own slot'
            );
            expect((await dbIndex.listMessageMedia(chatId, session.firstMessageId)).length === 1, 'message_media has the picture');
            expect((await metricsOf(chatId, session.firstMessageId))?.imageCount === 1, 'the metric counts the delivered picture');
            const cached = await MediaCache.findByPk(replyMediaKeyOf(JPEG_BYTES));
            expect(cached?.data?.equals(JPEG_BYTES) === true, 'the bytes are in media_cache once');
        },
    },
    {
        name: 'finalize: several attachments write media[] only, the row points at the first cache key',
        body: async () => {
            const chatId = -1009300000002;
            const { chatContext } = await startSession(chatId);
            const session = chatContext.session;
            const labels = ['a', 'b', 'c'];
            const ids = labels.map(() => takeMessageId());
            session.textBuffer = '三张图';
            session.messageIds.push(...ids);
            session.currentMessageId = session.firstMessageId;
            session.mediaMessageIds = ids;
            session.images = labels.map(pictureBytes);
            session.imageCaptions = ['一', undefined, '三'];

            await finalize(chatContext);

            const version = await storedVersionOf(chatId, session.firstMessageId);
            const media = version?.media ?? [];
            expect(version?.imageBase64 === undefined, 'a multi-picture version does not write the legacy slot');
            expect(media.length === 3 && media.every((item) => item.placement === 'attachment'), 'every picture is an attachment');
            expect(
                media.map((item) => item.mediaKey).join(',') === labels.map((label) => replyMediaKeyOf(pictureBytes(label))).join(','),
                'media[] keeps delivery order and content-addressed keys'
            );
            expect(version?.currentMessageId === session.firstMessageId, 'the text message carries the buttons');
            expect(
                JSON.stringify(version?.mediaMessageIds) === JSON.stringify(ids),
                `the album ids are all recorded (got ${JSON.stringify(version?.mediaMessageIds)})`
            );

            const row = await rowOf(chatId, session.firstMessageId);
            expect(
                row !== null && row.file === null && row.fileUniqueId === media[0]?.mediaKey && row.fileMime === 'image/png',
                `the row points at the first picture (got ${JSON.stringify({ file: row?.file, key: row?.fileUniqueId })})`
            );
            const rows = await dbIndex.listMessageMedia(chatId, session.firstMessageId);
            expect(
                rows.map((item) => item.ordinal).join(',') === '1,2,3' && rows[1]?.caption === undefined,
                `message_media follows the delivery order (got ${JSON.stringify(rows)})`
            );
            expect((await metricsOf(chatId, session.firstMessageId))?.imageCount === 3, 'the metric counts three pictures');
            for (const label of labels) {
                expect(
                    (await MediaCache.findByPk(replyMediaKeyOf(pictureBytes(label))))?.data?.equals(pictureBytes(label)) === true,
                    `picture ${label} is cached once`
                );
            }
        },
    },
    {
        name: 'finalize: a rich L1 reply stores delivery, snapshot and inline-then-attachment media',
        body: async () => {
            const chatId = -1009300000003;
            const { chatContext } = await startSession(chatId);
            const session = chatContext.session;
            const albumId = takeMessageId();
            const inlineOne = pictureBytes('inline-1');
            const inlineTwo = pictureBytes('inline-2');
            const trailing = pictureBytes('trailing');
            session.textBuffer = '先来一段，再来一张。';
            session.messageIds.push(albumId);
            session.currentMessageId = session.firstMessageId;
            session.mediaMessageIds = [albumId];
            session.inlineMedia = [
                { placement: 'inline', id: 'img1', data: inlineOne, mimeType: 'image/png', caption: '第一张' },
                { placement: 'inline', id: 'img2', data: inlineTwo, mimeType: 'image/png' },
            ];
            session.inlineDelivery = 'rich';
            session.richAnswerMarkdown = '先来一段，再来一张。\n\n![](tg://photo?id=img1 "第一张")';
            session.images = [trailing];

            await finalize(chatContext);

            const version = await storedVersionOf(chatId, session.firstMessageId);
            expect(version?.delivery === 'rich', `the delivery form is stored (got ${version?.delivery})`);
            expect(version?.richRenderer === 'v1', 'the renderer generation is stored');
            expect(version?.richAnswerMarkdown === session.richAnswerMarkdown, 'the answer snapshot is stored');
            expect(version?.imageBase64 === undefined, 'an inline-picture version does not write the legacy slot');
            const media = version?.media ?? [];
            expect(
                media.map((item) => `${item.placement}:${item.id ?? '-'}`).join(',') === 'inline:img1,inline:img2,attachment:-',
                `inline pictures come first in media[] (got ${JSON.stringify(media.map((item) => item.placement))})`
            );
            expect(
                media[0]?.caption === '第一张' && media[2]?.mediaKey === replyMediaKeyOf(trailing),
                'each picture keeps its caption and cache key'
            );
            const row = await rowOf(chatId, session.firstMessageId);
            expect(
                row?.file === null && row.fileUniqueId === media[0]?.mediaKey,
                'the row points at the first (inline) picture'
            );
            const rows = await dbIndex.listMessageMedia(chatId, session.firstMessageId);
            expect(
                rows.map((item) => item.placement).join(',') === 'inline,inline,attachment',
                `message_media keeps the placements (got ${JSON.stringify(rows.map((item) => item.placement))})`
            );
            expect((await metricsOf(chatId, session.firstMessageId))?.imageCount === 3, 'the metric counts inline and trailing pictures');
        },
    },
    {
        name: 'finalize: a rich L2 fallback stores rich-text and all pictures as attachments',
        body: async () => {
            const chatId = -1009300000004;
            const { chatContext } = await startSession(chatId);
            const session = chatContext.session;
            const ids = [takeMessageId(), takeMessageId()];
            const pictures = [pictureBytes('l2-a'), pictureBytes('l2-b')];
            session.textBuffer = '只能把图放在下面了。';
            session.messageIds.push(...ids);
            session.currentMessageId = session.firstMessageId;
            session.mediaMessageIds = ids;
            session.inlineMedia = [];
            session.inlineDelivery = 'attachments';
            session.richAnswerMarkdown = '只能把图放在下面了。\n\n（另有 2 张图未能内嵌发送）';
            session.images = pictures;
            session.imageCaptions = ['甲', '乙'];

            await finalize(chatContext);

            const version = await storedVersionOf(chatId, session.firstMessageId);
            expect(version?.delivery === 'rich-text', `the fallback keeps the rich body (got ${version?.delivery})`);
            expect(
                version?.richAnswerMarkdown === session.richAnswerMarkdown,
                'the snapshot is the body actually sent (without media blocks)'
            );
            expect(
                (version?.media ?? []).length === 2 && (version?.media ?? []).every((item) => item.placement === 'attachment'),
                'every picture is a trailing attachment'
            );
            expect(version?.imageBase64 === undefined, 'two pictures do not use the legacy slot');
        },
    },
    {
        name: 'finalize: an errored reply stores no pictures and clears the message_media rows',
        body: async () => {
            const chatId = -1009300000005;
            const { chatContext } = await startSession(chatId);
            const session = chatContext.session;
            await dbIndex.replaceMessageMedia(chatId, session.firstMessageId, [
                {
                    ordinal: 1,
                    mediaKey: replyMediaKeyOf(pictureBytes('stale')),
                    mimeType: 'image/png',
                    sizeBytes: 10,
                    placement: 'attachment',
                },
            ]);
            session.textBuffer = '答到一半';
            session.images = [pictureBytes('never-sent')];
            session.mediaMessageIds = [takeMessageId()];

            await finalize(chatContext, { errorMessage: 'upstream exploded', errorKind: 'other' });

            const version = await storedVersionOf(chatId, session.firstMessageId);
            expect(version?.media === undefined && version?.delivery === undefined, 'an errored version stores no pictures');
            expect(version?.imageBase64 === undefined && version?.mediaMessageIds === undefined, 'and no picture slots either');
            expect(
                (await dbIndex.listMessageMedia(chatId, session.firstMessageId)).length === 0,
                'the previous picture rows cannot survive an error version'
            );
            const row = await rowOf(chatId, session.firstMessageId);
            expect(row?.file === null && row.fileUniqueId === null, 'the row has no picture');
            expect((await metricsOf(chatId, session.firstMessageId))?.imageCount === 0, 'the metric counts nothing');
        },
    },
    {
        name: 'finalize: an already cached picture is touched, not stored twice',
        body: async () => {
            const chatId = -1009300000006;
            const bytes = pictureBytes('shared');
            const mediaKey = replyMediaKeyOf(bytes);
            await putCachedMedia({ fileUniqueId: mediaKey, mime: 'image/png', kind: 'photo', data: bytes, sizeBytes: bytes.length });
            const cached = await MediaCache.findByPk(mediaKey);
            if (cached) {
                cached.lastUsedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
                await cached.save();
            }
            const { chatContext } = await startSession(chatId);
            const session = chatContext.session;
            session.textBuffer = '同一张图';
            session.images = [bytes];
            await finalize(chatContext);
            await settle();

            expect(await MediaCache.count({ where: { fileUniqueId: mediaKey } }) === 1, 'the content-addressed row is reused');
            const touched = await MediaCache.findByPk(mediaKey);
            expect(
                touched !== null && touched.lastUsedAt.getTime() > cached!.lastUsedAt.getTime(),
                'a cache hit refreshes the LRU stamp'
            );
        },
    },
    {
        name: 'switchVersion: a legacy single picture switches to a two-picture album',
        body: async () => {
            const chatId = -1009300000007;
            const userMessageId = takeMessageId();
            const replyId = takeMessageId();
            const photoId = takeMessageId();
            const albumIds = [takeMessageId(), takeMessageId()];
            const albumPictures = [pictureBytes('sw-a'), pictureBytes('sw-b')];
            for (const [index, picture] of albumPictures.entries()) {
                await putCachedMedia({
                    fileUniqueId: replyMediaKeyOf(picture),
                    mime: 'image/png',
                    kind: 'photo',
                    data: picture,
                    sizeBytes: picture.length,
                });
                void index;
            }
            await seedResponse({
                chatId,
                firstMessageId: replyId,
                userMessageId,
                currentVersionIndex: 0,
                versions: [
                    { text: '第一版', messageIds: [replyId, photoId], currentMessageId: photoId, imageBase64: PNG_BYTES.toString('base64'), imageCaption: '配文' },
                    {
                        text: '第二版',
                        messageIds: [replyId, ...albumIds],
                        currentMessageId: replyId,
                        media: albumPictures.map((picture, index) => ({
                            placement: 'attachment' as const,
                            mediaKey: replyMediaKeyOf(picture),
                            mimeType: 'image/png',
                            sizeBytes: picture.length,
                            ...(index === 0 ? { caption: '第一张' } : {}),
                        })),
                        mediaMessageIds: albumIds,
                    },
                ],
            });
            await seedRow({ chatId, messageId: replyId, text: '第一版\n\n配文', file: PNG_BYTES, fileMime: 'image/png' });

            const telegram = createFakeTelegram();
            const ctx = contextOf(messageUpdate({ chatId, messageId: takeMessageId(), userId: 42, text: '切换' }), telegram);
            const { result: switched, lines } = await captureConsole(() => botMessageService.switchVersion(ctx, replyId, 'next'));
            expect(switched, `the switch succeeded (log: ${lines.slice(-3).join(' | ')})`);
            expect(
                telegram.callsOf('deleteMessage').some((call) => call.payload.message_id === photoId),
                'the old single picture message is deleted'
            );
            const sentAlbumIndex = telegram.calls.findIndex((call) => call.method === 'sendMediaGroup');
            const deletedOldIndex = telegram.calls.findIndex(
                (call) => call.method === 'deleteMessage' && call.payload.message_id === photoId
            );
            expect(
                sentAlbumIndex >= 0 && deletedOldIndex > sentAlbumIndex,
                'the old picture goes only after the album is sent (a failed send keeps it)'
            );
            const albumCall = telegram.callsOf('sendMediaGroup')[0];
            const albumMedia = asRecord(albumCall?.payload).media;
            expect(
                listLengthOf(albumMedia) === 2,
                `one album of two pictures (got ${String(listLengthOf(albumMedia))})`
            );

            const stored = await dbIndex.getBotResponse(chatId, replyId);
            const version = stored?.getVersions()[1];
            const sentIds = version?.mediaMessageIds ?? [];
            expect(sentIds.length === 2, `the album ids are stored (got ${JSON.stringify(sentIds)})`);
            expect(version?.currentMessageId === replyId, 'the text message carries the buttons');
            expect(
                version?.messageIds[0] === replyId && version.messageIds.length === 3 && sentIds.every((id) => version.messageIds.includes(id)),
                `the text first, then the album ids (got ${JSON.stringify(version?.messageIds)})`
            );
            const row = await rowOf(chatId, replyId);
            expect(
                row !== null && row.file === null && row.fileUniqueId === replyMediaKeyOf(albumPictures[0]!),
                `the row points at the album's first picture (got ${JSON.stringify({ file: row?.file, key: row?.fileUniqueId })})`
            );
            const mediaRows = await dbIndex.listMessageMedia(chatId, replyId);
            expect(mediaRows.length === 2 && mediaRows[1]?.ordinal === 2, `message_media follows the new version (got ${JSON.stringify(mediaRows)})`);
        },
    },
    {
        name: 'switchVersion: a two-picture album switches back to the legacy single picture',
        body: async () => {
            const chatId = -1009300000008;
            const userMessageId = takeMessageId();
            const replyId = takeMessageId();
            const albumIds = [takeMessageId(), takeMessageId()];
            const legacyPhotoId = takeMessageId();
            const albumPictures = [pictureBytes('back-a'), pictureBytes('back-b')];
            for (const picture of albumPictures) {
                await putCachedMedia({
                    fileUniqueId: replyMediaKeyOf(picture),
                    mime: 'image/png',
                    kind: 'photo',
                    data: picture,
                    sizeBytes: picture.length,
                });
            }
            await seedResponse({
                chatId,
                firstMessageId: replyId,
                userMessageId,
                currentVersionIndex: 0,
                versions: [
                    {
                        text: '相册版',
                        messageIds: [replyId, ...albumIds],
                        currentMessageId: replyId,
                        media: albumPictures.map((picture) => ({
                            placement: 'attachment' as const,
                            mediaKey: replyMediaKeyOf(picture),
                            mimeType: 'image/png',
                            sizeBytes: picture.length,
                        })),
                        mediaMessageIds: albumIds,
                    },
                    {
                        text: '单图版',
                        messageIds: [replyId, legacyPhotoId],
                        currentMessageId: legacyPhotoId,
                        imageBase64: JPEG_BYTES.toString('base64'),
                        imageCaption: '唯一的图',
                    },
                ],
            });
            await seedRow({ chatId, messageId: replyId, text: '相册版' });
            const telegram = createFakeTelegram();
            const ctx = contextOf(messageUpdate({ chatId, messageId: takeMessageId(), userId: 42, text: '切换' }), telegram);
            const { result: switched, lines } = await captureConsole(() => botMessageService.switchVersion(ctx, replyId, 'next'));
            expect(switched, `the switch succeeded (log: ${lines.slice(-3).join(' | ')})`);
            expect(
                albumIds.every((id) => telegram.callsOf('deleteMessage').some((call) => call.payload.message_id === id)),
                'every old album picture message is deleted'
            );
            const photoCall = telegram.callsOf('sendPhoto')[0];
            expect(photoCall !== undefined, 'the legacy version re-sends its single picture');
            const version = (await dbIndex.getBotResponse(chatId, replyId))?.getVersions()[1];
            const newPhotoId = version?.messageIds[1];
            expect(newPhotoId !== undefined && version?.currentMessageId === newPhotoId, 'the single picture carries the buttons');
            const row = await rowOf(chatId, replyId);
            expect(
                row?.file?.equals(JPEG_BYTES) === true && row.fileUniqueId === null,
                'the legacy single picture keeps the old BLOB row'
            );
            expect(
                (await dbIndex.listMessageMedia(chatId, replyId)).length === 0,
                'the album rows are cleared for the legacy version'
            );
        },
    },
    {
        name: 'switchVersion: a version that lost one picture keeps only the shown one and its buttons',
        body: async () => {
            const chatId = -1009300000016;
            const userMessageId = takeMessageId();
            const replyId = takeMessageId();
            const kept = pictureBytes('kept');
            const lost = pictureBytes('lost-bytes');
            // Only the first picture's bytes are still cached: the other one is skipped
            await putCachedMedia({
                fileUniqueId: replyMediaKeyOf(kept),
                mime: 'image/png',
                kind: 'photo',
                data: kept,
                sizeBytes: kept.length,
            });
            await seedResponse({
                chatId,
                firstMessageId: replyId,
                userMessageId,
                currentVersionIndex: 0,
                versions: [
                    { text: '旧版只有文字', messageIds: [replyId], currentMessageId: replyId },
                    {
                        text: '新版带两张图',
                        messageIds: [replyId],
                        currentMessageId: replyId,
                        media: [kept, lost].map((picture) => ({
                            placement: 'attachment' as const,
                            mediaKey: replyMediaKeyOf(picture),
                            mimeType: 'image/png',
                            sizeBytes: picture.length,
                        })),
                    },
                ],
            });
            await seedRow({ chatId, messageId: replyId, text: '旧版只有文字' });

            const telegram = createFakeTelegram();
            const ctx = contextOf(messageUpdate({ chatId, messageId: takeMessageId(), userId: 42, text: '切换' }), telegram);
            const { result: switched, lines } = await captureConsole(() => botMessageService.switchVersion(ctx, replyId, 'next'));
            expect(switched, `the switch succeeded (log: ${lines.slice(-3).join(' | ')})`);
            expect(telegram.callsOf('sendMediaGroup').length === 0, 'one remaining picture is not an album');
            expect(telegram.callsOf('sendPhoto').length === 1, `the remaining picture is sent (got ${telegram.callsOf('sendPhoto').length})`);
            const version = (await dbIndex.getBotResponse(chatId, replyId))?.getVersions()[1];
            expect(version?.mediaMessageIds?.length === 1, `only the re-sent picture is listed (got ${JSON.stringify(version?.mediaMessageIds)})`);
            // The stored version now has one picture, so the live single-picture
            // rule applies: the picture carries the buttons
            expect(
                version?.currentMessageId === version?.mediaMessageIds?.[0],
                `the remaining picture is the carrier (got ${String(version?.currentMessageId)})`
            );
            const markup = telegram.callsOf('editMessageReplyMarkup').at(-1);
            expect(
                asRecord(markup?.payload).message_id === version?.mediaMessageIds?.[0],
                `the buttons land on the remaining picture (got ${JSON.stringify(markup?.payload.message_id)})`
            );
        },
    },
    {
        name: 'switchVersion: a text-less picture version sends one message per picture with the buttons last',
        body: async () => {
            const chatId = -1009300000017;
            const userMessageId = takeMessageId();
            const replyId = takeMessageId();
            const pictures = [pictureBytes('plain-a'), pictureBytes('plain-b')];
            for (const picture of pictures) {
                await putCachedMedia({
                    fileUniqueId: replyMediaKeyOf(picture),
                    mime: 'image/png',
                    kind: 'photo',
                    data: picture,
                    sizeBytes: picture.length,
                });
            }
            await seedResponse({
                chatId,
                firstMessageId: replyId,
                userMessageId,
                currentVersionIndex: 0,
                versions: [
                    { text: '文字版', messageIds: [replyId], currentMessageId: replyId },
                    {
                        text: '',
                        messageIds: [replyId],
                        currentMessageId: replyId,
                        media: pictures.map((picture) => ({
                            placement: 'attachment' as const,
                            mediaKey: replyMediaKeyOf(picture),
                            mimeType: 'image/png',
                            sizeBytes: picture.length,
                        })),
                    },
                ],
            });
            await seedRow({ chatId, messageId: replyId, text: '文字版' });

            const telegram = createFakeTelegram();
            const ctx = contextOf(messageUpdate({ chatId, messageId: takeMessageId(), userId: 42, text: '切换' }), telegram);
            const { result: switched, lines } = await captureConsole(() => botMessageService.switchVersion(ctx, replyId, 'next'));
            expect(switched, `the switch succeeded (log: ${lines.slice(-3).join(' | ')})`);
            expect(telegram.callsOf('sendMediaGroup').length === 0, 'a text-less reply uses no album (no message for the keyboard)');
            expect(telegram.callsOf('sendPhoto').length === 2, `both pictures are sent one by one (got ${telegram.callsOf('sendPhoto').length})`);
            const version = (await dbIndex.getBotResponse(chatId, replyId))?.getVersions()[1];
            const pictureIds = version?.mediaMessageIds ?? [];
            expect(pictureIds.length === 2, `both picture messages are listed (got ${JSON.stringify(pictureIds)})`);
            expect(
                version?.currentMessageId === pictureIds[pictureIds.length - 1],
                'the last picture carries the buttons'
            );
            const markup = telegram.callsOf('editMessageReplyMarkup').at(-1);
            expect(
                asRecord(markup?.payload).message_id === version?.currentMessageId,
                `the buttons land on the last picture (got ${JSON.stringify(markup?.payload.message_id)})`
            );
        },
    },
    {
        name: 'refresh: a text reply with an album edits its text message and keeps the pictures',
        body: async () => {
            const chatId = -1009300000009;
            const userMessageId = takeMessageId();
            const replyId = takeMessageId();
            const albumIds = [takeMessageId(), takeMessageId()];
            const pictures = [pictureBytes('ref-a'), pictureBytes('ref-b')];
            for (const picture of pictures) {
                await putCachedMedia({
                    fileUniqueId: replyMediaKeyOf(picture),
                    mime: 'image/png',
                    kind: 'photo',
                    data: picture,
                    sizeBytes: picture.length,
                });
            }
            await seedResponse({
                chatId,
                firstMessageId: replyId,
                userMessageId,
                currentVersionIndex: 0,
                buttonState: dbIndex.ButtonState.HAS_VERSIONS,
                versions: [{
                    text: '正文回来了',
                    messageIds: [replyId, ...albumIds],
                    currentMessageId: replyId,
                    media: pictures.map((picture) => ({
                        placement: 'attachment' as const,
                        mediaKey: replyMediaKeyOf(picture),
                        mimeType: 'image/png',
                        sizeBytes: picture.length,
                    })),
                    mediaMessageIds: albumIds,
                }],
            });
            await seedRow({ chatId, messageId: replyId, text: '正文回来了' });

            const telegram = createFakeTelegram();
            const { result: refreshed, lines } = await captureConsole(() => botMessageService.refreshToFinalState(telegram.api, chatId, replyId));
            expect(refreshed, `the refresh succeeded (log: ${lines.slice(-3).join(' | ')})`);
            const edits = telegram.callsOf('editMessageText');
            expect(
                edits.length > 0 && edits.every((call) => call.payload.message_id === replyId),
                `only the text message is rewritten (got ${JSON.stringify(edits.map((call) => call.payload.message_id))})`
            );
            expect(telegram.callsOf('deleteMessage').length === 0, 'the album pictures are never deleted by a refresh');
            const markup = telegram.callsOf('editMessageReplyMarkup').at(-1);
            expect(asRecord(markup?.payload).message_id === replyId, `the buttons land on the text message (got ${JSON.stringify(markup?.payload.message_id)})`);
        },
    },
    {
        name: 'refresh: a text-less picture reply only re-applies its buttons',
        body: async () => {
            const chatId = -1009300000010;
            const userMessageId = takeMessageId();
            const replyId = takeMessageId();
            const pictureIds = [takeMessageId(), takeMessageId()];
            const pictures = [pictureBytes('only-a'), pictureBytes('only-b')];
            for (const picture of pictures) {
                await putCachedMedia({
                    fileUniqueId: replyMediaKeyOf(picture),
                    mime: 'image/png',
                    kind: 'photo',
                    data: picture,
                    sizeBytes: picture.length,
                });
            }
            await seedResponse({
                chatId,
                firstMessageId: replyId,
                userMessageId,
                currentVersionIndex: 0,
                buttonState: dbIndex.ButtonState.HAS_VERSIONS,
                versions: [{
                    text: '',
                    messageIds: pictureIds,
                    currentMessageId: pictureIds[1] ?? replyId,
                    media: pictures.map((picture) => ({
                        placement: 'attachment' as const,
                        mediaKey: replyMediaKeyOf(picture),
                        mimeType: 'image/png',
                        sizeBytes: picture.length,
                    })),
                    mediaMessageIds: pictureIds,
                }],
            });

            const telegram = createFakeTelegram();
            const { result: refreshed } = await captureConsole(() => botMessageService.refreshToFinalState(telegram.api, chatId, replyId));
            expect(refreshed, 'the refresh succeeded');
            expect(telegram.callsOf('editMessageText').length === 0, 'no text chunk is invented for a text-less reply');
            expect(telegram.callsOf('sendMessage').length === 0, 'no [Empty response] message is sent');
            const markup = telegram.callsOf('editMessageReplyMarkup').at(-1);
            expect(
                asRecord(markup?.payload).message_id === pictureIds[1],
                `the buttons land on the last picture (got ${JSON.stringify(markup?.payload.message_id)})`
            );
        },
    },
    {
        name: 'refresh: a legacy text-less picture version keeps its single message',
        body: async () => {
            const chatId = -1009300000015;
            const userMessageId = takeMessageId();
            const replyId = takeMessageId();
            await seedResponse({
                chatId,
                firstMessageId: replyId,
                userMessageId,
                currentVersionIndex: 0,
                buttonState: dbIndex.ButtonState.HAS_VERSIONS,
                versions: [{
                    text: '',
                    messageIds: [replyId],
                    currentMessageId: replyId,
                    imageBase64: PNG_BYTES.toString('base64'),
                }],
            });

            const telegram = createFakeTelegram();
            const { result: refreshed } = await captureConsole(() => botMessageService.refreshToFinalState(telegram.api, chatId, replyId));
            expect(refreshed, 'the refresh succeeded');
            expect(telegram.callsOf('editMessageText').length === 0, 'the picture message is not edited to text');
            expect(telegram.callsOf('sendMessage').length === 0, 'no [Empty response] message is invented');
            const markup = telegram.callsOf('editMessageReplyMarkup').at(-1);
            expect(asRecord(markup?.payload).message_id === replyId, 'the picture message keeps the buttons');
            const version = (await dbIndex.getBotResponse(chatId, replyId))?.getVersions()[0];
            expect(version?.messageIds.length === 1, `the message list stays one message (got ${JSON.stringify(version?.messageIds)})`);
        },
    },
    {
        name: 'startRetry: a text-less album version deletes all its picture messages',
        body: async () => {
            const chatId = -1009300000011;
            const userMessageId = takeMessageId();
            const replyId = takeMessageId();
            const pictureIds = [takeMessageId(), takeMessageId()];
            const pictures = [pictureBytes('retry-a'), pictureBytes('retry-b')];
            for (const picture of pictures) {
                await putCachedMedia({
                    fileUniqueId: replyMediaKeyOf(picture),
                    mime: 'image/png',
                    kind: 'photo',
                    data: picture,
                    sizeBytes: picture.length,
                });
            }
            await seedResponse({
                chatId,
                firstMessageId: replyId,
                userMessageId,
                currentVersionIndex: 0,
                versions: [{
                    text: '',
                    messageIds: pictureIds,
                    currentMessageId: pictureIds[1] ?? replyId,
                    media: pictures.map((picture) => ({
                        placement: 'attachment' as const,
                        mediaKey: replyMediaKeyOf(picture),
                        mimeType: 'image/png',
                        sizeBytes: picture.length,
                    })),
                    mediaMessageIds: pictureIds,
                }],
            });

            const telegram = createFakeTelegram();
            const ctx = contextOf(messageUpdate({ chatId, messageId: takeMessageId(), userId: 42, text: '重试' }), telegram);
            const { result: session } = await captureConsole(() => botMessageService.startRetry(ctx, replyId));
            expect(session !== null, 'the retry started');
            expect(
                pictureIds.every((id) => telegram.callsOf('deleteMessage').some((call) => call.payload.message_id === id)),
                `both picture messages are deleted (got ${JSON.stringify(telegram.callsOf('deleteMessage').map((call) => call.payload.message_id))})`
            );
        },
    },
    {
        name: 'switchVersion: a rich version replays its snapshot and uploads its inline pictures',
        body: async () => {
            const chatId = -1009300000012;
            const userMessageId = takeMessageId();
            const replyId = takeMessageId();
            const inlineOne = pictureBytes('replay-inline-1');
            const inlineTwo = pictureBytes('replay-inline-2');
            for (const picture of [inlineOne, inlineTwo]) {
                await putCachedMedia({
                    fileUniqueId: replyMediaKeyOf(picture),
                    mime: 'image/png',
                    kind: 'photo',
                    data: picture,
                    sizeBytes: picture.length,
                });
            }
            const snapshot = '答案段。\n\n![](tg://photo?id=img1 "第一张")\n\n![](tg://photo?id=img2)';
            await seedResponse({
                chatId,
                firstMessageId: replyId,
                userMessageId,
                currentVersionIndex: 0,
                versions: [
                    { text: '旧版只有文字', messageIds: [replyId], currentMessageId: replyId },
                    {
                        text: '答案段。',
                        messageIds: [replyId],
                        currentMessageId: replyId,
                        delivery: 'rich',
                        richRenderer: 'v1',
                        richAnswerMarkdown: snapshot,
                        media: [
                            { placement: 'inline', id: 'img1', mediaKey: replyMediaKeyOf(inlineOne), mimeType: 'image/png', sizeBytes: inlineOne.length, caption: '第一张' },
                            { placement: 'inline', id: 'img2', mediaKey: replyMediaKeyOf(inlineTwo), mimeType: 'image/png', sizeBytes: inlineTwo.length },
                        ],
                    },
                ],
            });
            await seedRow({ chatId, messageId: replyId, text: '旧版只有文字' });

            const telegram = createFakeTelegram();
            const ctx = contextOf(messageUpdate({ chatId, messageId: takeMessageId(), userId: 42, text: '切换' }), telegram);
            const { result: switched, lines } = await captureConsole(() => botMessageService.switchVersion(ctx, replyId, 'next'));
            expect(switched, `the switch succeeded (log: ${lines.slice(-3).join(' | ')})`);

            const richEdit = telegram.callsOf('editMessageText').find((call) => call.payload.rich_message !== undefined);
            const richMessage = asRecord(richEdit?.payload.rich_message);
            expect(
                typeof richMessage.markdown === 'string' && richMessage.markdown.includes('tg://photo?id=img1'),
                'the replayed body is the stored snapshot, media blocks included'
            );
            const richMedia = richMessage.media;
            expect(
                listLengthOf(richMedia) === 2,
                `both inline pictures travel with the edit (got ${String(listLengthOf(richMedia))})`
            );
            const version = (await dbIndex.getBotResponse(chatId, replyId))?.getVersions()[1];
            expect(version?.currentMessageId === replyId && version?.messageIds[0] === replyId, 'the same message shows the new version');
            const row = await rowOf(chatId, replyId);
            expect(
                row !== null && row.file === null && row.fileUniqueId === replyMediaKeyOf(inlineOne),
                'the row points at the first inline picture'
            );
        },
    },
    {
        name: 'switchVersion: a rich version with trailing pictures re-sends them as an album behind the body',
        body: async () => {
            const chatId = -1009300000013;
            const userMessageId = takeMessageId();
            const replyId = takeMessageId();
            const trailing = [pictureBytes('replay-album-a'), pictureBytes('replay-album-b')];
            for (const picture of trailing) {
                await putCachedMedia({
                    fileUniqueId: replyMediaKeyOf(picture),
                    mime: 'image/png',
                    kind: 'photo',
                    data: picture,
                    sizeBytes: picture.length,
                });
            }
            await seedResponse({
                chatId,
                firstMessageId: replyId,
                userMessageId,
                currentVersionIndex: 0,
                versions: [
                    { text: '旧版只有文字', messageIds: [replyId], currentMessageId: replyId },
                    {
                        text: '正文在这里。',
                        messageIds: [replyId],
                        currentMessageId: replyId,
                        delivery: 'rich-text',
                        richRenderer: 'v1',
                        richAnswerMarkdown: '正文在这里。',
                        media: trailing.map((picture) => ({
                            placement: 'attachment' as const,
                            mediaKey: replyMediaKeyOf(picture),
                            mimeType: 'image/png',
                            sizeBytes: picture.length,
                        })),
                    },
                ],
            });
            await seedRow({ chatId, messageId: replyId, text: '旧版只有文字' });

            const telegram = createFakeTelegram();
            const ctx = contextOf(messageUpdate({ chatId, messageId: takeMessageId(), userId: 42, text: '切换' }), telegram);
            const { result: switched, lines } = await captureConsole(() => botMessageService.switchVersion(ctx, replyId, 'next'));
            expect(switched, `the switch succeeded (log: ${lines.slice(-3).join(' | ')})`);

            const richEdit = telegram.callsOf('editMessageText').find((call) => call.payload.rich_message !== undefined);
            expect(asRecord(richEdit?.payload.rich_message).media === undefined, 'a snapshot without media blocks uploads no pictures with the body');
            const albumCall = telegram.callsOf('sendMediaGroup')[0];
            const albumMedia = asRecord(albumCall?.payload).media;
            expect(
                listLengthOf(albumMedia) === 2,
                `both trailing pictures go out as one album (got ${String(listLengthOf(albumMedia))})`
            );
            const version = (await dbIndex.getBotResponse(chatId, replyId))?.getVersions()[1];
            expect(version?.currentMessageId === replyId, 'the rich body carries the buttons');
            expect(
                (version?.mediaMessageIds ?? []).length === 2,
                `the album ids are stored (got ${JSON.stringify(version?.mediaMessageIds)})`
            );
            const markup = telegram.callsOf('editMessageReplyMarkup').at(-1);
            expect(asRecord(markup?.payload).message_id === replyId, `the buttons land on the rich body (got ${JSON.stringify(markup?.payload.message_id)})`);
            const mediaRows = await dbIndex.listMessageMedia(chatId, replyId);
            expect(mediaRows.length === 2, `message_media follows the replayed version (got ${mediaRows.length})`);
        },
    },
    {
        name: 'refresh: a rich inline-picture version re-edits the body with its contents preserved',
        body: async () => {
            const chatId = -1009300000014;
            const userMessageId = takeMessageId();
            const replyId = takeMessageId();
            const picture = pictureBytes('refresh-rich');
            await putCachedMedia({
                fileUniqueId: replyMediaKeyOf(picture),
                mime: 'image/png',
                kind: 'photo',
                data: picture,
                sizeBytes: picture.length,
            });
            const snapshot = '答案段。\n\n![](tg://photo?id=img1)';
            await seedResponse({
                chatId,
                firstMessageId: replyId,
                userMessageId,
                currentVersionIndex: 0,
                buttonState: dbIndex.ButtonState.HAS_VERSIONS,
                versions: [{
                    text: '答案段。',
                    messageIds: [replyId],
                    currentMessageId: replyId,
                    delivery: 'rich',
                    richRenderer: 'v1',
                    richAnswerMarkdown: snapshot,
                    media: [
                        { placement: 'inline', id: 'img1', mediaKey: replyMediaKeyOf(picture), mimeType: 'image/png', sizeBytes: picture.length },
                    ],
                }],
            });
            await seedRow({ chatId, messageId: replyId, text: '答案段。' });

            const telegram = createFakeTelegram();
            const { result: refreshed, lines } = await captureConsole(() => botMessageService.refreshToFinalState(telegram.api, chatId, replyId));
            expect(refreshed, `the refresh succeeded (log: ${lines.slice(-3).join(' | ')})`);
            const richEdit = telegram.callsOf('editMessageText').find((call) => call.payload.rich_message !== undefined);
            const richMessage = asRecord(richEdit?.payload.rich_message);
            expect(
                typeof richMessage.markdown === 'string' && richMessage.markdown.includes('tg://photo?id=img1'),
                'the refreshed body is the stored snapshot, never a re-render'
            );
            const richMedia = richMessage.media;
            expect(
                listLengthOf(richMedia) === 1,
                `the inline picture travels with the refresh (got ${String(listLengthOf(richMedia))})`
            );
            const version = (await dbIndex.getBotResponse(chatId, replyId))?.getVersions()[0];
            expect(version?.currentMessageId === replyId, 'the body message stays the carrier');
        },
    },
    {
        name: 'switchVersion: a refused rich body leaves the version and the old pictures untouched',
        body: async () => {
            const chatId = -1009300000201;
            const userMessageId = takeMessageId();
            const replyId = takeMessageId();
            const oldPictureId = takeMessageId();
            const oldPicture = pictureBytes('b3-old');
            const oldKey = await cachePicture(oldPicture);
            await seedResponse({
                chatId,
                firstMessageId: replyId,
                userMessageId,
                currentVersionIndex: 0,
                buttonState: dbIndex.ButtonState.HAS_VERSIONS,
                versions: [
                    {
                        text: '旧版正文',
                        messageIds: [replyId, oldPictureId],
                        currentMessageId: oldPictureId,
                        media: [attachmentMediaOf(oldKey, oldPicture.length)],
                        mediaMessageIds: [oldPictureId],
                    },
                    {
                        text: '新版正文',
                        messageIds: [replyId],
                        currentMessageId: replyId,
                        delivery: 'rich',
                        richRenderer: 'v1',
                        richAnswerMarkdown: '新版正文',
                    },
                ],
            });
            await seedRow({ chatId, messageId: replyId, text: '旧版正文' });

            const telegram = createFakeTelegram({
                refuse: (call) => (
                    call.method === 'editMessageText' && call.payload.rich_message !== undefined
                        ? { error_code: 400, description: 'Bad Request: offline test refuses the rich body' }
                        : null
                ),
            });
            const ctx = contextOf(messageUpdate({ chatId, messageId: takeMessageId(), userId: 42, text: '切换' }), telegram);
            const { result: switched, lines } = await captureConsole(() => botMessageService.switchVersion(ctx, replyId, 'next'));
            expect(switched === false, `the switch fails when the rich body is refused (got ${String(switched)}; log: ${lines.slice(-2).join(' | ')})`);
            expect(
                telegram.callsOf('deleteMessage').length === 0,
                `the old picture message is not deleted (got ${JSON.stringify(telegram.callsOf('deleteMessage').map((call) => call.payload.message_id))})`
            );
            const response = await dbIndex.getBotResponse(chatId, replyId);
            expect(response?.currentVersionIndex === 0, `the current version is unchanged (got ${String(response?.currentVersionIndex)})`);
            const versions = response?.getVersions() ?? [];
            expect(
                JSON.stringify(versions[0]?.mediaMessageIds) === JSON.stringify([oldPictureId]),
                `the old version keeps its picture message (got ${JSON.stringify(versions[0]?.mediaMessageIds)})`
            );
            expect(versions[1]?.mediaMessageIds === undefined && versions[1]?.messageIds.length === 1, 'the new version was not saved');
        },
    },
    {
        name: 'switchVersion: a rich body without its trailing pictures is not saved',
        body: async () => {
            const chatId = -1009300000202;
            const userMessageId = takeMessageId();
            const replyId = takeMessageId();
            const pictures = [pictureBytes('b3-rich-a'), pictureBytes('b3-rich-b')];
            const keyA = await cachePicture(pictures[0]!);
            const keyB = await cachePicture(pictures[1]!);
            await seedResponse({
                chatId,
                firstMessageId: replyId,
                userMessageId,
                currentVersionIndex: 0,
                buttonState: dbIndex.ButtonState.HAS_VERSIONS,
                versions: [
                    { text: '旧版正文', messageIds: [replyId], currentMessageId: replyId },
                    {
                        text: '新版正文',
                        messageIds: [replyId],
                        currentMessageId: replyId,
                        delivery: 'rich-text',
                        richRenderer: 'v1',
                        richAnswerMarkdown: '新版正文',
                        media: [
                            attachmentMediaOf(keyA, pictures[0]!.length),
                            attachmentMediaOf(keyB, pictures[1]!.length),
                        ],
                    },
                ],
            });
            await seedRow({ chatId, messageId: replyId, text: '旧版正文' });

            const telegram = createFakeTelegram({ refuse: refusingMediaSends });
            const ctx = contextOf(messageUpdate({ chatId, messageId: takeMessageId(), userId: 42, text: '切换' }), telegram);
            const { result: switched, lines } = await captureConsole(() => botMessageService.switchVersion(ctx, replyId, 'next'));
            expect(switched === false, `the switch fails when the pictures cannot be sent (got ${String(switched)}; log: ${lines.slice(-2).join(' | ')})`);
            const response = await dbIndex.getBotResponse(chatId, replyId);
            expect(response?.currentVersionIndex === 0, `the current version is unchanged (got ${String(response?.currentVersionIndex)})`);
            const newVersion = response?.getVersions()[1];
            expect(
                newVersion?.mediaMessageIds === undefined,
                `no version with media but no picture messages is saved (got ${JSON.stringify(newVersion?.mediaMessageIds)})`
            );
        },
    },
    {
        name: 'switchVersion: an entities version whose pictures cannot be sent is not saved and keeps the old pictures',
        body: async () => {
            const chatId = -1009300000203;
            const userMessageId = takeMessageId();
            const replyId = takeMessageId();
            const oldPictureId = takeMessageId();
            const oldPicture = pictureBytes('m2-old-picture');
            const oldKey = await cachePicture(oldPicture);
            const pictures = [pictureBytes('m2-entity-a'), pictureBytes('m2-entity-b')];
            const keys = [await cachePicture(pictures[0]!), await cachePicture(pictures[1]!)];
            await seedResponse({
                chatId,
                firstMessageId: replyId,
                userMessageId,
                currentVersionIndex: 0,
                buttonState: dbIndex.ButtonState.HAS_VERSIONS,
                versions: [
                    {
                        text: '旧版正文',
                        messageIds: [replyId, oldPictureId],
                        currentMessageId: replyId,
                        media: [attachmentMediaOf(oldKey, oldPicture.length)],
                        mediaMessageIds: [oldPictureId],
                    },
                    {
                        text: '新版带两张图',
                        messageIds: [replyId],
                        currentMessageId: replyId,
                        media: pictures.map((picture, index) => attachmentMediaOf(keys[index]!, picture.length)),
                    },
                ],
            });
            await seedRow({ chatId, messageId: replyId, text: '旧版正文' });

            const telegram = createFakeTelegram({ refuse: refusingMediaSends });
            const ctx = contextOf(messageUpdate({ chatId, messageId: takeMessageId(), userId: 42, text: '切换' }), telegram);
            const { result: switched, lines } = await captureConsole(() => botMessageService.switchVersion(ctx, replyId, 'next'));
            expect(switched === false, `the switch fails when the media cannot be sent (got ${String(switched)}; log: ${lines.slice(-2).join(' | ')})`);
            const response = await dbIndex.getBotResponse(chatId, replyId);
            expect(response?.currentVersionIndex === 0, `the current version is unchanged (got ${String(response?.currentVersionIndex)})`);
            expect(
                response?.getVersions()[1]?.mediaMessageIds === undefined,
                'the new version was not saved with its picture messages missing'
            );
            expect(
                !telegram.callsOf('deleteMessage').some((call) => call.payload.message_id === oldPictureId),
                'the old picture message is not deleted by a failed switch'
            );
            expect(
                JSON.stringify(response?.getVersions()[0]?.mediaMessageIds) === JSON.stringify([oldPictureId]),
                'the stored old version still lists its picture message'
            );
        },
    },
    {
        name: 'switchVersion: one rich-text attachment keeps the buttons on the picture (live carrier)',
        body: async () => {
            const chatId = -1009300000204;
            const userMessageId = takeMessageId();
            const replyId = takeMessageId();
            const picture = pictureBytes('m6-single');
            const key = await cachePicture(picture);
            await seedResponse({
                chatId,
                firstMessageId: replyId,
                userMessageId,
                currentVersionIndex: 0,
                buttonState: dbIndex.ButtonState.HAS_VERSIONS,
                versions: [
                    { text: '旧版正文', messageIds: [replyId], currentMessageId: replyId },
                    {
                        text: '新版正文',
                        messageIds: [replyId],
                        currentMessageId: replyId,
                        delivery: 'rich-text',
                        richRenderer: 'v1',
                        richAnswerMarkdown: '新版正文',
                        media: [attachmentMediaOf(key, picture.length)],
                    },
                ],
            });
            await seedRow({ chatId, messageId: replyId, text: '旧版正文' });

            const telegram = createFakeTelegram();
            const ctx = contextOf(messageUpdate({ chatId, messageId: takeMessageId(), userId: 42, text: '切换' }), telegram);
            const { result: switched, lines } = await captureConsole(() => botMessageService.switchVersion(ctx, replyId, 'next'));
            expect(switched, `the switch succeeded (log: ${lines.slice(-2).join(' | ')})`);
            const version = (await dbIndex.getBotResponse(chatId, replyId))?.getVersions()[1];
            const pictureIds = version?.mediaMessageIds ?? [];
            expect(pictureIds.length === 1, `one picture message is stored (got ${JSON.stringify(pictureIds)})`);
            expect(
                version?.currentMessageId === pictureIds[0],
                `the picture message carries the buttons (live rule; got ${String(version?.currentMessageId)})`
            );
            const markup = telegram.callsOf('editMessageReplyMarkup').at(-1);
            expect(
                asRecord(markup?.payload).message_id === pictureIds[0],
                `the buttons land on the picture (got ${JSON.stringify(markup?.payload.message_id)})`
            );
        },
    },
    {
        name: 'switchVersion: several rich-text attachments keep the buttons on the last layout message',
        body: async () => {
            const chatId = -1009300000205;
            const userMessageId = takeMessageId();
            const replyId = takeMessageId();
            const pictures = [pictureBytes('m6-multi-a'), pictureBytes('m6-multi-b')];
            const keys = [await cachePicture(pictures[0]!), await cachePicture(pictures[1]!)];
            const { searchPageTokenOf } = await import('../../src/shared/search-page.js');
            const searchToken = searchPageTokenOf({ chatId, firstMessageId: replyId, versionId: 2 });
            await seedResponse({
                chatId,
                firstMessageId: replyId,
                userMessageId,
                currentVersionIndex: 0,
                buttonState: dbIndex.ButtonState.HAS_VERSIONS,
                versions: [
                    { text: '旧版正文', messageIds: [replyId], currentMessageId: replyId },
                    {
                        text: '新版正文',
                        messageIds: [replyId],
                        currentMessageId: replyId,
                        delivery: 'rich-text',
                        richRenderer: 'v1',
                        richAnswerMarkdown: '新版正文',
                        searchLinkToken: searchToken,
                        media: pictures.map((picture, index) => attachmentMediaOf(keys[index]!, picture.length)),
                    },
                ],
            });
            await seedRow({ chatId, messageId: replyId, text: '旧版正文' });

            const telegram = createFakeTelegram();
            const ctx = contextOf(messageUpdate({ chatId, messageId: takeMessageId(), userId: 42, text: '切换' }), telegram);
            const { result: switched, lines } = await captureConsole(() => botMessageService.switchVersion(ctx, replyId, 'next'));
            expect(switched, `the switch succeeded (log: ${lines.slice(-2).join(' | ')})`);
            expect(telegram.callsOf('sendMessage').length >= 1, 'the folded search footer is sent as its own message');
            const version = (await dbIndex.getBotResponse(chatId, replyId))?.getVersions()[1];
            expect(
                version?.currentMessageId !== replyId,
                `the buttons do not drift to the body (got ${String(version?.currentMessageId)})`
            );
            const markup = telegram.callsOf('editMessageReplyMarkup').at(-1);
            expect(
                asRecord(markup?.payload).message_id === version?.currentMessageId,
                `the buttons land on the last layout message (got ${JSON.stringify(markup?.payload.message_id)})`
            );
        },
    },
    {
        name: 'switchVersion: a version whose picture bytes are gone keeps only the pictures it can show',
        body: async () => {
            const chatId = -1009300000206;
            const userMessageId = takeMessageId();
            const replyId = takeMessageId();
            const kept = pictureBytes('m2-kept');
            const lost = pictureBytes('m2-lost');
            const keptKey = await cachePicture(kept);
            await seedResponse({
                chatId,
                firstMessageId: replyId,
                userMessageId,
                currentVersionIndex: 0,
                buttonState: dbIndex.ButtonState.HAS_VERSIONS,
                versions: [
                    { text: '旧版正文', messageIds: [replyId], currentMessageId: replyId },
                    {
                        text: '新版正文',
                        messageIds: [replyId],
                        currentMessageId: replyId,
                        media: [attachmentMediaOf(keptKey, kept.length), attachmentMediaOf(replyMediaKeyOf(lost), lost.length)],
                    },
                ],
            });
            await seedRow({ chatId, messageId: replyId, text: '旧版正文' });

            const telegram = createFakeTelegram();
            const ctx = contextOf(messageUpdate({ chatId, messageId: takeMessageId(), userId: 42, text: '切换' }), telegram);
            const { result: switched, lines } = await captureConsole(() => botMessageService.switchVersion(ctx, replyId, 'next'));
            expect(switched, `the switch succeeded with the remaining picture (log: ${lines.slice(-2).join(' | ')})`);
            const version = (await dbIndex.getBotResponse(chatId, replyId))?.getVersions()[1];
            expect(
                (version?.media ?? []).length === 1 && (version?.media ?? [])[0]?.mediaKey === keptKey,
                `only the shown picture stays in the version (got ${JSON.stringify(version?.media?.map((item) => item.mediaKey))})`
            );
            expect((version?.mediaMessageIds ?? []).length === 1, 'media[] and the picture messages agree');
        },
    },
    {
        name: 'refresh: a rich-text single attachment keeps its buttons on the picture (live carrier)',
        body: async () => {
            const chatId = -1009300000207;
            const userMessageId = takeMessageId();
            const replyId = takeMessageId();
            const pictureId = takeMessageId();
            const picture = pictureBytes('refresh-m6-single');
            const key = await cachePicture(picture);
            await seedResponse({
                chatId,
                firstMessageId: replyId,
                userMessageId,
                currentVersionIndex: 0,
                buttonState: dbIndex.ButtonState.HAS_VERSIONS,
                versions: [{
                    text: '正文',
                    messageIds: [replyId, pictureId],
                    currentMessageId: replyId,
                    delivery: 'rich-text',
                    richRenderer: 'v1',
                    richAnswerMarkdown: '正文',
                    media: [attachmentMediaOf(key, picture.length)],
                    mediaMessageIds: [pictureId],
                }],
            });
            await seedRow({ chatId, messageId: replyId, text: '正文' });

            const telegram = createFakeTelegram();
            const { result: refreshed, lines } = await captureConsole(() => botMessageService.refreshToFinalState(telegram.api, chatId, replyId));
            expect(refreshed, `the refresh succeeded (log: ${lines.slice(-2).join(' | ')})`);
            const version = (await dbIndex.getBotResponse(chatId, replyId))?.getVersions()[0];
            expect(version?.currentMessageId === pictureId, `the picture message is the carrier (got ${String(version?.currentMessageId)})`);
            const markup = telegram.callsOf('editMessageReplyMarkup').at(-1);
            expect(
                asRecord(markup?.payload).message_id === pictureId,
                `the buttons land on the picture (got ${JSON.stringify(markup?.payload.message_id)})`
            );
        },
    },
    {
        name: 'refresh: several rich-text attachments keep the buttons on the last layout message',
        body: async () => {
            const chatId = -1009300000208;
            const userMessageId = takeMessageId();
            const replyId = takeMessageId();
            const pictureIds = [takeMessageId(), takeMessageId()];
            const pictures = [pictureBytes('refresh-m6-a'), pictureBytes('refresh-m6-b')];
            const keys = [await cachePicture(pictures[0]!), await cachePicture(pictures[1]!)];
            const { searchPageTokenOf } = await import('../../src/shared/search-page.js');
            const searchToken = searchPageTokenOf({ chatId, firstMessageId: replyId, versionId: 1 });
            await seedResponse({
                chatId,
                firstMessageId: replyId,
                userMessageId,
                currentVersionIndex: 0,
                buttonState: dbIndex.ButtonState.HAS_VERSIONS,
                versions: [{
                    text: '正文',
                    messageIds: [replyId, ...pictureIds],
                    currentMessageId: replyId,
                    delivery: 'rich-text',
                    richRenderer: 'v1',
                    richAnswerMarkdown: '正文',
                    searchLinkToken: searchToken,
                    media: pictures.map((picture, index) => attachmentMediaOf(keys[index]!, picture.length)),
                    mediaMessageIds: pictureIds,
                }],
            });
            await seedRow({ chatId, messageId: replyId, text: '正文' });

            const telegram = createFakeTelegram();
            const { result: refreshed, lines } = await captureConsole(() => botMessageService.refreshToFinalState(telegram.api, chatId, replyId));
            expect(refreshed, `the refresh succeeded (log: ${lines.slice(-2).join(' | ')})`);
            expect(telegram.callsOf('sendMessage').length >= 1, 'the folded search footer is its own message');
            const version = (await dbIndex.getBotResponse(chatId, replyId))?.getVersions()[0];
            expect(
                version?.currentMessageId !== replyId,
                `the buttons do not drift to the body (got ${String(version?.currentMessageId)})`
            );
            const markup = telegram.callsOf('editMessageReplyMarkup').at(-1);
            expect(
                asRecord(markup?.payload).message_id === version?.currentMessageId,
                `the buttons land on the last layout message (got ${JSON.stringify(markup?.payload.message_id)})`
            );
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}

const { sequelize } = await import('../../src/db/config.js');
await sequelize.close();

reportResults(results);
