/**
 * Offline cases for where a message's own media parts sit in the model
 * context: inside its message block — after the `#N 用户名 [标注…]` header and
 * before `<<EOF` — never between the previous message's terminator and this
 * message's header, where the model read them as the previous message's
 * attachment (harness issue #10, 2026-11-13).
 *
 * Run: npx tsx scripts/offline/context-media-order.mts
 */
import {
    OFFLINE_CHAT_ID,
    expect,
    reportResults,
    runCase,
    setupOfflineDb,
    takeMessageId,
    type CaseResult,
} from './harness.mts';
import type { ModelCapabilities, UnifiedContentPart, UnifiedMessage } from '../../src/ai/types.js';

delete process.env.LUOXU_PREVIEW_URL;

const db = await setupOfflineDb();
const { Message, putCachedMedia } = db;
const { buildContext } = await import('../../src/reply/context-builder.js');
const { MediaCache } = await import('../../src/db/mediaCacheDTO.js');

/** A model that sees images: the case the wire format has to be right for */
const VISION: ModelCapabilities = {
    supportsImageInput: true,
    supportsImageOutput: false,
    supportsSystemPrompt: true,
    requiresMessageMerge: false,
    supportsThinking: false,
    supportsGrounding: false,
    supportsMediaInput: false,
};

const TEXT_ONLY: ModelCapabilities = { ...VISION, supportsImageInput: false };
/** Vision plus audio/video: the only kind that receives a `media` part */
const ALL_MODAL: ModelCapabilities = { ...VISION, supportsMediaInput: true };

const PNG_BYTES = Buffer.from('offline-context-order-png');
const WEBP_BYTES = Buffer.from('offline-context-order-webp');

/** The terminator closing one user message block, as a text part of its own */
const EOF_CLOSE = '\n<<EOF\n';

const putMedia = async (
    fileUniqueId: string,
    data: Buffer,
    mime: string,
    kind: string
): Promise<void> =>
    putCachedMedia({ fileUniqueId, data, sizeBytes: data.length, mime, kind });

const seedMessage = async (
    options: {
        text?: string | null;
        replyToId?: number | null;
        fileUniqueId?: string | null;
        fileMime?: string | null;
        mediaHint?: string | null;
        fromBot?: boolean;
    } = {}
): Promise<number> => {
    const messageId = takeMessageId();
    await Message.create({
        chatId: OFFLINE_CHAT_ID,
        messageId,
        fromBotSelf: options.fromBot === true,
        userId: options.fromBot === true ? 7777 : 42,
        date: new Date(messageId * 1000),
        userName: options.fromBot === true ? 'Bot' : 'tester',
        text: 'text' in options ? options.text ?? null : `message ${messageId}`,
        quoteText: null,
        file: null,
        fileMime: options.fileMime ?? null,
        fileUniqueId: options.fileUniqueId ?? null,
        replyToId: options.replyToId ?? null,
        chatCommand: null,
        modelParts: null,
        mediaHint: options.mediaHint ?? null,
        forwardOrigin: null,
        forwardFromId: null,
        viaBot: null,
        ocrText: null,
    });
    return messageId;
};

const build = async (
    messageId: number,
    capabilities: ModelCapabilities = VISION
): Promise<UnifiedMessage[]> => {
    const row = await Message.findOne({ where: { chatId: OFFLINE_CHAT_ID, messageId } });
    if (!row) throw new Error(`seeded message ${messageId} not found`);
    const { messages } = await buildContext(row, { capabilities, model: 'gemini-3.8-flash' });
    return messages;
};

const textAt = (message: UnifiedMessage, index: number): string => {
    const part = message.content[index];
    return part !== undefined && part.type === 'text' ? part.text ?? '' : '';
};

const indexOfPart = (
    message: UnifiedMessage,
    predicate: (part: UnifiedContentPart) => boolean
): number => message.content.findIndex(predicate);

const isMediaPart = (part: UnifiedContentPart): boolean =>
    part.type === 'image' || part.type === 'media';

const isEofClose = (part: UnifiedContentPart): boolean =>
    part.type === 'text' && part.text === EOF_CLOSE;

const isRuntimeBlock = (part: UnifiedContentPart): boolean =>
    part.type === 'text' && (part.text ?? '').startsWith('[system] 运行时信息');

