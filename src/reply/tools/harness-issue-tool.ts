/**
 * The model's own issue list about the harness it is using (`harness_issue`:
 * `list` | `create`).
 */
import { match } from 'ts-pattern';
import type { ToolCallTrace, ToolHandler, ToolResult } from '../../ai/tools/tool-types.js';
import { parseHarnessIssueInput, type HarnessIssueInputProblem } from '../../services/harness-issue-input.js';
import {
    createHarnessIssue,
    listHarnessIssues,
    HARNESS_ISSUE_BODY_MAX,
    HARNESS_ISSUE_KINDS,
    HARNESS_ISSUE_LIST_LIMIT_MAX,
    HARNESS_ISSUE_SEVERITIES,
    HARNESS_ISSUE_STATUSES,
    HARNESS_ISSUE_TITLE_MAX,
    type HarnessIssueRecord,
    type HarnessIssueStats,
    type HarnessIssueStatusFilter,
} from '../../services/harness-issue-service.js';
import { MAX_HARNESS_ISSUES_PER_REPLY, type HarnessIssueState } from './harness-issue-state.js';
import { HARNESS_ISSUE_TOOL_NAME } from './tool-names.js';
import { traceQuote } from './tool-trace.js';

const ok = (content: string, trace?: ToolCallTrace): ToolResult => ({
    content,
    isError: false,
    images: [],
    record: null,
    ...(trace === undefined ? {} : { trace }),
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
    const filedByPerson = record.source === 'user' ? '[user]' : '';
    return `#${record.id} [${record.status}][${record.kind}]${severity}${filedByPerson} ${record.title}`;
};

const formatStats = (stats: HarnessIssueStats): string => {
    const counts = HARNESS_ISSUE_STATUSES.map(
        (status) => `${status} ${stats.byStatus[status]}`
    ).join(' · ');
    return `全部 ${stats.total} 条：${counts}`;
};

const isStatusFilter = (value: string): value is HarnessIssueStatusFilter =>
    value === 'open' || value === 'closed' || value === 'all';

const inputProblemMessage = (problem: HarnessIssueInputProblem): string =>
    match(problem)
        .with('missing', () => 'title、body、kind 都是必填。')
        .with('title_too_long', () => `title 超过 ${HARNESS_ISSUE_TITLE_MAX} 字，请压缩成一句话。`)
        .with('body_too_long', () => `body 超过 ${HARNESS_ISSUE_BODY_MAX} 字，请只保留现象与建议。`)
        .with('bad_kind', () => 'kind 必须是 bug / improvement / feature。')
        .with('bad_severity', () => 'severity 必须是 low / medium / high。')
        .exhaustive();

const executeList = async (
    args: Readonly<Record<string, unknown>>,
    chatId: number,
    tracePrefix: string
): Promise<ToolResult> => {
    const statusArg = trimToNull(stringOf(args, 'status')) ?? 'open';
    if (!isStatusFilter(statusArg)) {
        return failed('status 必须是 open / closed / all。');
    }
    const query = trimToNull(stringOf(args, 'query')) ?? undefined;
    const limitArg = args['limit'];
    const limit = typeof limitArg === 'number' && Number.isFinite(limitArg) ? Math.trunc(limitArg) : undefined;

    try {
        const { records, stats } = await listHarnessIssues({
            status: statusArg,
            ...(query === undefined ? {} : { query }),
            ...(limit === undefined ? {} : { limit }),
            visibleInChatId: chatId,
        });
        const filterLabel = query === undefined ? `status=${statusArg}` : `status=${statusArg}, query=${query}`;
        const lines =
            records.length === 0
                ? [`没有匹配的 issue（${filterLabel}）。`]
                : [...records.map(formatRecord), `共 ${records.length} 条（${filterLabel}）。`];
        lines.push(formatStats(stats));
        const argument = `${statusArg}${query === undefined ? '' : traceQuote(query, 24)}`;
        return ok(lines.join('\n'), {
            argument: tracePrefix === '' ? argument : `${tracePrefix}${argument}`,
            result: `${records.length} 条（共 ${stats.total} 条）`,
        });
    } catch (error) {
        return failed(`读取 issue 列表失败：${error instanceof Error ? error.message : String(error)}`);
    }
};

const executeCreate = async (
    args: Readonly<Record<string, unknown>>,
    state: HarnessIssueState,
    chatId: number,
    tracePrefix: string
): Promise<ToolResult> => {
    const parsed = parseHarnessIssueInput(args);
    if (!parsed.ok) {
        return failed(inputProblemMessage(parsed.problem));
    }
    const { title, body, kind, severity } = parsed.value;
    if (!state.canCreate()) {
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
            ...(severity === null ? {} : { severity }),
            ...(toolName === null ? {} : { toolName: toolName.slice(0, 64) }),
            chatId,
        });
        state.noteCreated();
        console.log(
            `[harness-issue] created #${record.id} kind=${record.kind}${record.toolName ? ` tool=${record.toolName}` : ''}`
        );
        const argument = `${kind}${traceQuote(title, 24)}${severity === null ? '' : ` · ${severity}`}`;
        return ok(`已记录 #${record.id}（open, ${record.kind}）。维护者会在后续迭代里处理。`, {
            argument: tracePrefix === '' ? argument : `${tracePrefix}${argument}`,
            result: `#${record.id}`,
        });
    } catch (error) {
        return failed(`记录失败：${error instanceof Error ? error.message : String(error)}`);
    }
};

