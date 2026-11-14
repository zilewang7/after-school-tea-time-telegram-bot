/**
 * A rich message (Bot API 10.1+ `rich_message`) from the update to what the
 * model reads: the blocks become markdown in the stored row, what the message
 * carries besides its text goes into columns, and the context builder renders
 * both.
 *
 * Only a premium account can send a real one, so the update is built by hand
 * and fed to the bot. Its photo cannot be fetched (the fake Bot API has no
 * file for it), which is the case the model has to be told about.
 *
 * The 10.3 blocks (expandable quotes, documents, button rows, inline buttons)
 * follow, each in a message of its own, then shapes no Bot API version has
 * yet: a later Bot API must never cost a message.
 */
import type { Bot } from 'grammy';
import type { RichBlock, Update } from 'grammy/types';
import { expect, reportResults, runCase, setupOfflineDb, takeMessageId, type CaseResult } from './harness.mts';
import { createFakeBot, quietly, waitUntil } from './fake-telegram.mts';

// Read per call by autoSave; set before the first src import
process.env.BOT_USER_NAME = 'AfterSchoolTeatimeBot';
process.env.BOT_USER_ID = '7777';
delete process.env.ALLOWED_CHAT_IDS;

await setupOfflineDb();
const { autoSave, autoUpdate } = await import('../../src/db/autoSave.js');
const { getMessage } = await import('../../src/db/index.js');
const { buildContext } = await import('../../src/reply/context-builder.js');
const { isAsyncFileSavePending } = await import('../../src/state.js');

type ModelCapabilities = import('../../src/ai/types.js').ModelCapabilities;

const CHAT_ID = -1007800000001;
const MESSAGE_ID = takeMessageId();

const update: Update = {
    update_id: 1,
    message: {
        message_id: MESSAGE_ID,
        date: 1_800_000_000,
        chat: { id: CHAT_ID, type: 'supergroup', title: '测试群' },
        from: { id: 111, is_bot: false, first_name: '测试用户' },
        forward_origin: {
            type: 'channel',
            date: 1_784_000_000,
            chat: { id: -1002000000000, type: 'channel', title: '测试频道' },
            message_id: 99,
        },
        rich_message: {
            blocks: [
                { type: 'heading', size: 2, text: '周报' },
                { type: 'paragraph', text: ['本周 ', { type: 'bold', text: '重点' }, ' 如下'] },
                {
                    type: 'list',
                    items: [
                        { label: '•', blocks: [{ type: 'paragraph', text: '第一项' }] },
                        { label: '•', blocks: [{ type: 'paragraph', text: '第二项' }] },
                    ],
                },
                {
                    type: 'table',
                    cells: [
                        [
                            { text: '项目', is_header: true, align: 'left', valign: 'top' },
                            { text: '状态', is_header: true, align: 'left', valign: 'top' },
                        ],
                        [
                            { text: '接入', align: 'left', valign: 'top' },
                            { text: '完成', align: 'left', valign: 'top' },
                        ],
                    ],
                },
                { type: 'pre', text: 'console.log(1)', language: 'js' },
                {
                    type: 'photo',
                    photo: [
                        { file_id: 'FAKE_FILE_ID_SMALL', file_unique_id: 'FAKE_UNIQUE_SMALL', width: 90, height: 90, file_size: 1024 },
                        { file_id: 'FAKE_FILE_ID_BIG', file_unique_id: 'FAKE_UNIQUE_BIG', width: 1280, height: 720, file_size: 123456 },
                    ],
                    caption: { text: '插图' },
                },
            ],
        },
    },
};

/** Sees images and nothing else */
const IMAGE_ONLY: ModelCapabilities = {
    supportsImageInput: true,
    supportsImageOutput: false,
    supportsSystemPrompt: true,
    requiresMessageMerge: false,
    supportsThinking: false,
    supportsGrounding: false,
    supportsMediaInput: false,
};

const { bot, telegram } = createFakeBot();
autoSave(bot);
autoUpdate(bot);
// The row is saved inside the middleware; the photo is fetched after it
await quietly(() => bot.handleUpdate(update));
await quietly(() => waitUntil('the photo to be given up', () => !isAsyncFileSavePending(CHAT_ID, MESSAGE_ID)));

