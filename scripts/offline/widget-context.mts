/**
 * Offline cases for widget context replay — a card the bot sent comes back to
 * it as its rendered picture plus (A2UI mode) the source surface it was built
 * from, so a later turn can see and revise it.
 *
 * The bot row of a widget reply is written by the delivery path with the 600px
 * render as its `file` and `mediaHint='a widget'`; this file seeds exactly that
 * shape and proves the existing media path turns it into an image part without
 * any widget-specific image loading.
 *
 * Run: npx tsx scripts/offline/widget-context.mts
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
import type { ResponseVersion } from '../../src/db/botResponseDTO.js';

// The bot's own rows are stored as messages of this user
process.env.BOT_USER_ID = '7777';

const db = await setupOfflineDb();
const { Message } = db;
const dbIndex = await import('../../src/db/index.js');
const { buildContext, renderA2uiSurfaceNote } = await import('../../src/reply/context-builder.js');
const { loadWidgetSurfaces } = await import('../../src/db/queries/context-queries.js');
const { buildStaticSystemPrompt } = await import('../../src/ai/system-prompt/index.js');

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

/** A real 1x1 PNG: enough to be stored and compared as the rendered card */
const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
);

const VISION: ModelCapabilities = {
    supportsImageInput: true,
    supportsImageOutput: false,
    supportsSystemPrompt: true,
    requiresMessageMerge: false,
    supportsThinking: true,
    supportsGrounding: true,
    supportsMediaInput: false,
};

/** Same model shape without vision: the surface text must survive on its own */
const TEXT_ONLY: ModelCapabilities = { ...VISION, supportsImageInput: false };

const surfaceOf = (text: string): Record<string, unknown> => ({
    version: '1.0',
    createSurface: { components: [{ id: 'root', component: 'Text', text }], dataModel: {} },
});

const seedRow = async (
    fields: Record<string, unknown> & { messageId?: number; chatId?: number }
): Promise<number> => {
    const messageId = fields.messageId ?? takeMessageId();
    await Message.create({
        chatId: fields.chatId ?? OFFLINE_CHAT_ID,
        messageId,
        fromBotSelf: false,
        userId: 1001,
        date: new Date(messageId * 1000),
        userName: 'Alice',
        text: `message ${messageId}`,
        quoteText: null,
        file: null,
        fileMime: null,
        fileUniqueId: null,
        replyToId: null,
        chatCommand: null,
        modelParts: null,
        mediaHint: null,
        forwardOrigin: null,
        forwardFromId: null,
        viaBot: null,
        ocrText: null,
        ...fields,
    });
    return messageId;
};

const rowOf = (chatId: number, messageId: number) => Message.findOne({ where: { chatId, messageId } });