/** How the turn's text reads on the wire: platforms join text parts with no separator */
const wireOf = (message: UnifiedMessage): string =>
    message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('');

const cases: CaseResult[] = [];

cases.push(
    await runCase('a sticker stays inside its own message block', async () => {
        const first = await seedMessage({ text: '第一条' });
        const uniqueId = `order-sticker-${takeMessageId()}`;
        await putMedia(uniqueId, WEBP_BYTES, 'image/webp', 'sticker');
        const sticker = await seedMessage({
            replyToId: first,
            text: '',
            mediaHint: 'a sticker',
            fileUniqueId: uniqueId,
            fileMime: 'image/webp',
        });

        const messages = await build(sticker);
        expect(messages.length === 2, `the context holds both messages (got ${messages.length})`);
        const [previous, trigger] = messages;
        if (previous === undefined || trigger === undefined) throw new Error('context turns missing');

        // The previous message ends with its own terminator and carries nothing
        const previousTexts = previous.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text ?? '');
        expect(
            previousTexts.at(-1)?.endsWith('<<EOF\n') === true,
            `the previous message still closes with its terminator (got ${JSON.stringify(previousTexts)})`
        );
        expect(
            !previous.content.some(isMediaPart),
            'the previous message carries none of this message’s media'
        );

        // The sticker opens its own block
        expect(
            trigger.content[0]?.type === 'text',
            `the message opens with its header, not with an image (got ${trigger.content[0]?.type ?? 'nothing'})`
        );
        expect(
            textAt(trigger, 0).startsWith('#2 tester ') && textAt(trigger, 0).includes('[sent a sticker]'),
            `the opening text is this message's header (got ${JSON.stringify(textAt(trigger, 0))})`
        );
        const imageIndex = indexOfPart(trigger, isMediaPart);
        const closeIndex = indexOfPart(trigger, isEofClose);
        expect(imageIndex > 0, `the sticker comes after the header (got index ${imageIndex})`);
        expect(
            closeIndex > imageIndex,
            `the terminator closes the block after the sticker (image ${imageIndex}, terminator ${closeIndex})`
        );
        expect(textAt(trigger, imageIndex) === '', 'the media part is not text');
        expect(
            textAt(trigger, closeIndex) === EOF_CLOSE,
            `the terminator is the closing part (got ${JSON.stringify(textAt(trigger, closeIndex))})`
        );
        // Removing the media leaves exactly the legacy wire text: the split is
        // only where the media sits, nothing else moved.
        expect(
            wireOf(trigger).startsWith('#2 tester [replying to #1 tester] [sent a sticker]\n<<EOF\n'),
            `the text wire keeps its legacy shape (got ${JSON.stringify(wireOf(trigger))})`
        );
    })
);

cases.push(
    await runCase('a media message between two text messages keeps the media in its own block', async () => {
        const first = await seedMessage({ text: '开头' });
        const uniqueId = `order-between-${takeMessageId()}`;
        await putMedia(uniqueId, PNG_BYTES, 'image/png', 'photo');
        const middle = await seedMessage({
            replyToId: first,
            text: '',
            mediaHint: 'a picture',
            fileUniqueId: uniqueId,
            fileMime: 'image/png',
        });
        const last = await seedMessage({ replyToId: middle, text: '然后呢' });

        const messages = await build(last);
        expect(messages.length === 3, `the reply chain is all there (got ${messages.length})`);
        const [opening, carrier, closing] = messages;
        if (opening === undefined || carrier === undefined || closing === undefined) {
            throw new Error('context turns missing');
        }

        expect(
            textAt(carrier, 0).startsWith('#2 tester '),
            `the media message opens with its own header (got ${JSON.stringify(textAt(carrier, 0))})`
        );
        const imageIndex = indexOfPart(carrier, isMediaPart);
        const closeIndex = indexOfPart(carrier, isEofClose);
        expect(
            imageIndex > 0 && closeIndex > imageIndex,
            `the image sits between its header and terminator (image ${imageIndex}, terminator ${closeIndex})`
        );
        // The old shape put the image after the *previous* message's terminator,
        // so the next header followed a bare image part.
        expect(
            textAt(closing, 0).startsWith('#3 tester '),
            `the next message opens with its header, not an image (got ${JSON.stringify(textAt(closing, 0))})`
        );
        expect(
            !closing.content.some(isMediaPart),
            'the image does not leak into the next message'
        );
    })
);

