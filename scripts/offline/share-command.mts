/**
 * Offline cases for the `/share` and `/shareone` bot commands (design
 * docs/2026-1110-1905-设计-Telegram-share命令把被回复的会话设为分享.md §6.1):
 * `/share` shares the whole conversation the replied message belongs to,
 * `/shareone` shares the replied bot reply (its current version) alone.
 *
 * Every case drives the real grammY handler through the fake Telegram API (the
 * bot-notice.mts style), so the assertions are the sendMessage payload and the
 * share_links row it wrote.
 *
 * Run: npx tsx scripts/offline/share-command.mts
 */
import type { Bot } from 'grammy';
import type { Update, User } from 'grammy/types';
import { expect, reportResults, runCase, setupOfflineDb, takeMessageId, type CaseResult } from './harness.mts';
import { createFakeBot, groupChat, messageUpdate, quietly, userOf, type FakeTelegram } from './fake-telegram.mts';

// Read when a command runs (not at import time): the command module, the share
// service and autoSave all look these up per call. Set before the first src
// import; the harness already pointed DB_PATH at a scratch database.
process.env.WEBAPP_PUBLIC_URL = 'https://miniapp.test';
process.env.BOT_USER_NAME = 'AfterSchoolTeatimeBot';
process.env.BOT_USER_ID = '7777';
process.env.BOT_NAME = 'K-ON';
process.env.WIDGET_RENDER_URL = '';
delete process.env.ALLOWED_CHAT_IDS;
delete process.env.SHARE_COMMAND;
delete process.env.SHARE_ENABLED;

const db = await setupOfflineDb();
const { Message } = db;
const dbIndex = await import('../../src/db/index.js');
const { sequelize } = await import('../../src/db/config.js');
const { QueryTypes } = await import('@sequelize/core');
const { isJsonRecord } = await import('../../src/panel/json.js');
const { findShareRowByToken } = await import('../../src/panel/share/share-store.js');
const { setPanelRunning } = await import('../../src/panel/panel-state.js');
const { autoSave } = await import('../../src/db/autoSave.js');
const shareCommand = await import('../../src/cmd/commands/share.js');
const { registerShareCommand, createShareCommandLimiter, USAGE_TEXT, OFF_TEXT, PERSONAL_ACCOUNT_TEXT } =
    shareCommand;

type ResponseVersion = import('../../src/db/index.js').ResponseVersion;

const BOT_USER_ID = 7777;
const BOT_USER: User = {
    id: BOT_USER_ID,
    is_bot: true,
    first_name: 'K-ON',
    username: 'AfterSchoolTeatimeBot',
};
const ANONYMOUS_ADMIN: User = { id: 1087968824, is_bot: true, first_name: 'GroupAnonymousBot' };
const OTHER_BOT: User = { id: 9001, is_bot: true, first_name: 'OtherBot' };
const SHARE_URL_PATTERN = /https:\/\/miniapp\.test\/s\/([A-Za-z0-9_-]{24})/;

/** A fresh chat per case, so no case can see another case's share rows */
let nextChatId = -1009500000000;
const takeChatId = (): number => (nextChatId -= 1);

/**
 * A fresh sender per case: the module-level limiter is per user and lives for
 * the whole file, so shared ids would make later cases look rate limited.
 */
let nextUserId = 61_000;
const takeUserId = (): number => (nextUserId += 1);

const saveUserMessage = async (
    chatId: number,
    messageId: number,
    userId: number,
    text: string,
    replyToId?: number
): Promise<void> => {
    await db.saveMessage({
        chatId,
        messageId,
        userId,
        date: new Date(),
        userName: `user-${userId}`,
        message: text,
        ...(replyToId === undefined ? {} : { replyToId }),
    });
};

