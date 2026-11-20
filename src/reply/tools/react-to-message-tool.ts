/**
 * react_to_message: the bot's own emoji reaction, as a tool.
 *
 * A reaction is lighter than a message ("got it", "agreed", a laugh) and lands
 * on the message the model read, named by its `#N`. One reaction per message
 * per bot, so setting another replaces it; `emoji` omitted cancels it.
 *
 * Two ids are deliberately kept apart:
 * - the Telegram target: a bot reply's `#N` opens the body of the *current*
 *   version (long-CoT replies lead with the CoT link, a version switch lays the
 *   same version out under new ids), resolved by findBotReplyBodyMessageIds;
 * - the stored id: the DB keys rows by the reply's stored first id — the id
 *   context numbering uses — so the runtime block shows the reaction on `#N`.
 *
 * The Bot API reports no update for a bot's own reaction, so the row is written
 * here (replaceBotReaction). That write is the model-facing copy, not the
 * source of truth: when it fails the Telegram side keeps the reaction and the
 * tool only warns.
 */
import { GrammyError } from 'grammy';
import type { ReactionType } from 'grammy/types';
import type { ToolCallTrace, ToolHandler, ToolResult } from '../../ai/tools/tool-types.js';
import { findBotReplyBodyMessageIds } from '../../db/queries/bot-reply-body-queries.js';
import { replaceBotReaction } from '../../db/queries/reaction-queries.js';
import { toTelegramApiAbortSignal } from '../../services/telegram-file-service.js';
import {
    isReactionEmoji,
    REACTION_EMOJIS,
    type ReactionEmoji,
} from '../../shared/reaction-emoji.js';
import type { ContextIndex, ContextIndexEntry } from '../context-index.js';
import type { ReplyToolContext } from './reply-tool-context.js';
import { REACT_TO_MESSAGE_TOOL_NAME } from './tool-names.js';
import { traceText } from './tool-trace.js';

const DESCRIPTION =
    '给本段对话中的一条消息加一个 Telegram emoji reaction（轻量回应：收到、赞同、😂 等），而不是发一条消息。' +
    'message 用该消息的 #N；emoji 必须是 Telegram 标准 reaction 表情之一（👍 ❤ 🔥 🎉 😂 😢 🤔 👀 💯 …）。' +
    '省略 emoji 表示取消你自己此前加的 reaction。每条消息你只能有一个 reaction，再设会替换。';

const INPUT_SCHEMA = {
    type: 'object',
    properties: {
        message: {
            type: 'integer',
            description: '消息在本次上下文中的编号 #N（不带 #）',
        },
        emoji: {
            type: 'string',
            enum: REACTION_EMOJIS,
            description: '要设置的 reaction；省略此参数 = 取消你自己加的 reaction',
        },
    },
    required: ['message'],
};

/** Telegram's own words on a refused call, cut so a long one cannot flood the model */
const API_DESCRIPTION_MAX_CHARS = 200;

/** What replaceBotReaction returns for the row state before the write */
export interface BotReactionWriteResult {
    readonly previousEmoji: string | null;
}

/** The row writer; a test injects a failing one to cover the write-failure path */
export type WriteBotReaction = (
    chatId: number,
    canonicalMessageId: number,
    emoji: string | null
) => Promise<BotReactionWriteResult>;

export interface ReactToMessageDependencies {
    readonly writeReaction?: WriteBotReaction;
}

interface ReactToMessageArgs {
    readonly messageNumber: number;
    /** null = cancel the bot's own reaction */
    readonly emoji: ReactionEmoji | null;
}

type ParsedArgs =
    | { readonly ok: true; readonly value: ReactToMessageArgs }
    | { readonly ok: false; readonly error: string };

/** Emoji omitted, null or blank all mean "cancel"; otherwise only the standard set */
type ParsedEmoji =
    | { readonly ok: true; readonly value: ReactionEmoji | null }
    | { readonly ok: false };

const okEmoji = (value: ReactionEmoji | null): ParsedEmoji => ({ ok: true, value });

const INVALID_EMOJI = '只支持 Telegram 标准 reaction 表情（如 👍 ❤ 😂 🤔）；要取消就省略 emoji。';

const parseEmoji = (raw: unknown): ParsedEmoji => {
    if (raw === undefined || raw === null) return okEmoji(null);
    if (typeof raw !== 'string') return { ok: false };
    const trimmed = raw.trim();
    if (trimmed === '') return okEmoji(null);
    return isReactionEmoji(trimmed) ? okEmoji(trimmed) : { ok: false };
};

const parseArgs = (raw: Readonly<Record<string, unknown>>): ParsedArgs => {
    const message = raw.message;
    if (typeof message !== 'number' || !Number.isSafeInteger(message)) {
        return { ok: false, error: '参数有误：message 要传整数（#N 里的数字）。' };
    }
    const emoji = parseEmoji(raw.emoji);
    if (!emoji.ok) return { ok: false, error: INVALID_EMOJI };
    return { ok: true, value: { messageNumber: message, emoji: emoji.value } };
};

/** The candidate range is stated, so the model does not guess a number next time */
const missingMessageText = (messageNumber: number, index: ContextIndex): string => {
    const numbers = [...index.keys()];
    if (numbers.length === 0) return `本次上下文没有 #${messageNumber} 这条消息。`;
    return `本次上下文没有 #${messageNumber} 这条消息（可用编号 #1–#${Math.max(...numbers)}）`;
};

