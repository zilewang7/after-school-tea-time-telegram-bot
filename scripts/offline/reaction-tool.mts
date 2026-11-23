/**
 * Offline cases for the react_to_message tool and its wiring into the tool
 * snapshot, the panel, the static prompt and the free-round notice.
 *
 * Run: npx tsx scripts/offline/reaction-tool.mts (or pnpm test:offline reaction-tool)
 *
 * The Telegram API is a real grammY Api whose transformer answers locally and
 * records the call; a refused call is answered the way Telegram does, so the
 * error path reads the GrammyError the way production does. The bot-reply
 * cases seed `bot_responses` versions directly, so the current-version body id
 * is the one findBotReplyBodyMessageIds reads.
 */
import { expect, reportResults, runCase, setupOfflineDb, takeMessageId, type CaseResult } from './harness.mts';
import { createFakeTelegram, groupChat, type FakeTelegram, type TelegramCall } from './fake-telegram.mts';
import type { ResponseVersion } from '../../src/db/botResponseDTO.js';
import type { ContextIndex } from '../../src/reply/context-index.js';
import type { ReactToMessageDependencies } from '../../src/reply/tools/react-to-message-tool.js';
import type { ReplyPartKind } from '../../src/shared/reply-part.js';
import type { ToolOverrides } from '../../src/services/tool-overrides.js';

// Read when the queries run; set before the db layer is imported
process.env.BOT_USER_ID = '7777';
process.env.BOT_NAME = 'Bot';

const db = await setupOfflineDb();
const { BotResponse, ButtonState } = await import('../../src/db/botResponseDTO.js');
const { MessageReaction } = await import('../../src/db/messageReactionDTO.js');
const { replaceBotReaction } = await import('../../src/db/queries/reaction-queries.js');
const { setReplyPart } = await import('../../src/db/queries/reply-part-queries.js');
const { createReactToMessageTool } = await import('../../src/reply/tools/react-to-message-tool.js');
const { buildReplyToolContext } = await import('../../src/reply/tools/reply-tool-context.js');
const { createReplyTools } = await import('../../src/reply/tools/create-reply-tools.js');
const { resolveToolAvailability } = await import('../../src/reply/tools/tool-availability.js');
const { isTimeFreeToolName, REACT_TO_MESSAGE_TOOL_NAME } = await import('../../src/reply/tools/tool-names.js');
const { getToolConfig, readToolConfig } = await import('../../src/config/tool-config.js');
const { GEMINI_IMAGE_MODEL } = await import('../../src/config/models.js');
const { TRIAL_MODEL } = await import('../../src/config/trial-access.js');
const { toolRoundNotice } = await import('../../src/ai/tools/tool-round.js');
const { buildStaticSystemPrompt } = await import('../../src/ai/system-prompt/index.js');
const { buildToolMatrix } = await import('../../src/panel/views/tool-matrix.js');
const { normalizeToolOverrides } = await import('../../src/services/tool-overrides.js');
const { REACTION_EMOJIS } = await import('../../src/shared/reaction-emoji.js');
const { REACTION_BATCH_MAX } = await import('../../src/reply/tools/reaction-batch.js');

const CHAT = -1009123000201;
/** A chat of its own for a case that leaves a 429 penalty on the coordinator */
const FLOOD_CHAT = -1009123000202;
const FLOOD_RETRY_CHAT = -1009123000203;
const USER = 42;
const signal = new AbortController().signal;

const json = (value: unknown): string => JSON.stringify(value);

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : {};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** An incoming user message as autoSave would have stored it */
const seedUserMessage = async (chatId: number, userId: number, text = 'hello'): Promise<number> => {
    const messageId = takeMessageId();
    await db.saveMessage({ chatId, messageId, userId, date: new Date(), userName: '张三', message: text });
    return messageId;
};

const rowsOf = (chatId: number, messageId: number) =>
    MessageReaction.findAll({ where: { chatId, messageId }, order: [['id', 'ASC']] });

const reactionCalls = (telegram: FakeTelegram): readonly TelegramCall[] =>
    telegram.callsOf('setMessageReaction');

const apiTargetsOf = (telegram: FakeTelegram): unknown[] =>
    reactionCalls(telegram).map((call) => call.payload.message_id);

interface IndexEntry {
    readonly number: number;
    readonly messageId: number;
    readonly fromBot: boolean;
}

/** The turn's `#N` → message map plus the context the tool factory needs */
const contextOf = (
    chatId: number,
    entries: readonly IndexEntry[],
    telegram: FakeTelegram,
    contextSignal: AbortSignal = signal
) => {
    const contextIndex: ContextIndex = new Map(
        entries.map((entry) => [
            entry.number,
            {
                number: entry.number,
                messageId: entry.messageId,
                fromBot: entry.fromBot,
                images: [],
                imageCount: 0,
            },
        ])
    );
    return buildReplyToolContext({
        chat: groupChat(chatId),
        triggerMessage: {
            messageId: entries.at(-1)?.messageId ?? 1,
            userId: USER,
            userName: '张三',
            text: 'hi',
        },
        contextIndex,
        signal: contextSignal,
        api: telegram.api,
    });
};

const toolOn = (
    chatId: number,
    entries: readonly IndexEntry[],
    telegram: FakeTelegram,
    dependencies: ReactToMessageDependencies = {},
    contextSignal: AbortSignal = signal
) => createReactToMessageTool(contextOf(chatId, entries, telegram, contextSignal), dependencies);

/** Swallow console.warn for one body and keep the lines, like a reply's log */
const captureWarnings = async <T,>(body: () => Promise<T>): Promise<{ value: T; warnings: string[] }> => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
        warnings.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
    };
    try {
        return { value: await body(), warnings };
    } finally {
        console.warn = originalWarn;
    }
};

const versionOf = (messageIds: number[], versionId: number, thinkingLinkToken?: string): ResponseVersion => ({
    versionId,
    createdAt: new Date().toISOString(),
    messageIds,
    currentMessageId: messageIds.at(-1) ?? 0,
    text: 'the whole reply text',
    wasStoppedByUser: false,
    ...(thinkingLinkToken === undefined ? {} : { thinkingLinkToken }),
});

/** A bot reply stored under its first message id, with one version layout */
const seedBotReply = async (input: {
    readonly chatId: number;
    readonly userMessageId: number;
    readonly messageIds: readonly number[];
    readonly thinkingLinkToken?: string;
}): Promise<number> => {
    const firstMessageId = input.messageIds[0] ?? takeMessageId();
    await BotResponse.create({
        messageId: firstMessageId,
        chatId: input.chatId,
        userMessageId: input.userMessageId,
        currentVersionIndex: 0,
        versions: JSON.stringify([versionOf([...input.messageIds], 1, input.thinkingLinkToken)]),
        buttonState: ButtonState.NONE,
        metadata: JSON.stringify({ model: 'offline-model', hasImage: false }),
    });
    return firstMessageId;
};

/** One delivery-ledger row, as the delivery writes it right after a message goes out */
const registerPart = (
    canonicalMessageId: number,
    messageId: number,
    part: ReplyPartKind,
    partIndex: number | null = null
): Promise<void> => setReplyPart({ chatId: CHAT, canonicalMessageId, messageId, part, partIndex });

/** Lay the same reply out again under new message ids, the way a version switch does */
const addVersion = async (input: {
    readonly chatId: number;
    readonly messageId: number;
    readonly messageIds: readonly number[];
    readonly thinkingLinkToken?: string;
}): Promise<void> => {
    const response = await BotResponse.findOne({
        where: { chatId: input.chatId, messageId: input.messageId },
    });
    if (response === null) throw new Error('the bot reply to switch was not found');
    const versions = response.getVersions();
    versions.push(versionOf([...input.messageIds], versions.length + 1, input.thinkingLinkToken));
    response.setVersions(versions);
    response.currentVersionIndex = versions.length - 1;
    await response.save();
};

const results: CaseResult[] = [];