cases.push(
    await runCase('a caption stays in the header line, before the media', async () => {
        const first = await seedMessage({ text: 'root' });
        const uniqueId = `order-caption-${takeMessageId()}`;
        await putMedia(uniqueId, PNG_BYTES, 'image/png', 'photo');
        const photo = await seedMessage({
            replyToId: first,
            text: '看这张',
            mediaHint: 'a picture',
            fileUniqueId: uniqueId,
            fileMime: 'image/png',
        });

        const messages = await build(photo);
        const trigger = messages.at(-1);
        if (trigger === undefined) throw new Error('trigger turn missing');

        const opening = textAt(trigger, 0);
        expect(
            opening.startsWith('#2 tester ') && opening.includes('[sent a picture]'),
            `the header names the picture (got ${JSON.stringify(opening)})`
        );
        expect(
            opening.endsWith(': 看这张'),
            `the caption rides the header line (got ${JSON.stringify(opening)})`
        );
        expect(!opening.includes('<<EOF'), 'the header line is not closed before the media');
        const imageIndex = indexOfPart(trigger, isMediaPart);
        const closeIndex = indexOfPart(trigger, isEofClose);
        expect(
            imageIndex === 1 && closeIndex === 2,
            `the picture is the part right after the header (image ${imageIndex}, terminator ${closeIndex})`
        );
    })
);

cases.push(
    await runCase('a message without media keeps its single text part', async () => {
        const first = await seedMessage({ text: 'root' });
        const plain = await seedMessage({ replyToId: first, text: '只有文字' });

        const messages = await build(plain);
        const trigger = messages.at(-1);
        if (trigger === undefined) throw new Error('trigger turn missing');

        expect(
            trigger.content[0]?.type === 'text',
            `the text part comes first (got ${trigger.content[0]?.type ?? 'nothing'})`
        );
        expect(
            textAt(trigger, 0).startsWith('#2 tester ') &&
                textAt(trigger, 0).endsWith(': 只有文字\n<<EOF\n'),
            `the text part is unchanged: header, body and terminator (got ${JSON.stringify(textAt(trigger, 0))})`
        );
        expect(
            !trigger.content.some((part, index) => index > 0 && part.type === 'text' && part.text === EOF_CLOSE),
            'no terminator is split off when there is nothing to put between'
        );
        expect(
            trigger.content.filter((part) => part.type === 'text').length === 2 &&
                isRuntimeBlock(trigger.content[1] ?? { type: 'image' }),
            'only the runtime block follows the message'
        );
    })
);

cases.push(
    await runCase('a text-only model gets one unsplit text part, no media', async () => {
        const first = await seedMessage({ text: '第一条' });
        const uniqueId = `order-blind-${takeMessageId()}`;
        await putMedia(uniqueId, WEBP_BYTES, 'image/webp', 'sticker');
        const sticker = await seedMessage({
            replyToId: first,
            text: '',
            mediaHint: 'a sticker',
            fileUniqueId: uniqueId,
            fileMime: 'image/webp',
        });

        const messages = await build(sticker, TEXT_ONLY);
        const trigger = messages.at(-1);
        if (trigger === undefined) throw new Error('trigger turn missing');

        expect(
            trigger.content.every((part) => part.type === 'text'),
            'the filtered media leaves no part behind'
        );
        expect(
            textAt(trigger, 0).includes('not visible to you'),
            `the header says the sticker cannot be seen (got ${JSON.stringify(textAt(trigger, 0))})`
        );
        expect(
            textAt(trigger, 0).endsWith('<<EOF\n'),
            `the text part keeps its terminator (got ${JSON.stringify(textAt(trigger, 0))})`
        );
        expect(
            trigger.content.filter((part) => part.type === 'text').length === 2 &&
                isRuntimeBlock(trigger.content[1] ?? { type: 'image' }),
            'the message stays one text part plus the runtime block'
        );
    })
);

