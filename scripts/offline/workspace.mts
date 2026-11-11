/**
 * Offline cases for the model workspace — the per-conversation draft file
 * system (no containers, no network, no Telegram).
 *
 * Run: npx tsx scripts/offline/workspace.mts
 *
 * Covers the path rules, read/write/edit/delete and their quotas, the manifest
 * builder and its workspace tokens, the tool handlers, `send_file` /
 * `send_widget` reading from the workspace, the preview tool with an injected
 * renderer, and the 7-day LRU cleanup.
 */
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';
import type { ToolHandler } from '../../src/ai/tools/tool-types.js';

await setupOfflineDb();
const { WorkspaceFile } = await import('../../src/db/workspaceFileDTO.js');
const {
    deleteWorkspaceFile,
    editWorkspaceFile,
    formatWorkspaceTime,
    listWorkspaceFiles,
    loadWorkspaceSnapshots,
    normalizeWorkspacePath,
    normalizeWorkspacePrefix,
    readWorkspaceFile,
    summarizeWorkspaceContent,
    writeWorkspaceFile,
    workspaceUsageOf,
} = await import('../../src/services/workspace-service.js');
const { createWorkspaceState, ensureWorkspaceToken, resolveWorkspaceRef } = await import(
    '../../src/reply/workspace/workspace-state.js'
);
const { buildWorkspaceManifest } = await import('../../src/reply/workspace/workspace-manifest.js');
const { createWorkspaceWriteTool } = await import('../../src/reply/tools/workspace-write-tool.js');
const { createWorkspaceReadTool } = await import('../../src/reply/tools/workspace-read-tool.js');
const { createWorkspaceListTool } = await import('../../src/reply/tools/workspace-list-tool.js');
const { createWorkspaceEditTool } = await import('../../src/reply/tools/workspace-edit-tool.js');
const { createWorkspaceDeleteTool } = await import('../../src/reply/tools/workspace-delete-tool.js');
const { createWorkspacePreviewTool } = await import('../../src/reply/tools/workspace-preview-tool.js');
const { createSendFileTool } = await import('../../src/reply/tools/send-file-tool.js');
const { createSendWidgetTool } = await import('../../src/reply/tools/send-widget-tool.js');
const { createReplyMediaState } = await import('../../src/reply/tools/reply-media-state.js');
const { clearExpiredData } = await import('../../src/db/autoSave.js');

const CHAT = -1009999999999;
const OTHER_CHAT = -1008888888888;
const ROOT = 9001;
const OTHER_ROOT = 9002;
const EMPTY_ROOT = 9003;
const signal = new AbortController().signal;

const QUOTA = {
    maxFileBytes: 4096,
    maxConversationBytes: 12_000,
    maxFiles: 5,
    maxGlobalBytes: 1_000_000,
};

const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlZkAAAAASUVORK5CYII=',
    'base64'
);

const call = (handler: ToolHandler, args: Readonly<Record<string, unknown>>) => handler.execute(args, signal);

