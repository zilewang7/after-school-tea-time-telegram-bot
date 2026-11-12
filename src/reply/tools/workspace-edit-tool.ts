/**
 * workspace_edit: exact-string replacement inside one workspace file.
 *
 * The everyday way to change a draft: it only sends the diff, so a long file
 * does not have to be reproduced. The match is exact (the line-number prefix
 * `workspace_read` prints is not part of the content) and all-or-nothing.
 */
import type { ToolHandler, ToolResult } from '../../ai/tools/tool-types.js';
import type { WidgetBudgetLimits } from '../../ai/widget/widget-size.js';
import { formatBytes } from '../../shared/file-name.js';
import { editWorkspaceFile } from '../../services/workspace-service.js';
import { consumeWorkspaceCall, resolveWorkspaceRef, type WorkspaceState } from '../workspace/workspace-state.js';
import { widgetDraftSizeLineOf } from '../workspace/workspace-widget-size.js';
import { parseWorkspaceEditArgs } from './workspace-tool-args.js';
import { workspaceToolError, workspaceToolSuccess } from './workspace-tool-result.js';
import { WORKSPACE_EDIT_TOOL_NAME } from './tool-names.js';

const DESCRIPTION =
    '把文件里的一段文本替换成新文本。old_string 必须在文件中唯一出现（要替换所有出现用 replace_all=true），' +
    '必须与原文完全一致（含缩进；workspace_read 返回的行号前缀不算内容）。' +
    '改大段内容或整体重写用 workspace_write(overwrite=true)。' +
    '改 .html 草稿时会报 widget 的原文与 zlib9 压缩后体积（以及离上限还差多少）。';

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
    },
    required: ['path', 'old_string', 'new_string'],
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

export const createWorkspaceEditTool = (options: WorkspaceEditToolOptions): ToolHandler => {
    const { state } = options;

    return {
        definition: {
            name: WORKSPACE_EDIT_TOOL_NAME,
            description: DESCRIPTION,
            inputSchema: INPUT_SCHEMA,
        },
        statusText: '✏️ 正在修改工作区文件…',
        execute: async (rawArgs) => {
            const parsed = parseWorkspaceEditArgs(rawArgs);
            if (!parsed.ok) return reject(parsed.error);
            const ref = resolveWorkspaceRef(state, rawArgs.workspace);
            if (!ref.ok) return reject(ref.error);
            const overLimit = consumeWorkspaceCall(state, 'write');
            if (overLimit !== null) return reject(overLimit);

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
            const draftLine = widgetDraftSizeLineOf(result.path, result.content, options.widgetLimits);
            return workspaceToolSuccess(draftLine === '' ? content : `${content}\n${draftLine}`);
        },
    };
};
