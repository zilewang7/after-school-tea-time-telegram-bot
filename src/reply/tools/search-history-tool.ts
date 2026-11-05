/**
 * search_history: the cheap listing pass over luoxu's archive.
 *
 * One request, one compact list: `hN`, time, author, the #N/link anchor, the
 * message's first line, the keyword in context and what the index carries
 * besides the body. Reading anything in full is the model's next decision
 * (`read_history`), which is what keeps a broad query cheap.
 *
 * Facts the description has to carry (the model cannot discover them): results
 * are newest-first with a hard 50-row cap rather than relevance, the index
 * covers previews/Instant-View/OCR text, and `before` is how you go further.
 */
import type { ToolHandler, ToolResult } from '../../ai/tools/tool-types.js';
import {
    HISTORY_SEARCH_TIMEOUT_MS,
    type HistoryRawMessage,
    type HistorySearchOutcome,
} from '../../services/luoxu-history-service.js';
import { parseDateBound, parseHistoryReference, parseHistorySearchArgs } from './history-args.js';
import {
    attachmentSummary,
    firstLineOf,
    htmlToText,
    isInsideFolded,
    keywordWindow,
    renderSearchList,
    stripFoldedBlocks,
    type SearchListRow,
} from './history-text.js';
import { historyToolError, historyToolSuccess } from './history-tool-result.js';
import type { HistoryEntry } from './history-state.js';
import {
    anchorFor,
    contextNumbersOf,
    describeFailure,
    historyTimeZoneOf,
    isOwner,
    messageKey,
    withHistoryLogging,
    type HistoryToolOptions,
} from './history-tool-shared.js';
import { SEARCH_HISTORY_TOOL_NAME } from './tool-names.js';

const DESCRIPTION =
    '检索本聊天的历史归档（luoxu 的全文索引，覆盖更早的消息、链接预览正文、Instant View 全文与图片 OCR 文本）。' +
    '返回按时间从新到旧的命中列表，每条带 hN 编号、时间、发送者、#N 或 t.me 链接、消息首行与命中处的上下文片段；不含正文全文，需要时用 read_history 读。' +
    '事实：最多只返回最新的 50 条命中（不是相关性排序）；query 支持空格 AND、OR、"短语"、-排除、括号，中文不需要分词；省略 query 时按时间列出最近的消息；' +
    '用 sender / from / to 收窄，用 before 翻到更早的一页。';

const INPUT_SCHEMA = {
    type: 'object',
    properties: {
        query: {
            type: 'string',
            description: '关键词，例如 "显卡 推荐"、RAG OR 检索、"Agent Memory"。省略则按时间列最近消息。',
        },
        sender: {
            type: 'string',
            description: '只找某个发言人：名字（模糊）或 Telegram uid。',
        },
        from: {
            type: 'string',
            description: '起始时间，YYYY-MM-DD 或 YYYY-MM-DD HH:mm（本机时区）。',
        },
        to: {
            type: 'string',
            description: '结束时间，YYYY-MM-DD 或 YYYY-MM-DD HH:mm；只给日期时含当天。',
        },
        before: {
            type: 'string',
            description: '只看比它更早的命中：hN（本次结果里的编号）或 YYYY-MM-DD HH:mm，用来翻页。',
        },
        limit: {
            type: 'integer',
            minimum: 1,
            maximum: 20,
            description: '列表条数，默认 10。',
        },
        scope: {
            type: 'string',
            enum: ['chat', 'all'],
            description: 'chat（默认）= 本聊天；all = 全部归档群（仅机主可用）。',
        },
    },
};

const MAX_GROUPS_PER_LIST = 4;
const MAX_LIST_CHARS = 6000;

const resolveSenderId = async (
    options: HistoryToolOptions,
    sender: string,
    scope: 'chat' | 'all',
    signal: AbortSignal
): Promise<{ readonly senderId: number | null; readonly error: string | null }> => {
    if (/^\d+$/.test(sender)) return { senderId: Number.parseInt(sender, 10), error: null };
    if (scope === 'all') {
        return { senderId: null, error: '跨群检索时 sender 需要用 uid 指定（名字只在单个群里解析）。' };
    }
    if (options.channelId === null) {
        return { senderId: null, error: '这个聊天没有归档索引，无法按名字找发言人。' };
    }
    try {
        const candidates = await options.service.findSenders(options.channelId, sender, { signal });
        if (candidates.length === 0) return { senderId: null, error: `没有找到叫「${sender}」的发言人。` };
        // One person shows up under every name they have used; the uid is what
        // identifies a sender, so several rows sharing one uid are one match,
        // not an ambiguity to hand back to the caller.
        const namesByUid = new Map<number, string>();
        for (const candidate of candidates) {
            if (!namesByUid.has(candidate.uid)) namesByUid.set(candidate.uid, candidate.name);
        }
        const [onlyUid] = [...namesByUid.keys()];
        if (onlyUid !== undefined && namesByUid.size === 1) {
            return { senderId: onlyUid, error: null };
        }
        const listed = [...namesByUid.entries()]
            .slice(0, 5)
            .map(([uid, name]) => `${uid}（${name}）`)
            .join('、');
        return { senderId: null, error: `「${sender}」对应多个发言人，请用 uid 指定：${listed}` };
    } catch (error) {
        return { senderId: null, error: describeFailure(error) };
    }
};