const stored = await getMessage(CHAT_ID, MESSAGE_ID);
// A missing row fails every check below instead of ending the file here
const text = stored?.text ?? '';

const results: CaseResult[] = [];

results.push(
    await runCase('the blocks of a rich message are stored as markdown', () => {
        expect(stored !== null, 'the message is stored');
        expect(text.includes('## 周报'), `a heading becomes ## (${text})`);
        expect(text.includes('本周 **重点** 如下'), 'bold text inside a paragraph stays inline');
        expect(text.includes('- 第一项') && text.includes('- 第二项'), 'list items become - lines');
        expect(text.includes('| 项目 | 状态 |') && text.includes('| 接入 | 完成 |'), 'a table becomes a GFM table');
        expect(text.includes('```js\nconsole.log(1)\n```'), 'a code block keeps its language');
        expect(text.includes('[图片] 插图'), 'a photo leaves a placeholder with its caption');
    })
);

results.push(
    await runCase('what the message carries besides its text goes into columns', () => {
        expect(!text.includes('(I send') && !text.includes('<<EOF'), 'the stored text is the content alone');
        expect(
            stored?.mediaHint === 'a picture — failed to download, you cannot see it',
            `the photo is noted, and that it could not be fetched (${stored?.mediaHint})`
        );
        expect(stored?.forwardOrigin === 'channel 测试频道', `and where it was forwarded from (${stored?.forwardOrigin})`);
        expect(telegram.callsOf('getFile').length > 0, 'the photo was asked for');
    })
);

results.push(
    await runCase('the context builder renders the row for the model', async () => {
        if (stored === null || stored === undefined) throw new Error('the message is not stored');
        const context = await buildContext(stored, { capabilities: IMAGE_ONLY });
        const rendered = (context.messages.at(-1)?.content ?? [])
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n');
        expect(rendered.includes('## 周报') && rendered.includes('| 项目 | 状态 |'), 'the markdown is what the model reads');
        expect(rendered.includes('[forwarded from channel 测试频道]'), `the forward is annotated (${rendered})`);
        expect(
            rendered.includes('[sent a picture — failed to download, you cannot see it]'),
            'the model is told that there was a picture it cannot see'
        );
        expect(rendered.includes('\n<<EOF'), 'the message ends with the EOF marker');
    })
);

// ---- Bot API 10.3 blocks, and shapes no Bot API version has yet ----

const SENT_AT = 1_800_000_100;
let nextUpdateId = 1000;

const richMessageUpdate = (messageId: number, blocks: RichBlock[]): Update => ({
    update_id: (nextUpdateId += 1),
    message: {
        message_id: messageId,
        date: SENT_AT,
        chat: { id: CHAT_ID, type: 'supergroup', title: '测试群' },
        from: { id: 111, is_bot: false, first_name: '测试用户' },
        rich_message: { blocks },
    },
});

const textMessageUpdate = (messageId: number, messageText: string): Update => ({
    update_id: (nextUpdateId += 1),
    message: {
        message_id: messageId,
        date: SENT_AT,
        chat: { id: CHAT_ID, type: 'supergroup', title: '测试群' },
        from: { id: 111, is_bot: false, first_name: '测试用户' },
        text: messageText,
    },
});

/** The message edited into a rich message a minute after it was sent */
const richEditUpdate = (messageId: number, blocks: RichBlock[]): Update => ({
    update_id: (nextUpdateId += 1),
    edited_message: {
        message_id: messageId,
        date: SENT_AT,
        edit_date: SENT_AT + 60,
        chat: { id: CHAT_ID, type: 'supergroup', title: '测试群' },
        from: { id: 111, is_bot: false, first_name: '测试用户' },
        rich_message: { blocks },
    },
});

/** Feed an update, wait until its file is fetched or given up, read the row */
const handleAndRead = async (target: Bot, incoming: Update, messageId: number) => {
    await target.handleUpdate(incoming);
    await waitUntil('the file to be given up', () => !isAsyncFileSavePending(CHAT_ID, messageId));
    return getMessage(CHAT_ID, messageId);
};

/** The same, with what the bot logs swallowed */
const ingest = (target: Bot, incoming: Update, messageId: number) =>
    quietly(() => handleAndRead(target, incoming, messageId));

