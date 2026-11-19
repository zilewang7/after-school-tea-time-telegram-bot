/**
 * Offline cases for what a reply publishes for its `#N` display links: which
 * message id a context number opens.
 *
 * A reply is stored under its first message id, but a long-CoT reply leads with
 * the link message that hides the thinking (design 2026-1111-1327) — that
 * message carries no body, so the number must open the message the body starts
 * in. The current version decides, and a bot message without a stored reply
 * keeps its own id (a notice the bot wrote through the message table alone).
 *
 * Run: npx tsx scripts/offline/context-bot-links.mts
 */
delete process.env.LUOXU_PREVIEW_URL;

import {
    expect,
    reportResults,
    runCase,
    setupOfflineDb,
    takeMessageId,
    type CaseResult,
} from './harness.mts';
import type { ResponseVersion } from '../../src/db/botResponseDTO.js';

const db = await setupOfflineDb();
const dbIndex = await import('../../src/db/index.js');
const { buildContext } = await import('../../src/reply/context-builder.js');
const { getContextNumbering } = await import('../../src/state.js');
const { buildMessageLinkResolver } = await import('../../src/telegram/message-link.js');
const { captureResumeFacts } = await import('../../src/reply/resume/resume-facts.js');
const { createReplyToolState } = await import('../../src/reply/tools/reply-tool-state.js');

const { Message } = db;
const { BotResponse, ButtonState } = dbIndex;

/** A supergroup: only these have the t.me/c/<internal id>/<message id> link form */
const CHAT_ID = -1001234500001;
const USER_ID = 42;
const BOT_USER_ID = 7777;

interface SeedMessageOptions {
    messageId?: number;
    replyToId?: number | null;
    text?: string | null;
    fromBot?: boolean;
}

const seedMessage = async (options: SeedMessageOptions = {}): Promise<number> => {
    const messageId = options.messageId ?? takeMessageId();
    await Message.create({
        chatId: CHAT_ID,
        messageId,
        fromBotSelf: options.fromBot === true,
        userId: options.fromBot === true ? BOT_USER_ID : USER_ID,
        date: new Date(messageId * 1000),
        userName: options.fromBot === true ? 'Bot' : 'tester',
        text: 'text' in options ? options.text ?? null : `message ${messageId}`,
        quoteText: null,
        file: null,
        fileMime: null,
        fileUniqueId: null,
        replyToId: options.replyToId ?? null,
        chatCommand: null,
        modelParts: null,
        mediaHint: null,
        forwardOrigin: null,
        forwardFromId: null,
        viaBot: null,
        ocrText: null,
    });
    return messageId;
};

/**
 * One stored version's message layout: the Telegram messages the version
 * occupies, first to last, and whether it leads with the CoT link message.
 */
interface VersionLayout {
    readonly messageIds: readonly number[];
    readonly thinkingLinkToken?: string;
}

interface SeedBotReplyOptions {
    readonly userMessageId: number;
    /** The reply's versions; each gets its first message id (the id a context reads) */
    readonly layoutsOf: (firstMessageId: number) => readonly VersionLayout[];
    /** Default: the last version */
    readonly currentVersionIndex?: number;
}

/**
 * A stored bot reply: its message row (kept under the first message id) and its
 * BotResponse row with the given version layouts.
 */
const seedBotReply = async (options: SeedBotReplyOptions): Promise<number> => {
    const firstMessageId = takeMessageId();
    const layouts = options.layoutsOf(firstMessageId);
    if (layouts.length === 0) throw new Error('a reply needs at least one version');
    await seedMessage({
        messageId: firstMessageId,
        replyToId: options.userMessageId,
        text: 'the whole reply text',
        fromBot: true,
    });

    const versions: ResponseVersion[] = layouts.map((layout, index) => {
        const messageIds = layout.messageIds.length > 0 ? [...layout.messageIds] : [firstMessageId];
        return {
            versionId: index + 1,
            createdAt: new Date(index * 1000).toISOString(),
            messageIds,
            currentMessageId: messageIds[messageIds.length - 1] ?? firstMessageId,
            text: 'the whole reply text',
            wasStoppedByUser: false,
            ...(layout.thinkingLinkToken === undefined
                ? {}
                : { thinkingLinkToken: layout.thinkingLinkToken }),
        };
    });

    await BotResponse.create({
        messageId: firstMessageId,
        chatId: CHAT_ID,
        userMessageId: options.userMessageId,
        currentVersionIndex: options.currentVersionIndex ?? versions.length - 1,
        versions: JSON.stringify(versions),
        buttonState: ButtonState.NONE,
        metadata: JSON.stringify({ model: 'offline-model', hasImage: false }),
    });
    return firstMessageId;
};

