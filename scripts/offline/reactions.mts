/**
 * Offline cases for message reactions: storage, inbound updates, canonical id
 * resolution, cleanup and the existing bot-reaction call sites.
 *
 * Run: npx tsx scripts/offline/reactions.mts (or pnpm test:offline reactions)
 *
 * The runtime block that renders these rows is covered by
 * scripts/offline/reaction-context.mts (commit 2); the tool by
 * reaction-tool.mts (commit 3).
 */
import { expect, reportResults, runCase, setupOfflineDb, takeMessageId, type CaseResult } from './harness.mts';
import { createFakeBot, groupChat, messageReactionUpdate, quietly, userOf } from './fake-telegram.mts';
import { API_CONSTANTS } from 'grammy';
import type { MessageReactionUpdated, Update } from 'grammy/types';

// src modules read env at import time; the reaction writer reads it when called
process.env.BOT_USER_ID = '7777';
process.env.BOT_NAME = 'Bot';

const db = await setupOfflineDb();
const { BotResponse, ButtonState } = await import('../../src/db/botResponseDTO.js');
const { MessageReaction } = await import('../../src/db/messageReactionDTO.js');
const { applyInboundReaction, autoReaction } = await import('../../src/db/message-reaction-save.js');
const {
    applyUserReactionUpdate,
    deleteOrphanReactions,
    listReactionsForMessages,
    recordBotReaction,
    replaceBotReaction,
    resolveReactionTargetId,
} = await import('../../src/db/queries/reaction-queries.js');
const { clearExpiredData } = await import('../../src/db/autoSave.js');
const { registerReactCommand } = await import('../../src/cmd/commands/react.js');
const { POLLING_ALLOWED_UPDATES } = await import('../../src/config/polling-updates.js');
const { Message } = await import('../../src/db/messageDTO.js');

const CHAT = -1009123000001;
const USER = 42;
const DAY_MS = 24 * 60 * 60 * 1000;

type ReactionUpdateInput = Parameters<typeof messageReactionUpdate>[0];

/** The typed `message_reaction` payload of a constructed update */
const inboundOf = (input: ReactionUpdateInput): MessageReactionUpdated => {
    const update = messageReactionUpdate(input);
    if (update.message_reaction === undefined) throw new Error('a reaction update is expected');
    return update.message_reaction;
};

/** A stored user message (what autoSave would have written) */
const seedUserMessage = async (chatId: number, userId: number, text = 'hello'): Promise<number> => {
    const messageId = takeMessageId();
    await db.saveMessage({
        chatId,
        messageId,
        userId,
        date: new Date(),
        userName: '张三',
        message: text,
    });
    return messageId;
};

/** A bot reply stored under its first message id, with one version layout */
const seedBotReply = async (options: {
    chatId: number;
    userMessageId: number;
    messageIds: number[];
    thinkingLinkToken?: string;
}): Promise<number> => {
    const firstMessageId = options.messageIds[0] ?? takeMessageId();
    await BotResponse.create({
        messageId: firstMessageId,
        chatId: options.chatId,
        userMessageId: options.userMessageId,
        currentVersionIndex: 0,
        versions: JSON.stringify([
            {
                versionId: 1,
                createdAt: new Date().toISOString(),
                messageIds: options.messageIds,
                currentMessageId: options.messageIds[options.messageIds.length - 1] ?? firstMessageId,
                text: 'the whole reply text',
                wasStoppedByUser: false,
                ...(options.thinkingLinkToken === undefined
                    ? {}
                    : { thinkingLinkToken: options.thinkingLinkToken }),
            },
        ]),
        buttonState: ButtonState.NONE,
        metadata: JSON.stringify({ model: 'offline-model', hasImage: false }),
    });
    return firstMessageId;
};

const rowsOf = (chatId: number, messageId: number) =>
    MessageReaction.findAll({ where: { chatId, messageId }, order: [['id', 'ASC']] });

const results: CaseResult[] = [];

