/**
 * Offline cases for the `/panel` message receipt (design 2026-1119-2016 §4.7):
 * `/panel` replying to a message registers the sent keyboard message for the
 * conversation it deep-links to; the panel's exclusion writes (single and
 * batch) and a conversation splice append one line each to the newest such
 * message, keep the buttons, keep only the five newest lines, and stay best
 * effort (a deleted message, no registration or no Bot API changes nothing).
 *
 * Cases drive the real grammY `/panel` handler through the fake Telegram API
 * (the share-command.mts style) and the real panel app for the writes.
 *
 * Run: npx tsx scripts/offline/panel-keyboard-notice.mts
 */
import { InlineKeyboard } from 'grammy';
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';
import { createFakeBot, createFakeTelegram, groupChat, messageUpdate, quietly, userOf, waitUntil, type FakeTelegram } from './fake-telegram.mts';
import { signInitData, type InitDataUserInput } from '../lib/init-data.mts';

const BOT_TOKEN = '123456789:AAFakeOfflineTokenForPanelTests_0123';
const OWNER_ID = 4242;
const BOT_USER_ID = 7777;
const ALICE: InitDataUserInput = { id: 5001, first_name: 'Alice' };
const BASE_TEXT = '这条会话的控制面板：';

/** The browser entry the command appends; the receipt edits keep it (HTML parse mode) */
const browserJumpLine = (chatId: number, rootId: number): string =>
    `网页版：<a href="https://miniapp.test/c/${chatId}/conv/${rootId}">在浏览器打开</a>`;
const baseTextOf = (chatId: number, rootId: number): string =>
    `${BASE_TEXT}\n${browserJumpLine(chatId, rootId)}`;

process.env.OWNER_USER_ID = String(OWNER_ID);
process.env.BOT_USER_ID = String(BOT_USER_ID);
process.env.WEBAPP_PUBLIC_URL = 'https://miniapp.test';
process.env.BOT_USER_NAME = 'k_on_test_bot';
process.env.WIDGET_RENDER_URL = '';
delete process.env.ALLOWED_CHAT_IDS;
delete process.env.LUOXU_PREVIEW_URL;

const db = await setupOfflineDb();
const registry = await import('../../src/db/queries/panel-registry.js');
const state = await import('../../src/state.js');
const { setPanelRunning } = await import('../../src/panel/panel-state.js');
const { registerPanelCommand } = await import('../../src/cmd/commands/panel.js');
const { createPanelApp } = await import('../../src/panel/app.js');
const { reportSpliceReceipt } = await import('../../src/services/conversation-keyboard-service.js');

type MembershipLookup = import('../../src/panel/access/membership.js').MembershipLookup;

const fakeLookup: MembershipLookup = async (_chatId, userId) => {
    if (userId === ALICE.id) return { status: 'member' };
    return { status: 'left' };
};

/** A panel app whose receipts are recorded by `telegram` (null = the app has no Bot API) */
const makeApp = (telegram: FakeTelegram | null) =>
    createPanelApp({
        botToken: BOT_TOKEN,
        membershipLookup: fakeLookup,
        staticRoot: '/nonexistent-panel-static-root',
        startedAt: new Date('2026-11-19T00:00:00.000Z'),
        version: 'test',
        botApi: telegram?.api,
        rateLimit: { limit: 1000, windowMs: 60_000 },
    });

interface Response {
    status: number;
    body: any;
}

const request = async (
    app: ReturnType<typeof createPanelApp>,
    method: string,
    path: string,
    body?: unknown
): Promise<Response> => {
    const headers = new Headers({
        'X-Init-Data': signInitData({ botToken: BOT_TOKEN, user: ALICE, authDate: Math.floor(Date.now() / 1000) }),
    });
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await app.request(path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: JSON.parse(await response.text()) };
};

/** Unique ids per case: every case owns its chats, conversations and receipts */
let nextChatId = -1009700000000;
const takeChatId = (): number => (nextChatId -= 1);
let nextMessageId = 500_000;
const takeId = (): number => (nextMessageId += 1);

const seedMessage = async (chatId: number, userId: number, text: string, replyToId?: number): Promise<number> => {
    const messageId = takeId();
    await db.saveMessage({
        chatId,
        messageId,
        userId,
        date: new Date(Date.now() - 600_000 + messageId),
        userName: 'Alice',
        message: text,
        ...(replyToId === undefined ? {} : { replyToId }),
    });
    return messageId;
};