type ReplySeed = Omit<SeedBotReplyOptions, 'userMessageId'>;

interface SeededConversation {
    /** The user message closing the chain; its context numbers the messages 1..N */
    readonly triggerMessageId: number;
    /** The bot replies, in the order they answer */
    readonly replyIds: readonly number[];
    /** The user messages between the replies, the trigger last */
    readonly followUpIds: readonly number[];
}

/**
 * A root message, the bot replies in order (each answering the message before
 * it), and a closing user trigger: the trigger's context numbers them 1..N.
 */
const seedConversation = async (replies: readonly ReplySeed[]): Promise<SeededConversation> => {
    let parentId = await seedMessage({ text: 'the conversation root' });
    const replyIds: number[] = [];
    const followUpIds: number[] = [];
    for (const reply of replies) {
        const replyId = await seedBotReply({ ...reply, userMessageId: parentId });
        replyIds.push(replyId);
        parentId = await seedMessage({ replyToId: replyId, text: 'a follow-up question' });
        followUpIds.push(parentId);
    }
    return { triggerMessageId: parentId, replyIds, followUpIds };
};

/** Build the trigger's context, which publishes the numbering for its links, and read it back */
const numberingOfContext = async (triggerMessageId: number): Promise<Map<number, number> | undefined> => {
    const trigger = await Message.findOne({ where: { chatId: CHAT_ID, messageId: triggerMessageId } });
    if (!trigger) throw new Error(`trigger ${triggerMessageId} is not stored`);
    await buildContext(trigger);
    return getContextNumbering(CHAT_ID, triggerMessageId);
};

const telegramUrlOf = (messageId: number): string =>
    `https://t.me/c/${String(CHAT_ID).slice(4)}/${messageId}`;

const results: CaseResult[] = [];

results.push(
    await runCase('a long-CoT reply number opens the message its body starts in', async () => {
        const bodyMessageId = takeMessageId();
        const { triggerMessageId } = await seedConversation([
            {
                layoutsOf: (firstMessageId) => [
                    { messageIds: [firstMessageId, bodyMessageId], thinkingLinkToken: 'cot-token' },
                ],
            },
        ]);

        const numbering = await numberingOfContext(triggerMessageId);
        expect(numbering?.get(2) === bodyMessageId, `#2 opens the body message (got ${numbering?.get(2)})`);
        expect(numbering?.get(3) === triggerMessageId, `the trigger opens itself (got ${numbering?.get(3)})`);
        const resolver = buildMessageLinkResolver(CHAT_ID, triggerMessageId);
        expect(
            resolver?.(2) === telegramUrlOf(bodyMessageId),
            `#2 links to the body message (got ${resolver?.(2)})`
        );
    })
);

results.push(
    await runCase('a reply without a CoT link keeps its first message', async () => {
        const laterMessageId = takeMessageId();
        const { triggerMessageId, replyIds } = await seedConversation([
            {
                // A split body: the first message still carries the answer's head
                layoutsOf: (firstMessageId) => [{ messageIds: [firstMessageId, laterMessageId] }],
            },
        ]);

        const numbering = await numberingOfContext(triggerMessageId);
        expect(numbering?.get(2) === replyIds[0], `#2 opens the reply's first message (got ${numbering?.get(2)})`);
    })
);

results.push(
    await runCase('the current version decides the number', async () => {
        const oldBodyMessageId = takeMessageId();
        const { triggerMessageId } = await seedConversation([
            {
                // Version 1 (current) leads with the CoT link; version 2 is the
                // latest but not shown, and has no link.
                layoutsOf: (firstMessageId) => [
                    { messageIds: [firstMessageId, oldBodyMessageId], thinkingLinkToken: 'cot-token' },
                    { messageIds: [firstMessageId] },
                ],
                currentVersionIndex: 0,
            },
        ]);

        const numbering = await numberingOfContext(triggerMessageId);
        expect(
            numbering?.get(2) === oldBodyMessageId,
            `the shown version decides (got ${numbering?.get(2)})`
        );
    })
);