results.push(
    await runCase('C1: sets a standard reaction on #N, calls Telegram once and records the row', async () => {
        const canonical = await seedUserMessage(CHAT, USER);
        const telegram = createFakeTelegram();
        const tool = toolOn(CHAT, [{ number: 3, messageId: canonical, fromBot: false }], telegram);

        expect(tool.definition.name === REACT_TO_MESSAGE_TOOL_NAME, 'the declaration uses the shared constant');
        expect(tool.statusText === '💬 正在设置 reaction…', `the status line (got ${tool.statusText})`);
        const schema = asRecord(tool.definition.inputSchema);
        const properties = asRecord(schema.properties);
        expect(
            json(asArray(asRecord(properties.emoji).enum)) === json([...REACTION_EMOJIS]),
            'the emoji enum is the shared standard set, in its order'
        );
        expect(schema.required === undefined, 'no field is globally required: the three forms are exclusive');
        expect(
            asRecord(properties.message).type === 'integer',
            'the message number is an integer, not a string'
        );

        const result = await tool.execute({ message: 3, emoji: '👍' }, signal);
        expect(!result.isError, `the call succeeds (got ${result.content})`);
        expect(result.content === '已给 #3 设置 👍。', `the result names message and emoji (got ${result.content})`);
        expect(json(result.trace) === json({ argument: '#3 👍', result: '已设置' }), `the trace (got ${json(result.trace)})`);
        expect(result.images.length === 0 && result.record === null, 'nothing is delivered: a reaction is not a message');

        const calls = reactionCalls(telegram);
        expect(calls.length === 1, `one setMessageReaction call (got ${calls.length})`);
        expect(
            calls[0]?.payload.chat_id === CHAT && calls[0]?.payload.message_id === canonical,
            `the call targets this chat's message (got ${json(calls[0]?.payload)})`
        );
        expect(
            json(calls[0]?.payload.reaction) === json([{ type: 'emoji', emoji: '👍' }]),
            'the reaction payload is the standard emoji form'
        );
        expect(calls[0]?.payload.is_big === undefined, 'no big animation');

        const rows = await rowsOf(CHAT, canonical);
        expect(
            rows.length === 1 && rows[0]?.emoji === '👍' && rows[0]?.fromBotSelf === true,
            `one bot row is stored (got ${json(rows.map((row) => row.emoji))})`
        );
    })
);

results.push(
    await runCase('C2: a second emoji replaces the previous one', async () => {
        const canonical = await seedUserMessage(CHAT, USER);
        await replaceBotReaction(CHAT, canonical, '🤔');
        const telegram = createFakeTelegram();
        const tool = toolOn(CHAT, [{ number: 4, messageId: canonical, fromBot: false }], telegram);

        const replaced = await tool.execute({ message: 4, emoji: '👍' }, signal);
        expect(
            !replaced.isError && replaced.content === '已把 #4 的 🤔 换成 👍。',
            `the result says what it replaced (got ${replaced.content})`
        );
        const rows = await rowsOf(CHAT, canonical);
        expect(rows.length === 1 && rows[0]?.emoji === '👍', 'only the new row is left');

        const again = await tool.execute({ message: 4, emoji: '👍' }, signal);
        expect(
            !again.isError && again.content === '#4 上已经是 👍。',
            `setting the same emoji again says so (got ${again.content})`
        );
        expect((await rowsOf(CHAT, canonical)).length === 1, 'and it stays one row');
    })
);

results.push(
    await runCase('C3: a missing, null or blank emoji clears the bot reaction', async () => {
        const canonical = await seedUserMessage(CHAT, USER);
        await replaceBotReaction(CHAT, canonical, '👍');
        const telegram = createFakeTelegram();
        const tool = toolOn(CHAT, [{ number: 5, messageId: canonical, fromBot: false }], telegram);

        const cleared = await tool.execute({ message: 5 }, signal);
        expect(
            !cleared.isError && cleared.content === '已取消你在 #5 上的 👍。',
            `the clearing result names what was there (got ${cleared.content})`
        );
        expect(json(reactionCalls(telegram)[0]?.payload.reaction) === '[]', 'an empty reaction list clears it');
        expect((await rowsOf(CHAT, canonical)).length === 0, 'the bot row is gone');
        expect(json(cleared.trace) === json({ argument: '#5 取消', result: '已取消' }), 'the trace says cancelled');

        const nothing = await tool.execute({ message: 5, emoji: null }, signal);
        expect(
            !nothing.isError && nothing.content === '#5 上没有你加的 reaction。',
            `nothing to cancel reads as such (got ${nothing.content})`
        );
        const blank = await tool.execute({ message: 5, emoji: '' }, signal);
        expect(
            !blank.isError && blank.content === '#5 上没有你加的 reaction。',
            'a blank emoji also means cancel, not an invalid value'
        );
        expect(reactionCalls(telegram).length === 3, 'every cancel reached Telegram');
    })
);

results.push(
    await runCase('C4: a bad number, a missing #N or a non-standard emoji is refused before Telegram', async () => {
        const canonical = await seedUserMessage(CHAT, USER);
        const telegram = createFakeTelegram();
        const tool = toolOn(CHAT, [{ number: 3, messageId: canonical, fromBot: false }], telegram);

        const noNumber = await tool.execute({}, signal);
        expect(
            noNumber.isError && noNumber.content.includes('message 要传整数'),
            `a missing number is refused (got ${noNumber.content})`
        );
        const textNumber = await tool.execute({ message: '3', emoji: '👍' }, signal);
        expect(textNumber.isError, 'a number sent as a string is refused');
        const missing = await tool.execute({ message: 99, emoji: '👍' }, signal);
        expect(
            missing.isError && missing.content === '本次上下文没有 #99 这条消息（可用编号 #1–#3）',
            `a missing #N names the range (got ${missing.content})`
        );
        const invalid = await tool.execute({ message: 3, emoji: '🐱' }, signal);
        expect(
            invalid.isError && invalid.content.includes('只支持 Telegram 标准 reaction 表情'),
            `a non-standard emoji is refused (got ${invalid.content})`
        );
        expect(reactionCalls(telegram).length === 0, 'nothing reached Telegram');
    })
);

results.push(
    await runCase('C5: a refused Bot API call comes back with Telegram’s own description', async () => {
        const canonical = await seedUserMessage(CHAT, USER);
        const telegram = createFakeTelegram({
            refuse: (call) =>
                call.method === 'setMessageReaction'
                    ? { error_code: 400, description: 'Bad Request: chat not found' }
                    : null,
        });
        const tool = toolOn(CHAT, [{ number: 3, messageId: canonical, fromBot: false }], telegram);

        const result = await tool.execute({ message: 3, emoji: '👍' }, signal);
        expect(result.isError, 'the refusal is an error result');
        expect(
            result.content.includes('设置 reaction 失败') && result.content.includes('chat not found'),
            `GrammyError.description rides along (got ${result.content})`
        );
        expect((await rowsOf(CHAT, canonical)).length === 0, 'a failed call writes no row');
    })
);

results.push(
    await runCase('C6: a bot reply targets the current version body, the row keeps the canonical id', async () => {
        const trigger = await seedUserMessage(CHAT, USER);
        const firstMessageId = takeMessageId();
        const bodyMessageId = takeMessageId();
        await seedBotReply({
            chatId: CHAT,
            userMessageId: trigger,
            messageIds: [firstMessageId, bodyMessageId],
            thinkingLinkToken: 'cot-token',
        });

        const telegram = createFakeTelegram();
        const tool = toolOn(CHAT, [{ number: 4, messageId: firstMessageId, fromBot: true }], telegram);
        const first = await tool.execute({ message: 4, emoji: '👍' }, signal);
        expect(!first.isError && first.content === '已给 #4 设置 👍。', `the tool works on a bot reply (got ${first.content})`);
        expect(
            json(apiTargetsOf(telegram)) === json([bodyMessageId]),
            `the API target is the current version body, not the stored first id (got ${json(apiTargetsOf(telegram))})`
        );
        const rows = await rowsOf(CHAT, firstMessageId);
        expect(rows.length === 1 && rows[0]?.emoji === '👍', 'the row hangs on the canonical id');
        expect((await rowsOf(CHAT, bodyMessageId)).length === 0, 'never on the body id');
        expect(
            rows[0]?.sourceMessageId === bodyMessageId && rows[0]?.part === null,
            'the row names the body message; without a ledger row its part is unknown'
        );

        const switchedFirst = takeMessageId();
        const switchedBody = takeMessageId();
        await addVersion({
            chatId: CHAT,
            messageId: firstMessageId,
            messageIds: [switchedFirst, switchedBody],
            thinkingLinkToken: 'cot-token',
        });
        const second = await tool.execute({ message: 4, emoji: '❤' }, signal);
        expect(!second.isError, 'the call after a version switch succeeds');
        expect(
            apiTargetsOf(telegram).at(-1) === switchedBody,
            `the target follows the new version body (got ${json(apiTargetsOf(telegram))})`
        );
        const updated = await rowsOf(CHAT, firstMessageId);
        expect(updated.length === 1 && updated[0]?.emoji === '❤', 'the canonical row follows the replacement');

        // No stored layout at all (cleaned-up BotResponse): the canonical id is tried
        const unbackedId = takeMessageId();
        const fallbackTelegram = createFakeTelegram();
        const fallbackTool = toolOn(CHAT, [{ number: 7, messageId: unbackedId, fromBot: true }], fallbackTelegram);
        const fallback = await fallbackTool.execute({ message: 7, emoji: '🎉' }, signal);
        expect(!fallback.isError, 'a reply without a layout row still reaches the API');
        expect(
            json(apiTargetsOf(fallbackTelegram)) === json([unbackedId]),
            'the canonical id is the fallback target'
        );
    })
);

