/**
 * Offline cases for bot notices: a command reply (/model, /chat help, /help,
 * /pic errors) is written as the bot's own row, so `/chat` contexts, reply
 * trees and the panel can see it. The "long replies split into several
 * messages" concern does not apply here: a notice is one Telegram message and
 * an AI reply is stored once, under its first message id.
 *
 * Run: npx tsx scripts/offline/bot-notice.mts
 */
import { expect, reportResults, runCase, setupOfflineDb, takeMessageId, type CaseResult } from './harness.mts';
import {
    contextOf,
    createFakeBot,
    createFakeTelegram,
    groupChat,
    messageUpdate,
    quietly,
    userOf,
} from './fake-telegram.mts';
import type { Update } from 'grammy/types';
import type { ChatRow } from '../../src/db/queries/panel-registry.js';

// Read when a notice is recorded, not at import time
process.env.BOT_USER_NAME = 'AfterSchoolTeatimeBot';
process.env.BOT_NAME = 'K-ON';
process.env.BOT_USER_ID = '7777';

const db = await setupOfflineDb();
const { Message, queries } = db;
const { sendBotNotice, sendBotNoticeVia, updateBotNotice } = await import('../../src/services/bot-notice-service.js');
const { writeBotMessageRow } = await import('../../src/db/index.js');
const { dealChatCommand } = await import('../../src/reply/commands/chat-command.js');
const { serializeChatCommand } = await import('../../src/reply/commands/chat-command-parser.js');
const { buildContext } = await import('../../src/reply/context-builder.js');
const { buildConversationTreeView } = await import('../../src/panel/views/conversation-tree.js');
const { menuLoad } = await import('../../src/cmd/menu.js');
const { registerModelCommand } = await import('../../src/cmd/commands/model.js');

const BOT_USER_ID = 7777;
const ALICE = { id: 5001, name: 'Alice' };

/** A fresh chat per case, so one case's rows never leak into another's range */
let nextChatId = -1009000000000;
const takeChatId = (): number => (nextChatId -= 1);

/** A text update that replies to `replyToMessageId` (what `/chat` needs) */
const replyUpdate = (input: {
    chatId: number;
    messageId: number;
    userId: number;
    text: string;
    replyToMessageId: number;
}): Update => {
    const update = messageUpdate({
        chatId: input.chatId,
        messageId: input.messageId,
        userId: input.userId,
        text: input.text,
    });
    if (update.message) {
        update.message.reply_to_message = {
            message_id: input.replyToMessageId,
            date: Math.floor(Date.now() / 1000),
            chat: groupChat(input.chatId),
            from: userOf(input.userId),
            text: 'the replied-to message',
        };
    }
    return update;
};

/** A button press on bot message `messageId` */
const callbackUpdateFor = (
    chatId: number,
    messageId: number,
    userId: number,
    data: string
): Update => ({
    update_id: takeMessageId(),
    callback_query: {
        id: `offline-callback-${messageId}`,
        from: userOf(userId),
        chat_instance: 'offline',
        data,
        message: {
            message_id: messageId,
            date: 0,
            chat: groupChat(chatId),
            from: { id: BOT_USER_ID, is_bot: true, first_name: 'K-ON', username: 'AfterSchoolTeatimeBot' },
            text: '当前模型：`gemini-4-argon`',
        },
    },
});

/** One user message row, written directly (no Telegram path involved) */
const seedUserMessage = async (
    chatId: number,
    messageId: number,
    options: { text: string; replyToId?: number | null; chatCommand?: string | null }
): Promise<void> => {
    await Message.create({
        chatId,
        messageId,
        fromBotSelf: false,
        userId: ALICE.id,
        date: new Date(),
        userName: ALICE.name,
        text: options.text,
        quoteText: null,
        file: null,
        fileMime: null,
        fileUniqueId: null,
        replyToId: options.replyToId ?? null,
        chatCommand: options.chatCommand ?? null,
        modelParts: null,
        mediaHint: null,
        forwardOrigin: null,
        forwardFromId: null,
        viaBot: null,
        ocrText: null,
    });
};