results.push(await runCase('inbound: a user adds, replaces and removes a reaction', async () => {
    const messageId = await seedUserMessage(CHAT, USER);
    const { bot } = createFakeBot();
    autoReaction(bot);

    await bot.handleUpdate(
        messageReactionUpdate({
            chatId: CHAT,
            messageId,
            userId: USER,
            newReaction: [{ type: 'emoji', emoji: '👍' }],
        })
    );
    const added = await rowsOf(CHAT, messageId);
    expect(added.length === 1, `one row after adding (got ${added.length})`);
    expect(added[0]?.emoji === '👍' && added[0]?.kind === 'emoji', 'the emoji is stored');
    expect(added[0]?.userId === USER && added[0]?.fromBotSelf === false, 'the actor is stored');
    expect(added[0]?.userName === 'user-42', 'the display name snapshot is stored');

    await bot.handleUpdate(
        messageReactionUpdate({
            chatId: CHAT,
            messageId,
            userId: USER,
            oldReaction: [{ type: 'emoji', emoji: '👍' }],
            newReaction: [{ type: 'emoji', emoji: '❤' }],
        })
    );
    const replaced = await rowsOf(CHAT, messageId);
    expect(replaced.length === 1 && replaced[0]?.emoji === '❤', 'a changed reaction replaces the old row');

    await bot.handleUpdate(
        messageReactionUpdate({
            chatId: CHAT,
            messageId,
            userId: USER,
            oldReaction: [{ type: 'emoji', emoji: '❤' }],
            newReaction: [],
        })
    );
    expect((await rowsOf(CHAT, messageId)).length === 0, 'removing the reaction deletes its row');
}));

results.push(await runCase('inbound: a re-delivered update changes nothing', async () => {
    const messageId = await seedUserMessage(CHAT, USER);
    const inbound = inboundOf({
        chatId: CHAT,
        messageId,
        userId: USER,
        newReaction: [{ type: 'emoji', emoji: '🔥' }],
    });
    await applyInboundReaction(inbound);
    await applyInboundReaction(inbound);
    expect((await rowsOf(CHAT, messageId)).length === 1, 'state-like writes are idempotent');
}));

results.push(await runCase('inbound: a bot reply chunk resolves to its canonical id', async () => {
    const trigger = await seedUserMessage(CHAT, USER);
    const chunkId = takeMessageId();
    const canonicalId = await seedBotReply({
        chatId: CHAT,
        userMessageId: trigger,
        messageIds: [takeMessageId(), chunkId],
    });
    const applied = await applyInboundReaction(
        inboundOf({
            chatId: CHAT,
            messageId: chunkId,
            userId: USER,
            newReaction: [{ type: 'emoji', emoji: '🎉' }],
        })
    );
    expect(
        applied.canonicalMessageId === canonicalId,
        `chunk normalizes to the first id (got ${String(applied.canonicalMessageId)})`
    );
    expect(applied.stored === true, 'the reaction was stored');
    const rows = await rowsOf(CHAT, canonicalId);
    expect(rows.length === 1 && rows[0]?.emoji === '🎉', 'the row hangs on the canonical id');
}));

results.push(await runCase('inbound: a message no table holds is dropped silently', async () => {
    const missingId = takeMessageId();
    const applied = await applyInboundReaction(
        inboundOf({
            chatId: CHAT,
            messageId: missingId,
            userId: USER,
            newReaction: [{ type: 'emoji', emoji: '👍' }],
        })
    );
    expect(applied.stored === false && applied.canonicalMessageId === null, 'nothing is resolved or written');
    expect((await rowsOf(CHAT, missingId)).length === 0, 'no orphan row is created');
}));

results.push(await runCase('inbound: custom, paid and anonymous reactions are stored', async () => {
    const messageId = await seedUserMessage(CHAT, USER);
    await applyInboundReaction(
        inboundOf({
            chatId: CHAT,
            messageId,
            userId: USER,
            newReaction: [
                { type: 'custom_emoji', custom_emoji_id: 'custom-1' },
                { type: 'paid' },
            ],
        })
    );
    const self = await rowsOf(CHAT, messageId);
    expect(self.length === 2, `both variants stored (got ${self.length})`);
    expect(self.some((row) => row.kind === 'custom_emoji' && row.customEmojiId === 'custom-1'), 'custom emoji id kept');
    expect(self.some((row) => row.kind === 'paid'), 'paid reaction kept');

    const anonymousId = await seedUserMessage(CHAT, USER);
    await applyInboundReaction(
        inboundOf({
            chatId: CHAT,
            messageId: anonymousId,
            actorChatId: -1005550001111,
            newReaction: [{ type: 'emoji', emoji: '💩' }],
        })
    );
    const anonymous = await rowsOf(CHAT, anonymousId);
    expect(anonymous.length === 1 && anonymous[0]?.userId === null, 'anonymous actor has no user id');
    expect(anonymous[0]?.actorChatId === -1005550001111, 'the actor chat is stored');
    expect(anonymous[0]?.userName === '匿名管理员', 'the actor chat title is the name snapshot');
}));