results.push(
    await runCase('C7: a deleted target reads as deleted, other refusals as themselves', async () => {
        const canonical = await seedUserMessage(CHAT, USER);
        for (const description of ['Bad Request: message to react not found', 'Bad Request: MESSAGE_ID_INVALID']) {
            const telegram = createFakeTelegram({
                refuse: (call) => (call.method === 'setMessageReaction' ? { error_code: 400, description } : null),
            });
            const tool = toolOn(CHAT, [{ number: 3, messageId: canonical, fromBot: false }], telegram);
            const result = await tool.execute({ message: 3, emoji: '👍' }, signal);
            expect(
                result.isError && result.content === '那条消息已被删除，无法点 reaction。',
                `"${description}" reads as a deleted message (got ${result.content})`
            );
        }
        expect((await rowsOf(CHAT, canonical)).length === 0, 'no row either way');
    })
);

results.push(
    await runCase('C8: a failing row write only warns; the reaction is already live', async () => {
        const canonical = await seedUserMessage(CHAT, USER);
        const telegram = createFakeTelegram();
        const context = contextOf(CHAT, [{ number: 3, messageId: canonical, fromBot: false }], telegram);

        const { value, warnings } = await captureWarnings(async () => {
            const tool = createReactToMessageTool(context, {
                writeReaction: async () => {
                    throw new Error('database is locked');
                },
            });
            const set = await tool.execute({ message: 3, emoji: '👍' }, signal);
            const cancel = await tool.execute({ message: 3 }, signal);
            return { set, cancel };
        });

        expect(
            !value.set.isError && value.set.content === '已给 #3 设置 👍。',
            `the set still reports success (got ${value.set.content})`
        );
        expect(
            !value.cancel.isError && value.cancel.content === '已取消你在 #3 上的 reaction。',
            `the cancel succeeds without a known previous emoji (got ${value.cancel.content})`
        );
        expect(reactionCalls(telegram).length === 2, 'both Telegram calls happened');
        expect(
            warnings.filter((line) => line.includes('failed to store the bot reaction')).length === 2,
            `each write failure is warned about (got ${json(warnings)})`
        );
        expect((await rowsOf(CHAT, canonical)).length === 0, 'no row was written');
    })
);

results.push(
    await runCase('C9: the declaration snapshot follows the availability switch', async () => {
        const canonical = await seedUserMessage(CHAT, USER);
        const context = contextOf(CHAT, [{ number: 3, messageId: canonical, fromBot: false }], createFakeTelegram());

        const offered = createReplyTools('gemini-4-argon', context);
        expect(offered.availability.reaction, 'the turn is offered the tool');
        const names = offered.tools.definitions.map((definition) => definition.name);
        expect(
            json(names) === json([REACT_TO_MESSAGE_TOOL_NAME]),
            `it is the only tool of a chat with nothing else switched on (got ${json(names)})`
        );

        const switchedOff = createReplyTools('gemini-4-argon', context, { reaction: false });
        expect(!switchedOff.availability.reaction, 'the panel switch decides the availability');
        expect(
            !switchedOff.tools.definitions.some((definition) => definition.name === REACT_TO_MESSAGE_TOOL_NAME),
            'and the declaration disappears from the snapshot'
        );

        const imageModel = createReplyTools(GEMINI_IMAGE_MODEL, context);
        expect(
            !imageModel.tools.definitions.some((definition) => definition.name === REACT_TO_MESSAGE_TOOL_NAME),
            'a model without client tools gets no declaration'
        );
    })
);

results.push(
    await runCase('C10: "message is not modified" is a success in the single form too', async () => {
        for (const description of [
            'Bad Request: message is not modified: specified new message content and reply markup are exactly the same',
            'Bad Request: MESSAGE_NOT_MODIFIED',
        ]) {
            const canonical = await seedUserMessage(CHAT, USER);
            const telegram = createFakeTelegram({
                refuse: (call) =>
                    call.method === 'setMessageReaction' ? { error_code: 400, description } : null,
            });
            const tool = toolOn(CHAT, [{ number: 3, messageId: canonical, fromBot: false }], telegram);

            const result = await tool.execute({ message: 3, emoji: '👍' }, signal);
            expect(!result.isError, `"${description}" is not an error (got ${result.content})`);
            expect(result.content === '已给 #3 设置 👍。', `the success copy (got ${result.content})`);
            expect(json(result.trace) === json({ argument: '#3 👍', result: '已设置' }), 'the success trace');
            const rows = await rowsOf(CHAT, canonical);
            expect(
                rows.length === 1 && rows[0]?.emoji === '👍' && rows[0]?.fromBotSelf === true,
                `the row is written (got ${json(rows.map((row) => row.emoji))})`
            );
        }
    })
);

results.push(
    await runCase('C11: a pure sticker reply targets the sticker message and snapshots the part', async () => {
        const trigger = await seedUserMessage(CHAT, USER);
        const stickerMessageId = takeMessageId();
        await seedBotReply({ chatId: CHAT, userMessageId: trigger, messageIds: [stickerMessageId] });
        await registerPart(stickerMessageId, stickerMessageId, 'sticker');
        const telegram = createFakeTelegram();
        const tool = toolOn(CHAT, [{ number: 4, messageId: stickerMessageId, fromBot: true }], telegram);

        const result = await tool.execute({ message: 4, emoji: '👍' }, signal);
        expect(
            !result.isError && result.content === '已给 #4 设置 👍。',
            `the tool works on a sticker reply (got ${result.content})`
        );
        expect(
            json(apiTargetsOf(telegram)) === json([stickerMessageId]),
            `the sticker message itself is the API target (got ${json(apiTargetsOf(telegram))})`
        );
        const rows = await rowsOf(CHAT, stickerMessageId);
        expect(rows.length === 1 && rows[0]?.emoji === '👍', 'the row hangs on the canonical id');
        expect(rows[0]?.sourceMessageId === stickerMessageId, 'the source is the message reacted to');
        expect(
            rows[0]?.part === 'sticker' && rows[0]?.partIndex === null,
            'the part snapshot names the sticker'
        );
    })
);

results.push(
    await runCase('C12: a pure picture reply targets its first picture and numbers it', async () => {
        const trigger = await seedUserMessage(CHAT, USER);
        const firstPicture = takeMessageId();
        const secondPicture = takeMessageId();
        await seedBotReply({ chatId: CHAT, userMessageId: trigger, messageIds: [firstPicture, secondPicture] });
        await registerPart(firstPicture, firstPicture, 'picture', 1);
        await registerPart(firstPicture, secondPicture, 'picture', 2);
        const telegram = createFakeTelegram();
        const tool = toolOn(CHAT, [{ number: 5, messageId: firstPicture, fromBot: true }], telegram);

        const result = await tool.execute({ message: 5, emoji: '❤' }, signal);
        expect(!result.isError, `the tool works on a picture reply (got ${result.content})`);
        expect(
            json(apiTargetsOf(telegram)) === json([firstPicture]),
            `the first picture is the API target (got ${json(apiTargetsOf(telegram))})`
        );
        const rows = await rowsOf(CHAT, firstPicture);
        expect(rows.length === 1 && rows[0]?.emoji === '❤', 'one bot row on the canonical id');
        expect(
            rows[0]?.sourceMessageId === firstPicture &&
                rows[0]?.part === 'picture' &&
                rows[0]?.partIndex === 1,
            'the picture number is snapshotted'
        );
    })
);

