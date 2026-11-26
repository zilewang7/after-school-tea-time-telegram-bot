/**
 * Offline cases for message reactions: storage, inbound updates, canonical id
 * resolution across the delivery ledger and the older versions fallback, part
 * snapshots, cleanup and the existing bot-reaction call sites.
 *
 * Run: npx tsx scripts/offline/reactions.mts (or pnpm test:offline reactions)
 *
 * The runtime block that renders these rows is covered by
 * scripts/offline/reaction-context.mts; the tool by reaction-tool.mts.
 */
import { expect, reportResults, runCase, setupOfflineDb, takeMessageId, type CaseResult } from './harness.mts';
import { createFakeBot, groupChat, messageReactionUpdate, quietly, userOf } from './fake-telegram.mts';
import { API_CONSTANTS } from 'grammy';
import type { MessageReactionUpdated, Update } from 'grammy/types';
import type { ReactionEmoji } from '../../src/shared/reaction-emoji.js';
import type { ReplyPartKind } from '../../src/shared/reply-part.js';

// src modules read env at import time; the reaction writer reads it when called
process.env.BOT_USER_ID = '7777';
process.env.BOT_NAME = 'Bot';

const db = await setupOfflineDb();
const { BotResponse, ButtonState } = await import('../../src/db/botResponseDTO.js');
const { BotReplyMessage } = await import('../../src/db/botReplyMessageDTO.js');
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
const { deleteOrphanReplyParts } = await import('../../src/db/queries/reply-part-queries.js');
const { clearExpiredData } = await import('../../src/ingest/auto-save.js');
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
    createdAt?: Date;
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
        ...(options.createdAt === undefined
            ? {}
            : { createdAt: options.createdAt, updatedAt: options.createdAt }),
    });
    return firstMessageId;
};

/** One delivery-ledger row, as the delivery writes it right after a message goes out */
const seedReplyPart = async (input: {
    canonicalMessageId: number;
    messageId: number;
    part: ReplyPartKind;
    partIndex?: number | null;
    createdAt?: Date;
}): Promise<void> => {
    await BotReplyMessage.create({
        chatId: CHAT,
        messageId: input.messageId,
        canonicalMessageId: input.canonicalMessageId,
        part: input.part,
        partIndex: input.partIndex ?? null,
        ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    });
};

const rowsOf = (chatId: number, messageId: number) =>
    MessageReaction.findAll({ where: { chatId, messageId }, order: [['id', 'ASC']] });

/** One inbound `message_reaction` update carrying the given emoji set (empty = cancel) */
const applyPartReaction = async (messageId: number, emojis: readonly ReactionEmoji[]) =>
    applyInboundReaction(
        inboundOf({
            chatId: CHAT,
            messageId,
            userId: USER,
            newReaction: emojis.map((emoji) => ({ type: 'emoji' as const, emoji })),
        })
    );

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