results.push(
    await runCase('several bot replies each resolve their own number', async () => {
        const plainLaterMessageId = takeMessageId();
        const linkedBodyMessageId = takeMessageId();
        const { triggerMessageId, replyIds, followUpIds } = await seedConversation([
            {
                layoutsOf: (firstMessageId) => [{ messageIds: [firstMessageId, plainLaterMessageId] }],
            },
            {
                layoutsOf: (firstMessageId) => [
                    { messageIds: [firstMessageId, linkedBodyMessageId], thinkingLinkToken: 'cot-token' },
                ],
            },
        ]);

        const numbering = await numberingOfContext(triggerMessageId);
        expect(numbering?.get(2) === replyIds[0], `the plain reply opens its first message (got ${numbering?.get(2)})`);
        expect(numbering?.get(3) === followUpIds[0], `the user message between them opens itself (got ${numbering?.get(3)})`);
        expect(
            numbering?.get(4) === linkedBodyMessageId,
            `the linked reply opens its body (got ${numbering?.get(4)})`
        );
    })
);

results.push(
    await runCase('a bot message without a stored reply keeps its own id', async () => {
        const rootId = await seedMessage({ text: 'the conversation root' });
        const noticeId = await seedMessage({
            replyToId: rootId,
            text: 'a notice the bot wrote through the message table alone',
            fromBot: true,
        });
        const triggerMessageId = await seedMessage({ replyToId: noticeId, text: 'a follow-up question' });

        const numbering = await numberingOfContext(triggerMessageId);
        expect(numbering?.get(2) === noticeId, `the notice opens itself (got ${numbering?.get(2)})`);
    })
);

results.push(
    await runCase('a reply with no stored version keeps its own id', async () => {
        // A reply whose row was written before its version: the layout is unknown
        const rootId = await seedMessage({ text: 'the conversation root' });
        const replyId = takeMessageId();
        await BotResponse.create({
            messageId: replyId,
            chatId: CHAT_ID,
            userMessageId: rootId,
            currentVersionIndex: 0,
            versions: JSON.stringify([]),
            buttonState: ButtonState.PROCESSING,
            metadata: JSON.stringify({ model: 'offline-model', hasImage: false }),
        });
        await seedMessage({ messageId: replyId, replyToId: rootId, text: null, fromBot: true });
        const triggerMessageId = await seedMessage({ replyToId: replyId, text: 'a follow-up question' });

        const numbering = await numberingOfContext(triggerMessageId);
        expect(numbering?.get(2) === replyId, `a reply without a version opens itself (got ${numbering?.get(2)})`);
    })
);

results.push(
    await runCase('a continued reply keeps the published numbering', async () => {
        const triggerMessageId = await seedMessage({ text: 'the interrupted trigger' });
        const contextIndex = new Map([
            [1, { number: 1, messageId: 9001, fromBot: false, images: [], imageCount: 0 }],
            [2, { number: 2, messageId: 9002, fromBot: true, images: [], imageCount: 0 }],
        ]);
        const displayNumbering = new Map([
            [1, 9001],
            [2, 9003],
        ]);
        const tools = {
            definitions: [],
            execute: async () => ({ content: '', isError: false, images: [], record: null }),
            statusOf: () => ({ text: '', chatAction: 'typing' as const }),
        };
        const input = {
            model: 'offline-model',
            systemPrompt: 'prompt',
            tools,
            toolState: createReplyToolState({
                chatId: CHAT_ID,
                conversationRootIds: [triggerMessageId],
            }),
            contextIndex,
            conversationRootIds: [triggerMessageId],
            promptAddendum: null,
            promptAddendumCustom: null,
            promptTemplateIds: null,
            promptTemplatesAuto: false,
            builtAt: 0,
        };

        const kept = captureResumeFacts({ ...input, numbering: displayNumbering });
        expect(kept.context.numbering.get(2) === 9003, `the body target is kept (got ${kept.context.numbering.get(2)})`);
        const fallback = captureResumeFacts(input);
        expect(
            fallback.context.numbering.get(2) === 9002,
            `without a published numbering the index ids are used (got ${fallback.context.numbering.get(2)})`
        );
    })
);

await reportResults(results);