const MERGED_DESCRIPTION =
    '查看或记录 harness 自身问题与改进建议（list 查重，create 提单）。' +
    "提单规范见 load_skill(['harness-reporting'])；勿写进回复正文。";

const MERGED_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        action: {
            type: 'string',
            enum: ['list', 'create'],
            description: 'list=查重列表；create=记录新 issue',
        },
        status: {
            type: 'string',
            enum: ['open', 'closed', 'all'],
            description: 'list 过滤，默认 open',
        },
        query: { type: 'string', description: 'list 关键词过滤' },
        limit: {
            type: 'integer',
            minimum: 1,
            maximum: HARNESS_ISSUE_LIST_LIMIT_MAX,
            description: 'list 条数上限（默认20）',
        },
        title: { type: 'string', description: 'create 一句话标题' },
        body: { type: 'string', description: 'create 现象/影响/建议（勿贴用户原文）' },
        kind: {
            type: 'string',
            enum: [...HARNESS_ISSUE_KINDS],
            description: 'create 类型：bug/improvement/feature',
        },
        severity: {
            type: 'string',
            enum: [...HARNESS_ISSUE_SEVERITIES],
            description: 'create 影响程度',
        },
        tool_name: { type: 'string', description: 'create 相关工具名' },
    },
    required: ['action'],
};

export interface HarnessIssueToolOptions {
    readonly state: HarnessIssueState;
    /** Where the issue was reported from; stored for follow-up, never shown */
    readonly chatId: number;
}

export const createHarnessIssueTool = (options: HarnessIssueToolOptions): ToolHandler => ({
    definition: {
        name: HARNESS_ISSUE_TOOL_NAME,
        description: MERGED_DESCRIPTION,
        inputSchema: MERGED_INPUT_SCHEMA,
    },
    statusText: (args) =>
        match(args.action)
            .with('list', () => '🔍 正在查看 harness issue…')
            .with('create', () => '📝 正在记录 harness issue…')
            .otherwise(() => undefined),
    execute: async (args) =>
        match(args.action)
            .with('list', () => executeList(args, options.chatId, 'list · '))
            .with('create', () => executeCreate(args, options.state, options.chatId, 'create · '))
            .otherwise(() => failed('action 必须是 "list" 或 "create"。')),
});
