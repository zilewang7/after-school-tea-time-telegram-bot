/**
 * workspace_list: what is in the workspace right now.
 *
 * The manifest already shows the newest files of the current conversation; this
 * tool is the complete answer (paging, prefixes, other spliced conversations).
 * It never refreshes the retention clock — only reads/edits/previews count as
 * "using" a file.
 */
import type { ToolHandler, ToolResult } from '../../ai/tools/tool-types.js';
import type { WidgetBudgetLimits } from '../../ai/widget/widget-size.js';
import { formatBytes } from '../../shared/file-name.js';
import {
    formatWorkspaceTime,
    listWorkspaceFiles,
    loadWorkspaceContents,
} from '../../services/workspace-service.js';
import { resolveWorkspaceRef, type WorkspaceState } from '../workspace/workspace-state.js';
import { isWidgetDraftPath, widgetDraftListDetailOf } from '../workspace/workspace-widget-size.js';
import { parseWorkspaceListArgs } from './workspace-tool-args.js';
import { workspaceToolError, workspaceToolSuccess } from './workspace-tool-result.js';
import { WORKSPACE_LIST_TOOL_NAME } from './tool-names.js';

const DESCRIPTION =
    '列出工作区里的文件（路径、大小、最近修改时间、首行摘要），按最近修改排序；' +
    'prefix 可以只看某个目录。HTML 草稿还会给出 zlib9 压缩后体积和离 widget 上限的差距。' +
    '不刷新文件的保留期。';

const INPUT_SCHEMA = {
    type: 'object',
    properties: {
        prefix: { type: 'string', description: '只看某个目录，如 widgets/；省略=整个工作区。' },
        workspace: {
            type: 'string',
            description: '要操作哪个会话的工作区：省略=当前会话（w1）；w2、w3… 见运行时工作区清单。',
        },
    },
    required: [],
};

const REJECTION_LOG_MAX_CHARS = 200;

const reject = (message: string): ToolResult => {
    console.warn(`[workspace_list] rejected: ${Array.from(message).slice(0, REJECTION_LOG_MAX_CHARS).join('')}`);
    return workspaceToolError(message);
};

export interface WorkspaceListToolOptions {
    readonly state: WorkspaceState;
    /** Widget limits of this turn; null/absent = no widget tools, so HTML drafts list plain sizes */
    readonly widgetLimits?: WidgetBudgetLimits | null;
}

export const createWorkspaceListTool = (options: WorkspaceListToolOptions): ToolHandler => {
    const { state } = options;
    const widgetLimits = options.widgetLimits ?? null;

    return {
        definition: {
            name: WORKSPACE_LIST_TOOL_NAME,
            description: DESCRIPTION,
            inputSchema: INPUT_SCHEMA,
        },
        statusText: '📂 正在列工作区…',
        execute: async (rawArgs) => {
            const parsed = parseWorkspaceListArgs(rawArgs);
            if (!parsed.ok) return reject(parsed.error);
            const ref = resolveWorkspaceRef(state, rawArgs.workspace);
            if (!ref.ok) return reject(ref.error);

            const snapshot = await listWorkspaceFiles(state.chatId, ref.ref.rootId, parsed.value.prefix);
            const label = `${ref.ref.label} ${ref.ref.token}`;
            // Only HTML drafts that can still be a widget get measured: a file
            // over the raw cap cannot fit anyway, and measuring it would read a
            // megabyte to report a number that cannot change the verdict.
            const draftPaths =
                widgetLimits === null
                    ? []
                    : snapshot.files
                          .filter(
                              (file) =>
                                  isWidgetDraftPath(file.path) &&
                                  file.sizeBytes <= widgetLimits.maxHtmlBytes
                          )
                          .map((file) => file.path);
            const draftContents =
                widgetLimits === null
                    ? new Map<string, string>()
                    : await loadWorkspaceContents(state.chatId, ref.ref.rootId, draftPaths);
            const hasDraft = snapshot.files.some((file) => isWidgetDraftPath(file.path));
            const widgetHint =
                widgetLimits === null || !hasDraft
                    ? ''
                    : `\nHTML 草稿按 widget 计：原文 ≤ ${widgetLimits.maxHtmlBytes} B、` +
                      `zlib9 ≤ ${widgetLimits.maxGzipBytes} B。`;
            const header =
                `工作区（${label}）共 ${snapshot.usage.fileCount} 个文件，已用 ` +
                `${formatBytes(snapshot.usage.totalBytes)} / ${formatBytes(state.quota.maxConversationBytes)}` +
                (parsed.value.prefix === '' ? '。' : `；${parsed.value.prefix} 下 ${snapshot.files.length} 个。`) +
                widgetHint;

            if (snapshot.files.length === 0) {
                return workspaceToolSuccess(
                    `${header}\n${parsed.value.prefix === '' ? '工作区是空的。用 workspace_write 创建草稿。' : '这个目录下没有文件。'}`
                );
            }

            const lines = snapshot.files.map((file) => {
                const summary = file.summary === '' ? '' : ` — ${file.summary}`;
                const detail =
                    widgetLimits !== null && isWidgetDraftPath(file.path)
                        ? widgetDraftListDetailOf(
                              file.sizeBytes,
                              draftContents.get(file.path),
                              widgetLimits
                          )
                        : formatBytes(file.sizeBytes);
                return `- ${file.path}（${detail}，${formatWorkspaceTime(file.updatedAt)}）${summary}`;
            });
            return workspaceToolSuccess(`${header}\n${lines.join('\n')}`);
        },
    };
};
