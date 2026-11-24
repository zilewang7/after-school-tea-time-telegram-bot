/**
 * Execution actions (`search` and `read`) for the merged `history` tool.
 *
 * Preserves 100% of luoxu search syntax, OCR/deleted/folded-block handling,
 * owner cross-group search (`channelId === null`), and `ToolCallTrace.links`.
 */
import type { ToolCallTrace, ToolResult } from '../../ai/tools/tool-types.js';
import {
    HISTORY_MESSAGES_TIMEOUT_MS,
    HISTORY_SEARCH_TIMEOUT_MS,
    type HistoryRawMessage,
    type HistorySearchOutcome,
} from '../../services/luoxu-history-service.js';
import {
    HISTORY_DEFAULT_LIMIT,
    HISTORY_MAX_REFS,
    HISTORY_REF_HINT,
    parseDateBound,
    parseHistoryReadArgs,
    parseHistoryReference,
    parseHistorySearchArgs,
    type HistoryReadArgs,
} from './history-args.js';
import type { HistoryEntry, HistoryState } from './history-state.js';
import {
    attachmentLine,
    firstContentLineOf,
    firstLineOf,
    formatArchiveStatus,
    formatHistoryTime,
    indexedBodyOf,
    isInsideFolded,
    keywordWindow,
    ocrBlocksOf,
    ocrSourceAtLine,
    renderFullMessage,
    renderSearchList,
    renderWindow,
    searchListBudget,
    stripFoldedBlocks,
    truncateChars,
    withNotice,
    type SearchListRow,
    type WindowRow,
} from './history-text.js';
import { historyToolError, historyToolSuccess } from './history-tool-result.js';
import {
    anchorFor,
    contextNumbersOf,
    describeFailure,
    historyRefLinks,
    historyTimeZoneOf,
    isOwner,
    messageKey,
    messageLink,
    type HistoryToolOptions,
} from './history-tool-shared.js';
import { traceChars, traceDateRange, traceParts, traceQuote, traceRef, traceText } from './tool-trace.js';

const MAX_GROUPS_PER_LIST = 4;
const MAX_FULL_CHARS_PER_MESSAGE = 4000;
const MAX_FULL_CHARS_TOTAL = 24000;
const WINDOW_CHARS_PER_MESSAGE = 300;
const WINDOW_CHARS_TOTAL = 10000;
const WINDOW_MAX_PER_SIDE = 20;

type SearchAttempt =
    | { readonly ok: true; readonly outcome: HistorySearchOutcome }
    | { readonly ok: false; readonly error: unknown };

type ResolveResult = { readonly entry: HistoryEntry } | { readonly error: string };

const archiveStatusOf = async (
    options: HistoryToolOptions,
    scope: 'chat' | 'all',
    signal: AbortSignal,
    timeZone: string
): Promise<string | null> => {
    try {
        const stats = await options.service.stats(scope === 'all' ? null : options.channelId, { signal });
        return formatArchiveStatus({ scope, groups: stats.groups, timeZone });
    } catch (error) {
        console.warn(`[history:search] /stats failed: ${describeFailure(error)}`);
        return null;
    }
};

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
    const bound = parseDateBound(before, 'start', historyTimeZoneOf(options));
    if (bound.error) return { end: null, error: bound.error };
    return { end: bound.seconds, error: null };
};

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
            console.warn(`[history:search] /messages failed for ${channelId}: ${describeFailure(error)}`);
        }
    }
    return raw;
};

