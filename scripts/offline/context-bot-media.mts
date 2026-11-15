/**
 * Offline cases for a v5 bot reply's pictures in the model context: the reply
 * stores them as `message_media` rows (design 2026-1115-1930 §12.7), so the
 * next turn must read every picture back in delivery order, number them as
 * `#N 的第 k 张图`, and name their captions. Old replies keep the single-file
 * path byte for byte.
 *
 * Run: npx tsx scripts/offline/context-bot-media.mts
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
import type {
    ModelCapabilities,
    UnifiedContentPart,
    UnifiedMessage,
} from '../../src/ai/types.js';
import type { StoredMessageMedia } from '../../src/db/messageMediaDTO.js';

delete process.env.LUOXU_PREVIEW_URL;

const db = await setupOfflineDb();
const { Message, putCachedMedia } = db;
const { buildContext } = await import('../../src/reply/context-builder.js');
const { replaceMessageMedia, listMessageMedia, deleteMessageMediaForMessages } = await import(
    '../../src/db/queries/message-media-queries.js'
);
const { resolveImageReferences } = await import(
    '../../src/reply/tools/image-references.js'
);

/** A model that sees images */
const VISION: ModelCapabilities = {
    supportsImageInput: true,
    supportsImageOutput: false,
    supportsSystemPrompt: true,
    requiresMessageMerge: false,
    supportsThinking: false,
    supportsGrounding: false,
    supportsMediaInput: false,
};

const PNG_1PX =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_1PX, 'base64');

/** Distinct bytes per picture: a part loaded from the wrong row cannot pass */
const pictureBytes = (label: string): Buffer => Buffer.concat([PNG_BYTES, Buffer.from(`-${label}`)]);

interface SeedOptions {
    text?: string | null;
    replyToId?: number | null;
    fromBot?: boolean;
    file?: Buffer | null;
    fileUniqueId?: string | null;
    fileMime?: string | null;
    mediaHint?: string | null;
}