results.push(await runCase('inbound: two parts of one reply keep their own reaction', async () => {
    const trigger = await seedUserMessage(CHAT, USER);
    const canonicalId = takeMessageId();
    const secondBodyId = takeMessageId();
    const stickerId = takeMessageId();
    await seedBotReply({
        chatId: CHAT,
        userMessageId: trigger,
        messageIds: [canonicalId, secondBodyId, stickerId],
    });
    await seedReplyPart({ canonicalMessageId: canonicalId, messageId: canonicalId, part: 'body', partIndex: 1 });
    await seedReplyPart({ canonicalMessageId: canonicalId, messageId: secondBodyId, part: 'body', partIndex: 2 });
    await seedReplyPart({ canonicalMessageId: canonicalId, messageId: stickerId, part: 'sticker' });

    const firstPart = await applyPartReaction(canonicalId, ['👍']);
    expect(
        firstPart.canonicalMessageId === canonicalId && firstPart.stored,
        'the first body part normalizes to the reply'
    );
    const secondPart = await applyPartReaction(secondBodyId, ['❤']);
    expect(secondPart.canonicalMessageId === canonicalId, 'the second body part too');
    const stickerPart = await applyPartReaction(stickerId, ['🤣']);
    expect(stickerPart.canonicalMessageId === canonicalId, 'and the sticker');

    const threeParts = await rowsOf(CHAT, canonicalId);
    expect(threeParts.length === 3, `three parts, three rows (got ${threeParts.length})`);
    const sourceRowOf = (sourceMessageId: number) =>
        threeParts.find((row) => row.sourceMessageId === sourceMessageId);
    expect(
        sourceRowOf(canonicalId)?.part === 'body' &&
            sourceRowOf(canonicalId)?.partIndex === 1 &&
            sourceRowOf(canonicalId)?.emoji === '👍',
        'body/1 keeps its own part snapshot and emoji'
    );
    expect(
        sourceRowOf(secondBodyId)?.part === 'body' &&
            sourceRowOf(secondBodyId)?.partIndex === 2 &&
            sourceRowOf(secondBodyId)?.emoji === '❤',
        'body/2 does not overwrite body/1'
    );
    expect(
        sourceRowOf(stickerId)?.part === 'sticker' &&
            sourceRowOf(stickerId)?.partIndex === null &&
            sourceRowOf(stickerId)?.emoji === '🤣',
        'the sticker is a part of its own'
    );

    // Changing one part's reaction replaces only that part's row
    await applyPartReaction(secondBodyId, ['🔥']);
    const afterChange = await rowsOf(CHAT, canonicalId);
    expect(afterChange.length === 3, `still one row per part (got ${afterChange.length})`);
    expect(
        afterChange.find((row) => row.sourceMessageId === secondBodyId)?.emoji === '🔥',
        'the changed part holds the new emoji'
    );
    expect(
        afterChange.find((row) => row.sourceMessageId === canonicalId)?.emoji === '👍',
        'another body part is untouched'
    );
    expect(
        afterChange.find((row) => row.sourceMessageId === stickerId)?.emoji === '🤣',
        'the sticker is untouched'
    );

    // Cancelling one part leaves the other parts' rows
    await applyPartReaction(stickerId, []);
    const afterCancel = await rowsOf(CHAT, canonicalId);
    expect(afterCancel.length === 2, `two parts left (got ${afterCancel.length})`);
    expect(afterCancel.every((row) => row.sourceMessageId !== stickerId), 'only the cancelled part lost its row');
    expect(
        afterCancel.some((row) => row.emoji === '👍') && afterCancel.some((row) => row.emoji === '🔥'),
        'the other parts still stand'
    );
}));

results.push(await runCase('inbound: a legacy part-less row is replaced by the first update', async () => {
    const trigger = await seedUserMessage(CHAT, USER);
    const canonicalId = takeMessageId();
    const secondBodyId = takeMessageId();
    await seedBotReply({ chatId: CHAT, userMessageId: trigger, messageIds: [canonicalId, secondBodyId] });
    await seedReplyPart({ canonicalMessageId: canonicalId, messageId: canonicalId, part: 'body', partIndex: 1 });
    await seedReplyPart({ canonicalMessageId: canonicalId, messageId: secondBodyId, part: 'body', partIndex: 2 });
    // Written before the parts model: same actor, same reply, part unknown
    await MessageReaction.create({
        chatId: CHAT,
        messageId: canonicalId,
        sourceMessageId: canonicalId,
        part: null,
        partIndex: null,
        userId: USER,
        actorChatId: null,
        userName: 'user-42',
        fromBotSelf: false,
        kind: 'emoji',
        emoji: '🎉',
        customEmojiId: null,
        createdAt: new Date(Date.now() - DAY_MS),
    });

    const applied = await applyPartReaction(secondBodyId, ['❤']);
    expect(applied.canonicalMessageId === canonicalId, 'the update normalizes to the reply');
    const rows = await rowsOf(CHAT, canonicalId);
    expect(rows.length === 1, `the legacy row is replaced, not stacked (got ${rows.length})`);
    expect(
        rows[0]?.sourceMessageId === secondBodyId &&
            rows[0]?.part === 'body' &&
            rows[0]?.partIndex === 2,
        'the new row carries the source and the part'
    );
    expect(rows[0]?.emoji === '❤', 'and the new emoji');
}));

