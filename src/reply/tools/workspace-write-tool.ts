/**
 * workspace_write: put text into the conversation's model workspace.
 *
 * The workspace is a draft area, not a delivery channel: a file written here
 * survives later replies of the same conversation and can be read back, edited,
 * previewed and finally sent with `send_file` / `send_widget`.
 *
 * One call may carry several files (`files`), which is the everyday way to lay
 * out a template: each item keeps its own append/overwrite/workspace and its
 * own outcome, and the items are written in list order, so a file listed twice
 * ends with the last item's content.
 */
import type { ToolHandler, ToolResult } from '../../ai/tools/tool-types.js';
import type { WidgetBudgetLimits } from '../../ai/widget/widget-size.js';
import { formatBytes } from '../../shared/file-name.js';
import { writeWorkspaceFile, type WorkspaceWriteOk } from '../../services/workspace-service.js';
import { resolveWorkspaceRef, type WorkspaceRef, type WorkspaceState } from '../workspace/workspace-state.js';
import { widgetDraftSizeLineOf } from '../workspace/workspace-widget-size.js';
import {
    parseWorkspaceWriteArgs,
    parseWorkspaceWriteBatchArgs,
    WRITE_BATCH_CONTENT_CHARS_MAX,
    WRITE_BATCH_MAX,
} from './workspace-tool-args.js';
import {
    logWorkspaceBatchFailures,
    workspaceBatchFailureLine,
    workspaceBatchTraceArgument,
    workspaceToolError,
    workspaceToolSuccess,
} from './workspace-tool-result.js';
import { WORKSPACE_WRITE_TOOL_NAME } from './tool-names.js';
import { traceBytes, traceParts, traceWorkspacePath } from './tool-trace.js';

const DESCRIPTION =
    '把文本写进本会话的模型工作区（按会话保留，7 天未使用自动清理）。' +
    '需要分多次写、跨轮次继续改、或之后要预览/发给聊天的草稿，都应该先写进工作区。' +
    '默认新建；文件已存在时需 overwrite=true 整体替换，append=true 追加。' +
    'workspace 省略=当前会话；w2… 是本次上下文里拼接进来的其他会话。' +
    '写 .html 草稿时会报 widget 的原文与 zlib9 压缩后体积（以及离上限还差多少），不用靠预览量体积。' +
    `一次写多个文件用 files（每项 {path, content, append?, overwrite?, workspace?}，最多 ${WRITE_BATCH_MAX} 个、` +
    `合计最多 ${WRITE_BATCH_CONTENT_CHARS_MAX} 字符），与 path/content 二选一，按列表顺序写。`;

const INPUT_SCHEMA = {
    type: 'object',
    properties: {
        path: {
            type: 'string',
            description: '工作区里的相对路径，如 notes/plan.md、widgets/card.html；最多 3 层目录。',
        },
        content: { type: 'string', description: '要写入的 UTF-8 文本。' },
        append: { type: 'boolean', description: 'true=追加到文件末尾；省略或 false=新建/覆盖。' },
        overwrite: { type: 'boolean', description: '文件已存在时整体替换；省略或 false=拒绝覆盖。' },
        workspace: {
            type: 'string',
            description: '要操作哪个会话的工作区：省略=当前会话（w1）；w2、w3… 见运行时工作区清单。',
        },
        files: {
            type: 'array',
            minItems: 1,
            maxItems: WRITE_BATCH_MAX,
            description:
                `一次写多个文件：每项一个文件，最多 ${WRITE_BATCH_MAX} 项、合计最多 ${WRITE_BATCH_CONTENT_CHARS_MAX} 字符；` +
                '与 path/content 二选一。',
            items: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: '工作区里的相对路径。' },
                    content: { type: 'string', description: '要写入的 UTF-8 文本。' },
                    append: { type: 'boolean', description: 'true=追加到文件末尾。' },
                    overwrite: { type: 'boolean', description: '文件已存在时整体替换。' },
                    workspace: {
                        type: 'string',
                        description: '这个文件写进哪个工作区：省略=当前会话（w1）。',
                    },
                },
                required: ['path', 'content'],
            },
        },
    },
    // Either path+content or files; the parser states which fields belong together
    required: [],
};

const REJECTION_LOG_MAX_CHARS = 200;

const reject = (message: string): ToolResult => {
    console.warn(`[workspace_write] rejected: ${Array.from(message).slice(0, REJECTION_LOG_MAX_CHARS).join('')}`);
    return workspaceToolError(message);
};

export interface WorkspaceWriteToolOptions {
    readonly state: WorkspaceState;
    /** Widget limits of this turn; null/absent = no widget tools, so no draft size line */
    readonly widgetLimits?: WidgetBudgetLimits | null;
}

/** `新建` / `覆盖` / `追加`: what this item did to the file */
const writeModeOf = (created: boolean, append: boolean): string => (created ? '新建' : append ? '追加' : '覆盖');

interface WriteBatchSuccess {
    readonly ref: WorkspaceRef;
    readonly result: WorkspaceWriteOk;
    readonly append: boolean;
}