cases.push(
    await runCase('a deduped media note stays inside the message block', async () => {
        const uniqueId = `order-dupe-${takeMessageId()}`;
        await putMedia(uniqueId, PNG_BYTES, 'image/png', 'photo');
        const first = await seedMessage({
            text: '第一张',
            mediaHint: 'a picture',
            fileUniqueId: uniqueId,
            fileMime: 'image/png',
        });
        const second = await seedMessage({
            replyToId: first,
            text: '再发一次',
            mediaHint: 'a picture',
            fileUniqueId: uniqueId,
            fileMime: 'image/png',
        });

        const messages = await build(second);
        const trigger = messages.at(-1);
        if (trigger === undefined) throw new Error('trigger turn missing');

        expect(
            first !== second && messages[0]?.content.some(isMediaPart) === true,
            'the first copy keeps the picture'
        );
        const noteIndex = indexOfPart(
            trigger,
            (part) => part.type === 'text' && (part.text ?? '').includes('[system] the same media as #1')
        );
        const closeIndex = indexOfPart(trigger, isEofClose);
        expect(noteIndex > 0, `the note replaces the media in its place (got index ${noteIndex})`);
        expect(
            closeIndex > noteIndex,
            `the note is inside the block, before the terminator (note ${noteIndex}, terminator ${closeIndex})`
        );
        expect(!trigger.content.some(isMediaPart), 'the second copy carries no media part');
        // The note replaces a media part inside the block, and text parts are
        // joined with no separator: it must start its own line, not fuse into
        // the body it follows.
        expect(
            wireOf(trigger).includes('再发一次\n[system] the same media as #1 — not attached again\n<<EOF\n'),
            `the note starts its own line inside the block (got ${JSON.stringify(wireOf(trigger))})`
        );
    })
);

cases.push(
    await runCase('a video part is inside the block only for a model that can watch it', async () => {
        const first = await seedMessage({ text: '看视频' });
        const uniqueId = `order-video-${takeMessageId()}`;
        await putCachedMedia({
            fileUniqueId: uniqueId,
            data: Buffer.from('offline-context-order-video'),
            sizeBytes: 27,
            mime: 'video/mp4',
            kind: 'video',
        });
        const video = await seedMessage({
            replyToId: first,
            text: '',
            mediaHint: 'a video',
            fileUniqueId: uniqueId,
            fileMime: 'video/mp4',
        });

        const watching = await build(video, ALL_MODAL);
        const watched = watching.at(-1);
        if (watched === undefined) throw new Error('trigger turn missing');
        expect(
            watched.content[0]?.type === 'text' && textAt(watched, 0).startsWith('#2 tester '),
            `the media message opens with its header (got ${JSON.stringify(textAt(watched, 0))})`
        );
        const mediaIndex = indexOfPart(
            watched,
            (part) => part.type === 'media' && part.mimeType === 'video/mp4'
        );
        const closeIndex = indexOfPart(watched, isEofClose);
        expect(
            mediaIndex > 0 && closeIndex > mediaIndex,
            `the video sits between header and terminator (media ${mediaIndex}, terminator ${closeIndex})`
        );

        // The same message for a model without audio/video input: no media
        // part, no split, and the header says why.
        const blind = await build(video);
        const blindTrigger = blind.at(-1);
        if (blindTrigger === undefined) throw new Error('trigger turn missing');
        expect(
            blindTrigger.content.every((part) => part.type === 'text'),
            'a model that cannot watch the video receives no media part'
        );
        expect(
            textAt(blindTrigger, 0).includes('not visible to you'),
            `the header says the video cannot be seen (got ${JSON.stringify(textAt(blindTrigger, 0))})`
        );
        expect(
            textAt(blindTrigger, 0).endsWith('<<EOF\n'),
            'the text stays one unsplit part'
        );
    })
);

