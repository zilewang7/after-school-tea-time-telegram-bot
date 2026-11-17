/**
 * Context-side link-preview deduplication (design
 * 2026-1118-0149, section 三/七.1.1):
 *
 * - one message's web-link preview (text + media) is injected once per context,
 *   keyed by the preview's *content* — the same tweet reached through a share
 *   link with different query parameters collapses, the x.com and fxtwitter
 *   forms of the same post do not (their content differs);
 * - the later message gets exactly one pointer line and no preview media, so
 *   no `dedupeContextMedia` note is needed for it;
 * - a text-only model's OCR fallback collapses with its block;
 * - `/chat`-linked messages behave exactly like reply-tree messages.
 *
 * Run: npx tsx scripts/offline/context-preview-dedupe.mts
 */
import { OFFLINE_CHAT_ID, expect, reportResults, runCase, setupOfflineDb, takeMessageId, type CaseResult } from './harness.mts';
import type { ModelCapabilities, UnifiedMessage } from '../../src/ai/types.js';

// The preview service reads this at import; acquisition never runs here (caches
// are seeded directly), but getLinkPreviewParts is gated on it being set.
process.env.LUOXU_PREVIEW_URL = 'http://127.0.0.1:9/luoxu';
delete process.env.LUOXU_OCR_URL;
process.env.BOT_USER_NAME = 'AfterSchoolTeatimeBot';
process.env.BOT_USER_ID = '7777';
delete process.env.ALLOWED_CHAT_IDS;

const db = await setupOfflineDb();
const { Message, putCachedMedia } = db;
const { buildContext } = await import('../../src/reply/context-builder.js');
const { LinkPreviewCache } = await import('../../src/db/linkPreviewCacheDTO.js');
const { saveMessageLinks } = await import('../../src/db/queries/context-queries.js');

const VISION: ModelCapabilities = {
    supportsImageInput: true,
    supportsImageOutput: false,
    supportsSystemPrompt: true,
    requiresMessageMerge: false,
    supportsThinking: false,
    supportsGrounding: false,
    supportsMediaInput: true,
};
const TEXT_ONLY: ModelCapabilities = { ...VISION, supportsImageInput: false, supportsMediaInput: false };

const PNG_A = Buffer.from('offline-preview-image-a');
const PNG_B = Buffer.from('offline-preview-image-b');
const MP4 = Buffer.from('offline-preview-video');

interface PreviewSeed {
    readonly url: string;
    readonly title: string;
    readonly description: string;
    readonly fullText: string | null;
    readonly ocrText?: string | null;
    /** media keys are derived from the row's own url hash, as the service does */
    readonly images?: readonly Buffer[];
    readonly video?: Buffer;
}

const seedPreview = async (seed: PreviewSeed): Promise<void> => {
    const urlHash = (url: string): string => {
        // Mirror luoxu-preview-service's key shape; the hash value itself never
        // matters as long as two different urls get different keys.
        let hash = 0;
        for (const char of url) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
        return hash.toString(16);
    };
    const mediaItems: { which: string; kind: string; mime: string; mediaKey: string; sizeBytes: number }[] = [];
    for (const [index, image] of (seed.images ?? []).entries()) {
        const which = index === 0 ? 'photo' : `page_photo_${index - 1}`;
        const mediaKey = `luoxu-preview:${urlHash(seed.url)}:${which}`;
        await putCachedMedia({ fileUniqueId: mediaKey, data: image, sizeBytes: image.length, mime: 'image/jpeg', kind: 'photo' });
        mediaItems.push({ which, kind: 'photo', mime: 'image/jpeg', mediaKey, sizeBytes: image.length });
    }
    if (seed.video !== undefined) {
        const mediaKey = `luoxu-preview:${urlHash(seed.url)}:doc`;
        await putCachedMedia({ fileUniqueId: mediaKey, data: seed.video, sizeBytes: seed.video.length, mime: 'video/mp4', kind: 'video' });
        mediaItems.push({ which: 'doc', kind: 'video', mime: 'video/mp4', mediaKey, sizeBytes: seed.video.length });
    }
    await LinkPreviewCache.upsert({
        url: seed.url,
        status: 'ready',
        siteName: seed.title === 'X' ? 'X (formerly Twitter)' : 'FxTwitter',
        title: seed.title,
        description: seed.description,
        fullText: seed.fullText,
        ocrText: seed.ocrText ?? null,
        mediaItems: mediaItems.length > 0 ? JSON.stringify(mediaItems) : null,
        lastUsedAt: new Date(),
    });
};

