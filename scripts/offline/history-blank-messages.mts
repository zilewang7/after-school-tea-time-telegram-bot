/**
 * Offline cases for harness #16 phase B (docs/2026-1124-1411-设计-harness-16-
 * 消息类型占位与支持.md §4.2/§4.3/§8.2): a message the archive has no text for
 * is explained instead of printed as a blank line, and a recovered hole is
 * labelled with its Telegram type.
 *
 * - read_history: a message missing from the full-text index (a Telegram
 *   service event, a type luoxu does not index) is read live from `/messages`
 *   and says which source it is; when Telegram does not have it either the read
 *   says both are empty.
 * - renderFullMessage / renderWindow / search_history: a body with nothing to
 *   quote says why ("可能是系统消息或未接入的消息类型") instead of a bare header.
 * - mediumHintOf knows the raw MTProto media types luoxu reports
 *   (`MessageMediaPoll` / `MessageMediaContact` / …).
 * - message-backfill-service stores a recovered non-text message as
 *   `messageKind` (and a service event as `unsupported`) instead of a blank row.
 * - the user-facing surfaces (`/context`, the panel conversation list, the
 *   public share page) show a neutral category and never the stored detail.
 *
 * Run: npx tsx scripts/offline/history-blank-messages.mts
 */
import type { Chat, Update } from 'grammy/types';
import { expect, reportResults, runCase, setupOfflineDb, takeMessageId, type CaseResult } from './harness.mts';
import { startStubServer } from './support/stub-server.mts';
import { createFakeBot, createUnusedApi, quietly } from './fake-telegram.mts';
import type { ContextIndex } from '../../src/reply/context-index.js';
import type {
    HistoryRawMessage,
    HistorySearchOptions,
    HistorySearchOutcome,
    HistoryService,
} from '../../src/services/luoxu-history-service.js';
import type { HistoryToolOptions } from '../../src/reply/tools/history-tool-shared.js';
import type { HistoryState } from '../../src/reply/tools/history-state.js';
import type { ToolHandler } from '../../src/ai/tools/tool-types.js';

const luoxu = await startStubServer();
process.env.LUOXU_PREVIEW_URL = luoxu.url;
process.env.BOT_USER_NAME = 'AfterSchoolTeatimeBot';
process.env.BOT_USER_ID = '7777';
process.env.BOT_NAME = 'K-ON';
delete process.env.ALLOWED_CHAT_IDS;

const db = await setupOfflineDb();
const { Message, saveMessage } = db;
const textKit = await import('../../src/reply/tools/history-text.js');
const { createHistoryState } = await import('../../src/reply/tools/history-state.js');
const { createReadHistoryTool } = await import('../../src/reply/tools/read-history-tool.js');
const { createSearchHistoryTool } = await import('../../src/reply/tools/search-history-tool.js');
const { buildReplyToolContext } = await import('../../src/reply/tools/reply-tool-context.js');
const { backfillMessages } = await import('../../src/services/message-backfill-service.js');
const { loadConversationShareContent } = await import('../../src/panel/share/share-content.js');
const { renderSharePage } = await import('../../src/panel/share/share-page.js');
const { buildConversationListView } = await import('../../src/panel/views/conversation-list.js');
const { registerContextCommand } = await import('../../src/cmd/commands/context.js');
const dbIndex = await import('../../src/db/index.js');

const CHAT_ID = -1002311128579;
const CHANNEL_ID = 2311128579;
const TZ = 'Asia/Shanghai';
const OWNER_ID = 603421700;
const BOT_ID = 6534005994;

// --- luoxu fakes -----------------------------------------------------------

interface Hit {
    readonly channelId: number;
    readonly messageId: number;
    readonly timestamp: number;
    readonly fromId: number | null;
    readonly fromName: string;
    readonly html: string;
    readonly editedAt: number | null;
    readonly deletedAt: number | null;
}

