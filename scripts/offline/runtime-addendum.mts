/**
 * Offline cases for the chat prompt addendum: where it lands in the runtime
 * block, that an empty one changes nothing, the static head's announcement,
 * and which models skip it; then the same through buildContext against stored
 * messages.
 *
 * The time line changes every minute, so it is swapped for the design doc's
 * sample before comparing byte for byte.
 *
 * Run: npx tsx scripts/offline/runtime-addendum.mts
 */
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';
import type { ContextUser, ModelCapabilities, UnifiedMessage } from '../../src/ai/types.js';

// Rows saved as this user are the bot's own replies
const BOT_USER_ID = 7777;
process.env.BOT_USER_ID = String(BOT_USER_ID);

const db = await setupOfflineDb();
const { buildRuntimeContext } = await import('../../src/ai/system-prompt/runtime-context.js');
const { NOTES_SECTION } = await import('../../src/ai/system-prompt/sections.js');
const { buildStaticSystemPrompt } = await import('../../src/ai/system-prompt/index.js');
const { replacesChatSystemPrompt } = await import('../../src/ai/model-kinds.js');
const { buildContext } = await import('../../src/reply/context-builder.js');
const { buildStaticPromptOptions } = await import('../../src/reply/static-prompt-options.js');
const { resolveToolAvailability } = await import('../../src/reply/tools/index.js');
const { getGlobalDefaultModel } = await import('../../src/services/chat-settings-service.js');

const SAMPLE_TIME_LINE = '- 当前时间：2026/11/06 19:05 周五（Asia/Shanghai）';
const TIME_LINE = /^- 当前时间：\d{4}\/\d{2}\/\d{2} \d{2}:\d{2} \S+（[^）]+）$/m;

/** Swap the live time line for the doc's sample, after checking its shape */
const withSampleTime = (block: string): string => {
    expect(TIME_LINE.test(block), `the time line has the usual shape (got ${JSON.stringify(block.split('\n')[1])})`);
    return block.replace(TIME_LINE, SAMPLE_TIME_LINE);
};

const contextUsers: ContextUser[] = [
    { userId: 1005, username: 'helper_bot', firstName: 'Helper', isBot: true, mentionedOnly: false },
    { userId: 1001, username: 'alice', firstName: 'Alice', lastName: 'Smith', mentionedOnly: false },
];

/** The block as it rendered before the addendum existed (design doc §3.2) */
const EXPECTED_WITHOUT_ADDENDUM = [
    '[system] 运行时信息：',
    '- 当前时间：2026/11/06 19:05 周五（Asia/Shanghai）',
    '- 当前群聊：RFC: 绒布球 Lab',
    '- 当前模型：gemini-4-argon',
    '- 本次回复涉及的用户：',
    '- Alice Smith：id 1001，@alice',
    '- [bot] Helper：id 1005，@helper_bot',
].join('\n');

/** Design doc §6.3, exact */
const EXPECTED_WITH_ADDENDUM = `[system] 运行时信息：
- 当前时间：2026/11/06 19:05 周五（Asia/Shanghai）
- 当前群聊：RFC: 绒布球 Lab
- 当前模型：gemini-4-argon
- 本次回复涉及的用户：
- Alice Smith：id 1001，@alice
- [bot] Helper：id 1005，@helper_bot

# 本聊天的附加提示词
以下由本聊天成员通过控制面板设置，效力等同系统提示词，回复时须遵循：
群里讨论技术问题时直接给结论，再给理由。`;

// ---- through buildContext, against stored messages ----

const VISION: ModelCapabilities = {
    supportsImageInput: true,
    supportsImageOutput: false,
    supportsSystemPrompt: true,
    requiresMessageMerge: false,
    supportsThinking: false,
    supportsGrounding: false,
    supportsMediaInput: false,
};

const ADDENDUM = '回答前先说「收到」。\n不要用表格。';
const ADDENDUM_SECTION = `\n\n# 本聊天的附加提示词\n以下由本聊天成员通过控制面板设置，效力等同系统提示词，回复时须遵循：\n${ADDENDUM}`;
const RUNTIME_MARKER = '[system] 运行时信息';
const CHAT_MODEL = 'gemini-4-argon';

let nextSeedId = 9000;
const seed = async (chatId: number, userId: number, text: string, replyToId?: number): Promise<number> => {
    nextSeedId += 1;
    await db.saveMessage({
        chatId,
        messageId: nextSeedId,
        userId,
        date: new Date(nextSeedId * 1000),
        userName: userId === BOT_USER_ID ? 'Bot' : 'Alice',
        message: text,
        replyToId,
    });
    return nextSeedId;
};