const seedMessage = async (
    chatId: number,
    options: { text: string; userName?: string; fromBotSelf?: boolean; replyToId?: number | null }
): Promise<number> => {
    const messageId = takeMessageId();
    await Message.create({
        chatId,
        messageId,
        fromBotSelf: options.fromBotSelf ?? false,
        userId: options.fromBotSelf === true ? 7777 : 42,
        date: new Date(messageId * 1000),
        userName: options.userName ?? (options.fromBotSelf === true ? 'Bot' : 'tester'),
        text: options.text,
        quoteText: null,
        file: null,
        fileMime: null,
        fileUniqueId: null,
        replyToId: options.replyToId ?? null,
        chatCommand: null,
        modelParts: null,
        mediaHint: null,
        forwardOrigin: null,
        forwardFromId: null,
        viaBot: null,
        ocrText: null,
        deletedAt: null,
    });
    return messageId;
};

const build = async (
    chatId: number,
    trigger: number,
    capabilities: ModelCapabilities = VISION
): Promise<UnifiedMessage[]> => {
    const row = await Message.findOne({ where: { chatId, messageId: trigger } });
    if (!row) throw new Error(`trigger ${trigger} not found`);
    const { messages } = await buildContext(row, { capabilities, model: 'gemini-3.8-flash' });
    return messages;
};

const textOf = (message: UnifiedMessage): string =>
    message.content.flatMap((part) => (part.type === 'text' && part.text ? [part.text] : [])).join('\n');

const textsWith = (messages: readonly UnifiedMessage[], marker: string): string[] =>
    messages.flatMap((message) =>
        message.content.flatMap((part) => (part.type === 'text' && part.text?.includes(marker) ? [part.text] : []))
    );

const partsOfType = (messages: readonly UnifiedMessage[], type: 'image' | 'media'): number =>
    messages.reduce((count, message) => count + message.content.filter((part) => part.type === type).length, 0);

const DEDUPE_MARKER = 'the same media as';
const POINTER = (number: number) => `链接预览与 #${number} 相同`;

let chatCounter = 0;
const nextChat = (): number => OFFLINE_CHAT_ID - 10 - (chatCounter += 1);

const results: CaseResult[] = [];

results.push(
    await runCase('the same preview content in two messages: one block, one pointer, no media repeated', async () => {
        const chatId = nextChat();
        await seedPreview({
            url: 'https://example.com/article',
            title: 'Same article',
            description: 'Same description',
            fullText: 'Full article body.',
            images: [PNG_A],
            video: MP4,
        });
        const first = await seedMessage(chatId, { text: '看看 https://example.com/article' });
        const trigger = await seedMessage(chatId, {
            text: '同一个链接 https://example.com/article',
            replyToId: first,
        });
        const messages = await build(chatId, trigger);

        const previews = textsWith(messages, '[system] 链接预览：');
        expect(previews.length === 1, `one full preview block (got ${previews.length})`);
        expect(previews[0]?.includes('全文:') === true, 'the kept block keeps the Instant View text');
        const pointers = textsWith(messages, POINTER(1));
        expect(pointers.length === 1, `the second message gets one pointer line (got ${pointers.length})`);
        expect(pointers[0]?.includes('不再重复') === true, 'the pointer says the preview is not repeated');
        expect(partsOfType(messages, 'image') === 1, `preview image injected once (got ${partsOfType(messages, 'image')})`);
        expect(partsOfType(messages, 'media') === 1, `preview video injected once (got ${partsOfType(messages, 'media')})`);
        expect(textsWith(messages, DEDUPE_MARKER).length === 0, 'no media note: the whole block was replaced');
    })
);

results.push(
    await runCase('same content reached through a share parameter is one preview', async () => {
        const chatId = nextChat();
        const clean = 'https://x.com/someone/status/123';
        const shared = 'https://x.com/someone/status/123?a=abc&s=46';
        await seedPreview({ url: clean, title: 'Same post', description: 'Same text', fullText: null, images: [PNG_A] });
        await seedPreview({ url: shared, title: 'Same post', description: 'Same text', fullText: null, images: [PNG_A] });
        const first = await seedMessage(chatId, { text: `看 ${clean}` });
        const trigger = await seedMessage(chatId, { text: `还有 ${shared}`, replyToId: first });
        const messages = await build(chatId, trigger);

        expect(textsWith(messages, '[system] 链接预览：').length === 1, 'share-parameter variant collapses into one block');
        expect(textsWith(messages, POINTER(1)).length === 1, 'the second form is a pointer');
        expect(partsOfType(messages, 'image') === 1, 'its image is not injected twice');
    })
);