const seedResponse = async (options: {
    chatId: number;
    firstMessageId: number;
    userMessageId: number;
    versions?: Array<Partial<ResponseVersion>>;
    currentVersionIndex?: number;
    /** Raw versions JSON, for malformed-row cases the typed shape cannot express */
    rawVersions?: string;
}): Promise<void> => {
    const versions: ResponseVersion[] = (options.versions ?? []).map((version, index) => ({
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
        currentVersionIndex: options.currentVersionIndex ?? Math.max(0, versions.length - 1),
        versions: options.rawVersions ?? JSON.stringify(versions),
        buttonState: dbIndex.ButtonState.NONE,
        metadata: JSON.stringify({ model: 'offline', hasImage: false }),
    });
};

/**
 * A card reply as the delivery path stores it: the text row (which carries the
 * rendered PNG and `mediaHint='a widget'`) plus a version whose own message ids
 * include the separate Telegram message the card was sent as. Returns the id of
 * that card message, which is what a user swipe-replies to.
 */
const seedWidgetReply = async (options: {
    chatId: number;
    askerId: number;
    replyId: number;
    text: string;
    mediaHint?: string | null;
    file?: Buffer | null;
    widget?: Record<string, unknown>;
}): Promise<number> => {
    const widgetMessageId = takeMessageId();
    await seedRow({
        chatId: options.chatId,
        messageId: options.replyId,
        fromBotSelf: true,
        userId: 7777,
        text: options.text,
        replyToId: options.askerId,
        file: options.file === undefined ? PNG_BYTES : options.file,
        fileMime: options.file === null ? null : 'image/png',
        mediaHint: options.mediaHint === undefined ? 'a widget' : options.mediaHint,
    });
    if (options.widget !== undefined) {
        await seedResponse({
            chatId: options.chatId,
            firstMessageId: options.replyId,
            userMessageId: options.askerId,
            versions: [
                {
                    text: options.text,
                    messageIds: [options.replyId, widgetMessageId],
                    currentMessageId: widgetMessageId,
                    widget: {
                        mode: 'a2ui',
                        html: '<div>card</div>',
                        messageId: widgetMessageId,
                        htmlBytes: 16,
                        zlibBytes: 12,
                        ...options.widget,
                    },
                },
            ],
        });
    }
    return widgetMessageId;
};

/** Seed the question that answers `replyToId` and build the context it would see */
const contextAfter = async (
    chatId: number,
    replyToId: number,
    capabilities: ModelCapabilities = VISION
): Promise<{ built: Awaited<ReturnType<typeof buildContext>>; assistant: UnifiedMessage | undefined }> => {
    const follower = await seedRow({ chatId, replyToId, text: '这张卡片画了什么' });
    const row = await rowOf(chatId, follower);
    if (!row) throw new Error('follower row missing');
    const built = await buildContext(row, { capabilities, model: 'gemini-3.8-flash' });
    return { built, assistant: built.messages.find((turn) => turn.role === 'assistant') };
};

const textOf = (turn: UnifiedMessage | undefined): string =>
    (turn?.content ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('\n');

const imagesOf = (turn: UnifiedMessage | undefined): UnifiedContentPart[] =>
    (turn?.content ?? []).filter((part) => part.type === 'image');

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const cases: Array<{ name: string; body: () => Promise<void> }> = [
    {
        name: 'a widget reply replays its rendered picture and the A2UI source',
        body: async () => {
            const chatId = -1003900000101;
            const askerId = takeMessageId();
            const replyId = takeMessageId();
            await seedRow({ chatId, messageId: askerId, text: '做个日报卡片' });
            const surface = surfaceOf('日报');
            await seedWidgetReply({
                chatId,
                askerId,
                replyId,
                text: '日报做好了',
                widget: { surface },
            });

            const { built, assistant } = await contextAfter(chatId, replyId);
            const images = imagesOf(assistant);
            expect(images.length === 1, `the card PNG rides the assistant turn as one image part (got ${images.length})`);
            expect(
                Buffer.from(images[0]?.imageData ?? '', 'base64').equals(PNG_BYTES),
                'the image part is the stored render, byte for byte'
            );
            expect(images[0]?.mimeType === 'image/png', `the image part keeps its PNG MIME (got ${images[0]?.mimeType})`);

            const text = textOf(assistant);
            expect(text.includes('[sent a widget]'), `the fact line is replayed (got ${JSON.stringify(text)})`);
            expect(
                text.includes(`[a2ui surface] ${JSON.stringify(surface)}`),
                `the A2UI source is replayed as minified JSON (got ${JSON.stringify(text)})`
            );
            expect(
                text.includes('[sent a widget]\n[a2ui surface] '),
                'the surface line sits right after the fact line'
            );
            expect(text.includes('日报做好了'), 'the caption stored as the row text is still replayed');

            const entry = [...built.contextIndex.values()].find((value) => value.messageId === replyId);
            expect(
                entry?.imageCount === 1 && entry.images[0]?.origin === 'attachment',
                `the card's #N counts the rendered picture as an attachment (got ${entry?.imageCount})`
            );
        },
    },
    {
        name: 'replying to the card message itself still replays the card',
        body: async () => {
            const chatId = -1003900000111;
            const askerId = takeMessageId();
            const replyId = takeMessageId();
            await seedRow({ chatId, messageId: askerId, text: '做个日报卡片' });
            const surface = surfaceOf('卡片消息');
            const widgetMessageId = await seedWidgetReply({
                chatId,
                askerId,
                replyId,
                text: '日报做好了',
                widget: { surface },
            });

            // The user swipe-replies to the card message, not to the text
            // message: that id resolves only through the version's message ids,
            // and the context must still hold the reply row that carries the PNG
            const { built, assistant } = await contextAfter(chatId, widgetMessageId);
            const images = imagesOf(assistant);
            expect(
                images.length === 1 && Buffer.from(images[0]?.imageData ?? '', 'base64').equals(PNG_BYTES),
                'the rendered card is replayed when the card message is the reply target'
            );
            expect(
                textOf(assistant).includes(`[a2ui surface] ${JSON.stringify(surface)}`),
                'and so is its A2UI source'
            );
            const entry = [...built.contextIndex.values()].find((value) => value.messageId === replyId);
            expect(entry !== undefined, 'the reply row is the context message that carries the card');
        },
    },
    {
        name: 'a surface stored as a JSON string is replayed as an object',
        body: async () => {
            const chatId = -1003900000102;
            const askerId = takeMessageId();
            const replyId = takeMessageId();
            await seedRow({ chatId, messageId: askerId, text: '做张卡片' });
            const surface = surfaceOf('字符串模式');
            await seedWidgetReply({
                chatId,
                askerId,
                replyId,
                text: '好了',
                // send_widget declares surface as a string after issue #5, so a
                // new card stores the model's JSON text, not a parsed object
                widget: { surface: JSON.stringify(surface) },
            });

            const { assistant } = await contextAfter(chatId, replyId);
            const text = textOf(assistant);
            expect(
                text.includes(`[a2ui surface] ${JSON.stringify(surface)}`),
                `a JSON string is normalized to minified object JSON (got ${JSON.stringify(text)})`
            );
            expect(!text.includes('\\"'), 'no escaped quotes leak from the stored string');
        },
    },
    {
        name: 'a surface over 4000 characters is cut and marked',
        body: async () => {
            const chatId = -1003900000103;
            const askerId = takeMessageId();
            const replyId = takeMessageId();
            await seedRow({ chatId, messageId: askerId, text: '做张长卡片' });
            const surface = surfaceOf('x'.repeat(5000));
            const fullJson = JSON.stringify(surface);
            expect(Array.from(fullJson).length > 4000, `the fixture surface is longer than the cap (got ${fullJson.length})`);
            await seedWidgetReply({ chatId, askerId, replyId, text: '好了', widget: { surface } });

            const { assistant } = await contextAfter(chatId, replyId);
            const text = textOf(assistant);
            const line = text.split('\n').find((candidate) => candidate.startsWith('[a2ui surface] '));
            expect(line !== undefined, 'the surface line is present');
            const replayed = line === undefined ? '' : line.slice('[a2ui surface] '.length);
            expect(replayed.endsWith('…（已截断）'), `the cut is marked (got ${JSON.stringify(replayed.slice(-12))})`);
            expect(
                Array.from(replayed).length === 4000 + Array.from('…（已截断）').length,
                `exactly 4000 source characters are kept (got ${Array.from(replayed).length})`
            );
            expect(
                replayed.startsWith(Array.from(fullJson).slice(0, 4000).join('')),
                'the kept prefix is the head of the minified surface'
            );
        },
    },
    {
        name: 'HTML mode replays the picture but no source',
        body: async () => {
            const chatId = -1003900000104;
            const askerId = takeMessageId();
            const replyId = takeMessageId();
            await seedRow({ chatId, messageId: askerId, text: '做张 HTML 卡片' });
            await seedWidgetReply({
                chatId,
                askerId,
                replyId,
                text: '好了',
                widget: { mode: 'html', html: '<div class="secret-source">hello</div>', htmlBytes: 42, zlibBytes: 30 },
            });

            const { assistant } = await contextAfter(chatId, replyId);
            const text = textOf(assistant);
            expect(text.includes('[sent a widget]'), 'the fact line is replayed');
            expect(!text.includes('[a2ui surface]'), 'no A2UI line for an HTML card');
            expect(!text.includes('secret-source'), 'the widget HTML itself never enters the context');
            expect(imagesOf(assistant).length === 1, 'the rendered picture still rides the turn');
        },
    },
    {
        name: 'a card stored before renders or surfaces existed replays the fact line only',
        body: async () => {
            const chatId = -1003900000105;
            const askerId = takeMessageId();
            const replyId = takeMessageId();
            await seedRow({ chatId, messageId: askerId, text: '旧卡片' });
            // Pre-render data: the row names the card but has no bytes, and the
            // version keeps no surface
            await seedWidgetReply({ chatId, askerId, replyId, text: '旧卡片好了', file: null });

            const { assistant } = await contextAfter(chatId, replyId);
            const text = textOf(assistant);
            expect(text.includes('[sent a widget]'), 'the fact line is still replayed');
            expect(!text.includes('[a2ui surface]'), 'no surface to replay');
            expect(imagesOf(assistant).length === 0, 'no picture is invented for an unrendered card');
            expect(text.includes('旧卡片好了'), 'the caption is replayed');
            expect(
                !text.includes('still being generated') && !text.includes('without producing any text'),
                'a card with no picture is not mistaken for an interrupted reply'
            );

            // A row with no bot_responses record at all (lost version) behaves the same
            const orphanChatId = -1003900000155;
            const orphanAsker = takeMessageId();
            const orphanReply = takeMessageId();
            await seedRow({ chatId: orphanChatId, messageId: orphanAsker, text: '孤儿卡片' });
            await seedWidgetReply({
                chatId: orphanChatId,
                askerId: orphanAsker,
                replyId: orphanReply,
                text: '孤儿卡片好了',
                file: null,
            });
            const orphan = await contextAfter(orphanChatId, orphanReply);
            const orphanText = textOf(orphan.assistant);
            expect(orphanText.includes('[sent a widget]'), 'the orphan card still replays its fact line');
            expect(!orphanText.includes('[a2ui surface]'), 'and nothing else');
        },
    },
    {
        name: 'a text-only model gets the surface text without the picture',
        body: async () => {
            const chatId = -1003900000106;
            const askerId = takeMessageId();
            const replyId = takeMessageId();
            await seedRow({ chatId, messageId: askerId, text: '做张卡片' });
            const surface = surfaceOf('无视觉模型');
            await seedWidgetReply({ chatId, askerId, replyId, text: '好了', widget: { surface } });

            const { assistant } = await contextAfter(chatId, replyId, TEXT_ONLY);
            expect(imagesOf(assistant).length === 0, 'the picture is filtered out for a text-only model');
            const text = textOf(assistant);
            expect(
                text.includes(`[a2ui surface] ${JSON.stringify(surface)}`),
                'the A2UI source is text, so it survives the capability filter'
            );
        },
    },
    {
        name: 'loadWidgetSurfaces reads only the current version and skips missing or malformed rows',
        body: async () => {
            const chatId = -1003900000107;
            const surfaceA = surfaceOf('A');
            const surfaceB = surfaceOf('B');
            const a = takeMessageId();
            const b = takeMessageId();
            const textOnly = takeMessageId();
            const brokenJson = takeMessageId();
            const badMode = takeMessageId();
            const outOfRange = takeMessageId();

            await seedResponse({
                chatId,
                firstMessageId: a,
                userMessageId: 1,
                versions: [{ text: 'A', widget: { mode: 'a2ui', html: '<div>A</div>', htmlBytes: 14, zlibBytes: 10, surface: surfaceA } }],
            });
            // The current version is the second one: a card was switched in
            await seedResponse({
                chatId,
                firstMessageId: b,
                userMessageId: 2,
                currentVersionIndex: 1,
                versions: [
                    { text: 'B-old', widget: { mode: 'html', html: '<div>old</div>', htmlBytes: 14, zlibBytes: 10 } },
                    { text: 'B', widget: { mode: 'a2ui', html: '<div>B</div>', htmlBytes: 14, zlibBytes: 10, surface: surfaceB } },
                ],
            });
            await seedResponse({ chatId, firstMessageId: textOnly, userMessageId: 3, versions: [{ text: 'no card' }] });
            await seedResponse({ chatId, firstMessageId: brokenJson, userMessageId: 4, rawVersions: 'not-json' });
            await seedResponse({
                chatId,
                firstMessageId: badMode,
                userMessageId: 5,
                rawVersions: JSON.stringify([{ text: 'bad', widget: { mode: 'weird', html: '<div>x</div>' } }]),
            });
            await seedResponse({
                chatId,
                firstMessageId: outOfRange,
                userMessageId: 6,
                currentVersionIndex: 9,
                versions: [{ text: 'x', widget: { mode: 'a2ui', html: '<div>x</div>', htmlBytes: 14, zlibBytes: 10, surface: surfaceA } }],
            });

            const surfaces = await loadWidgetSurfaces(chatId, [
                a,
                b,
                textOnly,
                brokenJson,
                badMode,
                outOfRange,
                987_654_321,
            ]);
            expect(surfaces.size === 2, `only the two valid cards are returned (got ${surfaces.size})`);
            expect(
                surfaces.get(a)?.mode === 'a2ui' && JSON.stringify(surfaces.get(a)?.surface) === JSON.stringify(surfaceA),
                'the first card keeps its mode and surface'
            );
            expect(
                JSON.stringify(surfaces.get(b)?.surface) === JSON.stringify(surfaceB),
                'the switched-in version is the one read, not the stale first one'
            );
            expect(
                !surfaces.has(textOnly) &&
                    !surfaces.has(brokenJson) &&
                    !surfaces.has(badMode) &&
                    !surfaces.has(outOfRange) &&
                    !surfaces.has(987_654_321),
                'text-only, malformed, unknown-mode, out-of-range and missing rows are all skipped'
            );
            expect((await loadWidgetSurfaces(chatId, [])).size === 0, 'an empty batch is one no-op');
        },
    },
    {
        name: 'the pure surface formatter never replays HTML or an absent source',
        body: async () => {
            expect(renderA2uiSurfaceNote(undefined) === '', 'no widget, no line');
            expect(renderA2uiSurfaceNote({ mode: 'html' }) === '', 'HTML mode, no line');
            expect(renderA2uiSurfaceNote({ mode: 'a2ui' }) === '', 'A2UI without a surface, no line');
            expect(renderA2uiSurfaceNote({ mode: 'a2ui', surface: null }) === '', 'a null surface, no line');
            const note = renderA2uiSurfaceNote({ mode: 'a2ui', surface: { a: 1 } });
            expect(note === '[a2ui surface] {"a":1}\n', `an object surface is minified into one line (got ${JSON.stringify(note)})`);
        },
    },
    {
        name: 'the format section documents how a sent card is replayed',
        body: async () => {
            const prompt = buildStaticSystemPrompt('gemini-4-argon');
            expect(prompt.includes('[sent a widget]'), 'the fact line is documented');
            expect(prompt.includes('[a2ui surface] {…}'), 'the A2UI replay line is documented');
            expect(prompt.includes('…（已截断）'), 'the truncation mark is documented');
            expect(
                prompt.includes('[sent a widget]') &&
                    prompt.indexOf('[sent a widget]') < prompt.indexOf('[a2ui surface] {…}'),
                'the two are documented together in wire order'
            );
        },
    },
];

// ---------------------------------------------------------------------------

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
reportResults(results);