const hitOf = (messageId: number, html: string, overrides: Partial<Hit> = {}): Hit => ({
    channelId: CHANNEL_ID,
    messageId,
    timestamp: 1_760_000_000 + messageId,
    fromId: 505132118,
    fromName: 'K-OFF',
    html,
    editedAt: null,
    deletedAt: null,
    ...overrides,
});

const outcomeOf = (hits: readonly Hit[], hasMore = false): HistorySearchOutcome => ({
    groups: new Map([[CHANNEL_ID, 'Personal Bot Test']]),
    hasMore,
    hits,
});

const rawMessage = (overrides: Partial<HistoryRawMessage> = {}): HistoryRawMessage => ({
    messageId: 5000,
    senderId: 505132118,
    senderName: 'K-OFF',
    senderIsBot: false,
    text: '',
    entities: [],
    replyToId: null,
    media: null,
    forward: null,
    imageCount: null,
    date: 1_760_000_000,
    ...overrides,
});

interface FakeService {
    readonly service: HistoryService;
    readonly searches: HistorySearchOptions[];
    readonly messageCalls: { channelId: number; ids: readonly number[] }[];
}

const fakeService = (options: {
    readonly search?: (request: HistorySearchOptions) => Promise<HistorySearchOutcome>;
    readonly raw?: readonly HistoryRawMessage[];
}): FakeService => {
    const searches: HistorySearchOptions[] = [];
    const messageCalls: { channelId: number; ids: readonly number[] }[] = [];
    const service: HistoryService = {
        search: async (request) => {
            searches.push(request);
            return options.search ? options.search(request) : outcomeOf([]);
        },
        findSenders: async () => [],
        messages: async (channelId, ids) => {
            messageCalls.push({ channelId, ids });
            return options.raw ?? [];
        },
        stats: async () => ({ groups: [] }),
        images: async () => ({ images: [], media: null }),
        imageBytes: async () => null,
    };
    return { service, searches, messageCalls };
};

const contextIndexWith = (messageId: number, number: number): ContextIndex =>
    new Map([[number, { number, messageId, fromBot: false, images: [], imageCount: 0 }]]);

const buildOptions = (
    fake: FakeService,
    overrides: {
        readonly channelId?: number | null;
        readonly state?: HistoryState;
    } = {}
): HistoryToolOptions => ({
    state: overrides.state ?? createHistoryState(),
    context: buildReplyToolContext({
        chat: { id: CHAT_ID, type: 'supergroup', title: '测试群' },
        triggerMessage: { messageId: 9000, userId: OWNER_ID, userName: '黑猫', text: null },
        contextIndex: contextIndexWith(5000, 12),
        signal: new AbortController().signal,
        // The history tools never touch the Bot API; a call on this one fails the file
        api: createUnusedApi(),
    }),
    service: fake.service,
    channelId: overrides.channelId === undefined ? CHANNEL_ID : overrides.channelId,
    ownerUserId: OWNER_ID,
    botUserId: BOT_ID,
    timeZone: TZ,
});

const execute = async (tool: ToolHandler, raw: Readonly<Record<string, unknown>>) =>
    tool.execute(raw, new AbortController().signal);

const linkOf = (messageId: number): string => `https://t.me/c/${CHANNEL_ID}/${messageId}`;

const entryOf = (overrides: Partial<Parameters<ReturnType<typeof createHistoryState>['remember']>[0]> = {}) =>
    createHistoryState().remember({
        channelId: CHANNEL_ID,
        messageId: 5001,
        timestamp: 1_760_000_000,
        fromId: 505132118,
        fromName: 'K-OFF',
        fromIsBot: false,
        indexedHtml: '',
        ...overrides,
    });

const fullOptions = {
    timeZone: TZ,
    folded: false,
    showGroup: false,
};

// --- seeding helpers -------------------------------------------------------

const DATE = new Date('2026-11-24T02:31:19.000Z');