const buildSearchRow = (
    entry: HistoryEntry,
    raw: HistoryRawMessage | undefined,
    query: string | null,
    anchor: string,
    replyTo: string | undefined
): SearchListRow => {
    const blocks = ocrBlocksOf(entry);
    const rawText = raw?.text ?? entry.rawText;
    const entities = raw?.entities ?? entry.entities;
    const strippedRaw = rawText === undefined ? '' : stripFoldedBlocks(rawText, entities, 30).text;
    let firstLine: string;
    let firstLineOcr: ReturnType<typeof ocrSourceAtLine> = null;
    if (strippedRaw.trim().length > 0) {
        firstLine = firstLineOf(strippedRaw, 80);
    } else if (rawText !== undefined) {
        const content = firstContentLineOf(indexedBodyOf(entry));
        firstLine = content.line >= 0 ? truncateChars(content.text, 80).text : '';
        firstLineOcr = ocrSourceAtLine(blocks, content.line);
    } else {
        firstLine = firstLineOf(indexedBodyOf(entry), 80);
    }
    const window = query ? keywordWindow(entry.indexedHtml, query) : null;
    const inFolded = Boolean(window?.term && rawText !== undefined && isInsideFolded(window.term, rawText, entities));
    const kwicOcr = window ? ocrSourceAtLine(blocks, window.line) : null;
    const kwicUnverified = window !== null && rawText === undefined;
    const attachments = attachmentLine(entry.indexedHtml, raw?.imageCount ?? null);
    return {
        entry,
        anchor,
        ...(entry.groupName ? { groupName: entry.groupName } : {}),
        firstLine,
        ...(firstLineOcr ? { firstLineOcr } : {}),
        ...(window
            ? {
                  kwic: window.text,
                  kwicInFolded: inFolded,
                  ...(kwicOcr ? { kwicOcr } : {}),
                  ...(kwicUnverified ? { kwicUnverified } : {}),
              }
            : {}),
        ...(attachments ? { attachments } : {}),
        ...(replyTo ? { replyTo } : {}),
    };
};

const latinMissHintOf = (query: string | null, narrowed: boolean): string => {
    if (query === null || query.includes('*') || !/[A-Za-z]/.test(query)) return '';
    const advice = '英文/驼峰词按整词匹配：要词首前缀就在纯单词词尾加 *（如 dock*），词中片段搜不到';
    return narrowed
        ? `（${advice}；也试试放宽时间/发言人再搜，别就此断定归档里没有。）`
        : `（${advice}。换个写法再试，别就此断定归档里没有。）`;
};