results.push(
    await runCase('the static head and the free-round notice name the tool when it is offered', async () => {
        const plain = buildStaticSystemPrompt('gemini-4-argon');
        expect(!plain.includes('react_to_message'), 'not offered: the capability section does not name it');
        expect(plain.includes('「消息 reaction」'), 'the notes always mention the runtime section that may appear');

        const withTool = buildStaticSystemPrompt('gemini-4-argon', { reaction: true });
        const addedLines = withTool.split('\n').filter((line) => !plain.split('\n').includes(line));
        expect(addedLines.length === 1, `exactly one line is added (got ${json(addedLines)})`);
        expect(
            addedLines[0]?.startsWith('- 可以用 `react_to_message` 给本段对话中的消息加一个 emoji reaction'),
            'the capability line opens with its purpose'
        );
        const trialHead = buildStaticSystemPrompt(TRIAL_MODEL, { trial: true });
        expect(trialHead.includes('历史检索、reaction 等'), 'the trial free-tool list includes reaction');
    })
);

results.push(
    await runCase('D1: on everywhere by default, and every switch gates it', async () => {
        const defaultConfig = readToolConfig({});
        expect(
            resolveToolAvailability('gemini-4-argon', CHAT, defaultConfig).reaction,
            'on in a chat outside TOOL_CHAT_IDS: no whitelist for reaction'
        );
        expect(
            !resolveToolAvailability('gemini-4-argon', CHAT, readToolConfig({ DISABLED_TOOLS: 'react_to_message' })).reaction,
            'DISABLED_TOOLS kills it'
        );
        expect(
            !resolveToolAvailability('gemini-4-argon', CHAT, defaultConfig, { reaction: false }).reaction,
            'the panel switch turns it off'
        );
        expect(
            resolveToolAvailability('gemini-4-argon', CHAT, defaultConfig, { reaction: true }).reaction,
            'and on again where the panel allows it'
        );
        expect(
            resolveToolAvailability('gemini-4-argon', CHAT, defaultConfig, null, 'trial').reaction,
            'a trial turn keeps the free tool'
        );
        expect(
            !resolveToolAvailability(GEMINI_IMAGE_MODEL, CHAT, defaultConfig).reaction,
            'a model without client tools has no reaction tool'
        );
    })
);

results.push(
    await runCase('D2: the panel matrix carries the group and explains every off state', async () => {
        const entryOf = (model: string, overrides: ToolOverrides | null = null) =>
            buildToolMatrix(model, CHAT, overrides).find((entry) => entry.key === 'reaction');

        const defaultEntry = entryOf('gemini-4-argon');
        if (defaultEntry === undefined) throw new Error('the reaction group is missing from the matrix');
        expect(
            defaultEntry.enabled && defaultEntry.defaultEnabled && defaultEntry.override === null,
            'on by default, following the env'
        );
        expect(defaultEntry.reason === null && !defaultEntry.blocked, 'with no reason and not blocked');
        expect(
            json(defaultEntry.tools) === json([REACT_TO_MESSAGE_TOOL_NAME]),
            'the group registers the one tool'
        );

        const offEntry = entryOf('gemini-4-argon', { reaction: false });
        expect(
            offEntry?.enabled === false && offEntry.override === false && offEntry.reason === '已由面板关闭' && !offEntry.blocked,
            `the panel switch explains an off group (got ${json(offEntry)})`
        );

        const noClientEntry = entryOf(GEMINI_IMAGE_MODEL);
        expect(
            noClientEntry?.enabled === false &&
                noClientEntry.reason === '当前模型不支持客户端工具' &&
                noClientEntry.blocked,
            `a model without client tools is a hard reason (got ${json(noClientEntry)})`
        );

        // DISABLED_TOOLS comes from the one cached config; flip the set for one read
        const disabledTools = getToolConfig().disabledTools;
        if (!(disabledTools instanceof Set)) throw new Error('the cached disabled tool names are not a set');
        const disabledEntry = await (async () => {
            disabledTools.add(REACT_TO_MESSAGE_TOOL_NAME);
            try {
                return entryOf('gemini-4-argon');
            } finally {
                void disabledTools.delete(REACT_TO_MESSAGE_TOOL_NAME);
            }
        })();
        expect(
            disabledEntry?.enabled === false &&
                disabledEntry.reason === `${REACT_TO_MESSAGE_TOOL_NAME} 已在 DISABLED_TOOLS 中关闭` &&
                disabledEntry.blocked,
            `DISABLED_TOOLS is a hard reason (got ${json(disabledEntry)})`
        );

        const normalized = normalizeToolOverrides({ reaction: false });
        expect(
            normalized.ok && normalized.value !== null && normalized.value.reaction === false,
            'the stored overrides form accepts the group'
        );
    })
);

results.push(
    await runCase('D5: the tool is time-free and the free-round notice lists it', async () => {
        expect(isTimeFreeToolName(REACT_TO_MESSAGE_TOOL_NAME), 'the free set names the tool');
        const notice = toolRoundNotice(3, false, true);
        expect(notice.includes('react_to_message'), `the free-round notice names it (got ${notice})`);
        expect(
            !toolRoundNotice(3, false).includes('react_to_message'),
            'a normal round does not list tools at all'
        );
    })
);

// ---------------------------------------------------------------------------
// Batch forms: messages / reactions (design 2026-1120-1638 §4 and §9.1)
// ---------------------------------------------------------------------------

/** One freshly seeded user message and the `#N` entry that names it */
const seededEntry = async (chatId: number, number: number, text = 'hello'): Promise<IndexEntry> => ({
    number,
    messageId: await seedUserMessage(chatId, USER, text),
    fromBot: false,
});

/** The stored bot rows of the given messages, in insertion order */
const botRowsOf = async (chatId: number, messageIds: readonly number[]) => {
    const rows = await MessageReaction.findAll({
        where: { chatId, fromBotSelf: true },
        order: [['id', 'ASC']],
    });
    return rows.filter((row) => messageIds.includes(row.messageId));
};

/** Every reaction list the fake Telegram received, as JSON */
const reactionPayloadsOf = (telegram: FakeTelegram): string[] =>
    reactionCalls(telegram).map((call) => json(call.payload.reaction));

/**
 * Count the raw SQL statements whose text matches while the body runs. The
 * bot-reply body read is the one call that goes through sequelize.query, so
 * this pins that a batch of replies still resolves them with one query. The
 * replaced method goes back even when the body throws.
 */
const countRawQueries = async <T,>(
    pattern: RegExp,
    body: () => Promise<T>
): Promise<{ readonly value: T; readonly count: number }> => {
    const { sequelize } = await import('../../src/db/config.js');
    const originalQuery = sequelize.query;
    let count = 0;
    Reflect.set(sequelize, 'query', (...args: unknown[]) => {
        const first = args[0];
        if (typeof first === 'string' && pattern.test(first)) count += 1;
        return Reflect.apply(originalQuery, sequelize, args);
    });
    try {
        const value = await body();
        return { value, count };
    } finally {
        Reflect.deleteProperty(sequelize, 'query');
    }
};

/**
 * Make the nth setMessageReaction answer a 429 carrying retry_after, the shape
 * Telegram uses; createFakeTelegram's refusals carry no parameters.
 */
const refuseNthReactionWithRetryAfter = (
    telegram: FakeTelegram,
    nth: number,
    retryAfter: number
): void => {
    let seen = 0;
    telegram.api.config.use((previous, method, payload, callSignal) => {
        if (method === 'setMessageReaction') {
            seen += 1;
            if (seen === nth) {
                return Promise.resolve({
                    ok: false,
                    error_code: 429,
                    description: `Too Many Requests: retry after ${retryAfter}`,
                    parameters: { retry_after: retryAfter },
                });
            }
        }
        return previous(method, payload, callSignal);
    });
};

