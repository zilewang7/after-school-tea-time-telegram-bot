/**
 * workspace_edit: exact-string replacement inside one workspace file.
 *
 * The everyday way to change a draft: it only sends the diff, so a long file
 * does not have to be reproduced. The match is exact (the line-number prefix
 * `workspace_read` prints is not part of the content) and all-or-nothing.
 *
 * One call may carry several edits (`edits`). They run in list order on the
 * state the previous one left, so two edits of the same file compose; an edit
 * that no longer matches fails alone, the rest still run.
 */
import type { ToolHandler, ToolResult } from '../../ai/tools/tool-types.js';
import type { WidgetBudgetLimits } from '../../ai/widget/widget-size.js';
import { formatBytes } from '../../shared/file-name.js';
import {
    editWorkspaceFile,
    workspaceUsageOf,
    type WorkspaceEditOk,
} from '../../services/workspace-service.js';
import { resolveWorkspaceRef, type WorkspaceRef, type WorkspaceState } from '../workspace/workspace-state.js';
import { widgetDraftSizeLineOf } from '../workspace/workspace-widget-size.js';
import {
    EDIT_BATCH_MAX,
    parseWorkspaceEditArgs,
    parseWorkspaceEditBatchArgs,
} from './workspace-tool-args.js';
import {
    logWorkspaceBatchFailures,
    workspaceBatchFailureLine,
    workspaceBatchTraceArgument,
    workspaceToolError,
    workspaceToolSuccess,
} from './workspace-tool-result.js';
import { WORKSPACE_EDIT_TOOL_NAME } from './tool-names.js';
import { traceBytes, traceParts, traceWorkspacePath } from './tool-trace.js';

const DESCRIPTION =
    '把文件里的一段文本替换成新文本。old_string 必须在文件中唯一出现（要替换所有出现用 replace_all=true），' +
    '必须与原文完全一致（含缩进；workspace_read 返回的行号前缀不算内容）。' +
    '改大段内容或整体重写用 workspace_write(overwrite=true)。' +
    '改 .html 草稿时会报 widget 的原文与 zlib9 压缩后体积（以及离上限还差多少）。' +
    `一次改多处用 edits（每项 {path, old_string, new_string, replace_all?, workspace?}，最多 ${EDIT_BATCH_MAX} 项），` +
    '按列表顺序执行：同一文件的后一项基于前一项改完的内容。';

const INPUT_SCHEMA = {
    type: 'object',
    properties: {
        path: { type: 'string', description: '工作区里的相对路径。' },
        old_string: { type: 'string', description: '要替换的原文，必须与文件内容完全一致。' },
        new_string: { type: 'string', description: '替换后的文本。' },
        replace_all: { type: 'boolean', description: 'true=替换所有出现；省略或 false=要求唯一匹配。' },
        workspace: {
            type: 'string',
            description: '要操作哪个会话的工作区：省略=当前会话（w1）；w2、w3… 见运行时工作区清单。',
        },
        edits: {
            type: 'array',
            minItems: 1,
            maxItems: EDIT_BATCH_MAX,
            description:
                `一次改多处：每项一处替换，最多 ${EDIT_BATCH_MAX} 项，与 path/old_string/new_string 二选一；` +
                '严格按列表顺序执行。',
            items: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: '工作区里的相对路径。' },
                    old_string: { type: 'string', description: '要替换的原文。' },
                    new_string: { type: 'string', description: '替换后的文本。' },
                    replace_all: { type: 'boolean', description: 'true=替换所有出现。' },
                    workspace: {
                        type: 'string',
                        description: '这个文件属于哪个工作区：省略=当前会话（w1）。',
                    },
                },
                required: ['path', 'old_string', 'new_string'],
            },
        },
    },
    // Either the three single-file fields or edits; the parser states which belong together
    required: [],
};

const REJECTION_LOG_MAX_CHARS = 200;

const reject = (message: string): ToolResult => {
    console.warn(`[workspace_edit] rejected: ${Array.from(message).slice(0, REJECTION_LOG_MAX_CHARS).join('')}`);
    return workspaceToolError(message);
};

export interface WorkspaceEditToolOptions {
    readonly state: WorkspaceState;
    /** Widget limits of this turn; null/absent = no widget tools, so no draft size line */
    readonly widgetLimits?: WidgetBudgetLimits | null;
}

interface EditBatchSuccess {
    readonly ref: WorkspaceRef;
    readonly result: WorkspaceEditOk;
}