let nextChatId = -1009600000000;
const takeChatId = (): number => (nextChatId -= 1);

// --- history tools ---------------------------------------------------------

const cases: CaseResult[] = [];

cases.push(
    await runCase('a service message missing from the index is read live', async () => {
        const fake = fakeService({
            search: async () => outcomeOf([]),
            raw: [rawMessage({ messageId: 5001 })],
        });
        const read = createReadHistoryTool(buildOptions(fake));
        const result = await execute(read, { ids: [linkOf(5001)] });
        expect(!result.isError, `the read succeeds (got ${result.content})`);
        expect(fake.messageCalls.length === 1, 'Telegram is asked for the missing id');
        expect(fake.messageCalls[0]?.ids.join(',') === '5001', 'exactly the requested id');
        expect(
            result.content.includes('未收录全文索引'),
            `the read says the index had no row (got ${result.content})`
        );
        expect(
            result.content.includes('没有可读正文'),
            `and that the live message has no readable body either (got ${result.content})`
        );
        expect(!result.content.includes('没有找到'), 'the old misleading "not found" wording is gone');
    })
);

cases.push(
    await runCase('the live text stands in when the index has no body', async () => {
        const fake = fakeService({
            search: async () => outcomeOf([]),
            raw: [rawMessage({ messageId: 5002, text: '[service] removed Bot helps bot from the group' })],
        });
        const read = createReadHistoryTool(buildOptions(fake));
        const result = await execute(read, { ids: [linkOf(5002)] });
        expect(!result.isError, 'the read succeeds');
        expect(
            result.content.includes('（未收录全文索引，以下为 Telegram 原文）'),
            `the source is named (got ${result.content})`
        );
        expect(
            result.content.includes('removed Bot helps bot from the group'),
            'the live text is shown'
        );
        expect(
            !result.content.includes('归档里没有可读正文'),
            'a message with a body is not called empty'
        );
    })
);

cases.push(
    await runCase('a message neither the index nor Telegram has says so', async () => {
        const fake = fakeService({ search: async () => outcomeOf([]), raw: [] });
        const read = createReadHistoryTool(buildOptions(fake));
        const result = await execute(read, { ids: [linkOf(5003)] });
        expect(result.isError, 'the read fails');
        expect(
            result.content.includes('归档和 Telegram 都读不到'),
            `it names both sources (got ${result.content})`
        );
        expect(result.content.includes('可能已删除'), 'and the likely cause');
    })
);

cases.push(
    await runCase('a full read with no body at all is not a blank quote', () => {
        const rendered = textKit.renderFullMessage(entryOf(), fullOptions);
        expect(rendered.includes('h1 ·'), 'the header is still printed');
        expect(
            rendered.includes('（归档里没有可读正文：可能是 Telegram 系统消息或未接入的消息类型）'),
            `the empty body is explained (got ${rendered})`
        );
        expect(!rendered.endsWith('\n'), 'no dangling empty body line');
    })
);

cases.push(
    await runCase('a full read with an attachment needs no empty-body note', () => {
        const rendered = textKit.renderFullMessage(
            entryOf({ indexedHtml: '[poll] 你是男娘吗', media: null }),
            fullOptions
        );
        expect(
            !rendered.includes('归档里没有可读正文'),
            `index text counts as a body (got ${rendered})`
        );
        expect(rendered.includes('[poll] 你是男娘吗'), 'the index body is shown');
    })
);

cases.push(
    await runCase('a window row with no body names what it is', () => {
        const entry = entryOf();
        const text = textKit.renderWindow(
            {
                minutes: 10,
                fromTime: '2026-11-24 10:00',
                toTime: '2026-11-24 10:20',
                scopeLabel: '本群',
                total: 1,
                perMessageChars: 300,
            },
            [{ entry, center: true }],
            TZ
        );
        expect(text.includes('（无正文：可能是系统消息）'), `the row says why it is empty (got ${text})`);
    })
);