const captureConsole = async <T,>(body: () => Promise<T>): Promise<{ result: T; lines: string[] }> => {
    const lines: string[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    const record = (...args: unknown[]): void => {
        lines.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '));
    };
    console.log = record;
    console.warn = record;
    console.error = record;
    try {
        return { result: await body(), lines };
    } finally {
        console.log = original.log;
        console.warn = original.warn;
        console.error = original.error;
    }
};

const clearWorkspace = async (): Promise<void> => {
    await WorkspaceFile.destroy({ where: {} });
};

const stateOf = (rootIds: readonly number[] = [ROOT, OTHER_ROOT]) =>
    createWorkspaceState({
        chatId: CHAT,
        conversationRootIds: rootIds,
        quota: QUOTA,
        callLimits: { writes: 20, reads: 20, lists: 10, deletes: 10, previews: 6 },
    });

const write = (path: string, content: string, extra: Record<string, unknown> = {}) =>
    writeWorkspaceFile({
        chatId: CHAT,
        conversationRootId: ROOT,
        path,
        content,
        append: false,
        overwrite: false,
        quota: QUOTA,
        ...extra,
    });

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'workspace paths stay relative, shallow and free of control characters',
        body: async () => {
            expect(normalizeWorkspacePath('notes/plan.md').ok, 'a nested relative path is accepted');
            expect(!normalizeWorkspacePath('/etc/passwd').ok, 'an absolute path is rejected');
            expect(!normalizeWorkspacePath('../secret').ok, 'a .. segment is rejected');
            expect(!normalizeWorkspacePath('a\\b.md').ok, 'a backslash is rejected');
            expect(!normalizeWorkspacePath('a//b.md').ok, 'an empty segment is rejected');
            expect(!normalizeWorkspacePath('a/b/c/d.md').ok, 'more than three levels are rejected');
            expect(!normalizeWorkspacePath('a\u0000b.md').ok, 'a control character is rejected');
            // A rejected path must not leave a global regex mid-scan and let the
            // next path's leading control character through
            expect(!normalizeWorkspacePath('\u0001leading.md').ok, 'the next path is still checked');
            expect(!normalizeWorkspacePath(`${'x'.repeat(129)}.md`).ok, 'an over-long path is rejected');
            const normalized = normalizeWorkspacePath('  notes/plan.md  ');
            expect(normalized.ok && normalized.path === 'notes/plan.md', 'surrounding whitespace is trimmed');
            const prefix = normalizeWorkspacePrefix('widgets/');
            expect(prefix.ok && prefix.path === 'widgets/', 'a list prefix keeps its trailing slash');
            expect(normalizeWorkspacePrefix('').ok, 'an empty prefix means the whole workspace');
        },
    },
    {
        name: 'a written file reads back with its summary, line numbers and paging',
        body: async () => {
            await clearWorkspace();
            const content = '# 计划\n\n第一段\n第二段\n第三段';
            const written = await write('notes/plan.md', content);
            expect(written.ok && written.sizeBytes === Buffer.byteLength(content, 'utf8'), 'the write reports its bytes');
            expect(written.ok && written.created && written.fileCount === 1, 'the first write creates the file');

            const file = await readWorkspaceFile(CHAT, ROOT, 'notes/plan.md');
            expect(file?.content === content, 'the content reads back byte for byte');
            expect(file?.mimeType === 'text/markdown', 'the mime type comes from the extension');

            const tool = createWorkspaceReadTool({ state: stateOf() });
            const page = await call(tool, { path: 'notes/plan.md', limit: 2 });
            expect(!page.isError, `the read tool succeeds (${page.content})`);
            expect(page.content.includes('共 5 行'), 'the header states the total line count');
            expect(page.content.includes('1| # 计划'), 'lines are numbered from 1');
            expect(page.content.includes('显示第 1–2 行'), 'the shown range is stated');
            expect(page.content.includes('还有 3 行，用 offset=3 继续'), 'the remainder is stated explicitly');

            const tail = await call(tool, { path: 'notes/plan.md', offset: 4, limit: 2 });
            expect(tail.content.includes('4| 第二段') && tail.content.includes('5| 第三段'), 'offset pages correctly');
            const beyond = await call(tool, { path: 'notes/plan.md', offset: 99 });
            expect(beyond.isError && beyond.content.includes('超过文件行数'), 'an out-of-range offset is an actionable error');
        },
    },
    {
        name: 'overwrite needs an explicit flag and append continues the same file',
        body: async () => {
            await clearWorkspace();
            await write('a.txt', 'first');
            const blind = await write('a.txt', 'second');
            expect(!blind.ok && blind.error.includes('overwrite=true'), 'an existing file is not silently replaced');
            const replaced = await write('a.txt', 'second', { overwrite: true });
            expect(replaced.ok && replaced.replacedBytes === 5, 'overwrite reports the replaced size');
            const appended = await write('a.txt', ' tail', { append: true });
            expect(appended.ok && !appended.created, 'append does not create a new row');
            expect(appended.ok && appended.replacedBytes === null, 'append reports no replaced bytes');
            const file = await readWorkspaceFile(CHAT, ROOT, 'a.txt');
            expect(file?.content === 'second tail', 'append concatenates the text');
            const appendedNew = await write('b.txt', 'starts here', { append: true });
            expect(appendedNew.ok && appendedNew.created, 'append to a missing file creates it');
            expect(summarizeWorkspaceContent('  \n\n第一行\n第二行') === '第一行', 'the summary is the first non-empty line');
            await write('titled.md', '# 标题\n正文', { overwrite: true });
            await write('titled.md', '\n追加的一段', { append: true });
            const titled = await listWorkspaceFiles(CHAT, ROOT);
            const summary = titled.files.find((file) => file.path === 'titled.md')?.summary;
            expect(summary === '# 标题', `append keeps the file's first-line summary (got ${summary})`);

            await write('emptied.md', '有摘要\n正文', { overwrite: true });
            await write('emptied.md', '', { overwrite: true });
            const emptied = await listWorkspaceFiles(CHAT, ROOT);
            const emptiedSummary = emptied.files.find((file) => file.path === 'emptied.md')?.summary;
            expect(emptiedSummary === '', `overwriting to empty content clears the summary (got ${emptiedSummary})`);
        },
    },
    {
        name: 'edit replaces exactly one match and reports the closest lines when it misses',
        body: async () => {
            await clearWorkspace();
            await write('card.html', '<div class="a">x</div>\n<div class="b">y</div>\n');
            const missed = await editWorkspaceFile({
                chatId: CHAT,
                conversationRootId: ROOT,
                path: 'card.html',
                oldString: '<div class="c">z</div>',
                newString: 'x',
                replaceAll: false,
                quota: QUOTA,
            });
            expect(
                !missed.ok && missed.error.includes('最接近的内容在第 1 行附近：\n1| <div class="a">x</div>'),
                `a miss quotes the line number and the block (${missed.ok ? 'ok' : missed.error})`
            );
            const ambiguous = await editWorkspaceFile({
                chatId: CHAT,
                conversationRootId: ROOT,
                path: 'card.html',
                oldString: '<div',
                newString: '<section',
                replaceAll: false,
                quota: QUOTA,
            });
            expect(!ambiguous.ok && ambiguous.error.includes('出现了 2 次'), 'a non-unique match is refused');
            const edited = await editWorkspaceFile({
                chatId: CHAT,
                conversationRootId: ROOT,
                path: 'card.html',
                oldString: '<div class="a">x</div>',
                newString: '<div class="a">改好了</div>',
                replaceAll: false,
                quota: QUOTA,
            });
            expect(edited.ok && edited.replacements === 1, 'a unique match is replaced');
            const file = await readWorkspaceFile(CHAT, ROOT, 'card.html');
            expect(file?.content.includes('改好了'), 'the edit is in the file');
            const all = await editWorkspaceFile({
                chatId: CHAT,
                conversationRootId: ROOT,
                path: 'card.html',
                oldString: '<div',
                newString: '<section',
                replaceAll: true,
                quota: QUOTA,
            });
            expect(all.ok && all.replacements === 2, 'replace_all replaces every occurrence');
        },
    },
    {
        name: 'quotas stop runaway writes and delete frees them again',
        body: async () => {
            await clearWorkspace();
            const tooBig = await write('big.txt', 'x'.repeat(QUOTA.maxFileBytes + 1));
            expect(!tooBig.ok && tooBig.error.includes('单个文件上限'), 'the per-file cap is enforced');
            for (let index = 0; index < QUOTA.maxFiles; index += 1) {
                const result = await write(`f${index}.txt`, 'x');
                expect(result.ok, `file ${index + 1} fits`);
            }
            const tooMany = await write('overflow.txt', 'x');
            expect(!tooMany.ok && tooMany.error.includes('配额'), 'the file-count cap is enforced');
            const deleted = await deleteWorkspaceFile(CHAT, ROOT, 'f0.txt');
            expect(deleted.ok && deleted.fileCount === QUOTA.maxFiles - 1, 'delete reports the remaining count');
            const fits = await write('overflow.txt', 'x');
            expect(fits.ok, 'a freed slot can be used again');
        },
    },
    {
        name: 'conversations and chats never see each other',
        body: async () => {
            await clearWorkspace();
            await write('shared.txt', 'root one');
            await writeWorkspaceFile({
                chatId: CHAT,
                conversationRootId: OTHER_ROOT,
                path: 'shared.txt',
                content: 'root two',
                append: false,
                overwrite: false,
                quota: QUOTA,
            });
            await writeWorkspaceFile({
                chatId: OTHER_CHAT,
                conversationRootId: ROOT,
                path: 'shared.txt',
                content: 'another chat',
                append: false,
                overwrite: false,
                quota: QUOTA,
            });
            const first = await readWorkspaceFile(CHAT, ROOT, 'shared.txt');
            const second = await readWorkspaceFile(CHAT, OTHER_ROOT, 'shared.txt');
            const third = await readWorkspaceFile(OTHER_CHAT, ROOT, 'shared.txt');
            expect(first?.content === 'root one', 'the current conversation keeps its file');
            expect(second?.content === 'root two', 'another conversation of the same chat is isolated');
            expect(third?.content === 'another chat', 'another chat is isolated');
            const list = await listWorkspaceFiles(CHAT, ROOT);
            expect(list.usage.fileCount === 1, 'listing only counts this conversation');
        },
    },
    {
        name: 'list filters by prefix and reports usage; empty workspaces say so',
        body: async () => {
            await clearWorkspace();
            await write('widgets/a.html', 'a');
            await write('widgets/b.html', 'b');
            await write('notes/c.md', 'c');
            const tool = createWorkspaceListTool({ state: stateOf() });
            const all = await call(tool, {});
            expect(all.content.includes('共 3 个文件'), 'the whole workspace count is shown');
            expect(all.content.includes('widgets/a.html') && all.content.includes('notes/c.md'), 'all files are listed');
            const widgets = await call(tool, { prefix: 'widgets/' });
            expect(widgets.content.includes('widgets/a.html') && !widgets.content.includes('notes/c.md'), 'the prefix filters the list');
            const badPrefix = await call(tool, { prefix: 42 });
            expect(badPrefix.isError && badPrefix.content.includes('prefix'), 'a non-string prefix is an argument error');
            await clearWorkspace();
            const empty = await call(tool, {});
            expect(empty.content.includes('工作区是空的'), 'an empty workspace says so');
            const usage = await workspaceUsageOf(CHAT, ROOT);
            expect(usage.fileCount === 0 && usage.totalBytes === 0, 'usage of an empty workspace is zero');
        },
    },
    {
        name: 'the manifest lists the current conversation and gives spliced ones a token',
        body: async () => {
            await clearWorkspace();
            await write('notes/plan.md', '# 发布计划\n正文');
            await writeWorkspaceFile({
                chatId: CHAT,
                conversationRootId: OTHER_ROOT,
                path: 'other.md',
                content: '拼接会话里的草稿',
                append: false,
                overwrite: false,
                quota: QUOTA,
            });
            const state = stateOf([ROOT, OTHER_ROOT, EMPTY_ROOT]);
            const rootNumbers = new Map([
                [OTHER_ROOT, 7],
                [EMPTY_ROOT, 9],
            ]);
            const manifest = await buildWorkspaceManifest({
                state,
                conversationRootIds: [ROOT, OTHER_ROOT, EMPTY_ROOT],
                rootNumbers,
                fileTools: true,
                widgetTools: false,
            });
            expect(manifest !== null, 'the manifest is built');
            expect(manifest?.includes('本会话 w1'), 'the current conversation is w1');
            expect(manifest?.includes('notes/plan.md'), 'the current conversation file is listed');
            expect(manifest?.includes('拼接的会话 #7'), 'the spliced conversation is labelled with its context number');
            expect(manifest?.includes('w2'), 'the spliced conversation got a token');
            expect(resolveWorkspaceRef(state, 'w2').ok, 'the token resolves to the spliced conversation');
            expect(
                manifest?.includes('w3') && manifest?.includes('（空）'),
                'an empty spliced conversation still gets its token in the manifest'
            );
            expect(resolveWorkspaceRef(state, 'w3').ok, 'the empty spliced conversation is addressable');
            expect(
                manifest?.includes('send_file') && !manifest?.includes('send_widget'),
                'only the delivery tool this turn offers is named'
            );
            expect(!resolveWorkspaceRef(state, 'w9').ok, 'an unknown token is refused');

            const again = await buildWorkspaceManifest({
                state,
                conversationRootIds: [ROOT, OTHER_ROOT, EMPTY_ROOT],
                rootNumbers,
                fileTools: true,
                widgetTools: false,
            });
            expect(again === manifest, 'the manifest serializes deterministically');

            const readOnly = await buildWorkspaceManifest({
                state,
                conversationRootIds: [ROOT, OTHER_ROOT, EMPTY_ROOT],
                rootNumbers,
                fileTools: false,
                widgetTools: false,
            });
            expect(
                readOnly?.includes('用 workspace_read 读取文件内容。') && !readOnly?.includes('send_file'),
                'without delivery tools the footer only names workspace_read'
            );
            const sanitized = summarizeWorkspaceContent('第一行\r\n第二行');
            expect(sanitized === '第一行', 'a summary never carries a line break');
        },
    },
    {
        name: 'the tool flow writes, lists, reads, edits and deletes with call limits',
        body: async () => {
            await clearWorkspace();
            const state = createWorkspaceState({
                chatId: CHAT,
                conversationRootIds: [ROOT, OTHER_ROOT],
                quota: QUOTA,
                callLimits: { writes: 5, reads: 20, lists: 10, deletes: 10, previews: 6 },
            });
            ensureWorkspaceToken(state, OTHER_ROOT, '拼接的会话');
            const writeTool = createWorkspaceWriteTool({ state });
            const listTool = createWorkspaceListTool({ state });
            const readTool = createWorkspaceReadTool({ state });
            const editTool = createWorkspaceEditTool({ state });
            const deleteTool = createWorkspaceDeleteTool({ state });

            const first = await call(writeTool, { path: 'notes/a.md', content: '# A' });
            expect(!first.isError && first.content.includes('已写入'), 'write succeeds');
            const toOther = await call(writeTool, { path: 'notes/b.md', content: '# B', workspace: 'w2' });
            expect(!toOther.isError && toOther.content.includes('w2'), 'write can target the spliced conversation');
            const listed = await call(listTool, { workspace: 'w2' });
            expect(listed.content.includes('notes/b.md'), 'the spliced workspace lists its own file');
            const read = await call(readTool, { path: 'notes/a.md' });
            expect(read.content.includes('1| # A'), 'read returns numbered lines');
            const edited = await call(editTool, { path: 'notes/a.md', old_string: '# A', new_string: '# A 改' });
            expect(!edited.isError && edited.content.includes('替换 1 处'), 'edit succeeds');
            const appended = await call(writeTool, { path: 'notes/a.md', content: '\n追加', append: true });
            expect(
                !appended.isError && appended.content.includes('已追加到') && !appended.content.includes('已覆盖'),
                'append is reported as an append'
            );
            const overwritten = await call(writeTool, { path: 'notes/a.md', content: '# 重写', overwrite: true });
            expect(
                !overwritten.isError &&
                    overwritten.content.includes('已覆盖') &&
                    overwritten.content.includes('原 '),
                'overwrite names the replaced size'
            );

            const overLimit = await call(writeTool, { path: 'notes/c.md', content: '# C' });
            expect(overLimit.isError && overLimit.content.includes('次数已用完'), 'the per-reply write limit is enforced');
            const deleted = await call(deleteTool, { path: 'notes/a.md' });
            expect(!deleted.isError && deleted.content.includes('已删除'), 'delete succeeds');
            const missing = await call(readTool, { path: 'notes/a.md' });
            expect(missing.isError && missing.content.includes('workspace_list'), 'a missing file points at list');
        },
    },
    {
        name: 'send_file takes the bytes from a workspace file',
        body: async () => {
            await clearWorkspace();
            const state = stateOf();
            await write('reports/q3.md', '# Q3\n正文');
            const media = createReplyMediaState();
            const tool = createSendFileTool({ state: media, workspace: state });
            const result = await call(tool, { workspace_path: 'reports/q3.md', caption: '季度报告' });
            expect(!result.isError, `workspace_path send succeeds (${result.content})`);
            const file = result.files?.[0];
            expect(file?.name === 'q3.md', `the delivery name defaults to the basename (got ${file?.name})`);
            expect(file?.data.toString('utf8') === '# Q3\n正文', 'the bytes are the workspace content');
            expect(file?.caption === '季度报告', 'the caption travels with the file');
            expect(result.content.includes('已从工作区读出'), 'the result names the workspace source');

            const second = await call(tool, { workspace_path: 'reports/q3.md' });
            expect(second.isError && second.content.includes('只能发一个文件'), 'one attachment per reply still holds');
            const both = await call(createSendFileTool({ state: createReplyMediaState(), workspace: state }), {
                workspace_path: 'reports/q3.md',
                content: 'x',
            });
            expect(both.isError && both.content.includes('只能给一个'), 'workspace_path and content are exclusive');
            const appendPath = await call(createSendFileTool({ state: createReplyMediaState(), workspace: state }), {
                workspace_path: 'reports/q3.md',
                append: true,
            });
            expect(appendPath.isError && appendPath.content.includes('append'), 'workspace_path cannot append');
        },
    },
    {
        name: 'send_widget takes html or an A2UI surface from the workspace',
        body: async () => {
            await clearWorkspace();
            const state = stateOf();
            const limits = { allowHtml: true, maxHtmlBytes: 32768, maxGzipBytes: 4096 };
            await write('widgets/card.html', '<div class="card">你好</div>');
            await write('widgets/card.json', JSON.stringify({ components: [{ id: 'root', component: 'Card', child: 't' }, { id: 't', component: 'Text', text: '你好' }] }));
            const htmlTool = createSendWidgetTool({ state: createReplyMediaState(), limits, workspace: state });
            const htmlResult = await call(htmlTool, { mode: 'html', workspace_path: 'widgets/card.html' });
            expect(!htmlResult.isError, `html from the workspace is accepted (${htmlResult.content})`);
            expect(htmlResult.widgets?.[0]?.html.includes('你好'), 'the widget carries the workspace html');

            const a2uiTool = createSendWidgetTool({ state: createReplyMediaState(), limits, workspace: state });
            const a2uiResult = await call(a2uiTool, { mode: 'a2ui', workspace_path: 'widgets/card.json' });
            expect(!a2uiResult.isError, `a2ui from the workspace is accepted (${a2uiResult.content})`);
            expect(a2uiResult.widgets?.[0]?.mode === 'a2ui', 'the widget stays in a2ui mode');

            const both = await call(createSendWidgetTool({ state: createReplyMediaState(), limits, workspace: state }), {
                mode: 'html',
                workspace_path: 'widgets/card.html',
                html: '<div>x</div>',
            });
            expect(both.isError && both.content.includes('只能给一个'), 'workspace_path and html are exclusive');
        },
    },
    {
        name: 'the preview tool renders the draft and reports the widget budget',
        body: async () => {
            await clearWorkspace();
            const state = stateOf();
            await write('widgets/card.html', '<div class="card">你好</div>');
            await write('notes/plain.md', '# 不是 HTML');
            await write('widgets/broken.json', '{ not json');
            const limits = { allowHtml: true, maxHtmlBytes: 32768, maxGzipBytes: 4096 };
            const tool = createWorkspacePreviewTool({
                state,
                limits,
                dependencies: { renderPng: async () => ({ png: PNG, width: 600, height: 320 }) },
            });
            const rendered = await call(tool, { path: 'widgets/card.html' });
            expect(!rendered.isError, `the preview renders (${rendered.content})`);
            expect(rendered.modelImages?.length === 1 && rendered.modelImages[0]?.mimeType === 'image/png', 'the PNG rides the tool result');
            expect(rendered.content.includes('600×320'), 'the rendered size is reported');
            expect(rendered.content.includes('widget 预检：通过'), 'the precheck result is reported');
            expect(rendered.content.includes('zlib9'), 'the size budget is reported');

            const text = await call(tool, { path: 'notes/plain.md' });
            expect(text.isError && text.content.includes('只支持 .html'), 'a non-renderable type is refused');
            const broken = await call(tool, { path: 'widgets/broken.json' });
            expect(broken.isError && broken.content.includes('JSON'), 'invalid A2UI json is refused');
            const noRenderer = createWorkspacePreviewTool({
                state,
                limits,
                dependencies: { renderPng: async () => null },
            });
            const failed = await call(noRenderer, { path: 'widgets/card.html' });
            expect(failed.isError && failed.content.includes('渲染不可用'), 'a failed render is an actionable error');

            // A2UI drafts must be judged in a2ui mode: with HTML mode off (the
            // default) the precheck used to demand mode="a2ui" of an a2ui draft.
            await write(
                'widgets/card.json',
                JSON.stringify({
                    components: [
                        { id: 'root', component: 'Card', child: 't' },
                        { id: 't', component: 'Text', text: '你好' },
                    ],
                })
            );
            const htmlOff = { allowHtml: false, maxHtmlBytes: 32768, maxGzipBytes: 4096 };
            const a2uiTool = createWorkspacePreviewTool({
                state,
                limits: htmlOff,
                dependencies: { renderPng: async () => ({ png: PNG, width: 600, height: 320 }) },
            });
            const a2ui = await call(a2uiTool, { path: 'widgets/card.json' });
            expect(!a2ui.isError, `an A2UI draft previews with HTML mode off (${a2ui.content})`);
            expect(a2ui.content.includes('widget 预检：通过'), 'the A2UI precheck does not demand HTML mode');
            const htmlDraft = await call(a2uiTool, { path: 'widgets/card.html' });
            expect(
                htmlDraft.content.includes('widget 预检：不通过') && htmlDraft.content.includes('mode="a2ui"'),
                `an HTML draft is still reported as failing the precheck (${htmlDraft.content})`
            );
        },
    },
    {
        name: 'quota errors name the cap that was hit, including the global one',
        body: async () => {
            await clearWorkspace();
            const conversationQuota = { ...QUOTA, maxConversationBytes: 20, maxFiles: 10 };
            const first = await writeWorkspaceFile({
                chatId: CHAT,
                conversationRootId: ROOT,
                path: 'a.txt',
                content: 'x'.repeat(12),
                append: false,
                overwrite: false,
                quota: conversationQuota,
            });
            expect(first.ok, 'the first file fits the conversation');
            const second = await writeWorkspaceFile({
                chatId: CHAT,
                conversationRootId: ROOT,
                path: 'b.txt',
                content: 'y'.repeat(12),
                append: false,
                overwrite: false,
                quota: conversationQuota,
            });
            expect(!second.ok && second.error.includes('本会话已用'), 'the conversation byte cap is named');

            const globalQuota = { ...QUOTA, maxGlobalBytes: 10 };
            const global = await writeWorkspaceFile({
                chatId: CHAT,
                conversationRootId: ROOT,
                path: 'c.txt',
                content: 'z'.repeat(20),
                append: false,
                overwrite: false,
                quota: globalQuota,
            });
            expect(!global.ok && global.error.includes('所有会话合计'), 'the global cap is named when it is the one hit');
        },
    },
    {
        name: 'a read caps one long line and the characters of the whole call',
        body: async () => {
            await clearWorkspace();
            const bigQuota = { ...QUOTA, maxFileBytes: 200_000, maxConversationBytes: 400_000 };
            const writeBig = (path: string, content: string) =>
                writeWorkspaceFile({
                    chatId: CHAT,
                    conversationRootId: ROOT,
                    path,
                    content,
                    append: false,
                    overwrite: true,
                    quota: bigQuota,
                });
            await writeBig('notes/long.md', 'x'.repeat(2500));
            const tool = createWorkspaceReadTool({ state: stateOf() });
            const long = await call(tool, { path: 'notes/long.md' });
            expect(!long.isError && long.content.includes('本行过长已截断'), 'an over-long line is cut and labelled');

            const lines = Array.from({ length: 20 }, (_, index) => `${index + 1} ${'y'.repeat(1500)}`);
            const written = await writeBig('notes/many.md', lines.join('\n'));
            expect(written.ok, 'the big file fits its own quota');
            const capped = await call(tool, { path: 'notes/many.md' });
            expect(!capped.isError && capped.content.includes('共 20 行'), 'the header still states the total');
            expect(!capped.content.includes('20| 20 '), 'the call stops before the last line');
            expect(capped.content.includes('用 offset='), 'the rest is paged with offset');
        },
    },
    {
        name: 'delivery tools refuse a missing workspace file or a disabled workspace',
        body: async () => {
            await clearWorkspace();
            const state = stateOf();
            const missingFile = await call(createSendFileTool({ state: createReplyMediaState(), workspace: state }), {
                workspace_path: 'notes/nope.md',
            });
            expect(missingFile.isError && missingFile.content.includes('工作区里没有'), 'a missing file is an actionable error');

            const inlineOnly = createSendFileTool({ state: createReplyMediaState(), workspace: null });
            const disabled = await call(inlineOnly, { workspace_path: 'notes/a.md' });
            expect(disabled.isError && disabled.content.includes('工作区工具'), 'a disabled workspace refuses workspace_path');

            const widgetTool = createSendWidgetTool({
                state: createReplyMediaState(),
                limits: { allowHtml: true, maxHtmlBytes: 32768, maxGzipBytes: 4096 },
                workspace: state,
            });
            const missingWidget = await call(widgetTool, { mode: 'a2ui', workspace_path: 'notes/nope.json' });
            expect(missingWidget.isError && missingWidget.content.includes('工作区里没有'), 'send_widget names a missing file too');

            // A workspace file is complete content: appending to it contradicts
            // its source, so the draft is flagged and the inline path refuses.
            await write('reports/q4.md', '# Q4');
            const media = createReplyMediaState();
            const prepared = await call(createSendFileTool({ state: media, workspace: state }), {
                workspace_path: 'reports/q4.md',
            });
            expect(!prepared.isError, `the workspace file is prepared (${prepared.content})`);
            const append = await call(createSendFileTool({ state: media, workspace: state }), {
                file_name: 'q4.md',
                content: 'tail',
                append: true,
            });
            expect(append.isError && append.content.includes('不能再追加'), 'a workspace-sourced draft cannot be appended to');

            const straySelector = await call(createSendFileTool({ state: createReplyMediaState(), workspace: state }), {
                file_name: 'plain.txt',
                content: 'inline',
                workspace: 'w2',
            });
            expect(
                straySelector.isError && straySelector.content.includes('workspace_path'),
                'a workspace selector without workspace_path is refused, not ignored'
            );
            const strayWidgetSelector = await call(widgetTool, {
                mode: 'html',
                html: '<div>x</div>',
                workspace: 'w2',
            });
            expect(
                strayWidgetSelector.isError && strayWidgetSelector.content.includes('workspace_path'),
                'send_widget refuses a workspace selector without workspace_path too'
            );
        },
    },
    {
        name: 'the manifest caps its file list and its characters',
        body: async () => {
            await clearWorkspace();
            const manyQuota = { ...QUOTA, maxFiles: 100 };
            for (let index = 0; index < 25; index += 1) {
                await writeWorkspaceFile({
                    chatId: CHAT,
                    conversationRootId: ROOT,
                    path: `f${String(index).padStart(2, '0')}.txt`,
                    content: 'x',
                    append: false,
                    overwrite: false,
                    quota: manyQuota,
                });
            }
            const many = await buildWorkspaceManifest({
                state: stateOf([ROOT]),
                conversationRootIds: [ROOT],
                rootNumbers: new Map(),
                fileTools: true,
                widgetTools: true,
            });
            const fileLines = (many ?? '').split('\n').filter((line) => /^ {2}- f\d\d\.txt/.test(line));
            expect(fileLines.length === 20, `only 20 files are listed (got ${fileLines.length})`);
            expect(many?.includes('还有 5 个文件没列出'), 'the rest is counted');

            // Many spliced conversations: the budget cuts them and says how many
            await clearWorkspace();
            const roots = [ROOT];
            for (let index = 0; index < 30; index += 1) {
                const rootId = 10_000 + index;
                roots.push(rootId);
                await writeWorkspaceFile({
                    chatId: CHAT,
                    conversationRootId: rootId,
                    path: 'draft.md',
                    content: 'x',
                    append: false,
                    overwrite: false,
                    quota: QUOTA,
                });
            }
            const wide = await buildWorkspaceManifest({
                state: stateOf(roots),
                conversationRootIds: roots,
                rootNumbers: new Map(roots.slice(1).map((rootId, index) => [rootId, index + 2])),
                fileTools: true,
                widgetTools: true,
            });
            expect(wide !== null && (wide?.length ?? 0) <= 1200, `the section stays within its budget (${wide?.length})`);
            expect(
                /还有 \d+ 个拼接会话没列出（w\d+–w\d+）；用 workspace_list\(workspace="w\d+"\) 逐个查看/.test(wide ?? ''),
                `the conversations that did not fit are counted with their tokens (${wide})`
            );
        },
    },
    {
        name: 'the hourly cleanup deletes only files unused for a week',
        body: async () => {
            await clearWorkspace();
            const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
            await WorkspaceFile.create({
                chatId: CHAT,
                conversationRootId: ROOT,
                path: 'old.md',
                content: Buffer.from('old'),
                sizeBytes: 3,
                summary: 'old',
                mimeType: 'text/markdown',
                createdAt: old,
                updatedAt: old,
                lastUsedAt: old,
            });
            await write('fresh.md', 'fresh');
            const { lines } = await captureConsole(() => clearExpiredData());
            expect((await readWorkspaceFile(CHAT, ROOT, 'old.md')) === null, 'the stale file is deleted');
            expect((await readWorkspaceFile(CHAT, ROOT, 'fresh.md')) !== null, 'the fresh file survives');
            expect(lines.some((line) => line.includes('1 workspace files')), `the cleanup summary counts it (${lines.join(' | ')})`);
        },
    },
    {
        name: 'the workspace time format is stable and timezone-aware',
        body: async () => {
            const date = new Date('2026-11-11T04:04:00.000Z');
            const formatted = formatWorkspaceTime(date);
            expect(/^\d{2}-\d{2} \d{2}:\d{2}$/.test(formatted), `the format is M-D HH:mm (got ${formatted})`);
            const snapshot = await loadWorkspaceSnapshots(CHAT, [ROOT]);
            expect(snapshot.size === 1, 'a snapshot is returned for the requested root');
        },
    },
];

const results: CaseResult[] = [];
for (const { name, body } of cases) {
    results.push(await runCase(name, body));
}
await reportResults(results);
