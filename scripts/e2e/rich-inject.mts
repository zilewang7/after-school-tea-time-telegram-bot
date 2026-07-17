/**
 * Injection test for rich message ingestion (Bot API 10.1+ rich_message).
 * Real rich messages can only be SENT by premium accounts, so e2e can't
 * produce one — instead we inject a hand-built update into bot.handleUpdate
 * and assert the DB row contains the markdown conversion.
 *
 * Run: DB_PATH=/tmp/rich-inject.sqlite BOT_TOKEN=dummy:token pnpm exec tsx scripts/e2e/rich-inject.mts
 */
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { autoSave } from '../../src/db/autoSave.js';
import { getMessage } from '../../src/db/index.js';
import { sequelize } from '../../src/db/config.js';

const CHAT_ID = -100999000111;
const MESSAGE_ID = 424242;

const botInfo: UserFromGetMe = {
    id: 1,
    is_bot: true,
    first_name: 'inject-test',
    username: 'inject_test_bot',
    can_join_groups: true,
    can_read_all_group_messages: true,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
};

const update: Update = {
    update_id: 1,
    message: {
        message_id: MESSAGE_ID,
        date: Math.floor(1_800_000_000),
        chat: { id: CHAT_ID, type: 'supergroup', title: 'inject' },
        from: { id: 111, is_bot: false, first_name: '测试用户' },
        rich_message: {
            blocks: [
                { type: 'heading', size: 2, text: '周报' },
                {
                    type: 'paragraph',
                    text: ['本周 ', { type: 'bold', text: '重点' }, ' 如下'],
                },
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
                        {
                            file_id: 'FAKE_FILE_ID_SMALL',
                            file_unique_id: 'FAKE_UNIQUE_SMALL',
                            width: 90,
                            height: 90,
                            file_size: 1024,
                        },
                        {
                            file_id: 'FAKE_FILE_ID_BIG',
                            file_unique_id: 'FAKE_UNIQUE_BIG',
                            width: 1280,
                            height: 720,
                            file_size: 123456,
                        },
                    ],
                    caption: { text: '插图' },
                },
            ],
        },
    },
};

const main = async (): Promise<void> => {
    // index.ts fires sync on import without awaiting; wait for the schema here
    await sequelize.sync({ alter: true });
    const bot = new Bot(process.env.BOT_TOKEN ?? 'dummy:token', { botInfo });
    autoSave(bot);
    await bot.handleUpdate(update);

    // saveMessage is awaited inside the middleware, so the row exists now
    const stored = await getMessage(CHAT_ID, MESSAGE_ID);
    if (!stored) throw new Error('rich message row not saved');
    const text = stored.text;
    console.log('--- stored text ---');
    console.log(text);

    const checks: Array<[string, boolean]> = [
        ['heading as ##', text.includes('## 周报')],
        ['bold inline', text.includes('**重点**')],
        ['list items', text.includes('- 第一项') && text.includes('- 第二项')],
        ['GFM table', text.includes('| 项目 | 状态 |')],
        ['fenced code with language', text.includes('```js')],
        ['media placeholder with caption', text.includes('[图片] 插图')],
        // The photo block's largest PhotoSize must be picked up as the
        // message's attached media (download itself fails here: fake file_id)
        ['media hint for rich photo block', text.includes('(I send a picture')],
    ];
    let failed = 0;
    for (const [name, ok] of checks) {
        console.log(`  ${ok ? '✓' : '✗'} ${name}`);
        if (!ok) failed += 1;
    }
    if (failed > 0) throw new Error(`${failed} checks failed`);
    console.log('rich-inject: ALL PASS');
    process.exit(0);
};

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