/** A message of the bot itself: another command's notice (not a bot_response) */
const saveBotMessage = async (
    chatId: number,
    messageId: number,
    replyToId: number | null,
    text: string
): Promise<void> => {
    await db.saveMessage({
        chatId,
        messageId,
        userId: BOT_USER_ID,
        date: new Date(),
        userName: 'K-ON',
        message: text,
        ...(replyToId === null ? {} : { replyToId }),
    });
};

const versionOf = (
    versionId: number,
    messageIds: number[],
    overrides: Partial<ResponseVersion> = {}
): ResponseVersion => ({
    versionId,
    createdAt: new Date(Date.now() - (10 - versionId) * 60_000).toISOString(),
    messageIds,
    currentMessageId: messageIds[messageIds.length - 1] ?? 0,
    text: `第 ${versionId} 版正文`,
    wasStoppedByUser: false,
    ...overrides,
});

const saveBotReply = async (input: {
    chatId: number;
    firstMessageId: number;
    userMessageId: number;
    versions: ResponseVersion[];
    currentVersionIndex?: number;
}): Promise<void> => {
    const response = await dbIndex.createBotResponse(input.chatId, input.firstMessageId, input.userMessageId, {
        model: 'offline-model',
        hasImage: false,
    });
    response.setVersions(input.versions);
    response.currentVersionIndex = input.currentVersionIndex ?? 0;
    await response.save();
};

interface ConversationFixture {
    /** The chain root the conversation share must name */
    rootId: number;
    /** The user message the bot answered (the conversation's identity) */
    triggerId: number;
    /** The bot reply's first segment, i.e. the bot_responses primary key */
    firstMessageId: number;
    /** A non-first segment of the reply, to prove any segment can be replied to */
    continuationId: number;
}

/**
 * root user message → the user message that triggered a reply → the bot reply
 * (only its first segment is a telegram_messages row, the continuation id lives
 * in versions[].messageIds, exactly like production multi-part replies).
 */
const seedConversation = async (chatId: number, rootText = '会话的根消息'): Promise<ConversationFixture> => {
    const rootId = takeMessageId();
    await saveUserMessage(chatId, rootId, 8001, rootText);
    const triggerId = takeMessageId();
    await saveUserMessage(chatId, triggerId, 8002, '触发这条回复的用户消息', rootId);
    const firstMessageId = takeMessageId();
    const continuationId = takeMessageId();
    await saveBotMessage(chatId, firstMessageId, triggerId, '这是 bot 的回复正文');
    await saveBotReply({
        chatId,
        firstMessageId,
        userMessageId: triggerId,
        versions: [versionOf(1, [firstMessageId, continuationId])],
    });
    return { rootId, triggerId, firstMessageId, continuationId };
};

/** Like seedConversation, but the current version is a retried one (version 2) */
const seedRetriedConversation = async (chatId: number): Promise<ConversationFixture & { currentVersionId: number }> => {
    const rootId = takeMessageId();
    await saveUserMessage(chatId, rootId, 8001, '会话的根消息');
    const triggerId = takeMessageId();
    await saveUserMessage(chatId, triggerId, 8002, '触发这条回复的用户消息', rootId);
    const firstMessageId = takeMessageId();
    const continuationId = takeMessageId();
    await saveBotMessage(chatId, firstMessageId, triggerId, '这是 bot 的当前版本回复');
    await saveBotReply({
        chatId,
        firstMessageId,
        userMessageId: triggerId,
        versions: [versionOf(1, [firstMessageId]), versionOf(2, [firstMessageId, continuationId])],
        currentVersionIndex: 1,
    });
    return { rootId, triggerId, firstMessageId, continuationId, currentVersionId: 2 };
};

interface ReplyUpdateInput {
    chatId: number;
    messageId: number;
    userId: number;
    text: string;
    replyToMessageId: number;
    /** Author of the replied-to message; the bot by default */
    replyFrom?: User;
    /** Replace the update's sender (anonymous admin, another bot) */
    sender?: User;
    /** Remove the sender entirely (a channel-identity message) */
    dropSender?: boolean;
}

