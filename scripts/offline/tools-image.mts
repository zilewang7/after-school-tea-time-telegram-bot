/**
 * Offline cases for generate_image and the image half of a reply (no
 * containers, no network).
 *
 * Run: npx tsx scripts/offline/tools-image.mts
 *
 * Covers the tool's argument checks, `#N` reference resolution against the
 * scratch database (album members, the bot's own images, bytes only a reply
 * version still keeps), the one-image-per-reply rule, how the image model's
 * stream is drained and its failures are worded for the chat model, caption
 * rendering and delivery, and the storage fixes that came with them: the bot
 * row is overwritten whole (B5), the continuation lookup prefilters in SQL
 * (B6) and an image nobody saw is never stored (B7: an error, or Telegram
 * refusing both the photo and the document).
 *
 * The image model is a stub sendMessage injected into the tool, so nothing is
 * ever generated. Telegram is a real grammY Api whose transformer answers
 * every call locally, so the reply pipeline runs unmodified.
 *
 * Every project module is imported dynamically AFTER the env below is set and
 * the scratch database is in place: the db layer opens DB_PATH on import.
 */
import { Api, Context, type Transformer } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import {
    OFFLINE_CHAT_ID,
    expect,
    reportResults,
    runCase,
    setupOfflineDb,
    takeMessageId,
    type CaseResult,
} from './harness.mts';
import type { AIResponse, PlatformConfig, ResponseState, StreamChunk, UnifiedMessage } from '../../src/ai/types.js';
import type { ToolHandler, ToolResult } from '../../src/ai/tools/tool-types.js';
import type { ResponseVersion } from '../../src/db/botResponseDTO.js';
import type { ContextIndex } from '../../src/reply/context-index.js';

// The bot's own rows are stored as messages of this user
process.env.BOT_USER_ID = '7777';
// Context building must never try to recover a message over the network
delete process.env.LUOXU_PREVIEW_URL;

const db = await setupOfflineDb();
const { Message, putCachedMedia } = db;

const { createGenerateImageTool } = await import('../../src/reply/tools/generate-image-tool.js');
const { parseGenerateImageArgs } = await import('../../src/reply/tools/image-tool-args.js');
const { resolveImageReferences } = await import('../../src/reply/tools/image-references.js');
const { buildImageCaption, IMAGE_CAPTION_MAX_LENGTH } = await import('../../src/reply/tools/image-message.js');
const { ONE_IMAGE_PER_REPLY } = await import('../../src/reply/tools/image-tool-result.js');
const { buildReplyToolContext } = await import('../../src/reply/tools/reply-tool-context.js');
const { createReplyMediaState } = await import('../../src/reply/tools/reply-media-state.js');
const imageGeneration = await import('../../src/ai/image-generation/index.js');
const { GEMINI_IMAGE_MODEL } = await import('../../src/config/models.js');
const { loadMessageImages, collectReferenceImages } = await import('../../src/reply/commands/reference-images.js');
const { buildContext } = await import('../../src/reply/context-builder.js');
const responseHandler = await import('../../src/reply/response-handler.js');
const { switchVersion, startRetry } = await import('../../src/services/bot-message-service.js');
const dbIndex = await import('../../src/db/index.js');

// ---------------------------------------------------------------------------
// Fixtures and small helpers
// ---------------------------------------------------------------------------

const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlZkAAAAASUVORK5CYII=',
    'base64'
);
// Only the signatures matter to the sniffer
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF offline jpeg')]);
const WEBP_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBPVP8 offline webp')]);
const GIF_BYTES = Buffer.from('GIF89a offline gif');

const IMAGE_READY = '图片已生成，会带着配文附在你这条回复后面发出。';
const BUSY = '生图服务繁忙（429），可以稍后重试或换个说法。';

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : {};

const json = (value: unknown): string => JSON.stringify(value);

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

const emptyState = (): ResponseState => ({
    textBuffer: '',
    thinkingBuffer: '',
    fullText: '',
    fullThinking: '',
    thinkingTruncatedChars: 0,
    images: [],
    groundingData: [],
    agentStats: undefined,
    modelParts: undefined,
    rawResponse: undefined,
    isDone: false,
});

const reply = (fields: Partial<AIResponse>): AIResponse => ({
    text: '',
    thinkingText: '',
    images: [],
    groundingData: [],
    ...fields,
});