results.push(await runCase('inbound: an album sub-image reaction hangs on its parent', async () => {
    const parentId = await seedUserMessage(CHAT, USER, 'album opener');
    const subImageId = takeMessageId();
    await Message.create({
        chatId: CHAT,
        messageId: subImageId,
        fromBotSelf: false,
        userId: USER,
        date: new Date(),
        userName: '张三',
        text: `sub image of [${parentId}]`,
        replyToId: parentId,
    });
    expect(
        (await resolveReactionTargetId(CHAT, subImageId)) === parentId,
        'sub-image resolves to the album opener'
    );
    await applyInboundReaction(
        inboundOf({
            chatId: CHAT,
            messageId: subImageId,
            userId: USER,
            newReaction: [{ type: 'emoji', emoji: '🥰' }],
        })
    );
    expect((await rowsOf(CHAT, parentId)).length === 1, 'the reaction is stored on the parent');
}));

results.push(await runCase('cleanup: reactions leave with their message, orphan rows are swept', async () => {
    const staleDate = new Date(Date.now() - 8 * DAY_MS);
    const staleMessageId = takeMessageId();
    await Message.create({
        chatId: CHAT,
        messageId: staleMessageId,
        fromBotSelf: false,
        userId: USER,
        date: staleDate,
        userName: '张三',
        text: 'an old message',
    });
    await MessageReaction.create({
        chatId: CHAT,
        messageId: staleMessageId,
        userId: USER,
        actorChatId: null,
        userName: '张三',
        fromBotSelf: false,
        kind: 'emoji',
        emoji: '👍',
        customEmojiId: null,
        createdAt: staleDate,
    });
    // A row with no message/bot response at all: only the NOT EXISTS sweep can see it
    const orphanMessageId = takeMessageId();
    await MessageReaction.create({
        chatId: CHAT,
        messageId: orphanMessageId,
        userId: USER,
        actorChatId: null,
        userName: '张三',
        fromBotSelf: false,
        kind: 'emoji',
        emoji: '🔥',
        customEmojiId: null,
        createdAt: staleDate,
    });

    await quietly(() => clearExpiredData());

    expect((await Message.count({ where: { chatId: CHAT, messageId: staleMessageId } })) === 0, 'the message is gone');
    expect((await rowsOf(CHAT, staleMessageId)).length === 0, 'its reaction went with it in the same pass');
    expect((await rowsOf(CHAT, orphanMessageId)).length === 0, 'the orphan sweep deleted the row no message holds');
}));

results.push(await runCase('bot reaction: replace keeps the previous emoji, clear removes the row', async () => {
    const messageId = await seedUserMessage(CHAT, USER);
    const first = await replaceBotReaction(CHAT, messageId, '👍');
    expect(first.previousEmoji === null, 'no previous reaction on the first write');
    const rows = await rowsOf(CHAT, messageId);
    expect(rows.length === 1 && rows[0]?.fromBotSelf === true, 'one bot row');
    expect(rows[0]?.userId === 7777 && rows[0]?.userName === 'Bot', 'the bot user is stored');

    const second = await replaceBotReaction(CHAT, messageId, '😂');
    expect(second.previousEmoji === '👍', 'the previous emoji is returned for the tool copy');
    expect((await rowsOf(CHAT, messageId)).length === 1, 'still one row');

    const cleared = await replaceBotReaction(CHAT, messageId, null);
    expect(cleared.previousEmoji === '😂', 'clearing reports what was there');
    expect((await rowsOf(CHAT, messageId)).length === 0, 'the row is removed');
}));

