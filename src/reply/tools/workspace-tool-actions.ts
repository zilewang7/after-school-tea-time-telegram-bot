/**
 * Action executors for the merged `workspace` tool.
 *
 * Keeps the exact quota, validation, touch, widget draft budget, render, and
 * trace semantics of the 8 legacy workspace_* tools while unifying error hints
 * onto `workspace(action=...)`.
 */
import type { ToolCallTrace, ToolModelImage, ToolResult } from '../../ai/tools/tool-types.js';
import { compileA2uiSurface } from '../../ai/widget/index.js';
import { measureWidgetHtml, type WidgetBudgetLimits } from '../../ai/widget/widget-size.js';
import { baseNameOf, extensionOf, formatBytes } from '../../shared/file-name.js';
import {
    copyWorkspaceFile,
    deleteWorkspaceFile,
    editWorkspaceFile,
    findWorkspaceFiles,
    formatWorkspaceTime,
    listWorkspaceFiles,
    loadWorkspaceContents,
    readWorkspaceFile,
    touchWorkspaceFile,
    workspaceUsageOf,
    writeWorkspaceFile,
    type WorkspaceEditOk,
    type WorkspaceWriteOk,
} from '../../services/workspace-service.js';
import { precheckWidgetHtml, type WidgetPrecheckLimits } from '../../telegram/widget-precheck.js';
import { renderWidgetPng } from '../../widget-image/render-client.js';
import { widgetDocument } from '../../widget-image/widget-page.js';
import { resolveWorkspaceRef, type WorkspaceRef, type WorkspaceState } from '../workspace/workspace-state.js';
import { isWidgetDraftPath, widgetDraftListDetailOf, widgetDraftSizeLineOf } from '../workspace/workspace-widget-size.js';
import {
    parseWorkspaceCopyArgs,
    parseWorkspaceDeleteArgs,
    parseWorkspaceEditArgs,
    parseWorkspaceEditBatchArgs,
    parseWorkspaceFindArgs,
    parseWorkspaceListArgs,
    parseWorkspacePreviewArgs,
    parseWorkspacePreviewBatchArgs,
    parseWorkspaceReadArgs,
    parseWorkspaceReadBatchArgs,
    parseWorkspaceWriteArgs,
    parseWorkspaceWriteBatchArgs,
    type PreviewTheme,
} from './workspace-tool-args.js';
import {
    logWorkspaceBatchFailures,
    workspaceBatchFailureLine,
    workspaceBatchTraceArgument,
    workspaceToolError,
    workspaceToolSuccess,
} from './workspace-tool-result.js';
import { traceBytes, traceParts, traceQuote, traceWorkspacePath } from './tool-trace.js';
import type { WorkspaceAction } from './workspace-tool-schema.js';

export interface WorkspacePreviewRenderResult {
    readonly png: Buffer;
    readonly width: number;
    readonly height: number;
}

export interface WorkspacePreviewDependencies {
    readonly renderPng: (
        document: string,
        options: { readonly width: number; readonly theme: 'light' | 'dark' }
    ) => Promise<WorkspacePreviewRenderResult | null>;
}

export interface WorkspaceActionContext {
    readonly state: WorkspaceState;
    readonly widgetLimits: WidgetBudgetLimits | null;
    readonly previewEnabled: boolean;
    readonly previewLimits: WidgetPrecheckLimits | null;
    readonly previewDependencies: WorkspacePreviewDependencies;
}

export const DEFAULT_PREVIEW_DEPENDENCIES: WorkspacePreviewDependencies = {
    renderPng: (document, options) =>
        renderWidgetPng(document, { width: options.width, theme: options.theme }),
};

const MAX_READ_CHARS = 24_000;
const MAX_LINE_CHARS = 2_000;
const MAX_FIND_HITS = 50;
const MAX_FIND_CHARS = 8_000;
const MAX_FIND_LINE_CHARS = 200;
const MAX_PREVIEW_DOCUMENT_BYTES = 300 * 1024;
const PREVIEW_WIDTH = 600;
const REJECTION_LOG_MAX_CHARS = 200;
const UNREAD_LINE = '未读：本次读取的 24000 字符预算已用完（可用 offset 继续）';

const reject = (action: WorkspaceAction, message: string): ToolResult => {
    console.warn(`[workspace:${action}] rejected: ${Array.from(message).slice(0, REJECTION_LOG_MAX_CHARS).join('')}`);
    return workspaceToolError(message, { argument: action });
};

const actionTrace = (action: WorkspaceAction, trace: ToolCallTrace): ToolCallTrace => ({
    ...trace,
    argument: trace.argument === undefined || trace.argument === '' ? action : `${action} · ${trace.argument}`,
});

const readHeaderOf = (
    path: string,
    label: string,
    start: number,
    end: number,
    totalLines: number,
    sizeBytes: number
): string =>
    `《${path}》（${label}）：共 ${totalLines} 行 / ${formatBytes(sizeBytes)}；显示第 ${start + 1}–${end} 行。`;