results.push(await runCase('inbound: the ledger alone normalizes a reply before finalize', async () => {
    const trigger = await seedUserMessage(CHAT, USER);
    const canonicalId = takeMessageId();
    const continuationId = takeMessageId();
    // The reply is still streaming: versions are empty, so only the ledger knows it
    await BotResponse.create({
        messageId: canonicalId,
        chatId: CHAT,
        userMessageId: trigger,
        currentVersionIndex: 0,
        versions: JSON.stringify([]),
        buttonState: ButtonState.NONE,
        metadata: JSON.stringify({ model: 'offline-model', hasImage: false }),
    });
    await seedReplyPart({ canonicalMessageId: canonicalId, messageId: canonicalId, part: 'body', partIndex: 1 });
    await seedReplyPart({ canonicalMessageId: canonicalId, messageId: continuationId, part: 'body', partIndex: 2 });

    const applied = await applyPartReaction(continuationId, ['👍']);
    expect(
        applied.canonicalMessageId === canonicalId && applied.stored,
        `the ledger normalized it before finalize (got ${String(applied.canonicalMessageId)})`
    );
    const rows = await rowsOf(CHAT, canonicalId);
    expect(rows.length === 1, `one row (got ${rows.length})`);
    expect(
        rows[0]?.sourceMessageId === continuationId &&
            rows[0]?.part === 'body' &&
            rows[0]?.partIndex === 2,
        'with the part snapshot only the ledger could give'
    );
}));

results.push(await runCase('inbound: without a ledger row the versions are the fallback', async () => {
    const trigger = await seedUserMessage(CHAT, USER);
    const canonicalId = takeMessageId();
    const chunkId = takeMessageId();
    await seedBotReply({ chatId: CHAT, userMessageId: trigger, messageIds: [canonicalId, chunkId] });

    const applied = await applyPartReaction(chunkId, ['❤']);
    expect(applied.canonicalMessageId === canonicalId, 'the chunk still normalizes through the versions');
    const rows = await rowsOf(CHAT, canonicalId);
    expect(rows.length === 1, `one row (got ${rows.length})`);
    expect(rows[0]?.sourceMessageId === chunkId, 'the source is the message the update named');
    expect(rows[0]?.part === null && rows[0]?.partIndex === null, 'the part is unknown, not guessed');
}));