results.push(await runCase('bot reaction: recordBotReaction normalizes chunks and refuses unknown messages', async () => {
    const trigger = await seedUserMessage(CHAT, USER);
    const canonicalId = await seedBotReply({
        chatId: CHAT,
        userMessageId: trigger,
        messageIds: [takeMessageId()],
    });
    const chunkOnly = takeMessageId();
    // The version was laid out again after a switch: only the new layout names the chunk
    await BotResponse.update(
        {
            versions: JSON.stringify([
                {
                    versionId: 2,
                    createdAt: new Date().toISOString(),
                    messageIds: [canonicalId, chunkOnly],
                    currentMessageId: chunkOnly,
                    text: 'switched layout',
                    wasStoppedByUser: false,
                },
            ]),
            currentVersionIndex: 0,
        },
        { where: { chatId: CHAT, messageId: canonicalId } }
    );
    expect((await recordBotReaction(CHAT, chunkOnly, '🏆')) === true, 'a chunk id is recorded');
    expect((await rowsOf(CHAT, canonicalId)).length === 1, 'under the canonical id');
    expect((await recordBotReaction(CHAT, takeMessageId(), '🏆')) === false, 'an unknown message is refused');
}));

results.push(await runCase('/react: the bot reaction is recorded after Telegram accepted it', async () => {
    const trigger = await seedUserMessage(CHAT, USER);
    const replyId = await seedBotReply({ chatId: CHAT, userMessageId: trigger, messageIds: [takeMessageId()] });
    const { bot, telegram } = createFakeBot();
    registerReactCommand(bot);

    const update: Update = {
        update_id: 1,
        message: {
            message_id: takeMessageId(),
            date: Math.floor(Date.now() / 1000),
            chat: groupChat(CHAT),
            from: userOf(USER),
            text: '/react 👍',
            entities: [{ type: 'bot_command', offset: 0, length: 6 }],
            reply_to_message: {
                message_id: replyId,
                date: 0,
                chat: groupChat(CHAT),
                from: userOf(7777),
                text: 'the bot reply',
                reply_to_message: undefined,
            },
        },
    };
    await quietly(() => bot.handleUpdate(update));

    const call = telegram.callsOf('setMessageReaction')[0];
    expect(call !== undefined, 'Telegram was asked for the reaction');
    expect(call?.payload.chat_id === CHAT && call?.payload.message_id === replyId, 'it targets the replied message');
    expect(
        (await rowsOf(CHAT, replyId)).some((row) => row.fromBotSelf && row.emoji === '👍'),
        'the row is recorded'
    );
}));

results.push(await runCase('allowed_updates: the default set plus message_reaction', async () => {
    const expected = [...API_CONSTANTS.DEFAULT_UPDATE_TYPES, 'message_reaction'];
    expect(
        JSON.stringify(POLLING_ALLOWED_UPDATES) === JSON.stringify(expected),
        `derived list (got ${JSON.stringify(POLLING_ALLOWED_UPDATES)})`
    );
    const allowed = new Set<string>(POLLING_ALLOWED_UPDATES);
    expect(allowed.has('message_reaction'), 'reaction updates are requested');
    expect(!allowed.has('chat_member'), 'chat_member stays off');
    expect(!allowed.has('message_reaction_count'), 'anonymous counts stay off');
}));

results.push(await runCase('listReactionsForMessages returns only the requested messages', async () => {
    const first = await seedUserMessage(CHAT, USER);
    const second = await seedUserMessage(CHAT, USER);
    await replaceBotReaction(CHAT, first, '👍');
    await applyUserReactionUpdate({
        chatId: CHAT,
        messageId: second,
        actor: { userId: USER, actorChatId: null, userName: '张三' },
        reactions: [{ kind: 'emoji', emoji: '❤', customEmojiId: null }],
    });
    const rows = await listReactionsForMessages(CHAT, [first, second]);
    expect(rows.length === 2, `both messages listed (got ${rows.length})`);
    expect(rows[0]?.messageId === first && rows[1]?.messageId === second, 'ordered by message id');
    expect((await listReactionsForMessages(CHAT, [])).length === 0, 'empty input returns nothing');
}));

results.push(await runCase('deleteOrphanReactions keeps rows whose message still exists', async () => {
    const liveId = await seedUserMessage(CHAT, USER);
    await replaceBotReaction(CHAT, liveId, '👍');
    const old = new Date(Date.now() - 8 * DAY_MS);
    // Backdate the live row: it is old, but its message still exists
    await MessageReaction.update({ createdAt: old }, { where: { chatId: CHAT, messageId: liveId } });
    const deleted = await deleteOrphanReactions(new Date(Date.now() - 7 * DAY_MS));
    expect(deleted === 0, `a live message keeps its reaction (deleted ${deleted})`);
    expect((await rowsOf(CHAT, liveId)).length === 1, 'the row survived');
}));

reportResults(results);