const displayLineOf = (rawLine: string): string => {
    const chars = Array.from(rawLine);
    return chars.length > MAX_LINE_CHARS ? `${chars.slice(0, MAX_LINE_CHARS).join('')}…（本行过长已截断）` : rawLine;
};

export const executeWorkspaceList = async (
    rawArgs: Readonly<Record<string, unknown>>,
    ctx: WorkspaceActionContext
): Promise<ToolResult> => {
    const { state, widgetLimits } = ctx;
    const parsed = parseWorkspaceListArgs(rawArgs);
    if (!parsed.ok) return reject('list', parsed.error);
    const ref = resolveWorkspaceRef(state, rawArgs.workspace);
    if (!ref.ok) return reject('list', ref.error);

    const snapshot = await listWorkspaceFiles(state.chatId, ref.ref.rootId, parsed.value.prefix);
    const label = `${ref.ref.label} ${ref.ref.token}`;
    const draftPaths =
        widgetLimits === null
            ? []
            : snapshot.files
                  .filter((file) => isWidgetDraftPath(file.path) && file.sizeBytes <= widgetLimits.maxHtmlBytes)
                  .map((file) => file.path);
    const draftContents =
        widgetLimits === null
            ? new Map<string, string>()
            : await loadWorkspaceContents(state.chatId, ref.ref.rootId, draftPaths);
    const hasDraft = snapshot.files.some((file) => isWidgetDraftPath(file.path));
    const widgetHint =
        widgetLimits === null || !hasDraft
            ? ''
            : `\nHTML 草稿按 widget 计：原文 ≤ ${widgetLimits.maxHtmlBytes} B、zlib9 ≤ ${widgetLimits.maxGzipBytes} B。`;
    const header =
        `工作区（${label}）共 ${snapshot.usage.fileCount} 个文件，已用 ` +
        `${formatBytes(snapshot.usage.totalBytes)} / ${formatBytes(state.quota.maxConversationBytes)}` +
        (parsed.value.prefix === '' ? '。' : `；${parsed.value.prefix} 下 ${snapshot.files.length} 个。`) +
        widgetHint;

    const traceArgument = traceWorkspacePath(ref.ref.token, parsed.value.prefix);
    if (snapshot.files.length === 0) {
        return workspaceToolSuccess(
            `${header}\n${parsed.value.prefix === '' ? '工作区是空的。用 workspace(action="write") 创建草稿。' : '这个目录下没有文件。'}`,
            undefined,
            actionTrace('list', { argument: traceArgument, result: '空目录' })
        );
    }

    const lines = snapshot.files.map((file) => {
        const summary = file.summary === '' ? '' : ` — ${file.summary}`;
        const detail =
            widgetLimits !== null && isWidgetDraftPath(file.path)
                ? widgetDraftListDetailOf(file.sizeBytes, draftContents.get(file.path), widgetLimits)
                : formatBytes(file.sizeBytes);
        return `- ${file.path}（${detail}，${formatWorkspaceTime(file.updatedAt)}）${summary}`;
    });
    return workspaceToolSuccess(
        `${header}\n${lines.join('\n')}`,
        undefined,
        actionTrace('list', {
            argument: traceArgument,
            result: parsed.value.prefix === '' ? `共 ${snapshot.usage.fileCount} 个文件` : `${snapshot.files.length} 个文件`,
        })
    );
};