/** The group is known to the panel (a /panel call does this on its own) */
const registerChat = async (chatId: number): Promise<void> => {
    await registry.upsertChatNow({ id: chatId, type: 'supergroup', title: 'Receipts' });
};

/** One user message replying another: a conversation of two messages, root first */
const seedConversation = async (chatId: number): Promise<{ rootId: number; childId: number }> => {
    const rootId = await seedMessage(chatId, ALICE.id, '根消息');
    const childId = await seedMessage(chatId, ALICE.id, '回复', rootId);
    return { rootId, childId };
};

// ---- driving the real /panel handler ----------------------------------------

setPanelRunning(true);
const { bot: panelBot, telegram: panelTelegram } = createFakeBot();
registerPanelCommand(panelBot);

const urlOf = (replyMarkup: unknown): string | null => {
    const markup = typeof replyMarkup === 'object' && replyMarkup !== null ? replyMarkup : {};
    const rows = 'inline_keyboard' in markup && Array.isArray(markup.inline_keyboard) ? markup.inline_keyboard : [];
    for (const row of rows) {
        if (!Array.isArray(row)) continue;
        for (const button of row) {
            if (typeof button === 'object' && button !== null && 'url' in button && typeof button.url === 'string') {
                return button.url;
            }
        }
    }
    return null;
};

/** A `/panel` sent as a reply to `replyToMessageId`; returns the message text and button URL */
const drivePanel = async (chatId: number, replyToMessageId: number): Promise<{ text: string; url: string | null }> => {
    panelTelegram.reset();
    const update = messageUpdate({ chatId, messageId: takeId(), userId: ALICE.id, text: '/panel' });
    const message = update.message;
    if (message !== undefined) {
        message.reply_to_message = {
            message_id: replyToMessageId,
            date: Math.floor(Date.now() / 1000),
            chat: groupChat(chatId),
            from: userOf(ALICE.id),
            text: '被回复的消息',
            reply_to_message: undefined,
        };
    }
    await quietly(() => panelBot.handleUpdate(update));
    const call = panelTelegram.callsOf('sendMessage').at(-1);
    const text = typeof call?.payload.text === 'string' ? call.payload.text : '';
    return { text, url: urlOf(call?.payload.reply_markup) };
};

/** The keyboard a receipt message carries; the edit must repeat it or Telegram drops it */
const receiptKeyboardOf = (chatId: number, rootId: number): InlineKeyboard =>
    new InlineKeyboard().url('打开这条会话', `https://t.me/k_on_test_bot/panel?startapp=c${chatId}_${rootId}`);

/** A receipt registered directly (cases that do not need the /panel round trip) */
const registerReceipt = (chatId: number, rootId: number, messageId: number): InlineKeyboard => {
    const replyMarkup = receiptKeyboardOf(chatId, rootId);
    state.registerConversationKeyboardMessage({ chatId, rootId, messageId, baseText: BASE_TEXT, replyMarkup });
    return replyMarkup;
};

const editCalls = (telegram: FakeTelegram) => telegram.callsOf('editMessageText');

const lastEditText = (telegram: FakeTelegram): string => {
    const payload = editCalls(telegram).at(-1)?.payload;
    return typeof payload?.text === 'string' ? payload.text : '';
};

const textLines = (text: string): string[] => text.split('\n');

/** The time suffix of one operation line, e.g. 「（20:15）」 */
const TIME_SUFFIX = /（\d{2}:\d{2}）$/;

interface ReceiptFixture {
    chatId: number;
    rootId: number;
    messageId: number;
    keyboard: InlineKeyboard;
    telegram: FakeTelegram;
}

/** A registered chat, a two-message conversation and a receipt on it */
const receiptFixture = async (): Promise<ReceiptFixture> => {
    const chatId = takeChatId();
    await registerChat(chatId);
    const conversation = await seedConversation(chatId);
    const messageId = 900_000 + Math.abs(chatId % 100_000);
    const keyboard = registerReceipt(chatId, conversation.rootId, messageId);
    return { chatId, rootId: conversation.rootId, messageId, keyboard, telegram: createFakeTelegram() };
};

// ---- cases ----------------------------------------------------------------

const results: CaseResult[] = [];