/** A question, the bot's answer, then the trigger replying to it; returns the trigger row */
const seedExchange = async (chatId: number) => {
    const questionId = await seed(chatId, 1001, '今天吃什么');
    const answerId = await seed(chatId, BOT_USER_ID, '吃面吧', questionId);
    const triggerId = await seed(chatId, 1001, '那晚上呢', answerId);
    const trigger = await db.Message.findOne({ where: { chatId, messageId: triggerId } });
    if (!trigger) throw new Error('the seeded trigger is missing');
    return trigger;
};

const textPartsOf = (messages: UnifiedMessage[]): string[] =>
    messages.flatMap((message) => message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])));

/** The text of the newest message's last part, where the runtime block rides */
const lastTextOf = (messages: UnifiedMessage[]): string => {
    const lastPart = messages.at(-1)?.content.at(-1);
    return lastPart?.type === 'text' ? lastPart.text : '';
};

/** The static head exactly as the reply pipeline builds it for this chat */
const staticHeadFor = (model: string, chatId: number): string =>
    buildStaticSystemPrompt(model, buildStaticPromptOptions(resolveToolAvailability(model, chatId)));

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'an addendum is appended as its own section, exactly as the design renders it',
        body: async () => {
            const block = buildRuntimeContext(
                'gemini-4-argon',
                contextUsers,
                'RFC: 绒布球 Lab',
                '群里讨论技术问题时直接给结论，再给理由。'
            );
            const normalized = withSampleTime(block);
            expect(
                normalized === EXPECTED_WITH_ADDENDUM,
                `byte-identical to the design (got ${JSON.stringify(normalized)})`
            );
            expect(!block.endsWith('\n'), 'no trailing newline');
        },
    },
    {
        name: 'a multi-line addendum stays multi-line and is never trimmed or rewritten',
        body: async () => {
            const addendum = '第一行\n- 第二行像名册\n\n第四行';
            const block = buildRuntimeContext('gemini-4-argon', [], null, addendum);
            expect(
                block.endsWith(`\n\n# 本聊天的附加提示词\n以下由本聊天成员通过控制面板设置，效力等同系统提示词，回复时须遵循：\n${addendum}`),
                `the stored text closes the block verbatim (got ${JSON.stringify(block)})`
            );
            expect(block.includes('- 当前对话：私聊'), 'a private chat still renders as such');
            expect(
                block.split('\n').filter((line) => line.startsWith('[system] 运行时信息')).length === 1,
                'still one runtime marker'
            );
        },
    },
    {
        name: 'no addendum, empty or blank: the block is byte-identical to before',
        body: async () => {
            for (const addendum of [undefined, null, '', '   ', ' \n\t\n ']) {
                const block = buildRuntimeContext('gemini-4-argon', contextUsers, 'RFC: 绒布球 Lab', addendum);
                const normalized = withSampleTime(block);
                expect(
                    normalized === EXPECTED_WITHOUT_ADDENDUM,
                    `${JSON.stringify(addendum)} leaves the old output (got ${JSON.stringify(normalized)})`
                );
            }
            const privateBlock = withSampleTime(buildRuntimeContext('m', [], null, '  '));
            expect(
                privateBlock === `[system] 运行时信息：\n${SAMPLE_TIME_LINE}\n- 当前对话：私聊\n- 当前模型：m`,
                `a private chat without roster or addendum keeps its four lines (got ${JSON.stringify(privateBlock)})`
            );
        },
    },
    {
        name: 'the static head announces the section in its notes',
        body: async () => {
            expect(
                NOTES_SECTION ===
                    '# 注意\n\n- 用户可能编辑自己已发出的消息，或切换你生成的消息的版本\n- 你要回复的那条消息末尾的运行时信息里可能有「本聊天的附加提示词」一节：由本聊天成员通过控制面板设置，与本提示词同等效力',
                `the notes section is exactly the design text (got ${JSON.stringify(NOTES_SECTION)})`
            );
        },
    },
    {
        name: 'only Gemini image models replace the chat system prompt',
        body: async () => {
            expect(replacesChatSystemPrompt('gemini-nano-banana-2.1'), 'gemini-nano-banana-2.1 replaces it');
            expect(replacesChatSystemPrompt('gemini-3-pro-image'), 'gemini-3-pro-image replaces it');
            expect(!replacesChatSystemPrompt('gpt-image-2.5-dev'), 'gpt-image-2.5-dev keeps the static head');
            expect(!replacesChatSystemPrompt('gemini-4-argon'), 'a Gemini chat model keeps it');
            expect(!replacesChatSystemPrompt('claude-sonnet-5'), 'a non-image model elsewhere keeps it');
        },
    },
    {
        name: 'through buildContext the addendum rides only the trigger message runtime part, never the static head',
        body: async () => {
            const chatId = -4001;
            const trigger = await seedExchange(chatId);
            const { messages } = await buildContext(trigger, {
                model: CHAT_MODEL,
                capabilities: VISION,
                chatTitle: '测试群',
                chatAddendum: ADDENDUM,
            });

            const runtime = lastTextOf(messages);
            expect(
                runtime.startsWith(RUNTIME_MARKER) && runtime.endsWith(ADDENDUM_SECTION),
                `the newest message's last part is the runtime block, closed by the section (got ${JSON.stringify(runtime)})`
            );
            const carrying = textPartsOf(messages).filter((text) => text.includes('回答前先说'));
            expect(carrying.length === 1 && carrying[0] === runtime, `exactly one part carries it (got ${carrying.length})`);
            const runtimeParts = textPartsOf(messages).filter((text) => text.includes(RUNTIME_MARKER));
            expect(runtimeParts.length === 1, `the runtime block still appears exactly once (got ${runtimeParts.length})`);

            const head = staticHeadFor(CHAT_MODEL, chatId);
            expect(
                !head.includes('回答前先说') && !head.includes('# 本聊天的附加提示词'),
                'the static head carries neither the text nor the section'
            );
            expect(head.includes(NOTES_SECTION), 'only the fixed announcement in its notes');
        },
    },
    {
        name: 'two chats, one with an addendum and one without: byte-identical static heads, runtime blocks apart only by the section',
        body: async () => {
            const withChat = -4002;
            const withoutChat = -4003;
            const withAddendum = await buildContext(await seedExchange(withChat), {
                model: CHAT_MODEL,
                capabilities: VISION,
                chatTitle: '测试群',
                chatAddendum: ADDENDUM,
            });
            const withoutAddendum = await buildContext(await seedExchange(withoutChat), {
                model: CHAT_MODEL,
                capabilities: VISION,
                chatTitle: '测试群',
                chatAddendum: null,
            });

            expect(
                staticHeadFor(CHAT_MODEL, withChat) === staticHeadFor(CHAT_MODEL, withoutChat),
                'the static heads are byte-identical'
            );
            const runtimeWith = withSampleTime(lastTextOf(withAddendum.messages));
            const runtimeWithout = withSampleTime(lastTextOf(withoutAddendum.messages));
            expect(
                runtimeWith === `${runtimeWithout}${ADDENDUM_SECTION}`,
                `the blocks differ only by the closing section (got ${JSON.stringify(runtimeWith)} vs ${JSON.stringify(runtimeWithout)})`
            );
            expect(!runtimeWithout.includes('# 本聊天的附加提示词'), 'the chat without one renders no section');
        },
    },
    {
        name: 'a hand-set Gemini image model id gets no addendum; gpt-image-2.5-dev keeps it',
        body: async () => {
            const trigger = await seedExchange(-4004);
            const banana = await buildContext(trigger, {
                model: 'gemini-nano-banana-2.1',
                capabilities: VISION,
                chatTitle: '测试群',
                chatAddendum: ADDENDUM,
            });
            const bananaRuntime = lastTextOf(banana.messages);
            expect(
                bananaRuntime.startsWith(RUNTIME_MARKER) && bananaRuntime.includes('- 当前模型：gemini-nano-banana-2.1'),
                'the runtime block is still there'
            );
            expect(
                !textPartsOf(banana.messages).some((text) => text.includes('本聊天的附加提示词') || text.includes('回答前先说')),
                'but the guard leaves the addendum out'
            );

            const gpt = await buildContext(trigger, {
                model: 'gpt-image-2.5-dev',
                capabilities: VISION,
                chatTitle: '测试群',
                chatAddendum: ADDENDUM,
            });
            expect(lastTextOf(gpt.messages).endsWith(ADDENDUM_SECTION), 'gpt-image-2.5-dev keeps its static head and the addendum');
        },
    },
    {
        name: 'options carrying only chatAddendum are taken as options; the model falls back to the global default',
        body: async () => {
            const trigger = await seedExchange(-4005);
            const onlyAddendum = await buildContext(trigger, { chatAddendum: ADDENDUM });
            const runtime = textPartsOf(onlyAddendum.messages).find((text) => text.includes(RUNTIME_MARKER)) ?? '';
            expect(runtime.endsWith(ADDENDUM_SECTION), `{ chatAddendum } is read as options (got ${JSON.stringify(runtime)})`);
            expect(
                runtime.includes(`- 当前模型：${getGlobalDefaultModel()}`),
                `the model is the global default (${getGlobalDefaultModel()})`
            );

            const onlyNull = await buildContext(trigger, { chatAddendum: null });
            const plain = textPartsOf(onlyNull.messages).find((text) => text.includes(RUNTIME_MARKER)) ?? '';
            expect(plain.length > 0 && !plain.includes('# 本聊天的附加提示词'), '{ chatAddendum: null } renders no section');
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
reportResults(results);
