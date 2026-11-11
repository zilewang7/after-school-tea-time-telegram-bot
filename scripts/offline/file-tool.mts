/**
 * Offline cases for send_file — the model writing a text file into the chat
 * (no containers, no network).
 *
 * Run: npx tsx scripts/offline/file-tool.mts
 *
 * Covers the pure argument rules (name sanitizing, extension → MIME, the size
 * cap, append), the one-attachment guard shared with the picture tools, and
 * the whole reply lifecycle against a fake Telegram: the document goes out
 * after the text, carries its caption, is stored in the version, comes back on
 * a version switch, and stays readable in the next context as text.
 *
 * Telegram is a real grammY Api whose transformer answers every call locally,
 * so the reply pipeline runs unmodified.
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
import type { AIResponse, FileDelivery } from '../../src/ai/types.js';
import type { ToolHandler, ToolResult } from '../../src/ai/tools/tool-types.js';
import type { ResponseVersion } from '../../src/db/botResponseDTO.js';

// The bot's own rows are stored as messages of this user
process.env.BOT_USER_ID = '7777';

const db = await setupOfflineDb();
const { Message } = db;

const responseHandler = await import('../../src/reply/response-handler.js');
const { createSendFileTool } = await import('../../src/reply/tools/send-file-tool.js');
const { createSendImageTool } = await import('../../src/reply/tools/send-image-tool.js');
const { createSendStickerTool } = await import('../../src/reply/tools/send-sticker-tool.js');
const { createReplyMediaState, ONE_ATTACHMENT_PER_REPLY } = await import(
    '../../src/reply/tools/reply-media-state.js'
);
const { FILE_MAX_BYTES, formatBytes, mimeForFileName, sanitizeFileName } = await import(
    '../../src/reply/tools/file-tool-args.js'
);
const { switchVersion, startRetry } = await import('../../src/services/bot-message-service.js');
const { buildContext } = await import('../../src/reply/context-builder.js');
const dbIndex = await import('../../src/db/index.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

const reply = (fields: Partial<AIResponse>): AIResponse => ({
    text: '',
    thinkingText: '',
    images: [],
    groundingData: [],
    ...fields,
});

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

// ---- fake Telegram: a real grammY Api whose transformer answers locally ----

interface TelegramCall {
    readonly method: string;
    readonly payload: Readonly<Record<string, unknown>>;
}

interface FakeTelegram {
    readonly api: Api;
    readonly calls: TelegramCall[];
    /** Methods answered with a 400, e.g. sendDocument to force the failure path */
    readonly failingMethods: Set<string>;
    /** Methods answered with a 400 whenever the call carries caption entities */
    readonly entityRefusingMethods: Set<string>;
    readonly sentIds: (method: string) => number[];
}

const SENDING_METHODS: ReadonlySet<string> = new Set(['sendMessage', 'sendDocument', 'sendPhoto']);
let nextFakeMessageId = 290_000;

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
                text: '帮我写成文件',
            },
        },
        telegram.api,
        BOT_ME
    );

const startChat = async (chatId: number) => {
    const telegram = createFakeTelegram(chatId);
    const ctx = contextIn(telegram, chatId, takeMessageId());
    const { result: chatContext } = await captureConsole(() => responseHandler.createChatContext(ctx, { model: 'offline-model' }));
    if (!chatContext) throw new Error('the chat context was not created');
    return { telegram, chatContext };
};

const callsOf = (telegram: FakeTelegram, method: string): TelegramCall[] =>
    telegram.calls.filter((call) => call.method === method);

const fileNameOf = (upload: unknown): unknown => asRecord(upload).filename;

const deliver = async (
    response: AIResponse,
    options: { chatId?: number; failing?: string[]; entityRefusing?: string[] } = {}
) => {
    const chatId = options.chatId ?? OFFLINE_CHAT_ID;
    const { telegram, chatContext } = await startChat(chatId);
    options.failing?.forEach((method) => telegram.failingMethods.add(method));
    options.entityRefusing?.forEach((method) => telegram.entityRefusingMethods.add(method));
    const firstId = chatContext.session.firstMessageId;
    chatContext.session.textBuffer = response.text;
    chatContext.session.images = response.images;
    await captureConsole(() => responseHandler.sendFinalResponse(chatContext, response));
    const stored = await dbIndex.getBotResponse(chatId, firstId);
    return {
        telegram,
        chatContext,
        firstId,
        version: stored?.getVersions().at(-1),
        metadata: stored?.getMetadata(),
        row: await rowOf(chatId, firstId),
    };
};