results.push(
    await runCase('R1: messages sets one emoji on several messages, in request order', async () => {
        const entries = [
            await seededEntry(CHAT, 3),
            await seededEntry(CHAT, 4),
            await seededEntry(CHAT, 5),
        ];
        const telegram = createFakeTelegram();
        const tool = toolOn(CHAT, entries, telegram);

        const result = await tool.execute({ messages: [3, 4, 5], emoji: '👍' }, signal);
        expect(!result.isError, `the batch succeeds (got ${result.content})`);
        expect(
            result.content === '已设置 3 条 reaction（#3、#4、#5）：\n- #3 👍\n- #4 👍\n- #5 👍',
            `the result lists every message (got ${result.content})`
        );
        expect(
            json(result.trace) === json({ argument: '#3 👍、#4 👍、#5 👍', result: '3 条设置' }),
            `the trace (got ${json(result.trace)})`
        );
        expect(result.images.length === 0 && result.record === null, 'a reaction is not a message');

        const calls = reactionCalls(telegram);
        expect(calls.length === 3, `one call per message (got ${calls.length})`);
        expect(
            json(apiTargetsOf(telegram)) === json(entries.map((entry) => entry.messageId)),
            `the calls follow request order (got ${json(apiTargetsOf(telegram))})`
        );
        expect(
            reactionPayloadsOf(telegram).every(
                (payload) => payload === json([{ type: 'emoji', emoji: '👍' }])
            ),
            'every call carries the shared emoji'
        );
        const rows = await botRowsOf(CHAT, entries.map((entry) => entry.messageId));
        expect(
            rows.length === 3 && rows.every((row) => row.emoji === '👍' && row.userId === 7777),
            `three bot rows are stored (got ${json(rows.map((row) => row.emoji))})`
        );
    })
);

results.push(
    await runCase('R2: messages without an emoji cancels every one of them', async () => {
        const entries = [
            await seededEntry(CHAT, 3),
            await seededEntry(CHAT, 4),
            await seededEntry(CHAT, 5),
        ];
        for (const entry of entries) await replaceBotReaction(CHAT, entry.messageId, '👍');
        const telegram = createFakeTelegram();
        const tool = toolOn(CHAT, entries, telegram);

        const result = await tool.execute({ messages: [3, 4, 5] }, signal);
        expect(!result.isError, `the batch succeeds (got ${result.content})`);
        expect(
            result.content ===
                '已取消 3 条 reaction（#3、#4、#5）：\n' +
                    '- #3 取消（原来 👍）\n- #4 取消（原来 👍）\n- #5 取消（原来 👍）',
            `every cancel names what was there (got ${result.content})`
        );
        expect(
            json(result.trace) === json({ argument: '#3 取消、#4 取消、#5 取消', result: '3 条取消' }),
            `the trace (got ${json(result.trace)})`
        );
        expect(
            reactionPayloadsOf(telegram).every((payload) => payload === '[]'),
            'every call clears the reaction'
        );
        expect(
            (await botRowsOf(CHAT, entries.map((entry) => entry.messageId))).length === 0,
            'no bot row is left'
        );
    })
);

results.push(
    await runCase('R3: reactions gives every message its own emoji, an omitted one cancels', async () => {
        const entries = [
            await seededEntry(CHAT, 3),
            await seededEntry(CHAT, 4),
            await seededEntry(CHAT, 5),
        ];
        const telegram = createFakeTelegram();
        const tool = toolOn(CHAT, entries, telegram);

        const mixed = await tool.execute(
            { reactions: [{ message: 3, emoji: '👍' }, { message: 4, emoji: '🤣' }, { message: 5 }] },
            signal
        );
        expect(!mixed.isError, `the mixed batch succeeds (got ${mixed.content})`);
        expect(
            mixed.content ===
                '已设置 3 条 reaction（#3、#4、#5）：\n- #3 👍\n- #4 🤣\n- #5 取消（原本没有）',
            `every item keeps its own emoji (got ${mixed.content})`
        );
        expect(
            json(mixed.trace) === json({ argument: '#3 👍、#4 🤣、#5 取消', result: '2 条设置 · 1 条取消' }),
            `the trace counts sets and cancels (got ${json(mixed.trace)})`
        );
        expect(
            json(reactionPayloadsOf(telegram)) ===
                json(['[{"type":"emoji","emoji":"👍"}]', '[{"type":"emoji","emoji":"🤣"}]', '[]']),
            `the payloads follow the items (got ${json(reactionPayloadsOf(telegram))})`
        );

        const blanks = await tool.execute({ reactions: [{ message: 3, emoji: '' }, { message: 4, emoji: null }] }, signal);
        expect(!blanks.isError, `a blank and a null emoji both cancel (got ${blanks.content})`);
        expect(
            blanks.content === '已取消 2 条 reaction（#3、#4）：\n- #3 取消（原来 👍）\n- #4 取消（原来 🤣）',
            `the cancel names the previous emoji (got ${blanks.content})`
        );
        expect(
            json(reactionPayloadsOf(telegram).slice(3)) === json(['[]', '[]']),
            'both cancels reached Telegram as empty lists'
        );
    })
);

results.push(
    await runCase('R4: a repeated message is called once and says which one won', async () => {
        const entries = [await seededEntry(CHAT, 3), await seededEntry(CHAT, 4)];
        const telegram = createFakeTelegram();
        const tool = toolOn(CHAT, entries, telegram);
        const repeated = await tool.execute({ messages: [3, 4, 3], emoji: '👍' }, signal);
        expect(!repeated.isError, `the batch succeeds (got ${repeated.content})`);
        expect(
            repeated.content ===
                '已设置 2 条 reaction（#3、#4）：\n- #3 👍\n- #4 👍\n#3 在一批里出现了 2 次，按最后一条设置。',
            `the repeated number is explained (got ${repeated.content})`
        );
        expect(reactionCalls(telegram).length === 2, 'the repeated message reached Telegram once');

        // Two numbers naming one API target: the later item wins, the earlier is named
        const shared = await seedUserMessage(CHAT, USER, 'shared');
        const other = await seedUserMessage(CHAT, USER, 'other');
        const sharedEntries: IndexEntry[] = [
            { number: 3, messageId: shared, fromBot: false },
            { number: 4, messageId: shared, fromBot: false },
            { number: 5, messageId: other, fromBot: false },
        ];
        const sharedTelegram = createFakeTelegram();
        const sharedTool = toolOn(CHAT, sharedEntries, sharedTelegram);
        const sameTarget = await sharedTool.execute({ messages: [3, 4], emoji: '❤' }, signal);
        expect(!sameTarget.isError, `the batch succeeds (got ${sameTarget.content})`);
        expect(
            sameTarget.content ===
                '已设置 1 条 reaction（#4）：\n- #4 ❤\n#3 和 #4 是同一条消息，按 #4 设置。',
            `the dropped number is named (got ${sameTarget.content})`
        );
        expect(
            json(apiTargetsOf(sharedTelegram)) === json([shared]),
            'one API target is called once'
        );

        // The last emoji wins when one number appears twice with different emojis
        const lastWinsEntry = await seededEntry(CHAT, 3);
        const lastWinsTelegram = createFakeTelegram();
        const lastWinsTool = toolOn(CHAT, [lastWinsEntry], lastWinsTelegram);
        const lastWins = await lastWinsTool.execute(
            { reactions: [{ message: 3, emoji: '👍' }, { message: 3, emoji: '🔥' }] },
            signal
        );
        expect(!lastWins.isError, `the batch succeeds (got ${lastWins.content})`);
        expect(
            lastWins.content ===
                '已设置 1 条 reaction（#3）：\n- #3 🔥\n#3 在一批里出现了 2 次，按最后一条设置。',
            `the last emoji is the one reported (got ${lastWins.content})`
        );
        expect(
            json(reactionPayloadsOf(lastWinsTelegram)) === json(['[{"type":"emoji","emoji":"🔥"}]']),
            'the last emoji is the one sent'
        );
    })
);

