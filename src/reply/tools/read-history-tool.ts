/**
 * read_history: the expensive half of the archive tools.
 *
 * Two shapes, one tool: `ids` reads whole index texts (preview, Instant View,
 * OCR included), `around` reads the conversation around a message in time —
 * the primitive that makes a lexical hit actionable, because a group message
 * on its own is often just a dozen words.
 *
 * Bot messages carry their folded thinking and Tools blocks in the same text.
 * By default those are collapsed to one marker that keeps the first line (50
 * chars), which is enough to tell what the reasoning was about without putting
 * the whole chain back into context; `folded=true` returns it raw.
 */
import type { ToolHandler, ToolResult } from '../../ai/tools/tool-types.js';
import { HISTORY_MESSAGES_TIMEOUT_MS } from '../../services/luoxu-history-service.js';
import { parseHistoryReadArgs, parseHistoryReference, HISTORY_REF_HINT } from './history-args.js';
import {
    attachmentSummary,
    formatHistoryTime,
    renderFullMessage,
    renderWindow,
    withNotice,
    type WindowRow,
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
    messageLink,
    withHistoryLogging,
    type HistoryToolOptions,
} from './history-tool-shared.js';
import { READ_HISTORY_TOOL_NAME } from './tool-names.js';

const DESCRIPTION =
    '读取历史归档里某条消息的完整索引文本（含网页预览、Instant View 正文、图片 OCR），或读取某条消息前后一段时间内的对话。' +
    'ids 接受 hN（本回复中出现过的编号）、#N（上下文里的编号）与 https://t.me/c/... 链接，一次最多 4 条；around 接受同样的引用，minutes 默认 10 分钟。' +
    'bot 自己的回复以折叠块形式带思考过程与工具记录，默认省略为一行（保留首行 50 字），folded=true 时原样返回。';

const INPUT_SCHEMA = {
    type: 'object',
    properties: {
        ids: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 4,
            description: '要读全文的引用：hN、#N 或 https://t.me/c/... 链接。与 around 二选一。',
        },
        around: {
            type: 'string',
            description: '以这条消息为中心读前后对话：hN、#N 或 https://t.me/c/... 链接。与 ids 二选一。',
        },
        minutes: {
            type: 'integer',
            minimum: 1,
            maximum: 120,
            description: 'around 的时间半径，默认 10 分钟。',
        },
        folded: {
            type: 'boolean',
            description: 'true = bot 自己回复里的折叠块原样返回（默认省略为一行，保留首行 50 字）。',
        },
    },
};

const MAX_FULL_CHARS_PER_MESSAGE = 4000;
const MAX_FULL_CHARS_TOTAL = 12000;
const WINDOW_CHARS_PER_MESSAGE = 300;
const WINDOW_CHARS_TOTAL = 10000;
const WINDOW_MAX_PER_SIDE = 20;

type ResolveResult = { readonly entry: HistoryEntry } | { readonly error: string };

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
        if (!hit) {
            return { error: `没有找到 ${messageLink(channelId, messageId)}（可能已删除，或不在归档里）。` };
        }
        const groupName = outcome.groups.get(channelId);
        return {
            entry: options.state.remember({
                channelId: hit.channelId,
                messageId: hit.messageId,
                timestamp: hit.timestamp,
                fromId: hit.fromId,
                fromName: hit.fromName,
                fromIsBot: hit.fromId !== null && hit.fromId === options.botUserId,
                indexedHtml: hit.html,
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
        if (options.channelId === null) return { error: '这个聊天没有归档索引。' };
        return ensureEntry(options, options.channelId, target.messageId, signal);
    }
    if (!isOwner(options) && reference.channelId !== options.channelId) {
        return { error: '只能读取本群的消息。' };
    }
    return ensureEntry(options, reference.channelId, reference.messageId, signal);
};

/** Give every entry its raw text/entities, so folded blocks can be located */
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
                    indexedHtml: current.indexedHtml,
                    ...(current.groupName ? { groupName: current.groupName } : {}),
                    rawText: raw.text,
                    entities: raw.entities,
                    replyToId: raw.replyToId,
                });
            }
        } catch (error) {
            console.warn(`[read_history] /messages failed for ${channelId}: ${describeFailure(error)}`);
        }
    }
};

