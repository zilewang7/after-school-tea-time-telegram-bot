/**
 * A rich message (Bot API 10.1+ `rich_message`) from the update to what the
 * model reads: the blocks become markdown in the stored row, what the message
 * carries besides its text goes into columns, and the context builder renders
 * both.
 *
 * Only a premium account can send a real one, so the update is built by hand
 * and fed to the bot. Its photo cannot be fetched (the fake Bot API has no
 * file for it), which is the case the model has to be told about.
 */
import type { Update } from 'grammy/types';
import { expect, reportResults, runCase, setupOfflineDb, takeMessageId, type CaseResult } from './harness.mts';
import { createFakeBot, quietly, waitUntil } from './fake-telegram.mts';

// Read per call by autoSave; set before the first src import
process.env.BOT_USER_NAME = 'AfterSchoolTeatimeBot';
process.env.BOT_USER_ID = '7777';
delete process.env.ALLOWED_CHAT_IDS;

await setupOfflineDb();
const { autoSave } = await import('../../src/db/autoSave.js');
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

reportResults(results);
