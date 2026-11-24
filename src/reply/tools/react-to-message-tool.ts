/**
 * react_to_message: the bot's own emoji reactions, as a tool.
 *
 * A reaction is lighter than a message ("got it", "agreed", a laugh) and lands
 * on the message the model read, named by its `#N`. One reaction per message
 * per bot, so setting another replaces it; `emoji` omitted cancels it.
 *
 * One call can name one message (`message`), several with the same emoji
 * (`messages`) or several with their own (`reactions`); the two batch forms are
 * handed to reaction-batch, one item runs through the same path the single form
 * always took. Only one of the three may appear: a call mixing them is refused
 * before any API call.
 *
 * Two ids are deliberately kept apart:
 * - the Telegram target: a bot reply's `#N` opens the body of the *current*
 *   version (long-CoT replies lead with the CoT link, a version switch lays the
 *   same version out under new ids), resolved by findBotReplyBodyMessageIds;
 * - the stored id: the DB keys rows by the reply's stored first id — the id
 *   context numbering uses — so the runtime block shows the reaction on `#N`.
 * The row also snapshots which part of the reply the target message is (read
 * from the delivery ledger), so a reaction on a sticker reply reads as the
 * sticker, not as the body.
 *
 * The Bot API cannot tell "already in this state" from a refusal: Telegram
 * answers a no-op reaction with 400 `message is not modified`, which both forms
 * treat as success (the state the call asked for is the state in the chat).
 *
 * The Bot API reports no update for a bot's own reaction, so the rows are
 * written here (replaceBotReaction / replaceBotReactions). That write is the
 * model-facing copy, not the source of truth: when it fails the Telegram side
 * keeps the reaction and the tool only warns.
 */
import type { ToolCallTrace, ToolHandler, ToolResult } from '../../ai/tools/tool-types.js';
import { findBotReplyBodyMessageIds } from '../../db/queries/bot-reply-body-queries.js';
import {
    replaceBotReaction,
    replaceBotReactions,
    type BotReactionSource,
} from '../../db/queries/reaction-queries.js';
import { toTelegramApiAbortSignal } from '../../services/telegram-file-service.js';
import {
    isReactionEmoji,
    REACTION_EMOJIS,
    type ReactionEmoji,
} from '../../shared/reaction-emoji.js';
import { runApiCall } from '../../telegram/edit-coordinator.js';
import type { ContextIndex, ContextIndexEntry } from '../context-index.js';
import {
    describeApiFailure,
    errorMessageOf,
    isNotModifiedError,
    REACTION_BATCH_MAX,
    reactionOf,
    resolveReactionSource,
    runReactionBatch,
    type ReactionBatchItem,
    type WriteBotReactions,
} from './reaction-batch.js';
import type { ReplyToolContext } from './reply-tool-context.js';
import { REACT_TO_MESSAGE_TOOL_NAME } from './tool-names.js';
import { traceText } from './tool-trace.js';

const DESCRIPTION =
    '给消息加/换/取消 Telegram emoji reaction（不发消息；每消息1个，再设替换，省 emoji 取消）。' +
    'message（单条）、messages（同表情≤6）、reactions（各别表情≤6）三选一。';

const INPUT_SCHEMA = {
    type: 'object',
    properties: {
        message: { type: 'integer', description: '单条消息 #N（不带 #）' },
        messages: {
            type: 'array',
            items: { type: 'integer' },
            minItems: 1,
            maxItems: REACTION_BATCH_MAX,
            description: `同表情批量 #N（≤${REACTION_BATCH_MAX}，用顶层 emoji）`,
        },
        reactions: {
            type: 'array',
            minItems: 1,
            maxItems: REACTION_BATCH_MAX,
            description: `分别设置（≤${REACTION_BATCH_MAX}，每项 {message, emoji?}）`,
            items: {
                type: 'object',
                properties: {
                    message: { type: 'integer' },
                    emoji: { type: 'string' },
                },
                required: ['message'],
            },
        },
        emoji: {
            type: 'string',
            enum: REACTION_EMOJIS,
            description: '标准 reaction emoji（单数/messages 用，省=取消）',
        },
    },
};

/** What replaceBotReaction returns for the row state before the write */
export interface BotReactionWriteResult {
    readonly previousEmoji: string | null;
}

/** The single-row writer; a test injects a failing one to cover that path */
export type WriteBotReaction = (
    chatId: number,
    canonicalMessageId: number,
    emoji: string | null,
    source?: BotReactionSource
) => Promise<BotReactionWriteResult>;

export interface ReactToMessageDependencies {
    readonly writeReaction?: WriteBotReaction;
    /** The batch writer; a test injects a failing one to cover that path */
    readonly writeReactions?: WriteBotReactions;
}

/** Emoji omitted, null or blank all mean "cancel"; otherwise only the standard set */
type ParsedEmoji =
    | { readonly ok: true; readonly value: ReactionEmoji | null }
    | { readonly ok: false };