/** Run `body` with console output swallowed; also returns the lines it logged as errors */
const withLoggedErrors = async <Result,>(body: () => Promise<Result>): Promise<{ result: Result; errors: string[] }> => {
    const original = { log: console.log, warn: console.warn, error: console.error };
    const errors: string[] = [];
    console.log = () => undefined;
    console.warn = () => undefined;
    console.error = (...args: unknown[]) => {
        errors.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
    };
    try {
        return { result: await body(), errors };
    } finally {
        console.log = original.log;
        console.warn = original.warn;
        console.error = original.error;
    }
};

/** What was logged about one message of the chat */
const loggedForMessage = (errors: string[], messageId: number): string[] =>
    errors.filter((line) => line.includes(`${CHAT_ID}/${messageId}`));

const fileIdsAskedFor = (): unknown[] => telegram.callsOf('getFile').map((call) => call.payload.file_id);

const REPORT_DOCUMENT: RichBlock = {
    type: 'document',
    document: {
        file_id: 'FAKE_DOC',
        file_unique_id: 'FAKE_DOC_U',
        file_name: 'report.pdf',
        mime_type: 'application/pdf',
        file_size: 2048,
    },
    caption: { text: '周报' },
};

// ton_address is Bot API 10.4: grammy 1.46 has no type for it yet
const TON_PARAGRAPH: RichBlock = JSON.parse('{"type":"paragraph","text":["钱包 ",{"type":"ton_address","text":"UQAbc123","address":"UQAbc123"}]}');

results.push(
    await runCase('10.3 blocks are stored as markdown, and the document is the attached file', async () => {
        const messageId = takeMessageId();
        telegram.reset();
        const row = await ingest(bot, richMessageUpdate(messageId, [
            { type: 'expandable_blockquote', text: ['第一行\n第二行 ', { type: 'bold', text: '粗' }], credit: '某人' },
            REPORT_DOCUMENT,
            {
                type: 'buttons',
                buttons: [
                    { text: '打开', url: 'https://example.com/open' },
                    { text: '签到', callback_data: 'sign-in' },
                ],
            },
            {
                type: 'paragraph',
                text: [
                    '点 ',
                    { type: 'button', button: { text: '这里', url: 'https://example.com/here' } },
                    ' 或 ',
                    { type: 'button', button: { text: '回调', callback_data: 'callback' } },
                ],
            },
            TON_PARAGRAPH,
        ]), messageId);
        const rowText = row?.text ?? '';
        expect(row !== null, 'the message is stored');
        expect(
            rowText.includes('<details>\n第一行\n第二行 **粗**\n— 某人\n</details>'),
            `an expandable quote becomes <details> with its credit (${rowText})`
        );
        expect(rowText.includes('[文件] report.pdf 周报'), 'a document leaves its name and caption');
        expect(
            rowText.includes('[按钮] [打开](https://example.com/open) · 签到'),
            'a button row keeps the url of a url button and the label of a callback button'
        );
        expect(rowText.includes('点 [这里](https://example.com/here) 或 回调'), 'inline buttons become a link and a label');
        expect(rowText.includes('钱包 UQAbc123'), 'a 10.4 ton address keeps its text');
        expect(
            row?.mediaHint === 'a file: report.pdf, application/pdf — failed to download, you cannot see it',
            `the document is the attached file, and could not be fetched (${row?.mediaHint})`
        );
        expect(fileIdsAskedFor().includes('FAKE_DOC'), `the document was asked for (${JSON.stringify(fileIdsAskedFor())})`);
    })
);

results.push(
    await runCase('a photo wins the single file slot over a document', async () => {
        const messageId = takeMessageId();
        telegram.reset();
        const row = await ingest(bot, richMessageUpdate(messageId, [
            REPORT_DOCUMENT,
            {
                type: 'photo',
                photo: [{ file_id: 'FAKE_PHOTO', file_unique_id: 'FAKE_PHOTO_U', width: 800, height: 600, file_size: 4096 }],
            },
        ]), messageId);
        expect(
            row?.mediaHint === 'a picture (this rich message carries 2 media files, only this one is attached) — failed to download, you cannot see it',
            `the photo is attached and the document counted (${row?.mediaHint})`
        );
        expect(
            fileIdsAskedFor().includes('FAKE_PHOTO') && !fileIdsAskedFor().includes('FAKE_DOC'),
            `only the photo was asked for (${JSON.stringify(fileIdsAskedFor())})`
        );
        expect((row?.text ?? '').includes('[文件] report.pdf 周报'), 'the document still leaves its placeholder');
    })
);