export const executeHistorySearch = async (
    options: HistoryToolOptions,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal
): Promise<ToolResult> => {
    const timeZone = historyTimeZoneOf(options);
    const defaultScope: 'chat' | 'all' = options.channelId === null ? 'all' : 'chat';
    const parsed = parseHistorySearchArgs(args, defaultScope);
    if (!parsed.ok) return historyToolError(parsed.error);
    const searchArgs = parsed.value;
    const traceArgument = traceParts(
        'search',
        searchArgs.query === null ? '最近消息' : traceQuote(searchArgs.query),
        searchArgs.sender === null ? null : `sender=${traceText(searchArgs.sender)}`,
        traceDateRange(searchArgs.from, searchArgs.to),
        searchArgs.before === null ? null : `before=${traceText(searchArgs.before)}`,
        searchArgs.limit === HISTORY_DEFAULT_LIMIT ? null : `limit=${searchArgs.limit}`,
        searchArgs.scope === 'all' && defaultScope !== 'all' ? '全部群' : null
    );

    if (searchArgs.scope === 'all' && !isOwner(options)) {
        return historyToolError('跨群检索仅机主可用。');
    }
    if (searchArgs.scope === 'chat' && options.channelId === null) {
        return historyToolError('当前是私聊，没有本群归档；scope 只能用 all。');
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

    const statusPromise = archiveStatusOf(options, searchArgs.scope, signal, timeZone);
    const searched = await options.service
        .search({
            channelId: searchArgs.scope === 'all' ? null : options.channelId,
            query: searchArgs.query,
            senderId: sender.senderId,
            start,
            end,
            limit: searchArgs.limit,
            signal,
            timeoutMs: HISTORY_SEARCH_TIMEOUT_MS,
        })
        .then(
            (outcome): SearchAttempt => ({ ok: true, outcome }),
            (error: unknown): SearchAttempt => ({ ok: false, error })
        );
    const status = await statusPromise;
    if (!searched.ok) return historyToolError(describeFailure(searched.error));
    const outcome = searched.outcome;

    const hits = outcome.hits.slice(0, searchArgs.limit);
    const scopeLabel = searchArgs.scope === 'all' ? '全部归档群' : '本群';
    const conditions = [
        searchArgs.query ? `query="${searchArgs.query}"` : '最近消息',
        from.seconds === null && to.seconds === null ? null : `时间 ${searchArgs.from ?? '…'}–${searchArgs.to ?? '…'}`,
        searchArgs.sender ? `发言人 ${searchArgs.sender}` : null,
    ].filter((part): part is string => part !== null);

    if (hits.length === 0) {
        const narrowed =
            searchArgs.sender !== null ||
            searchArgs.from !== null ||
            searchArgs.to !== null ||
            searchArgs.before !== null;
        const empty = `历史检索：${conditions.join('，')}，范围=${scopeLabel}，没有找到匹配的历史消息。${latinMissHintOf(searchArgs.query, narrowed)}`;
        return historyToolSuccess(status === null ? empty : `${empty}\n${status}`, {
            argument: traceArgument,
            result: '无命中',
        });
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
            fromIsBot: message?.senderIsBot ?? (hit.fromId !== null && hit.fromId === options.botUserId),
            fromSelf: hit.fromId !== null && hit.fromId === options.botUserId,
            indexedHtml: hit.html,
            deletedAt: hit.deletedAt,
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
            buildSearchRow(
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
            matched: outcome.hasMore ? `${searchArgs.limit}+` : String(rows.length),
            hasMore: outcome.hasMore,
            ...(last ? { beforeHint: `h${last.entry.h}` } : {}),
            showGroup: searchArgs.scope === 'all',
            ...(status === null ? {} : { status }),
        },
        rows,
        timeZone,
        searchListBudget(searchArgs.limit)
    );
    return historyToolSuccess(text, {
        argument: traceArgument,
        result: `${hits.length}${outcome.hasMore ? '+' : ''} 条命中`,
    });
};

const recoverFromTelegram = async (
    options: HistoryToolOptions,
    channelId: number,
    messageId: number,
    signal: AbortSignal,
    groupName: string | undefined
): Promise<ResolveResult> => {
    let raws;
    try {
        raws = await options.service.messages(channelId, [messageId], {
            signal,
            timeoutMs: HISTORY_MESSAGES_TIMEOUT_MS,
        });
    } catch (error) {
        return { error: describeFailure(error) };
    }
    const raw = raws.find((message) => message.messageId === messageId);
    if (raw === undefined) {
        return { error: `归档和 Telegram 都读不到 ${messageLink(channelId, messageId)}（可能已删除）。` };
    }
    return {
        entry: options.state.remember({
            channelId,
            messageId,
            timestamp: raw.date ?? Math.floor(Date.now() / 1000),
            fromId: raw.senderId,
            fromName: raw.senderName || '佚名',
            fromIsBot: raw.senderIsBot,
            fromSelf: raw.senderId !== null && raw.senderId === options.botUserId,
            indexedHtml: '',
            rawText: raw.text,
            entities: raw.entities,
            replyToId: raw.replyToId,
            media: raw.media,
            forward: raw.forward,
            imageCount: raw.imageCount,
            ...(groupName ? { groupName } : {}),
        }),
    };
};

const ensureEntry = async (
    options: HistoryToolOptions,
    channelId: number,
    messageId: number,
    signal: AbortSignal
): Promise<ResolveResult> => {
    const cached = options.state.findByMessage(channelId, messageId);
    if (cached) return { entry: cached };
    try {
        const outcome = await options.service.search({ channelId, ids: [messageId], signal });
        const hit = outcome.hits.find((candidate) => candidate.messageId === messageId);
        const groupName = outcome.groups.get(channelId);
        if (!hit) return recoverFromTelegram(options, channelId, messageId, signal, groupName);
        return {
            entry: options.state.remember({
                channelId: hit.channelId,
                messageId: hit.messageId,
                timestamp: hit.timestamp,
                fromId: hit.fromId,
                fromName: hit.fromName,
                fromIsBot: hit.fromId !== null && hit.fromId === options.botUserId,
                fromSelf: hit.fromId !== null && hit.fromId === options.botUserId,
                indexedHtml: hit.html,
                deletedAt: hit.deletedAt,
                ...(groupName ? { groupName } : {}),
            }),
        };
    } catch (error) {
        return { error: describeFailure(error) };
    }
};

const resolveReference = async (
    options: HistoryToolOptions,
    text: string,
    signal: AbortSignal
): Promise<ResolveResult> => {
    const reference = parseHistoryReference(text);
    if (!reference) return { error: `无法识别的引用「${text}」。${HISTORY_REF_HINT}` };
    if (reference.kind === 'number') {
        const entry = options.state.entryOf(reference.h);
        return entry ? { entry } : { error: `没有 h${reference.h}——它不在本次回复的历史结果里。` };
    }
    if (reference.kind === 'context') {
        const target = options.context.contextIndex.get(reference.number);
        if (!target) return { error: `本轮上下文里没有 #${reference.number}。` };
        if (options.channelId === null) {
            return { error: '当前是私聊，没有本群归档；用 history(action="search") 返回的 hN 读取跨群消息。' };
        }
        return ensureEntry(options, options.channelId, target.messageId, signal);
    }
    if (!isOwner(options) && reference.channelId !== options.channelId) {
        return { error: '只能读取本群的消息。' };
    }
    return ensureEntry(options, reference.channelId, reference.messageId, signal);
};

const loadRaw = async (
    options: HistoryToolOptions,
    entries: readonly HistoryEntry[],
    signal: AbortSignal
): Promise<void> => {
    const byChannel = new Map<number, number[]>();
    for (const entry of entries) {
        if (entry.rawText !== undefined) continue;
        const ids = byChannel.get(entry.channelId);
        if (ids) ids.push(entry.messageId);
        else byChannel.set(entry.channelId, [entry.messageId]);
    }
    for (const [channelId, ids] of byChannel) {
        try {
            const raws = await options.service.messages(channelId, ids, {
                signal,
                timeoutMs: HISTORY_MESSAGES_TIMEOUT_MS,
            });
            for (const raw of raws) {
                const current = options.state.findByMessage(channelId, raw.messageId);
                if (!current) continue;
                options.state.remember({
                    channelId: current.channelId,
                    messageId: current.messageId,
                    timestamp: current.timestamp,
                    fromId: current.fromId,
                    fromName: current.fromName,
                    fromIsBot: raw.senderIsBot || current.fromIsBot,
                    fromSelf: current.fromSelf === true || (raw.senderId !== null && raw.senderId === options.botUserId),
                    indexedHtml: current.indexedHtml,
                    ...(current.groupName ? { groupName: current.groupName } : {}),
                    rawText: raw.text,
                    entities: raw.entities,
                    replyToId: raw.replyToId,
                    media: raw.media,
                    forward: raw.forward,
                    imageCount: raw.imageCount,
                });
            }
        } catch (error) {
            console.warn(`[history:read] /messages failed for ${channelId}: ${describeFailure(error)}`);
        }
    }
};

const readFull = async (
    options: HistoryToolOptions,
    refs: readonly string[],
    folded: boolean,
    signal: AbortSignal,
    trace: ToolCallTrace
): Promise<ToolResult> => {
    const entries: HistoryEntry[] = [];
    const seen = new Set<string>();
    for (const ref of refs) {
        const resolved = await resolveReference(options, ref, signal);
        if ('error' in resolved) return historyToolError(resolved.error);
        const key = messageKey(resolved.entry.channelId, resolved.entry.messageId);
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push(resolved.entry);
    }
    await loadRaw(options, entries, signal);

    const timeZone = historyTimeZoneOf(options);
    const contextNumbers = contextNumbersOf(options.context);
    const currentChannel = options.channelId;
    const blocks: string[] = [];
    let rendered = 0;
    let omitted = 0;
    let used = 0;
    for (const entry of entries) {
        const fresh = options.state.findByMessage(entry.channelId, entry.messageId) ?? entry;
        const anchor = `${anchorFor(contextNumbers, currentChannel, fresh.channelId, fresh.messageId)}`;
        const block = renderFullMessage(fresh, {
            timeZone,
            anchor,
            folded,
            maxChars: MAX_FULL_CHARS_PER_MESSAGE,
            showGroup: fresh.channelId !== currentChannel,
        });
        if (used + block.length > MAX_FULL_CHARS_TOTAL) {
            omitted = entries.length - rendered;
            blocks.push(`（其余 ${omitted} 条因长度省略，可减少 ids 分次读）`);
            break;
        }
        blocks.push(block);
        rendered += 1;
        used += block.length + 2;
    }
    const renderedChars = blocks.slice(0, rendered).reduce((total, block) => total + Array.from(block).length, 0);
    return historyToolSuccess([withNotice('历史阅读：'), ...blocks].join('\n\n'), {
        ...trace,
        result: traceParts(
            `${rendered} 条全文`,
            renderedChars > 0 ? traceChars(renderedChars) : null,
            omitted > 0 ? `省略 ${omitted} 条` : null
        ),
    });
};

const readWindow = async (
    options: HistoryToolOptions,
    around: string,
    minutes: number,
    signal: AbortSignal,
    trace: ToolCallTrace
): Promise<ToolResult> => {
    const resolved = await resolveReference(options, around, signal);
    if ('error' in resolved) return historyToolError(resolved.error);
    const center = resolved.entry;
    const windowSeconds = minutes * 60;
    const windowStart = center.timestamp - windowSeconds;
    const windowEnd = center.timestamp + windowSeconds;

    let earlier;
    let later;
    try {
        [earlier, later] = await Promise.all([
            options.service.search({ channelId: center.channelId, start: windowStart, end: center.timestamp, signal }),
            options.service.search({ channelId: center.channelId, start: center.timestamp, end: windowEnd + 1, signal }),
        ]);
    } catch (error) {
        return historyToolError(describeFailure(error));
    }

    const earlierRows = earlier.hits.slice(0, WINDOW_MAX_PER_SIDE);
    const laterRows = later.hits.slice().sort((a, b) => a.timestamp - b.timestamp).slice(0, WINDOW_MAX_PER_SIDE);

    const ordered: { readonly entry: HistoryEntry; readonly center: boolean }[] = [];
    for (const hit of [...earlierRows].reverse()) {
        ordered.push({
            entry: options.state.remember({
                channelId: hit.channelId,
                messageId: hit.messageId,
                timestamp: hit.timestamp,
                fromId: hit.fromId,
                fromName: hit.fromName,
                fromIsBot: hit.fromId !== null && hit.fromId === options.botUserId,
                fromSelf: hit.fromId !== null && hit.fromId === options.botUserId,
                indexedHtml: hit.html,
                ...(earlier.groups.get(center.channelId) ? { groupName: earlier.groups.get(center.channelId) } : {}),
            }),
            center: false,
        });
    }
    ordered.push({ entry: center, center: true });
    for (const hit of laterRows) {
        ordered.push({
            entry: options.state.remember({
                channelId: hit.channelId,
                messageId: hit.messageId,
                timestamp: hit.timestamp,
                fromId: hit.fromId,
                fromName: hit.fromName,
                fromIsBot: hit.fromId !== null && hit.fromId === options.botUserId,
                fromSelf: hit.fromId !== null && hit.fromId === options.botUserId,
                indexedHtml: hit.html,
                ...(later.groups.get(center.channelId) ? { groupName: later.groups.get(center.channelId) } : {}),
            }),
            center: false,
        });
    }

    await loadRaw(options, ordered.map((item) => item.entry), signal);

    const timeZone = historyTimeZoneOf(options);
    const rows: WindowRow[] = ordered
        .map((item) => {
            const entry = options.state.findByMessage(item.entry.channelId, item.entry.messageId) ?? item.entry;
            const attachments = attachmentLine(entry.indexedHtml, entry.imageCount ?? null);
            return { entry, center: item.center, ...(attachments ? { attachments } : {}) };
        })
        .sort((a, b) => a.entry.timestamp - b.entry.timestamp);

    const notes: string[] = [];
    if (earlier.hits.length > WINDOW_MAX_PER_SIDE) {
        notes.push(`较早一侧还有 ${earlier.hits.length - WINDOW_MAX_PER_SIDE} 条未显示，可缩小 minutes。`);
    }
    if (later.hits.length > WINDOW_MAX_PER_SIDE) {
        notes.push(`较晚一侧还有 ${later.hits.length - WINDOW_MAX_PER_SIDE} 条未显示，可缩小 minutes。`);
    }

    const text = renderWindow(
        {
            minutes,
            fromTime: formatHistoryTime(windowStart, timeZone),
            toTime: formatHistoryTime(windowEnd, timeZone),
            scopeLabel: '本群',
            total: rows.length,
            perMessageChars: WINDOW_CHARS_PER_MESSAGE,
            ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
        },
        rows,
        timeZone,
        WINDOW_CHARS_TOTAL
    );
    return historyToolSuccess(text, { ...trace, result: `${rows.length} 条消息` });
};

/** Keeps the first 3 `hN` tokens within the 56-char trace cap so links remain clickable */
const describeReadArgsTrace = (args: HistoryReadArgs, state: HistoryState): ToolCallTrace => {
    if (args.around !== null) {
        const links = historyRefLinks(state, [args.around]);
        return {
            argument: traceParts(`around ${traceRef(args.around)}`, `${args.minutes} 分钟`),
            ...(links.length > 0 ? { links } : {}),
        };
    }
    const shown = args.refs.slice(0, 3);
    const rest = args.refs.length - shown.length;
    const refs = `${shown.map((ref) => traceRef(ref)).join('、')}${rest > 0 ? `+${rest}` : ''}`;
    const links = historyRefLinks(state, shown);
    return {
        argument: traceParts('read', `${refs}${args.folded ? '（含折叠）' : ''}`),
        ...(links.length > 0 ? { links } : {}),
    };
};

export const executeHistoryRead = async (
    options: HistoryToolOptions,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal
): Promise<ToolResult> => {
    const parsed = parseHistoryReadArgs(args);
    if (!parsed.ok) return historyToolError(parsed.error);
    const readArgs = parsed.value;
    const trace = describeReadArgsTrace(readArgs, options.state);
    if (readArgs.around) {
        return readWindow(options, readArgs.around, readArgs.minutes, signal, trace);
    }
    return readFull(options, readArgs.refs, readArgs.folded, signal, trace);
};

export const summarizeHistoryArgs = (
    args: Readonly<Record<string, unknown>>,
    defaultScope: 'chat' | 'all'
): string => {
    if (args.action === 'read') {
        return JSON.stringify({
            action: 'read',
            ids: Array.isArray(args.ids) ? args.ids.slice(0, HISTORY_MAX_REFS) : (args.ids ?? null),
            around: args.around ?? null,
            minutes: args.minutes ?? null,
            folded: args.folded === true,
        });
    }
    return JSON.stringify({
        action: args.action ?? null,
        query: args.query ?? null,
        sender: args.sender ?? null,
        scope: args.scope ?? defaultScope,
        from: args.from ?? null,
        to: args.to ?? null,
        before: args.before ?? null,
        limit: args.limit ?? null,
    });
};
