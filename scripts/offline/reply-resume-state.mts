/**
 * Offline cases for the tool state a "继续" hands back (design 2026-1112-1123
 * §6.2, §6.5 steps 3-4; test plan §11 第 3 期 case 8): the ids the
 * interrupted version's tools handed out still resolve (`g1`, `h1`), the
 * per-reply limits go on counting (harness issues, workspace writes,
 * search_by_image), and the resumed request is the interrupted one byte for
 * byte: the workspace manifest is not appended a second time. Same bench as
 * reply-resume.mts, with the luoxu stub answering the history tools.
 *
 * Run: npx tsx scripts/offline/reply-resume-state.mts
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import { endOpenReplies } from './fake-telegram.mts';
import { answer } from './support/gemini-loop-fixtures.mts';
import {
    answersIn,
    createResumeBench,
    failingRound,
    HISTORY_CHAT_ID,
    imageReply,
    json,
    quietCase,
    roundOf,
    takeChatId,
    type FunctionAnswer,
} from './support/resume-bench.mts';

const bench = await createResumeBench();
const { telegram, vertex } = bench;
const { MAX_HARNESS_ISSUES_PER_REPLY } = await import('../../src/reply/tools/harness-issue-state.js');
const { MAX_SEARCHES_PER_REPLY } = await import('../../src/reply/tools/search-by-image-tool.js');

const answerOf = (answers: readonly FunctionAnswer[], name: string): FunctionAnswer[] =>
    answers.filter((item) => item.name === name);

const cases: Array<{ name: string; body: () => Promise<void> }> = [
    {
        name: 'case 8: after 继续 the model still refers to g1 (a drawn picture) and h1 (a history hit)',
        body: quietCase(async () => {
            vertex.reset([
                roundOf({
                    label: 'r1',
                    calls: [
                        { name: 'generate_image', args: { prompt: '一只猫' } },
                        { name: 'search_history', args: { query: '显卡' } },
                    ],
                }),
                imageReply(),
                failingRound(),
            ]);
            telegram.reset();
            const reply = await bench.ask(HISTORY_CHAT_ID, '@AfterSchoolTeatimeBot 画只猫再翻翻记录');
            const entry = bench.entryOf(reply);
            expect(entry?.toolState.media.generated.size === 1, `g1 was drawn (got ${json(entry?.toolState.media.generated.size)})`);
            expect(entry?.toolState.history.entries().length !== 0, 'and the history hits were numbered');
            const luoxuBefore = bench.luoxuRequests.length;

            vertex.reset([
                roundOf({
                    label: 'r2',
                    calls: [
                        { name: 'send_image', args: { image_id: 'g1' } },
                        { name: 'read_history', args: { ids: ['h1'] } },
                    ],
                }),
                answer('图和记录都在。'),
            ]);
            telegram.reset();
            await bench.continueReply(reply);
            const answers = answersIn(vertex.requests[1]);
            const sendImage = answerOf(answers, 'send_image').at(-1);
            expect(sendImage?.output !== undefined && sendImage.error === undefined, `send_image found g1 (got ${json(sendImage)})`);
            expect(telegram.callsOf('sendPhoto').length === 1, 'and the picture went out with the reply');
            const readHistory = answerOf(answers, 'read_history').at(-1);
            const readText = readHistory?.output ?? readHistory?.error ?? '';
            expect(!readText.includes('没有 h1'), `read_history knew h1 (got ${json(readHistory)})`);
            expect(
                bench.luoxuRequests.slice(luoxuBefore).some((path) => path.startsWith('/messages')),
                `and asked the archive for it (got ${json(bench.luoxuRequests.slice(luoxuBefore))})`
            );
        }),
    },
    {
        name: 'case 8: the per-reply limits go on counting: harness issues, search_by_image',
        body: quietCase(async () => {
            const issueCalls = Array.from({ length: MAX_HARNESS_ISSUES_PER_REPLY }, (_unused, index) => ({
                name: 'create_harness_issue',
                args: { title: `问题 ${index + 1}`, body: '离线测试记下的问题', kind: 'bug' },
            }));
            vertex.reset([roundOf({ label: 'r1', calls: issueCalls }), failingRound()]);
            telegram.reset();
            const reply = await bench.ask(takeChatId(), '@AfterSchoolTeatimeBot 记几个问题');
            const entry = bench.entryOf(reply);
            if (entry === undefined) throw new Error('nothing was kept');
            expect(entry.toolState.harnessIssues.createdCount() === MAX_HARNESS_ISSUES_PER_REPLY, 'the issues of round 1 were filed');
            // search_by_image only counts real searches against an outside service: the
            // interrupted version is given its spent allowance directly
            entry.toolState.media.reverseSearchCount = MAX_SEARCHES_PER_REPLY;
            const toolState = entry.toolState;

            vertex.reset([
                roundOf({
                    label: 'r2',
                    calls: [
                        { name: 'create_harness_issue', args: { title: '再一个问题', body: '超出上限', kind: 'bug' } },
                        { name: 'search_by_image', args: { message: 1 } },
                    ],
                }),
                answer('到上限了。'),
            ]);
            telegram.reset();
            await bench.continueReply(reply);
            const answers = answersIn(vertex.requests[1]);
            const issue = answerOf(answers, 'create_harness_issue').at(-1);
            expect(
                issue?.error?.includes(`已经记录了 ${MAX_HARNESS_ISSUES_PER_REPLY} 条 issue`) === true,
                `the issue past the limit is refused (got ${json(issue)})`
            );
            const search = answerOf(answers, 'search_by_image').at(-1);
            expect(
                search?.error?.includes(`已经做过 ${MAX_SEARCHES_PER_REPLY} 次以图搜图`) === true,
                `search_by_image is at its limit (got ${json(search)})`
            );
            expect(toolState.harnessIssues.createdCount() === MAX_HARNESS_ISSUES_PER_REPLY, 'no fourth issue');
            const filed = await bench.dbIndex.HarnessIssue.count({ where: { chatId: reply.chatId } });
            expect(filed === MAX_HARNESS_ISSUES_PER_REPLY, `three issues in the database (got ${filed})`);
        }),
    },
    {
        name: 'case 8: the resumed request is the interrupted one byte for byte; the workspace manifest rides round 1 once',
        body: quietCase(async () => {
            vertex.reset([roundOf({ label: 'r1', calls: [{ name: 'workspace_write', args: { path: 'a.md', content: 'A' } }] }), failingRound()]);
            telegram.reset();
            const reply = await bench.ask(takeChatId(), '@AfterSchoolTeatimeBot 写份草稿');
            const [round1, failedRound2] = vertex.requests;
            const manifestLine = '用 workspace_write 创建草稿';
            expect(round1?.rawBody.includes(manifestLine) === true, 'the first request carries the workspace manifest');

            vertex.reset([answer('写好了。')]);
            telegram.reset();
            await bench.continueReply(reply);
            const resumed = vertex.requests[0];
            expect(resumed?.rawBody === failedRound2?.rawBody, 'the resumed request is the failed round 2, byte for byte');
            expect(
                (resumed?.rawBody.split(manifestLine).length ?? 0) - 1 === 1,
                'the manifest appears once, as round 1 had it'
            );
        }),
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
endOpenReplies();
await bench.close();
reportResults(results);
