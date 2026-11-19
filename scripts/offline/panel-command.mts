/**
 * Offline cases for the `/panel` command (design
 * docs/2026-1119-2016-设计-面板会话深链与多选排除.md §4.4): replying to a
 * message makes the button deep-link into the conversation that message
 * belongs to; every other case keeps exactly the chat-level reply the command
 * had before. The real grammY handler is driven through the fake Telegram API
 * (the share-command.mts style), so the assertions are the sendMessage text
 * and reply_markup.
 *
 * Run: npx tsx scripts/offline/panel-command.mts
 */
import type { Bot } from 'grammy';
import type { Chat, Update, User } from 'grammy/types';
import { expect, reportResults, runCase, setupOfflineDb, takeMessageId, type CaseResult } from './harness.mts';
import {
    createFakeBot,
    groupChat,
    messageUpdate,
    quietly,
    userOf,
    type FakeTelegram,
} from './fake-telegram.mts';

// Read when a command runs (not at import time): the command module and the
// conversation queries look these up per call. Set before the first src import;
// the harness already pointed DB_PATH at a scratch database.
process.env.WEBAPP_PUBLIC_URL = 'https://miniapp.test';
process.env.BOT_USER_NAME = 'AfterSchoolTeatimeBot';
process.env.BOT_USER_ID = '7777';
process.env.BOT_NAME = 'K-ON';
process.env.WIDGET_RENDER_URL = '';
delete process.env.ALLOWED_CHAT_IDS;
delete process.env.WEBAPP_BOT_SHORT_NAME;

const db = await setupOfflineDb();
const dbIndex = await import('../../src/db/index.js');
const { setPanelRunning } = await import('../../src/panel/panel-state.js');
const { findChat } = await import('../../src/db/queries/panel-registry.js');
const { parseStartParam } = await import('../../src/panel/auth/start-param.js');
const { registerPanelCommand } = await import('../../src/cmd/commands/panel.js');

type ResponseVersion = import('../../src/db/index.js').ResponseVersion;

const BOT_USER_ID = 7777;
const BOT_USER: User = { id: BOT_USER_ID, is_bot: true, first_name: 'K-ON', username: 'AfterSchoolTeatimeBot' };
const BOT_USER_NAME = 'AfterSchoolTeatimeBot';
const WEBAPP_URL = 'https://miniapp.test';

/** The texts the command answers with */
const CHAT_PANEL_TEXT = '本聊天的控制面板：';
const PRIVATE_PANEL_TEXT = '控制面板：';
const CONVERSATION_PANEL_TEXT = '这条会话的控制面板：';
const OPEN_PANEL_LABEL = '打开面板';
const OPEN_CONVERSATION_LABEL = '打开这条会话';
const DISABLED_TEXT = '面板未启用';
const UNSUPPORTED_TEXT = '这里不支持控制面板';

/** A fresh chat per case, so no case can see another case's rows */
let nextChatId = -1009600000000;
const takeChatId = (): number => (nextChatId -= 1);
let nextPrivateChatId = 52_000;
const takePrivateChatId = (): number => (nextPrivateChatId += 1);

const privateChatOf = (chatId: number): Chat.PrivateChat => ({ id: chatId, type: 'private', first_name: '私聊用户' });

/**
 * A command in a channel arrives as a channel post, not as a `message` update:
 * grammY's command filter matches both, and `ctx.message` stays undefined.
 */
const channelPostUpdate = (chatId: number, messageId: number, text: string): Update => ({
    update_id: takeMessageId(),
    channel_post: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: 'channel', title: '测试频道' },
        sender_chat: { id: chatId, type: 'channel', title: '测试频道' },
        text,
        entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]?.length ?? 0 }],
    },
});

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

const versionOf = (versionId: number, messageIds: number[]): ResponseVersion => ({
    versionId,
    createdAt: new Date(Date.now() - (10 - versionId) * 60_000).toISOString(),
    messageIds,
    currentMessageId: messageIds[messageIds.length - 1] ?? 0,
    text: `第 ${versionId} 版正文`,
    wasStoppedByUser: false,
});

const saveBotReply = async (input: {
    chatId: number;
    firstMessageId: number;
    userMessageId: number;
    versions: ResponseVersion[];
}): Promise<void> => {
    const response = await dbIndex.createBotResponse(input.chatId, input.firstMessageId, input.userMessageId, {
        model: 'offline-model',
        hasImage: false,
    });
    response.setVersions(input.versions);
    await response.save();
};