const ARCHIVE_DOCUMENT: RichBlock = {
    type: 'document',
    document: { file_id: 'FAKE_ZIP', file_unique_id: 'FAKE_ZIP_U', file_name: 'src.zip', mime_type: 'application/zip', file_size: 2048 },
};
const CLIP_VIDEO: RichBlock = {
    type: 'video',
    video: { file_id: 'FAKE_VIDEO', file_unique_id: 'FAKE_VIDEO_U', width: 640, height: 360, duration: 5, mime_type: 'video/mp4', file_size: 8192 },
};

results.push(
    await runCase('without a photo, the first file the model can read wins the slot over one it cannot', async () => {
        const messageId = takeMessageId();
        telegram.reset();
        const row = await ingest(bot, richMessageUpdate(messageId, [ARCHIVE_DOCUMENT, CLIP_VIDEO]), messageId);
        expect(
            row?.mediaHint === 'a video (this rich message carries 2 media files, only this one is attached) — failed to download, you cannot see it',
            `the video is attached and the archive counted (${row?.mediaHint})`
        );
        expect(
            fileIdsAskedFor().includes('FAKE_VIDEO') && !fileIdsAskedFor().includes('FAKE_ZIP'),
            `only the video was asked for (${JSON.stringify(fileIdsAskedFor())})`
        );

        const readableFirstId = takeMessageId();
        telegram.reset();
        const readableFirst = await ingest(bot, richMessageUpdate(readableFirstId, [REPORT_DOCUMENT, CLIP_VIDEO]), readableFirstId);
        expect(
            readableFirst?.mediaHint?.startsWith('a file: report.pdf, application/pdf (this rich message carries 2 media files') === true,
            `a file the model can read keeps its place before the video (${readableFirst?.mediaHint})`
        );
    })
);

results.push(
    await runCase('an edit into a rich message with a document attaches the document', async () => {
        const messageId = takeMessageId();
        await ingest(bot, textMessageUpdate(messageId, '先发一条纯文本'), messageId);
        telegram.reset();
        const row = await ingest(bot, richEditUpdate(messageId, [
            { type: 'paragraph', text: '改成了富文本' },
            {
                type: 'document',
                document: { file_id: 'FAKE_EDIT_DOC', file_unique_id: 'FAKE_EDIT_DOC_U', file_name: 'notes.txt', mime_type: 'text/plain', file_size: 512 },
            },
        ]), messageId);
        const rowText = row?.text ?? '';
        expect(rowText.includes('改成了富文本') && rowText.includes('[文件] notes.txt'), `the edited text is stored (${rowText})`);
        expect(!rowText.includes('先发一条纯文本'), 'and replaces the original');
        expect(
            row?.mediaHint === 'a file: notes.txt, text/plain — failed to download, you cannot see it',
            `the document becomes the attached file (${row?.mediaHint})`
        );
        expect(fileIdsAskedFor().includes('FAKE_EDIT_DOC'), `the document was asked for (${JSON.stringify(fileIdsAskedFor())})`);
    })
);

// Shapes no Bot API version has yet; JSON.parse because no type allows them
const FUTURE_BLOCKS: RichBlock[] = JSON.parse(`[
    {"type": "future_block", "text": "未来的块"},
    {"type": "paragraph", "text": [
        "之前 ",
        {"type": "future_inline", "text": "未来的行内"},
        {"type": "future_inline_without_text", "payload": 1},
        " 之后"
    ]}
]`);

results.push(
    await runCase('an unknown block or inline type never drops the message', async () => {
        const messageId = takeMessageId();
        const row = await ingest(bot, richMessageUpdate(messageId, FUTURE_BLOCKS), messageId);
        const rowText = row?.text ?? '';
        expect(row !== null, 'the message is stored');
        expect(rowText.includes('未来的块'), `an unknown block keeps its text (${rowText})`);
        expect(rowText.includes('之前 未来的行内 之后'), 'an unknown inline node keeps its text, one without text is left out');
    })
);