const resolveBeforeEnd = (
    options: HistoryToolOptions,
    before: string
): { readonly end: number | null; readonly error: string | null } => {
    const reference = parseHistoryReference(before);
    if (reference) {
        if (reference.kind !== 'number') return { end: null, error: `before 只接受 hN 或时间，不接受 ${before}。` };
        const entry = options.state.entryOf(reference.h);
        if (!entry) return { end: null, error: `没有 h${reference.h}——它不在本次回复的历史结果里。` };
        return { end: entry.timestamp, error: null };
    }
    // Strictly earlier: a bare date means "before that day starts"
    const bound = parseDateBound(before, 'start', historyTimeZoneOf(options));
    if (bound.error) return { end: null, error: bound.error };
    return { end: bound.seconds, error: null };
};

/** Fetch raw texts for the listed hits, grouped per chat; failures only degrade */
const fetchRaw = async (
    options: HistoryToolOptions,
    hits: readonly { readonly channelId: number; readonly messageId: number }[],
    signal: AbortSignal
): Promise<Map<string, HistoryRawMessage>> => {
    const byChannel = new Map<number, number[]>();
    for (const hit of hits) {
        const ids = byChannel.get(hit.channelId);
        if (ids) ids.push(hit.messageId);
        else byChannel.set(hit.channelId, [hit.messageId]);
    }
    const raw = new Map<string, HistoryRawMessage>();
    let groups = 0;
    for (const [channelId, ids] of byChannel) {
        if (groups >= MAX_GROUPS_PER_LIST) break;
        groups += 1;
        try {
            const messages = await options.service.messages(channelId, ids, { signal });
            for (const message of messages) raw.set(messageKey(channelId, message.messageId), message);
        } catch (error) {
            console.warn(`[search_history] /messages failed for ${channelId}: ${describeFailure(error)}`);
        }
    }
    return raw;
};

const buildRow = (
    entry: HistoryEntry,
    raw: HistoryRawMessage | undefined,
    query: string | null,
    anchor: string,
    replyTo: string | undefined
): SearchListRow => {
    const body = raw ? stripFoldedBlocks(raw.text, raw.entities, 30).text : '';
    const firstLine = firstLineOf(body || htmlToText(entry.indexedHtml), 80);
    const window = query ? keywordWindow(entry.indexedHtml, query) : null;
    const inFolded = window?.term && raw ? isInsideFolded(window.term, raw.text, raw.entities) : false;
    const attachments = attachmentSummary(entry.indexedHtml);
    return {
        entry,
        anchor,
        ...(entry.groupName ? { groupName: entry.groupName } : {}),
        firstLine,
        ...(window ? { kwic: window.text, kwicInFolded: inFolded } : {}),
        ...(attachments ? { attachments } : {}),
        ...(replyTo ? { replyTo } : {}),
    };
};

const summarizeSearchArgs = (args: Readonly<Record<string, unknown>>): string =>
    JSON.stringify({
        query: args.query ?? null,
        sender: args.sender ?? null,
        scope: args.scope ?? 'chat',
        from: args.from ?? null,
        to: args.to ?? null,
        before: args.before ?? null,
        limit: args.limit ?? null,
    });