const seedMessage = async (options: SeedOptions = {}): Promise<number> => {
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
        file: options.file ?? null,
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

/** One cached reply picture: media_cache bytes + its `message_media` row */
const cachePicture = async (
    key: string,
    bytes: Buffer,
    mimeType = 'image/png'
): Promise<void> => {
    await putCachedMedia({ fileUniqueId: key, data: bytes, sizeBytes: bytes.length, mime: mimeType, kind: 'photo' });
};

const storedPicture = (ordinal: number, key: string, bytes: Buffer, caption?: string): StoredMessageMedia => ({
    ordinal,
    mediaKey: key,
    mimeType: 'image/png',
    sizeBytes: bytes.length,
    placement: ordinal <= 1 ? 'inline' : 'attachment',
    ...(caption === undefined ? {} : { caption }),
});

/**
 * A bot reply whose v5 version delivered `pictures` pictures: one message row
 * (its fileUniqueId mirrors the first picture, file BLOB absent as for every
 * multi-picture reply) plus one `message_media` row per picture.
 */
interface SeededBotReply {
    botMessageId: number;
    userMessageId: number;
    bytes: Buffer[];
    keys: string[];
}

const seedBotReply = async (
    label: string,
    pictures: number,
    options: {
        captions?: (string | undefined)[];
        cached?: boolean[];
        legacyFirstBytes?: Buffer;
        /** indexes whose bytes the model cannot read as an image (label checks) */
        unreadable?: number[];
    } = {}
): Promise<SeededBotReply> => {
    const captions = options.captions ?? [];
    const unreadable = new Set(options.unreadable ?? []);
    const bytes = Array.from({ length: pictures }, (_unused, index) =>
        unreadable.has(index) ? Buffer.from(`not-an-image-${label}-${index + 1}`) : pictureBytes(`${label}-${index + 1}`)
    );
    const keys = bytes.map((_unused, index) => `bot-media-${label}-${index + 1}`);
    for (const [index, key] of keys.entries()) {
        if (options.cached?.[index] === false) continue;
        await cachePicture(key, bytes[index] ?? PNG_BYTES);
    }
    const userMessageId = await seedMessage({ text: '画了几张图' });
    const botMessageId = await seedMessage({
        fromBot: true,
        replyToId: userMessageId,
        text: '画好了',
        mediaHint: 'some pictures',
        fileUniqueId: keys[0] ?? null,
        fileMime: 'image/png',
        ...(options.legacyFirstBytes === undefined ? {} : { file: options.legacyFirstBytes }),
    });
    await replaceMessageMedia(
        OFFLINE_CHAT_ID,
        botMessageId,
        bytes.map((picture, index) => storedPicture(index + 1, keys[index] ?? '', picture, captions[index]))
    );
    return { botMessageId, userMessageId, bytes, keys };
};

const build = async (messageId: number): Promise<UnifiedMessage[]> => {
    const row = await Message.findOne({ where: { chatId: OFFLINE_CHAT_ID, messageId } });
    if (!row) throw new Error(`seeded message ${messageId} not found`);
    const { messages, contextIndex } = await buildContext(row, { capabilities: VISION, model: 'gemini-3.8-flash' });
    lastContextIndex = contextIndex;
    return messages;
};

/** The index of the last build (the tool numbering the model sees) */
let lastContextIndex: ReadonlyMap<number, import('../../src/reply/context-index.js').ContextIndexEntry> = new Map();

const textAt = (message: UnifiedMessage, index: number): string => {
    const part = message.content[index];
    return part !== undefined && part.type === 'text' ? part.text ?? '' : '';
};

/** The user-role carrier turn that replays a bot reply's attachments */
const carrierOf = (messages: readonly UnifiedMessage[]): UnifiedMessage => {
    const carrier = messages.find(
        (message) =>
            message.role === 'user' &&
            message.content.some((part) => part.type === 'text' && (part.text ?? '').startsWith('[system] 以下是你在 #'))
    );
    if (carrier === undefined) throw new Error('the bot reply has no attachment carrier turn');
    return carrier;
};

const imagePartsOf = (message: UnifiedMessage): UnifiedContentPart[] =>
    message.content.filter((part) => part.type === 'image');

const bytesOfPart = (part: UnifiedContentPart): Buffer =>
    part.type === 'image' && part.imageData !== undefined ? Buffer.from(part.imageData, 'base64') : Buffer.alloc(0);

const cases: CaseResult[] = [];

cases.push(
    await runCase('a v5 reply replays every stored picture as its own part, in ordinal order', async () => {
        const reply = await seedBotReply('three', 3);
        const messages = await build(reply.userMessageId);

        const carrier = carrierOf(messages);
        const note = textAt(carrier, 0);
        expect(
            note.startsWith('[system] 以下是你在 #'),
            `the carrier keeps its note (got ${JSON.stringify(note)})`
        );
        expect(!note.includes('图注：'), 'pictures without captions add no caption line');

        const images = imagePartsOf(carrier);
        expect(images.length === 3, `all three pictures come back (got ${images.length})`);
        for (const [index, part] of images.entries()) {
            expect(
                bytesOfPart(part).equals(reply.bytes[index] ?? Buffer.alloc(0)),
                `picture ${index + 1} carries the bytes of that delivery position`
            );
            expect(part.type === 'image' && part.mimeType === 'image/png', `picture ${index + 1} is a PNG part`);
        }

        // The tool numbering is the same list: `#N 的第 k 张图` resolves here
        const botNumber = [...lastContextIndex.values()].find((entry) => entry.messageId === reply.botMessageId)?.number;
        expect(botNumber !== undefined, 'the bot reply is in the context index');
        const entry = botNumber === undefined ? undefined : lastContextIndex.get(botNumber);
        expect(entry?.imageCount === 3, `the reply is known to carry three pictures (got ${String(entry?.imageCount)})`);

        const references = await resolveImageReferences(
            [{ message: botNumber ?? 0, image: 2 }],
            {
                chatId: OFFLINE_CHAT_ID,
                contextIndex: lastContextIndex,
                loadMessageImages: async () => [],
            }
        );
        expect(references.ok, 'the second picture of the reply is a valid reference');
        if (references.ok) {
            expect(
                references.images[0]?.data.equals(reply.bytes[1] ?? Buffer.alloc(0)) === true,
                'the reference resolves to the second delivered picture'
            );
        }
    })
);

cases.push(
    await runCase('the picture number in the reference error is the context position', async () => {
        const reply = await seedBotReply('label', 3);
        await build(reply.userMessageId);
        const botNumber = [...lastContextIndex.values()].find((entry) => entry.messageId === reply.botMessageId)?.number;
        const references = await resolveImageReferences(
            [{ message: botNumber ?? 0, image: 9 }],
            {
                chatId: OFFLINE_CHAT_ID,
                contextIndex: lastContextIndex,
                loadMessageImages: async () => [],
            }
        );
        expect(!references.ok, 'a picture past the list is refused');
        if (!references.ok) {
            expect(
                references.error.includes('只有 3 张图，没有第 9 张'),
                `the error counts the context pictures (got ${JSON.stringify(references.error)})`
            );
        }
    })
);

cases.push(
    await runCase('a tool reference names the picture by its context position', async () => {
        const reply = await seedBotReply('unreadable', 3, { unreadable: [1] });
        await build(reply.userMessageId);
        const botNumber = [...lastContextIndex.values()].find((entry) => entry.messageId === reply.botMessageId)?.number;
        const references = await resolveImageReferences(
            [{ message: botNumber ?? 0, image: 2 }],
            {
                chatId: OFFLINE_CHAT_ID,
                contextIndex: lastContextIndex,
                loadMessageImages: async () => [],
            }
        );
        expect(!references.ok, 'an unreadable picture is refused');
        if (!references.ok) {
            expect(
                references.error.includes(`#${botNumber ?? 0} 的第 2 张图格式不支持`),
                `the problem names the picture as #N 的第 k 张图 (got ${JSON.stringify(references.error)})`
            );
        }
    })
);

cases.push(
    await runCase('stored captions become one short note naming the picture positions', async () => {
        const reply = await seedBotReply('captions', 3, {
            captions: ['第一张的说明', undefined, '第三张\n换行了'],
        });
        const messages = await build(reply.userMessageId);
        const note = textAt(carrierOf(messages), 0);
        expect(
            note.includes('图注：第 1 张「第一张的说明」；第 3 张「第三张 换行了」'),
            `the caption line names positions and folds newlines (got ${JSON.stringify(note)})`
        );
    })
);

cases.push(
    await runCase('a picture whose cache was cleared is skipped, the rest keep their order', async () => {
        const reply = await seedBotReply('cleared', 3, {
            captions: ['留下', '没了', '留下二'],
            cached: [true, false, true],
        });
        const messages = await build(reply.userMessageId);
        const carrier = carrierOf(messages);
        const images = imagePartsOf(carrier);
        expect(images.length === 2, `only the two cached pictures come back (got ${images.length})`);
        expect(bytesOfPart(images[0] ?? { type: 'text' }).equals(reply.bytes[0] ?? Buffer.alloc(0)), 'the first picture');
        expect(bytesOfPart(images[1] ?? { type: 'text' }).equals(reply.bytes[2] ?? Buffer.alloc(0)), 'the third picture');
        const note = textAt(carrier, 0);
        expect(
            note.includes('图注：第 1 张「留下」；第 2 张「留下二」'),
            `the captions follow the pictures the model can see (got ${JSON.stringify(note)})`
        );
    })
);

cases.push(
    await runCase('when every cached picture is gone the legacy row bytes still replay one picture', async () => {
        const legacyFirst = pictureBytes('legacy-first');
        const reply = await seedBotReply('all-cleared', 2, {
            captions: ['x', 'y'],
            cached: [false, false],
            legacyFirstBytes: legacyFirst,
        });
        const rows = await listMessageMedia(OFFLINE_CHAT_ID, reply.botMessageId);
        expect(rows.length === 2, 'the stored picture rows still exist');

        const messages = await build(reply.userMessageId);
        const carrier = carrierOf(messages);
        const images = imagePartsOf(carrier);
        expect(
            images.length === 1,
            `the row's own first picture still reaches the model (got ${images.length})`
        );
        expect(
            bytesOfPart(images[0] ?? { type: 'text' }).equals(legacyFirst),
            "the fallback serves the message row's legacy bytes"
        );
    })
);

cases.push(
    await runCase('a reply without stored picture rows keeps the single-file carrier unchanged', async () => {
        const key = 'legacy-single-picture';
        const bytes = pictureBytes('legacy-single');
        await cachePicture(key, bytes);
        const userMessageId = await seedMessage({ text: '一张图' });
        const botMessageId = await seedMessage({
            fromBot: true,
            replyToId: userMessageId,
            text: '给你',
            fileUniqueId: key,
            fileMime: 'image/png',
            mediaHint: 'a picture',
        });
        expect((await listMessageMedia(OFFLINE_CHAT_ID, botMessageId)).length === 0, 'no message_media rows');

        const messages = await build(userMessageId);
        const carrier = carrierOf(messages);
        expect(
            textAt(carrier, 0).endsWith('发出的附件。'),
            `the carrier note has exactly its old text (got ${JSON.stringify(textAt(carrier, 0))})`
        );
        const images = imagePartsOf(carrier);
        expect(images.length === 1, `the single picture replays once (got ${images.length})`);
        expect(bytesOfPart(images[0] ?? { type: 'text' }).equals(bytes), 'the single picture bytes');
    })
);

cases.push(
    await runCase('stored picture rows can be deleted with their message (cleanup path)', async () => {
        const reply = await seedBotReply('cleanup', 3);
        expect((await listMessageMedia(OFFLINE_CHAT_ID, reply.botMessageId)).length === 3, 'three rows before');
        const deleted = await deleteMessageMediaForMessages(OFFLINE_CHAT_ID, [reply.botMessageId]);
        expect(deleted === 3, `the delete removes all three (got ${deleted})`);
        expect(
            (await listMessageMedia(OFFLINE_CHAT_ID, reply.botMessageId)).length === 0,
            'no row is left behind'
        );
    })
);

reportResults(cases);
