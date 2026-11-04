/**
 * The model's own issue list about the harness it is using.
 *
 * `list_harness_issues` is the dedupe step, `create_harness_issue` the write.
 * Neither touches the chat: the model records friction for the maintainer, not
 * a report for the user, and the reply's own text must not mention it.
 */
import type { ToolHandler, ToolResult } from '../../ai/tools/tool-types.js';
import {
    createHarnessIssue,
    listHarnessIssues,
    HARNESS_ISSUE_BODY_MAX,
    HARNESS_ISSUE_KINDS,
    HARNESS_ISSUE_LIST_LIMIT_MAX,
    HARNESS_ISSUE_SEVERITIES,
    HARNESS_ISSUE_TITLE_MAX,
    type HarnessIssueKind,
    type HarnessIssueRecord,
    type HarnessIssueSeverity,
    type HarnessIssueStatusFilter,
} from '../../services/harness-issue-service.js';
import { MAX_HARNESS_ISSUES_PER_REPLY, type HarnessIssueState } from './harness-issue-state.js';
import { CREATE_HARNESS_ISSUE_TOOL_NAME, LIST_HARNESS_ISSUES_TOOL_NAME } from './tool-names.js';

const ok = (content: string): ToolResult => ({
    content,
    isError: false,
    images: [],
    record: null,
});

const failed = (content: string): ToolResult => ({
    content,
    isError: true,
    images: [],
    record: null,
});

const stringOf = (args: Readonly<Record<string, unknown>>, key: string): string | null => {
    const value = args[key];
    return typeof value === 'string' ? value : null;
};

const trimToNull = (value: string | null): string | null => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
};

const formatRecord = (record: HarnessIssueRecord): string => {
    const severity = record.severity ? `[${record.severity}]` : '';
    return `#${record.id} [${record.status}][${record.kind}]${severity} ${record.title}`;
};

const LIST_DESCRIPTION =
    '列出已记录的 harness 自身问题与改进建议及其状态。在提新 issue 前先用它查重；status=closed 可查已处理/已驳回的旧条目。';

const LIST_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        status: {
            type: 'string',
            enum: ['open', 'closed', 'all'],
            description: 'open（默认）= 待处理；closed = 已处理、已驳回或重复；all = 全部。',
        },
        query: {
            type: 'string',
            description: '按关键词过滤标题与正文。',
        },
        limit: {
            type: 'integer',
            minimum: 1,
            maximum: HARNESS_ISSUE_LIST_LIMIT_MAX,
            description: `最多返回几条，默认 20，上限 ${HARNESS_ISSUE_LIST_LIMIT_MAX}。`,
        },
    },
};

const CREATE_DESCRIPTION =
    '记录一条关于 harness 自身的问题或改进建议：工具描述不清、参数不够用、错误信息没帮助、上下文格式难解析、缺少能力、提示词自相矛盾等。' +
    '只写 harness 的问题，不要贴用户消息原文、个人信息或一次性任务细节。提交前先用 `list_harness_issues` 查重。';

const CREATE_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        title: {
            type: 'string',
            description: '一句话说清问题，例如「send_sticker 的描述没写可以整行照抄目录」。',
        },
        body: {
            type: 'string',
            description: '哪个工具/环节、现象、影响、建议怎么改；不要包含用户消息原文或个人信息。',
        },
        kind: {
            type: 'string',
            enum: [...HARNESS_ISSUE_KINDS],
            description: 'bug = 行为不对；improvement = 能用但别扭；feature = 缺能力。',
        },
        severity: {
            type: 'string',
            enum: [...HARNESS_ISSUE_SEVERITIES],
            description: '对干活的影响程度，可省略。',
        },
        tool_name: {
            type: 'string',
            description: '相关工具名（如 send_sticker），可省略。',
        },
    },
    required: ['title', 'body', 'kind'],
};

const isKind = (value: string): value is HarnessIssueKind =>
    (HARNESS_ISSUE_KINDS as readonly string[]).includes(value);