export const createSearchHistoryTool = (options: HistoryToolOptions): ToolHandler => {
    const timeZone = historyTimeZoneOf(options);

    const handler: ToolHandler = {
        definition: {
            name: SEARCH_HISTORY_TOOL_NAME,
            description: DESCRIPTION,
            inputSchema: INPUT_SCHEMA,
        },
        statusText: '🔍 正在翻聊天记录…',
        chatAction: 'typing',
        execute: async (args, signal): Promise<ToolResult> => {
            const parsed = parseHistorySearchArgs(args);
            if (!parsed.ok) return historyToolError(parsed.error);
            const searchArgs = parsed.value;

            if (searchArgs.scope === 'all' && !isOwner(options)) {
                return historyToolError('跨群检索仅机主可用。');
            }
            if (searchArgs.scope === 'chat' && options.channelId === null) {
                return historyToolError('这个聊天没有归档索引。');
            }

            const sender = searchArgs.sender
                ? await resolveSenderId(options, searchArgs.sender, searchArgs.scope, signal)
                : { senderId: null, error: null };
            if (sender.error) return historyToolError(sender.error);

            const from = parseDateBound(searchArgs.from, 'start', timeZone);
            if (from.error) return historyToolError(from.error);
            const to = parseDateBound(searchArgs.to, 'end', timeZone);
            if (to.error) return historyToolError(to.error);
            const before = searchArgs.before ? resolveBeforeEnd(options, searchArgs.before) : { end: null, error: null };
            if (before.error) return historyToolError(before.error);

            const start = from.seconds === null ? null : from.seconds - 1;
            const ends = [to.seconds === null ? null : to.seconds + 1, before.end].filter(
                (value): value is number => value !== null
            );
            const end = ends.length > 0 ? Math.min(...ends) : null;

            let outcome: HistorySearchOutcome;
            try {
                outcome = await options.service.search({
                    channelId: searchArgs.scope === 'all' ? null : options.channelId,
                    query: searchArgs.query,
                    senderId: sender.senderId,
                    start,
                    end,
                    signal,
                    timeoutMs: HISTORY_SEARCH_TIMEOUT_MS,
                });
            } catch (error) {
                return historyToolError(describeFailure(error));
            }

            const hits = outcome.hits.slice(0, searchArgs.limit);
            const scopeLabel = searchArgs.scope === 'all' ? '全部归档群' : '本群';
            const conditions = [
                searchArgs.query ? `query="${searchArgs.query}"` : '最近消息',
                from.seconds === null && to.seconds === null
                    ? null
                    : `时间 ${searchArgs.from ?? '…'}–${searchArgs.to ?? '…'}`,
                searchArgs.sender ? `发言人 ${searchArgs.sender}` : null,
            ].filter((part): part is string => part !== null);

            if (hits.length === 0) {
                return historyToolSuccess(
                    `历史检索：${conditions.join('，')}，范围=${scopeLabel}，没有找到匹配的历史消息。`
                );
            }

            const currentChannel = options.channelId;
            const contextNumbers = contextNumbersOf(options.context);

            const raw = await fetchRaw(options, hits, signal);
            const rows: SearchListRow[] = [];
            for (const hit of hits) {
                const groupName = outcome.groups.get(hit.channelId);
                const message = raw.get(messageKey(hit.channelId, hit.messageId));
                const entry = options.state.remember({
                    channelId: hit.channelId,
                    messageId: hit.messageId,
                    timestamp: hit.timestamp,
                    fromId: hit.fromId,
                    fromName: hit.fromName,
                    fromIsBot:
                        message?.senderIsBot ?? (hit.fromId !== null && hit.fromId === options.botUserId),
                    indexedHtml: hit.html,
                    ...(groupName ? { groupName } : {}),
                    ...(message
                        ? {
                              rawText: message.text,
                              entities: message.entities,
                              replyToId: message.replyToId,
                              media: message.media,
                              forward: message.forward,
                          }
                        : {}),
                });
                const replyNumber =
                    message?.replyToId !== null && message?.replyToId !== undefined
                        ? contextNumbers.get(message.replyToId)
                        : undefined;
                const replyTo =
                    replyNumber !== undefined
                        ? `#${replyNumber}`
                        : message?.replyToId !== null && message?.replyToId !== undefined
                          ? String(message.replyToId)
                          : undefined;
                rows.push(
                    buildRow(
                        entry,
                        message,
                        searchArgs.query,
                        anchorFor(contextNumbers, currentChannel, hit.channelId, hit.messageId),
                        replyTo
                    )
                );
            }

            const last = rows[rows.length - 1];
            const text = renderSearchList(
                {
                    ...(searchArgs.query ? { query: searchArgs.query } : {}),
                    scopeLabel,
                    shown: rows.length,
                    matched: outcome.hasMore ? '50+' : String(rows.length),
                    hasMore: outcome.hasMore,
                    ...(last ? { beforeHint: `h${last.entry.h}` } : {}),
                    showGroup: searchArgs.scope === 'all',
                },
                rows,
                timeZone,
                MAX_LIST_CHARS
            );
            return historyToolSuccess(text);
        },
    };
    return withHistoryLogging(handler, options.context.chatId, summarizeSearchArgs);
};
