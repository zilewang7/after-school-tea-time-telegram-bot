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
import type { ToolOverrides } from '../../src/services/tool-overrides.js';

// Read when the queries run; set before the db layer is imported
process.env.BOT_USER_ID = '7777';
process.env.BOT_NAME = 'Bot';

const db = await setupOfflineDb();
const { BotResponse, ButtonState } = await import('../../src/db/botResponseDTO.js');
const { MessageReaction } = await import('../../src/db/messageReactionDTO.js');
const { replaceBotReaction } = await import('../../src/db/queries/reaction-queries.js');
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

const CHAT = -1009123000201;
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
const contextOf = (chatId: number, entries: readonly IndexEntry[], telegram: FakeTelegram) => {
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
        signal,
        api: telegram.api,
    });
};

const toolOn = (chatId: number, entries: readonly IndexEntry[], telegram: FakeTelegram) =>
    createReactToMessageTool(contextOf(chatId, entries, telegram));

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
        expect(json(schema.required) === json(['message']), 'only the message number is required');
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

reportResults(results);