const executeReadBatch = async (
    rawArgs: Readonly<Record<string, unknown>>,
    ctx: WorkspaceActionContext
): Promise<ToolResult> => {
    const { state } = ctx;
    const parsed = parseWorkspaceReadBatchArgs(rawArgs);
    if (!parsed.ok) return reject('read', parsed.error);
    const ref = resolveWorkspaceRef(state, parsed.value.workspace);
    if (!ref.ok) return reject('read', ref.error);
    const requestLabels = parsed.value.items.map((item) =>
        item.ok ? traceWorkspacePath(ref.ref.token, item.path) : item.label
    );
    const label = `${ref.ref.label} ${ref.ref.token}`;
    const blocks: string[] = [];
    const failures: string[] = [];
    const unread: string[] = [];
    let remaining = MAX_READ_CHARS;

    for (const item of parsed.value.items) {
        if (!item.ok) {
            failures.push(workspaceBatchFailureLine(item.label, item.error));
            continue;
        }
        const displayLabel = traceWorkspacePath(ref.ref.token, item.path);
        if (remaining <= 0) {
            unread.push(`《${displayLabel}》：${UNREAD_LINE}`);
            continue;
        }
        const file = await readWorkspaceFile(state.chatId, ref.ref.rootId, item.path);
        if (file === null) {
            failures.push(
                `《${displayLabel}》：工作区里没有这个文件。用 workspace(action="list") 看看现有文件，或先 workspace(action="write") 创建。`
            );
            continue;
        }
        await touchWorkspaceFile(file.id).catch((error: unknown) => {
            console.warn('[workspace:read] lastUsedAt refresh failed:', error);
        });
        const lines = file.content.split('\n');
        const totalLines = lines.length;
        const start = parsed.value.offset - 1;
        if (parsed.value.offset > totalLines) {
            failures.push(`《${displayLabel}》：offset=${parsed.value.offset} 超过文件行数（共 ${totalLines} 行）。`);
            continue;
        }
        const provisionalHeader = readHeaderOf(
            file.path,
            label,
            start,
            start + Math.min(parsed.value.limit, totalLines - start),
            totalLines,
            file.sizeBytes
        );
        if (remaining <= provisionalHeader.length + 1) {
            unread.push(`《${displayLabel}》：${UNREAD_LINE}`);
            continue;
        }
        const shown: string[] = [];
        let used = provisionalHeader.length + 1;
        let index = start;
        for (; index < totalLines && shown.length < parsed.value.limit; index += 1) {
            const numbered = `${index + 1}| ${displayLineOf(lines[index] ?? '')}`;
            if (used + numbered.length + 1 > remaining) break;
            shown.push(numbered);
            used += numbered.length + 1;
        }
        if (shown.length === 0) {
            unread.push(`《${displayLabel}》：${UNREAD_LINE}`);
            continue;
        }
        remaining -= used;
        const header = readHeaderOf(file.path, label, start, start + shown.length, totalLines, file.sizeBytes);
        const restLines = totalLines - index;
        const tail = restLines > 0 ? `\n… 还有 ${restLines} 行，用 offset=${index + 1} 继续。` : '';
        blocks.push(`${header}\n${shown.join('\n')}${tail}`);
    }

    logWorkspaceBatchFailures('workspace:read', failures);
    const notRead = [...failures, ...unread];
    const output: string[] = [];
    if (blocks.length > 0) {
        output.push(`已读取 ${blocks.length} 个文件：`);
        output.push(blocks.join('\n\n'));
    }
    if (notRead.length > 0) {
        output.push(blocks.length > 0 ? `有 ${notRead.length} 个没读成：` : `这 ${parsed.value.items.length} 个文件都没读成：`);
        for (const line of notRead) output.push(`- ${line}`);
    }
    const trace = actionTrace('read', {
        argument: workspaceBatchTraceArgument('个文件', requestLabels),
        result: traceParts(
            `${blocks.length} 个文件`,
            failures.length > 0 ? `${failures.length} 个失败` : null,
            unread.length > 0 ? `${unread.length} 个未读` : null
        ),
    });
    return blocks.length === 0 ? workspaceToolError(output.join('\n'), trace) : workspaceToolSuccess(output.join('\n'), undefined, trace);
};

export const executeWorkspaceRead = async (
    rawArgs: Readonly<Record<string, unknown>>,
    ctx: WorkspaceActionContext
): Promise<ToolResult> => {
    const singleGiven = typeof rawArgs.path === 'string' && rawArgs.path.trim() !== '';
    if (Array.isArray(rawArgs.paths) && (rawArgs.paths.length > 0 || !singleGiven)) {
        return executeReadBatch(rawArgs, ctx);
    }
    const { state } = ctx;
    const parsed = parseWorkspaceReadArgs(rawArgs);
    if (!parsed.ok) return reject('read', parsed.error);
    const ref = resolveWorkspaceRef(state, rawArgs.workspace);
    if (!ref.ok) return reject('read', ref.error);

    const file = await readWorkspaceFile(state.chatId, ref.ref.rootId, parsed.value.path);
    if (file === null) {
        return reject(
            'read',
            `工作区里没有《${parsed.value.path}》。用 workspace(action="list") 看看现有文件，或先 workspace(action="write") 创建。`
        );
    }
    await touchWorkspaceFile(file.id).catch((error: unknown) => {
        console.warn('[workspace:read] lastUsedAt refresh failed:', error);
    });
    const lines = file.content.split('\n');
    const totalLines = lines.length;
    if (parsed.value.offset > totalLines) {
        return reject('read', `offset=${parsed.value.offset} 超过文件行数（共 ${totalLines} 行）。`);
    }
    const start = parsed.value.offset - 1;
    const shown: string[] = [];
    let usedChars = 0;
    let index = start;
    for (; index < totalLines && shown.length < parsed.value.limit; index += 1) {
        const numbered = `${index + 1}| ${displayLineOf(lines[index] ?? '')}`;
        if (usedChars + numbered.length > MAX_READ_CHARS) break;
        shown.push(numbered);
        usedChars += numbered.length + 1;
    }
    const label = `${ref.ref.label} ${ref.ref.token}`;
    const header = readHeaderOf(file.path, label, start, start + shown.length, totalLines, file.sizeBytes);
    const remaining = totalLines - index;
    const tail = remaining > 0 ? `\n… 还有 ${remaining} 行，用 offset=${index + 1} 继续。` : '';
    return workspaceToolSuccess(
        `${header}\n${shown.join('\n')}${tail}`,
        undefined,
        actionTrace('read', {
            argument: `${traceWorkspacePath(ref.ref.token, file.path)} 第 ${start + 1}–${start + shown.length} 行`,
            result: `共 ${totalLines} 行`,
        })
    );
};

