/**
 * Offline cases for the model workspace — the per-conversation draft file
 * system (no containers, no network, no Telegram).
 *
 * Run: npx tsx scripts/offline/workspace.mts
 *
 * Covers the path rules, read/write/find/copy/edit/delete and their quotas, the
 * manifest builder and its workspace tokens, the tool handlers, `send_file` /
 * `send_widget` reading from the workspace, the preview tool with an injected
 * renderer, the multi-file calls (files/paths/edits), and the 7-day LRU cleanup.
 */
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';
import type { ToolHandler } from '../../src/ai/tools/tool-types.js';

await setupOfflineDb();
const { formatBytes } = await import('../../src/shared/file-name.js');
const { EDIT_BATCH_MAX, PREVIEW_BATCH_MAX, READ_BATCH_MAX, WRITE_BATCH_MAX } = await import(
    '../../src/reply/tools/workspace-tool-args.js'
);
const { WorkspaceFile } = await import('../../src/db/workspaceFileDTO.js');
const {
    copyWorkspaceFile,
    deleteWorkspaceFile,
    editWorkspaceFile,
    findWorkspaceFiles,
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
const { createWorkspaceTool } = await import('../../src/reply/tools/workspace-tool.js');
const { createSendFileTool } = await import('../../src/reply/tools/send-file-tool.js');
const { createSendWidgetTool } = await import('../../src/reply/tools/send-widget-tool.js');
const { createReplyMediaState } = await import('../../src/reply/tools/reply-media-state.js');
const { measureWidgetHtml } = await import('../../src/ai/widget/widget-size.js');
const { clearExpiredData } = await import('../../src/db/autoSave.js');
const { WORKSPACE_TOOL_NAME } = await import('../../src/reply/tools/tool-names.js');

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

/** Deterministic printable filler that deflate cannot shrink much (a hostile draft) */
const randomHtmlOf = (length: number): string => {
    const chars: string[] = [];
    let seed = 987654321;
    for (let index = 0; index < length; index += 1) {
        seed = (seed * 48271) % 2147483647;
        chars.push(String.fromCharCode(33 + (seed % 90)));
    }
    return chars.join('');
};

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

/** `inputSchema.properties` is unknown by contract; the schema cases read it field by field */
const recordOf = (value: unknown): Readonly<Record<string, unknown>> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    const record: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) record[key] = item;
    return record;
};

const propertiesOf = (tool: ToolHandler): Readonly<Record<string, unknown>> =>
    recordOf(recordOf(tool.definition.inputSchema)['properties']);

const clearWorkspace = async (): Promise<void> => {
    await WorkspaceFile.destroy({ where: {} });
};