cases.push(
    await runCase('a window row uses the live text when the index has none', () => {
        const entry = entryOf({ rawText: 'service event', entities: [] });
        const text = textKit.renderWindow(
            {
                minutes: 10,
                fromTime: '2026-11-24 10:00',
                toTime: '2026-11-24 10:20',
                scopeLabel: '本群',
                total: 1,
                perMessageChars: 300,
            },
            [{ entry, center: false }],
            TZ
        );
        expect(text.includes('service event'), `the live body is shown (got ${text})`);
        expect(!text.includes('无正文'), 'and it is not called empty');
    })
);

cases.push(
    await runCase('search_history says a blank row is blank', async () => {
        const fake = fakeService({
            search: async () => outcomeOf([hitOf(5010, ' ')]),
            raw: [rawMessage({ messageId: 5010, text: '' })],
        });
        const search = createSearchHistoryTool(buildOptions(fake));
        const result = await execute(search, { limit: 5 });
        expect(!result.isError, 'the search succeeds');
        expect(result.content.includes('（无正文）'), `the row says it has no body (got ${result.content})`);
    })
);

cases.push(
    await runCase('search_history words a raw media type instead of a blank row', async () => {
        const fake = fakeService({
            search: async () => outcomeOf([hitOf(5011, ' ')]),
            raw: [
                rawMessage({
                    messageId: 5011,
                    text: '',
                    media: { type: 'MessageMediaContact', mime: null, size: null, duration: null, stickerEmoji: null, fileName: null, voice: false },
                }),
            ],
        });
        const search = createSearchHistoryTool(buildOptions(fake));
        const result = await execute(search, { limit: 5 });
        expect(!result.isError, 'the search succeeds');
        expect(
            result.content.includes('[sent a contact card]'),
            `the contact card is named (got ${result.content})`
        );
        expect(!result.content.includes('（无正文）'), 'a typed row is not called an empty one');
    })
);

cases.push(
    await runCase('the raw MTProto media types are worded like the live context', () => {
        const expectations: readonly (readonly [string, string])[] = [
            ['MessageMediaPoll', 'a poll'],
            ['MessageMediaContact', 'a contact card'],
            ['MessageMediaGeo', 'a location'],
            ['MessageMediaGeoLive', 'a live location'],
            ['MessageMediaVenue', 'a venue'],
            ['MessageMediaDice', 'a dice roll'],
            ['MessageMediaGame', 'a game'],
            ['MessageMediaInvoice', 'an invoice'],
            ['MessageMediaStory', 'a story'],
            ['MessageMediaPaidMedia', 'paid media'],
            ['MessageMediaToDo', 'a checklist'],
            ['MessageMediaGiveaway', 'a giveaway'],
            ['MessageMediaGiveawayResults', 'a giveaway'],
            ['MessageMediaUnsupported', 'an unsupported message'],
            ['MessageMediaFutureThing', 'a future thing'],
        ];
        for (const [type, label] of expectations) {
            const media = {
                type,
                mime: null,
                size: null,
                duration: null,
                stickerEmoji: null,
                fileName: null,
                voice: false,
            };
            const hinted = textKit.mediumHintOf(media);
            expect(hinted === label, `${type} reads as "${label}" (got "${hinted}")`);
        }
        expect(textKit.mediumHintOf(null) === '', 'no media still means no hint');
    })
);

// --- missing-row backfill --------------------------------------------------

interface BackfillPayload {
    readonly id: number;
    readonly sender_id: number | null;
    readonly sender_name: string;
    readonly sender_is_bot: boolean;
    readonly text: string;
    readonly entities: unknown[];
    readonly reply_to: number | null;
    readonly date: number | null;
    readonly media: { readonly type: string; readonly mime: string | null } | null;
}