/** A text update replying to another message (messageUpdate has no reply field) */
const replyUpdate = (input: ReplyUpdateInput): Update => {
    const update = messageUpdate({
        chatId: input.chatId,
        messageId: input.messageId,
        userId: input.userId,
        text: input.text,
    });
    const message = update.message;
    if (message === undefined) return update;
    message.reply_to_message = {
        message_id: input.replyToMessageId,
        date: Math.floor(Date.now() / 1000),
        chat: groupChat(input.chatId),
        from: input.replyFrom ?? BOT_USER,
        text: '被回复的消息',
    };
    if (input.dropSender === true) {
        delete message.from;
    } else if (input.sender !== undefined) {
        message.from = input.sender;
    }
    return update;
};

/** A bot with the share commands registered and the panel marked as running */
const commandBot = (): { bot: Bot; telegram: FakeTelegram } => {
    setPanelRunning(true);
    const { bot, telegram } = createFakeBot();
    registerShareCommand(bot);
    return { bot, telegram };
};

const drive = async (bot: Bot, update: Update): Promise<void> => {
    await quietly(() => bot.handleUpdate(update));
};

const lastReplyText = (telegram: FakeTelegram): string => {
    const text = telegram.callsOf('sendMessage').at(-1)?.payload.text;
    return typeof text === 'string' ? text : '';
};

/** The token of the share URL in a reply, asserting there is one */
const expectShareUrl = (text: string, label: string): string => {
    const match = SHARE_URL_PATTERN.exec(text);
    expect(match !== null, `${label}: the reply carries an absolute share URL (got ${JSON.stringify(text)})`);
    return match?.[1] ?? '';
};

/** All share_links rows of one chat, active or not */
const countShareRows = async (chatId: number): Promise<number> => {
    const rows: unknown[] = await sequelize.query('SELECT COUNT(*) AS total FROM share_links WHERE chatId = :chatId', {
        replacements: { chatId },
        type: QueryTypes.SELECT,
    });
    const row = rows[0];
    if (!isJsonRecord(row)) return -1;
    const total = Number(row.total);
    return Number.isFinite(total) ? total : -1;
};