results.push(await runCase('inbound: a bot body that reads like an album sub-image is not normalized', async () => {
    const parentId = await seedUserMessage(CHAT, USER, 'album opener');
    const botBodyId = takeMessageId();
    await Message.create({
        chatId: CHAT,
        messageId: botBodyId,
        fromBotSelf: true,
        userId: 7777,
        date: new Date(),
        userName: 'Bot',
        text: `sub image of [${parentId}]`,
        replyToId: parentId,
    });

    expect((await resolveReactionTargetId(CHAT, botBodyId)) === botBodyId, 'a bot message keeps its own id');
    const applied = await applyPartReaction(botBodyId, ['👍']);
    expect(applied.canonicalMessageId === botBodyId && applied.stored, 'the reaction hangs on the bot message');
    expect((await rowsOf(CHAT, botBodyId)).length === 1, 'one row there');
    expect((await rowsOf(CHAT, parentId)).length === 0, 'the message it replies to stays untouched');
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

results.push(await runCase('cleanup: ledger rows leave with their message, reply and orphan sweep', async () => {
    const staleDate = new Date(Date.now() - 8 * DAY_MS);

    // The part message has a stale row of its own: the message cascade removes it
    const stalePartMessageId = takeMessageId();
    await Message.create({
        chatId: CHAT,
        messageId: stalePartMessageId,
        fromBotSelf: false,
        userId: USER,
        date: staleDate,
        userName: '张三',
        text: 'an old body part',
    });
    await seedReplyPart({
        canonicalMessageId: stalePartMessageId,
        messageId: stalePartMessageId,
        part: 'body',
        partIndex: 1,
        createdAt: staleDate,
    });

    // The reply's first message row is stale: both cleanup keys remove every part
    const canonicalWithMessageId = takeMessageId();
    await Message.create({
        chatId: CHAT,
        messageId: canonicalWithMessageId,
        fromBotSelf: true,
        userId: 7777,
        date: staleDate,
        userName: 'Bot',
        text: 'an old reply',
    });
    const partWithoutRowId = takeMessageId();
    await seedReplyPart({
        canonicalMessageId: canonicalWithMessageId,
        messageId: canonicalWithMessageId,
        part: 'body',
        partIndex: 1,
        createdAt: staleDate,
    });
    await seedReplyPart({
        canonicalMessageId: canonicalWithMessageId,
        messageId: partWithoutRowId,
        part: 'sticker',
        createdAt: staleDate,
    });

    // The reply has a stale response row and no message row of its own
    const responseOnlyCanonicalId = takeMessageId();
    const responseOnlyPartId = takeMessageId();
    await seedBotReply({
        chatId: CHAT,
        userMessageId: takeMessageId(),
        messageIds: [responseOnlyCanonicalId, responseOnlyPartId],
        createdAt: staleDate,
    });
    await seedReplyPart({
        canonicalMessageId: responseOnlyCanonicalId,
        messageId: responseOnlyCanonicalId,
        part: 'body',
        partIndex: 1,
        createdAt: staleDate,
    });
    await seedReplyPart({
        canonicalMessageId: responseOnlyCanonicalId,
        messageId: responseOnlyPartId,
        part: 'picture',
        partIndex: 1,
        createdAt: staleDate,
    });

    // Neither table holds this one: only the orphan sweep can see it
    const orphanCanonicalId = takeMessageId();
    await seedReplyPart({
        canonicalMessageId: orphanCanonicalId,
        messageId: takeMessageId(),
        part: 'body',
        partIndex: 1,
        createdAt: staleDate,
    });

    // A young orphan is not swept
    const youngOrphanCanonicalId = takeMessageId();
    await seedReplyPart({
        canonicalMessageId: youngOrphanCanonicalId,
        messageId: takeMessageId(),
        part: 'body',
        partIndex: 1,
    });

    await quietly(() => clearExpiredData());

    const partsOf = async (canonicalMessageId: number): Promise<number> =>
        BotReplyMessage.count({ where: { chatId: CHAT, canonicalMessageId } });
    expect((await partsOf(stalePartMessageId)) === 0, 'a part whose own message row expired went with it');
    expect((await partsOf(canonicalWithMessageId)) === 0, 'every part of a reply whose first message row expired');
    expect((await partsOf(responseOnlyCanonicalId)) === 0, 'parts of a reply whose response row expired');
    expect((await partsOf(orphanCanonicalId)) === 0, 'the orphan sweep removed the rows no table holds');
    expect((await partsOf(youngOrphanCanonicalId)) === 1, 'a part younger than the cutoff is kept');
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

results.push(await runCase('deleteOrphanReplyParts keeps a part whose reply still exists', async () => {
    const trigger = await seedUserMessage(CHAT, USER);
    const canonicalId = await seedBotReply({
        chatId: CHAT,
        userMessageId: trigger,
        messageIds: [takeMessageId()],
    });
    const partId = takeMessageId();
    await seedReplyPart({ canonicalMessageId: canonicalId, messageId: partId, part: 'body', partIndex: 1 });
    // Old enough for the sweep, but its reply row still exists
    await BotReplyMessage.update(
        { createdAt: new Date(Date.now() - 8 * DAY_MS) },
        { where: { chatId: CHAT, messageId: partId } }
    );
    const deleted = await deleteOrphanReplyParts(new Date(Date.now() - 7 * DAY_MS));
    expect(deleted === 0, `a live reply keeps its part (deleted ${deleted})`);
    expect(
        (await BotReplyMessage.count({ where: { chatId: CHAT, canonicalMessageId: canonicalId } })) === 1,
        'the row survived'
    );
}));

reportResults(results);