const textOf = (call: TelegramCall | undefined): string =>
    typeof call?.payload.text === 'string' ? call.payload.text : '';

/** A file as the tool hands it to the delivery layer */
const fileOf = (content: string, name = 'SKILL.md', caption?: string): FileDelivery => ({
    name,
    mimeType: mimeForFileName(name),
    data: Buffer.from(content, 'utf8'),
    ...(caption ? { caption } : {}),
});

const runTool = async (tool: ToolHandler, args: Record<string, unknown>): Promise<ToolResult> =>
    (await captureConsole(() => tool.execute(args, new AbortController().signal))).result;

const stickerRefusedOf = async (tool: ToolHandler): Promise<ToolResult> => runTool(tool, { sticker: '07' });

const noopContext = { chatId: OFFLINE_CHAT_ID, contextIndex: new Map(), signal: new AbortController().signal };

const VISION = {
    supportsImageInput: true,
    supportsImageOutput: false,
    supportsSystemPrompt: true,
    requiresMessageMerge: false,
    supportsThinking: true,
    supportsGrounding: true,
    supportsMediaInput: false,
};

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const cases: Array<{ name: string; body: () => Promise<void> }> = [
    {
        name: 'file names are sanitized and the extension picks the MIME',
        body: async () => {
            const ok = sanitizeFileName('  SKILL.md ');
            expect(ok.ok && ok.name === 'SKILL.md', `a plain name is kept (got ${json(ok)})`);

            const path = sanitizeFileName('../etc/passwd');
            expect(!path.ok && path.error.includes('路径分隔符'), `a path is refused, not guessed (got ${json(path)})`);

            const illegal = sanitizeFileName('a<b>c:d|e?.md');
            expect(illegal.ok && illegal.name === 'a_b_c_d_e_.md', `illegal characters become _ (got ${json(illegal)})`);

            const empty = sanitizeFileName(' ... ');
            expect(empty.ok && empty.name === 'file.txt', `an empty name falls back to file.txt (got ${json(empty)})`);

            const long = sanitizeFileName(`${'x'.repeat(200)}.md`);
            expect(long.ok && long.name.length === 80 && long.name.endsWith('.md'), `a long name keeps its extension (got ${json(long)})`);

            expect(
                mimeForFileName('SKILL.md') === 'text/markdown' &&
                    mimeForFileName('data.json') === 'application/json' &&
                    mimeForFileName('table.csv') === 'text/csv' &&
                    mimeForFileName('main.ts') === 'text/plain' &&
                    mimeForFileName('noext') === 'text/plain',
                'the extension table covers the document types and defaults to text/plain'
            );
            expect(
                formatBytes(512) === '512 B' && formatBytes(12_698) === '12.4 KB' && formatBytes(2 * 1024 * 1024) === '2.00 MB',
                `sizes read as B / KB / MB (got ${json([formatBytes(512), formatBytes(12_698), formatBytes(FILE_MAX_BYTES)])})`
            );
        },
    },
    {
        name: 'one file is written in appended pieces and refuses a second name',
        body: async () => {
            const state = createReplyMediaState();
            const tool = createSendFileTool({ state });

            const first = await runTool(tool, {
                file_name: 'SKILL.md',
                content: '# Skill\n',
                caption: '看这个',
            });
            expect(
                !first.isError &&
                    first.files?.[0]?.data.toString('utf8') === '# Skill\n' &&
                    first.content.includes('文件《SKILL.md》已写好') &&
                    state.hasReplyFile,
                `the first piece creates the file (got ${json(first.content)})`
            );

            const second = await runTool(tool, {
                file_name: 'SKILL.md',
                content: '正文\n',
                append: true,
            });
            expect(
                !second.isError &&
                    second.content.includes('已追加') &&
                    second.files?.[0]?.data.toString('utf8') === '# Skill\n正文\n' &&
                    second.files?.[0]?.caption === '看这个',
                `append adds to the same file and keeps the caption (got ${json(second.content)})`
            );

            const another = await runTool(tool, { file_name: 'other.md', content: 'x' });
            expect(
                another.isError && another.content.includes('只能发一个文件'),
                `a second file is refused (got ${json(another.content)})`
            );

            const mismatched = await runTool(tool, {
                file_name: 'other.md',
                content: 'x',
                append: true,
            });
            expect(
                mismatched.isError && mismatched.content.includes('file_name 要与第一次一致'),
                `appending to a different name is refused (got ${json(mismatched.content)})`
            );

            const empty = await runTool(tool, { file_name: 'a.md', content: '   ' });
            expect(empty.isError && empty.content.includes('content 为空'), `empty content is refused (got ${json(empty.content)})`);

            expect(
                state.fileDraft?.parts.length === 2 && state.fileDraft?.name === 'SKILL.md',
                'a refused call leaves the written file untouched'
            );
        },
    },
    {
        name: 'the size cap refuses the call instead of truncating the file',
        body: async () => {
            const state = createReplyMediaState();
            const tool = createSendFileTool({ state, maxBytes: 10 });

            const tooBig = await runTool(tool, { file_name: 'a.txt', content: '12345678901' });
            expect(
                tooBig.isError && tooBig.content.includes('上限') && state.fileDraft === undefined,
                `a single oversized piece is refused (got ${json(tooBig.content)})`
            );

            const fits = await runTool(tool, { file_name: 'a.txt', content: '12345' });
            expect(!fits.isError, 'a piece inside the cap is written');

            const over = await runTool(tool, { file_name: 'a.txt', content: '678901', append: true });
            expect(
                over.isError && state.fileDraft?.parts.join('') === '12345',
                `an append past the cap leaves the file unchanged (got ${json(over.content)})`
            );
        },
    },
    {
        name: 'a file and a picture cannot share one reply',
        body: async () => {
            const withImage = createReplyMediaState();
            withImage.hasReplyImage = true;
            const fileTool = createSendFileTool({ state: withImage });
            const refused = await runTool(fileTool, { file_name: 'a.md', content: 'x' });
            expect(
                refused.isError && refused.content === ONE_ATTACHMENT_PER_REPLY,
                `send_file is refused once an image exists (got ${json(refused.content)})`
            );

            const withSticker = createReplyMediaState();
            withSticker.fileDraft = { name: 'a.md', mimeType: 'text/markdown', parts: ['x'] };
            withSticker.hasReplyFile = true;

            const imageTool = createSendImageTool({
                state: withSticker,
                context: noopContext,
            });
            const imageRefused = await runTool(imageTool, { url: 'https://example.com/a.png' });
            expect(
                imageRefused.isError && imageRefused.content === ONE_ATTACHMENT_PER_REPLY,
                `send_image is refused once a file exists (got ${json(imageRefused.content)})`
            );

            const stickerTool = createSendStickerTool({
                state: withSticker,
                context: {
                    api: { getStickerSet: async () => ({ stickers: [] }), getFile: async () => ({}) },
                    signal: new AbortController().signal,
                },
                setName: 'ColorfulHachimi',
            });
            const stickerRefused = await stickerRefusedOf(stickerTool);
            expect(
                stickerRefused.isError && stickerRefused.content === ONE_ATTACHMENT_PER_REPLY,
                `send_sticker is refused once a file exists (got ${json(stickerRefused.content)})`
            );
        },
    },
    {
        name: 'the file goes out after the text and is stored in the version and the row',
        body: async () => {
            const file = fileOf('# Skill\n正文\n', 'SKILL.md', '**说明**：拿去用');
            const delivered = await deliver(reply({ text: '写好了', files: [file] }));
            const documentCall = callsOf(delivered.telegram, 'sendDocument')[0];

            expect(
                documentCall !== undefined &&
                    fileNameOf(documentCall.payload.document) === 'SKILL.md' &&
                    documentCall.payload.disable_content_type_detection === true,
                `a document went out with its own name (got ${json(documentCall?.payload.document && fileNameOf(documentCall.payload.document))})`
            );
            expect(
                documentCall?.payload.caption === '说明：拿去用' &&
                    Array.isArray(documentCall?.payload.caption_entities) &&
                    documentCall.payload.caption_entities.length === 1,
                'the caption is rendered with its entities'
            );
            expect(
                textOf(callsOf(delivered.telegram, 'editMessageText').at(-1)) === '写好了',
                'the text message was edited before the file was sent'
            );

            const version = delivered.version;
            expect(
                version?.file?.name === 'SKILL.md' &&
                    version.file.mimeType === 'text/markdown' &&
                    version.file.sizeBytes === Buffer.byteLength('# Skill\n正文\n') &&
                    version.file.caption === '**说明**：拿去用',
                `the version stores the file metadata (got ${json(version?.file)})`
            );
            expect(
                version?.fileBase64 !== undefined &&
                    Buffer.from(version.fileBase64, 'base64').toString('utf8') === '# Skill\n正文\n' &&
                    version.imageBase64 === undefined,
                'the version keeps the bytes in fileBase64, not in imageBase64'
            );
            expect(delivered.metadata?.hasFile === true, 'the response metadata says it has a file');

            const row = delivered.row;
            expect(
                row?.mediaHint === 'a file: SKILL.md, text/markdown' &&
                    row.file === null &&
                    row.fileMime === null &&
                    row.text?.includes('写好了'),
                `the row keeps the hint, not the bytes (got ${json({ hint: row?.mediaHint, file: row?.file === null ? null : 'bytes' })})`
            );
        },
    },
    {
        name: 'a file-only reply replaces the processing message',
        body: async () => {
            const delivered = await deliver(reply({ files: [fileOf('only', 'notes.txt')] }));
            const [deleted] = callsOf(delivered.telegram, 'deleteMessage').map((call) => call.payload);

            expect(
                delivered.version?.file?.name === 'notes.txt' &&
                    (delivered.version.messageIds ?? []).length === 1 &&
                    delivered.version.messageIds[0] === delivered.telegram.sentIds('sendDocument')[0],
                'the document message is the reply, the processing message is gone'
            );
            expect(deleted !== undefined, 'the processing message was deleted');
        },
    },
    {
        name: 'a refused caption is retried as plain text and keeps the file',
        body: async () => {
            const delivered = await deliver(
                reply({ text: '给你', files: [fileOf('body', 'a.md', '**粗体**配文')] }),
                { entityRefusing: ['sendDocument'] }
            );
            const documents = callsOf(delivered.telegram, 'sendDocument');

            expect(
                documents.length === 2 &&
                    documents[1]?.payload.caption === '粗体配文' &&
                    documents[1]?.payload.caption_entities === undefined,
                `the second attempt drops entities (got ${json(documents.map((call) => call.payload.caption))})`
            );
            expect(
                delivered.version?.file?.name === 'a.md' && delivered.version.fileBase64 !== undefined,
                'the file is still stored'
            );
        },
    },
    {
        name: 'a refused upload leaves the reply without the file',
        body: async () => {
            const withText = await deliver(reply({ text: '给你', files: [fileOf('x', 'a.md')] }), {
                failing: ['sendDocument'],
            });
            expect(
                withText.version !== undefined &&
                    withText.version.file === undefined &&
                    withText.version.fileBase64 === undefined,
                'a failed send stores no file'
            );
            expect(withText.row?.file === null && withText.row.mediaHint === null, 'the row has no file bytes either');
            expect(textOf(callsOf(withText.telegram, 'editMessageText').at(-1)) === '给你', 'the text stays');

            const fileOnly = await deliver(reply({ files: [fileOf('x', 'a.md')] }), {
                failing: ['sendDocument'],
            });
            expect(
                textOf(callsOf(fileOnly.telegram, 'editMessageText').at(-1)) === '[file failed to send]',
                'a file-only reply says the file did not go out'
            );
        },
    },
    {
        name: 'a version switch re-sends the stored file and deletes the old one',
        body: async () => {
            const chatId = -1003900000041;
            const telegram = createFakeTelegram(chatId);
            const userMessageId = takeMessageId();
            const replyId = takeMessageId();
            const fileMessageId = takeMessageId();
            const BODY = '# 文件内容\n第二行';

            await seedResponse({
                chatId,
                firstMessageId: replyId,
                userMessageId,
                currentVersionIndex: 1,
                versions: [
                    {
                        text: '',
                        messageIds: [fileMessageId],
                        currentMessageId: fileMessageId,
                        file: { name: 'notes.md', mimeType: 'text/markdown', sizeBytes: Buffer.byteLength(BODY), caption: '旧配文' },
                        fileBase64: Buffer.from(BODY, 'utf8').toString('base64'),
                    },
                    { text: '第二版只有文字', messageIds: [replyId], currentMessageId: replyId },
                ],
            });
            await seedRow({
                chatId,
                messageId: replyId,
                fromBotSelf: true,
                userId: 7777,
                text: '第二版只有文字',
            });

            const ctx = contextIn(telegram, chatId, takeMessageId());
            const { result: switched } = await captureConsole(() => switchVersion(ctx, replyId, 'prev'));
            const documentCall = callsOf(telegram, 'sendDocument')[0];

            expect(switched, 'the file version is switchable');
            expect(
                documentCall !== undefined &&
                    fileNameOf(documentCall.payload.document) === 'notes.md' &&
                    documentCall.payload.caption === '旧配文' &&
                    documentCall.payload.reply_markup !== undefined,
                `the stored file is re-uploaded with its caption and buttons (got ${json(fileNameOf(documentCall?.payload.document))})`
            );

            const row = await rowOf(chatId, replyId);
            expect(
                row?.file === null &&
                    row.mediaHint === 'a file: notes.md, text/markdown' &&
                    row.fileMime === null,
                `the row names the switched-to file, without its bytes (got ${json({ hint: row?.mediaHint, mime: row?.fileMime })})`
            );

            const { result: back } = await captureConsole(() =>
                switchVersion(contextIn(telegram, chatId, takeMessageId()), replyId, 'next')
            );
            expect(back, 'and switchable back');
            const lastSentText = textOf(callsOf(telegram, 'sendMessage').at(-1));
            expect(
                callsOf(telegram, 'deleteMessage').length >= 1 && lastSentText.includes('第二版只有文字'),
                `the file message is deleted when the text version comes back (got ${json(lastSentText)})`
            );
        },
    },
    {
        name: 'retrying a file-only reply deletes the stored document',
        body: async () => {
            const chatId = -1003900000042;
            const telegram = createFakeTelegram(chatId);
            const userMessageId = takeMessageId();
            const replyId = takeMessageId();
            const fileMessageId = takeMessageId();

            await seedResponse({
                chatId,
                firstMessageId: replyId,
                userMessageId,
                versions: [
                    {
                        text: '',
                        messageIds: [replyId, fileMessageId],
                        currentMessageId: fileMessageId,
                        file: { name: 'a.md', mimeType: 'text/markdown', sizeBytes: 1 },
                        fileBase64: Buffer.from('x').toString('base64'),
                    },
                ],
            });

            const ctx = contextIn(telegram, chatId, takeMessageId());
            const { result: session } = await captureConsole(() => startRetry(ctx, replyId));
            expect(session !== null, 'the retry starts');
            const deleted = callsOf(telegram, 'deleteMessage').map((call) => call.payload.message_id);
            expect(
                deleted.includes(replyId) && deleted.includes(fileMessageId),
                `both messages of the file-only reply are removed (got ${json(deleted)})`
            );
        },
    },
    {
        name: 'the next context names the file and does not replay its bytes',
        body: async () => {
            const BODY = '# Skill\n\n第一行\n第二行';
            const delivered = await deliver(reply({ text: '写好了', files: [fileOf(BODY, 'SKILL.md')] }));
            const follower = await seedRow({ replyToId: delivered.firstId, text: '这个文件讲了什么' });
            const row = await rowOf(OFFLINE_CHAT_ID, follower);
            if (!row) throw new Error('the follow-up row was not stored');

            const { result: built } = await captureConsole(() =>
                buildContext(row, { capabilities: VISION, model: 'gemini-3.8-flash' })
            );
            const assistant = built.messages.find((turn) => turn.role === 'assistant');
            const parts = assistant?.content ?? [];
            const named = parts.some(
                (part) =>
                    part.type === 'text' &&
                    (part.text ?? '').includes('[sent a file: SKILL.md, text/markdown]') &&
                    (part.text ?? '').includes('写好了')
            );

            expect(named, 'the assistant turn names the file message');
            expect(
                parts.every((part) => !(part.type === 'text' && (part.text ?? '').includes(BODY))),
                'the file body is not replayed into the context'
            );
            expect(
                parts.every((part) => part.type !== 'image' && part.type !== 'media'),
                'no binary media part is attached for the file'
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