/** Insert one message row directly, bypassing the Telegram-facing save path */
const seedRow = async (fields: Record<string, unknown> & { messageId?: number }): Promise<number> => {
    const messageId = fields.messageId ?? takeMessageId();
    await Message.create({
        chatId: OFFLINE_CHAT_ID,
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

/** A stored reply with the given versions; the last one is current unless told otherwise */
const seedResponse = async (options: {
    chatId?: number;
    firstMessageId: number;
    userMessageId: number;
    versions: Array<Partial<ResponseVersion>>;
    currentVersionIndex?: number;
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
        chatId: options.chatId ?? OFFLINE_CHAT_ID,
        userMessageId: options.userMessageId,
        currentVersionIndex: options.currentVersionIndex ?? versions.length - 1,
        versions: JSON.stringify(versions),
        buttonState: dbIndex.ButtonState.NONE,
        metadata: JSON.stringify({ model: 'offline', hasImage: false }),
    });
};

// ---- the image model: a stub sendMessage that records every request ----

interface ImageRequest {
    readonly messages: UnifiedMessage[];
    readonly config: PlatformConfig;
}

type ImageModelAnswer = readonly StreamChunk[] | Error;

const imageAnswer = (image: Buffer, mimeType = 'image/png'): StreamChunk[] => [
    { type: 'thinking', content: '先打个草稿' },
    { type: 'image', imageData: image, imageMimeType: mimeType },
    { type: 'done', rawResponse: { candidates: [{ finishReason: 'STOP' }] } },
];

const noImageAnswer = (rawResponse: unknown, text = ''): StreamChunk[] => [
    ...(text ? [{ type: 'text' as const, content: text }] : []),
    { type: 'done', rawResponse },
];

const stubImageModel = (answer: (request: ImageRequest) => ImageModelAnswer = () => imageAnswer(PNG_BYTES)) => {
    const requests: ImageRequest[] = [];
    const sendMessage = async (messages: UnifiedMessage[], config: PlatformConfig): Promise<AsyncIterable<StreamChunk>> => {
        const request = { messages, config };
        requests.push(request);
        const scripted = answer(request);
        if (scripted instanceof Error) throw scripted;
        return (async function* (): AsyncGenerator<StreamChunk> {
            yield* scripted;
        })();
    };
    return { sendMessage, requests };
};

type ImageModel = ReturnType<typeof stubImageModel>;

const noNetworkFetch = async (): Promise<{ ok: false; error: string }> => ({
    ok: false,
    error: 'offline: no network',
});

const toolFor = (contextIndex: ContextIndex, model: ImageModel, signal = new AbortController().signal): ToolHandler =>
    createGenerateImageTool(
        buildReplyToolContext({
            chat: { id: OFFLINE_CHAT_ID, type: 'supergroup', title: '测试群' },
            triggerMessage: { messageId: 1, userId: 42, userName: '张三', text: null },
            contextIndex,
            signal,
        }),
        createReplyMediaState(null),
        { sendMessage: model.sendMessage, loadMessageImages, fetchImage: noNetworkFetch }
    );

const runTool = async (tool: ToolHandler, args: Record<string, unknown>): Promise<ToolResult> =>
    (await captureConsole(() => tool.execute(args, new AbortController().signal))).result;

/** The parts of the one user turn a request carried */
const partsOf = (request: ImageRequest | undefined) => request?.messages[0]?.content ?? [];

const imagesOf = (request: ImageRequest | undefined): Buffer[] =>
    partsOf(request)
        .filter((part) => part.type === 'image')
        .map((part) => Buffer.from(part.imageData ?? '', 'base64'));

const NO_CONTEXT: ContextIndex = new Map();

/** A context index without a database behind it */
const indexOf = (imageCounts: number[]): ContextIndex =>
    new Map(
        imageCounts.map((imageCount, position) => [
            position + 1,
            { number: position + 1, messageId: 50_000 + position, fromBot: false, imageCount },
        ])
    );

// ---- the reference tree: an album, the bot's images, a plain message ----

const VISION = {
    supportsImageInput: true,
    supportsImageOutput: false,
    supportsSystemPrompt: true,
    requiresMessageMerge: false,
    supportsThinking: true,
    supportsGrounding: true,
    supportsMediaInput: false,
};

/**
 * #1 album (PNG + JPEG member) ← #2 the bot's picture ← #3 a plain question
 * ← #4 a bot reply whose row bytes are gone but whose version keeps a WebP
 * ← #5 the trigger. Numbered by the real context builder.
 */
const buildReferenceTree = async () => {
    const albumUniqueId = `image-album-${takeMessageId()}`;
    const memberUniqueId = `image-album-member-${takeMessageId()}`;
    await putCachedMedia({ fileUniqueId: albumUniqueId, data: PNG_BYTES, sizeBytes: PNG_BYTES.length, mime: 'image/png', kind: 'photo' });
    await putCachedMedia({ fileUniqueId: memberUniqueId, data: JPEG_BYTES, sizeBytes: JPEG_BYTES.length, mime: 'image/jpeg', kind: 'photo' });

    const album = await seedRow({ text: '两张参考图', fileUniqueId: albumUniqueId, mediaHint: 'a picture' });
    await seedRow({ replyToId: album, text: `sub image of [${album}]`, fileUniqueId: memberUniqueId });
    const botPicture = await seedRow({
        fromBotSelf: true,
        userId: 7777,
        userName: 'Bot',
        text: '画好了',
        file: PNG_BYTES,
        fileMime: 'image/png',
        replyToId: album,
    });
    const question = await seedRow({ text: '再来一张', replyToId: botPicture });
    const botVersioned = await seedRow({ fromBotSelf: true, userId: 7777, userName: 'Bot', text: '又画了一张', replyToId: question });
    await seedResponse({
        firstMessageId: botVersioned,
        userMessageId: question,
        versions: [{ text: '又画了一张', imageBase64: WEBP_BYTES.toString('base64'), imageCaption: '第二张' }],
    });
    const trigger = await seedRow({ text: '把这几张拼在一起', replyToId: botVersioned });

    const row = await rowOf(OFFLINE_CHAT_ID, trigger);
    if (!row) throw new Error('the trigger row was not stored');
    const { result: built } = await captureConsole(() => buildContext(row, { capabilities: VISION, model: 'gemini-3.8-flash' }));
    return { contextIndex: built.contextIndex, album, botPicture, question, botVersioned, trigger };
};

const tree = await buildReferenceTree();

// ---- fake Telegram: a real grammY Api whose transformer answers locally ----

interface TelegramCall {
    readonly method: string;
    readonly payload: Readonly<Record<string, unknown>>;
}

interface FakeTelegram {
    readonly api: Api;
    readonly calls: TelegramCall[];
    /** Methods answered with a 400, e.g. sendPhoto to force the document fallback */
    readonly failingMethods: Set<string>;
    /** Methods answered with a 400 whenever the call carries caption entities */
    readonly entityRefusingMethods: Set<string>;
    readonly sentIds: (method: string) => number[];
}

const SENDING_METHODS: ReadonlySet<string> = new Set(['sendMessage', 'sendPhoto', 'sendDocument']);
let nextFakeMessageId = 190_000;

const fakeChat = (chatId: number) => ({ id: chatId, type: 'supergroup' as const, title: '测试群' });

const createFakeTelegram = (chatId: number): FakeTelegram => {
    const calls: TelegramCall[] = [];
    const failingMethods = new Set<string>();
    const entityRefusingMethods = new Set<string>();
    const sent: Array<{ readonly method: string; readonly messageId: number }> = [];

    const answer = async (method: string, payload: unknown) => {
        const fields = asRecord(payload);
        calls.push({ method, payload: fields });
        if (failingMethods.has(method)) {
            return { ok: false, error_code: 400, description: `Bad Request: ${method} refused offline` };
        }
        if (entityRefusingMethods.has(method) && 'caption_entities' in fields) {
            return { ok: false, error_code: 400, description: "Bad Request: can't parse entities offline" };
        }
        if (!SENDING_METHODS.has(method)) return { ok: true, result: true };
        nextFakeMessageId += 1;
        sent.push({ method, messageId: nextFakeMessageId });
        return { ok: true, result: { message_id: nextFakeMessageId, date: 0, chat: fakeChat(chatId) } };
    };

    const api = new Api('0:offline-token');
    // The transformer is generic over every method: one cast at this boundary
    const offlineTransformer = (_previous: unknown, method: string, payload: unknown) => answer(method, payload);
    api.config.use(offlineTransformer as Transformer);

    return {
        api,
        calls,
        failingMethods,
        entityRefusingMethods,
        sentIds: (method) => sent.filter((message) => message.method === method).map((message) => message.messageId),
    };
};

const BOT_ME: UserFromGetMe = {
    id: 7777,
    is_bot: true,
    first_name: 'Bot',
    username: 'AfterSchoolTeatimeBot',
    can_join_groups: true,
    can_read_all_group_messages: true,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
};

const contextIn = (telegram: FakeTelegram, chatId: number, messageId: number): Context =>
    new Context(
        {
            update_id: messageId,
            message: {
                message_id: messageId,
                date: 0,
                chat: fakeChat(chatId),
                from: { id: 42, is_bot: false, first_name: '张三' },
                text: '画一只猫',
            },
        },
        telegram.api,
        BOT_ME
    );

/** A chat context exactly as a real trigger message creates it */
const startChat = async (chatId: number) => {
    const telegram = createFakeTelegram(chatId);
    const ctx = contextIn(telegram, chatId, takeMessageId());
    const { result: chatContext } = await captureConsole(() => responseHandler.createChatContext(ctx));
    if (!chatContext) throw new Error('the chat context was not created');
    return { telegram, chatContext };
};

/** What processStream syncs into the session while a reply streams */
const syncSession = (chatContext: Awaited<ReturnType<typeof startChat>>['chatContext'], response: AIResponse): void => {
    chatContext.session.textBuffer = response.text;
    chatContext.session.images = response.images;
};

/** Deliver a finished reply and read back what was sent and stored */
const deliver = async (
    chatId: number,
    response: AIResponse,
    failingMethods: string[] = [],
    entityRefusingMethods: string[] = []
) => {
    const { telegram, chatContext } = await startChat(chatId);
    failingMethods.forEach((method) => telegram.failingMethods.add(method));
    entityRefusingMethods.forEach((method) => telegram.entityRefusingMethods.add(method));
    const firstId = chatContext.session.firstMessageId;
    syncSession(chatContext, response);
    await captureConsole(() => responseHandler.sendFinalResponse(chatContext, response));
    const stored = await dbIndex.getBotResponse(chatId, firstId);
    return {
        telegram,
        chatContext,
        version: stored?.getVersions().at(-1),
        row: await rowOf(chatId, firstId),
    };
};

const callsOf = (telegram: FakeTelegram, method: string): TelegramCall[] =>
    telegram.calls.filter((telegramCall) => telegramCall.method === method);

const fileNameOf = (upload: unknown): unknown => asRecord(upload).filename;

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const cases: Array<{ name: string; body: () => Promise<void> }> = [
    {
        name: 'generate_image arguments are checked against the schema',
        body: async () => {
            const minimal = parseGenerateImageArgs({ prompt: '  一只猫  ', caption: '' });
            expect(
                minimal.ok &&
                    minimal.args.prompt === '一只猫' &&
                    minimal.args.caption === '' &&
                    minimal.args.references.length === 0 &&
                    minimal.args.aspectRatio === undefined,
                'prompt and an empty caption are enough'
            );

            const full = parseGenerateImageArgs({
                prompt: '把猫换成狗',
                caption: '换好了',
                references: [{ message: 3 }, { message: 1, image: 2 }],
                aspect_ratio: '16:9',
            });
            expect(
                full.ok &&
                    json(full.args.references) === json([{ message: 3 }, { message: 1, image: 2 }]) &&
                    full.args.aspectRatio === '16:9',
                'references and the aspect ratio are read'
            );

            const nulls = parseGenerateImageArgs({ prompt: '猫', caption: '猫', references: null, aspect_ratio: null });
            expect(nulls.ok && nulls.args.references.length === 0 && nulls.args.aspectRatio === undefined, 'null optional fields count as absent');

            const broken = parseGenerateImageArgs({
                prompt: '   ',
                references: [{ message: 0 }, { message: '3' }, { message: 2, image: 0 }, 'x'],
                aspect_ratio: '7:3',
            });
            const problems = broken.ok ? '' : broken.error;
            expect(
                problems.startsWith('参数有误：') &&
                    problems.includes('prompt 必须是非空字符串') &&
                    problems.includes('caption 必须是字符串') &&
                    problems.includes('references[0].message 必须是正整数') &&
                    problems.includes('references[1].message 必须是正整数') &&
                    problems.includes('references[2].image 必须是从 1 开始的正整数') &&
                    problems.includes('references[3] 必须是') &&
                    problems.includes('aspect_ratio 只能是 1:1、2:3'),
                `every problem is listed at once (got ${json(problems)})`
            );
            const notArray = parseGenerateImageArgs({ prompt: '猫', caption: '', references: { message: 1 } });
            expect(!notArray.ok && notArray.error.includes('references 必须是数组'), 'references must be an array');

            const model = stubImageModel();
            const result = await runTool(toolFor(NO_CONTEXT, model), { prompt: '猫' });
            expect(result.isError && result.content.includes('caption 必须是字符串'), 'the tool answers bad arguments with an error');
            expect(model.requests.length === 0, 'and never reaches the image model');
        },
    },
    {
        name: 'references resolve #N to the stored images, album members and the bot’s own',
        body: async () => {
            const entries = [...tree.contextIndex.values()].map((entry) => `#${entry.number}:${entry.imageCount}`);
            expect(
                json(entries) === json(['#1:2', '#2:1', '#3:0', '#4:0', '#5:0']),
                `the context numbers the tree as expected (got ${json(entries)})`
            );

            const generate = async (args: Record<string, unknown>) => {
                const model = stubImageModel();
                const result = await runTool(toolFor(tree.contextIndex, model), { prompt: '拼图', caption: '', ...args });
                return { result, request: model.requests[0] };
            };

            const member = await generate({ references: [{ message: 1, image: 2 }] });
            expect(!member.result.isError, `an album member resolves (got ${json(member.result.content)})`);
            const memberParts = partsOf(member.request);
            expect(
                memberParts.length === 2 &&
                    memberParts[0]?.type === 'image' &&
                    memberParts[0].mimeType === 'image/jpeg' &&
                    imagesOf(member.request)[0]?.equals(JPEG_BYTES) === true &&
                    memberParts[1]?.type === 'text' &&
                    memberParts[1].text === '拼图',
                `one user turn: the picked image first, then the prompt (got ${json(memberParts.map((part) => part.type))})`
            );
            expect(
                member.request?.messages.length === 1 && member.request.messages[0]?.role === 'user',
                'the request is a single user turn'
            );

            const wholeAlbum = await generate({ references: [{ message: 1 }] });
            const albumImages = imagesOf(wholeAlbum.request);
            expect(
                albumImages.length === 2 && albumImages[0]?.equals(PNG_BYTES) === true && albumImages[1]?.equals(JPEG_BYTES) === true,
                'without `image` the whole album goes, in context order'
            );

            const botPicture = await generate({ references: [{ message: 2 }] });
            expect(imagesOf(botPicture.request)[0]?.equals(PNG_BYTES) === true, 'the bot’s own picture comes from its row');

            const versioned = await generate({ references: [{ message: 4 }] });
            const versionedParts = partsOf(versioned.request);
            expect(
                imagesOf(versioned.request)[0]?.equals(WEBP_BYTES) === true &&
                    versionedParts[0]?.type === 'image' &&
                    versionedParts[0].mimeType === 'image/webp',
                'a reply whose row bytes are gone resolves through its version, with the real mime'
            );

            const overlapping = await generate({ references: [{ message: 1 }, { message: 1, image: 1 }, { message: 2 }] });
            expect(imagesOf(overlapping.request).length === 3, 'an image picked twice is sent once');

            expect(
                (await collectReferenceImages(OFFLINE_CHAT_ID, [tree.album])).length === 2,
                '/picbanana still collects the album as base64 strings'
            );
        },
    },
    {
        name: 'the request carries the image model, one attempt and the output knobs',
        body: async () => {
            const model = stubImageModel();
            await runTool(toolFor(tree.contextIndex, model), { prompt: '画一只猫', caption: '' });
            const fromScratch = model.requests[0]?.config;
            expect(
                fromScratch?.model === GEMINI_IMAGE_MODEL &&
                    fromScratch.maxRetries === 1 &&
                    fromScratch.timeout === imageGeneration.IMAGE_GENERATION_TIMEOUT_MS &&
                    fromScratch.tools === undefined,
                `the image model, one attempt, the 120s budget, no tools (got ${json({ ...fromScratch, signal: undefined })})`
            );
            expect(
                json(fromScratch?.imageOutput) ===
                    json({ aspectRatio: '1:1', imageSize: '1K', instruction: 'Generate the image the user describes. Always respond with an image.' }),
                `from scratch: square, 1K, the generate_image instruction (got ${json(fromScratch?.imageOutput)})`
            );
            expect(fromScratch?.signal instanceof AbortSignal && !fromScratch.signal.aborted, 'a live signal rides along');

            const editModel = stubImageModel();
            await runTool(toolFor(tree.contextIndex, editModel), { prompt: '改成狗', caption: '', references: [{ message: 2 }] });
            const edit = editModel.requests[0]?.config.imageOutput;
            expect(edit !== undefined && !('aspectRatio' in edit) && edit.imageSize === '1K', 'an edit follows the source shape');

            const wideModel = stubImageModel();
            await runTool(toolFor(tree.contextIndex, wideModel), {
                prompt: '改成狗',
                caption: '',
                references: [{ message: 2 }],
                aspect_ratio: '16:9',
            });
            expect(wideModel.requests[0]?.config.imageOutput?.aspectRatio === '16:9', 'an explicit ratio wins');

            const stop = new AbortController();
            const stoppedModel = stubImageModel(({ config }) => {
                stop.abort();
                return config.signal?.aborted ? new Error('Aborted') : imageAnswer(PNG_BYTES);
            });
            const stopped = await runTool(toolFor(tree.contextIndex, stoppedModel, stop.signal), { prompt: '猫', caption: '' });
            expect(
                stopped.isError && stopped.content === '这条回复已被停止，图片没有生成。',
                `the reply’s stop reaches the request (got ${json(stopped.content)})`
            );
        },
    },
    {
        name: 'unusable references come back with the numbers that do have images',
        body: async () => {
            const model = stubImageModel();
            const tool = toolFor(tree.contextIndex, model);

            const missing = await runTool(tool, { prompt: '猫', caption: '', references: [{ message: 9 }, { message: 3 }] });
            expect(
                missing.isError &&
                    missing.content.includes('#9 不在当前上下文里') &&
                    missing.content.includes('#3 这条消息没有可用的图片') &&
                    missing.content.endsWith('当前上下文里带图的消息：#1（2 张）、#2（1 张）'),
                `each problem plus the numbers with images (got ${json(missing.content)})`
            );

            const pastAlbum = await runTool(tool, { prompt: '猫', caption: '', references: [{ message: 1, image: 3 }] });
            expect(pastAlbum.isError && pastAlbum.content.includes('#1 只有 2 张图，没有第 3 张'), 'an index past the album');
            expect(model.requests.length === 0, 'none of them reaches the image model');

            const loaderOf = (images: Buffer[]) => async () =>
                images.map((image) => ({ data: image.toString('base64'), mimeType: 'image/png' }));
            const resolveWith = (images: Buffer[], imageCounts: number[], references: Array<{ message: number; image: number | undefined }>) =>
                resolveImageReferences(references, {
                    chatId: OFFLINE_CHAT_ID,
                    contextIndex: indexOf(imageCounts),
                    loadMessageImages: loaderOf(images),
                });

            const gif = await resolveWith([GIF_BYTES], [1], [{ message: 1, image: undefined }]);
            expect(!gif.ok && gif.error.includes('#1 的图格式不支持（只支持 PNG、JPEG、WebP）'), 'a GIF is refused by its bytes');

            const huge = Buffer.concat([PNG_BYTES, Buffer.alloc(7 * 1024 * 1024)]);
            const oversized = await resolveWith([PNG_BYTES, huge], [2], [{ message: 1, image: undefined }]);
            expect(!oversized.ok && oversized.error.includes('#1 的第 2 张图超过 7MB'), 'an image over 7MB is refused');

            const many = await resolveWith(Array.from({ length: 7 }, () => PNG_BYTES), [7], [{ message: 1, image: undefined }]);
            expect(
                !many.ok && many.error.includes('参考图最多 6 张，这次选了 7 张') && many.error.endsWith('当前上下文里带图的消息：#1（7 张）'),
                `more than six images are refused (got ${json(many.ok ? '' : many.error)})`
            );

            const none = await resolveWith([], [0, 0], [{ message: 1, image: undefined }]);
            expect(!none.ok && none.error.endsWith('当前上下文里没有带图的消息'), 'a context without images says so');
        },
    },
    {
        name: 'one reply gets one image: a second successful call is refused',
        body: async () => {
            const model = stubImageModel();
            const tool = toolFor(NO_CONTEXT, model);
            const longPrompt = '一只戴着红色帽子的橘猫\n坐在窗台上看雪，窗外是傍晚的街道和路灯，远处有几个行人撑着伞走过';

            const first = await runTool(tool, { prompt: longPrompt, caption: '雪天的猫' });
            const image = first.images[0];
            expect(!first.isError && first.content === IMAGE_READY, `the first image is generated (got ${json(first.content)})`);
            expect(
                first.images.length === 1 && image?.data.equals(PNG_BYTES) === true && image.mimeType === 'image/png' && image.caption === '雪天的猫',
                'the result carries the image, its real mime and the caption'
            );
            const expectedLine = `generate_image: ${Array.from(longPrompt.replace(/\s+/g, ' ')).slice(0, 40).join('')}`;
            expect(
                first.record?.provider === 'mcp' && json(first.record.searchQueries) === json([expectedLine]) && json(first.record.citations) === '[]',
                `the Tools line shows the prompt's first 40 chars on one line (got ${json(first.record?.searchQueries)})`
            );

            const second = await runTool(tool, { prompt: '再画一张', caption: '' });
            expect(second.isError && second.content === ONE_IMAGE_PER_REPLY, `the second is refused (got ${json(second.content)})`);
            expect(model.requests.length === 1, 'without a second request');

            const uncaptioned = await runTool(toolFor(NO_CONTEXT, stubImageModel()), { prompt: '猫', caption: '  ' });
            expect(uncaptioned.images[0]?.caption === undefined, 'an empty caption leaves the image without one');

            // A failed attempt does not use up the reply's image
            let attempts = 0;
            const flaky = stubImageModel(() => {
                attempts += 1;
                return attempts === 1 ? Object.assign(new Error('got status: 429 Too Many Requests'), { status: 429 }) : imageAnswer(PNG_BYTES);
            });
            const flakyTool = toolFor(NO_CONTEXT, flaky);
            const busy = await runTool(flakyTool, { prompt: '猫', caption: '' });
            const retried = await runTool(flakyTool, { prompt: '猫', caption: '' });
            expect(busy.content === BUSY && !retried.isError, 'after a 429 the model may try again in the same reply');
        },
    },
    {
        name: 'the image stream is drained to its last image and failures are worded for the model',
        body: async () => {
            const { drainImageStream, generateImage, classifyGenerationError } = imageGeneration;
            async function* stream(): AsyncGenerator<StreamChunk> {
                yield { type: 'text', content: '先' };
                yield { type: 'image', imageData: JPEG_BYTES, imageMimeType: 'image/jpeg' };
                yield { type: 'thinking', content: '想一想' };
                yield { type: 'text', content: '画好了' };
                yield { type: 'image', imageData: PNG_BYTES, imageMimeType: 'image/png' };
                yield { type: 'done', rawResponse: { candidates: [{ finishReason: 'STOP' }] } };
            }
            const drained = await drainImageStream(stream());
            expect(drained.image?.data.equals(PNG_BYTES) === true && drained.image.mimeType === 'image/png', 'the last image is kept');
            expect(drained.text === '先画好了', 'visible text is collected, thinking is not');
            expect(json(drained.rawResponse) === json({ candidates: [{ finishReason: 'STOP' }] }), 'the closing raw response is kept');

            const wordingFor = async (answer: ImageModelAnswer): Promise<string> =>
                (await runTool(toolFor(NO_CONTEXT, stubImageModel(() => answer)), { prompt: '猫', caption: '' })).content;

            expect((await wordingFor(Object.assign(new Error('quota'), { status: 429 }))) === BUSY, 'HTTP 429 is busy');
            expect((await wordingFor(new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}'))) === BUSY, 'RESOURCE_EXHAUSTED is busy');

            const promptBlocked = await wordingFor(noImageAnswer({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }));
            expect(promptBlocked.includes('拦') && promptBlocked.includes('PROHIBITED_CONTENT'), `a blocked prompt (got ${json(promptBlocked)})`);

            const imageBlocked = await wordingFor(noImageAnswer({ candidates: [{ finishReason: 'IMAGE_SAFETY' }] }, '这个画不了'));
            expect(
                imageBlocked.includes('IMAGE_SAFETY') && imageBlocked.includes('这个画不了'),
                `a blocked image, with what the model said (got ${json(imageBlocked)})`
            );

            const noImage = await wordingFor(noImageAnswer({ candidates: [{ finishReason: 'NO_IMAGE' }] }));
            expect(noImage.includes('没有出图') && noImage.includes('NO_IMAGE'), `no image (got ${json(noImage)})`);

            const textOnly = await wordingFor(noImageAnswer({ candidates: [{ finishReason: 'STOP' }] }, '我更想跟你聊聊天'));
            expect(textOnly.includes('只回了文字') && textOnly.includes('我更想跟你聊聊天'), `a text-only answer quotes it (got ${json(textOnly)})`);

            const empty = await wordingFor(noImageAnswer(undefined));
            expect(empty.includes('没有出图'), `an empty answer (got ${json(empty)})`);

            const crashed = await wordingFor(new Error('socket hang up'));
            expect(crashed === '生图失败：socket hang up', `anything else is passed on (got ${json(crashed)})`);

            // The platform rethrows silently, so the tool's log line carries the cause
            const PRIVATE_PROMPT = '只给生图模型看的画面描述';
            const logLineFor = async (answer: ImageModelAnswer): Promise<string> => {
                const tool = toolFor(NO_CONTEXT, stubImageModel(() => answer));
                const { lines } = await captureConsole(() =>
                    tool.execute({ prompt: PRIVATE_PROMPT, caption: '' }, new AbortController().signal)
                );
                return lines.find((line) => line.startsWith('[generate_image]')) ?? '';
            };
            const rejectedLog = await logLineFor(new Error('got status: 400 Bad Request.\n{"error":{"message":"imageSize is not supported"}}'));
            expect(
                rejectedLog.endsWith(': error: got status: 400 Bad Request. {"error":{"message":"imageSize is not supported"}}'),
                `an upstream error is logged, on one line (got ${json(rejectedLog)})`
            );
            const blockedLog = await logLineFor(noImageAnswer({ candidates: [{ finishReason: 'IMAGE_SAFETY' }] }, '这个画不了'));
            expect(blockedLog.endsWith(': blocked (IMAGE_SAFETY)'), `a block is logged with its reason (got ${json(blockedLog)})`);
            const noImageLog = await logLineFor(noImageAnswer({ candidates: [{ finishReason: 'NO_IMAGE' }] }));
            expect(noImageLog.endsWith(': no-image (NO_IMAGE)'), `a missing image is logged with its reason (got ${json(noImageLog)})`);
            const textOnlyLog = await logLineFor(noImageAnswer({ candidates: [{ finishReason: 'STOP' }] }, '我更想跟你聊聊天'));
            expect(textOnlyLog.endsWith(': text-only'), `a text-only answer is logged by kind (got ${json(textOnlyLog)})`);
            expect(
                [rejectedLog, blockedLog, noImageLog, textOnlyLog].every(
                    (line) => !line.includes(PRIVATE_PROMPT) && !line.includes('这个画不了') && !line.includes('我更想跟你聊聊天')
                ),
                'neither the prompt nor the image model’s words reach the log'
            );

            // The deadline: a request that never answers is cut off and reported as a timeout
            const hanging = async (_messages: UnifiedMessage[], config: PlatformConfig): Promise<AsyncIterable<StreamChunk>> =>
                (async function* (): AsyncGenerator<StreamChunk> {
                    await new Promise((resolve) => config.signal?.addEventListener('abort', resolve, { once: true }));
                    throw new Error('This operation was aborted');
                })();
            const timedOut = await generateImage(
                { prompt: '猫', references: [] },
                { sendMessage: hanging, signal: new AbortController().signal, timeoutMs: 50 }
            );
            expect(!timedOut.ok && timedOut.failure.kind === 'timeout', 'the deadline aborts the request as a timeout');
            expect(
                classifyGenerationError(new Error('Timeout'), { stopped: false, timedOut: false }).kind === 'timeout' &&
                    classifyGenerationError(new Error('Aborted'), { stopped: true, timedOut: true }).kind === 'stopped',
                'the platform’s own timeout is a timeout, and a stop wins over the deadline'
            );
        },
    },
    {
        name: 'the caption is rendered like the reply text and fits Telegram’s limit',
        body: async () => {
            const styled = buildImageCaption('**一只猫** 和 _一只狗_');
            expect(
                styled.caption === '一只猫 和 一只狗' &&
                    json(styled.caption_entities) ===
                        json([
                            { type: 'bold', offset: 0, length: 3 },
                            { type: 'italic', offset: 6, length: 3 },
                        ]),
                `markdown becomes entities (got ${json(styled)})`
            );
            expect(json(buildImageCaption('')) === '{}' && json(buildImageCaption('  \n ')) === '{}' && json(buildImageCaption(undefined)) === '{}', 'no caption, no fields');
            expect(json(buildImageCaption('就一句话')) === json({ caption: '就一句话' }), 'plain text carries no entity list');

            const linked = buildImageCaption('照着 #2 改的', (contextNumber) =>
                contextNumber === 2 ? 'https://t.me/c/123/456' : undefined
            );
            expect(
                linked.caption_entities?.some((entity) => entity.type === 'text_link' && entity.url === 'https://t.me/c/123/456') === true,
                '#N becomes a link like in the reply text'
            );

            const long = buildImageCaption(`**${'很长的配文'.repeat(400)}**`);
            const longText = long.caption ?? '';
            expect(
                longText.length <= IMAGE_CAPTION_MAX_LENGTH && longText.length > 900 && longText.endsWith('…'),
                `a long caption is cut to fit and marked (got ${longText.length} chars)`
            );
            expect(
                (long.caption_entities ?? []).every((entity) => entity.offset + entity.length <= longText.length) &&
                    long.caption_entities?.[0]?.type === 'bold',
                'its entities stay inside the cut text'
            );

            const manyStyles = buildImageCaption(Array.from({ length: 150 }, (_, index) => `**${index}**`).join(' '));
            expect((manyStyles.caption_entities ?? []).length <= 90 && (manyStyles.caption ?? '').endsWith('…'), 'the entity budget is kept too');
        },
    },
    {
        name: 'the image goes out with its caption and real file name, and both are stored',
        body: async () => {
            const captioned = await deliver(-1003900000001, reply({ text: '画好了', images: [JPEG_BYTES], imageCaption: '**一只猫**' }));
            const [photo] = callsOf(captioned.telegram, 'sendPhoto');
            expect(
                photo?.payload.caption === '一只猫' &&
                    json(photo.payload.caption_entities) === json([{ type: 'bold', offset: 0, length: 3 }]),
                `the photo carries the rendered caption (got ${json({ caption: photo?.payload.caption, entities: photo?.payload.caption_entities })})`
            );
            expect(fileNameOf(photo?.payload.photo) === 'image.jpg', `named after its real format (got ${json(fileNameOf(photo?.payload.photo))})`);
            expect(captioned.version?.imageCaption === '**一只猫**', 'the version keeps the caption');
            expect(
                captioned.row?.text === '画好了\n\n**一只猫**' && captioned.row.fileMime === 'image/jpeg' && captioned.row.file?.equals(JPEG_BYTES) === true,
                `the context row reads the text, then the caption, with the image (got ${json(captioned.row?.text)})`
            );

            const fallback = await deliver(-1003900000002, reply({ text: '画好了', images: [WEBP_BYTES], imageCaption: '配文' }), ['sendPhoto']);
            const [document] = callsOf(fallback.telegram, 'sendDocument');
            expect(
                document?.payload.caption === '配文' && fileNameOf(document.payload.document) === 'image.webp',
                `the document fallback carries the caption too (got ${json(document?.payload.caption)})`
            );
            expect(fallback.chatContext.session.messageIds.includes(fallback.telegram.sentIds('sendDocument')[0] ?? -1), 'and is recorded');

            const longText = Array.from({ length: 700 }, (_, index) => `第 ${index} 段：一段足够长的测试文字。`).join('\n\n');
            const split = await deliver(-1003900000003, reply({ text: longText, images: [PNG_BYTES], imageCaption: '长文配图' }));
            const [splitPhoto] = callsOf(split.telegram, 'sendPhoto');
            expect(
                split.telegram.sentIds('sendMessage').length > 1 && splitPhoto?.payload.caption === '长文配图' && fileNameOf(splitPhoto.payload.photo) === 'image.png',
                'the split-message path sends the caption as well'
            );

            const imageOnly = await deliver(-1003900000004, reply({ images: [PNG_BYTES], imageCaption: '只有图' }));
            expect(
                callsOf(imageOnly.telegram, 'sendPhoto')[0]?.payload.caption === '只有图' && imageOnly.row?.text === '只有图',
                `an image-only reply stores its caption as the text (got ${json(imageOnly.row?.text)})`
            );

            const plain = await deliver(-1003900000005, reply({ text: '画好了', images: [PNG_BYTES] }));
            const [plainPhoto] = callsOf(plain.telegram, 'sendPhoto');
            expect(
                plainPhoto !== undefined && !('caption' in plainPhoto.payload) && plain.version?.imageCaption === undefined && plain.row?.text === '画好了',
                'without a caption nothing changes'
            );
        },
    },
    {
        name: 'B5: the bot row is overwritten whole on finalize and on version switching',
        body: async () => {
            // Finalize over a row an earlier version left behind (as a retry finds it)
            const chatId = -1003900000011;
            const { chatContext } = await startChat(chatId);
            const firstId = chatContext.session.firstMessageId;
            await seedRow({
                chatId,
                messageId: firstId,
                fromBotSelf: true,
                userId: 7777,
                text: '旧版本的话',
                file: PNG_BYTES,
                fileMime: 'image/png',
                modelParts: [{ text: '', thoughtSignature: 'stale' }],
            });
            const textOnly = reply({ text: '新版本只有文字' });
            syncSession(chatContext, textOnly);
            await captureConsole(() => responseHandler.sendFinalResponse(chatContext, textOnly));
            const finalized = await rowOf(chatId, firstId);
            expect(
                finalized?.text === '新版本只有文字' && finalized.file === null && finalized.fileMime === null && finalized.modelParts === null,
                `no stale image, mime or parts survive finalize (got ${json({ text: finalized?.text, file: finalized?.file?.length, parts: finalized?.modelParts })})`
            );
            const duplicates = await Message.count({ where: { chatId, messageId: firstId } });
            expect(duplicates === 1, 'the row is updated, not duplicated');

            // Switching between a captioned image version and a text-only one
            const switchChatId = -1003900000012;
            const telegram = createFakeTelegram(switchChatId);
            const userMessageId = takeMessageId();
            const replyId = takeMessageId();
            const photoId = takeMessageId();
            await seedResponse({
                chatId: switchChatId,
                firstMessageId: replyId,
                userMessageId,
                currentVersionIndex: 0,
                versions: [
                    {
                        text: '第一版',
                        messageIds: [replyId, photoId],
                        currentMessageId: photoId,
                        imageBase64: PNG_BYTES.toString('base64'),
                        imageCaption: '**配文**',
                        modelParts: [{ text: '', thoughtSignature: 'v1' }],
                    },
                    { text: '第二版' },
                ],
            });
            await seedRow({ chatId: switchChatId, messageId: replyId, fromBotSelf: true, userId: 7777, text: '第一版\n\n**配文**', file: PNG_BYTES, fileMime: 'image/png', modelParts: [{ text: '', thoughtSignature: 'v1' }] });
            const ctx = contextIn(telegram, switchChatId, takeMessageId());

            const { result: toTextOnly } = await captureConsole(() => switchVersion(ctx, replyId, 'next'));
            const textOnlyRow = await rowOf(switchChatId, replyId);
            expect(toTextOnly, 'switched to the text-only version');
            expect(
                textOnlyRow?.text === '第二版' && textOnlyRow.file === null && textOnlyRow.fileMime === null && textOnlyRow.modelParts === null,
                `the text-only version leaves no image, caption or parts behind (got ${json({ text: textOnlyRow?.text, file: textOnlyRow?.file?.length })})`
            );

            const { result: backToImage } = await captureConsole(() => switchVersion(ctx, replyId, 'prev'));
            const [resent] = callsOf(telegram, 'sendPhoto');
            const imageRow = await rowOf(switchChatId, replyId);
            expect(backToImage && resent?.payload.caption === '配文', `the re-sent image keeps its caption (got ${json(resent?.payload.caption)})`);
            expect(
                json(resent?.payload.caption_entities) === json([{ type: 'bold', offset: 0, length: 2 }]) && fileNameOf(resent?.payload.photo) === 'image.png',
                'rendered, under its real file name'
            );
            expect(
                imageRow?.text === '第一版\n\n**配文**' && imageRow.file?.equals(PNG_BYTES) === true && imageRow.fileMime === 'image/png',
                'and the row has the image version back, caption included'
            );

            // saveMessage keeps merging for everyone else (autoSave, /pic)
            const userRow = await seedRow({ text: '原文', file: JPEG_BYTES, fileMime: 'image/jpeg' });
            await db.saveMessage({ chatId: OFFLINE_CHAT_ID, messageId: userRow, userId: 1001, date: new Date(), message: '改过的字' });
            const merged = await rowOf(OFFLINE_CHAT_ID, userRow);
            expect(merged?.text === '改过的字' && merged.file?.equals(JPEG_BYTES) === true, 'saveMessage still keeps what it is not given');
        },
    },
    {
        name: 'B6: the continuation lookup prefilters in SQL and still finds every message id',
        body: async () => {
            const chatId = -1003900000021;
            const userMessageId = takeMessageId();
            // Rows come back in id order, so a chat-wide scan parses all seven before it reaches the reply
            const unrelatedIds = Array.from({ length: 5 }, () => takeMessageId());
            const decoy = takeMessageId();
            const first = takeMessageId();
            const continuation = takeMessageId();
            const photo = takeMessageId();
            for (const unrelated of unrelatedIds) {
                await seedResponse({ chatId, firstMessageId: unrelated, userMessageId, versions: [{ text: '无关的回复' }] });
            }
            // Its text mentions the id, so the prefilter lets it through; the parsed versions do not
            await seedResponse({ chatId, firstMessageId: decoy, userMessageId, versions: [{ text: `提到了 ${continuation} 这个数字` }] });
            await seedResponse({
                chatId,
                firstMessageId: first,
                userMessageId,
                versions: [{ text: '很长的回复', messageIds: [first, continuation, photo], currentMessageId: photo }],
            });

            const { findBotResponseByMessageId, BotResponse } = dbIndex;
            /** One lookup, counting the stored responses it had to parse */
            const lookUpCountingParses = async (messageId: number) => {
                const originalGetVersions = BotResponse.prototype.getVersions;
                let parsed = 0;
                BotResponse.prototype.getVersions = function getVersionsCounted(this: InstanceType<typeof BotResponse>) {
                    parsed += 1;
                    return originalGetVersions.call(this);
                };
                try {
                    return { found: await findBotResponseByMessageId(chatId, messageId), parsed };
                } finally {
                    BotResponse.prototype.getVersions = originalGetVersions;
                }
            };

            const continued = await lookUpCountingParses(continuation);
            expect(continued.found?.messageId === first, 'a continuation id finds its reply, not the decoy');
            expect(continued.parsed === 2, `only the decoy and the reply pass the prefilter (parsed ${continued.parsed} of 7)`);

            // The common case: someone replies to a message that is no bot reply at all
            const unknown = await lookUpCountingParses(takeMessageId());
            expect(unknown.found === null && unknown.parsed === 0, `an id no reply mentions parses nothing (parsed ${unknown.parsed} of 7)`);

            expect((await findBotResponseByMessageId(chatId, photo))?.messageId === first, 'the image message id is found too');
            expect((await findBotResponseByMessageId(chatId, first))?.messageId === first, 'the first id still takes the direct lookup');
            const digitsOfLongerId = Number(String(photo).slice(0, -1));
            expect((await findBotResponseByMessageId(chatId, digitsOfLongerId)) === null, 'digits inside a longer id are no match');
            expect((await findBotResponseByMessageId(-1003900000022, continuation)) === null, 'another chat never matches');
        },
    },
    {
        name: 'B7: an error after an image was generated stores no image',
        body: async () => {
            const chatId = -1003900000031;
            const { telegram, chatContext } = await startChat(chatId);
            const firstId = chatContext.session.firstMessageId;
            // The stream had produced text and an image before it failed
            chatContext.session.textBuffer = '画到一半';
            chatContext.session.images = [PNG_BYTES];
            chatContext.currentState = {
                ...emptyState(),
                textBuffer: '画到一半',
                fullText: '画到一半',
                images: [PNG_BYTES],
                imageCaption: '配文',
            };

            await captureConsole(() => responseHandler.handleResponseError(chatContext, new Error('upstream exploded')));
            const stored = await dbIndex.getBotResponse(chatId, firstId);
            const version = stored?.getVersions().at(-1);
            const row = await rowOf(chatId, firstId);
            expect(
                version?.errorMessage === 'upstream exploded' && version.imageBase64 === undefined && version.imageCaption === undefined,
                'the errored version keeps no image'
            );
            expect(stored?.getMetadata().hasImage === false, 'the reply is not marked as having one');
            expect(row?.text === '画到一半' && row.file === null, 'nor does the context row');
            expect(
                callsOf(telegram, 'sendPhoto').length === 0 && callsOf(telegram, 'sendDocument').length === 0,
                'and nothing was sent as an image'
            );

            // A stop is not an error: what was produced is delivered and kept
            const stoppedChatId = -1003900000032;
            const stopped = await startChat(stoppedChatId);
            stopped.chatContext.session.images = [PNG_BYTES];
            stopped.chatContext.currentState = { ...emptyState(), textBuffer: '画好了', fullText: '画好了', images: [PNG_BYTES], imageCaption: '配文' };
            await captureConsole(() => responseHandler.handleResponseError(stopped.chatContext, new Error('Aborted')));
            const stoppedVersion = (await dbIndex.getBotResponse(stoppedChatId, stopped.chatContext.session.firstMessageId))?.getVersions().at(-1);
            expect(
                callsOf(stopped.telegram, 'sendPhoto')[0]?.payload.caption === '配文' && stoppedVersion?.imageBase64 !== undefined,
                'a stopped reply still delivers and stores its image'
            );
        },
    },
    {
        name: 'B7: an image Telegram takes neither as a photo nor as a document is not stored',
        body: async () => {
            const bothRefused = ['sendPhoto', 'sendDocument'];

            const withText = await deliver(
                -1003900000041,
                reply({ text: '画好了', images: [PNG_BYTES], imageCaption: '配文' }),
                bothRefused
            );
            const textMessageId = withText.chatContext.session.firstMessageId;
            const withTextResponse = await dbIndex.getBotResponse(-1003900000041, textMessageId);
            expect(
                callsOf(withText.telegram, 'sendPhoto').length === 1 && callsOf(withText.telegram, 'sendDocument').length === 1,
                'the photo and the document were both tried'
            );
            expect(
                withText.version !== undefined &&
                    withText.version.imageBase64 === undefined &&
                    withText.version.imageCaption === undefined &&
                    withTextResponse?.getMetadata().hasImage === false,
                'the version keeps neither the image nor its caption'
            );
            expect(
                withText.row?.text === '画好了' && withText.row.file === null && withText.row.fileMime === null,
                `nor does the context row (got ${json(withText.row?.text)})`
            );
            expect(
                json(withText.version?.messageIds) === json([textMessageId]) &&
                    withText.version?.currentMessageId === textMessageId,
                'the reply ends on its text message, the one a refresh will restore'
            );

            const imageOnly = await deliver(-1003900000042, reply({ images: [PNG_BYTES], imageCaption: '只有图' }), bothRefused);
            const processingId = imageOnly.chatContext.session.firstMessageId;
            expect(callsOf(imageOnly.telegram, 'deleteMessage').length === 0, 'without text the processing message is kept');
            expect(
                callsOf(imageOnly.telegram, 'editMessageText').some(
                    (telegramCall) =>
                        telegramCall.payload.message_id === processingId && telegramCall.payload.text === '[image failed to send]'
                ),
                'and says the image did not go out'
            );
            expect(
                imageOnly.version !== undefined &&
                    imageOnly.version.imageBase64 === undefined &&
                    json(imageOnly.version.messageIds) === json([processingId]) &&
                    imageOnly.row?.text === '[Empty response]' &&
                    imageOnly.row.file === null,
                `nothing of the image is stored (got ${json({ ids: imageOnly.version?.messageIds, text: imageOnly.row?.text })})`
            );

            const longText = Array.from({ length: 700 }, (_, index) => `第 ${index} 段：一段足够长的测试文字。`).join('\n\n');
            const split = await deliver(-1003900000043, reply({ text: longText, images: [PNG_BYTES] }), bothRefused);
            expect(
                split.version !== undefined &&
                    split.version.imageBase64 === undefined &&
                    split.version.currentMessageId === split.telegram.sentIds('sendMessage').at(-1) &&
                    split.row?.file === null,
                'the split path stores no image either and ends on its last text message'
            );

            // Delivered, an image-only reply still takes the processing message's place
            const delivered = await deliver(-1003900000044, reply({ images: [PNG_BYTES] }));
            const deliveredMethods = delivered.telegram.calls.map((telegramCall) => telegramCall.method);
            const [photoId] = delivered.telegram.sentIds('sendPhoto');
            expect(
                deliveredMethods.indexOf('sendPhoto') < deliveredMethods.indexOf('deleteMessage') &&
                    json(delivered.version?.messageIds) === json([photoId]) &&
                    delivered.version?.imageBase64 !== undefined,
                `the processing message goes once the photo is out (got ${json(deliveredMethods)})`
            );
        },
    },
    {
        name: 'a caption Telegram refuses for its entities goes out as plain text, the image is kept',
        body: async () => {
            const refusedEntities = await deliver(
                -1003900000051,
                reply({ text: '画好了', images: [PNG_BYTES], imageCaption: '**一只猫**' }),
                [],
                ['sendPhoto', 'sendDocument']
            );
            const photos = callsOf(refusedEntities.telegram, 'sendPhoto');
            expect(
                photos.length === 2 &&
                    callsOf(refusedEntities.telegram, 'sendDocument').length === 1 &&
                    photos[1]?.payload.caption === '一只猫' &&
                    !('caption_entities' in (photos[1]?.payload ?? {})),
                `photo and document with entities, then the photo with a plain caption (got ${json(refusedEntities.telegram.calls.map((telegramCall) => telegramCall.method))})`
            );
            expect(
                refusedEntities.version?.imageBase64 !== undefined &&
                    refusedEntities.version.imageCaption === '**一只猫**' &&
                    refusedEntities.version.currentMessageId === refusedEntities.telegram.sentIds('sendPhoto')[0],
                'the image and its caption are stored as sent'
            );

            const imageRefused = await deliver(
                -1003900000052,
                reply({ text: '画好了', images: [PNG_BYTES], imageCaption: '**一只猫**' }),
                ['sendPhoto', 'sendDocument']
            );
            expect(
                callsOf(imageRefused.telegram, 'sendPhoto').length === 2 &&
                    callsOf(imageRefused.telegram, 'sendDocument').length === 2 &&
                    imageRefused.version?.imageBase64 === undefined,
                'a refusal of the image itself gets one plain-caption round, then gives up'
            );
            const plainRefused = await deliver(
                -1003900000053,
                reply({ text: '画好了', images: [PNG_BYTES], imageCaption: '配文' }),
                ['sendPhoto', 'sendDocument']
            );
            expect(
                callsOf(plainRefused.telegram, 'sendPhoto').length === 1 && callsOf(plainRefused.telegram, 'sendDocument').length === 1,
                'a caption without entities is not tried again'
            );

            // Version switching re-sends the image the same way
            const switchChatId = -1003900000054;
            const telegram = createFakeTelegram(switchChatId);
            telegram.entityRefusingMethods.add('sendPhoto');
            const userMessageId = takeMessageId();
            const replyId = takeMessageId();
            await seedResponse({
                chatId: switchChatId,
                firstMessageId: replyId,
                userMessageId,
                currentVersionIndex: 1,
                versions: [
                    { text: '第一版', imageBase64: PNG_BYTES.toString('base64'), imageCaption: '**配文**' },
                    { text: '第二版' },
                ],
            });
            const { result: switched } = await captureConsole(() =>
                switchVersion(contextIn(telegram, switchChatId, takeMessageId()), replyId, 'prev')
            );
            const resent = callsOf(telegram, 'sendPhoto');
            expect(
                switched && resent.length === 2 && resent[1]?.payload.caption === '配文' && !('caption_entities' in (resent[1]?.payload ?? {})),
                `the re-sent image falls back to the plain caption (got ${json(resent.map((telegramCall) => telegramCall.payload.caption))})`
            );
        },
    },
    {
        name: 'a reply that shows records above its image is no image-only reply to retry or switch from',
        body: async () => {
            const toolsOnly: Partial<ResponseVersion> = {
                text: '',
                agentStats: { toolUsage: [{ name: 'generate_image', count: 1 }] },
                imageBase64: PNG_BYTES.toString('base64'),
                imageCaption: '配文',
            };

            // Retry keeps the text message the records are in
            const retryChatId = -1003900000061;
            const retryTelegram = createFakeTelegram(retryChatId);
            const retryUser = takeMessageId();
            const retryFirst = takeMessageId();
            const retryPhoto = takeMessageId();
            await seedResponse({
                chatId: retryChatId,
                firstMessageId: retryFirst,
                userMessageId: retryUser,
                versions: [{ ...toolsOnly, messageIds: [retryFirst, retryPhoto], currentMessageId: retryPhoto }],
            });
            const { result: retried } = await captureConsole(() =>
                startRetry(contextIn(retryTelegram, retryChatId, takeMessageId()), retryFirst)
            );
            const deleted = callsOf(retryTelegram, 'deleteMessage').map((telegramCall) => telegramCall.payload.message_id);
            expect(
                json(deleted) === json([retryPhoto]) && json(retried?.messageIds) === json([retryFirst]),
                `only the photo goes, the records message is edited for the retry (got deleted=${json(deleted)}, ids=${json(retried?.messageIds)})`
            );
            expect(callsOf(retryTelegram, 'sendMessage').length === 0, 'no new processing message is sent');
            retried?.streamController.abort();

            // A true image-only version still starts over in a new message
            const imageOnlyChatId = -1003900000062;
            const imageOnlyTelegram = createFakeTelegram(imageOnlyChatId);
            const imageOnlyUser = takeMessageId();
            const imageOnlyPhoto = takeMessageId();
            await seedResponse({
                chatId: imageOnlyChatId,
                firstMessageId: imageOnlyPhoto,
                userMessageId: imageOnlyUser,
                versions: [{ text: '', imageBase64: PNG_BYTES.toString('base64') }],
            });
            const { result: restarted } = await captureConsole(() =>
                startRetry(contextIn(imageOnlyTelegram, imageOnlyChatId, takeMessageId()), imageOnlyPhoto)
            );
            expect(
                json(callsOf(imageOnlyTelegram, 'deleteMessage').map((telegramCall) => telegramCall.payload.message_id)) ===
                    json([imageOnlyPhoto]) &&
                    callsOf(imageOnlyTelegram, 'sendMessage').length === 1 &&
                    restarted?.firstMessageId === imageOnlyPhoto,
                'an image-only version is replaced by a new processing message, keyed as before'
            );
            restarted?.streamController.abort();

            // Switching away edits the records message in place
            const switchChatId = -1003900000063;
            const switchTelegram = createFakeTelegram(switchChatId);
            const switchUser = takeMessageId();
            const switchFirst = takeMessageId();
            const switchPhoto = takeMessageId();
            await seedResponse({
                chatId: switchChatId,
                firstMessageId: switchFirst,
                userMessageId: switchUser,
                currentVersionIndex: 0,
                versions: [
                    { ...toolsOnly, messageIds: [switchFirst, switchPhoto], currentMessageId: switchPhoto },
                    { text: '第二版' },
                ],
            });
            const { result: switched } = await captureConsole(() =>
                switchVersion(contextIn(switchTelegram, switchChatId, takeMessageId()), switchFirst, 'next')
            );
            const switchDeleted = callsOf(switchTelegram, 'deleteMessage').map((telegramCall) => telegramCall.payload.message_id);
            expect(
                switched &&
                    json(switchDeleted) === json([switchPhoto]) &&
                    callsOf(switchTelegram, 'sendMessage').length === 0 &&
                    callsOf(switchTelegram, 'editMessageText').some(
                        (telegramCall) => telegramCall.payload.message_id === switchFirst && telegramCall.payload.text === '第二版'
                    ),
                `the photo goes and the first message turns into the new version (got deleted=${json(switchDeleted)})`
            );
        },
    },
    {
        name: 'image bytes are told apart by their signatures',
        body: async () => {
            const { sniffImageMime, imageFileName } = imageGeneration;
            expect(
                sniffImageMime(PNG_BYTES) === 'image/png' &&
                    sniffImageMime(JPEG_BYTES) === 'image/jpeg' &&
                    sniffImageMime(WEBP_BYTES) === 'image/webp' &&
                    sniffImageMime(GIF_BYTES) === null &&
                    sniffImageMime(Buffer.alloc(0)) === null,
                'png, jpeg and webp are recognised, anything else is not'
            );
            expect(
                imageFileName(JPEG_BYTES) === 'image.jpg' && imageFileName(WEBP_BYTES) === 'image.webp' && imageFileName(GIF_BYTES) === 'image.png',
                'upload names follow the bytes, unknown keeps image.png'
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
