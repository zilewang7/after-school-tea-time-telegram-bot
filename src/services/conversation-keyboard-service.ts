/**
 * The in-chat receipt of a panel operation (design 2026-1119-2016 §4.7): the
 * `/panel` message that opened a conversation gets the operation appended to
 * its text, so the chat shows what the panel just did.
 *
 * Best effort throughout: a restart, a deleted message or a failing Bot API
 * call only mean nobody sees the line; the operation itself is never affected.
 * Callers fire and forget.
 */
import type { Api } from 'grammy';
import { match } from 'ts-pattern';
import { findRootMessage } from '../db/queries/context-queries.js';
import {
    appendConversationKeyboardOperation,
    dropConversationKeyboardMessage,
    hasConversationKeyboardMessages,
} from '../state.js';

const NOT_MODIFIED = 'message is not modified';
const MESSAGE_NOT_FOUND = 'message to edit not found';
const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

/** HH:MM in the bot's time zone */
const clockOf = (now: number): string => {
    const timeZone = process.env.TZ || DEFAULT_TIME_ZONE;
    return new Intl.DateTimeFormat('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone,
    }).format(new Date(now));
};

const lineOf = (text: string, now: number): string => `· ${text}（${clockOf(now)}）`;

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The message text after appending one operation line */
const textWith = (baseText: string, ops: readonly string[]): string => `${baseText}\n${ops.join('\n')}`;

const editReceipt = async (botApi: Api, chatId: number, rootId: number, line: string, now: number): Promise<void> => {
    const entry = appendConversationKeyboardOperation(chatId, rootId, line, now);
    if (entry === undefined) return;
    try {
        // No reply_markup: Telegram keeps the message's buttons
        await botApi.editMessageText(entry.chatId, entry.messageId, textWith(entry.baseText, entry.ops));
    } catch (error) {
        const message = describeError(error);
        if (message.includes(MESSAGE_NOT_FOUND)) {
            dropConversationKeyboardMessage(chatId, rootId);
            return;
        }
        if (message.includes(NOT_MODIFIED)) return;
        console.warn(`[panel] the conversation receipt ${entry.chatId}/${entry.messageId} was not updated: ${message}`);
    }
};

export type ConversationOperationKind = 'exclude' | 'restore' | 'splice';

const operationTextOf = (kind: ConversationOperationKind, count: number): string =>
    match(kind)
        .with('exclude', () => `已排除 ${count} 条消息`)
        .with('restore', () => `已恢复 ${count} 条消息`)
        .with('splice', () => `已拼接 ${count} 段对话`)
        .exhaustive();

export interface ExclusionReceiptInput {
    chatId: number;
    /** Canonical ids that really changed state */
    messageIds: readonly number[];
    action: 'exclude' | 'restore';
    /** The bot's own Api; null (tests, no api) disables receipts */
    botApi: Api | null;
    /** Clock in ms; defaults to Date.now */
    now?: () => number;
}

/**
 * Report an exclusion write on the receipts of the conversations its messages
 * belong to (normally one). Never throws.
 */
export const reportExclusionReceipt = async (input: ExclusionReceiptInput): Promise<void> => {
    if (input.botApi === null || input.messageIds.length === 0) return;
    if (!hasConversationKeyboardMessages(input.chatId)) return;
    const botApi = input.botApi;
    const now = input.now?.() ?? Date.now();
    try {
        const countsByRoot = new Map<number, number>();
        for (const messageId of input.messageIds) {
            const root = await findRootMessage(input.chatId, messageId, { recover: false });
            if (root === null) continue;
            countsByRoot.set(root.messageId, (countsByRoot.get(root.messageId) ?? 0) + 1);
        }
        for (const [rootId, count] of countsByRoot) {
            await editReceipt(botApi, input.chatId, rootId, lineOf(operationTextOf(input.action, count), now), now);
        }
    } catch (error) {
        console.warn(`[panel] the exclusion receipt of chat ${input.chatId} failed: ${describeError(error)}`);
    }
};

export interface SpliceReceiptInput {
    chatId: number;
    rootId: number;
    /** How many conversations were attached */
    attachedRoots: number;
    /** The bot's own Api; null (tests, no api) disables receipts */
    botApi: Api | null;
    /** Clock in ms; defaults to Date.now */
    now?: () => number;
}

/** Report a conversation splice on that conversation's own receipt. Never throws. */
export const reportSpliceReceipt = async (input: SpliceReceiptInput): Promise<void> => {
    if (input.botApi === null || input.attachedRoots < 1) return;
    if (!hasConversationKeyboardMessages(input.chatId)) return;
    const now = input.now?.() ?? Date.now();
    try {
        await editReceipt(
            input.botApi,
            input.chatId,
            input.rootId,
            lineOf(operationTextOf('splice', input.attachedRoots), now),
            now
        );
    } catch (error) {
        console.warn(`[panel] the splice receipt of chat ${input.chatId} failed: ${describeError(error)}`);
    }
};
