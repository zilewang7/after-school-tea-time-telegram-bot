/**
 * Offline cases for the control panel's chat registry: the one-shot backfill
 * from stored messages, the debounced touches autoSave feeds, the private-chat
 * row the panel creates, and the membership lookups.
 *
 * Run: npx tsx scripts/offline/panel-registry.mts
 */
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';
import type { Message as TgMessage } from 'grammy/types';

// The bot's own id, so seeded rows can be marked fromBotSelf
const BOT_USER_ID = 7000;
process.env.BOT_USER_ID = String(BOT_USER_ID);

const db = await setupOfflineDb();
const { sequelize } = await import('../../src/db/config.js');
const { QueryTypes } = await import('@sequelize/core');
const { createBotResponse, TelegramUser } = await import('../../src/db/index.js');
const { ChatRecord } = await import('../../src/db/chatDTO.js');
const { ChatMemberSeen } = await import('../../src/db/chatMemberSeenDTO.js');
const { backfillPanelRegistry } = await import('../../src/db/schema-migrations.js');
const registry = await import('../../src/db/queries/panel-registry.js');
const { fillMissingChatNames } = await import('../../src/panel/chat-names.js');

const PRIVATE_CHAT_ID = 5001;
const SMALL_GROUP_ID = -4001;
const SUPERGROUP_ID = -1001234567890;
const BOT_ONLY_SUPERGROUP_ID = -1009876543210;

const HUMAN_ID = 6001;
const OTHER_HUMAN_ID = 6003;
const ROSTER_BOT_ID = 6002;

const DAY_MS = 24 * 60 * 60 * 1000;
const hoursAgo = (hours: number): Date => new Date(Date.now() - hours * 60 * 60 * 1000);

let nextMessageId = 100;
const seed = async (chatId: number, userId: number, date: Date): Promise<void> => {
    nextMessageId += 1;
    await db.saveMessage({ chatId, messageId: nextMessageId, userId, date, userName: `u${userId}`, message: 'hi' });
};

/** Wait until a fire-and-forget write has landed (or time out) */
const waitFor = async (description: string, condition: () => Promise<boolean>): Promise<void> => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
        if (await condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`timed out waiting for ${description}`);
};

/** Give a dropped write the chance to land, so its absence means something */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150));

/** Run `body` with Date.now shifted forward, to step past the 60s windows */
const withClockAhead = async (offsetMs: number, body: () => void): Promise<void> => {
    const realNow = Date.now;
    Date.now = () => realNow.call(Date) + offsetMs;
    try {
        body();
    } finally {
        Date.now = realNow;
    }
};

const memberRow = (chatId: number, userId: number) => ChatMemberSeen.findOne({ where: { chatId, userId } });

const forgetBackfill = (): Promise<unknown> =>
    sequelize.query("DELETE FROM schema_migrations WHERE name = '20261106_miniapp_panel_backfill'");