results.push(
    await runCase('/panel replying a message registers the conversation receipt', async () => {
        const chatId = takeChatId();
        const conversation = await seedConversation(chatId);
        const drive = await drivePanel(chatId, conversation.childId);
        expect(
            drive.text === baseTextOf(chatId, conversation.rootId),
            `the reply says what it is and links the browser entry (got ${JSON.stringify(drive.text)})`
        );
        expect(
            drive.url !== null && drive.url.includes(`startapp=c${chatId}_${conversation.rootId}`),
            `the button deep-links to the conversation (got ${JSON.stringify(drive.url)})`
        );
        const entry = state.latestConversationKeyboardMessage(chatId, conversation.rootId);
        expect(entry !== undefined, 'the sent message was registered for its conversation');
        expect(
            entry?.baseText === baseTextOf(chatId, conversation.rootId) && entry?.ops.length === 0,
            'registered with the base text (browser link included) and no lines'
        );
        // A later operation edits the very message the handler sent
        const telegram = createFakeTelegram();
        const app = makeApp(telegram);
        const messageId = await seedMessage(chatId, ALICE.id, '要排除的', conversation.rootId);
        const response = await request(app, 'PUT', `/api/chats/${chatId}/messages/${messageId}/exclusion`);
        expect(response.status === 200, `the exclusion goes through (got ${response.status})`);
        await waitUntil('the receipt edit', () => editCalls(telegram).length > 0);
        expect(editCalls(telegram).at(-1)?.payload.message_id === entry?.messageId, 'the /panel message is the one edited');
        expect(
            editCalls(telegram).at(-1)?.payload.parse_mode === 'HTML',
            'the edit repeats the HTML parse mode the link needs'
        );
        expect(
            drive.url !== null && urlOf(editCalls(telegram).at(-1)?.payload.reply_markup) === drive.url,
            'the edit repeats the button the /panel message was sent with'
        );
    })
);

results.push(
    await runCase('every receipt edit carries the registered keyboard', async () => {
        const chatId = takeChatId();
        const conversation = await seedConversation(chatId);
        const drive = await drivePanel(chatId, conversation.childId);
        expect(drive.url !== null, 'the /panel reply came with a button');
        const telegram = createFakeTelegram();
        const app = makeApp(telegram);
        for (let index = 0; index < 2; index += 1) {
            const messageId = await seedMessage(chatId, ALICE.id, `第 ${index} 条`, conversation.rootId);
            await request(app, 'PUT', `/api/chats/${chatId}/messages/${messageId}/exclusion`);
            await waitUntil(`edit ${index + 1}`, () => editCalls(telegram).length >= index + 1);
        }
        const edits = editCalls(telegram);
        expect(edits.length === 2, `two edits (got ${edits.length})`);
        expect(
            edits.every((call) => urlOf(call.payload.reply_markup) === drive.url),
            `every edit repeats the /panel button (got ${JSON.stringify(edits.map((call) => call.payload.reply_markup))})`
        );
    })
);

results.push(
    await runCase('a single exclusion appends one line and keeps the buttons', async () => {
        const fixture = await receiptFixture();
        const messageIdToExclude = await seedMessage(fixture.chatId, ALICE.id, '要排除的', fixture.rootId);
        const app = makeApp(fixture.telegram);
        const response = await request(app, 'PUT', `/api/chats/${fixture.chatId}/messages/${messageIdToExclude}/exclusion`);
        expect(response.status === 200, `200 (got ${response.status} ${JSON.stringify(response.body)})`);
        await waitUntil('the receipt edit', () => editCalls(fixture.telegram).length > 0);
        const payload = editCalls(fixture.telegram).at(-1)?.payload ?? {};
        expect(
            payload.chat_id === fixture.chatId && payload.message_id === fixture.messageId,
            `edited the registered message (got ${JSON.stringify(payload)})`
        );
        const lines = textLines(lastEditText(fixture.telegram));
        expect(lines[0] === BASE_TEXT && lines.length === 2, `base text then one line (got ${JSON.stringify(lines)})`);
        expect(
            lines[1]?.startsWith('· 已排除 1 条消息') === true && TIME_SUFFIX.test(lines[1] ?? ''),
            `the operation line (got ${JSON.stringify(lines[1])})`
        );
        expect(
            urlOf(payload.reply_markup) === urlOf(fixture.keyboard),
            `the edit repeats the button (got ${JSON.stringify(payload.reply_markup)})`
        );
    })
);

