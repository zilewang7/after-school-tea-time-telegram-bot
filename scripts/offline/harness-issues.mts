/**
 * Offline cases for the harness issue list — the model's own bug tracker.
 *
 * No network, no Telegram: the cases drive the service and the two tools
 * directly against the scratch SQLite database.
 *
 * Run: npx tsx scripts/offline/harness-issues.mts
 */
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';
import type { ToolHandler } from '../../src/ai/tools/tool-types.js';

await setupOfflineDb();
const { createHarnessIssue, listHarnessIssues, clearHarnessIssues } = await import(
    '../../src/services/harness-issue-service.js'
);
const { createCreateHarnessIssueTool, createListHarnessIssuesTool } = await import(
    '../../src/reply/tools/harness-issue-tool.js'
);
const { createHarnessIssueState, MAX_HARNESS_ISSUES_PER_REPLY } = await import(
    '../../src/reply/tools/harness-issue-state.js'
);
const { HarnessIssue } = await import('../../src/db/harnessIssueDTO.js');
const { readToolConfig } = await import('../../src/config/tool-config.js');

const signal = new AbortController().signal;
const call = (handler: ToolHandler, args: Readonly<Record<string, unknown>>) => handler.execute(args, signal);

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'a recorded issue is open by default and reads back from the list',
        body: async () => {
            await clearHarnessIssues();
            const created = await createHarnessIssue({
                title: 'send_sticker 的描述没写可以整行照抄目录',
                body: '模型照着目录整行传，第一次被拒，试了两次才成功。',
                kind: 'improvement',
                severity: 'medium',
                toolName: 'send_sticker',
                chatId: -100123,
            });
            expect(created.status === 'open', `new issues start open (got ${created.status})`);
            expect(created.toolName === 'send_sticker', 'the related tool is stored');
            expect(created.chatId === -100123, 'the reporting chat is stored');

            const { records: open } = await listHarnessIssues({ status: 'open' });
            expect(open.length === 1 && open[0]?.id === created.id, 'the open list returns it');
        },
    },
    {
        name: 'closed covers triaged/fixed/wontfix/duplicate and hides open issues',
        body: async () => {
            await clearHarnessIssues();
            const first = await createHarnessIssue({ title: '甲', body: '正文甲', kind: 'bug' });
            const second = await createHarnessIssue({ title: '乙', body: '正文乙', kind: 'feature' });
            await HarnessIssue.update({ status: 'fixed' }, { where: { id: first.id } });
            await HarnessIssue.update({ status: 'duplicate' }, { where: { id: second.id } });

            const { records: closed } = await listHarnessIssues({ status: 'closed' });
            expect(closed.length === 2, `both closed issues are returned (got ${closed.length})`);
            expect(
                closed.every((issue) => issue.status !== 'open'),
                'closed never contains an open issue'
            );
            const { records: open } = await listHarnessIssues({ status: 'open' });
            expect(open.length === 0, 'the open list is empty once both are closed');
            const { records: all } = await listHarnessIssues({ status: 'all' });
            expect(all.length === 2, 'all returns both');
        },
    },
    {
        name: 'the keyword matches title and body and the limit caps the rows',
        body: async () => {
            await clearHarnessIssues();
            await createHarnessIssue({ title: '标题里有 风控 两个字', body: '无关正文', kind: 'bug' });
            await createHarnessIssue({ title: '无关标题', body: '正文提到 风控 的处理', kind: 'bug' });
            await createHarnessIssue({ title: '第三条', body: '第三条正文', kind: 'bug' });

            const { records: hits } = await listHarnessIssues({ status: 'open', query: '风控' });
            expect(hits.length === 2, `title and body both match the keyword (got ${hits.length})`);
            const { records: limited } = await listHarnessIssues({ status: 'open', limit: 1 });
            expect(limited.length === 1, `limit caps the rows (got ${limited.length})`);
        },
    },
    {
        name: 'the create tool rejects malformed or oversized input without writing',
        body: async () => {
            await clearHarnessIssues();
            const tool = createCreateHarnessIssueTool({
                state: createHarnessIssueState(),
                chatId: -100123,
            });
            const noTitle = await call(tool, { body: '正文', kind: 'bug' });
            expect(noTitle.isError, 'a missing title is rejected');
            const badKind = await call(tool, { title: '标题', body: '正文', kind: 'weird' });
            expect(badKind.isError && badKind.content.includes('bug'), 'an unknown kind is rejected');
            const longTitle = await call(tool, { title: '长'.repeat(201), body: '正文', kind: 'bug' });
            expect(longTitle.isError && longTitle.content.includes('200'), 'an over-long title is rejected');
            const longBody = await call(tool, { title: '标题', body: '长'.repeat(4001), kind: 'bug' });
            expect(longBody.isError && longBody.content.includes('4000'), 'an over-long body is rejected');
            expect((await listHarnessIssues({ status: 'all' })).records.length === 0, 'nothing was written');
        },
    },
    {
        name: 'one reply records at most three issues',
        body: async () => {
            await clearHarnessIssues();
            const tool = createCreateHarnessIssueTool({
                state: createHarnessIssueState(),
                chatId: -100123,
            });
            for (let index = 0; index < MAX_HARNESS_ISSUES_PER_REPLY; index += 1) {
                const result = await call(tool, {
                    title: `第 ${index + 1} 条`,
                    body: '正文',
                    kind: 'bug',
                });
                expect(!result.isError, `issue ${index + 1} is accepted`);
            }
            const fourth = await call(tool, { title: '第 4 条', body: '正文', kind: 'bug' });
            expect(
                fourth.isError && fourth.content.includes('3 条'),
                `the fourth is refused (got ${fourth.content})`
            );
            expect((await listHarnessIssues({ status: 'all' })).records.length === 3, 'only three rows exist');
        },
    },
    {
        name: 'the list tool renders id, status and kind',
        body: async () => {
            await clearHarnessIssues();
            const created = await createHarnessIssue({
                title: '列表格式',
                body: '正文',
                kind: 'improvement',
                severity: 'high',
            });
            const tool = createListHarnessIssuesTool({ chatId: -100123 });
            const result = await call(tool, { status: 'open' });
            expect(!result.isError, 'the list call succeeds');
            expect(
                result.content.includes(`#${created.id} [open][improvement][high]`),
                `the row names id, status, kind and severity (got ${result.content})`
            );
            const empty = await call(tool, { status: 'open', query: '没有这个关键词' });
            expect(empty.content.includes('没有匹配的 issue'), 'an empty result says so');
        },
    },
    {
        name: 'the list reports whole-list counts so an empty answer needs no second call',
        body: async () => {
            await clearHarnessIssues();
            const tool = createListHarnessIssuesTool({ chatId: -100123 });

            const empty = await call(tool, { status: 'open' });
            expect(
                empty.content.includes('没有匹配的 issue') &&
                    empty.content.includes('全部 0 条') &&
                    empty.content.includes('open 0'),
                `an empty list reports zero everywhere (got ${empty.content})`
            );

            const first = await createHarnessIssue({ title: '甲', body: '正文甲', kind: 'bug' });
            await createHarnessIssue({ title: '乙', body: '正文乙', kind: 'feature' });
            await HarnessIssue.update({ status: 'fixed' }, { where: { id: first.id } });

            const openView = await call(tool, { status: 'open' });
            expect(
                openView.content.includes('共 1 条') &&
                    openView.content.includes('全部 2 条') &&
                    openView.content.includes('open 1') &&
                    openView.content.includes('fixed 1'),
                `the open view still counts the closed one (got ${openView.content})`
            );

            const miss = await call(tool, { status: 'open', query: '没有这个关键词' });
            expect(
                miss.content.includes('没有匹配的 issue') && miss.content.includes('全部 2 条'),
                `a filtered miss still reports the whole list (got ${miss.content})`
            );
        },
    },
    {
        name: 'HARNESS_ISSUES=0 switches the tool group off',
        body: async () => {
            expect(readToolConfig({}).harnessIssues, 'the group is on by default');
            expect(
                readToolConfig({ HARNESS_ISSUES: '0' }).harnessIssues === false,
                'setting 0 turns it off'
            );
        },
    },
    {
        name: 'recording an issue does not charge the reply tool budget',
        body: async () => {
            const { toolTimeSpentMs } = await import('../../src/ai/tools/tool-round.js');
            const executed = (name: string, durationMs: number) => ({
                call: { id: name, name, argumentsJson: '{}' },
                result: { content: '', isError: false, images: [], record: null },
                durationMs,
            });
            const charged = toolTimeSpentMs([
                executed('search_history', 1200),
                executed('list_harness_issues', 300),
                executed('create_harness_issue', 400),
                executed('get_ui_guide', 500),
                executed('send_file', 100),
                executed('send_widget', 900),
                executed('workspace_write', 700),
                executed('workspace_read', 200),
                executed('workspace_list', 100),
                executed('workspace_find', 300),
                executed('workspace_edit', 600),
                executed('workspace_copy', 300),
                executed('workspace_delete', 100),
                executed('workspace_preview', 800),
            ]);
            expect(charged === 1200, `only search_history is charged (got ${charged}ms)`);
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
reportResults(results);