results.push(
    await runCase('R5: a batch crossing a user message and bot replies targets the reply bodies', async () => {
        const userMessageId = await seedUserMessage(CHAT, USER, 'the question');
        const firstMessageId = takeMessageId();
        const bodyMessageId = takeMessageId();
        await seedBotReply({
            chatId: CHAT,
            userMessageId,
            messageIds: [firstMessageId, bodyMessageId],
            thinkingLinkToken: 'cot-token',
        });
        const secondFirstMessageId = takeMessageId();
        const secondBodyMessageId = takeMessageId();
        await seedBotReply({
            chatId: CHAT,
            userMessageId,
            messageIds: [secondFirstMessageId, secondBodyMessageId],
            thinkingLinkToken: 'cot-token',
        });
        const entries: IndexEntry[] = [
            { number: 3, messageId: userMessageId, fromBot: false },
            { number: 4, messageId: firstMessageId, fromBot: true },
            { number: 5, messageId: secondFirstMessageId, fromBot: true },
        ];
        const telegram = createFakeTelegram();
        const tool = toolOn(CHAT, entries, telegram);

        // findBotReplyBodyMessageIds reads the layout; one query serves both replies
        const measured = await countRawQueries(/json_extract/i, () =>
            tool.execute({ messages: [3, 4, 5], emoji: '🎉' }, signal)
        );
        const { value: result } = measured;
        expect(!result.isError, `the batch succeeds (got ${result.content})`);
        expect(
            result.content === '已设置 3 条 reaction（#3、#4、#5）：\n- #3 🎉\n- #4 🎉\n- #5 🎉',
            `the result lists every message (got ${result.content})`
        );
        expect(measured.count === 1, `both reply bodies are resolved with one query (got ${measured.count})`);
        expect(
            json(apiTargetsOf(telegram)) === json([userMessageId, bodyMessageId, secondBodyMessageId]),
            `the bot replies target their current version bodies (got ${json(apiTargetsOf(telegram))})`
        );
        const userRows = await rowsOf(CHAT, userMessageId);
        expect(userRows.length === 1 && userRows[0]?.emoji === '🎉', 'the user message row is on its own id');
        const firstRows = await rowsOf(CHAT, firstMessageId);
        expect(firstRows.length === 1 && firstRows[0]?.emoji === '🎉', 'the first reply row is on the canonical id');
        const secondRows = await rowsOf(CHAT, secondFirstMessageId);
        expect(secondRows.length === 1 && secondRows[0]?.emoji === '🎉', 'the second reply row is on its canonical id');
        expect((await rowsOf(CHAT, bodyMessageId)).length === 0, 'never on the body id');
        expect((await rowsOf(CHAT, secondBodyMessageId)).length === 0, 'never on the second body id');
    })
);

results.push(
    await runCase('R6: a number the context does not have fails alone', async () => {
        const entry = await seededEntry(CHAT, 3);
        const telegram = createFakeTelegram();
        const tool = toolOn(CHAT, [entry], telegram);

        const result = await tool.execute({ messages: [3, 9], emoji: '👍' }, signal);
        expect(!result.isError, `a partly failed batch is not an error result (got ${result.content})`);
        expect(
            result.content ===
                '已设置 1 条 reaction（#3）：\n- #3 👍\n有 1 条没设置成：\n- #9：本次上下文没有 #9 这条消息。',
            `the missing number is the only failure (got ${result.content})`
        );
        expect(
            json(result.trace) === json({ argument: '#3 👍、#9 👍', result: '1 条设置 · 1 条失败' }),
            `the trace counts the failure (got ${json(result.trace)})`
        );
        expect(reactionCalls(telegram).length === 1, 'only the known message reaches Telegram');
    })
);

results.push(
    await runCase('R7: a batch where no number is in the context is an error result', async () => {
        const telegram = createFakeTelegram();
        const tool = toolOn(CHAT, [await seededEntry(CHAT, 3)], telegram);

        const result = await tool.execute({ messages: [8, 9] }, signal);
        expect(result.isError, 'no success means an error result');
        expect(
            result.content ===
                '这 2 条都没设置成：\n- #8：本次上下文没有 #8 这条消息。\n- #9：本次上下文没有 #9 这条消息。',
            `every failure is listed (got ${result.content})`
        );
        expect(
            typeof result.trace?.result === 'string' && result.trace.result.startsWith('全部失败'),
            `the trace says all failed (got ${json(result.trace)})`
        );
        expect(reactionCalls(telegram).length === 0, 'nothing reaches Telegram');
    })
);

results.push(
    await runCase('R8: more than six items is refused before any call', async () => {
        const telegram = createFakeTelegram();
        const tool = toolOn(CHAT, [await seededEntry(CHAT, 3)], telegram);

        const tooManyMessages = await tool.execute(
            { messages: [1, 2, 3, 4, 5, 6, 7], emoji: '👍' },
            signal
        );
        expect(
            tooManyMessages.isError && tooManyMessages.content.includes('一次最多 6 条'),
            `messages is capped (got ${tooManyMessages.content})`
        );
        const tooManyReactions = await tool.execute(
            { reactions: [1, 2, 3, 4, 5, 6, 7].map((message) => ({ message, emoji: '👍' })) },
            signal
        );
        expect(
            tooManyReactions.isError && tooManyReactions.content.includes('一次最多 6 条'),
            `reactions is capped (got ${tooManyReactions.content})`
        );
        expect(REACTION_BATCH_MAX === 6, 'the cap is the designed six');
        expect(reactionCalls(telegram).length === 0, 'nothing reaches Telegram');
    })
);

results.push(
    await runCase('R9: empty arrays and non-integer numbers are argument errors', async () => {
        const telegram = createFakeTelegram();
        const tool = toolOn(CHAT, [await seededEntry(CHAT, 3)], telegram);
        const invalidCalls: ReadonlyArray<{ readonly args: Readonly<Record<string, unknown>>; readonly text: string }> = [
            { args: { messages: [] }, text: 'messages 不能为空' },
            { args: { reactions: [] }, text: 'reactions 不能为空' },
            { args: { messages: [3, '4'] }, text: '每一项都要是整数编号' },
            { args: { messages: 3 }, text: 'messages 要是消息编号数组' },
            { args: { reactions: [3] }, text: '第 1 项要是 {message, emoji?} 对象' },
            { args: { reactions: [{ emoji: '👍' }] }, text: '第 1 项的 message 要传整数' },
        ];
        for (const invalidCall of invalidCalls) {
            const result = await tool.execute(invalidCall.args, signal);
            expect(
                result.isError && result.content.includes(invalidCall.text),
                `${invalidCall.text} (got ${result.content})`
            );
        }
        expect(reactionCalls(telegram).length === 0, 'nothing reaches Telegram');
    })
);

results.push(
    await runCase('R10: the three forms are exclusive', async () => {
        const telegram = createFakeTelegram();
        const tool = toolOn(CHAT, [await seededEntry(CHAT, 3)], telegram);
        const mixtures: ReadonlyArray<Readonly<Record<string, unknown>>> = [
            { message: 3, messages: [3] },
            { messages: [3], reactions: [{ message: 3 }] },
            { message: 3, messages: [3], reactions: [{ message: 3 }] },
        ];
        for (const args of mixtures) {
            const result = await tool.execute(args, signal);
            expect(
                result.isError && result.content.includes('只能传一个'),
                `two forms together are refused (got ${result.content})`
            );
        }
        const topEmoji = await tool.execute({ reactions: [{ message: 3, emoji: '👍' }], emoji: '👍' }, signal);
        expect(
            topEmoji.isError && topEmoji.content.includes('不要再传顶层 emoji'),
            `a top-level emoji next to reactions is refused (got ${topEmoji.content})`
        );
        expect(reactionCalls(telegram).length === 0, 'nothing reaches Telegram');
    })
);

results.push(
    await runCase('R11: a non-standard emoji is refused in both batch forms', async () => {
        const telegram = createFakeTelegram();
        const tool = toolOn(CHAT, [await seededEntry(CHAT, 3)], telegram);

        const shared = await tool.execute({ messages: [3], emoji: '🐱' }, signal);
        expect(
            shared.isError && shared.content.includes('只支持 Telegram 标准 reaction 表情'),
            `messages uses the shared emoji check (got ${shared.content})`
        );
        const perItem = await tool.execute({ reactions: [{ message: 3, emoji: '🐱' }] }, signal);
        expect(
            perItem.isError &&
                perItem.content.includes('第 1 项') &&
                perItem.content.includes('只支持 Telegram 标准 reaction 表情'),
            `reactions names the bad item (got ${perItem.content})`
        );
        expect(reactionCalls(telegram).length === 0, 'nothing reaches Telegram');
    })
);