results.push(
    await runCase('a batch exclusion reports the changed count', async () => {
        const fixture = await receiptFixture();
        const targets = [
            await seedMessage(fixture.chatId, ALICE.id, '一', fixture.rootId),
            await seedMessage(fixture.chatId, ALICE.id, '二', fixture.rootId),
            await seedMessage(fixture.chatId, ALICE.id, '三', fixture.rootId),
        ];
        const app = makeApp(fixture.telegram);
        const response = await request(app, 'POST', `/api/chats/${fixture.chatId}/exclusions`, {
            action: 'exclude',
            messageIds: targets,
        });
        expect(response.status === 200 && response.body.changed.length === 3, `three changed (got ${JSON.stringify(response.body)})`);
        await waitUntil('the receipt edit', () => editCalls(fixture.telegram).length > 0);
        expect(
            lastEditText(fixture.telegram).includes('· 已排除 3 条消息（'),
            `the batch count (got ${JSON.stringify(lastEditText(fixture.telegram))})`
        );
    })
);

results.push(
    await runCase('a batch restore appends its own line after the exclude', async () => {
        const fixture = await receiptFixture();
        const targets = [
            await seedMessage(fixture.chatId, ALICE.id, '一', fixture.rootId),
            await seedMessage(fixture.chatId, ALICE.id, '二', fixture.rootId),
        ];
        const app = makeApp(fixture.telegram);
        await request(app, 'POST', `/api/chats/${fixture.chatId}/exclusions`, { action: 'exclude', messageIds: targets });
        await waitUntil('the exclude line', () => editCalls(fixture.telegram).length >= 1);
        const restore = await request(app, 'POST', `/api/chats/${fixture.chatId}/exclusions`, {
            action: 'restore',
            messageIds: targets.slice(0, 1),
        });
        expect(restore.status === 200 && restore.body.changed.length === 1, `one restored (got ${JSON.stringify(restore.body)})`);
        await waitUntil('the restore line', () => editCalls(fixture.telegram).length >= 2);
        const lines = textLines(lastEditText(fixture.telegram));
        expect(lines.length === 3, `base text and two operation lines (got ${JSON.stringify(lines)})`);
        expect(lines[1]?.includes('已排除 2 条消息') === true && lines[2]?.includes('已恢复 1 条消息') === true, 'both lines in order');
    })
);

results.push(
    await runCase('the receipt keeps only its five newest lines', async () => {
        const fixture = await receiptFixture();
        const app = makeApp(fixture.telegram);
        for (let index = 0; index < 6; index += 1) {
            const messageId = await seedMessage(fixture.chatId, ALICE.id, `第 ${index} 条`, fixture.rootId);
            await request(app, 'PUT', `/api/chats/${fixture.chatId}/messages/${messageId}/exclusion`);
            await waitUntil(`edit ${index + 1}`, () => editCalls(fixture.telegram).length >= index + 1);
        }
        const lines = textLines(lastEditText(fixture.telegram));
        expect(lines.length === 6, `base text plus five lines (got ${lines.length})`);
        expect(lines.slice(1).every((line) => line.startsWith('· 已排除 1 条消息')), 'every kept line is one operation');
        expect(state.latestConversationKeyboardMessage(fixture.chatId, fixture.rootId)?.ops.length === 5, 'the registry keeps five lines too');
    })
);

results.push(
    await runCase('a newer /panel message replaces the older receipt', async () => {
        const fixture = await receiptFixture();
        const newerMessageId = 999_001;
        registerReceipt(fixture.chatId, fixture.rootId, newerMessageId);
        const app = makeApp(fixture.telegram);
        const messageId = await seedMessage(fixture.chatId, ALICE.id, '要排除的', fixture.rootId);
        await request(app, 'PUT', `/api/chats/${fixture.chatId}/messages/${messageId}/exclusion`);
        await waitUntil('the receipt edit', () => editCalls(fixture.telegram).length > 0);
        expect(editCalls(fixture.telegram).at(-1)?.payload.message_id === newerMessageId, 'the newest message is the one edited');
    })
);