const readFull = async (
    options: HistoryToolOptions,
    refs: readonly string[],
    folded: boolean,
    signal: AbortSignal
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
            blocks.push(`（其余 ${entries.length - blocks.length} 条因长度省略，可减少 ids 分次读）`);
            break;
        }
        blocks.push(block);
        used += block.length + 2;
    }
    return historyToolSuccess([withNotice('历史阅读：'), ...blocks].join('\n\n'));
};

const readWindow = async (
    options: HistoryToolOptions,
    around: string,
    minutes: number,
    signal: AbortSignal
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
            options.service.search({
                channelId: center.channelId,
                start: windowStart,
                end: center.timestamp,
                signal,
            }),
            options.service.search({
                channelId: center.channelId,
                start: center.timestamp,
                end: windowEnd + 1,
                signal,
            }),
        ]);
    } catch (error) {
        return historyToolError(describeFailure(error));
    }

    const earlierRows = earlier.hits.slice(0, WINDOW_MAX_PER_SIDE);
    const laterRows = later.hits
        .slice()
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(0, WINDOW_MAX_PER_SIDE);

    const timeZone = historyTimeZoneOf(options);
    const rows: WindowRow[] = [];
    const windowRow = (entry: HistoryEntry, center: boolean): WindowRow => {
        const attachments = attachmentSummary(entry.indexedHtml);
        return {
            entry,
            center,
            ...(attachments ? { attachments } : {}),
        };
    };

    for (const hit of [...earlierRows].reverse()) {
        const groupName = earlier.groups.get(center.channelId);
        const entry = options.state.remember({
            channelId: hit.channelId,
            messageId: hit.messageId,
            timestamp: hit.timestamp,
            fromId: hit.fromId,
            fromName: hit.fromName,
            fromIsBot: hit.fromId !== null && hit.fromId === options.botUserId,
            indexedHtml: hit.html,
            ...(groupName ? { groupName } : {}),
        });
        rows.push(windowRow(entry, false));
    }
    rows.push(windowRow(center, true));
    for (const hit of laterRows) {
        const groupName = later.groups.get(center.channelId);
        const entry = options.state.remember({
            channelId: hit.channelId,
            messageId: hit.messageId,
            timestamp: hit.timestamp,
            fromId: hit.fromId,
            fromName: hit.fromName,
            fromIsBot: hit.fromId !== null && hit.fromId === options.botUserId,
            indexedHtml: hit.html,
            ...(groupName ? { groupName } : {}),
        });
        rows.push(windowRow(entry, false));
    }
    rows.sort((a, b) => a.entry.timestamp - b.entry.timestamp);

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
    return historyToolSuccess(text);
};

const summarizeReadArgs = (args: Readonly<Record<string, unknown>>): string =>
    JSON.stringify({
        ids: Array.isArray(args.ids) ? args.ids.slice(0, 4) : (args.ids ?? null),
        around: args.around ?? null,
        minutes: args.minutes ?? null,
        folded: args.folded === true,
    });

const handlerOf = (options: HistoryToolOptions): ToolHandler => ({
    definition: {
        name: READ_HISTORY_TOOL_NAME,
        description: DESCRIPTION,
        inputSchema: INPUT_SCHEMA,
    },
    statusText: '读聊天记录',
    chatAction: 'typing',
    execute: async (args, signal): Promise<ToolResult> => {
        const parsed = parseHistoryReadArgs(args);
        if (!parsed.ok) return historyToolError(parsed.error);
        const readArgs = parsed.value;
        if (readArgs.around) {
            return readWindow(options, readArgs.around, readArgs.minutes, signal);
        }
        return readFull(options, readArgs.refs, readArgs.folded, signal);
    },
});

export const createReadHistoryTool = (options: HistoryToolOptions): ToolHandler =>
    withHistoryLogging(handlerOf(options), options.context.chatId, summarizeReadArgs);