// The package renderer does not throw on any shape today; this one stands in
// for a later release that does
const { bot: failingBot, telegram: failingTelegram } = createFakeBot();
const throwingRenderer = (): string => {
    throw new TypeError("Cannot read properties of undefined (reading 'type')");
};
autoSave(failingBot, { renderRichBlocks: throwingRenderer });
autoUpdate(failingBot, { renderRichBlocks: throwingRenderer });

const UNRENDERABLE_BLOCKS: RichBlock[] = [
    { type: 'heading', size: 2, text: '周报' },
    { type: 'paragraph', text: ['本周 ', { type: 'bold', text: '重点' }, ' 如下'] },
    { type: 'expandable_blockquote', text: '藏起来的话', credit: '某人' },
    {
        type: 'buttons',
        buttons: [{
            text: ['打开 ', { type: 'custom_emoji', custom_emoji_id: 'emoji-id', alternative_text: '👍' }],
            url: 'https://example.com/open',
        }],
    },
    REPORT_DOCUMENT,
];
const UNRENDERABLE_PLAIN_TEXT = '周报\n本周 重点 如下\n藏起来的话\n某人\n打开 👍\nreport.pdf\n周报';

results.push(
    await runCase('a renderer that throws still stores the message, as plain text', async () => {
        const messageId = takeMessageId();
        failingTelegram.reset();
        const { result: row, errors } = await withLoggedErrors(() =>
            handleAndRead(failingBot, richMessageUpdate(messageId, UNRENDERABLE_BLOCKS), messageId)
        );
        expect(row !== null, 'the message is stored');
        expect(
            row?.text === UNRENDERABLE_PLAIN_TEXT,
            `with the plain text of every block, ids and urls left out (${JSON.stringify(row?.text)})`
        );
        expect(
            row?.mediaHint === 'a file: report.pdf, application/pdf — failed to download, you cannot see it',
            `the document is still attached (${row?.mediaHint})`
        );
        const logged = loggedForMessage(errors, messageId);
        expect(
            logged.length === 1 && logged[0]?.includes('plain text') === true && !logged[0].includes('\n'),
            `one line names the message (${JSON.stringify(errors)})`
        );
        expect(!errors.some((line) => line.includes('DROPPED')), 'nothing is dropped');
    })
);

results.push(
    await runCase('an edit with a renderer that throws stores the plain text too', async () => {
        const messageId = takeMessageId();
        await ingest(failingBot, textMessageUpdate(messageId, '原来的文字'), messageId);
        const { result: row, errors } = await withLoggedErrors(() =>
            handleAndRead(failingBot, richEditUpdate(messageId, FUTURE_BLOCKS), messageId)
        );
        expect(
            row?.text === '未来的块\n之前 未来的行内 之后',
            `the edit is stored as plain text (${JSON.stringify(row?.text)})`
        );
        expect(loggedForMessage(errors, messageId).length === 1, `one line names the message (${JSON.stringify(errors)})`);
        expect(!errors.some((line) => line.includes('更新消息失败')), 'the edit is not lost');
    })
);

// A photo block without its photo sizes: no Bot API allows it today
const PHOTO_WITHOUT_SIZES: RichBlock = JSON.parse('{"type":"photo","caption":{"text":"没有图的图片块"}}');

results.push(
    await runCase('a known block in a shape its type does not allow never drops the message', async () => {
        const messageId = takeMessageId();
        telegram.reset();
        const { result: row, errors } = await withLoggedErrors(() =>
            handleAndRead(bot, richMessageUpdate(messageId, [REPORT_DOCUMENT, PHOTO_WITHOUT_SIZES]), messageId)
        );
        const rowText = row?.text ?? '';
        expect(row !== null, 'the message is stored');
        expect(
            rowText.includes('[文件] report.pdf 周报') && rowText.includes('[图片] 没有图的图片块'),
            `with the text of both blocks (${rowText})`
        );
        expect(
            row?.mediaHint === 'a file: report.pdf, application/pdf — failed to download, you cannot see it',
            `the file found before the broken block is still attached (${row?.mediaHint})`
        );
        expect(
            loggedForMessage(errors, messageId).some((line) => line.includes('media of rich message')),
            `one line names the message (${JSON.stringify(errors)})`
        );
        expect(!errors.some((line) => line.includes('DROPPED')), 'nothing is dropped');
    })
);

reportResults(results);
