/**
 * workspace_read: read a workspace file back, with line numbers and paging.
 *
 * The model wrote the file itself, but the bytes are gone from its context
 * after the reply; this is how it looks at the draft again (and the only way to
 * get an exact `old_string` for `workspace_edit`).
 */
import type { ToolHandler, ToolResult } from '../../ai/tools/tool-types.js';
import { formatBytes } from '../../shared/file-name.js';
import { readWorkspaceFile, touchWorkspaceFile } from '../../services/workspace-service.js';
import { consumeWorkspaceCall, resolveWorkspaceRef, type WorkspaceState } from '../workspace/workspace-state.js';
import { parseWorkspaceReadArgs } from './workspace-tool-args.js';
import { workspaceToolError, workspaceToolSuccess } from './workspace-tool-result.js';
import { WORKSPACE_READ_TOOL_NAME } from './tool-names.js';

const DESCRIPTION =
    '读取工作区里的文本文件，按行返回并带行号。默认读前 200 行；文件更长时用 offset/limit 分页，' +
    '返回体末尾会说明还剩多少行。单次最多返回约 24000 字符，超长行会被截断并标注。';

const INPUT_SCHEMA = {
    type: 'object',
    properties: {
        path: { type: 'string', description: '工作区里的相对路径。' },
        offset: { type: 'integer', minimum: 1, description: '起始行号（从 1 开始），默认 1。' },
        limit: { type: 'integer', minimum: 1, maximum: 800, description: '最多读多少行，默认 200，最大 800。' },
        workspace: {
            type: 'string',
            description: '要操作哪个会话的工作区：省略=当前会话（w1）；w2、w3… 见运行时工作区清单。',
        },
    },
    required: ['path'],
};

/** One call's whole text budget, matching the archive tools' per-call cap */
const MAX_READ_CHARS = 24_000;
/** A single line longer than this is cut and labelled, so one line cannot eat the budget */
const MAX_LINE_CHARS = 2_000;

const REJECTION_LOG_MAX_CHARS = 200;

const reject = (message: string): ToolResult => {
    console.warn(`[workspace_read] rejected: ${Array.from(message).slice(0, REJECTION_LOG_MAX_CHARS).join('')}`);
    return workspaceToolError(message);
};

export interface WorkspaceReadToolOptions {
    readonly state: WorkspaceState;
}

export const createWorkspaceReadTool = (options: WorkspaceReadToolOptions): ToolHandler => {
    const { state } = options;

    return {
        definition: {
            name: WORKSPACE_READ_TOOL_NAME,
            description: DESCRIPTION,
            inputSchema: INPUT_SCHEMA,
        },
        statusText: '📖 正在读工作区文件…',
        execute: async (rawArgs) => {
            const parsed = parseWorkspaceReadArgs(rawArgs);
            if (!parsed.ok) return reject(parsed.error);
            const ref = resolveWorkspaceRef(state, rawArgs.workspace);
            if (!ref.ok) return reject(ref.error);
            const overLimit = consumeWorkspaceCall(state, 'read');
            if (overLimit !== null) return reject(overLimit);

            const file = await readWorkspaceFile(state.chatId, ref.ref.rootId, parsed.value.path);
            if (file === null) {
                return reject(
                    `工作区里没有《${parsed.value.path}》。用 workspace_list 看看现有文件，或先 workspace_write 创建。`
                );
            }
            await touchWorkspaceFile(file.id).catch((error: unknown) => {
                console.warn('[workspace_read] lastUsedAt refresh failed:', error);
            });

            const lines = file.content.split('\n');
            const totalLines = lines.length;
            if (parsed.value.offset > totalLines) {
                return reject(`offset=${parsed.value.offset} 超过文件行数（共 ${totalLines} 行）。`);
            }

            const start = parsed.value.offset - 1;
            const shown: string[] = [];
            let usedChars = 0;
            let index = start;
            for (; index < totalLines && shown.length < parsed.value.limit; index += 1) {
                const rawLine = lines[index] ?? '';
                const chars = Array.from(rawLine);
                const display = chars.length > MAX_LINE_CHARS
                    ? `${chars.slice(0, MAX_LINE_CHARS).join('')}…（本行过长已截断）`
                    : rawLine;
                const numbered = `${index + 1}| ${display}`;
                if (usedChars + numbered.length > MAX_READ_CHARS) break;
                shown.push(numbered);
                usedChars += numbered.length + 1;
            }

            const label = `${ref.ref.label} ${ref.ref.token}`;
            const header =
                `《${file.path}》（${label}）：共 ${totalLines} 行 / ${formatBytes(file.sizeBytes)}；` +
                `显示第 ${start + 1}–${start + shown.length} 行。`;
            const remaining = totalLines - index;
            const tail = remaining > 0 ? `\n… 还有 ${remaining} 行，用 offset=${index + 1} 继续。` : '';
            return workspaceToolSuccess(`${header}\n${shown.join('\n')}${tail}`);
        },
    };
};