const stateOf = (rootIds: readonly number[] = [ROOT, OTHER_ROOT]) =>
    createWorkspaceState({
        chatId: CHAT,
        conversationRootIds: rootIds,
        quota: QUOTA,
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

            const tool = createWorkspaceTool({ state: stateOf() });
            const page = await call(tool, { action: 'read', path: 'notes/plan.md', limit: 2 });
            expect(!page.isError, `the read tool succeeds (${page.content})`);
            expect(page.content.includes('共 5 行'), 'the header states the total line count');
            expect(page.content.includes('1| # 计划'), 'lines are numbered from 1');
            expect(page.content.includes('显示第 1–2 行'), 'the shown range is stated');
            expect(page.content.includes('还有 3 行，用 offset=3 继续'), 'the remainder is stated explicitly');

            const tail = await call(tool, { action: 'read', path: 'notes/plan.md', offset: 4, limit: 2 });
            expect(tail.content.includes('4| 第二段') && tail.content.includes('5| 第三段'), 'offset pages correctly');
            const beyond = await call(tool, { action: 'read', path: 'notes/plan.md', offset: 99 });
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
            const tool = createWorkspaceTool({ state: stateOf() });
            const all = await call(tool, { action: 'list' });
            expect(all.content.includes('共 3 个文件'), 'the whole workspace count is shown');
            expect(all.content.includes('widgets/a.html') && all.content.includes('notes/c.md'), 'all files are listed');
            const widgets = await call(tool, { action: 'list', prefix: 'widgets/' });
            expect(widgets.content.includes('widgets/a.html') && !widgets.content.includes('notes/c.md'), 'the prefix filters the list');
            const badPrefix = await call(tool, { action: 'list', prefix: 42 });
            expect(badPrefix.isError && badPrefix.content.includes('prefix'), 'a non-string prefix is an argument error');
            await clearWorkspace();
            const empty = await call(tool, { action: 'list' });
            expect(empty.content.includes('工作区是空的'), 'an empty workspace says so');
            const usage = await workspaceUsageOf(CHAT, ROOT);
            expect(usage.fileCount === 0 && usage.totalBytes === 0, 'usage of an empty workspace is zero');
        },
    },
    {
        name: 'html drafts report the widget budget on write, edit and list',
        body: async () => {
            await clearWorkspace();
            const limits = { maxHtmlBytes: 32768, maxGzipBytes: 4096 };
            const state = stateOf();
            const tool = createWorkspaceTool({ state, widgetLimits: limits });
            const plainTool = createWorkspaceTool({ state });

            const small = '<div class="card">你好</div>';
            const size = measureWidgetHtml(small);
            const written = await call(tool, { action: 'write', path: 'widgets/card.html', content: small });
            expect(
                written.content.includes(`原文 ${size.rawBytes} B / 32768 B`),
                `the write reports the raw size (got ${written.content})`
            );
            expect(
                written.content.includes(`zlib9 ${size.zlibBytes} B / 4096 B`),
                'the write reports the compressed size'
            );
            expect(written.content.includes('余 '), 'a draft under the limit shows the remaining room');

            const note = await call(tool, { action: 'write', path: 'notes/plan.md', content: '# 计划' });
            expect(!note.content.includes('widget 体积'), 'a non-HTML file gets no widget line');

            const plain = await call(plainTool, {
                action: 'write',
                path: 'widgets/plain.html',
                content: small,
            });
            expect(!plain.content.includes('widget 体积'), 'without widget tools the write stays plain');

            const edited = await call(tool, {
                action: 'edit',
                path: 'widgets/card.html',
                old_string: '你好',
                new_string: '再见',
            });
            const editedSize = measureWidgetHtml('<div class="card">再见</div>');
            expect(
                edited.content.includes(`zlib9 ${editedSize.zlibBytes} B`),
                `the edit reports the new compressed size (got ${edited.content})`
            );

            const listed = await call(tool, { action: 'list' });
            expect(listed.content.includes('HTML 草稿按 widget 计'), 'the list states the widget limits');
            expect(listed.content.includes('zlib9'), 'the list shows the compressed size of the draft');
            expect(listed.content.includes('widgets/plain.html'), 'the plain draft is listed too');
            const plainList = await call(plainTool, { action: 'list' });
            expect(!plainList.content.includes('zlib9'), 'without widget tools the list stays plain');

            // A draft over the compressed limit says how much has to go
            const bigQuota = {
                maxFileBytes: 64_000,
                maxConversationBytes: 500_000,
                maxFiles: 10,
                maxGlobalBytes: 2_000_000,
            };
            const bigState = createWorkspaceState({
                chatId: CHAT,
                conversationRootIds: [ROOT],
                quota: bigQuota,
            });
            const bigTool = createWorkspaceTool({ state: bigState, widgetLimits: limits });
            const bigContent = randomHtmlOf(6000);
            const bigSize = measureWidgetHtml(bigContent);
            expect(bigSize.zlibBytes > limits.maxGzipBytes, 'the fixture is over the zlib limit');
            const big = await call(bigTool, { action: 'write', path: 'widgets/big.html', content: bigContent });
            expect(
                big.content.includes(`超 ${bigSize.zlibBytes - limits.maxGzipBytes} B`),
                `the write names the gap to close (got ${big.content})`
            );
            expect(big.content.includes('发送会被拒'), 'an over-limit draft warns that sending is refused');

            // A draft over the raw cap cannot be a widget: the list says so and
            // does not read the file to measure it
            const huge = randomHtmlOf(40_000);
            const hugeWritten = await call(bigTool, { action: 'write', path: 'widgets/huge.html', content: huge });
            expect(!hugeWritten.isError, `a big draft still writes (${hugeWritten.content})`);
            const bigList = await call(createWorkspaceTool({ state: bigState, widgetLimits: limits }), { action: 'list' });
            expect(bigList.content.includes('已超 widget 原文上限 32768 B'), 'an over-cap draft is named as such');
            expect(bigList.content.includes('widgets/big.html'), 'the other draft is still listed');
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
                readOnly?.includes('用 workspace(action="read") 读取文件内容。') && !readOnly?.includes('send_file'),
                'without delivery tools the footer only names workspace(action="read")'
            );
            const sanitized = summarizeWorkspaceContent('第一行\r\n第二行');
            expect(sanitized === '第一行', 'a summary never carries a line break');
        },
    },
    {
        name: 'the tool flow writes, lists, reads, edits and deletes',
        body: async () => {
            await clearWorkspace();
            const state = createWorkspaceState({
                chatId: CHAT,
                conversationRootIds: [ROOT, OTHER_ROOT],
                quota: QUOTA,
            });
            ensureWorkspaceToken(state, OTHER_ROOT, '拼接的会话');
            const tool = createWorkspaceTool({ state });

            const first = await call(tool, { action: 'write', path: 'notes/a.md', content: '# A' });
            expect(!first.isError && first.content.includes('已写入'), 'write succeeds');
            const toOther = await call(tool, { action: 'write', path: 'notes/b.md', content: '# B', workspace: 'w2' });
            expect(!toOther.isError && toOther.content.includes('w2'), 'write can target the spliced conversation');
            const listed = await call(tool, { action: 'list', workspace: 'w2' });
            expect(listed.content.includes('notes/b.md'), 'the spliced workspace lists its own file');
            const read = await call(tool, { action: 'read', path: 'notes/a.md' });
            expect(read.content.includes('1| # A'), 'read returns numbered lines');
            const edited = await call(tool, { action: 'edit', path: 'notes/a.md', old_string: '# A', new_string: '# A 改' });
            expect(!edited.isError && edited.content.includes('替换 1 处'), 'edit succeeds');
            const appended = await call(tool, { action: 'write', path: 'notes/a.md', content: '\n追加', append: true });
            expect(
                !appended.isError && appended.content.includes('已追加到') && !appended.content.includes('已覆盖'),
                'append is reported as an append'
            );
            const overwritten = await call(tool, { action: 'write', path: 'notes/a.md', content: '# 重写', overwrite: true });
            expect(
                !overwritten.isError &&
                    overwritten.content.includes('已覆盖') &&
                    overwritten.content.includes('原 '),
                'overwrite names the replaced size'
            );

            // No per-reply call counters: a later write is not refused
            const extra = await call(tool, { action: 'write', path: 'notes/c.md', content: '# C' });
            expect(!extra.isError && extra.content.includes('已写入'), 'a later write is not refused by a count');
            const deleted = await call(tool, { action: 'delete', path: 'notes/a.md' });
            expect(!deleted.isError && deleted.content.includes('已删除'), 'delete succeeds');
            const missing = await call(tool, { action: 'read', path: 'notes/a.md' });
            expect(missing.isError && missing.content.includes('workspace(action="list")'), 'a missing file points at list');
        },
    },
    {
        name: 'find locates lines across files, by scope and case, with caps',
        body: async () => {
            await clearWorkspace();
            await write('widgets/card.html', '<div class="card">NEON</div>\n<div>霓虹</div>');
            await write('notes/plan.md', '第一行\nneon 参考\n最后一行');
            await write('notes/other.md', '无关内容');

            const base = {
                query: 'neon',
                path: null,
                prefix: '',
                caseSensitive: false,
                maxHits: 50,
                maxChars: 8000,
                maxLineChars: 200,
            };
            const all = await findWorkspaceFiles(CHAT, ROOT, base);
            expect(
                all.totalHits === 2 && all.scannedFiles === 3,
                `case-insensitive search scans every file (got ${JSON.stringify({ total: all.totalHits, scanned: all.scannedFiles })})`
            );
            expect(
                all.hits.some((hit) => hit.path === 'notes/plan.md' && hit.lineNumber === 2),
                `hits carry the path and the line number (got ${JSON.stringify(all.hits)})`
            );
            expect(
                all.hits.some((hit) => hit.path === 'widgets/card.html' && hit.lineNumber === 1),
                'the other file is found too'
            );

            const exact = await findWorkspaceFiles(CHAT, ROOT, { ...base, query: 'NEON', caseSensitive: true });
            expect(
                exact.totalHits === 1 && exact.hits[0]?.path === 'widgets/card.html',
                `case_sensitive filters the matches (got ${JSON.stringify(exact.hits)})`
            );
            const oneFile = await findWorkspaceFiles(CHAT, ROOT, { ...base, path: 'notes/plan.md' });
            expect(
                oneFile.totalHits === 1 && oneFile.scannedFiles === 1,
                `path limits the scan to one file (got ${JSON.stringify(oneFile)})`
            );
            const oneDir = await findWorkspaceFiles(CHAT, ROOT, { ...base, prefix: 'widgets/' });
            expect(
                oneDir.totalHits === 1 && oneDir.scannedFiles === 1,
                `prefix limits the scan to one directory (got ${JSON.stringify(oneDir)})`
            );
            const none = await findWorkspaceFiles(CHAT, ROOT, { ...base, query: '不存在的词' });
            expect(none.totalHits === 0 && none.hits.length === 0 && !none.truncated, 'a miss is a clean empty result');

            // Caps: every match is counted, only the first few are shown
            await write('notes/many.md', Array.from({ length: 60 }, (_, index) => `hit ${index}`).join('\n'));
            const capped = await findWorkspaceFiles(CHAT, ROOT, { ...base, query: 'hit', maxHits: 5 });
            expect(
                capped.totalHits === 60 && capped.hits.length === 5 && capped.truncated,
                `caps count everything but show a few (got ${JSON.stringify({ total: capped.totalHits, shown: capped.hits.length })})`
            );
            const longLine = await findWorkspaceFiles(CHAT, ROOT, {
                ...base,
                query: 'END',
                maxLineChars: 10,
            });
            await write('notes/long.md', `${'x'.repeat(30)}END`);
            const cappedLine = await findWorkspaceFiles(CHAT, ROOT, {
                ...base,
                query: 'END',
                maxLineChars: 10,
            });
            expect(longLine.totalHits === 0, 'the long line did not exist yet');
            expect(
                cappedLine.totalHits === 1 && cappedLine.hits[0]?.line === `${'x'.repeat(10)}…`,
                `one long line is capped for display (got ${JSON.stringify(cappedLine.hits[0])})`
            );

            const state = createWorkspaceState({ chatId: CHAT, conversationRootIds: [ROOT], quota: QUOTA });
            const tool = createWorkspaceTool({ state });
            const toolResult = await call(tool, { action: 'find', query: 'neon' });
            expect(
                !toolResult.isError && toolResult.content.includes('找到 2 处') && toolResult.content.includes('notes/plan.md:2| neon 参考'),
                `the tool renders path:line hits (got ${toolResult.content})`
            );
            const scoped = await call(tool, { action: 'find', query: 'neon', path: 'notes/plan.md', prefix: 'notes/' });
            expect(scoped.isError && scoped.content.includes('只能给一个'), 'path and prefix are exclusive');
            const empty = await call(tool, { action: 'find', query: '  ' });
            expect(empty.isError && empty.content.includes('query 不能为空'), 'an empty query is rejected');
            const miss = await call(tool, { action: 'find', query: 'zzz' });
            expect(!miss.isError && miss.content.includes('没有找到'), 'a miss tells the model what it scanned');

            // No per-reply call counters: a repeated find is not refused
            const again = await call(tool, { action: 'find', query: 'neon' });
            expect(!again.isError && again.content.includes('找到 2 处'), 'a repeated find is not refused');
        },
    },
    {
        name: 'copy duplicates a file without overwriting the target',
        body: async () => {
            await clearWorkspace();
            const state = createWorkspaceState({ chatId: CHAT, conversationRootIds: [ROOT], quota: QUOTA });
            const tool = createWorkspaceTool({ state });
            await call(tool, { action: 'write', path: 'widgets/game.html', content: '<div>v1</div>' });

            const copied = await call(tool, { action: 'copy', path: 'widgets/game.html', new_path: 'widgets/game-v1.html' });
            expect(!copied.isError && copied.content.includes('已复制'), `copy succeeds (got ${copied.content})`);
            const readBack = await readWorkspaceFile(CHAT, ROOT, 'widgets/game-v1.html');
            expect(readBack?.content === '<div>v1</div>', 'the copy carries the same bytes');
            const listed = await listWorkspaceFiles(CHAT, ROOT);
            expect(
                listed.files.length === 2 && listed.usage.totalBytes === 26,
                `both files count toward the quota (got ${JSON.stringify(listed.usage)})`
            );
            const copiedInfo = listed.files.find((file) => file.path === 'widgets/game-v1.html');
            expect(
                copiedInfo?.summary === '<div>v1</div>' && copiedInfo?.mimeType === 'text/html',
                `the copy keeps the summary and takes the target MIME type (got ${JSON.stringify(copiedInfo)})`
            );
            const serviceCopy = await copyWorkspaceFile(CHAT, ROOT, {
                from: 'widgets/game.html',
                to: 'widgets/game-svc.html',
                quota: QUOTA,
            });
            expect(
                serviceCopy.ok && serviceCopy.sizeBytes === 13 && serviceCopy.fileCount === 3,
                `the service reports the copy's size and the new usage (got ${JSON.stringify(serviceCopy)})`
            );

            const again = await call(tool, { action: 'copy', path: 'widgets/game.html', new_path: 'widgets/game-v1.html' });
            expect(
                again.isError && again.content.includes('已经有') && again.content.includes('new_path'),
                'a copy never overwrites the target'
            );
            const missing = await call(tool, { action: 'copy', path: 'widgets/nope.html', new_path: 'widgets/x.html' });
            expect(missing.isError && missing.content.includes('workspace(action="list")'), 'a missing source points at list');
            const same = await call(tool, { action: 'copy', path: 'widgets/game.html', new_path: 'widgets/game.html' });
            expect(same.isError && same.content.includes('相同'), 'source and target must differ');

            // The file-count quota stops the next copy, and the source is untouched
            await call(tool, { action: 'copy', path: 'widgets/game.html', new_path: 'widgets/game-v2.html' });
            await call(tool, { action: 'copy', path: 'widgets/game.html', new_path: 'widgets/game-v3.html' });
            const overQuota = await call(tool, { action: 'copy', path: 'widgets/game.html', new_path: 'widgets/game-v4.html' });
            expect(overQuota.isError && overQuota.content.includes('配额'), 'the file-count quota applies to copies');
            const source = await readWorkspaceFile(CHAT, ROOT, 'widgets/game.html');
            expect(source?.content === '<div>v1</div>', 'failed copies leave the source alone');

            // No per-reply call counters: several copies in one reply are fine
            await clearWorkspace();
            const repeatTool = createWorkspaceTool({
                state: createWorkspaceState({ chatId: CHAT, conversationRootIds: [ROOT], quota: QUOTA }),
            });
            await write('a.txt', 'hello');
            const firstCopy = await call(repeatTool, { action: 'copy', path: 'a.txt', new_path: 'b.txt' });
            const secondCopy = await call(repeatTool, { action: 'copy', path: 'a.txt', new_path: 'c.txt' });
            expect(
                !firstCopy.isError && !secondCopy.isError,
                `copies are not refused by a per-reply count (${firstCopy.content} / ${secondCopy.content})`
            );
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
            const tool = createWorkspaceTool({
                state,
                workspacePreview: true,
                previewLimits: limits,
                previewDependencies: { renderPng: async () => ({ png: PNG, width: 600, height: 320 }) },
            });
            const rendered = await call(tool, { action: 'preview', path: 'widgets/card.html' });
            expect(!rendered.isError, `the preview renders (${rendered.content})`);
            expect(rendered.modelImages?.length === 1 && rendered.modelImages[0]?.mimeType === 'image/png', 'the PNG rides the tool result');
            expect(rendered.content.includes('600×320'), 'the rendered size is reported');
            expect(rendered.content.includes('widget 预检：通过'), 'the precheck result is reported');
            expect(rendered.content.includes('zlib9'), 'the size budget is reported');

            const text = await call(tool, { action: 'preview', path: 'notes/plain.md' });
            expect(text.isError && text.content.includes('只支持 .html'), 'a non-renderable type is refused');
            const broken = await call(tool, { action: 'preview', path: 'widgets/broken.json' });
            expect(broken.isError && broken.content.includes('JSON'), 'invalid A2UI json is refused');
            const noRenderer = createWorkspaceTool({
                state,
                workspacePreview: true,
                previewLimits: limits,
                previewDependencies: { renderPng: async () => null },
            });
            const failed = await call(noRenderer, { action: 'preview', path: 'widgets/card.html' });
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
            const a2uiTool = createWorkspaceTool({
                state,
                workspacePreview: true,
                previewLimits: htmlOff,
                previewDependencies: { renderPng: async () => ({ png: PNG, width: 600, height: 320 }) },
            });
            const a2ui = await call(a2uiTool, { action: 'preview', path: 'widgets/card.json' });
            expect(!a2ui.isError, `an A2UI draft previews with HTML mode off (${a2ui.content})`);
            expect(a2ui.content.includes('widget 预检：通过'), 'the A2UI precheck does not demand HTML mode');
            const htmlDraft = await call(a2uiTool, { action: 'preview', path: 'widgets/card.html' });
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
            const tool = createWorkspaceTool({ state: stateOf() });
            const long = await call(tool, { action: 'read', path: 'notes/long.md' });
            expect(!long.isError && long.content.includes('本行过长已截断'), 'an over-long line is cut and labelled');

            const lines = Array.from({ length: 20 }, (_, index) => `${index + 1} ${'y'.repeat(1500)}`);
            const written = await writeBig('notes/many.md', lines.join('\n'));
            expect(written.ok, 'the big file fits its own quota');
            const capped = await call(tool, { action: 'read', path: 'notes/many.md' });
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
                /还有 \d+ 个拼接会话没列出（w\d+–w\d+）；用 workspace\(action="list", workspace="w\d+"\) 逐个查看/.test(wide ?? ''),
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
    {
        name: 'a write batch creates several files, reports each and gives one usage line per workspace',
        body: async () => {
            await clearWorkspace();
            const state = createWorkspaceState({ chatId: CHAT, conversationRootIds: [ROOT, OTHER_ROOT], quota: QUOTA });
            ensureWorkspaceToken(state, OTHER_ROOT, '拼接的会话');
            const tool = createWorkspaceTool({ state });

            const result = await call(tool, {
                action: 'write',
                files: [
                    { path: 'notes/plan.md', content: '# 计划' },
                    { path: 'src/main.ts', content: 'export const a = 1;' },
                    { path: 'notes/other.md', content: '# 别的', workspace: 'w2' },
                ],
            });
            expect(!result.isError, `the batch succeeds (${result.content})`);
            expect(result.content.includes('已写入 3 个文件：'), `the header counts the files (${result.content})`);
            expect(result.content.includes('- 《notes/plan.md》（'), 'each file gets its own line');
            expect(result.content.includes('- 《src/main.ts》（'), 'the second file is listed too');
            expect(result.content.includes('w2 notes/other.md'), 'a spliced workspace keeps its token in the line');
            expect(
                (await readWorkspaceFile(CHAT, ROOT, 'notes/plan.md'))?.content === '# 计划' &&
                    (await readWorkspaceFile(CHAT, ROOT, 'src/main.ts'))?.content === 'export const a = 1;' &&
                    (await readWorkspaceFile(CHAT, OTHER_ROOT, 'notes/other.md'))?.content === '# 别的',
                'every file landed in the workspace its item named'
            );
            expect(
                result.content.includes('工作区（本会话 w1）：') && result.content.includes('工作区（拼接的会话 w2）：'),
                `usage is reported once per workspace (${result.content})`
            );
            expect(result.content.includes('2 个文件，已用'), 'the usage of the current workspace counts both files');
            expect(result.content.includes(`（${formatBytes(Buffer.byteLength('# 计划'))}，新建）`), 'the line carries size and outcome');
            expect(result.trace?.argument?.includes('3 个文件'), `the trace counts the request (${result.trace?.argument})`);
        },
    },
    {
        name: 'a write batch keeps what succeeded and names every file that failed',
        body: async () => {
            await clearWorkspace();
            const state = createWorkspaceState({ chatId: CHAT, conversationRootIds: [ROOT], quota: QUOTA });
            const tool = createWorkspaceTool({ state });
            await write('notes/taken.md', 'old');

            const result = await call(tool, {
                action: 'write',
                files: [
                    { path: 'notes/ok.md', content: 'fine' },
                    { path: '../escape.md', content: 'nope' },
                    { path: 'notes/taken.md', content: 'blind' },
                    { path: 'notes/over.md', content: 'x'.repeat(QUOTA.maxFileBytes + 1) },
                ],
            });
            expect(!result.isError, `a partly failed batch is not a call error (${result.content})`);
            expect(result.content.includes('已写入 1 个文件：'), 'the successful file is counted');
            expect(result.content.includes('有 3 个没写成：'), 'the failures are counted');
            expect(result.content.includes('../escape.md'), 'an illegal path is named');
            expect(
                result.content.includes('notes/taken.md') && result.content.includes('overwrite=true'),
                'an existing file explains the flag'
            );
            expect(
                result.content.includes('notes/over.md') && result.content.includes('单个文件上限'),
                'an oversize file names the cap'
            );
            expect((await readWorkspaceFile(CHAT, ROOT, 'notes/ok.md'))?.content === 'fine', 'the good file is really stored');
            expect((await readWorkspaceFile(CHAT, ROOT, 'notes/taken.md'))?.content === 'old', 'the refused file is untouched');
        },
    },
    {
        name: 'a write batch applies its items in order, so the last write of a file wins',
        body: async () => {
            await clearWorkspace();
            const tool = createWorkspaceTool({
                state: createWorkspaceState({ chatId: CHAT, conversationRootIds: [ROOT], quota: QUOTA }),
            });
            const result = await call(tool, {
                action: 'write',
                files: [
                    { path: 'notes/draft.md', content: '第一版' },
                    { path: 'notes/draft.md', content: '第二版', overwrite: true },
                    { path: 'logs/a.txt', content: 'one' },
                    { path: 'logs/a.txt', content: ' two', append: true },
                ],
            });
            expect(!result.isError, `the batch succeeds (${result.content})`);
            expect(result.content.includes('已写入 4 个文件：'), 'all four items succeeded');
            expect(
                result.content.includes(`（${formatBytes(Buffer.byteLength('第二版'))}，覆盖）`),
                `the overwrite is named as such (${result.content})`
            );
            expect(result.content.includes(`（${formatBytes(7)}，追加）`), 'the append reports the whole file size');
            expect((await readWorkspaceFile(CHAT, ROOT, 'notes/draft.md'))?.content === '第二版', 'the last item is the final state');
            expect((await readWorkspaceFile(CHAT, ROOT, 'logs/a.txt'))?.content === 'one two', 'append composes with the create');
        },
    },
    {
        name: 'a write batch rejects a mixed form, an empty list, too many files and too much text',
        body: async () => {
            await clearWorkspace();
            const tool = createWorkspaceTool({ state: stateOf() });
            const mixed = await call(tool, { action: 'write', path: 'a.md', content: 'x', files: [{ path: 'b.md', content: 'y' }] });
            expect(
                mixed.isError && mixed.content.includes('参数有误') && mixed.content.includes('files 和 path 只能给一个'),
                `the two forms are exclusive (${mixed.content})`
            );
            const empty = await call(tool, { action: 'write', files: [] });
            expect(empty.isError && empty.content.includes('files 是空的'), 'an empty files array is an argument error');
            const tooMany = await call(tool, {
                action: 'write',
                files: Array.from({ length: WRITE_BATCH_MAX + 1 }, (_, index) => ({ path: `f${index}.md`, content: 'x' })),
            });
            expect(tooMany.isError && tooMany.content.includes(`最多 ${WRITE_BATCH_MAX} 项`), 'the item cap is enforced');
            const tooLong = await call(tool, { action: 'write', files: [{ path: 'big.md', content: 'x'.repeat(32_001) }] });
            expect(tooLong.isError && tooLong.content.includes('合计最多 32000 字符'), 'the whole text budget is enforced');
            const topLevelFlag = await call(tool, { action: 'write', files: [{ path: 'a.md', content: 'x' }], append: true });
            expect(
                topLevelFlag.isError && topLevelFlag.content.includes('写在每一项里'),
                'a batch field at the top level is refused, not silently ignored'
            );
            expect((await readWorkspaceFile(CHAT, ROOT, 'a.md')) === null, 'a parameter error wrote nothing');
        },
    },
    {
        name: 'a read batch returns its files in order with one shared offset, limit and workspace',
        body: async () => {
            await clearWorkspace();
            await write('notes/a.md', 'a1\na2\na3');
            await write('notes/b.md', 'b1\nb2');
            const state = createWorkspaceState({ chatId: CHAT, conversationRootIds: [ROOT, OTHER_ROOT], quota: QUOTA });
            ensureWorkspaceToken(state, OTHER_ROOT, '拼接的会话');
            await writeWorkspaceFile({
                chatId: CHAT,
                conversationRootId: OTHER_ROOT,
                path: 'other.md',
                content: 'o1\no2',
                append: false,
                overwrite: false,
                quota: QUOTA,
            });
            const tool = createWorkspaceTool({ state });

            const result = await call(tool, { action: 'read', paths: ['notes/a.md', 'notes/b.md'], offset: 2, limit: 1 });
            expect(!result.isError, `the batch reads (${result.content})`);
            expect(result.content.includes('已读取 2 个文件：'), 'the header counts the files');
            expect(
                result.content.indexOf('notes/a.md') < result.content.indexOf('notes/b.md'),
                'the paragraphs keep the request order'
            );
            expect(
                result.content.includes('2| a2') && result.content.includes('显示第 2–2 行'),
                'the shared offset and limit apply to every file'
            );
            expect(!result.content.includes('1| a1') && !result.content.includes('1| b1'), 'lines before the offset are not shown');
            expect(result.content.includes('2| b2'), 'the second file is read at the same offset');

            const spliced = await call(tool, { action: 'read', paths: ['other.md'], workspace: 'w2' });
            expect(
                !spliced.isError && spliced.content.includes('拼接的会话 w2'),
                `the shared workspace token is used (${spliced.content})`
            );
            expect(spliced.content.includes('1| o1'), 'the spliced workspace file is read');
        },
    },
    {
        name: 'a read batch shares one character budget and marks the files it did not reach',
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
            // The first file alone almost fills the 24000-character budget
            const first = Array.from({ length: 30 }, (_, index) => `${'x'.repeat(999)}${index}`).join('\n');
            const second = Array.from({ length: 5 }, () => `MARKER${'y'.repeat(993)}`).join('\n');
            expect((await writeBig('notes/long1.md', first)).ok, 'the first big file fits');
            expect((await writeBig('notes/long2.md', second)).ok, 'the second big file fits');

            const tool = createWorkspaceTool({ state: stateOf() });
            const result = await call(tool, { action: 'read', paths: ['notes/long1.md', 'notes/long2.md'] });
            expect(!result.isError, `the batch still succeeds (${result.content.slice(0, 200)})`);
            expect(result.content.includes('已读取 1 个文件：'), 'only the first file fits the budget');
            expect(result.content.includes('还有 '), 'the first file is cut and states the rest');
            expect(
                result.content.includes('未读：本次读取的 24000 字符预算已用完（可用 offset 继续）'),
                'the second file is marked unread'
            );
            expect(!result.content.includes('MARKER'), 'the unread file body is absent');
            expect(result.content.length < 25_000, `the whole call stays near the budget (${result.content.length})`);
        },
    },
    {
        name: 'a read batch reports missing files and keeps reading the rest',
        body: async () => {
            await clearWorkspace();
            await write('notes/a.md', 'one\ntwo');
            const tool = createWorkspaceTool({ state: stateOf() });

            const result = await call(tool, { action: 'read', paths: ['notes/a.md', 'notes/nope.md', 'one/two/three/four.md'] });
            expect(!result.isError, `one readable file keeps the call a success (${result.content})`);
            expect(result.content.includes('已读取 1 个文件：'), 'the readable file is read');
            expect(result.content.includes('有 2 个没读成：'), 'both misses are counted');
            expect(
                result.content.includes('notes/nope.md') && result.content.includes('工作区里没有'),
                'the missing file is named'
            );
            expect(
                result.content.includes('one/two/three/four.md') && result.content.includes('目录最多 3 层'),
                'the illegal path is named'
            );

            const none = await call(tool, { action: 'read', paths: ['notes/missing1.md', 'notes/missing2.md'] });
            expect(none.isError && none.content.includes('这 2 个文件都没读成：'), 'a fully failed batch is an error');

            const badOffset = await call(tool, { action: 'read', paths: ['notes/a.md'], offset: 9 });
            expect(
                badOffset.isError && badOffset.content.includes('offset=9 超过文件行数'),
                'an out-of-range offset is a per-item failure'
            );
        },
    },
    {
        name: 'a read batch rejects a mixed form, an empty list, too many paths and a bad item',
        body: async () => {
            const tool = createWorkspaceTool({ state: stateOf() });
            const mixed = await call(tool, { action: 'read', path: 'a.md', paths: ['b.md'] });
            expect(mixed.isError && mixed.content.includes('paths 和 path 只能给一个'), 'the two forms are exclusive');
            const empty = await call(tool, { action: 'read', paths: [] });
            expect(empty.isError && empty.content.includes('paths 是空的'), 'an empty paths array is an argument error');
            const tooMany = await call(tool, {
                action: 'read',
                paths: Array.from({ length: READ_BATCH_MAX + 1 }, (_, index) => `f${index}.md`),
            });
            expect(tooMany.isError && tooMany.content.includes(`最多 ${READ_BATCH_MAX} 项`), 'the path cap is enforced');
            const notString = await call(tool, { action: 'read', paths: ['a.md', 42] });
            expect(
                notString.isError && notString.content.includes('第 2 项要传字符串'),
                'a non-string path is an argument error'
            );
            const badOffset = await call(tool, { action: 'read', paths: ['a.md'], offset: 0 });
            expect(badOffset.isError && badOffset.content.includes('offset 从 1 开始'), 'the shared offset is validated');
        },
    },
    {
        name: 'an edit batch composes in list order and reports the item that no longer matches',
        body: async () => {
            await clearWorkspace();
            await write('notes/plan.md', 'one\ntwo\n');
            const tool = createWorkspaceTool({ state: stateOf() });
            const result = await call(tool, {
                action: 'edit',
                edits: [
                    { path: 'notes/plan.md', old_string: 'one', new_string: 'ONE' },
                    // Only exists after the first edit: proves the items run in order
                    { path: 'notes/plan.md', old_string: 'ONE', new_string: 'uno' },
                    { path: 'notes/plan.md', old_string: 'two', new_string: 'dos' },
                    { path: 'notes/plan.md', old_string: 'nope', new_string: 'x' },
                    { path: 'notes/plan.md', old_string: 'uno', new_string: 'one!' },
                ],
            });
            expect(!result.isError, `a partly failed edit batch is not a call error (${result.content})`);
            expect(result.content.includes('已修改 4 处：'), 'the successful edits are counted');
            expect(result.content.includes('- 《notes/plan.md》：替换 1 处'), 'each edit gets its own line');
            expect(result.content.includes('有 1 处没改成：'), 'the failed edit is counted');
            expect(result.content.includes('找不到这段 old_string'), 'the reason is the single-file wording');
            expect(result.content.includes('工作区（本会话 w1）：'), 'usage comes once at the end');
            expect(
                (await readWorkspaceFile(CHAT, ROOT, 'notes/plan.md'))?.content === 'one!\ndos\n',
                'the edits ran in order on the state the previous one left'
            );
        },
    },
    {
        name: 'an edit batch rejects a mixed form, an empty list and too many items',
        body: async () => {
            await clearWorkspace();
            const tool = createWorkspaceTool({ state: stateOf() });
            const mixed = await call(tool, {
                action: 'edit',
                path: 'a.md',
                old_string: 'x',
                new_string: 'y',
                edits: [{ path: 'b.md', old_string: 'x', new_string: 'y' }],
            });
            expect(
                mixed.isError && mixed.content.includes('edits 和 path 只能给一个'),
                'the single form and edits are exclusive'
            );
            const empty = await call(tool, { action: 'edit', edits: [] });
            expect(empty.isError && empty.content.includes('edits 是空的'), 'an empty edits array is an argument error');
            const tooMany = await call(tool, {
                action: 'edit',
                edits: Array.from({ length: EDIT_BATCH_MAX + 1 }, (_, index) => ({
                    path: `f${index}.md`,
                    old_string: 'x',
                    new_string: 'y',
                })),
            });
            expect(tooMany.isError && tooMany.content.includes(`最多 ${EDIT_BATCH_MAX} 项`), 'the item cap is enforced');
            const topLevelFlag = await call(tool, {
                action: 'edit',
                edits: [{ path: 'a.md', old_string: 'x', new_string: 'y' }],
                replace_all: true,
            });
            expect(
                topLevelFlag.isError && topLevelFlag.content.includes('写在每一项里'),
                'a batch field at the top level is refused, not silently ignored'
            );
        },
    },
    {
        name: 'a preview batch renders its drafts in order and reports the ones that failed',
        body: async () => {
            await clearWorkspace();
            await write('widgets/one.html', '<div class="a">one</div>');
            await write('widgets/two.html', '<div class="b">two</div>');
            await write('widgets/bad.json', '{ not json');
            const documents: string[] = [];
            const tool = createWorkspaceTool({
                state: stateOf(),
                workspacePreview: true,
                previewLimits: { allowHtml: true, maxHtmlBytes: 32768, maxGzipBytes: 4096 },
                previewDependencies: {
                    renderPng: async (document: string) => {
                        documents.push(document);
                        // The second draft renders, then the sidecar fails on the third
                        return documents.length === 2 ? null : { png: PNG, width: 600, height: 300 };
                    },
                },
            });

            const result = await call(tool, {
                action: 'preview',
                paths: ['widgets/one.html', 'widgets/two.html', 'widgets/bad.json'],
            });
            expect(!result.isError, `a partly failed batch is not a call error (${result.content})`);
            expect(result.modelImages?.length === 1, `only the rendered draft brings a picture (${result.modelImages?.length})`);
            expect(result.content.includes('已渲染 1 张预览：'), 'the rendered draft is counted');
            expect(result.content.includes('600×300'), 'its size is reported');
            expect(result.content.includes('有 2 个没渲染成：'), 'the failed drafts are counted');
            expect(result.content.includes('渲染不可用'), 'the failed render is named');
            expect(result.content.includes('不是合法的 JSON'), 'the broken json is named');
            expect(documents.length === 2, 'the broken json fails before reaching the renderer');
            expect(
                result.trace?.argument?.includes('3 个草稿'),
                `the trace counts the requested drafts (${result.trace?.argument})`
            );
        },
    },
    {
        name: 'a preview batch rejects a mixed form, an empty list and too many paths',
        body: async () => {
            const tool = createWorkspaceTool({
                state: stateOf(),
                workspacePreview: true,
                previewLimits: { allowHtml: true, maxHtmlBytes: 32768, maxGzipBytes: 4096 },
                previewDependencies: { renderPng: async () => ({ png: PNG, width: 600, height: 300 }) },
            });
            const mixed = await call(tool, { action: 'preview', path: 'a.html', paths: ['b.html'] });
            expect(mixed.isError && mixed.content.includes('paths 和 path 只能给一个'), 'the two forms are exclusive');
            const empty = await call(tool, { action: 'preview', paths: [] });
            expect(empty.isError && empty.content.includes('paths 是空的'), 'an empty paths array is an argument error');
            const tooMany = await call(tool, {
                action: 'preview',
                paths: Array.from({ length: PREVIEW_BATCH_MAX + 1 }, (_, index) => `f${index}.html`),
            });
            expect(tooMany.isError && tooMany.content.includes(`最多 ${PREVIEW_BATCH_MAX} 项`), 'the path cap is enforced');
            const badTheme = await call(tool, { action: 'preview', paths: ['a.html'], theme: 'dim' });
            expect(badTheme.isError && badTheme.content.includes('theme 只能是'), 'the shared theme is validated');
        },
    },
    {
        name: 'the single-file wording of the merged actions is preserved and trace prefixes the action',
        body: async () => {
            await clearWorkspace();
            const state = createWorkspaceState({ chatId: CHAT, conversationRootIds: [ROOT], quota: QUOTA });
            const tool = createWorkspaceTool({
                state,
                workspacePreview: true,
                previewLimits: { allowHtml: true, maxHtmlBytes: 32768, maxGzipBytes: 4096 },
                previewDependencies: { renderPng: async () => ({ png: PNG, width: 600, height: 320 }) },
            });
            const written = await call(tool, { action: 'write', path: 'exact/a.md', content: 'abc' });
            expect(
                written.content ===
                    `已写入《exact/a.md》（本会话 w1）：${formatBytes(3)}（工作区 1 个文件，已用 ` +
                        `${formatBytes(3)} / ${formatBytes(QUOTA.maxConversationBytes)}）。`,
                `the single write keeps its wording (got ${written.content})`
            );
            expect(written.trace?.argument === 'write · exact/a.md', `the single write trace prefixes action (got ${written.trace?.argument})`);
            expect(written.trace?.result === '3B（新建）', 'the single write trace keeps its result');

            const read = await call(tool, { action: 'read', path: 'exact/a.md' });
            expect(
                read.content === `《exact/a.md》（本会话 w1）：共 1 行 / ${formatBytes(3)}；显示第 1–1 行。\n1| abc`,
                `the single read keeps its wording (got ${read.content})`
            );

            const edited = await call(tool, {
                action: 'edit',
                path: 'exact/a.md',
                old_string: 'abc',
                new_string: 'abcd',
            });
            expect(
                edited.content === `已修改《exact/a.md》（本会话 w1）：替换 1 处，现在 ${formatBytes(4)}。`,
                `the single edit keeps its wording (got ${edited.content})`
            );

            await write('widgets/exact.html', '<div>x</div>');
            const limits = { allowHtml: true, maxHtmlBytes: 32768, maxGzipBytes: 4096 };
            const previewed = await call(tool, { action: 'preview', path: 'widgets/exact.html' });
            const size = measureWidgetHtml('<div>x</div>');
            expect(
                previewed.content ===
                    `已渲染《widgets/exact.html》（本会话 w1）预览：600×320 PNG，已附上（静态首帧）。` +
                        `体积：原文 ${formatBytes(size.rawBytes)} / ${formatBytes(limits.maxHtmlBytes)}，` +
                        `zlib9 ${formatBytes(size.zlibBytes)} / ${formatBytes(limits.maxGzipBytes)}；` +
                        'widget 预检：通过。',
                `the single preview keeps its wording (got ${previewed.content})`
            );
        },
    },
    {
        name: 'a batch whose items all failed is an error result',
        body: async () => {
            await clearWorkspace();
            const state = createWorkspaceState({ chatId: CHAT, conversationRootIds: [ROOT], quota: QUOTA });
            const tool = createWorkspaceTool({
                state,
                workspacePreview: true,
                previewLimits: { allowHtml: true, maxHtmlBytes: 32768, maxGzipBytes: 4096 },
                previewDependencies: { renderPng: async () => ({ png: PNG, width: 600, height: 300 }) },
            });
            const written = await call(tool, {
                action: 'write',
                files: [
                    { path: '../a.md', content: 'x' },
                    { path: '/abs.md', content: 'y' },
                ],
            });
            expect(written.isError, 'a write batch with no success is an error');
            expect(written.content.includes('这 2 个文件都没写成：'), `the header says so (${written.content})`);

            const edited = await call(tool, {
                action: 'edit',
                edits: [
                    { path: 'notes/missing.md', old_string: 'x', new_string: 'y' },
                    { path: 'notes/missing.md', old_string: 'z', new_string: 'w' },
                ],
            });
            expect(edited.isError, 'an edit batch with no success is an error');
            expect(edited.content.includes('这 2 处都没改成：'), `the header says so (${edited.content})`);

            const previewed = await call(tool, {
                action: 'preview',
                paths: ['widgets/nope.html', 'widgets/bad.json'],
            });
            expect(previewed.isError, 'a preview batch with no rendered draft is an error');
            expect(previewed.content.includes('这 2 个草稿都没渲染成：'), `the header says so (${previewed.content})`);
            expect(previewed.modelImages === undefined, 'no picture rides the result');
        },
    },
    {
        name: 'merged workspace schema prunes preview/theme when preview is off, checks action, and switches statusText',
        body: async () => {
            const withPreview = createWorkspaceTool({
                state: stateOf(),
                workspacePreview: true,
                previewLimits: { allowHtml: true, maxHtmlBytes: 32768, maxGzipBytes: 4096 },
            });
            expect(withPreview.definition.name === WORKSPACE_TOOL_NAME, 'tool name is workspace');
            expect(withPreview.definition.description.includes('workspace-usage'), 'description references workspace-usage skill');
            const withProps = propertiesOf(withPreview);
            const withActionEnum = recordOf(withProps['action'])['enum'];
            expect(
                Array.isArray(withActionEnum) && withActionEnum.includes('preview') && withActionEnum.length === 8,
                `with preview on, action enum has 8 actions (${JSON.stringify(withActionEnum)})`
            );
            expect('theme' in withProps, 'with preview on, theme property is present');

            const files = recordOf(withProps['files']);
            expect(files.minItems === 1 && files.maxItems === WRITE_BATCH_MAX, 'files is a 1–10 array');
            expect(Array.isArray(recordOf(files['items'])['required']), 'a file item declares its own required fields');
            expect(
                recordOf(withProps['path']).type === 'string' && recordOf(withProps['content']).type === 'string',
                'the single-file fields are declared'
            );
            const edits = recordOf(withProps['edits']);
            expect(edits.minItems === 1 && edits.maxItems === EDIT_BATCH_MAX, 'edits is a 1–5 array');
            const paths = recordOf(withProps['paths']);
            expect(paths.minItems === 1 && paths.maxItems === READ_BATCH_MAX, 'paths caps at READ_BATCH_MAX (10)');
            expect(
                String(paths.description ?? '').includes(`preview≤${PREVIEW_BATCH_MAX}`),
                'paths description mentions preview cap when preview is on'
            );

            const withoutPreview = createWorkspaceTool({ state: stateOf(), workspacePreview: false });
            const withoutProps = propertiesOf(withoutPreview);
            const withoutActionEnum = recordOf(withoutProps['action'])['enum'];
            expect(
                Array.isArray(withoutActionEnum) && !withoutActionEnum.includes('preview') && withoutActionEnum.length === 7,
                `with preview off, action enum has 7 actions (${JSON.stringify(withoutActionEnum)})`
            );
            expect(!('theme' in withoutProps), 'with preview off, theme property is omitted');

            const refusedPreview = await call(withoutPreview, { action: 'preview', path: 'widgets/card.html' });
            expect(
                refusedPreview.isError && refusedPreview.content.includes('未开启工作区预览'),
                `preview action is rejected when disabled (got ${refusedPreview.content})`
            );
            const badAction = await call(withoutPreview, { action: 'unknown' });
            expect(badAction.isError && badAction.content.includes('action 必须是'), 'unknown action is rejected');

            expect(typeof withPreview.statusText === 'function', 'statusText is a dynamic function');
            if (typeof withPreview.statusText === 'function') {
                expect(withPreview.statusText({ action: 'list' }) === '📂 正在列工作区…', 'list statusText');
                expect(withPreview.statusText({ action: 'read' }) === '📖 正在读工作区文件…', 'read statusText');
                expect(withPreview.statusText({ action: 'write' }) === '📝 正在写工作区文件…', 'write statusText');
                expect(withPreview.statusText({ action: 'edit' }) === '✏️ 正在修改工作区文件…', 'edit statusText');
                expect(withPreview.statusText({ action: 'copy' }) === '📋 正在复制工作区文件…', 'copy statusText');
                expect(withPreview.statusText({ action: 'delete' }) === '🗑️ 正在删除工作区文件…', 'delete statusText');
                expect(withPreview.statusText({ action: 'find' }) === '🔍 正在搜索工作区…', 'find statusText');
                expect(withPreview.statusText({ action: 'preview' }) === '🖼️ 正在渲染工作区预览…', 'preview statusText');
                expect(withPreview.statusText({ action: 'other' }) === '⚙️ 正在操作工作区…', 'fallback statusText');
            }
        },
    },
    {
        name: 'blank single-file fields are fillers next to a batch call',
        body: async () => {
            const state = stateOf([ROOT]);

            const tool = createWorkspaceTool({
                state,
                workspacePreview: true,
                previewLimits: { allowHtml: true, maxHtmlBytes: 32768, maxGzipBytes: 4096 },
            });
            const written = await call(tool, {
                action: 'write',
                files: [{ path: 'notes/a.md', content: 'A' }],
                path: '',
                content: '',
            });
            expect(!written.isError, `blank fillers do not fail the write batch (${written.content})`);

            const read = await call(tool, { action: 'read', paths: ['notes/a.md'], path: '' });
            expect(
                !read.isError && read.content.includes('notes/a.md'),
                `a blank path filler does not fail the read batch (${read.content})`
            );

            const edited = await call(tool, {
                action: 'edit',
                edits: [{ path: 'notes/a.md', old_string: 'A', new_string: 'B' }],
                path: '',
                old_string: '',
                new_string: '',
            });
            expect(!edited.isError, `blank fillers do not fail the edit batch (${edited.content})`);

            const previewed = await call(tool, { action: 'preview', paths: ['notes/a.md'], path: '' });
            expect(
                !previewed.content.includes('只能给一个'),
                `a blank path filler does not look like a second form (${previewed.content})`
            );

            // An empty batch array next to a valid single form is a filler too
            const singleWrite = await call(tool, {
                action: 'write',
                path: 'notes/b.md',
                content: 'B',
                files: [],
            });
            expect(!singleWrite.isError, `an empty files array does not hijack the single write (${singleWrite.content})`);
            const singleRead = await call(tool, { action: 'read', path: 'notes/b.md', paths: [] });
            expect(
                !singleRead.isError && singleRead.content.includes('notes/b.md'),
                `an empty paths array does not hijack the single read (${singleRead.content})`
            );
        },
    },
];


const results: CaseResult[] = [];
for (const { name, body } of cases) {
    results.push(await runCase(name, body));
}
await reportResults(results);