/** One notice row exactly as the service writes it */
const seedNotice = async (
    chatId: number,
    messageId: number,
    replyToId: number | null,
    text: string
): Promise<void> => {
    await writeBotMessageRow({
        chatId,
        messageId,
        replyToId,
        date: new Date(),
        text,
        modelParts: null,
        file: null,
        fileMime: null,
    });
};

const textOfTurn = (turn: { content: ReadonlyArray<{ text?: string }> }): string =>
    turn.content.map((part) => part.text ?? '').join('\n');

const cases: CaseResult[] = [];

cases.push(
    await runCase("a notice is sent unchanged and recorded as the bot's own row", async () => {
        const chatId = takeChatId();
        const telegram = createFakeTelegram();
        const commandId = takeMessageId();
        const ctx = contextOf(
            messageUpdate({ chatId, messageId: commandId, userId: ALICE.id, text: '/model gemini-4-argon' }),
            telegram
        );

        const text = '切换为：`gemini-4-argon`';
        const sent = await sendBotNotice(ctx, text, { parse_mode: 'Markdown' });
        expect(sent, 'the notice was sent');

        const call = telegram.callsOf('sendMessage').at(-1);
        expect(call?.payload.text === text, 'the text is passed through verbatim');
        expect(call?.payload.parse_mode === 'Markdown', 'the parse mode is passed through');
        expect(call?.payload.reply_parameters === undefined, 'the visible message gains no reply link');

        const row = await Message.findOne({ where: { chatId, fromBotSelf: true } });
        expect(row !== null, 'the notice was recorded');
        expect(row?.text === text, 'with the same text');
        expect(row?.replyToId === commandId, 'answering the command message');
        expect(row?.userName === 'K-ON', 'under the bot name');
        expect(row?.userId === BOT_USER_ID, 'and the bot user id');
        expect(
            (row?.messageId ?? 0) > 500_000,
            `under the id Telegram returned for it, not the trigger id (got ${row?.messageId})`
        );
        const ageMs = Date.now() - new Date(row?.date ?? 0).getTime();
        expect(ageMs >= 0 && ageMs < 10_000, `recorded with a current date (age ${ageMs}ms)`);
    })
);

cases.push(
    await runCase('a notice sent from an Api-only caller is recorded too', async () => {
        const chatId = takeChatId();
        const telegram = createFakeTelegram();
        const triggerId = takeMessageId();

        const sent = await sendBotNoticeVia(telegram.api, chatId, triggerId, '生成视频失败：测试');
        expect(sent, 'the notice was sent');

        const row = await Message.findOne({ where: { chatId, fromBotSelf: true } });
        expect(row?.text === '生成视频失败：测试', 'the text is recorded');
        expect(row?.replyToId === triggerId, 'answering the triggering message');
    })
);

cases.push(
    await runCase('the /chat help is recorded, so a later context can quote it', async () => {
        const chatId = takeChatId();
        const telegram = createFakeTelegram();
        const commandId = takeMessageId();
        const ctx = contextOf(
            messageUpdate({ chatId, messageId: commandId, userId: ALICE.id, text: '/chat' }),
            telegram
        );

        const outcome = await quietly(() => dealChatCommand(ctx));
        expect(outcome.type === 'help-shown', `bare /chat shows the help (got ${outcome.type})`);

        const row = await Message.findOne({ where: { chatId, fromBotSelf: true } });
        expect(row !== null, 'the help message was recorded');
        expect(
            (row?.text ?? '').startsWith('`/chat` 仅在需要添加上下文时使用'),
            'with the help text'
        );
        expect(row?.replyToId === commandId, 'answering the /chat command');
    })
);