const isSeverity = (value: string): value is HarnessIssueSeverity =>
    (HARNESS_ISSUE_SEVERITIES as readonly string[]).includes(value);

const isStatusFilter = (value: string): value is HarnessIssueStatusFilter =>
    value === 'open' || value === 'closed' || value === 'all';

export const createListHarnessIssuesTool = (): ToolHandler => ({
    definition: {
        name: LIST_HARNESS_ISSUES_TOOL_NAME,
        description: LIST_DESCRIPTION,
        inputSchema: LIST_INPUT_SCHEMA,
    },
    execute: async (args) => {
        const statusArg = trimToNull(stringOf(args, 'status')) ?? 'open';
        if (!isStatusFilter(statusArg)) {
            return failed('status 必须是 open / closed / all。');
        }
        const query = trimToNull(stringOf(args, 'query')) ?? undefined;
        const limitArg = args['limit'];
        const limit = typeof limitArg === 'number' && Number.isFinite(limitArg) ? Math.trunc(limitArg) : undefined;

        try {
            const records = await listHarnessIssues({
                status: statusArg,
                ...(query === undefined ? {} : { query }),
                ...(limit === undefined ? {} : { limit }),
            });
            if (records.length === 0) {
                return ok(`没有匹配的 issue（status=${statusArg}）。`);
            }
            const lines = records.map(formatRecord);
            lines.push(`共 ${records.length} 条（status=${statusArg}）。`);
            return ok(lines.join('\n'));
        } catch (error) {
            return failed(`读取 issue 列表失败：${error instanceof Error ? error.message : String(error)}`);
        }
    },
});

export interface CreateHarnessIssueToolOptions {
    readonly state: HarnessIssueState;
    /** Where the issue was reported from; stored for follow-up, never shown */
    readonly chatId: number;
}

export const createCreateHarnessIssueTool = (
    options: CreateHarnessIssueToolOptions
): ToolHandler => ({
    definition: {
        name: CREATE_HARNESS_ISSUE_TOOL_NAME,
        description: CREATE_DESCRIPTION,
        inputSchema: CREATE_INPUT_SCHEMA,
    },
    execute: async (args) => {
        const title = trimToNull(stringOf(args, 'title'));
        const body = trimToNull(stringOf(args, 'body'));
        const kind = trimToNull(stringOf(args, 'kind'));
        if (title === null || body === null || kind === null) {
            return failed('title、body、kind 都是必填。');
        }
        if (title.length > HARNESS_ISSUE_TITLE_MAX) {
            return failed(`title 超过 ${HARNESS_ISSUE_TITLE_MAX} 字，请压缩成一句话。`);
        }
        if (body.length > HARNESS_ISSUE_BODY_MAX) {
            return failed(`body 超过 ${HARNESS_ISSUE_BODY_MAX} 字，请只保留现象与建议。`);
        }
        if (!isKind(kind)) {
            return failed('kind 必须是 bug / improvement / feature。');
        }
        const severityArg = trimToNull(stringOf(args, 'severity'));
        if (severityArg !== null && !isSeverity(severityArg)) {
            return failed('severity 必须是 low / medium / high。');
        }
        if (!options.state.canCreate()) {
            return failed(
                `本条回复已经记录了 ${MAX_HARNESS_ISSUES_PER_REPLY} 条 issue，请合并后再提。`
            );
        }

        const toolName = trimToNull(stringOf(args, 'tool_name'));
        try {
            const record = await createHarnessIssue({
                title,
                body,
                kind,
                ...(severityArg === null ? {} : { severity: severityArg }),
                ...(toolName === null ? {} : { toolName: toolName.slice(0, 64) }),
                chatId: options.chatId,
            });
            options.state.noteCreated();
            console.log(
                `[harness-issue] created #${record.id} kind=${record.kind}${record.toolName ? ` tool=${record.toolName}` : ''}`
            );
            return ok(`已记录 #${record.id}（open, ${record.kind}）。维护者会在后续迭代里处理。`);
        } catch (error) {
            return failed(`记录失败：${error instanceof Error ? error.message : String(error)}`);
        }
    },
});
