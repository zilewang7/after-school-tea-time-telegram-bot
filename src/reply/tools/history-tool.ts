/**
 * history: the merged 2-in-1 archive tool (`search` | `read`).
 *
 * Keeps luoxu's lexical rules, OCR/deleted/folded-block semantics, DM cross-group
 * search (`channelId === null`), and `ToolCallTrace.links` while rejecting mixed
 * search/read parameters at runtime.
 */
import { match } from 'ts-pattern';
import type { ToolHandler, ToolResult } from '../../ai/tools/tool-types.js';
import {
    HISTORY_DEFAULT_LIMIT,
    HISTORY_MAX_LIMIT,
    HISTORY_MAX_QUERY_CHARS,
    HISTORY_MAX_REFS,
} from './history-args.js';
import { executeHistoryRead, executeHistorySearch, summarizeHistoryArgs } from './history-tool-actions.js';
import { historyToolError } from './history-tool-result.js';
import { withHistoryLogging, type HistoryToolOptions } from './history-tool-shared.js';
import { HISTORY_TOOL_NAME } from './tool-names.js';

const SEARCH_ONLY_KEYS = ['query', 'sender', 'from', 'to', 'before', 'limit', 'scope'] as const;
const READ_ONLY_KEYS = ['ids', 'around', 'minutes', 'folded'] as const;

const descriptionOf = (channelId: number | null): string =>
    '检索并读归档消息（luoxu 全文索引：消息、预览、Instant View、图片 OCR）。' +
    `search 返回从新到旧的 hN 列表（默认${HISTORY_DEFAULT_LIMIT}，最多${HISTORY_MAX_LIMIT}，非相关性序），read 按 ids/around 读全文或对话。` +
    '规则：OCR 非正文；「（已删除）」仍可读；「（你自己）」折叠块默认省略（folded=true 原样返回）。' +
    'query：空格=AND、OR、-、()；中文按字，英文/驼峰按整词不分大小写，词首前缀加 *（如 docker*，勿对 #tag 加 *，无 *mid）；before 翻页。' +
    (channelId === null
        ? '当前私聊无本群归档，scope 仅 all；#N 不适用，可用 hN 或 t.me。'
        : '默认本群；机主可用 scope="all" 跨群。');

const inputSchemaOf = (channelId: number | null): Readonly<Record<string, unknown>> => ({
    type: 'object',
    properties: {
        action: {
            type: 'string',
            enum: ['search', 'read'],
            description: 'search=检索列表；read=读全文/对话',
        },
        query: {
            type: 'string',
            description: `search 关键词（≤${HISTORY_MAX_QUERY_CHARS}字）；省略列最近`,
        },
        sender: { type: 'string', description: 'search 发言人名或 uid（跨群仅 uid）' },
        from: { type: 'string', description: 'search 起始 YYYY-MM-DD[ HH:mm]' },
        to: { type: 'string', description: 'search 结束日期/时间（含当天）' },
        before: { type: 'string', description: 'search 翻更早页：hN 或时间' },
        limit: {
            type: 'integer',
            minimum: 1,
            maximum: HISTORY_MAX_LIMIT,
            description: `search 条数（默认${HISTORY_DEFAULT_LIMIT}/最大${HISTORY_MAX_LIMIT}）`,
        },
        scope: {
            type: 'string',
            enum: ['chat', 'all'],
            description: channelId === null ? '固定 all（私聊跨群）' : 'chat=本群；all=全部（仅机主）',
        },
        ids: {
            type: 'array',
            items: { type: 'string' },
            maxItems: HISTORY_MAX_REFS,
            description: `read 引用数组（hN/#N/t.me，≤${HISTORY_MAX_REFS}），与 around 互斥`,
        },
        around: { type: 'string', description: 'read 中心引用（hN/#N/t.me），与 ids 互斥' },
        minutes: {
            type: 'integer',
            minimum: 1,
            maximum: 120,
            description: 'read around 半径分钟（默认10）',
        },
        folded: { type: 'boolean', description: 'read true=保留 bot 折叠块原文' },
    },
    required: ['action'],
});

const isNonEmptyArg = (key: string, value: unknown): boolean => {
    if (value === undefined || value === null) return false;
    if (key === 'folded') return value !== false;
    if (typeof value === 'string') return value.trim() !== '';
    if (Array.isArray(value)) return value.length > 0;
    return true;
};

const mixedParamsError = (action: 'search' | 'read', args: Readonly<Record<string, unknown>>): string | null => {
    const forbidden = action === 'search' ? READ_ONLY_KEYS : SEARCH_ONLY_KEYS;
    const present = forbidden.filter((key) => isNonEmptyArg(key, args[key]));
    if (present.length === 0) return null;
    return `参数有误：action="${action}" 不能与 ${present.join('、')} 混传。`;
};

export const createHistoryTool = (options: HistoryToolOptions): ToolHandler => {
    const defaultScope: 'chat' | 'all' = options.channelId === null ? 'all' : 'chat';

    const handler: ToolHandler = {
        definition: {
            name: HISTORY_TOOL_NAME,
            description: descriptionOf(options.channelId),
            inputSchema: inputSchemaOf(options.channelId),
        },
        statusText: (args) =>
            match(args.action)
                .with('search', () => '🔍 正在翻聊天记录…')
                .with('read', () => '📖 正在读聊天记录…')
                .otherwise(() => undefined),
        chatAction: 'typing',
        execute: async (args, signal): Promise<ToolResult> =>
            match(args.action)
                .with('search', () => {
                    const mixed = mixedParamsError('search', args);
                    return mixed !== null
                        ? Promise.resolve(historyToolError(mixed))
                        : executeHistorySearch(options, args, signal);
                })
                .with('read', () => {
                    const mixed = mixedParamsError('read', args);
                    return mixed !== null
                        ? Promise.resolve(historyToolError(mixed))
                        : executeHistoryRead(options, args, signal);
                })
                .otherwise(() => Promise.resolve(historyToolError('action 必须是 "search" 或 "read"。'))),
    };
    return withHistoryLogging(handler, options.context.chatId, (args) =>
        summarizeHistoryArgs(args, defaultScope)
    );
};
