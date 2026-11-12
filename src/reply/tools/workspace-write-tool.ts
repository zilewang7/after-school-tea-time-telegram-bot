/**
 * workspace_write: put text into the conversation's model workspace.
 *
 * The workspace is a draft area, not a delivery channel: a file written here
 * survives later replies of the same conversation and can be read back, edited,
 * previewed and finally sent with `send_file` / `send_widget`.
 */
import type { ToolHandler, ToolResult } from '../../ai/tools/tool-types.js';
import type { WidgetBudgetLimits } from '../../ai/widget/widget-size.js';
import { formatBytes } from '../../shared/file-name.js';
import { writeWorkspaceFile } from '../../services/workspace-service.js';
import { resolveWorkspaceRef, type WorkspaceState } from '../workspace/workspace-state.js';
import { widgetDraftSizeLineOf } from '../workspace/workspace-widget-size.js';
import { parseWorkspaceWriteArgs } from './workspace-tool-args.js';
import { workspaceToolError, workspaceToolSuccess } from './workspace-tool-result.js';
import { WORKSPACE_WRITE_TOOL_NAME } from './tool-names.js';

const DESCRIPTION =
    '把文本写进本会话的模型工作区（按会话保留，7 天未使用自动清理）。' +
    '需要分多次写、跨轮次继续改、或之后要预览/发给聊天的草稿，都应该先写进工作区。' +
    '默认新建；文件已存在时需 overwrite=true 整体替换，append=true 追加。' +
    'workspace 省略=当前会话；w2… 是本次上下文里拼接进来的其他会话。' +
    '写 .html 草稿时会报 widget 的原文与 zlib9 压缩后体积（以及离上限还差多少），不用靠预览量体积。';

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
    },
    required: ['path', 'content'],
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

export const createWorkspaceWriteTool = (options: WorkspaceWriteToolOptions): ToolHandler => {
    const { state } = options;

    return {
        definition: {
            name: WORKSPACE_WRITE_TOOL_NAME,
            description: DESCRIPTION,
            inputSchema: INPUT_SCHEMA,
        },
        statusText: '📝 正在写工作区文件…',
        execute: async (rawArgs) => {
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
            const draftLine = widgetDraftSizeLineOf(result.path, result.content, options.widgetLimits);
            return workspaceToolSuccess(draftLine === '' ? content : `${content}\n${draftLine}`);
        },
    };
};
