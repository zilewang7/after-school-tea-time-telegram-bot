/**
 * Offline cases for the chat prompt addendum: where it lands in the runtime
 * block, that an empty one changes nothing, the static head's announcement,
 * and which models skip it.
 *
 * Pure rendering, no database. The time line changes every minute, so it is
 * swapped for the design doc's sample before comparing byte for byte.
 *
 * Run: npx tsx scripts/offline/runtime-addendum.mts
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import type { ContextUser } from '../../src/ai/types.js';

const { buildRuntimeContext } = await import('../../src/ai/system-prompt/runtime-context.js');
const { NOTES_SECTION } = await import('../../src/ai/system-prompt/sections.js');
const { replacesChatSystemPrompt } = await import('../../src/ai/model-kinds.js');

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
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
reportResults(results);