results.push(
    await runCase('a different preview (x.com vs fxtwitter of one post) is NOT merged', async () => {
        const chatId = nextChat();
        await seedPreview({
            url: 'https://x.com/someone/status/456?s=46',
            title: 'X post',
            description: 'First line of the post…',
            fullText: null,
            images: [PNG_A],
        });
        await seedPreview({
            url: 'https://fxtwitter.com/someone/status/456',
            title: 'Fx post',
            description: 'First line of the post',
            fullText: 'Thread body + stats',
            images: [PNG_A, PNG_B],
            video: MP4,
        });
        const first = await seedMessage(chatId, { text: 'https://x.com/someone/status/456?s=46' });
        const trigger = await seedMessage(chatId, {
            text: 'https://fxtwitter.com/someone/status/456',
            replyToId: first,
        });
        const messages = await build(chatId, trigger);

        expect(textsWith(messages, '[system] 链接预览：').length === 2, 'both forms keep their own block');
        expect(textsWith(messages, POINTER(1)).length === 0, 'no pointer between different content');
        expect(textsWith(messages, '全文:').length === 1, 'only the fxtwitter form carries the full text');
    })
);

results.push(
    await runCase('same text but different media bytes stays two previews', async () => {
        const chatId = nextChat();
        await seedPreview({
            url: 'https://example.com/a',
            title: 'Title',
            description: 'Description',
            fullText: null,
            images: [PNG_A],
        });
        await seedPreview({
            url: 'https://example.com/b',
            title: 'Title',
            description: 'Description',
            fullText: null,
            images: [PNG_B],
        });
        const first = await seedMessage(chatId, { text: 'https://example.com/a' });
        const trigger = await seedMessage(chatId, { text: 'https://example.com/b', replyToId: first });
        const messages = await build(chatId, trigger);

        expect(textsWith(messages, '[system] 链接预览：').length === 2, 'media identity is part of the preview identity');
    })
);

results.push(
    await runCase('a text-only model gets the preview text and the OCR fallback once', async () => {
        const chatId = nextChat();
        await seedPreview({
            url: 'https://example.com/ocr',
            title: 'Ocr post',
            description: 'Description',
            fullText: null,
            ocrText: '图片里的字',
            images: [PNG_A],
        });
        const first = await seedMessage(chatId, { text: 'https://example.com/ocr' });
        const trigger = await seedMessage(chatId, { text: '再看 https://example.com/ocr', replyToId: first });
        const messages = await build(chatId, trigger, TEXT_ONLY);

        expect(textsWith(messages, '[system] 链接预览：').length === 1, 'one preview text block');
        expect(textsWith(messages, '图中文字（OCR').length === 1, 'one OCR fallback block');
        expect(textsWith(messages, POINTER(1)).length === 1, 'the second message gets the pointer');
        expect(partsOfType(messages, 'image') === 0, 'a text-only model sees no image at all');
    })
);

results.push(
    await runCase('messages pulled in by /chat dedupe exactly like reply-tree messages', async () => {
        const chatId = nextChat();
        const url = 'https://fxtwitter.com/someone/status/789';
        await seedPreview({
            url,
            title: 'Fx post',
            description: 'Description',
            fullText: 'Thread text',
            images: [PNG_A],
        });
        // The group flow: the fixup bot's message and the user's inline message.
        const botMessage = await seedMessage(chatId, {
            text: `someone: ${url}`,
            userName: '丁二™自动机',
        });
        const userMessage = await seedMessage(chatId, { text: url, userName: 'tester' });
        const command = await seedMessage(chatId, { text: '/chat 两条 fx 链接' });
        await saveMessageLinks(chatId, command, [botMessage, userMessage]);

        const messages = await build(chatId, command);
        const headings = messages.map(textOf);

        expect(textsWith(messages, '[system] 链接预览：').length === 1, 'one full block across the /chat pull');
        const pointers = textsWith(messages, POINTER(1));
        expect(pointers.length === 1, `one pointer for the duplicate (got ${pointers.length})`);
        expect(headings.some((text) => text.includes('丁二™自动机')), 'the bot message is in the context');
        expect(partsOfType(messages, 'image') === 1, 'the preview image is attached once');
    })
);

results.push(
    await runCase('a preview that only one message carries is unchanged', async () => {
        const chatId = nextChat();
        await seedPreview({
            url: 'https://example.com/once',
            title: 'Once',
            description: 'Desc',
            fullText: 'Body',
            images: [PNG_A],
        });
        const trigger = await seedMessage(chatId, { text: 'https://example.com/once' });
        const messages = await build(chatId, trigger);

        expect(textsWith(messages, '[system] 链接预览：').length === 1, 'the single preview block is there');
        expect(textsWith(messages, POINTER(1)).length === 0, 'no pointer for a single occurrence');
        expect(partsOfType(messages, 'image') === 1, 'its image is there');
    })
);

await reportResults(results);