interface WriteBatchSuccess {
    readonly ref: WorkspaceRef;
    readonly result: WorkspaceWriteOk;
    readonly append: boolean;
}

const writeModeOf = (created: boolean, append: boolean): string => (created ? '新建' : append ? '追加' : '覆盖');

const executeWriteBatch = async (
    rawArgs: Readonly<Record<string, unknown>>,
    ctx: WorkspaceActionContext
): Promise<ToolResult> => {
    const { state, widgetLimits } = ctx;
    const parsed = parseWorkspaceWriteBatchArgs(rawArgs);
    if (!parsed.ok) return reject('write', parsed.error);
    const items = parsed.value;
    const traceLabels: string[] = [];
    const successes: WriteBatchSuccess[] = [];
    const failures: string[] = [];

    for (const item of items) {
        if (!item.ok) {
            traceLabels.push(item.label);
            failures.push(workspaceBatchFailureLine(item.label, item.error));
            continue;
        }
        const ref = resolveWorkspaceRef(state, item.workspace);
        if (!ref.ok) {
            traceLabels.push(item.args.path);
            failures.push(workspaceBatchFailureLine(item.args.path, ref.error));
            continue;
        }
        traceLabels.push(traceWorkspacePath(ref.ref.token, item.args.path));
        const result = await writeWorkspaceFile({
            chatId: state.chatId,
            conversationRootId: ref.ref.rootId,
            path: item.args.path,
            content: item.args.content,
            append: item.args.append,
            overwrite: item.args.overwrite,
            quota: state.quota,
        });
        if (!result.ok) {
            failures.push(workspaceBatchFailureLine(traceWorkspacePath(ref.ref.token, item.args.path), result.error));
            continue;
        }
        successes.push({ ref: ref.ref, result, append: item.args.append });
    }

    logWorkspaceBatchFailures('workspace:write', failures);
    const lines: string[] = [];
    if (successes.length > 0) {
        lines.push(`已写入 ${successes.length} 个文件：`);
        for (const success of successes) {
            const label = traceWorkspacePath(success.ref.token, success.result.path);
            const line = `- 《${label}》（${formatBytes(success.result.sizeBytes)}，${writeModeOf(success.result.created, success.append)}）`;
            const draftLine = widgetDraftSizeLineOf(success.result.path, success.result.content, widgetLimits);
            lines.push(draftLine === '' ? line : `${line}\n  ${draftLine}`);
        }
        const byToken = new Map<string, WriteBatchSuccess>();
        for (const success of successes) byToken.set(success.ref.token, success);
        for (const { ref, result } of byToken.values()) {
            lines.push(
                `工作区（${ref.label} ${ref.token}）：${result.fileCount} 个文件，已用 ` +
                    `${formatBytes(result.totalBytes)} / ${formatBytes(state.quota.maxConversationBytes)}。`
            );
        }
    }
    if (failures.length > 0) {
        lines.push(successes.length > 0 ? `有 ${failures.length} 个没写成：` : `这 ${items.length} 个文件都没写成：`);
        for (const failure of failures) lines.push(`- ${failure}`);
    }
    const writtenBytes = successes.reduce((total, success) => total + success.result.sizeBytes, 0);
    const trace = actionTrace('write', {
        argument: workspaceBatchTraceArgument('个文件', traceLabels),
        result:
            successes.length === 0
                ? '全部失败'
                : traceParts(`${successes.length} 个文件`, traceBytes(writtenBytes), failures.length > 0 ? `${failures.length} 个失败` : null),
    });
    return successes.length === 0 ? workspaceToolError(lines.join('\n'), trace) : workspaceToolSuccess(lines.join('\n'), undefined, trace);
};

export const executeWorkspaceWrite = async (
    rawArgs: Readonly<Record<string, unknown>>,
    ctx: WorkspaceActionContext
): Promise<ToolResult> => {
    const singleGiven = typeof rawArgs.path === 'string' && rawArgs.path.trim() !== '';
    if (Array.isArray(rawArgs.files) && (rawArgs.files.length > 0 || !singleGiven)) {
        return executeWriteBatch(rawArgs, ctx);
    }
    const { state, widgetLimits } = ctx;
    const parsed = parseWorkspaceWriteArgs(rawArgs);
    if (!parsed.ok) return reject('write', parsed.error);
    const ref = resolveWorkspaceRef(state, rawArgs.workspace);
    if (!ref.ok) return reject('write', ref.error);

    const result = await writeWorkspaceFile({
        chatId: state.chatId,
        conversationRootId: ref.ref.rootId,
        path: parsed.value.path,
        content: parsed.value.content,
        append: parsed.value.append,
        overwrite: parsed.value.overwrite,
        quota: state.quota,
    });
    if (!result.ok) return reject('write', result.error);

    const label = `${ref.ref.label} ${ref.ref.token}`;
    const usage =
        `工作区 ${result.fileCount} 个文件，已用 ${formatBytes(result.totalBytes)} / ` +
        `${formatBytes(state.quota.maxConversationBytes)}`;
    const size = formatBytes(result.sizeBytes);
    const content = result.created
        ? parsed.value.append
            ? `已新建并写入《${result.path}》（${label}）：${size}（${usage}）。`
            : `已写入《${result.path}》（${label}）：${size}（${usage}）。`
        : parsed.value.append
          ? `已追加到《${result.path}》（${label}）：现在 ${size}（${usage}）。`
          : `已覆盖《${result.path}》（${label}）：原 ${formatBytes(result.replacedBytes ?? 0)} → ${size}（${usage}）。`;
    const draftLine = widgetDraftSizeLineOf(result.path, result.content, widgetLimits);
    const mode = parsed.value.append ? '（追加）' : parsed.value.overwrite ? '（覆盖）' : '';
    return workspaceToolSuccess(
        draftLine === '' ? content : `${content}\n${draftLine}`,
        undefined,
        actionTrace('write', {
            argument: `${traceWorkspacePath(ref.ref.token, result.path)}${mode}`,
            result: `${traceBytes(result.sizeBytes)}${result.created ? '（新建）' : ''}`,
        })
    );
};

