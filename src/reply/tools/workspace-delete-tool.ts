/**
 * workspace_delete: free quota by removing one draft file.
 */
import type { ToolHandler, ToolResult } from '../../ai/tools/tool-types.js';
import { formatBytes } from '../../shared/file-name.js';
import { deleteWorkspaceFile } from '../../services/workspace-service.js';
import { consumeWorkspaceCall, resolveWorkspaceRef, type WorkspaceState } from '../workspace/workspace-state.js';
import { parseWorkspaceDeleteArgs } from './workspace-tool-args.js';
import { workspaceToolError, workspaceToolSuccess } from './workspace-tool-result.js';
import { WORKSPACE_DELETE_TOOL_NAME } from './tool-names.js';

const DESCRIPTION = '删除工作区里的一个文件，释放配额。删除后无法恢复。';

const INPUT_SCHEMA = {
    type: 'object',
    properties: {
        path: { type: 'string', description: '工作区里的相对路径。' },
        workspace: {
            type: 'string',
            description: '要操作哪个会话的工作区：省略=当前会话（w1）；w2、w3… 见运行时工作区清单。',
        },
    },
    required: ['path'],
};

const REJECTION_LOG_MAX_CHARS = 200;

const reject = (message: string): ToolResult => {
    console.warn(`[workspace_delete] rejected: ${Array.from(message).slice(0, REJECTION_LOG_MAX_CHARS).join('')}`);
    return workspaceToolError(message);
};

export interface WorkspaceDeleteToolOptions {
    readonly state: WorkspaceState;
}

export const createWorkspaceDeleteTool = (options: WorkspaceDeleteToolOptions): ToolHandler => {
    const { state } = options;

    return {
        definition: {
            name: WORKSPACE_DELETE_TOOL_NAME,
            description: DESCRIPTION,
            inputSchema: INPUT_SCHEMA,
        },
        statusText: '🗑️ 正在删除工作区文件…',
        execute: async (rawArgs) => {
            const parsed = parseWorkspaceDeleteArgs(rawArgs);
            if (!parsed.ok) return reject(parsed.error);
            const ref = resolveWorkspaceRef(state, rawArgs.workspace);
            if (!ref.ok) return reject(ref.error);
            const overLimit = consumeWorkspaceCall(state, 'delete');
            if (overLimit !== null) return reject(overLimit);

            const result = await deleteWorkspaceFile(state.chatId, ref.ref.rootId, parsed.value.path);
            if (!result.ok) return reject(result.error);

            const label = `${ref.ref.label} ${ref.ref.token}`;
            return workspaceToolSuccess(
                `已删除《${result.path}》（${label}）：释放 ${formatBytes(result.freedBytes)}；` +
                    `工作区 ${result.fileCount} 个文件，已用 ${formatBytes(result.totalBytes)}。`
            );
        },
    };
};