results.push(
    await runCase('R12: a deleted target fails alone and the rest of the batch goes on', async () => {
        const firstId = await seedUserMessage(CHAT, USER, 'first');
        const deletedId = await seedUserMessage(CHAT, USER, 'deleted');
        const lastId = await seedUserMessage(CHAT, USER, 'last');
        const entries: IndexEntry[] = [
            { number: 3, messageId: firstId, fromBot: false },
            { number: 4, messageId: deletedId, fromBot: false },
            { number: 5, messageId: lastId, fromBot: false },
        ];
        const telegram = createFakeTelegram({
            refuse: (call) =>
                call.method === 'setMessageReaction' && call.payload.message_id === deletedId
                    ? { error_code: 400, description: 'Bad Request: message to react not found' }
                    : null,
        });
        const tool = toolOn(CHAT, entries, telegram);

        const result = await tool.execute({ messages: [3, 4, 5], emoji: '👍' }, signal);
        expect(!result.isError, `the other two still succeed (got ${result.content})`);
        expect(
            result.content ===
                '已设置 2 条 reaction（#3、#5）：\n- #3 👍\n- #5 👍\n' +
                    '有 1 条没设置成：\n- #4：那条消息已被删除，无法点 reaction。',
            `the deleted item is the only failure (got ${result.content})`
        );
        expect(reactionCalls(telegram).length === 3, 'the rest of the batch still reached Telegram');
        const rows = await botRowsOf(CHAT, entries.map((entry) => entry.messageId));
        expect(
            rows.length === 2 && rows.every((row) => row.messageId !== deletedId),
            'only the reachable messages got a row'
        );
    })
);

results.push(
    await runCase('R13: a failing batch write only warns; the reactions are live', async () => {
        const entries = [await seededEntry(CHAT, 3), await seededEntry(CHAT, 4)];
        const telegram = createFakeTelegram();
        const { value, warnings } = await captureWarnings(async () => {
            const tool = toolOn(CHAT, entries, telegram, {
                writeReactions: async () => {
                    throw new Error('database is locked');
                },
            });
            return tool.execute({ messages: [3, 4], emoji: '👍' }, signal);
        });

        expect(!value.isError, `the batch still reports success (got ${value.content})`);
        expect(
            value.content === '已设置 2 条 reaction（#3、#4）：\n- #3 👍\n- #4 👍',
            `without a previous state the lines stay plain (got ${value.content})`
        );
        expect(reactionCalls(telegram).length === 2, 'both Telegram calls happened');
        expect(
            warnings.filter((line) => line.includes('failed to store 2 bot reactions')).length === 1,
            `one warning for the whole write (got ${json(warnings)})`
        );
        expect(
            (await botRowsOf(CHAT, entries.map((entry) => entry.messageId))).length === 0,
            'no row was written'
        );
    })
);

results.push(
    await runCase('R14: a stopped reply leaves the remaining items unprocessed', async () => {
        const controller = new AbortController();
        const entries = [
            await seededEntry(CHAT, 3),
            await seededEntry(CHAT, 4),
            await seededEntry(CHAT, 5),
            await seededEntry(CHAT, 6),
        ];
        const telegram = createFakeTelegram({
            refuse: (call) => {
                if (call.method === 'setMessageReaction') controller.abort();
                return null;
            },
        });
        const tool = toolOn(CHAT, entries, telegram, {}, controller.signal);

        const result = await tool.execute({ messages: [3, 4, 5, 6], emoji: '👍' }, controller.signal);
        expect(!result.isError, `a stop after one success is not an error result (got ${result.content})`);
        expect(
            result.content ===
                '已设置 1 条 reaction（#3）：\n- #3 👍\n有 3 条没设置成：\n' +
                    '- #4：回复已停止，未处理。\n- #5：回复已停止，未处理。\n- #6：回复已停止，未处理。',
            `the untouched items say so (got ${result.content})`
        );
        expect(reactionCalls(telegram).length === 1, 'only the first item reached Telegram');
        const rows = await botRowsOf(CHAT, entries.map((entry) => entry.messageId));
        expect(rows.length === 1 && rows[0]?.emoji === '👍', 'the applied reaction stays');
    })
);

results.push(
    await runCase('R15: a flood wait escaping auto-retry stops the rest of the batch', async () => {
        const entries = [
            await seededEntry(FLOOD_CHAT, 3),
            await seededEntry(FLOOD_CHAT, 4),
            await seededEntry(FLOOD_CHAT, 5),
            await seededEntry(FLOOD_CHAT, 6),
        ];
        let attempts = 0;
        const telegram = createFakeTelegram({
            refuse: (call) => {
                if (call.method !== 'setMessageReaction') return null;
                attempts += 1;
                return attempts === 2
                    ? { error_code: 429, description: 'Too Many Requests: retry later' }
                    : null;
            },
        });
        const tool = toolOn(FLOOD_CHAT, entries, telegram);

        const result = await tool.execute({ messages: [3, 4, 5, 6], emoji: '👍' }, signal);
        expect(!result.isError, `the first item still succeeded (got ${result.content})`);
        expect(
            result.content ===
                '已设置 1 条 reaction（#3）：\n- #3 👍\n' +
                    '有 1 条没设置成：\n- #4：被 Telegram 限流，剩余未设置。',
            `the flood wait names the remaining items (got ${result.content})`
        );
        expect(
            json(result.trace) === json({ argument: '#3 等 4 条', result: '1 条设置 · 1 条失败' }),
            `the trace (got ${json(result.trace)})`
        );
        expect(reactionCalls(telegram).length === 2, 'the remaining two were not called');
        expect(
            (await botRowsOf(FLOOD_CHAT, entries.map((entry) => entry.messageId))).length === 1,
            'the successful reaction is stored'
        );
    })
);

results.push(
    await runCase('R16: schema and prompt describe both batch forms', async () => {
        const tool = toolOn(CHAT, [await seededEntry(CHAT, 3)], createFakeTelegram());
        const schema = asRecord(tool.definition.inputSchema);
        const properties = asRecord(schema.properties);

        const messages = asRecord(properties.messages);
        expect(
            messages.type === 'array' && messages.minItems === 1 && messages.maxItems === 6,
            `messages is a bounded array (got ${json(messages)})`
        );
        expect(asRecord(messages.items).type === 'integer', 'messages carries numbers');
        const reactions = asRecord(properties.reactions);
        expect(
            reactions.type === 'array' && reactions.minItems === 1 && reactions.maxItems === 6,
            `reactions is a bounded array (got ${json(reactions)})`
        );
        const reactionItem = asRecord(reactions.items);
        expect(reactionItem.type === 'object', 'reactions carries objects');
        const reactionProperties = asRecord(reactionItem.properties);
        expect(
            asRecord(reactionProperties.message).type === 'integer',
            'each reaction names its message by number'
        );
        expect(
            json(asArray(asRecord(reactionProperties.emoji).enum)) === json([...REACTION_EMOJIS]),
            'each reaction takes a standard emoji'
        );
        expect(json(reactionItem.required) === json(['message']), 'each reaction needs its message');
        expect(
            schema.required === undefined,
            'the top level requires nothing: a batch call has no message'
        );

        const description = tool.definition.description;
        expect(
            description.includes('messages=[3,4,5]') && description.includes("reactions=[{message:3,emoji:'👍'}"),
            `the description shows both batch examples (got ${description})`
        );

        const prompt = buildStaticSystemPrompt('gemini-4-argon', { reaction: true });
        const reactionLine = prompt
            .split('\n')
            .find((line) => line.startsWith('- 可以用 `react_to_message`'));
        expect(
            reactionLine !== undefined &&
                reactionLine.includes('messages') &&
                reactionLine.includes('reactions'),
            `the static prompt names both forms (got ${json(reactionLine)})`
        );
    })
);