const excerptByCodePoints = (text: string, maxChars: number): string => {
    const characters = Array.from(text);
    return characters.length <= maxChars ? text : `${characters.slice(0, maxChars).join('')}…`;
};

const errorMessageOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

/** Telegram's two ways of saying the target no longer exists */
const isDeletedTargetError = (error: GrammyError): boolean =>
    error.error_code === 400 &&
    (error.description.includes('message to react not found') ||
        error.description.includes('MESSAGE_ID_INVALID'));

const describeApiFailure = (error: unknown): string => {
    if (!(error instanceof GrammyError)) {
        return `设置 reaction 失败：${excerptByCodePoints(
            errorMessageOf(error),
            API_DESCRIPTION_MAX_CHARS
        )}`;
    }
    if (isDeletedTargetError(error)) return '那条消息已被删除，无法点 reaction。';
    return `设置 reaction 失败（Telegram：${excerptByCodePoints(
        error.description,
        API_DESCRIPTION_MAX_CHARS
    )}）。`;
};

const reactionOf = (emoji: ReactionEmoji | null): ReactionType[] =>
    emoji === null ? [] : [{ type: 'emoji', emoji }];

/**
 * Where the Bot API call lands: the message itself for a user message, the
 * current version's body for a bot reply. The layout read may fail (the
 * BotResponse was cleaned up, or has no version row yet); the canonical id is
 * still worth trying rather than refusing the call.
 */
const resolveApiTargetMessageId = async (
    context: ReplyToolContext,
    entry: ContextIndexEntry
): Promise<number> => {
    if (!entry.fromBot) return entry.messageId;
    try {
        const bodyMessageIds = await findBotReplyBodyMessageIds(context.chatId, [entry.messageId]);
        return bodyMessageIds.get(entry.messageId) ?? entry.messageId;
    } catch (error) {
        console.warn(
            `[reaction] could not resolve the body message of ${context.chatId}/${entry.messageId}: ` +
                errorMessageOf(error)
        );
        return entry.messageId;
    }
};

/**
 * The write is the model-facing copy only: the reaction is already live in the
 * chat, so a failure returns `undefined` (previous state unknown) and the tool
 * still reports success.
 */
const writeReactionOrWarn = async (
    writeReaction: WriteBotReaction,
    context: ReplyToolContext,
    canonicalMessageId: number,
    emoji: ReactionEmoji | null
): Promise<string | null | undefined> => {
    try {
        const written = await writeReaction(context.chatId, canonicalMessageId, emoji);
        return written.previousEmoji;
    } catch (error) {
        console.warn(
            `[reaction] failed to store the bot reaction ${context.chatId}/${canonicalMessageId}: ` +
                errorMessageOf(error)
        );
        return undefined;
    }
};

/** `undefined` = the write failed, so the previous state is unknown */
const successContent = (
    messageNumber: number,
    emoji: ReactionEmoji | null,
    previousEmoji: string | null | undefined
): string => {
    const reference = `#${messageNumber}`;
    if (emoji === null) {
        if (previousEmoji === undefined) return `已取消你在 ${reference} 上的 reaction。`;
        if (previousEmoji === null) return `${reference} 上没有你加的 reaction。`;
        return `已取消你在 ${reference} 上的 ${previousEmoji}。`;
    }
    if (previousEmoji === emoji) return `${reference} 上已经是 ${emoji}。`;
    if (previousEmoji !== null && previousEmoji !== undefined) {
        return `已把 ${reference} 的 ${previousEmoji} 换成 ${emoji}。`;
    }
    return `已给 ${reference} 设置 ${emoji}。`;
};

const traceOf = (messageNumber: number, emoji: ReactionEmoji | null): ToolCallTrace => ({
    argument: traceText(`#${messageNumber} ${emoji ?? '取消'}`),
    result: emoji === null ? '已取消' : '已设置',
});

const failed = (content: string): ToolResult => ({
    content,
    isError: true,
    images: [],
    record: null,
});

const succeeded = (content: string, trace: ToolCallTrace): ToolResult => ({
    content,
    isError: false,
    images: [],
    record: null,
    trace,
});

export const createReactToMessageTool = (
    context: ReplyToolContext,
    dependencies: ReactToMessageDependencies = {}
): ToolHandler => {
    const writeReaction: WriteBotReaction = dependencies.writeReaction ?? replaceBotReaction;

    return {
        definition: {
            name: REACT_TO_MESSAGE_TOOL_NAME,
            description: DESCRIPTION,
            inputSchema: INPUT_SCHEMA,
        },
        statusText: '💬 正在设置 reaction…',
        execute: async (rawArgs) => {
            const parsed = parseArgs(rawArgs);
            if (!parsed.ok) return failed(parsed.error);

            const { messageNumber, emoji } = parsed.value;
            const entry = context.contextIndex.get(messageNumber);
            if (entry === undefined) return failed(missingMessageText(messageNumber, context.contextIndex));

            const apiTargetMessageId = await resolveApiTargetMessageId(context, entry);
            try {
                await context.api.setMessageReaction(
                    context.chatId,
                    apiTargetMessageId,
                    reactionOf(emoji),
                    undefined,
                    toTelegramApiAbortSignal(context.signal)
                );
            } catch (error) {
                return failed(describeApiFailure(error));
            }

            const previousEmoji = await writeReactionOrWarn(
                writeReaction,
                context,
                entry.messageId,
                emoji
            );
            return succeeded(successContent(messageNumber, emoji, previousEmoji), traceOf(messageNumber, emoji));
        },
    };
};