type ParsedArgs =
    | { readonly ok: true; readonly mode: 'single'; readonly item: ReactionBatchItem }
    | { readonly ok: true; readonly mode: 'batch'; readonly items: readonly ReactionBatchItem[] }
    | { readonly ok: false; readonly error: string };

const okEmoji = (value: ReactionEmoji | null): ParsedEmoji => ({ ok: true, value });

const INVALID_EMOJI = '只支持 Telegram 标准 reaction 表情（如 👍 ❤ 🤣 🤔）；要取消就省略 emoji。';

const integerOf = (value: unknown): number | null =>
    typeof value === 'number' && Number.isSafeInteger(value) ? value : null;

/** Object.fromEntries keeps the record without an `as` cast on model input */
const asRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : null;

const parseEmoji = (raw: unknown): ParsedEmoji => {
    if (raw === undefined || raw === null) return okEmoji(null);
    if (typeof raw !== 'string') return { ok: false };
    const trimmed = raw.trim();
    if (trimmed === '') return okEmoji(null);
    return isReactionEmoji(trimmed) ? okEmoji(trimmed) : { ok: false };
};

const parseSingleForm = (raw: Readonly<Record<string, unknown>>): ParsedArgs => {
    const messageNumber = integerOf(raw.message);
    if (messageNumber === null) {
        return { ok: false, error: '参数有误：message 要传整数（#N 里的数字）。' };
    }
    const emoji = parseEmoji(raw.emoji);
    if (!emoji.ok) return { ok: false, error: INVALID_EMOJI };
    return { ok: true, mode: 'single', item: { messageNumber, emoji: emoji.value } };
};

const parseMessagesForm = (raw: Readonly<Record<string, unknown>>): ParsedArgs => {
    const messages = raw.messages;
    if (!Array.isArray(messages)) {
        return { ok: false, error: '参数有误：messages 要是消息编号数组，如 [3,4,5]。' };
    }
    const messageNumbers: number[] = [];
    for (const message of messages) {
        const messageNumber = integerOf(message);
        if (messageNumber === null) {
            return { ok: false, error: '参数有误：messages 里的每一项都要是整数编号。' };
        }
        messageNumbers.push(messageNumber);
    }
    const emoji = parseEmoji(raw.emoji);
    if (!emoji.ok) return { ok: false, error: INVALID_EMOJI };
    if (messageNumbers.length === 0) return { ok: false, error: '参数有误：messages 不能为空。' };
    if (messageNumbers.length > REACTION_BATCH_MAX) {
        return {
            ok: false,
            error: `参数有误：一次最多 ${REACTION_BATCH_MAX} 条（messages 有 ${messageNumbers.length} 条）。`,
        };
    }
    return {
        ok: true,
        mode: 'batch',
        items: messageNumbers.map((messageNumber) => ({ messageNumber, emoji: emoji.value })),
    };
};

const parseReactionsForm = (raw: Readonly<Record<string, unknown>>): ParsedArgs => {
    const topEmoji = raw.emoji;
    const topEmojiGiven =
        topEmoji !== undefined &&
        topEmoji !== null &&
        !(typeof topEmoji === 'string' && topEmoji.trim() === '');
    if (topEmojiGiven) {
        return { ok: false, error: '参数有误：reactions 形态每条自带 emoji，不要再传顶层 emoji。' };
    }
    const reactions = raw.reactions;
    if (!Array.isArray(reactions)) {
        return {
            ok: false,
            error: "参数有误：reactions 要是对象数组，如 [{message:3,emoji:'👍'},{message:5}]。",
        };
    }
    const items: ReactionBatchItem[] = [];
    for (const [index, reaction] of reactions.entries()) {
        const record = asRecord(reaction);
        if (record === null) {
            return {
                ok: false,
                error: `参数有误：reactions 第 ${index + 1} 项要是 {message, emoji?} 对象。`,
            };
        }
        const messageNumber = integerOf(record.message);
        if (messageNumber === null) {
            return {
                ok: false,
                error: `参数有误：reactions 第 ${index + 1} 项的 message 要传整数。`,
            };
        }
        const emoji = parseEmoji(record.emoji);
        if (!emoji.ok) {
            return {
                ok: false,
                error: `参数有误：reactions 第 ${index + 1} 项${INVALID_EMOJI}`,
            };
        }
        items.push({ messageNumber, emoji: emoji.value });
    }
    if (items.length === 0) return { ok: false, error: '参数有误：reactions 不能为空。' };
    if (items.length > REACTION_BATCH_MAX) {
        return {
            ok: false,
            error: `参数有误：一次最多 ${REACTION_BATCH_MAX} 条（reactions 有 ${items.length} 条）。`,
        };
    }
    return { ok: true, mode: 'batch', items };
};

/** Present and not a filler (`null`, `''`, `0`, `[]`); a form value is always >= 1 */
const namesForm = (raw: Readonly<Record<string, unknown>>, key: string): boolean => {
    const value = raw[key];
    if (value === undefined || value === null) return false;
    if (typeof value === 'string') return value.trim() !== '';
    if (typeof value === 'number') return value !== 0;
    return !Array.isArray(value) || value.length > 0;
};

