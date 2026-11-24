/**
 * leave_handoff: write the note the next reply of this conversation reads.
 *
 * The note is a plain workspace file at a fixed path, always replaced as a
 * whole: after a stop or a resume the same call may run again, and an
 * overwrite stays idempotent. Long text is cut instead of refused: in the
 * Gemini hand-off round this is the only tool left, so there is no second
 * chance to trim the text.
 */
import type { ToolHandler, ToolResult } from '../../ai/tools/tool-types.js';
import { formatBytes } from '../../shared/file-name.js';
import { writeWorkspaceFile } from '../../services/workspace-service.js';
import {
    HANDOFF_FILE_PATH,
    HANDOFF_TOOL_MAX_CHARS,
} from '../workspace/workspace-handoff.js';
import { resolveWorkspaceRef, type WorkspaceState } from '../workspace/workspace-state.js';
import { parseLeaveHandoffArgs } from './workspace-tool-args.js';
import { workspaceToolError, workspaceToolSuccess } from './workspace-tool-result.js';
import { LEAVE_HANDOFF_TOOL_NAME } from './tool-names.js';

const DESCRIPTION_HEAD =
    `写交接文档到 handoff.md（覆盖，≤${HANDOFF_TOOL_MAX_CHARS}字，下轮见前2000字；` +
    "结构见 load_skill(['workspace-usage'])）。";

/** Gemini runs a hand-off round after the budgets are gone; the other platforms do not */
const DESCRIPTION_FINAL_ROUND = `${DESCRIPTION_HEAD}Gemini 收尾轮唯一可用工具。`;

const DESCRIPTION_NEUTRAL = `${DESCRIPTION_HEAD}请在收尾前提前调用。`;

const INPUT_SCHEMA = {
    type: 'object',
    properties: {
        content: {
            type: 'string',
            description: `交接 Markdown（首行一句话进度，≤${HANDOFF_TOOL_MAX_CHARS}字）`,
        },
    },
    required: ['content'],
};

const REJECTION_LOG_MAX_CHARS = 200;

const reject = (message: string, traceArgument?: string): ToolResult => {
    console.warn(`[leave_handoff] rejected: ${Array.from(message).slice(0, REJECTION_LOG_MAX_CHARS).join('')}`);
    return workspaceToolError(
        message,
        traceArgument === undefined ? undefined : { argument: traceArgument }
    );
};

export interface LeaveHandoffToolOptions {
    readonly state: WorkspaceState;
    /** The platform runs the Gemini hand-off round: the description may promise it */
    readonly finalRoundTool: boolean;
}

export const createLeaveHandoffTool = (options: LeaveHandoffToolOptions): ToolHandler => {
    const { state } = options;
    const description = options.finalRoundTool ? DESCRIPTION_FINAL_ROUND : DESCRIPTION_NEUTRAL;

    return {
        definition: {
            name: LEAVE_HANDOFF_TOOL_NAME,
            description,
            inputSchema: INPUT_SCHEMA,
        },
        statusText: '🗂️ 正在写交接文档…',
        execute: async (rawArgs) => {
            const parsed = parseLeaveHandoffArgs(rawArgs);
            if (!parsed.ok) {
                const written = typeof rawArgs.content === 'string' ? Array.from(rawArgs.content.trim()).length : 0;
                return reject(parsed.error, `${written} 字`);
            }
            const text = parsed.value.content.trim();
            const chars = Array.from(text);
            const traceArgument = `${chars.length} 字`;
            const ref = resolveWorkspaceRef(state, undefined);
            if (!ref.ok) return reject(ref.error, traceArgument);

            const truncated = chars.length > HANDOFF_TOOL_MAX_CHARS;
            const content = truncated ? chars.slice(0, HANDOFF_TOOL_MAX_CHARS).join('') : text;

            const result = await writeWorkspaceFile({
                chatId: state.chatId,
                conversationRootId: ref.ref.rootId,
                path: HANDOFF_FILE_PATH,
                content,
                append: false,
                overwrite: true,
                quota: state.quota,
            });
            if (!result.ok) {
                return reject(
                    `${result.error}\n本轮已无法补救（收尾轮调不到 workspace list/delete）；` +
                        '下一条回复先清理工作区再写。',
                    traceArgument
                );
            }

            console.log(
                `[handoff] wrote chat=${state.chatId} root=${ref.ref.rootId} chars=${Array.from(content).length}`
            );

            const usage =
                `工作区 ${result.fileCount} 个文件，已用 ${formatBytes(result.totalBytes)} / ` +
                `${formatBytes(state.quota.maxConversationBytes)}`;
            const size = formatBytes(result.sizeBytes);
            const label = `${ref.ref.label} ${ref.ref.token}`;
            const base = result.created
                ? `已写入交接文档 handoff.md（${label}）：${chars.length} 字符（${size}；${usage}）。`
                : `已覆盖交接文档 handoff.md（${label}）：原 ${formatBytes(result.replacedBytes ?? 0)} → ${size}（${usage}）。`;
            const truncation = truncated
                ? `\n原文 ${chars.length} 字符，只保存了前 ${HANDOFF_TOOL_MAX_CHARS} 字符（注入只取前 2000，其余可 workspace(action="read")）。`
                : '';
            return workspaceToolSuccess(
                `${base}同一会话的下一轮回复会看到全文（上限 2000 字符）。${truncation}`,
                undefined,
                {
                    argument: traceArgument,
                    result: truncated
                        ? `已写 handoff.md · 截断为 ${HANDOFF_TOOL_MAX_CHARS}`
                        : '已写 handoff.md',
                }
            );
        },
    };
};