interface EditBatchSuccess {
    readonly ref: WorkspaceRef;
    readonly result: WorkspaceEditOk;
}

const executeEditBatch = async (
    rawArgs: Readonly<Record<string, unknown>>,
    ctx: WorkspaceActionContext
): Promise<ToolResult> => {
    const { state, widgetLimits } = ctx;
    const parsed = parseWorkspaceEditBatchArgs(rawArgs);
    if (!parsed.ok) return reject('edit', parsed.error);
    const items = parsed.value;
    const traceLabels: string[] = [];
    const successes: EditBatchSuccess[] = [];
    const failures: string[] = [];

    for (const item of items) {
        if (!item.ok) {
            traceLabels.push(item.label);
            failures.push(workspaceBatchFailureLine(item.label, item.error));
            continue;
        }
        const ref = resolveWorkspaceRef(state, item.workspace);
        if (!ref.ok) {
            traceLabels.push(item.args.path);
            failures.push(workspaceBatchFailureLine(item.args.path, ref.error));
            continue;
        }
        traceLabels.push(traceWorkspacePath(ref.ref.token, item.args.path));
        const result = await editWorkspaceFile({
            chatId: state.chatId,
            conversationRootId: ref.ref.rootId,
            path: item.args.path,
            oldString: item.args.oldString,
            newString: item.args.newString,
            replaceAll: item.args.replaceAll,
            quota: state.quota,
        });
        if (!result.ok) {
            failures.push(workspaceBatchFailureLine(traceWorkspacePath(ref.ref.token, item.args.path), result.error));
            continue;
        }
        successes.push({ ref: ref.ref, result });
    }

    logWorkspaceBatchFailures('workspace:edit', failures);
    const lines: string[] = [];
    if (successes.length > 0) {
        lines.push(`已修改 ${successes.length} 处：`);
        for (const success of successes) {
            const label = traceWorkspacePath(success.ref.token, success.result.path);
            const line = `- 《${label}》：替换 ${success.result.replacements} 处，现在 ${formatBytes(success.result.sizeBytes)}。`;
            const draftLine = widgetDraftSizeLineOf(success.result.path, success.result.content, widgetLimits);
            lines.push(draftLine === '' ? line : `${line}\n  ${draftLine}`);
        }
        const byToken = new Map<string, WorkspaceRef>();
        for (const success of successes) byToken.set(success.ref.token, success.ref);
        for (const ref of byToken.values()) {
            const usage = await workspaceUsageOf(state.chatId, ref.rootId);
            lines.push(
                `工作区（${ref.label} ${ref.token}）：${usage.fileCount} 个文件，已用 ` +
                    `${formatBytes(usage.totalBytes)} / ${formatBytes(state.quota.maxConversationBytes)}。`
            );
        }
    }
    if (failures.length > 0) {
        lines.push(successes.length > 0 ? `有 ${failures.length} 处没改成：` : `这 ${items.length} 处都没改成：`);
        for (const failure of failures) lines.push(`- ${failure}`);
    }
    const replacements = successes.reduce((total, success) => total + success.result.replacements, 0);
    const trace = actionTrace('edit', {
        argument: workspaceBatchTraceArgument('处修改', traceLabels),
        result:
            successes.length === 0
                ? '全部失败'
                : traceParts(`替换 ${replacements} 处`, failures.length > 0 ? `${failures.length} 处失败` : null),
    });
    return successes.length === 0 ? workspaceToolError(lines.join('\n'), trace) : workspaceToolSuccess(lines.join('\n'), undefined, trace);
};