results.push(
    await runCase('R17: "message is not modified" counts as success', async () => {
        const entries = [await seededEntry(CHAT, 3), await seededEntry(CHAT, 4)];
        const telegram = createFakeTelegram({
            refuse: (call) =>
                call.method === 'setMessageReaction'
                    ? {
                          error_code: 400,
                          description:
                              'Bad Request: message is not modified: specified new message content and reply markup are exactly the same',
                      }
                    : null,
        });
        const tool = toolOn(CHAT, entries, telegram);

        const result = await tool.execute({ messages: [3, 4] }, signal);
        expect(!result.isError, `an unchanged target is not a failure (got ${result.content})`);
        expect(
            result.content ===
                '已取消 2 条 reaction（#3、#4）：\n- #3 取消（原本没有）\n- #4 取消（原本没有）',
            `the cancels read as successes (got ${result.content})`
        );
        expect(
            json(result.trace) === json({ argument: '#3 取消、#4 取消', result: '2 条取消' }),
            `the trace (got ${json(result.trace)})`
        );
        expect(reactionCalls(telegram).length === 2, 'both cancels were attempted');
        expect(
            (await botRowsOf(CHAT, entries.map((entry) => entry.messageId))).length === 0,
            'no row was written'
        );
    })
);

results.push(
    await runCase('R18: a chat-level refusal stops the rest of the batch', async () => {
        const firstId = await seedUserMessage(CHAT, USER, 'first');
        const refusedId = await seedUserMessage(CHAT, USER, 'refused');
        const lastId = await seedUserMessage(CHAT, USER, 'last');
        const entries: IndexEntry[] = [
            { number: 3, messageId: firstId, fromBot: false },
            { number: 4, messageId: refusedId, fromBot: false },
            { number: 5, messageId: lastId, fromBot: false },
        ];
        const telegram = createFakeTelegram({
            refuse: (call) =>
                call.method === 'setMessageReaction' && call.payload.message_id === refusedId
                    ? { error_code: 403, description: 'Forbidden: CHAT_WRITE_FORBIDDEN' }
                    : null,
        });
        const tool = toolOn(CHAT, entries, telegram);

        const result = await tool.execute({ messages: [3, 4, 5], emoji: '👍' }, signal);
        expect(!result.isError, `the first item still succeeded (got ${result.content})`);
        expect(
            result.content ===
                '已设置 1 条 reaction（#3）：\n- #3 👍\n' +
                    '有 1 条没设置成：\n- #4：聊天权限不足，剩余未设置。',
            `the permission refusal is named once (got ${result.content})`
        );
        expect(reactionCalls(telegram).length === 2, 'the last item was not called');
    })
);

results.push(
    await runCase('R19: a flood wait with retry_after says how long to wait', async () => {
        const entries = [
            await seededEntry(FLOOD_RETRY_CHAT, 3),
            await seededEntry(FLOOD_RETRY_CHAT, 4),
            await seededEntry(FLOOD_RETRY_CHAT, 5),
        ];
        const telegram = createFakeTelegram();
        refuseNthReactionWithRetryAfter(telegram, 2, 17);
        const tool = toolOn(FLOOD_RETRY_CHAT, entries, telegram);

        const result = await tool.execute({ messages: [3, 4, 5], emoji: '👍' }, signal);
        expect(!result.isError, `the first item still succeeded (got ${result.content})`);
        expect(result.content.includes('约 17 秒'), `the retry_after reaches the model (got ${result.content})`);
        expect(
            result.content.includes('剩余未设置'),
            `the remaining items are named as unset (got ${result.content})`
        );
        expect(reactionCalls(telegram).length === 1, 'the stop kept the rest from being called');
    })
);

results.push(
    await runCase('R20: null and empty-array fillers do not count as a second form', async () => {
        const canonicalThree = await seedUserMessage(CHAT, USER);
        const canonicalFour = await seedUserMessage(CHAT, USER);
        const telegram = createFakeTelegram();
        const tool = toolOn(
            CHAT,
            [
                { number: 3, messageId: canonicalThree, fromBot: false },
                { number: 4, messageId: canonicalFour, fromBot: false },
            ],
            telegram
        );

        // A single-form call that also carries the batch fields as fillers
        const single = await tool.execute(
            { message: 3, emoji: '👍', messages: [], reactions: [] },
            signal
        );
        expect(
            !single.isError && single.content === '已给 #3 设置 👍。',
            `empty arrays are fillers for the single form (got ${single.content})`
        );

        // A batch call that also carries the single field as null
        const batch = await tool.execute({ messages: [4, 3], emoji: '🔥', message: null }, signal);
        expect(
            !batch.isError && batch.content.includes('已设置 2 条 reaction'),
            `a null message is a filler for the batch form (got ${batch.content})`
        );

        // A zero message is a filler too (a form value is always >= 1)
        const zeroFiller = await tool.execute({ messages: [3], emoji: '👌', message: 0 }, signal);
        expect(
            !zeroFiller.isError && zeroFiller.content.includes('#3 👌'),
            `a zero message is a filler (got ${zeroFiller.content})`
        );

        // A blank top-level emoji next to reactions is a filler, not a mixture
        const reactions = await tool.execute(
            { reactions: [{ message: 3, emoji: '🎉' }], emoji: '' },
            signal
        );
        expect(
            !reactions.isError && reactions.content.includes('#3 🎉'),
            `a blank top-level emoji is a filler (got ${reactions.content})`
        );
    })
);

results.push(
    await runCase('R21: the batch writes the same row shape as the single form, part included', async () => {
        const ask = await seedUserMessage(CHAT, USER, 'the question');
        // Two replies laid out the same way: the CoT link first, the body second
        const firstA = takeMessageId();
        const bodyA = takeMessageId();
        await seedBotReply({
            chatId: CHAT,
            userMessageId: ask,
            messageIds: [firstA, bodyA],
            thinkingLinkToken: 'cot-token',
        });
        await registerPart(firstA, firstA, 'cot-link');
        await registerPart(firstA, bodyA, 'body', 1);
        const firstB = takeMessageId();
        const bodyB = takeMessageId();
        await seedBotReply({
            chatId: CHAT,
            userMessageId: ask,
            messageIds: [firstB, bodyB],
            thinkingLinkToken: 'cot-token',
        });
        await registerPart(firstB, firstB, 'cot-link');
        await registerPart(firstB, bodyB, 'body', 1);

        const singleTelegram = createFakeTelegram();
        const singleTool = toolOn(CHAT, [{ number: 4, messageId: firstA, fromBot: true }], singleTelegram);
        const single = await singleTool.execute({ message: 4, emoji: '👍' }, signal);
        expect(!single.isError, `the single form succeeds (got ${single.content})`);
        expect(
            json(apiTargetsOf(singleTelegram)) === json([bodyA]),
            `the single form targets the current body (got ${json(apiTargetsOf(singleTelegram))})`
        );

        const batchTelegram = createFakeTelegram();
        const batchTool = toolOn(
            CHAT,
            [
                { number: 5, messageId: firstB, fromBot: true },
                { number: 6, messageId: ask, fromBot: false },
            ],
            batchTelegram
        );
        const batch = await batchTool.execute({ messages: [5, 6], emoji: '👍' }, signal);
        expect(!batch.isError, `the batch succeeds (got ${batch.content})`);
        expect(
            json(apiTargetsOf(batchTelegram)) === json([bodyB, ask]),
            `the batch targets the reply body and the user message (got ${json(apiTargetsOf(batchTelegram))})`
        );

        const singleRow = (await rowsOf(CHAT, firstA))[0];
        const batchRow = (await rowsOf(CHAT, firstB))[0];
        expect(
            singleRow?.sourceMessageId === bodyA && batchRow?.sourceMessageId === bodyB,
            'each write names the message it reacted to'
        );
        expect(
            singleRow?.part === 'body' &&
                singleRow.partIndex === 1 &&
                batchRow?.part === 'body' &&
                batchRow.partIndex === 1,
            'both forms snapshot the same part'
        );
        expect(singleRow?.emoji === '👍' && batchRow?.emoji === '👍', 'both write the emoji');
        const userRow = (await rowsOf(CHAT, ask))[0];
        expect(userRow?.part === null && userRow?.partIndex === null, 'a user message has no part');
        expect(userRow?.sourceMessageId === ask && userRow?.emoji === '👍', 'but its row still names the message');
    })
);

reportResults(results);