export const createWorkspaceEditTool = (options: WorkspaceEditToolOptions): ToolHandler => {
    const { state } = options;

    const draftLineOf = (result: WorkspaceEditOk): string =>
        widgetDraftSizeLineOf(result.path, result.content, options.widgetLimits);

    /** One usage line per workspace the batch touched; an edit may add or remove bytes */
    const usageLinesOf = async (successes: readonly EditBatchSuccess[]): Promise<string[]> => {
        const byToken = new Map<string, WorkspaceRef>();
        for (const success of successes) byToken.set(success.ref.token, success.ref);
        const lines: string[] = [];
        for (const ref of byToken.values()) {
            const usage = await workspaceUsageOf(state.chatId, ref.rootId);
            lines.push(
                `工作区（${ref.label} ${ref.token}）：${usage.fileCount} 个文件，已用 ` +
                    `${formatBytes(usage.totalBytes)} / ${formatBytes(state.quota.maxConversationBytes)}。`
            );
        }
        return lines;
    };

    const executeBatch = async (rawArgs: Readonly<Record<string, unknown>>): Promise<ToolResult> => {
        const parsed = parseWorkspaceEditBatchArgs(rawArgs);
        if (!parsed.ok) return reject(parsed.error);
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

        logWorkspaceBatchFailures(WORKSPACE_EDIT_TOOL_NAME, failures);
        const lines: string[] = [];
        if (successes.length > 0) {
            lines.push(`已修改 ${successes.length} 处：`);
            for (const success of successes) {
                const label = traceWorkspacePath(success.ref.token, success.result.path);
                const line = `- 《${label}》：替换 ${success.result.replacements} 处，现在 ${formatBytes(
                    success.result.sizeBytes
                )}。`;
                const draftLine = draftLineOf(success.result);
                lines.push(draftLine === '' ? line : `${line}\n  ${draftLine}`);
            }
            lines.push(...(await usageLinesOf(successes)));
        }
        if (failures.length > 0) {
            lines.push(
                successes.length > 0
                    ? `有 ${failures.length} 处没改成：`
                    : `这 ${items.length} 处都没改成：`
            );
            for (const failure of failures) lines.push(`- ${failure}`);
        }

        const replacements = successes.reduce((total, success) => total + success.result.replacements, 0);
        const trace = {
            argument: workspaceBatchTraceArgument('处修改', traceLabels),
            result:
                successes.length === 0
                    ? '全部失败'
                    : traceParts(
                          `替换 ${replacements} 处`,
                          failures.length > 0 ? `${failures.length} 处失败` : null
                      ),
        };
        return successes.length === 0
            ? workspaceToolError(lines.join('\n'), trace)
            : workspaceToolSuccess(lines.join('\n'), undefined, trace);
    };

    return {
        definition: {
            name: WORKSPACE_EDIT_TOOL_NAME,
            description: DESCRIPTION,
            inputSchema: INPUT_SCHEMA,
        },
        statusText: '✏️ 正在修改工作区文件…',
        execute: async (rawArgs) => {
            const singleGiven =
                typeof rawArgs.path === 'string' &&
                rawArgs.path.trim() !== '' &&
                typeof rawArgs.old_string === 'string';
            const edits = rawArgs.edits;
            if (Array.isArray(edits) && (edits.length > 0 || !singleGiven)) return executeBatch(rawArgs);

            const parsed = parseWorkspaceEditArgs(rawArgs);
            if (!parsed.ok) return reject(parsed.error);
            const ref = resolveWorkspaceRef(state, rawArgs.workspace);
            if (!ref.ok) return reject(ref.error);

            const result = await editWorkspaceFile({
                chatId: state.chatId,
                conversationRootId: ref.ref.rootId,
                path: parsed.value.path,
                oldString: parsed.value.oldString,
                newString: parsed.value.newString,
                replaceAll: parsed.value.replaceAll,
                quota: state.quota,
            });
            if (!result.ok) return reject(result.error);

            const label = `${ref.ref.label} ${ref.ref.token}`;
            const content = `已修改《${result.path}》（${label}）：替换 ${result.replacements} 处，现在 ${formatBytes(result.sizeBytes)}。`;
            const draftLine = draftLineOf(result);
            return workspaceToolSuccess(
                draftLine === '' ? content : `${content}\n${draftLine}`,
                undefined,
                {
                    argument: `${traceWorkspacePath(ref.ref.token, result.path)}${
                        parsed.value.replaceAll ? '（全部）' : ''
                    }`,
                    result: `替换 ${result.replacements} 处 · ${traceBytes(result.sizeBytes)}`,
                }
            );
        },
    };
};
