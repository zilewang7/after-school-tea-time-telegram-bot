/**
 * workspace_copy: duplicate one workspace file to a new path.
 *
 * The model's way to keep a known-good version before a risky edit: copying
 * bytes costs no output tokens and cannot overwrite the target (the MCP
 * filesystem convention), so a retry is visible instead of silently replacing.
 */
import type { ToolHandler, ToolResult } from '../../ai/tools/tool-types.js';
import { formatBytes } from '../../shared/file-name.js';
import { copyWorkspaceFile } from '../../services/workspace-service.js';
import { resolveWorkspaceRef, type WorkspaceState } from '../workspace/workspace-state.js';
import { parseWorkspaceCopyArgs } from './workspace-tool-args.js';
import { workspaceToolError, workspaceToolSuccess } from './workspace-tool-result.js';
import { WORKSPACE_COPY_TOOL_NAME } from './tool-names.js';

const DESCRIPTION =
    '把工作区里的一个文件复制成新路径，用来「先留一版再改」；目标已存在会失败，绝不覆盖。' +
    '复制的是文件内容、摘要与类型，新文件的类型按新路径的扩展名决定。';

const INPUT_SCHEMA = {
    type: 'object',
    properties: {
        path: { type: 'string', description: '要复制的源文件（工作区相对路径）。' },
        new_path: { type: 'string', description: '复制到的新路径，如 widgets/card-v1.html；不能已存在。' },
        workspace: {
            type: 'string',
            description: '要操作哪个会话的工作区：省略=当前会话（w1）；w2、w3… 见运行时工作区清单。',
        },
    },
    required: ['path', 'new_path'],
};

const REJECTION_LOG_MAX_CHARS = 200;

const reject = (message: string): ToolResult => {
    console.warn(`[workspace_copy] rejected: ${Array.from(message).slice(0, REJECTION_LOG_MAX_CHARS).join('')}`);
    return workspaceToolError(message);
};

export interface WorkspaceCopyToolOptions {
    readonly state: WorkspaceState;
}

export const createWorkspaceCopyTool = (options: WorkspaceCopyToolOptions): ToolHandler => {
    const { state } = options;

    return {
        definition: {
            name: WORKSPACE_COPY_TOOL_NAME,
            description: DESCRIPTION,
            inputSchema: INPUT_SCHEMA,
        },
        statusText: '📋 正在复制工作区文件…',
        execute: async (rawArgs) => {
            const parsed = parseWorkspaceCopyArgs(rawArgs);
            if (!parsed.ok) return reject(parsed.error);
            const ref = resolveWorkspaceRef(state, rawArgs.workspace);
            if (!ref.ok) return reject(ref.error);

            const result = await copyWorkspaceFile(state.chatId, ref.ref.rootId, {
                from: parsed.value.from,
                to: parsed.value.to,
                quota: state.quota,
            });
            if (!result.ok) return reject(result.error);

            const label = `${ref.ref.label} ${ref.ref.token}`;
            const usage =
                `工作区 ${result.fileCount} 个文件，已用 ${formatBytes(result.totalBytes)} / ` +
                `${formatBytes(state.quota.maxConversationBytes)}`;
            return workspaceToolSuccess(
                `已复制《${result.from}》→《${result.to}》（${label}）：${formatBytes(result.sizeBytes)}（${usage}）。`
            );
        },
    };
};