export const executeWorkspaceEdit = async (
    rawArgs: Readonly<Record<string, unknown>>,
    ctx: WorkspaceActionContext
): Promise<ToolResult> => {
    const singleGiven =
        typeof rawArgs.path === 'string' && rawArgs.path.trim() !== '' && typeof rawArgs.old_string === 'string';
    if (Array.isArray(rawArgs.edits) && (rawArgs.edits.length > 0 || !singleGiven)) {
        return executeEditBatch(rawArgs, ctx);
    }
    const { state, widgetLimits } = ctx;
    const parsed = parseWorkspaceEditArgs(rawArgs);
    if (!parsed.ok) return reject('edit', parsed.error);
    const ref = resolveWorkspaceRef(state, rawArgs.workspace);
    if (!ref.ok) return reject('edit', ref.error);

    const result = await editWorkspaceFile({
        chatId: state.chatId,
        conversationRootId: ref.ref.rootId,
        path: parsed.value.path,
        oldString: parsed.value.oldString,
        newString: parsed.value.newString,
        replaceAll: parsed.value.replaceAll,
        quota: state.quota,
    });
    if (!result.ok) return reject('edit', result.error);

    const label = `${ref.ref.label} ${ref.ref.token}`;
    const content = `已修改《${result.path}》（${label}）：替换 ${result.replacements} 处，现在 ${formatBytes(result.sizeBytes)}。`;
    const draftLine = widgetDraftSizeLineOf(result.path, result.content, widgetLimits);
    return workspaceToolSuccess(
        draftLine === '' ? content : `${content}\n${draftLine}`,
        undefined,
        actionTrace('edit', {
            argument: `${traceWorkspacePath(ref.ref.token, result.path)}${parsed.value.replaceAll ? '（全部）' : ''}`,
            result: `替换 ${result.replacements} 处 · ${traceBytes(result.sizeBytes)}`,
        })
    );
};

export const executeWorkspaceCopy = async (
    rawArgs: Readonly<Record<string, unknown>>,
    ctx: WorkspaceActionContext
): Promise<ToolResult> => {
    const { state } = ctx;
    const parsed = parseWorkspaceCopyArgs(rawArgs);
    if (!parsed.ok) return reject('copy', parsed.error);
    const ref = resolveWorkspaceRef(state, rawArgs.workspace);
    if (!ref.ok) return reject('copy', ref.error);

    const result = await copyWorkspaceFile(state.chatId, ref.ref.rootId, {
        from: parsed.value.from,
        to: parsed.value.to,
        quota: state.quota,
    });
    if (!result.ok) return reject('copy', result.error);

    const label = `${ref.ref.label} ${ref.ref.token}`;
    const usage =
        `工作区 ${result.fileCount} 个文件，已用 ${formatBytes(result.totalBytes)} / ` +
        `${formatBytes(state.quota.maxConversationBytes)}`;
    return workspaceToolSuccess(
        `已复制《${result.from}》→《${result.to}》（${label}）：${formatBytes(result.sizeBytes)}（${usage}）。`,
        undefined,
        actionTrace('copy', {
            argument: `${traceWorkspacePath(ref.ref.token, result.from)} → ${result.to}`,
            result: traceBytes(result.sizeBytes),
        })
    );
};

export const executeWorkspaceDelete = async (
    rawArgs: Readonly<Record<string, unknown>>,
    ctx: WorkspaceActionContext
): Promise<ToolResult> => {
    const { state } = ctx;
    const parsed = parseWorkspaceDeleteArgs(rawArgs);
    if (!parsed.ok) return reject('delete', parsed.error);
    const ref = resolveWorkspaceRef(state, rawArgs.workspace);
    if (!ref.ok) return reject('delete', ref.error);

    const result = await deleteWorkspaceFile(state.chatId, ref.ref.rootId, parsed.value.path);
    if (!result.ok) return reject('delete', result.error);

    const label = `${ref.ref.label} ${ref.ref.token}`;
    return workspaceToolSuccess(
        `已删除《${result.path}》（${label}）：释放 ${formatBytes(result.freedBytes)}；` +
            `工作区 ${result.fileCount} 个文件，已用 ${formatBytes(result.totalBytes)}。`,
        undefined,
        actionTrace('delete', {
            argument: traceWorkspacePath(ref.ref.token, result.path),
            result: `释放 ${traceBytes(result.freedBytes)}`,
        })
    );
};