cases.push(
    await runCase('an expired media note stays outside the block', async () => {
        const uniqueId = `order-expired-${takeMessageId()}`;
        await putCachedMedia({
            fileUniqueId: uniqueId,
            fileUri: 'gs://offline-bucket/expired.png',
            sizeBytes: 1024,
            mime: 'image/png',
            kind: 'photo',
        });
        // Past the GCS reference TTL: the part becomes a system note, not media
        await MediaCache.update(
            { createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) },
            { where: { fileUniqueId: uniqueId } }
        );
        const first = await seedMessage({ text: 'root' });
        const photo = await seedMessage({
            replyToId: first,
            text: '早一点的图',
            mediaHint: 'a picture',
            fileUniqueId: uniqueId,
            fileMime: 'image/png',
        });

        const messages = await build(photo);
        const trigger = messages.at(-1);
        if (trigger === undefined) throw new Error('trigger turn missing');

        expect(
            !trigger.content.some(isMediaPart),
            'the expired file contributes no media part'
        );
        expect(
            textAt(trigger, 0).startsWith('#2 tester ') && textAt(trigger, 0).endsWith(': 早一点的图\n<<EOF\n'),
            `the message stays one text part, terminator included (got ${JSON.stringify(textAt(trigger, 0))})`
        );
        const noteIndex = indexOfPart(
            trigger,
            (part) => part.type === 'text' && (part.text ?? '').includes('media expired')
        );
        expect(noteIndex === 1, `the expired-media note follows the block (got index ${noteIndex})`);
        expect(
            wireOf(trigger).includes('<<EOF\n[system] media expired'),
            `the note starts after the terminator on its own line (got ${JSON.stringify(wireOf(trigger))})`
        );
    })
);

cases.push(
    await runCase('an album keeps both pictures inside the block', async () => {
        const mainUniqueId = `order-album-main-${takeMessageId()}`;
        await putMedia(mainUniqueId, PNG_BYTES, 'image/png', 'photo');
        const album = await seedMessage({
            text: '两张图',
            mediaHint: 'some pictures',
            fileUniqueId: mainUniqueId,
            fileMime: 'image/png',
        });
        const subUniqueId = `order-album-sub-${takeMessageId()}`;
        await putMedia(subUniqueId, WEBP_BYTES, 'image/webp', 'photo');
        await seedMessage({
            replyToId: album,
            text: `sub image of [${album}]`,
            mediaHint: 'a picture',
            fileUniqueId: subUniqueId,
            fileMime: 'image/webp',
        });
        const trigger = await seedMessage({ replyToId: album, text: '不错' });

        const messages = await build(trigger);
        const albumTurn = messages[0];
        if (albumTurn === undefined) throw new Error('album turn missing');
        expect(
            albumTurn.content[0]?.type === 'text' && textAt(albumTurn, 0).startsWith('#1 tester '),
            `the album opens with its header (got ${JSON.stringify(textAt(albumTurn, 0))})`
        );
        const imageIndexes = albumTurn.content.flatMap((part, index) => (isMediaPart(part) ? [index] : []));
        const closeIndex = indexOfPart(albumTurn, isEofClose);
        expect(
            imageIndexes.length === 2,
            `both album members are attached (got ${String(imageIndexes.length)})`
        );
        expect(
            imageIndexes[0] === 1 &&
                imageIndexes[1] === 2 &&
                closeIndex > imageIndexes[1],
            `both pictures sit between header and terminator (images ${imageIndexes.join(',')}, terminator ${closeIndex})`
        );
    })
);

cases.push(
    await runCase('a bot reply still replays its attachment in a carrier turn', async () => {
        const uniqueId = `order-bot-${takeMessageId()}`;
        await putMedia(uniqueId, PNG_BYTES, 'image/png', 'photo');
        const botMessage = await seedMessage({
            fromBot: true,
            text: '给你一张图',
            mediaHint: 'a picture',
            fileUniqueId: uniqueId,
            fileMime: 'image/png',
        });
        const trigger = await seedMessage({ replyToId: botMessage, text: '谢谢' });

        const messages = await build(trigger);
        const textTurn = messages[0];
        const carrierTurn = messages[1];
        if (textTurn === undefined || carrierTurn === undefined) throw new Error('bot turns missing');
        expect(
            textTurn.role === 'assistant' &&
                textTurn.content.every((part) => !isMediaPart(part)),
            'the bot’s text turn carries no attachment bytes'
        );
        expect(
            textAt(textTurn, 0).startsWith('[#1]\n'),
            `the bot text turn keeps its [#N] label (got ${JSON.stringify(textAt(textTurn, 0))})`
        );
        expect(
            carrierTurn.role === 'user' &&
                textAt(carrierTurn, 0).startsWith('[system] 以下是你在 #1 那条回复里发出的附件。'),
            `the carrier turn names the reply first (got ${JSON.stringify(textAt(carrierTurn, 0))})`
        );
        expect(carrierTurn.content[1]?.type === 'image', 'the attachment follows the carrier note');
    })
);

reportResults(cases);