const backfillPayload = (overrides: Partial<BackfillPayload> & Pick<BackfillPayload, 'id'>): BackfillPayload => ({
    sender_id: 505132118,
    sender_name: 'K-OFF',
    sender_is_bot: false,
    text: '',
    entities: [],
    reply_to: null,
    date: 1_794_000_000,
    media: null,
    ...overrides,
});

const backfillChatId = takeChatId();
const backfillMessagesById = new Map<number, BackfillPayload>([
    [6001, backfillPayload({ id: 6001, media: { type: 'MessageMediaPoll', mime: null } })],
    [6002, backfillPayload({ id: 6002 })],
    [6003, backfillPayload({ id: 6003, media: { type: 'MessageMediaContact', mime: null } })],
    [6004, backfillPayload({ id: 6004, text: '一条正常的文字消息' })],
    [6005, backfillPayload({ id: 6005, media: { type: 'photo', mime: null } })],
]);

cases.push(
    await runCase('a recovered non-text message is stored with its kind', async () => {
        luoxu.handle((request, response) => {
            const url = new URL(request.url ?? '/', 'http://127.0.0.1');
            if (!url.pathname.endsWith('/messages')) {
                response.writeHead(404).end();
                return;
            }
            const ids = (url.searchParams.get('ids') ?? '')
                .split(',')
                .filter((part) => part !== '')
                .map(Number);
            const messages = ids.flatMap((id) => {
                const message = backfillMessagesById.get(id);
                return message === undefined ? [] : [message];
            });
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ messages }));
        });
        const stored = await backfillMessages(backfillChatId, [6001, 6002, 6003, 6004, 6005]);
        luoxu.reset();
        expect(stored.length === 5, `all five ids are stored (got ${stored.join(',')})`);

        const rowOf = async (messageId: number) => {
            const row = await Message.findOne({ where: { chatId: backfillChatId, messageId } });
            expect(row !== null, `${messageId} is in the database`);
            return row;
        };
        const poll = await rowOf(6001);
        expect(poll?.messageKind === 'poll', `a poll keeps its kind (got ${poll?.messageKind})`);
        expect(poll?.mediaHint === null, 'no media hint is needed for a typed row');

        const service = await rowOf(6002);
        expect(service?.messageKind === 'unsupported', `a service event gets the fallback kind (got ${service?.messageKind})`);

        const contact = await rowOf(6003);
        expect(contact?.messageKind === 'contact', `a contact card keeps its kind (got ${contact?.messageKind})`);

        const textRow = await rowOf(6004);
        expect(textRow?.messageKind === null, 'a recovered text message gets no kind');

        const photo = await rowOf(6005);
        expect(photo?.messageKind === null, 'an ordinary photo gets no kind');
        expect(
            photo?.mediaHint?.includes('recovered from history') === true,
            `an ordinary media keeps the "file is gone" hint (got ${photo?.mediaHint})`
        );
    })
);

// --- user-facing surfaces --------------------------------------------------

cases.push(
    await runCase('the public share page names a neutral category, never the detail', async () => {
        const shareChatId = takeChatId();
        const rootId = takeMessageId();
        await saveMessage({
            chatId: shareChatId,
            messageId: rootId,
            userId: 505132118,
            userName: 'K-OFF',
            date: DATE,
            message: '',
            messageKind: 'service',
            messageDetail: 'removed Bot helps bot from the group; phone +8613800000000',
        });
        const content = await loadConversationShareContent(shareChatId, rootId);
        expect(content !== null, 'the conversation share is readable');
        if (content === null) return;
        const bubble = content.bubbles[0];
        expect(bubble?.kind === 'user' && bubble.messageKind === 'service', 'the kind reaches the bubble');
        const page = renderSharePage({
            token: 'A'.repeat(24),
            baseUrl: 'https://miniapp.test',
            content,
            preview: null,
            miniAppLink: null,
        });
        expect(page.includes('（群系统事件）'), `the page shows the category (got ${page.slice(0, 400)})`);
        expect(!page.includes('removed Bot helps bot'), 'and not the stored detail');
        expect(!page.includes('8613800000000'), 'no phone number leaks onto the public page');
    })
);

