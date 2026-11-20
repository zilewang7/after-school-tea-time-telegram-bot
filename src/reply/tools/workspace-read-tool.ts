/**
 * workspace_read: read a workspace file back, with line numbers and paging.
 *
 * The model wrote the file itself, but the bytes are gone from its context
 * after the reply; this is how it looks at the draft again (and the only way to
 * get an exact `old_string` for `workspace_edit`).
 *
 * One call may read several files (`paths`). They share this call's character
 * budget and the same offset/limit/workspace: the files are filled in request
 * order, and a file that no longer fits is reported as unread instead of
 * dropping the ones after it.
 */
import type { ToolHandler, ToolResult } from '../../ai/tools/tool-types.js';
import { formatBytes } from '../../shared/file-name.js';
import { readWorkspaceFile, touchWorkspaceFile } from '../../services/workspace-service.js';
import { resolveWorkspaceRef, type WorkspaceState } from '../workspace/workspace-state.js';
import {
    parseWorkspaceReadArgs,
    parseWorkspaceReadBatchArgs,
    READ_BATCH_MAX,
} from './workspace-tool-args.js';
import {
    logWorkspaceBatchFailures,
    workspaceBatchFailureLine,
    workspaceBatchTraceArgument,
    workspaceToolError,
    workspaceToolSuccess,
} from './workspace-tool-result.js';
import { WORKSPACE_READ_TOOL_NAME } from './tool-names.js';
import { traceParts, traceWorkspacePath } from './tool-trace.js';

const DESCRIPTION =
    '读取工作区里的文本文件，按行返回并带行号。默认读前 200 行；文件更长时用 offset/limit 分页，' +
    '返回体末尾会说明还剩多少行。单次最多返回约 24000 字符，超长行会被截断并标注。' +
    `一次读多个文件用 paths（最多 ${READ_BATCH_MAX} 个）；offset/limit/workspace 对每个文件都适用，` +
    '这些文件共享同一次 24000 字符预算。';

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
        paths: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: READ_BATCH_MAX,
            description: `一次读多个文件：最多 ${READ_BATCH_MAX} 个路径，与 path 二选一；共享同一次读取的字符预算。`,
        },
    },
    // Either path or paths; the parser states which fields belong together
    required: [],
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

const UNREAD_LINE = '未读：本次读取的 24000 字符预算已用完（可用 offset 继续）';

/** The header of one file's paragraph in a read result */
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

export interface WorkspaceReadToolOptions {
    readonly state: WorkspaceState;
}

export const createWorkspaceReadTool = (options: WorkspaceReadToolOptions): ToolHandler => {
    const { state } = options;

    const executeBatch = async (rawArgs: Readonly<Record<string, unknown>>): Promise<ToolResult> => {
        const parsed = parseWorkspaceReadBatchArgs(rawArgs);
        if (!parsed.ok) return reject(parsed.error);
        const ref = resolveWorkspaceRef(state, parsed.value.workspace);
        if (!ref.ok) return reject(ref.error);
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
                    `《${displayLabel}》：工作区里没有这个文件。用 workspace_list 看看现有文件，或先 workspace_write 创建。`
                );
                continue;
            }
            await touchWorkspaceFile(file.id).catch((error: unknown) => {
                console.warn('[workspace_read] lastUsedAt refresh failed:', error);
            });

            const lines = file.content.split('\n');
            const totalLines = lines.length;
            const start = parsed.value.offset - 1;
            if (parsed.value.offset > totalLines) {
                failures.push(`《${displayLabel}》：offset=${parsed.value.offset} 超过文件行数（共 ${totalLines} 行）。`);
                continue;
            }
            // Reserve the longest header this paragraph can have, so the budget
            // check comes before any character is spent on the file.
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

        logWorkspaceBatchFailures(WORKSPACE_READ_TOOL_NAME, failures);
        const notRead = [...failures, ...unread];
        const output: string[] = [];
        if (blocks.length > 0) {
            output.push(`已读取 ${blocks.length} 个文件：`);
            output.push(blocks.join('\n\n'));
        }
        if (notRead.length > 0) {
            output.push(
                blocks.length > 0
                    ? `有 ${notRead.length} 个没读成：`
                    : `这 ${parsed.value.items.length} 个文件都没读成：`
            );
            for (const line of notRead) output.push(`- ${line}`);
        }
        const trace = {
            argument: workspaceBatchTraceArgument('个文件', requestLabels),
            result: traceParts(
                `${blocks.length} 个文件`,
                failures.length > 0 ? `${failures.length} 个失败` : null,
                unread.length > 0 ? `${unread.length} 个未读` : null
            ),
        };
        return blocks.length === 0
            ? workspaceToolError(output.join('\n'), trace)
            : workspaceToolSuccess(output.join('\n'), undefined, trace);
    };

    return {
        definition: {
            name: WORKSPACE_READ_TOOL_NAME,
            description: DESCRIPTION,
            inputSchema: INPUT_SCHEMA,
        },
        statusText: '📖 正在读工作区文件…',
        execute: async (rawArgs) => {
            const singleGiven = typeof rawArgs.path === 'string' && rawArgs.path.trim() !== '';
            const paths = rawArgs.paths;
            if (Array.isArray(paths) && (paths.length > 0 || !singleGiven)) return executeBatch(rawArgs);

            const parsed = parseWorkspaceReadArgs(rawArgs);
            if (!parsed.ok) return reject(parsed.error);
            const ref = resolveWorkspaceRef(state, rawArgs.workspace);
            if (!ref.ok) return reject(ref.error);

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
                const display = displayLineOf(rawLine);
                const numbered = `${index + 1}| ${display}`;
                if (usedChars + numbered.length > MAX_READ_CHARS) break;
                shown.push(numbered);
                usedChars += numbered.length + 1;
            }

            const label = `${ref.ref.label} ${ref.ref.token}`;
            const header = readHeaderOf(
                file.path,
                label,
                start,
                start + shown.length,
                totalLines,
                file.sizeBytes
            );
            const remaining = totalLines - index;
            const tail = remaining > 0 ? `\n… 还有 ${remaining} 行，用 offset=${index + 1} 继续。` : '';
            return workspaceToolSuccess(`${header}\n${shown.join('\n')}${tail}`, undefined, {
                argument: `${traceWorkspacePath(ref.ref.token, file.path)} 第 ${start + 1}–${start + shown.length} 行`,
                result: `共 ${totalLines} 行`,
            });
        },
    };
};