export const executeWorkspaceFind = async (
    rawArgs: Readonly<Record<string, unknown>>,
    ctx: WorkspaceActionContext
): Promise<ToolResult> => {
    const { state } = ctx;
    const parsed = parseWorkspaceFindArgs(rawArgs);
    if (!parsed.ok) return reject('find', parsed.error);
    const ref = resolveWorkspaceRef(state, rawArgs.workspace);
    if (!ref.ok) return reject('find', ref.error);

    const result = await findWorkspaceFiles(state.chatId, ref.ref.rootId, {
        query: parsed.value.query,
        path: parsed.value.path,
        prefix: parsed.value.prefix,
        caseSensitive: parsed.value.caseSensitive,
        maxHits: MAX_FIND_HITS,
        maxChars: MAX_FIND_CHARS,
        maxLineChars: MAX_FIND_LINE_CHARS,
    });
    const label = `${ref.ref.label} ${ref.ref.token}`;
    const traceArgument = traceWorkspacePath(
        ref.ref.token,
        traceParts(
            traceQuote(parsed.value.query, 32),
            parsed.value.path ?? (parsed.value.prefix === '' ? null : parsed.value.prefix)
        )
    );
    if (parsed.value.path !== null && result.scannedFiles === 0) {
        return reject('find', `工作区（${label}）里没有《${parsed.value.path}》；用 workspace(action="list") 看看现有文件。`);
    }
    if (result.scannedFiles === 0) {
        const where = parsed.value.prefix === '' ? '' : `（${parsed.value.prefix} 下）`;
        return workspaceToolSuccess(
            `工作区（${label}）里没有可搜索的文件${where}；先用 workspace(action="write") 创建草稿。`,
            undefined,
            actionTrace('find', { argument: traceArgument, result: '没有可搜索的文件' })
        );
    }
    const scope =
        parsed.value.path !== null
            ? `《${parsed.value.path}》`
            : parsed.value.prefix === ''
              ? '整个工作区'
              : `${parsed.value.prefix} 目录`;
    if (result.totalHits === 0) {
        return workspaceToolSuccess(
            `在${scope}（${label}）里没有找到「${parsed.value.query}」；扫描了 ${result.scannedFiles} 个文件。` +
                '可以用 workspace(action="list") 看路径，或换个词/加 prefix。',
            undefined,
            actionTrace('find', { argument: traceArgument, result: `0 处（扫描 ${result.scannedFiles} 个文件）` })
        );
    }
    const lines = result.hits.map((hit) => `${hit.path}:${hit.lineNumber}| ${hit.line}`);
    const hidden = result.totalHits - result.hits.length;
    const tail = result.truncated && hidden > 0 ? `\n… 还有 ${hidden} 处未显示，缩小 query 或加 path/prefix。` : '';
    return workspaceToolSuccess(
        `在${scope}（${label}）里找到 ${result.totalHits} 处「${parsed.value.query}」（扫描 ${result.scannedFiles} 个文件）：\n` +
            lines.join('\n') +
            tail,
        undefined,
        actionTrace('find', {
            argument: traceArgument,
            result: traceParts(
                `${result.totalHits} 处（扫描 ${result.scannedFiles} 个文件）`,
                result.truncated && hidden > 0 ? `仅显示前 ${result.hits.length} 处` : null
            ),
        })
    );
};

type DraftRenderOutcome =
    | {
          readonly ok: true;
          readonly content: string;
          readonly modelImage: ToolModelImage;
          readonly width: number;
          readonly height: number;
          readonly precheckOk: boolean;
      }
    | { readonly ok: false; readonly error: string };

const renderDraft = async (
    ctx: WorkspaceActionContext,
    limits: WidgetPrecheckLimits,
    ref: WorkspaceRef,
    path: string,
    theme: PreviewTheme
): Promise<DraftRenderOutcome> => {
    const file = await readWorkspaceFile(ctx.state.chatId, ref.rootId, path);
    if (file === null) {
        return { ok: false, error: `工作区里没有《${path}》。用 workspace(action="list") 看看现有文件。` };
    }
    await touchWorkspaceFile(file.id).catch((error: unknown) => {
        console.warn('[workspace:preview] lastUsedAt refresh failed:', error);
    });
    const extension = extensionOf(baseNameOf(file.path));
    let html: string;
    let mode: 'html' | 'a2ui';
    if (extension === 'html' || extension === 'htm') {
        html = file.content;
        mode = 'html';
    } else if (extension === 'json') {
        let surface: unknown;
        try {
            surface = JSON.parse(file.content);
        } catch {
            return { ok: false, error: `《${file.path}》不是合法的 JSON；A2UI 草稿要写成合法的 surface JSON。` };
        }
        const compiled = compileA2uiSurface(surface, {
            maxHtmlBytes: limits.maxHtmlBytes,
            maxGzipBytes: limits.maxGzipBytes,
        });
        if (!compiled.ok) return { ok: false, error: `A2UI 草稿编译失败：${compiled.message}` };
        html = compiled.html;
        mode = 'a2ui';
    } else {
        return {
            ok: false,
            error: 'workspace(action="preview") 只支持 .html/.htm（HTML 草稿）或 .json（A2UI surface）；文本请用 workspace(action="read")。',
        };
    }

    const document = widgetDocument(html, { theme });
    if (Buffer.byteLength(document, 'utf8') > MAX_PREVIEW_DOCUMENT_BYTES) {
        return {
            ok: false,
            error:
                `《${file.path}》包裹成完整文档后有 ${formatBytes(Buffer.byteLength(document, 'utf8'))}，` +
                `超过渲染边车上限 ${formatBytes(MAX_PREVIEW_DOCUMENT_BYTES)}；请精简内容或拆成多个文件。`,
        };
    }
    const rendered = await ctx.previewDependencies.renderPng(document, { width: PREVIEW_WIDTH, theme });
    if (rendered === null) {
        return {
            ok: false,
            error: '预览渲染不可用或失败（边车未配置/超时）；可以直接 send_widget 发送，或用 workspace(action="read") 检查源码。',
        };
    }
    const size = measureWidgetHtml(html);
    const precheck = precheckWidgetHtml(mode, html, limits);
    const budget =
        `体积：原文 ${formatBytes(size.rawBytes)} / ${formatBytes(limits.maxHtmlBytes)}，` +
        `zlib9 ${formatBytes(size.zlibBytes)} / ${formatBytes(limits.maxGzipBytes)}`;
    const precheckLine = precheck.ok ? 'widget 预检：通过。' : `widget 预检：不通过——${precheck.message}`;
    return {
        ok: true,
        content:
            `已渲染《${file.path}》（${ref.label} ${ref.token}）预览：${rendered.width}×${rendered.height} PNG，已附上（静态首帧）。` +
            `${budget}；${precheckLine}`,
        modelImage: { data: rendered.png, mimeType: 'image/png', caption: `[workspace:preview] ${file.path}` },
        width: rendered.width,
        height: rendered.height,
        precheckOk: precheck.ok,
    };
};