cases.push(
    await runCase('a /chat summon counts a bot notice among the messages it attaches', async () => {
        const chatId = takeChatId();
        const target = takeMessageId();
        const modelCommand = takeMessageId();
        const notice = takeMessageId();
        const chatCommand = takeMessageId();

        await seedUserMessage(chatId, target, { text: 'opencode go' });
        await seedUserMessage(chatId, modelCommand, { text: '/model@AfterSchoolTeatimeBot' });
        await seedNotice(chatId, notice, modelCommand, '切换为：`gemini-4-argon`');
        await seedUserMessage(chatId, chatCommand, {
            replyToId: target,
            text: '/chat 3',
            chatCommand: serializeChatCommand({
                selection: { type: 'count', count: 3 },
                userScope: { type: 'anyone', limit: Infinity },
                prompt: null,
            }),
        });

        const telegram = createFakeTelegram();
        const ctx = contextOf(
            replyUpdate({
                chatId,
                messageId: chatCommand,
                userId: ALICE.id,
                text: '/chat 3',
                replyToMessageId: target,
            }),
            telegram
        );

        const outcome = await quietly(() => dealChatCommand(ctx));
        expect(outcome.type === 'ready', `a valid summon is ready (got ${outcome.type})`);

        const linked = await queries.getLinkedMessageIds(chatId, [chatCommand]);
        const attached = linked.get(chatCommand) ?? [];
        expect(attached.includes(notice), 'the bot notice is one of the attached messages');
        expect(attached.includes(modelCommand), 'the command message is attached as any other message');
    })
);

