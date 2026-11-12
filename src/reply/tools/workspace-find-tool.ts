/**
 * workspace_find: literal content search across the workspace.
 *
 * A later reply knows a draft exists but not where the line to change is; a
 * keyword search returns `path:line| text` so the model reads (or edits) only
 * the relevant part instead of paging the whole file. The scan is one query
 * over the conversation's rows (≤10 MB), line by line.
 */
import type { ToolHandler, ToolResult } from '../../ai/tools/tool-types.js';
import { findWorkspaceFiles } from '../../services/workspace-service.js';
import { consumeWorkspaceCall, resolveWorkspaceRef, type WorkspaceState } from '../workspace/workspace-state.js';
import { parseWorkspaceFindArgs } from './workspace-tool-args.js';
import { workspaceToolError, workspaceToolSuccess } from './workspace-tool-result.js';
import { WORKSPACE_FIND_TOOL_NAME } from './tool-names.js';

const DESCRIPTION =
    '在工作区里按字面量搜索文件内容，返回 路径:行号 和那一行。默认搜整个会话；' +
    '可以用 path 只搜一个文件、prefix 只搜一个目录（如 widgets/），两者只能给一个。默认不区分大小写。' +
    '找到后可以用 workspace_read 的 offset 读那一段，或直接用 workspace_edit 修改。';

const INPUT_SCHEMA = {
    type: 'object',
    properties: {
        query: { type: 'string', description: '要搜的字面量子串，最多 200 字符；不做正则。' },
        path: { type: 'string', description: '只搜这个文件（工作区相对路径）。' },
        prefix: { type: 'string', description: '只搜这个目录，如 widgets/；与 path 二选一。' },
        case_sensitive: { type: 'boolean', description: 'true=区分大小写；省略或 false=不区分。' },
        workspace: {
            type: 'string',
            description: '要操作哪个会话的工作区：省略=当前会话（w1）；w2、w3… 见运行时工作区清单。',
        },
    },
    required: ['query'],
};

/** Caps of one find call: hits, rendered characters, and one line */
const MAX_FIND_HITS = 50;
const MAX_FIND_CHARS = 8000;
const MAX_FIND_LINE_CHARS = 200;

const REJECTION_LOG_MAX_CHARS = 200;

const reject = (message: string): ToolResult => {
    console.warn(`[workspace_find] rejected: ${Array.from(message).slice(0, REJECTION_LOG_MAX_CHARS).join('')}`);
    return workspaceToolError(message);
};

export interface WorkspaceFindToolOptions {
    readonly state: WorkspaceState;
}

export const createWorkspaceFindTool = (options: WorkspaceFindToolOptions): ToolHandler => {
    const { state } = options;

    return {
        definition: {
            name: WORKSPACE_FIND_TOOL_NAME,
            description: DESCRIPTION,
            inputSchema: INPUT_SCHEMA,
        },
        statusText: '🔍 正在搜索工作区…',
        execute: async (rawArgs) => {
            const parsed = parseWorkspaceFindArgs(rawArgs);
            if (!parsed.ok) return reject(parsed.error);
            const ref = resolveWorkspaceRef(state, rawArgs.workspace);
            if (!ref.ok) return reject(ref.error);
            const overLimit = consumeWorkspaceCall(state, 'read');
            if (overLimit !== null) return reject(overLimit);

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
            if (parsed.value.path !== null && result.scannedFiles === 0) {
                return reject(`工作区（${label}）里没有《${parsed.value.path}》；用 workspace_list 看看现有文件。`);
            }
            if (result.scannedFiles === 0) {
                const where = parsed.value.prefix === '' ? '' : `（${parsed.value.prefix} 下）`;
                return workspaceToolSuccess(
                    `工作区（${label}）里没有可搜索的文件${where}；先用 workspace_write 创建草稿。`
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
                        '可以用 workspace_list 看路径，或换个词/加 prefix。'
                );
            }
            const lines = result.hits.map((hit) => `${hit.path}:${hit.lineNumber}| ${hit.line}`);
            const hidden = result.totalHits - result.hits.length;
            const tail = result.truncated && hidden > 0 ? `\n… 还有 ${hidden} 处未显示，缩小 query 或加 path/prefix。` : '';
            return workspaceToolSuccess(
                `在${scope}（${label}）里找到 ${result.totalHits} 处「${parsed.value.query}」（扫描 ${result.scannedFiles} 个文件）：\n` +
                    lines.join('\n') +
                    tail
            );
        },
    };
};