results.push(
    await runCase("another conversation's receipt is untouched", async () => {
        const fixture = await receiptFixture();
        const other = await seedConversation(fixture.chatId);
        registerReceipt(fixture.chatId, other.rootId, 999_002);
        const app = makeApp(fixture.telegram);
        const messageId = await seedMessage(fixture.chatId, ALICE.id, '要排除的', fixture.rootId);
        await request(app, 'PUT', `/api/chats/${fixture.chatId}/messages/${messageId}/exclusion`);
        await waitUntil('the receipt edit', () => editCalls(fixture.telegram).length > 0);
        expect(editCalls(fixture.telegram).length === 1, 'one message was edited');
        expect(editCalls(fixture.telegram).every((call) => call.payload.message_id === fixture.messageId), 'the operated conversation only');
    })
);

results.push(
    await runCase('a deleted receipt message is forgotten without failing the write', async () => {
        const chatId = takeChatId();
        await registerChat(chatId);
        const conversation = await seedConversation(chatId);
        registerReceipt(chatId, conversation.rootId, 999_003);
        const refusing = createFakeTelegram({
            refuse: (call) =>
                call.method === 'editMessageText'
                    ? { error_code: 400, description: 'Bad Request: message to edit not found' }
                    : null,
        });
        const app = makeApp(refusing);
        const messageId = await seedMessage(chatId, ALICE.id, '要排除的', conversation.rootId);
        const response = await request(app, 'PUT', `/api/chats/${chatId}/messages/${messageId}/exclusion`);
        expect(response.status === 200, `the write goes through (got ${response.status})`);
        await waitUntil('the refused edit', () => editCalls(refusing).length > 0);
        await waitUntil(
            'the dropped receipt',
            () => state.latestConversationKeyboardMessage(chatId, conversation.rootId) === undefined
        );
        const secondMessage = await seedMessage(chatId, ALICE.id, '又一条', conversation.rootId);
        await request(app, 'PUT', `/api/chats/${chatId}/messages/${secondMessage}/exclusion`);
        expect(editCalls(refusing).length === 1, 'no second edit for a forgotten receipt');
    })
);

results.push(
    await runCase('no registration, an unchanged batch or no Bot API edit nothing', async () => {
        const chatId = takeChatId();
        const telegram = createFakeTelegram();
        await registerChat(chatId);
        const conversation = await seedConversation(chatId);
        const app = makeApp(telegram);
        const unregistered = await seedMessage(chatId, ALICE.id, '无回执', conversation.rootId);
        const noReceipt = await request(app, 'PUT', `/api/chats/${chatId}/messages/${unregistered}/exclusion`);
        expect(noReceipt.status === 200 && editCalls(telegram).length === 0, 'a message with no /panel receipt edits nothing');

        registerReceipt(chatId, conversation.rootId, 999_004);
        // A message that was never excluded: a restore has nothing to change
        const neverExcluded = await seedMessage(chatId, ALICE.id, '一直在上下文里', conversation.rootId);
        const unchanged = await request(app, 'POST', `/api/chats/${chatId}/exclusions`, {
            action: 'restore',
            messageIds: [neverExcluded],
        });
        expect(unchanged.status === 200 && unchanged.body.changed.length === 0, 'nothing to restore');
        expect(editCalls(telegram).length === 0, 'an unchanged batch reports nothing');

        const withoutApi = makeApp(null);
        const messageId = await seedMessage(chatId, ALICE.id, '要排除的', conversation.rootId);
        const response = await request(withoutApi, 'PUT', `/api/chats/${chatId}/messages/${messageId}/exclusion`);
        expect(response.status === 200, `the app works without a Bot API (got ${response.status})`);
        expect(state.latestConversationKeyboardMessage(chatId, conversation.rootId)?.ops.length === 0, 'no line was added');
    })
);

results.push(
    await runCase('a splice reports how many conversations were attached', async () => {
        const fixture = await receiptFixture();
        await reportSpliceReceipt({ chatId: fixture.chatId, rootId: fixture.rootId, attachedRoots: 2, botApi: fixture.telegram.api });
        await waitUntil('the receipt edit', () => editCalls(fixture.telegram).length > 0);
        const payload = editCalls(fixture.telegram).at(-1)?.payload ?? {};
        expect(
            payload.message_id === fixture.messageId && lastEditText(fixture.telegram).includes('· 已拼接 2 段对话（'),
            'the splice line'
        );
        await reportSpliceReceipt({ chatId: fixture.chatId, rootId: fixture.rootId, attachedRoots: 0, botApi: fixture.telegram.api });
        expect(editCalls(fixture.telegram).length === 1, 'nothing attached reports nothing');
    })
);

reportResults(results);