interface ConversationFixture {
    /** The chain root the deep link must name */
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

/** The chats a `message` update can name (a channel post has its own update slot) */
type MessageChat = Chat.GroupChat | Chat.PrivateChat | Chat.SupergroupChat;

interface TextUpdateInput {
    chat: MessageChat;
    messageId: number;
    userId: number;
    text: string;
    replyToMessageId?: number;
    replyFrom?: User;
}

/** A text update in any chat type, optionally replying to another message */
const textUpdate = (input: TextUpdateInput): Update => {
    const update = messageUpdate({
        chatId: input.chat.id,
        messageId: input.messageId,
        userId: input.userId,
        text: input.text,
    });
    const message = update.message;
    if (message !== undefined) {
        // messageUpdate always builds a supergroup; this case's chat may be another kind
        message.chat = input.chat;
        if (input.replyToMessageId !== undefined) {
            message.reply_to_message = {
                message_id: input.replyToMessageId,
                date: Math.floor(Date.now() / 1000),
                chat: input.chat,
                from: input.replyFrom ?? userOf(input.userId),
                text: '被回复的消息',
                // A replied-to message never nests its own reply
                reply_to_message: undefined,
            };
        }
    }
    return update;
};

/** A bot with /panel registered and the panel marked as running */
const commandBot = (): { bot: Bot; telegram: FakeTelegram } => {
    setPanelRunning(true);
    const { bot, telegram } = createFakeBot();
    registerPanelCommand(bot);
    return { bot, telegram };
};

const drive = async (bot: Bot, update: Update): Promise<void> => {
    await quietly(() => bot.handleUpdate(update));
};

const lastSentPayload = (telegram: FakeTelegram): Readonly<Record<string, unknown>> =>
    telegram.callsOf('sendMessage').at(-1)?.payload ?? {};

const lastReplyText = (telegram: FakeTelegram): string => {
    const text = lastSentPayload(telegram).text;
    return typeof text === 'string' ? text : '';
};

const asFields = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : {};

interface SentButton {
    text: string;
    url: string | null;
    webAppUrl: string | null;
}

/** The buttons of the last sent message, row by row */
const buttonsOf = (telegram: FakeTelegram): SentButton[] => {
    const markup = asFields(lastSentPayload(telegram).reply_markup);
    const rows: unknown[] = Array.isArray(markup.inline_keyboard) ? markup.inline_keyboard : [];
    return rows.flatMap((row) =>
        (Array.isArray(row) ? row : []).map((button) => {
            const fields = asFields(button);
            const webApp = asFields(fields.web_app);
            return {
                text: typeof fields.text === 'string' ? fields.text : '',
                url: typeof fields.url === 'string' ? fields.url : null,
                webAppUrl: typeof webApp.url === 'string' ? webApp.url : null,
            };
        })
    );
};

/** The Direct Link a URL button must carry */
const directLink = (startParam: string): string =>
    `https://t.me/${BOT_USER_NAME}/panel?startapp=${startParam}`;

const startParamOf = (url: string | null): string | null => {
    if (url === null) return null;
    return new URL(url).searchParams.get('startapp');
};

/** Assert the answer is exactly one URL button with this label and URL */
const expectUrlButton = (telegram: FakeTelegram, input: { label: string; url: string }): void => {
    const buttons = buttonsOf(telegram);
    expect(buttons.length === 1, `exactly one button (got ${JSON.stringify(buttons)})`);
    expect(buttons[0]?.text === input.label, `the label is ${input.label} (got ${JSON.stringify(buttons[0]?.text)})`);
    expect(buttons[0]?.url === input.url, `the URL is ${input.url} (got ${JSON.stringify(buttons[0]?.url)})`);
    expect(buttons[0]?.webAppUrl === null, 'a URL button, never a web_app button');
};

/** Assert the answer is exactly one web_app button with this label and URL */
const expectWebAppButton = (telegram: FakeTelegram, input: { label: string; url: string }): void => {
    const buttons = buttonsOf(telegram);
    expect(buttons.length === 1, `exactly one button (got ${JSON.stringify(buttons)})`);
    expect(buttons[0]?.text === input.label, `the label is ${input.label} (got ${JSON.stringify(buttons[0]?.text)})`);
    expect(buttons[0]?.webAppUrl === input.url, `the web_app URL is ${input.url} (got ${JSON.stringify(buttons[0]?.webAppUrl)})`);
    expect(buttons[0]?.url === null, 'a web_app button, not a URL button');
};

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'a bare /panel in a group keeps the chat-level Direct Link (regression)',
        body: async () => {
            const { bot, telegram } = commandBot();
            const chatId = takeChatId();

            await drive(
                bot,
                textUpdate({ chat: groupChat(chatId), messageId: takeMessageId(), userId: 5001, text: '/panel' })
            );

            expect(telegram.callsOf('sendMessage').length === 1, 'the command answers exactly once');
            expect(
                lastReplyText(telegram) === CHAT_PANEL_TEXT,
                `the chat-level text (got ${JSON.stringify(lastReplyText(telegram))})`
            );
            expectUrlButton(telegram, { label: OPEN_PANEL_LABEL, url: directLink(`c${chatId}`) });
            expect((await findChat(chatId)) !== null, 'the chat is still registered in the panel');
        },
    },
    {
        name: 'the reply button label and text name the conversation',
        body: async () => {
            const { bot, telegram } = commandBot();
            const chatId = takeChatId();
            const fixture = await seedConversation(chatId);

            await drive(
                bot,
                textUpdate({
                    chat: groupChat(chatId),
                    messageId: takeMessageId(),
                    userId: 5001,
                    text: '/panel',
                    replyToMessageId: fixture.triggerId,
                })
            );

            expect(
                lastReplyText(telegram) === CONVERSATION_PANEL_TEXT,
                `the conversation text (got ${JSON.stringify(lastReplyText(telegram))})`
            );
            expectUrlButton(telegram, {
                label: OPEN_CONVERSATION_LABEL,
                url: directLink(`c${chatId}_${fixture.rootId}`),
            });
            const buttons = buttonsOf(telegram);
            expect(buttons[0]?.url !== null, 'the button carries a URL');
        },
    },
    {
        name: 'replying to a user message deep-links to the conversation root',
        body: async () => {
            const { bot, telegram } = commandBot();
            const chatId = takeChatId();
            const fixture = await seedConversation(chatId);

            await drive(
                bot,
                textUpdate({
                    chat: groupChat(chatId),
                    messageId: takeMessageId(),
                    userId: 5001,
                    text: '/panel',
                    replyToMessageId: fixture.triggerId,
                })
            );

            const target = parseStartParam(startParamOf(buttonsOf(telegram)[0]?.url ?? null));
            expect(
                JSON.stringify(target) === JSON.stringify({ kind: 'conversation', chatId, rootId: fixture.rootId }),
                `the signed start_param parses back into the conversation target (got ${JSON.stringify(target)})`
            );
        },
    },
    {
        name: 'replying to the chain root itself deep-links to that root',
        body: async () => {
            const { bot, telegram } = commandBot();
            const chatId = takeChatId();
            const fixture = await seedConversation(chatId);

            await drive(
                bot,
                textUpdate({
                    chat: groupChat(chatId),
                    messageId: takeMessageId(),
                    userId: 5001,
                    text: '/panel',
                    replyToMessageId: fixture.rootId,
                })
            );

            expectUrlButton(telegram, {
                label: OPEN_CONVERSATION_LABEL,
                url: directLink(`c${chatId}_${fixture.rootId}`),
            });
        },
    },
    {
        name: 'replying to a bot reply or one of its continuation messages deep-links to the same root',
        body: async () => {
            const { bot, telegram } = commandBot();
            const chatId = takeChatId();
            const fixture = await seedConversation(chatId);

            for (const repliedId of [fixture.firstMessageId, fixture.continuationId]) {
                telegram.reset();
                await drive(
                    bot,
                    textUpdate({
                        chat: groupChat(chatId),
                        messageId: takeMessageId(),
                        userId: 5001,
                        text: '/panel',
                        replyToMessageId: repliedId,
                    })
                );
                expect(
                    lastReplyText(telegram) === CONVERSATION_PANEL_TEXT,
                    `replied id ${repliedId}: the conversation text (got ${JSON.stringify(lastReplyText(telegram))})`
                );
                expectUrlButton(telegram, {
                    label: OPEN_CONVERSATION_LABEL,
                    url: directLink(`c${chatId}_${fixture.rootId}`),
                });
            }
        },
    },
    {
        name: 'replying to a message that was never stored keeps the chat-level keyboard',
        body: async () => {
            const { bot, telegram } = commandBot();
            const chatId = takeChatId();
            const missingId = takeMessageId();

            await drive(
                bot,
                textUpdate({
                    chat: groupChat(chatId),
                    messageId: takeMessageId(),
                    userId: 5001,
                    text: '/panel',
                    replyToMessageId: missingId,
                    replyFrom: userOf(8009),
                })
            );

            expect(
                lastReplyText(telegram) === CHAT_PANEL_TEXT,
                `the chat-level text (got ${JSON.stringify(lastReplyText(telegram))})`
            );
            expectUrlButton(telegram, { label: OPEN_PANEL_LABEL, url: directLink(`c${chatId}`) });
        },
    },
    {
        name: 'replying to a bot notice keeps the chat-level keyboard',
        body: async () => {
            const { bot, telegram } = commandBot();
            const chatId = takeChatId();
            const noticeId = takeMessageId();
            await saveBotMessage(chatId, noticeId, null, '切换为：`offline-model`');

            await drive(
                bot,
                textUpdate({
                    chat: groupChat(chatId),
                    messageId: takeMessageId(),
                    userId: 5001,
                    text: '/panel',
                    replyToMessageId: noticeId,
                    replyFrom: BOT_USER,
                })
            );

            expect(
                lastReplyText(telegram) === CHAT_PANEL_TEXT,
                `a notice is not a conversation message (got ${JSON.stringify(lastReplyText(telegram))})`
            );
            expectUrlButton(telegram, { label: OPEN_PANEL_LABEL, url: directLink(`c${chatId}`) });
        },
    },
    {
        name: 'replying to a lone command message keeps the chat-level keyboard',
        body: async () => {
            const { bot, telegram } = commandBot();
            const chatId = takeChatId();
            const helpId = takeMessageId();
            await saveUserMessage(chatId, helpId, 5001, '/help');
            const summonId = takeMessageId();
            // A /chat summon row: chatCommand set, its own text has no leading slash
            await db.saveMessage({
                chatId,
                messageId: summonId,
                userId: 5001,
                date: new Date(),
                userName: 'user-5001',
                message: '拼接这段对话',
                chatCommand: '{}',
            });

            for (const repliedId of [helpId, summonId]) {
                telegram.reset();
                await drive(
                    bot,
                    textUpdate({
                        chat: groupChat(chatId),
                        messageId: takeMessageId(),
                        userId: 5001,
                        text: '/panel',
                        replyToMessageId: repliedId,
                        replyFrom: userOf(5001),
                    })
                );
                expect(
                    lastReplyText(telegram) === CHAT_PANEL_TEXT,
                    `replied id ${repliedId}: a command root is not a conversation (got ${JSON.stringify(lastReplyText(telegram))})`
                );
                expectUrlButton(telegram, { label: OPEN_PANEL_LABEL, url: directLink(`c${chatId}`) });
            }
        },
    },
    {
        name: 'a command message that replies inside a conversation still deep-links to that conversation',
        body: async () => {
            const { bot, telegram } = commandBot();
            const chatId = takeChatId();
            const fixture = await seedConversation(chatId);
            const commandId = takeMessageId();
            await saveUserMessage(chatId, commandId, 5001, '/help', fixture.triggerId);

            await drive(
                bot,
                textUpdate({
                    chat: groupChat(chatId),
                    messageId: takeMessageId(),
                    userId: 5001,
                    text: '/panel',
                    replyToMessageId: commandId,
                    replyFrom: userOf(5001),
                })
            );

            expectUrlButton(telegram, {
                label: OPEN_CONVERSATION_LABEL,
                url: directLink(`c${chatId}_${fixture.rootId}`),
            });
        },
    },
    {
        name: 'a private chat /panel without a reply keeps the web_app button (regression)',
        body: async () => {
            const { bot, telegram } = commandBot();
            const userId = takePrivateChatId();

            await drive(
                bot,
                textUpdate({
                    chat: privateChatOf(userId),
                    messageId: takeMessageId(),
                    userId,
                    text: '/panel',
                })
            );

            expect(
                lastReplyText(telegram) === PRIVATE_PANEL_TEXT,
                `the private-chat text (got ${JSON.stringify(lastReplyText(telegram))})`
            );
            expectWebAppButton(telegram, { label: OPEN_PANEL_LABEL, url: WEBAPP_URL });
            expect((await findChat(userId)) !== null, 'the private chat is registered in the panel');
        },
    },
    {
        name: 'a private chat reply deep-links to the conversation with a URL button',
        body: async () => {
            const { bot, telegram } = commandBot();
            const userId = takePrivateChatId();
            const fixture = await seedConversation(userId);

            await drive(
                bot,
                textUpdate({
                    chat: privateChatOf(userId),
                    messageId: takeMessageId(),
                    userId,
                    text: '/panel',
                    replyToMessageId: fixture.firstMessageId,
                })
            );

            expect(
                lastReplyText(telegram) === CONVERSATION_PANEL_TEXT,
                `the conversation text (got ${JSON.stringify(lastReplyText(telegram))})`
            );
            expectUrlButton(telegram, {
                label: OPEN_CONVERSATION_LABEL,
                url: directLink(`c${userId}_${fixture.rootId}`),
            });
        },
    },
    {
        name: 'a private chat reply that resolves to no conversation keeps the web_app button',
        body: async () => {
            const { bot, telegram } = commandBot();
            const userId = takePrivateChatId();

            await drive(
                bot,
                textUpdate({
                    chat: privateChatOf(userId),
                    messageId: takeMessageId(),
                    userId,
                    text: '/panel',
                    replyToMessageId: takeMessageId(),
                })
            );

            expect(
                lastReplyText(telegram) === PRIVATE_PANEL_TEXT,
                `the chat-level text (got ${JSON.stringify(lastReplyText(telegram))})`
            );
            expectWebAppButton(telegram, { label: OPEN_PANEL_LABEL, url: WEBAPP_URL });
        },
    },
    {
        name: 'without BOT_USER_NAME a conversation reply falls back to exactly the chat-level reply',
        body: async () => {
            const { bot, telegram } = commandBot();
            try {
                delete process.env.BOT_USER_NAME;

                // A group: no Direct Link, so the group keyboard is unavailable
                const groupId = takeChatId();
                const groupFixture = await seedConversation(groupId);
                await drive(
                    bot,
                    textUpdate({
                        chat: groupChat(groupId),
                        messageId: takeMessageId(),
                        userId: 5001,
                        text: '/panel',
                        replyToMessageId: groupFixture.triggerId,
                    })
                );
                expect(
                    lastReplyText(telegram) === DISABLED_TEXT,
                    `the group says the panel is unavailable (got ${JSON.stringify(lastReplyText(telegram))})`
                );
                expect(buttonsOf(telegram).length === 0, 'the group answer carries no keyboard');

                // A private chat: nothing to deep-link, so the web_app button is the today reply
                telegram.reset();
                const userId = takePrivateChatId();
                const privateFixture = await seedConversation(userId);
                await drive(
                    bot,
                    textUpdate({
                        chat: privateChatOf(userId),
                        messageId: takeMessageId(),
                        userId,
                        text: '/panel',
                        replyToMessageId: privateFixture.triggerId,
                    })
                );
                expect(
                    lastReplyText(telegram) === PRIVATE_PANEL_TEXT,
                    `the private chat keeps today's text (got ${JSON.stringify(lastReplyText(telegram))})`
                );
                expectWebAppButton(telegram, { label: OPEN_PANEL_LABEL, url: WEBAPP_URL });
            } finally {
                process.env.BOT_USER_NAME = BOT_USER_NAME;
            }
        },
    },
    {
        name: 'a stopped panel answers 面板未启用 before looking at the reply',
        body: async () => {
            const { bot, telegram } = commandBot();
            const chatId = takeChatId();
            const fixture = await seedConversation(chatId);
            try {
                setPanelRunning(false);
                await drive(
                    bot,
                    textUpdate({
                        chat: groupChat(chatId),
                        messageId: takeMessageId(),
                        userId: 5001,
                        text: '/panel',
                        replyToMessageId: fixture.triggerId,
                    })
                );
                expect(
                    lastReplyText(telegram) === DISABLED_TEXT,
                    `the disabled text (got ${JSON.stringify(lastReplyText(telegram))})`
                );
                expect(buttonsOf(telegram).length === 0, 'no keyboard while the panel is stopped');
            } finally {
                setPanelRunning(true);
            }
        },
    },
    {
        name: 'a channel gets 这里不支持控制面板',
        body: async () => {
            const { bot, telegram } = commandBot();
            const chatId = takeChatId();

            await drive(bot, channelPostUpdate(chatId, takeMessageId(), '/panel'));

            expect(
                lastReplyText(telegram) === UNSUPPORTED_TEXT,
                `the unsupported text (got ${JSON.stringify(lastReplyText(telegram))})`
            );
            expect(buttonsOf(telegram).length === 0, 'the channel answer carries no keyboard');
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) results.push(await runCase(testCase.name, testCase.body));
reportResults(results);