cases.push(
    await runCase('a context quotes the notice and pulls in the command it answers', async () => {
        const chatId = takeChatId();
        const target = takeMessageId();
        const modelCommand = takeMessageId();
        const notice = takeMessageId();
        const chatCommand = takeMessageId();

        await seedUserMessage(chatId, target, { text: 'opencode go' });
        await seedUserMessage(chatId, modelCommand, { text: '/model@AfterSchoolTeatimeBot' });
        await seedNotice(chatId, notice, modelCommand, '切换为：`gemini-4-argon`');
        await seedUserMessage(chatId, chatCommand, {
            replyToId: target,
            text: '/chat 1',
            chatCommand: serializeChatCommand({
                selection: { type: 'count', count: 1 },
                userScope: { type: 'anyone', limit: Infinity },
                prompt: null,
            }),
        });
        // The notice was attached by the /chat command; its command message was not
        await queries.saveMessageLinks(chatId, chatCommand, [notice]);

        const commandRow = await Message.findOne({ where: { chatId, messageId: chatCommand } });
        if (!commandRow) throw new Error('seeded /chat command not found');

        const { messages } = await quietly(() => buildContext(commandRow));
        const assistantTurn = messages.find((turn) => turn.role === 'assistant');
        expect(assistantTurn !== undefined, 'the notice is an assistant turn');
        if (!assistantTurn) throw new Error('assistant turn missing');
        expect(
            /^\[#\d+\]\n/.test(textOfTurn(assistantTurn)),
            `the turn carries its context number (got ${JSON.stringify(textOfTurn(assistantTurn))})`
        );
        expect(
            textOfTurn(assistantTurn).includes('切换为：`gemini-4-argon`'),
            `the notice text is quoted (got ${JSON.stringify(textOfTurn(assistantTurn))})`
        );
        expect(
            messages.some(
                (turn) => turn.role === 'user' && textOfTurn(turn).includes('/model@AfterSchoolTeatimeBot')
            ),
            'the command message the notice answers is pulled into the context'
        );
    })
);

cases.push(
    await runCase('/model records its overview and keeps the edited menu in step', async () => {
        const chatId = takeChatId();
        const { bot, telegram } = createFakeBot();
        registerModelCommand(bot);
        menuLoad(bot);

        const commandId = takeMessageId();
        await quietly(() =>
            bot.handleUpdate(
                messageUpdate({ chatId, messageId: commandId, userId: ALICE.id, text: '/model' })
            )
        );

        const overview = await Message.findOne({ where: { chatId, fromBotSelf: true } });
        expect(overview !== null, 'the /model overview was recorded');
        expect((overview?.text ?? '').includes('当前模型：'), 'with the overview text');
        expect(overview?.replyToId === commandId, 'answering the /model command');

        const menuMessageId = overview?.messageId;
        if (menuMessageId === undefined) throw new Error('recorded overview has no message id');

        // A button press edits that same message in place: the stored text must follow
        telegram.reset();
        await quietly(() =>
            bot.handleUpdate(
                callbackUpdateFor(chatId, menuMessageId, ALICE.id, 'mdl:gemini-4-argon')
            )
        );

        const switched = await Message.findOne({ where: { chatId, messageId: menuMessageId } });
        expect(
            (switched?.text ?? '').includes('切换为：'),
            `the edited menu text replaces the stored overview (got ${JSON.stringify(switched?.text)})`
        );
        expect(switched?.replyToId === commandId, 'and keeps answering the /model command');
    })
);

cases.push(
    await runCase('/model <id> records the switch itself', async () => {
        const chatId = takeChatId();
        const { bot } = createFakeBot();
        registerModelCommand(bot);

        const commandId = takeMessageId();
        await quietly(() =>
            bot.handleUpdate(
                messageUpdate({
                    chatId,
                    messageId: commandId,
                    userId: ALICE.id,
                    text: '/model my-offline-model',
                })
            )
        );

        const row = await Message.findOne({ where: { chatId, fromBotSelf: true } });
        expect(row !== null, 'the switch was recorded');
        expect((row?.text ?? '').includes('切换为：'), 'with the switch text');
        expect((row?.text ?? '').includes('my-offline-model'), 'naming the new model');
        expect(row?.replyToId === commandId, 'answering the /model command');
    })
);

cases.push(
    await runCase('an edited message is recorded once and later updates rewrite that row', async () => {
        const chatId = takeChatId();
        const telegram = createFakeTelegram();
        const triggerId = takeMessageId();
        const editedMessageId = takeMessageId();
        const ctx = contextOf(
            messageUpdate({ chatId, messageId: triggerId, userId: ALICE.id, text: '/picgrok cat' }),
            telegram
        );

        // The generation commands turn their "Processing..." placeholder into the
        // error notice: no row exists yet, the edit creates it
        await updateBotNotice(ctx, editedMessageId, '生成图片失败：第一次', triggerId);
        const first = await Message.findOne({ where: { chatId, messageId: editedMessageId } });
        expect(first !== null, 'a message edited into a notice is recorded');
        expect(first?.fromBotSelf === true, "as the bot's own row");
        expect(first?.replyToId === triggerId, 'answering the triggering command');
        expect(first?.text === '生成图片失败：第一次', 'with the text it was edited to');

        // A second edit rewrites the same row (the /model menu's buttons do this)
        await updateBotNotice(ctx, editedMessageId, '生成图片失败：第二次');
        const rows = await Message.findAll({ where: { chatId, messageId: editedMessageId } });
        expect(rows.length === 1, 'one message id keeps exactly one row');
        expect(rows[0]?.text === '生成图片失败：第二次', 'with the latest text');
        expect(rows[0]?.replyToId === triggerId, 'and the original reply target');
    })
);

cases.push(
    await runCase('the panel tree renders a notice node with no reply detail to open', async () => {
        const chatId = takeChatId();
        const root = takeMessageId();
        const notice = takeMessageId();
        await seedUserMessage(chatId, root, { text: 'the starting point' });
        await seedNotice(chatId, notice, root, '切换为：`gemini-4-argon`');

        const chat: ChatRow = {
            chatId,
            type: 'supergroup',
            title: '测试群',
            username: null,
            firstSeenAt: new Date(),
            lastSeenAt: new Date(),
        };
        const view = await quietly(() => buildConversationTreeView(chat, 'observer', root));
        const node = view.nodes.find((candidate) => candidate.messageId === notice);
        expect(node !== undefined, 'the notice is a node of the tree');
        if (node === undefined) throw new Error('notice node missing');
        if (node.kind !== 'bot') throw new Error(`expected a bot node, got ${node.kind}`);
        expect(node.reply.versionCount === 0, 'with no stored reply versions');
        expect(node.reply.text === '切换为：`gemini-4-argon`', 'and the row text as its body');
    })
);

reportResults(cases);