/** Present at all, so a lone empty array still gets its own parser's error */
const hasField = (raw: Readonly<Record<string, unknown>>, key: string): boolean =>
    raw[key] !== undefined && raw[key] !== null;

/**
 * The three forms are exclusive: exactly one of message / messages / reactions.
 * Models often fill the unused fields with `null` or `[]`; those fillers do not
 * count as a second form, while a lone empty one is still reported by its own
 * parser ("messages 不能为空").
 */
const parseArgs = (raw: Readonly<Record<string, unknown>>): ParsedArgs => {
    const single = namesForm(raw, 'message');
    const messages = namesForm(raw, 'messages');
    const reactions = namesForm(raw, 'reactions');
    const forms = [single, messages, reactions].filter((present) => present).length;
    if (forms > 1) return { ok: false, error: '参数有误：message、messages、reactions 只能传一个。' };
    if (reactions) return parseReactionsForm(raw);
    if (messages) return parseMessagesForm(raw);
    if (single) return parseSingleForm(raw);
    if (hasField(raw, 'reactions')) return parseReactionsForm(raw);
    if (hasField(raw, 'messages')) return parseMessagesForm(raw);
    return {
        ok: false,
        error:
            '参数有误：message 要传整数（#N 里的数字）；' +
            '一次点多条用 messages=[…] 或 reactions=[…]。',
    };
};

/** The candidate range is stated, so the model does not guess a number next time */
const missingMessageText = (messageNumber: number, index: ContextIndex): string => {
    const numbers = [...index.keys()];
    if (numbers.length === 0) return `本次上下文没有 #${messageNumber} 这条消息。`;
    return `本次上下文没有 #${messageNumber} 这条消息（可用编号 #1–#${Math.max(...numbers)}）`;
};

/**
 * Where a single call lands: the message itself for a user message, the current
 * version's body for a bot reply. The layout read may fail (the BotResponse was
 * cleaned up, or has no version row yet); the canonical id is still worth
 * trying rather than refusing the call.
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
    emoji: ReactionEmoji | null,
    source?: BotReactionSource
): Promise<string | null | undefined> => {
    try {
        const written = await writeReaction(context.chatId, canonicalMessageId, emoji, source);
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

/** One call of the single form: one API target, one row */
const executeSingle = async (
    item: ReactionBatchItem,
    context: ReplyToolContext,
    writeReaction: WriteBotReaction
): Promise<ToolResult> => {
    const entry = context.contextIndex.get(item.messageNumber);
    if (entry === undefined) return failed(missingMessageText(item.messageNumber, context.contextIndex));

    const apiTargetMessageId = await resolveApiTargetMessageId(context, entry);
    try {
        await runApiCall(context.chatId, () =>
            context.api.setMessageReaction(
                context.chatId,
                apiTargetMessageId,
                reactionOf(item.emoji),
                undefined,
                toTelegramApiAbortSignal(context.signal)
            )
        );
    } catch (error) {
        // Telegram refuses a reaction that is already in the asked-for state
        // with "message is not modified"; that is the outcome the call wanted,
        // so it is a success here too (the batch forms have always read it so).
        if (!isNotModifiedError(error)) return failed(describeApiFailure(error));
    }

    // Which part of the reply the API target is; a ledger row is written as each
    // message goes out, so this is the same answer an inbound reaction gets.
    const source = await resolveReactionSource(context.chatId, apiTargetMessageId);
    const previousEmoji = await writeReactionOrWarn(
        writeReaction,
        context,
        entry.messageId,
        item.emoji,
        source
    );
    return succeeded(
        successContent(item.messageNumber, item.emoji, previousEmoji),
        traceOf(item.messageNumber, item.emoji)
    );
};

export const createReactToMessageTool = (
    context: ReplyToolContext,
    dependencies: ReactToMessageDependencies = {}
): ToolHandler => {
    const writeReaction: WriteBotReaction = dependencies.writeReaction ?? replaceBotReaction;
    const writeReactions: WriteBotReactions = dependencies.writeReactions ?? replaceBotReactions;

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

            if (parsed.mode === 'single') {
                return executeSingle(parsed.item, context, writeReaction);
            }

            const outcome = await runReactionBatch(parsed.items, context, { writeReactions });
            if (outcome.failures.length > 0 && !outcome.aborted) {
                // A batch that partly failed has no rejected call to log; the
                // failed items are what an operator needs. A user's stop is not
                // a failure worth a warning.
                console.warn(
                    `[reaction] ${outcome.failures.length} 条没设置成：${outcome.failures.join('、')}`
                );
            }
            return {
                content: outcome.content,
                isError: outcome.isError,
                images: [],
                record: null,
                trace: { argument: outcome.traceArgument, result: outcome.traceResult },
            };
        },
    };
};