export const createWorkspaceWriteTool = (options: WorkspaceWriteToolOptions): ToolHandler => {
    const { state } = options;

    const draftLineOf = (result: WorkspaceWriteOk): string =>
        widgetDraftSizeLineOf(result.path, result.content, options.widgetLimits);

    const successLineOf = (success: WriteBatchSuccess): string => {
        const label = traceWorkspacePath(success.ref.token, success.result.path);
        const line = `- 《${label}》（${formatBytes(success.result.sizeBytes)}，${writeModeOf(
            success.result.created,
            success.append
        )}）`;
        const draftLine = draftLineOf(success.result);
        return draftLine === '' ? line : `${line}\n  ${draftLine}`;
    };

    /** One usage line per workspace the batch wrote to, each at its final size */
    const usageLinesOf = (successes: readonly WriteBatchSuccess[]): string[] => {
        const byToken = new Map<string, WriteBatchSuccess>();
        for (const success of successes) byToken.set(success.ref.token, success);
        return [...byToken.values()].map(
            ({ ref, result }) =>
                `工作区（${ref.label} ${ref.token}）：${result.fileCount} 个文件，已用 ` +
                `${formatBytes(result.totalBytes)} / ${formatBytes(state.quota.maxConversationBytes)}。`
        );
    };

    const executeBatch = async (rawArgs: Readonly<Record<string, unknown>>): Promise<ToolResult> => {
        const parsed = parseWorkspaceWriteBatchArgs(rawArgs);
        if (!parsed.ok) return reject(parsed.error);
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

        logWorkspaceBatchFailures(WORKSPACE_WRITE_TOOL_NAME, failures);
        const lines: string[] = [];
        if (successes.length > 0) {
            lines.push(`已写入 ${successes.length} 个文件：`);
            for (const success of successes) lines.push(successLineOf(success));
            lines.push(...usageLinesOf(successes));
        }
        if (failures.length > 0) {
            lines.push(
                successes.length > 0
                    ? `有 ${failures.length} 个没写成：`
                    : `这 ${items.length} 个文件都没写成：`
            );
            for (const failure of failures) lines.push(`- ${failure}`);
        }

        const writtenBytes = successes.reduce((total, success) => total + success.result.sizeBytes, 0);
        const trace = {
            argument: workspaceBatchTraceArgument('个文件', traceLabels),
            result:
                successes.length === 0
                    ? '全部失败'
                    : traceParts(
                          `${successes.length} 个文件`,
                          traceBytes(writtenBytes),
                          failures.length > 0 ? `${failures.length} 个失败` : null
                      ),
        };
        return successes.length === 0
            ? workspaceToolError(lines.join('\n'), trace)
            : workspaceToolSuccess(lines.join('\n'), undefined, trace);
    };

    return {
        definition: {
            name: WORKSPACE_WRITE_TOOL_NAME,
            description: DESCRIPTION,
            inputSchema: INPUT_SCHEMA,
        },
        statusText: '📝 正在写工作区文件…',
        execute: async (rawArgs) => {
            const singleGiven = typeof rawArgs.path === 'string' && rawArgs.path.trim() !== '';
            const files = rawArgs.files;
            if (Array.isArray(files) && (files.length > 0 || !singleGiven)) return executeBatch(rawArgs);

            const parsed = parseWorkspaceWriteArgs(rawArgs);
            if (!parsed.ok) return reject(parsed.error);
            const ref = resolveWorkspaceRef(state, rawArgs.workspace);
            if (!ref.ok) return reject(ref.error);

            const result = await writeWorkspaceFile({
                chatId: state.chatId,
                conversationRootId: ref.ref.rootId,
                path: parsed.value.path,
                content: parsed.value.content,
                append: parsed.value.append,
                overwrite: parsed.value.overwrite,
                quota: state.quota,
            });
            if (!result.ok) return reject(result.error);

            const label = `${ref.ref.label} ${ref.ref.token}`;
            const usage =
                `工作区 ${result.fileCount} 个文件，已用 ${formatBytes(result.totalBytes)} / ` +
                `${formatBytes(state.quota.maxConversationBytes)}`;
            const size = formatBytes(result.sizeBytes);
            // Four outcomes, four honest sentences: a model that appended must not
            // read "已覆盖", and an overwrite must say what it replaced.
            const content = result.created
                ? parsed.value.append
                    ? `已新建并写入《${result.path}》（${label}）：${size}（${usage}）。`
                    : `已写入《${result.path}》（${label}）：${size}（${usage}）。`
                : parsed.value.append
                  ? `已追加到《${result.path}》（${label}）：现在 ${size}（${usage}）。`
                  : `已覆盖《${result.path}》（${label}）：原 ${formatBytes(result.replacedBytes ?? 0)} → ${size}（${usage}）。`;
            const draftLine = draftLineOf(result);
            const mode = parsed.value.append ? '（追加）' : parsed.value.overwrite ? '（覆盖）' : '';
            return workspaceToolSuccess(
                draftLine === '' ? content : `${content}\n${draftLine}`,
                undefined,
                {
                    argument: `${traceWorkspacePath(ref.ref.token, result.path)}${mode}`,
                    result: `${traceBytes(result.sizeBytes)}${result.created ? '（新建）' : ''}`,
                }
            );
        },
    };
};