cases.push(
    await runCase('the panel conversation list shows a neutral category', async () => {
        const listChatId = takeChatId();
        const rootId = takeMessageId();
        await saveMessage({
            chatId: listChatId,
            messageId: rootId,
            userId: 505132118,
            userName: 'K-OFF',
            date: new Date(),
            message: '',
            messageKind: 'service',
            messageDetail: 'removed Bot helps bot from the group',
        });
        const replyId = takeMessageId();
        const response = await dbIndex.createBotResponse(listChatId, replyId, rootId, {
            model: 'offline-model',
            hasImage: false,
        });
        response.setVersions([
            {
                versionId: 1,
                createdAt: new Date().toISOString(),
                messageIds: [replyId],
                currentMessageId: replyId,
                text: '好的',
                wasStoppedByUser: false,
            },
        ]);
        response.currentVersionIndex = 0;
        await response.save();

        const view = await buildConversationListView({
            chatId: listChatId,
            access: 'member',
            limit: 10,
            before: null,
            now: new Date(),
        });
        const item = view.conversations.find((conversation) => conversation.rootId === rootId);
        expect(item !== undefined, 'the conversation is listed');
        if (item === undefined) return;
        expect(item.root.kind === 'user' && item.root.redacted === false, 'a member sees the user root');
        if (item.root.kind !== 'user' || item.root.redacted !== false) return;
        expect(
            item.root.excerpt === '[群系统事件]',
            `the root excerpt is the neutral category (got "${item.root.excerpt}")`
        );
        expect(!item.root.excerpt.includes('removed'), 'the detail stays out of the list');
    })
);

/**
 * A `/context` reply update: the command answers the message it replies to.
 * Built as a whole `Update` so the fixture is type-checked like a real one.
 */
const contextCommandUpdate = (input: {
    readonly chatId: number;
    readonly messageId: number;
    readonly userId: number;
    readonly replyToId: number;
}): Update => {
    const chat: Chat.SupergroupChat = { id: input.chatId, type: 'supergroup', title: '测试群' };
    const date = Math.floor(Date.now() / 1000);
    return {
        update_id: input.messageId,
        message: {
            message_id: input.messageId,
            date,
            chat,
            from: { id: input.userId, is_bot: false, first_name: 'owner' },
            text: '/context',
            entities: [{ type: 'bot_command', offset: 0, length: '/context'.length }],
            reply_to_message: {
                message_id: input.replyToId,
                date,
                chat,
                from: { id: 505132118, is_bot: false, first_name: 'K-OFF' },
                text: '被回复的消息',
                // A replied-to message never nests its own reply
                reply_to_message: undefined,
            },
        },
    };
};

cases.push(
    await runCase('/context names a neutral category for a non-text message', async () => {
        const contextChatId = takeChatId();
        const rootId = takeMessageId();
        await saveMessage({
            chatId: contextChatId,
            messageId: rootId,
            userId: 505132118,
            userName: 'K-OFF',
            date: DATE,
            message: '',
            messageKind: 'service',
            messageDetail: 'removed Bot helps bot from the group',
        });

        const { bot, telegram } = createFakeBot();
        registerContextCommand(bot);
        const commandId = takeMessageId();
        const update = contextCommandUpdate({
            chatId: contextChatId,
            messageId: commandId,
            userId: OWNER_ID,
            replyToId: rootId,
        });
        await quietly(() => bot.handleUpdate(update));
        const payload = telegram.callsOf('sendMessage').at(-1)?.payload ?? {};
        const text = typeof payload.text === 'string' ? payload.text : '';
        expect(text !== '', 'the command answers');
        expect(text.includes('[群系统事件]'), `the category is shown (got ${text})`);
        expect(!text.includes('removed Bot helps bot'), 'the detail is not');
    })
);

await luoxu.close();
await reportResults(cases);