const executePreviewBatch = async (
    rawArgs: Readonly<Record<string, unknown>>,
    ctx: WorkspaceActionContext,
    limits: WidgetPrecheckLimits
): Promise<ToolResult> => {
    const parsed = parseWorkspacePreviewBatchArgs(rawArgs);
    if (!parsed.ok) return reject('preview', parsed.error);
    const ref = resolveWorkspaceRef(ctx.state, parsed.value.workspace);
    if (!ref.ok) return reject('preview', ref.error);
    const requestLabels = parsed.value.items.map((item) =>
        item.ok ? traceWorkspacePath(ref.ref.token, item.path) : item.label
    );
    const paragraphs: string[] = [];
    const modelImages: ToolModelImage[] = [];
    const failures: string[] = [];

    for (const item of parsed.value.items) {
        if (!item.ok) {
            failures.push(workspaceBatchFailureLine(item.label, item.error));
            continue;
        }
        const rendered = await renderDraft(ctx, limits, ref.ref, item.path, parsed.value.theme);
        if (!rendered.ok) {
            failures.push(workspaceBatchFailureLine(traceWorkspacePath(ref.ref.token, item.path), rendered.error));
            continue;
        }
        paragraphs.push(rendered.content);
        modelImages.push(rendered.modelImage);
    }

    logWorkspaceBatchFailures('workspace:preview', failures);
    const lines: string[] = [];
    if (paragraphs.length > 0) {
        lines.push(`已渲染 ${paragraphs.length} 张预览：`);
        lines.push(paragraphs.join('\n\n'));
    }
    if (failures.length > 0) {
        lines.push(paragraphs.length > 0 ? `有 ${failures.length} 个没渲染成：` : `这 ${parsed.value.items.length} 个草稿都没渲染成：`);
        for (const failure of failures) lines.push(`- ${failure}`);
    }
    const trace = actionTrace('preview', {
        argument: workspaceBatchTraceArgument('个草稿', requestLabels),
        result:
            paragraphs.length === 0
                ? '全部失败'
                : traceParts(`${paragraphs.length} 张`, failures.length > 0 ? `${failures.length} 个失败` : null),
    });
    return paragraphs.length === 0
        ? workspaceToolError(lines.join('\n'), trace)
        : workspaceToolSuccess(lines.join('\n'), modelImages, trace);
};

export const executeWorkspacePreview = async (
    rawArgs: Readonly<Record<string, unknown>>,
    ctx: WorkspaceActionContext
): Promise<ToolResult> => {
    if (!ctx.previewEnabled) {
        return reject('preview', '当前未开启工作区预览（需要支持看图的模型且开启渲染服务）。');
    }
    const limits = ctx.previewLimits;
    if (limits === null) {
        return reject('preview', '工作区预览未配置 widget 大小限制。');
    }
    const singleGiven = typeof rawArgs.path === 'string' && rawArgs.path.trim() !== '';
    if (Array.isArray(rawArgs.paths) && (rawArgs.paths.length > 0 || !singleGiven)) {
        return executePreviewBatch(rawArgs, ctx, limits);
    }
    const parsed = parseWorkspacePreviewArgs(rawArgs);
    if (!parsed.ok) return reject('preview', parsed.error);
    const ref = resolveWorkspaceRef(ctx.state, rawArgs.workspace);
    if (!ref.ok) return reject('preview', ref.error);

    const rendered = await renderDraft(ctx, limits, ref.ref, parsed.value.path, parsed.value.theme);
    if (!rendered.ok) return reject('preview', rendered.error);
    return workspaceToolSuccess(
        rendered.content,
        [rendered.modelImage],
        actionTrace('preview', {
            argument: traceParts(
                traceWorkspacePath(ref.ref.token, parsed.value.path),
                parsed.value.theme === 'dark' ? 'dark' : null
            ),
            result: `${rendered.width}×${rendered.height} PNG · ${rendered.precheckOk ? '预检通过' : '预检不通过'}`,
        })
    );
};