const groupMessage = (
    chat: TgMessage['chat'],
    from: TgMessage['from'],
    extra: Partial<TgMessage> = {}
): TgMessage => ({ message_id: 1, date: 0, chat, from, ...extra });

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'the backfill seeds chats and human group speakers from stored rows, once',
        body: async () => {
            const marker = await sequelize.query<{ name: string }>(
                "SELECT name FROM schema_migrations WHERE name = '20261106_miniapp_panel_backfill'",
                { type: QueryTypes.SELECT }
            );
            expect(marker.length === 1, 'startup already recorded the backfill on the empty database');

            await TelegramUser.create({ userId: ROSTER_BOT_ID, firstName: 'RssBot', isBot: true, updatedAt: new Date() });
            await seed(PRIVATE_CHAT_ID, PRIVATE_CHAT_ID, hoursAgo(5));
            await seed(SMALL_GROUP_ID, HUMAN_ID, hoursAgo(48));
            await seed(SMALL_GROUP_ID, HUMAN_ID, hoursAgo(3));
            await seed(SMALL_GROUP_ID, HUMAN_ID, hoursAgo(10));
            // None of these is a person who can be recognized as a member
            for (const userId of [0, 777000, 1087968824, ROSTER_BOT_ID, BOT_USER_ID]) {
                await seed(SMALL_GROUP_ID, userId, hoursAgo(1));
            }
            await seed(SUPERGROUP_ID, HUMAN_ID, hoursAgo(2));
            await seed(SUPERGROUP_ID, OTHER_HUMAN_ID, hoursAgo(4));
            await createBotResponse(BOT_ONLY_SUPERGROUP_ID, 900, 899, { model: 'offline-model', hasImage: false });

            await backfillPanelRegistry();
            expect((await ChatRecord.count()) === 0, 'a recorded backfill does not run again');

            await forgetBackfill();
            await backfillPanelRegistry();

            const chats = await registry.listChats();
            const typeOf = (chatId: number) => chats.find((chat) => chat.chatId === chatId)?.type;
            expect(chats.length === 4, `four chats are registered (got ${chats.length})`);
            expect(typeOf(PRIVATE_CHAT_ID) === 'private', 'a positive id is a private chat');
            expect(typeOf(SMALL_GROUP_ID) === 'group', 'a short negative id is a basic group');
            expect(typeOf(SUPERGROUP_ID) === 'supergroup', 'a -100 id is a supergroup');
            expect(typeOf(BOT_ONLY_SUPERGROUP_ID) === 'supergroup', 'a chat with only bot rows is found too');
            expect(chats.every((chat) => chat.title === null && chat.username === null), 'titles wait for the next message');

            const smallGroup = await registry.findChat(SMALL_GROUP_ID);
            expect(
                smallGroup !== null &&
                    Math.abs(smallGroup.firstSeenAt.getTime() - hoursAgo(48).getTime()) < 60_000 &&
                    Math.abs(smallGroup.lastSeenAt.getTime() - hoursAgo(1).getTime()) < 60_000,
                `first and last seen span every stored row (got ${smallGroup?.firstSeenAt.toISOString()} – ${smallGroup?.lastSeenAt.toISOString()})`
            );

            const members = await ChatMemberSeen.findAll({ order: [['chatId', 'ASC'], ['userId', 'ASC']] });
            const memberKeys = members.map((row) => `${row.chatId}:${row.userId}`);
            expect(
                JSON.stringify(memberKeys) ===
                    JSON.stringify([`${SUPERGROUP_ID}:${HUMAN_ID}`, `${SUPERGROUP_ID}:${OTHER_HUMAN_ID}`, `${SMALL_GROUP_ID}:${HUMAN_ID}`]),
                `only human group speakers are seeded (got ${JSON.stringify(memberKeys)})`
            );
            const human = await memberRow(SMALL_GROUP_ID, HUMAN_ID);
            expect(human?.messageCount === 3, `the message count is the stored rows (got ${human?.messageCount})`);

            // Statements are idempotent even if the marker goes missing
            await forgetBackfill();
            await backfillPanelRegistry();
            expect((await ChatRecord.count()) === 4, 'a second run adds no chats');
            expect((await ChatMemberSeen.count()) === 3, 'a second run adds no members');
            expect((await memberRow(SMALL_GROUP_ID, HUMAN_ID))?.messageCount === 3, 'and does not recount');
        },
    },
    {
        name: 'a chat touch writes at once, then not again within 60s',
        body: async () => {
            const chatId = -4002;
            registry.touchChatDebounced({ id: chatId, type: 'group', title: '甲群' });
            await waitFor('the first touch', async () => (await registry.findChat(chatId)) !== null);
            registry.touchChatDebounced({ id: chatId, type: 'group', title: '乙群' });
            await settle();
            expect((await registry.findChat(chatId))?.title === '甲群', 'the second touch within 60s is dropped');

            await withClockAhead(61_000, () =>
                registry.touchChatDebounced({ id: chatId, type: 'supergroup', title: '乙群', username: 'yi_group' })
            );
            await waitFor('the touch after the window', async () => (await registry.findChat(chatId))?.title === '乙群');
            const row = await registry.findChat(chatId);
            expect(row?.type === 'supergroup' && row.username === 'yi_group', 'type and username follow the latest chat');
        },
    },
    {
        name: 'an immediate upsert overwrites the username (NULL too) and keeps a known title',
        body: async () => {
            const chatId = -4003;
            await registry.upsertChatNow({ id: chatId, type: 'supergroup', title: '丙群', username: 'bing' });
            const first = await registry.findChat(chatId);
            await registry.upsertChatNow({ id: chatId, type: 'supergroup' });
            const second = await registry.findChat(chatId);
            expect(second?.username === null, 'a chat without a username clears it');
            expect(second?.title === '丙群', 'a missing title never wipes a known one');
            expect(
                first !== null && second !== null && second.firstSeenAt.getTime() === first.firstSeenAt.getTime(),
                'firstSeenAt is only set on insert'
            );
            await registry.upsertChatNow({ id: 5002, type: 'private', first_name: 'Bob', username: 'bob' });
            expect((await registry.findChat(5002))?.title === 'Bob', 'a private chat is titled with the first name');
        },
    },
    {
        name: 'a member touch counts every message but writes at most once per 60s',
        body: async () => {
            const chatId = -4004;
            registry.touchChatMemberDebounced(chatId, HUMAN_ID);
            await waitFor('the first member write', async () => (await memberRow(chatId, HUMAN_ID)) !== null);
            const first = await memberRow(chatId, HUMAN_ID);
            registry.touchChatMemberDebounced(chatId, HUMAN_ID);
            registry.touchChatMemberDebounced(chatId, HUMAN_ID);
            await settle();
            const unchanged = await memberRow(chatId, HUMAN_ID);
            expect(unchanged?.messageCount === 1, `calls within 60s do not write (count ${unchanged?.messageCount})`);
            expect(
                unchanged?.lastSeenAt.getTime() === first?.lastSeenAt.getTime(),
                'lastSeenAt does not move within the window'
            );

            await withClockAhead(61_000, () => registry.touchChatMemberDebounced(chatId, HUMAN_ID));
            await waitFor('the write after the window', async () => (await memberRow(chatId, HUMAN_ID))?.messageCount === 4);
            const after = await memberRow(chatId, HUMAN_ID);
            expect(
                after !== null && first !== null && after.lastSeenAt.getTime() > first.lastSeenAt.getTime(),
                'the next write carries the held-back count and moves lastSeenAt'
            );

            registry.touchChatMemberDebounced(4005, HUMAN_ID);
            await settle();
            expect((await memberRow(4005, HUMAN_ID)) === null, 'private chats never get member rows');
        },
    },
    {
        name: 'the autoSave hook registers every chat but only human group senders',
        body: async () => {
            const groupChat = { id: -4006, type: 'supergroup' as const, title: '丁群', is_forum: undefined };
            const human = { id: 6101, is_bot: false, first_name: 'Human' };
            registry.harvestChatRegistry(groupMessage(groupChat, human));
            registry.harvestChatRegistry(groupMessage(groupChat, { id: 6102, is_bot: true, first_name: 'Bot' }));
            registry.harvestChatRegistry(groupMessage(groupChat, { id: 777000, is_bot: false, first_name: 'Telegram' }));
            registry.harvestChatRegistry(
                groupMessage(groupChat, { id: 1087968824, is_bot: true, first_name: 'Group' }, {
                    sender_chat: { id: -4006, type: 'supergroup', title: '丁群' },
                })
            );
            registry.harvestChatRegistry(
                groupMessage(groupChat, { id: 6103, is_bot: false, first_name: 'Poster' }, {
                    sender_chat: { id: -1005555, type: 'channel', title: '频道' },
                })
            );
            registry.harvestChatRegistry(
                groupMessage({ id: 6104, type: 'private', first_name: 'Carol' }, { id: 6104, is_bot: false, first_name: 'Carol' })
            );
            registry.harvestChatRegistry(undefined);

            await waitFor('the group member', async () => (await memberRow(-4006, 6101)) !== null);
            await waitFor('the private chat', async () => (await registry.findChat(6104)) !== null);
            await settle();
            const members = await ChatMemberSeen.findAll({ where: { chatId: -4006 } });
            expect(
                members.length === 1 && members[0]?.userId === 6101,
                `bots, the service account and sender_chat messages are skipped (got ${members.map((row) => row.userId).join(',')})`
            );
            expect((await registry.findChat(-4006))?.title === '丁群', 'the group is registered with its title');
            const privateChat = await registry.findChat(6104);
            expect(
                privateChat?.type === 'private' && privateChat.title === 'Carol',
                'a private chat is registered with the sender first name'
            );
            expect((await ChatMemberSeen.count({ where: { chatId: 6104 } })) === 0, 'no member row for it');
        },
    },
    {
        name: 'the panel creates a missing private chat row and names a backfilled one',
        body: async () => {
            await registry.ensurePrivateChatRow({ id: 8001, first_name: 'Dave', username: 'dave' });
            const created = await registry.findChat(8001);
            expect(
                created?.type === 'private' && created.title === 'Dave' && created.username === 'dave',
                'a missing row is created from initData'
            );

            // PRIVATE_CHAT_ID was seeded by the backfill without a title
            await registry.ensurePrivateChatRow({ id: PRIVATE_CHAT_ID, first_name: 'Erin' });
            const backfilled = await registry.findChat(PRIVATE_CHAT_ID);
            expect(backfilled?.title === 'Erin', 'a backfilled row gets the first name');

            await registry.ensurePrivateChatRow({ id: 5002, first_name: 'Robert' });
            expect((await registry.findChat(5002))?.title === 'Bob', 'a named row keeps its data');

            await registry.ensurePrivateChatRow({ id: 8002, first_name: 'Grace', last_name: 'Hopper' });
            expect((await registry.findChat(8002))?.title === 'Grace Hopper', 'initData with a last name gives the full name');
        },
    },
    {
        name: 'a private chat is titled with the full name, a group with its title',
        body: async () => {
            registry.harvestChatRegistry(
                groupMessage(
                    { id: 8101, type: 'private', first_name: 'Heidi', last_name: 'Klum', username: 'heidi_k' },
                    { id: 8101, is_bot: false, first_name: 'Heidi', last_name: 'Klum' }
                )
            );
            await waitFor('the private chat row', async () => (await registry.findChat(8101)) !== null);
            const privateChat = await registry.findChat(8101);
            expect(
                privateChat?.title === 'Heidi Klum' && privateChat.username === 'heidi_k',
                `first and last name, and the username (got ${privateChat?.title} @${privateChat?.username})`
            );
            await registry.upsertChatNow({ id: 8102, type: 'private', first_name: 'Ivan' });
            expect((await registry.findChat(8102))?.title === 'Ivan', 'no last name: just the first name');
        },
    },
    {
        name: 'untitled chats are named once: getChat first, the roster for a private chat, failures retried next start',
        body: async () => {
            const NAMED_BY_LOOKUP = -1005550000001;
            const ROSTER_PRIVATE = 8201;
            const SILENT_PRIVATE = 8202;
            const BROKEN_GROUP = -4555;
            const ALREADY_NAMED = -1005550000002;
            const insertUntitled = (chatId: number, type: string): Promise<unknown> =>
                sequelize.query(
                    `INSERT INTO chats (chatId, type, title, username, firstSeenAt, lastSeenAt)
                     VALUES (:chatId, :type, NULL, NULL, :now, :now)`,
                    { replacements: { chatId, type, now: new Date() } }
                );
            // Earlier cases left untitled rows of their own; name those out of the way first
            for (const leftover of await registry.listUntitledChats()) {
                await registry.fillChatName({ id: leftover.chatId, type: leftover.type, title: 'earlier', first_name: 'earlier' });
            }
            await insertUntitled(NAMED_BY_LOOKUP, 'group');
            await insertUntitled(ROSTER_PRIVATE, 'private');
            await insertUntitled(SILENT_PRIVATE, 'private');
            await insertUntitled(BROKEN_GROUP, 'group');
            await registry.upsertChatNow({ id: ALREADY_NAMED, type: 'supergroup', title: '已有名字' });
            await TelegramUser.create({
                userId: ROSTER_PRIVATE,
                firstName: 'Judy',
                lastName: 'Chen',
                username: 'judy_c',
                isBot: false,
                updatedAt: new Date(),
            });

            const looked: number[] = [];
            const lookup = async (chatId: number, signal: AbortSignal) => {
                looked.push(chatId);
                if (chatId === NAMED_BY_LOOKUP) {
                    // A group upgraded to a supergroup since the backfill guessed its type
                    return { type: 'supergroup', title: '查得到的群', username: 'found_group' };
                }
                if (chatId === ROSTER_PRIVATE) {
                    // Never answers: the deadline aborts it and the roster takes over
                    return new Promise<never>((_resolve, reject) => {
                        signal.addEventListener('abort', () => reject(new Error('aborted')));
                    });
                }
                throw new Error('Bad Request: chat not found');
            };
            await fillMissingChatNames(lookup, { gapMs: 0, timeoutMs: 100 });

            const found = await registry.findChat(NAMED_BY_LOOKUP);
            expect(
                found?.title === '查得到的群' && found.username === 'found_group' && found.type === 'supergroup',
                `getChat names the group and corrects its type (got ${JSON.stringify(found)})`
            );
            const fromRoster = await registry.findChat(ROSTER_PRIVATE);
            expect(
                fromRoster?.title === 'Judy Chen' && fromRoster.username === 'judy_c',
                `a timed-out private lookup falls back to the roster (got ${fromRoster?.title} @${fromRoster?.username})`
            );
            expect((await registry.findChat(SILENT_PRIVATE))?.title === null, 'a private chat nobody knows stays untitled');
            expect((await registry.findChat(BROKEN_GROUP))?.title === null, 'a group getChat refuses stays untitled');
            expect(!looked.includes(ALREADY_NAMED), 'a named chat is never looked up');

            looked.length = 0;
            await fillMissingChatNames(lookup, { gapMs: 0, timeoutMs: 100 });
            expect(
                JSON.stringify([...looked].sort((left, right) => left - right)) ===
                    JSON.stringify([BROKEN_GROUP, SILENT_PRIVATE]),
                `the next start only retries the ones still untitled (got ${JSON.stringify(looked)})`
            );

            // A harvested message wins over a stale lookup: only untitled rows are filled
            await registry.fillChatName({ id: NAMED_BY_LOOKUP, type: 'supergroup', title: '旧名字' });
            expect((await registry.findChat(NAMED_BY_LOOKUP))?.title === '查得到的群', 'a titled row is never overwritten');
        },
    },
    {
        name: 'membership lookups: groups spoken in and the 30-day fallback',
        body: async () => {
            const spokenIn = await registry.listGroupChatIdsSpokenIn(HUMAN_ID);
            expect(
                spokenIn.includes(SMALL_GROUP_ID) && spokenIn.includes(SUPERGROUP_ID) && spokenIn.includes(-4004),
                `every group the user spoke in is listed (got ${JSON.stringify(spokenIn)})`
            );
            expect(!spokenIn.some((chatId) => chatId > 0), 'no private chat is listed');
            expect(spokenIn[0] === -4004, 'most recent first');
            expect((await registry.listGroupChatIdsSpokenIn(424242)).length === 0, 'a stranger has none');

            await ChatMemberSeen.create({
                chatId: -4007,
                userId: HUMAN_ID,
                firstSeenAt: new Date(Date.now() - 50 * DAY_MS),
                lastSeenAt: new Date(Date.now() - 40 * DAY_MS),
                messageCount: 2,
            });
            expect(await registry.spokeWithinDays(SMALL_GROUP_ID, HUMAN_ID, 30), 'a recent speaker passes');
            expect(!(await registry.spokeWithinDays(-4007, HUMAN_ID, 30)), 'a speaker silent for 40 days does not');
            expect(await registry.spokeWithinDays(-4007, HUMAN_ID, 60), 'but passes a 60-day window');
            expect(!(await registry.spokeWithinDays(SMALL_GROUP_ID, 424242, 30)), 'a stranger never passes');
        },
    },
    {
        name: 'a panel user lands in the roster once per 60s',
        body: async () => {
            registry.touchPanelUserDebounced({ id: 9001, first_name: 'Frank', last_name: 'Li', username: 'Frank_L' });
            await waitFor('the roster row', async () => (await TelegramUser.findByPk(9001)) !== null);
            const row = await TelegramUser.findByPk(9001);
            expect(
                row?.firstName === 'Frank' && row.lastName === 'Li' && row.username === 'frank_l' && row.isBot === false,
                'name, handle (lowercased like the roster) and isBot=false are stored'
            );
            registry.touchPanelUserDebounced({ id: 9001, first_name: 'Franky' });
            await settle();
            expect((await TelegramUser.findByPk(9001))?.firstName === 'Frank', 'a second call within 60s does not write');
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
reportResults(results);