/** The stored row behind a reply's URL, with the fields both commands must set */
const expectShareRow = async (token: string, label: string): Promise<{ kind: string; rootId: number | null; firstMessageId: number | null; versionId: number | null; createdBy: number; source: string }> => {
    const row = await findShareRowByToken(token);
    expect(row !== null, `${label}: the token names a stored share row`);
    if (row === null) throw new Error(`${label}: share row ${token} not found`);
    return row;
};

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'a bare /share and /shareone without a reply show the usage text',
        body: async () => {
            const { bot, telegram } = commandBot();
            const chatId = takeChatId();
            const sender = takeUserId();

            await drive(bot, messageUpdate({ chatId, messageId: takeMessageId(), userId: sender, text: '/share' }));
            expect(
                lastReplyText(telegram) === USAGE_TEXT,
                `bare /share answers USAGE_TEXT (got ${JSON.stringify(lastReplyText(telegram))})`
            );
            expect((await countShareRows(chatId)) === 0, 'no share row is created');

            telegram.reset();
            await drive(bot, messageUpdate({ chatId, messageId: takeMessageId(), userId: sender, text: '/shareone' }));
            expect(
                lastReplyText(telegram) === USAGE_TEXT,
                `bare /shareone answers USAGE_TEXT (got ${JSON.stringify(lastReplyText(telegram))})`
            );
            expect((await countShareRows(chatId)) === 0, 'still no share row');
        },
    },
    {
        name: 'both commands refuse a trailing argument',
        body: async () => {
            const { bot, telegram } = commandBot();
            const chatId = takeChatId();
            const sender = takeUserId();
            const rootId = takeMessageId();
            await saveUserMessage(chatId, rootId, 8001, '第一条消息');
            const targetId = takeMessageId();
            await saveUserMessage(chatId, targetId, 8002, '被回复的消息', rootId);

            await drive(
                bot,
                replyUpdate({
                    chatId,
                    messageId: takeMessageId(),
                    userId: sender,
                    text: '/share foo',
                    replyToMessageId: targetId,
                    replyFrom: userOf(8002),
                })
            );
            expect(
                lastReplyText(telegram) === USAGE_TEXT,
                `/share foo answers USAGE_TEXT (got ${JSON.stringify(lastReplyText(telegram))})`
            );
            expect((await countShareRows(chatId)) === 0, '/share foo creates no link');

            telegram.reset();
            await drive(
                bot,
                replyUpdate({
                    chatId,
                    messageId: takeMessageId(),
                    userId: sender,
                    text: '/shareone foo',
                    replyToMessageId: targetId,
                    replyFrom: userOf(8002),
                })
            );
            expect(
                lastReplyText(telegram) === USAGE_TEXT,
                `/shareone foo answers USAGE_TEXT (got ${JSON.stringify(lastReplyText(telegram))})`
            );
            expect((await countShareRows(chatId)) === 0, '/shareone foo creates no link');
        },
    },
    {
        name: 'a reply to a bot reply shares the whole conversation at its chain root',
        body: async () => {
            const { bot, telegram } = commandBot();
            const chatId = takeChatId();
            const sender = takeUserId();
            const fixture = await seedConversation(chatId);

            // Replying to the second segment of a multi-part reply must work too
            await drive(
                bot,
                replyUpdate({
                    chatId,
                    messageId: takeMessageId(),
                    userId: sender,
                    text: '/share',
                    replyToMessageId: fixture.continuationId,
                })
            );

            const text = lastReplyText(telegram);
            expect(text.includes('已分享会话'), `the reply says the conversation was shared (got ${JSON.stringify(text)})`);
            const token = expectShareUrl(text, 'conversation share');
            expect(telegram.callsOf('sendMessage').length === 1, 'the command answers exactly once');

            const row = await expectShareRow(token, 'conversation share');
            expect(row.kind === 'conversation', `kind is conversation (got ${row.kind})`);
            expect(
                row.rootId === fixture.rootId,
                `rootId is the chain root behind the reply (got ${row.rootId}, want ${fixture.rootId})`
            );
            expect(row.firstMessageId === null && row.versionId === null, 'a conversation share names no reply version');
            expect(row.source === 'user', `source is user (got ${row.source})`);
            expect(row.createdBy === sender, `createdBy is the sender (got ${row.createdBy}, want ${sender})`);
            expect((await countShareRows(chatId)) === 1, 'exactly one share_links row');
        },
    },
    {
        name: 'a reply to a plain user message shares that conversation from its root',
        body: async () => {
            const { bot, telegram } = commandBot();
            const chatId = takeChatId();
            const sender = takeUserId();
            const rootId = takeMessageId();
            await saveUserMessage(chatId, rootId, 8001, '对话的第一条消息');
            const followUpId = takeMessageId();
            await saveUserMessage(chatId, followUpId, 8002, '同一会话的追问', rootId);

            await drive(
                bot,
                replyUpdate({
                    chatId,
                    messageId: takeMessageId(),
                    userId: sender,
                    text: '/share',
                    replyToMessageId: followUpId,
                    replyFrom: userOf(8002),
                })
            );

            const token = expectShareUrl(lastReplyText(telegram), 'conversation share');
            const row = await expectShareRow(token, 'conversation share');
            expect(row.kind === 'conversation', `kind is conversation (got ${row.kind})`);
            expect(
                row.rootId === rootId,
                `rootId walks the reply chain to the root (got ${row.rootId}, want ${rootId})`
            );
            expect(row.createdBy === sender, `createdBy is the sender (got ${row.createdBy})`);
            expect((await countShareRows(chatId)) === 1, 'exactly one share_links row');
        },
    },
    {
        name: 'a non-first segment of a bot reply is shared alone at the current version',
        body: async () => {
            const { bot, telegram } = commandBot();
            const chatId = takeChatId();
            const sender = takeUserId();
            const fixture = await seedRetriedConversation(chatId);

            await drive(
                bot,
                replyUpdate({
                    chatId,
                    messageId: takeMessageId(),
                    userId: sender,
                    text: '/shareone',
                    replyToMessageId: fixture.continuationId,
                })
            );

            const text = lastReplyText(telegram);
            expect(text.includes('已分享这条回复'), `the reply says the single reply was shared (got ${JSON.stringify(text)})`);
            const token = expectShareUrl(text, 'reply share');
            const row = await expectShareRow(token, 'reply share');
            expect(row.kind === 'reply', `kind is reply (got ${row.kind})`);
            expect(
                row.firstMessageId === fixture.firstMessageId,
                `firstMessageId normalises to the reply's first segment (got ${row.firstMessageId}, want ${fixture.firstMessageId})`
            );
            expect(
                row.versionId === fixture.currentVersionId,
                `versionId is the current version (got ${row.versionId}, want ${fixture.currentVersionId})`
            );
            expect(row.rootId === null, 'a reply share names no conversation root');
            expect(row.source === 'user', `source is user (got ${row.source})`);
            expect(row.createdBy === sender, `createdBy is the sender (got ${row.createdBy})`);
            expect((await countShareRows(chatId)) === 1, 'exactly one share_links row');
        },
    },
    {
        name: 'a user message cannot be shared alone with /shareone',
        body: async () => {
            const { bot, telegram } = commandBot();
            const chatId = takeChatId();
            const sender = takeUserId();
            const userMessageId = takeMessageId();
            await saveUserMessage(chatId, userMessageId, 8001, '一条用户消息');

            await drive(
                bot,
                replyUpdate({
                    chatId,
                    messageId: takeMessageId(),
                    userId: sender,
                    text: '/shareone',
                    replyToMessageId: userMessageId,
                    replyFrom: userOf(8001),
                })
            );

            const text = lastReplyText(telegram);
            expect(
                text.includes('被回复的消息不是我的回复'),
                `the reply explains it is not a bot reply (got ${JSON.stringify(text)})`
            );
            expect((await countShareRows(chatId)) === 0, 'no share row is created');
        },
    },
    {
        name: 'a bot notice is not locatable as a reply share',
        body: async () => {
            const { bot, telegram } = commandBot();
            const chatId = takeChatId();
            const sender = takeUserId();
            const noticeId = takeMessageId();
            await saveBotMessage(chatId, noticeId, null, '切换为：`offline-model`');

            await drive(
                bot,
                replyUpdate({
                    chatId,
                    messageId: takeMessageId(),
                    userId: sender,
                    text: '/shareone',
                    replyToMessageId: noticeId,
                })
            );

            const text = lastReplyText(telegram);
            expect(
                text.includes('超出保留期或无法定位'),
                `the reply explains the bot message has no stored reply (got ${JSON.stringify(text)})`
            );
            expect((await countShareRows(chatId)) === 0, 'no share row is created');
        },
    },
    {
        name: 'an unstored replied message cannot be shared',
        body: async () => {
            const { bot, telegram } = commandBot();
            const chatId = takeChatId();
            const sender = takeUserId();
            const missingId = takeMessageId();

            await drive(
                bot,
                replyUpdate({
                    chatId,
                    messageId: takeMessageId(),
                    userId: sender,
                    text: '/share',
                    replyToMessageId: missingId,
                    replyFrom: userOf(8009),
                })
            );

            const text = lastReplyText(telegram);
            expect(
                text.includes('找不到被回复的消息'),
                `the reply explains the target is not stored (got ${JSON.stringify(text)})`
            );
            expect((await countShareRows(chatId)) === 0, 'no share row is created');
        },
    },
    {
        name: 'another member reuses the conversation link and the creator keeps its own wording',
        body: async () => {
            const { bot, telegram } = commandBot();
            const chatId = takeChatId();
            const creatorId = takeUserId();
            const memberId = takeUserId();
            const fixture = await seedConversation(chatId);

            const share = async (userId: number): Promise<string> => {
                telegram.reset();
                await drive(
                    bot,
                    replyUpdate({
                        chatId,
                        messageId: takeMessageId(),
                        userId,
                        text: '/share',
                        replyToMessageId: fixture.continuationId,
                    })
                );
                return lastReplyText(telegram);
            };

            const creatorText = await share(creatorId);
            const creatorToken = expectShareUrl(creatorText, 'creator share');
            expect((await countShareRows(chatId)) === 1, 'the first share creates one row');

            const memberText = await share(memberId);
            const memberToken = expectShareUrl(memberText, 'member share');
            expect(memberToken === creatorToken, 'another member gets the same token');
            expect(memberText.includes('之前已分享过'), `the reuse is named (got ${JSON.stringify(memberText)})`);
            expect(!memberText.includes('你创建的链接'), 'a member who did not create the link does not own it');
            expect((await countShareRows(chatId)) === 1, 'the reuse adds no row');

            const againText = await share(creatorId);
            expect(expectShareUrl(againText, 'creator repeat') === creatorToken, 'the creator gets the same token too');
            expect(againText.includes('你创建的链接'), `the creator's own link is named (got ${JSON.stringify(againText)})`);
            expect((await countShareRows(chatId)) === 1, 'still one row');
        },
    },
    {
        name: 'the switches turn the command off without creating a link',
        body: async () => {
            const { bot, telegram } = commandBot();
            const chatId = takeChatId();
            const sender = takeUserId();
            const fixture = await seedConversation(chatId);

            const sendShare = async (): Promise<string> => {
                telegram.reset();
                await drive(
                    bot,
                    replyUpdate({
                        chatId,
                        messageId: takeMessageId(),
                        userId: sender,
                        text: '/share',
                        replyToMessageId: fixture.continuationId,
                    })
                );
                return lastReplyText(telegram);
            };

            try {
                process.env.SHARE_COMMAND = '0';
                expect((await sendShare()) === OFF_TEXT, 'SHARE_COMMAND=0 answers OFF_TEXT');
            } finally {
                delete process.env.SHARE_COMMAND;
            }
            expect((await countShareRows(chatId)) === 0, 'SHARE_COMMAND=0 creates no link');

            try {
                process.env.SHARE_ENABLED = '0';
                expect((await sendShare()) === OFF_TEXT, 'SHARE_ENABLED=0 answers OFF_TEXT');
            } finally {
                delete process.env.SHARE_ENABLED;
            }
            expect((await countShareRows(chatId)) === 0, 'SHARE_ENABLED=0 creates no link');

            try {
                process.env.WEBAPP_PUBLIC_URL = '';
                expect((await sendShare()) === OFF_TEXT, 'a missing WEBAPP_PUBLIC_URL answers OFF_TEXT');
            } finally {
                process.env.WEBAPP_PUBLIC_URL = 'https://miniapp.test';
            }
            expect((await countShareRows(chatId)) === 0, 'a missing WEBAPP_PUBLIC_URL creates no link');

            try {
                setPanelRunning(false);
                expect((await sendShare()) === OFF_TEXT, 'a stopped panel answers OFF_TEXT');
            } finally {
                setPanelRunning(true);
            }
            expect((await countShareRows(chatId)) === 0, 'a stopped panel creates no link');
        },
    },
    {
        name: 'anonymous admins, other bots and channel identities are refused',
        body: async () => {
            const { bot, telegram } = commandBot();
            const chatId = takeChatId();
            const fixture = await seedConversation(chatId);

            const sendAs = async (input: { sender?: User; dropSender?: boolean; userId: number }): Promise<string> => {
                telegram.reset();
                await drive(
                    bot,
                    replyUpdate({
                        chatId,
                        messageId: takeMessageId(),
                        userId: input.userId,
                        text: '/share',
                        replyToMessageId: fixture.continuationId,
                        ...(input.sender === undefined ? {} : { sender: input.sender }),
                        ...(input.dropSender === true ? { dropSender: true } : {}),
                    })
                );
                return lastReplyText(telegram);
            };

            expect(
                (await sendAs({ sender: ANONYMOUS_ADMIN, userId: ANONYMOUS_ADMIN.id })) === PERSONAL_ACCOUNT_TEXT,
                'an anonymous admin is asked to use a personal account'
            );
            expect((await countShareRows(chatId)) === 0, 'an anonymous admin creates no link');
            expect(
                (await sendAs({ sender: OTHER_BOT, userId: OTHER_BOT.id })) === PERSONAL_ACCOUNT_TEXT,
                'another bot is asked to use a personal account'
            );
            expect((await sendAs({ dropSender: true, userId: 1 })) === USAGE_TEXT, 'a channel identity gets the usage text');
            expect((await countShareRows(chatId)) === 0, 'non-human senders create no link');
        },
    },
    {
        name: 'the limiter allows five a minute and thirty an hour with an injected clock',
        body: async () => {
            let clock = 3_600_000;
            const limiter = createShareCommandLimiter({ now: () => clock });
            const user = takeUserId();

            for (let take = 1; take <= 5; take += 1) {
                expect(limiter.take(user).allowed === true, `the ${take}. take in a minute is allowed`);
            }
            const sixth = limiter.take(user);
            expect(sixth.allowed === false, 'the sixth take in a minute is refused');
            expect(sixth.retryAfterSeconds > 0, `the refusal says how long to wait (got ${sixth.retryAfterSeconds})`);
            expect(limiter.take(takeUserId()).allowed === true, 'another user is not affected');

            clock += 60_001;
            expect(limiter.take(user).allowed === true, 'allowed again once the minute window passed');

            // One take per minute keeps the minute window clear, so only the hour
            // window can refuse the 31st take of the same hour.
            let hourClock = 7_200_000;
            const hourLimiter = createShareCommandLimiter({ now: () => hourClock });
            const hourlyUser = takeUserId();
            let allowed = 0;
            for (let take = 1; take <= 30; take += 1) {
                hourClock += 61_000;
                if (hourLimiter.take(hourlyUser).allowed) allowed += 1;
            }
            expect(allowed === 30, `thirty takes spread over one hour are allowed (got ${allowed})`);

            hourClock += 61_000;
            const overHour = hourLimiter.take(hourlyUser);
            expect(overHour.allowed === false, 'the thirty-first take inside the hour is refused');
            expect(overHour.retryAfterSeconds > 0, 'the hourly refusal says how long to wait');
        },
    },
    {
        name: 'the sixth command in a minute is refused and creates no link',
        body: async () => {
            const { bot, telegram } = commandBot();
            const chatId = takeChatId();
            const sender = takeUserId();
            const fixtures: ConversationFixture[] = [];
            for (let index = 0; index < 6; index += 1) fixtures.push(await seedConversation(chatId));

            let lastText = '';
            for (const fixture of fixtures) {
                telegram.reset();
                await drive(
                    bot,
                    replyUpdate({
                        chatId,
                        messageId: takeMessageId(),
                        userId: sender,
                        text: '/share',
                        replyToMessageId: fixture.continuationId,
                    })
                );
                lastText = lastReplyText(telegram);
            }

            expect(lastText.includes('分享太频繁了'), `the sixth command is refused (got ${JSON.stringify(lastText)})`);
            const rows = await countShareRows(chatId);
            expect(rows === 5, `the first five commands created links and the sixth none (got ${rows} rows)`);
        },
    },
    {
        name: 'the command and its answer stay out of telegram_messages while ordinary messages are stored',
        body: async () => {
            const chatId = takeChatId();
            const sender = takeUserId();
            const fixture = await seedConversation(chatId);

            const { bot, telegram } = createFakeBot();
            setPanelRunning(true);
            autoSave(bot);
            registerShareCommand(bot);

            const shareCommandId = takeMessageId();
            await drive(
                bot,
                replyUpdate({
                    chatId,
                    messageId: shareCommandId,
                    userId: sender,
                    text: '/share',
                    replyToMessageId: fixture.continuationId,
                })
            );
            const shareText = lastReplyText(telegram);

            const shareOneCommandId = takeMessageId();
            telegram.reset();
            await drive(
                bot,
                replyUpdate({
                    chatId,
                    messageId: shareOneCommandId,
                    userId: sender,
                    text: '/shareone',
                    replyToMessageId: fixture.firstMessageId,
                })
            );
            const shareOneText = lastReplyText(telegram);

            expect(SHARE_URL_PATTERN.test(shareText), 'the /share handler answered with a link');
            expect(SHARE_URL_PATTERN.test(shareOneText), 'the /shareone handler answered with a link');
            expect(
                (await Message.findOne({ where: { chatId, messageId: shareCommandId } })) === null,
                'the /share command message is not stored'
            );
            expect(
                (await Message.findOne({ where: { chatId, messageId: shareOneCommandId } })) === null,
                'the /shareone command message is not stored'
            );

            const seededRows = await Message.findAll({ where: { chatId } });
            expect(
                seededRows.every((row) => !(row.text ?? '').includes('https://miniapp.test/s/')),
                'the bot answer with the share URL is not stored'
            );
            expect(seededRows.length === 3, `only the seeded messages exist (got ${seededRows.length})`);

            const plainId = takeMessageId();
            await drive(bot, messageUpdate({ chatId, messageId: plainId, userId: sender, text: '一条普通消息' }));
            const plainRow = await Message.findOne({ where: { chatId, messageId: plainId } });
            expect(plainRow?.text === '一条普通消息', 'an ordinary message is still stored');

            const contextCommandId = takeMessageId();
            await drive(
                bot,
                messageUpdate({ chatId, messageId: contextCommandId, userId: sender, text: '/context' })
            );
            expect(
                (await Message.findOne({ where: { chatId, messageId: contextCommandId } })) === null,
                '/context is still excluded (regression)'
            );
        },
    },
    {
        name: 'the conversation summary is one plain line',
        body: async () => {
            const { bot, telegram } = commandBot();
            const chatId = takeChatId();
            const sender = takeUserId();
            const fixture = await seedConversation(chatId, '**粗体**\n第二行');

            await drive(
                bot,
                replyUpdate({
                    chatId,
                    messageId: takeMessageId(),
                    userId: sender,
                    text: '/share',
                    replyToMessageId: fixture.firstMessageId,
                })
            );

            const text = lastReplyText(telegram);
            const match = /已分享会话「([^」]*)」/.exec(text);
            expect(match !== null, `the reply names the shared conversation (got ${JSON.stringify(text)})`);
            const summary = match?.[1] ?? '';
            expect(!summary.includes('**'), `the summary has no markdown markup (got ${JSON.stringify(summary)})`);
            expect(
                !summary.includes('\n') && !summary.includes('\r'),
                `the summary is a single line (got ${JSON.stringify(summary)})`
            );
            expect(
                summary.includes('粗体') && summary.includes('第二行'),
                `the summary keeps the message text (got ${JSON.stringify(summary)})`
            );
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) results.push(await runCase(testCase.name, testCase.body));
reportResults(results);
