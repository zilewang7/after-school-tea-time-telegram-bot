/**
 * What both history tools need: options, failure wording, ids and anchors.
 */
import type { ToolHandler, ToolResult } from '../../ai/tools/tool-types.js';
import { HistoryRequestError, type HistoryService } from '../../services/luoxu-history-service.js';
import { HISTORY_DEFAULT_TIME_ZONE } from './history-args.js';
import type { HistoryState } from './history-state.js';
import type { ReplyToolContext } from './reply-tool-context.js';

export interface HistoryToolOptions {
    readonly state: HistoryState;
    readonly context: ReplyToolContext;
    readonly service: HistoryService;
    /** luoxu channel id of the current chat; null when this chat is not archived */
    readonly channelId: number | null;
    readonly ownerUserId: number | null;
    readonly botUserId: number | null;
    readonly timeZone?: string;
}

export const historyTimeZoneOf = (options: HistoryToolOptions): string =>
    options.timeZone ?? (process.env.TZ || HISTORY_DEFAULT_TIME_ZONE);

export const describeFailure = (error: unknown): string => {
    if (error instanceof HistoryRequestError) {
        switch (error.kind) {
            case 'bad-query':
                return `查询语法有误（${error.detail}），可简化后重试。`;
            case 'not-indexed':
                return '这个聊天没有归档索引。';
            case 'missing':
                return '这条消息在归档里读不到了（可能已删除）。';
            case 'unavailable':
                return `检索服务暂时不可用（${error.detail}）。`;
        }
    }
    return `检索失败：${error instanceof Error ? error.message : String(error)}。`;
};

export const messageKey = (channelId: number, messageId: number): string => `${channelId}:${messageId}`;

export const isOwner = (options: HistoryToolOptions): boolean =>
    options.ownerUserId !== null && options.context.requester.userId === options.ownerUserId;

/** `#N` → messageId, for the messages this turn already shows */
export const contextNumbersOf = (context: ReplyToolContext): Map<number, number> => {
    const numbers = new Map<number, number>();
    for (const entry of context.contextIndex.values()) numbers.set(entry.messageId, entry.number);
    return numbers;
};

/**
 * A hit's anchor: `#N` when this turn already shows the message, else a link.
 * Cross-group refs are never numbered.
 */
export const anchorFor = (
    contextNumbers: ReadonlyMap<number, number>,
    currentChannel: number | null,
    channelId: number,
    messageId: number
): string => {
    if (channelId === currentChannel) {
        const number = contextNumbers.get(messageId);
        if (number !== undefined) return `#${number}`;
    }
    return messageLink(channelId, messageId);
};

export const messageLink = (channelId: number, messageId: number): string =>
    `https://t.me/c/${channelId}/${messageId}`;

const LOG_ARG_CHARS = 160;

/**
 * One log line per call: which tool, which chat, the arguments that shape the
 * query, how long it took and whether it degraded. This is the only way to
 * see later whether the model searches, reads, or gives up.
 */
export const withHistoryLogging = (
    handler: ToolHandler,
    chatId: number,
    summarize: (args: Readonly<Record<string, unknown>>) => string
): ToolHandler => ({
    ...handler,
    execute: async (args, signal): Promise<ToolResult> => {
        const startedAt = Date.now();
        const result = await handler.execute(args, signal);
        const elapsed = Date.now() - startedAt;
        const argsText = Array.from(summarize(args)).slice(0, LOG_ARG_CHARS).join('');
        const outcome = result.isError
            ? `error="${Array.from(result.content).slice(0, LOG_ARG_CHARS).join('')}"`
            : `chars=${result.content.length}`;
        console.log(
            `[history] ${handler.definition.name} chat=${chatId} ${argsText} ${elapsed}ms ${outcome}`
        );
        return result;
    },
});
