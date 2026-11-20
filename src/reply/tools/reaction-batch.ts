/**
 * Several reactions in one call: resolve the batch's targets once, set them in
 * request order under the per-chat API budget, and answer with one compact
 * result the model can act on.
 *
 * The calls are sequential on purpose: the per-chat budget and Telegram's flood
 * limits are per chat, so a batch must not fire N calls at once. A refused item
 * is reported by its number and the batch goes on; a refusal every later item
 * would repeat (a chat-level permission error, a flood wait) stops the rest and
 * says so, instead of asking Telegram N times for the answer it already gave.
 *
 * The rows are written afterwards, in one transaction. That write is the
 * model-facing copy, not the source of truth: when it fails the batch only warns
 * and still reports the reactions as set.
 */
import { GrammyError } from 'grammy';
import type { ReactionType } from 'grammy/types';
import { findBotReplyBodyMessageIds } from '../../db/queries/bot-reply-body-queries.js';
import { replaceBotReactions } from '../../db/queries/reaction-queries.js';
import { toTelegramApiAbortSignal } from '../../services/telegram-file-service.js';
import type { ReactionEmoji } from '../../shared/reaction-emoji.js';
import { runApiCall } from '../../telegram/edit-coordinator.js';
import type { ContextIndexEntry } from '../context-index.js';
import type { ReplyToolContext } from './reply-tool-context.js';
import { traceParts, traceText } from './tool-trace.js';

/** How many messages one react_to_message call may carry */
export const REACTION_BATCH_MAX = 6;

/** One reaction the batch will try to set; null emoji cancels that message's */
export interface ReactionBatchItem {
    readonly messageNumber: number;
    readonly emoji: ReactionEmoji | null;
}

/** The row writer of a whole batch; a test injects a failing one */
export type WriteBotReactions = (
    chatId: number,
    items: readonly { readonly canonicalMessageId: number; readonly emoji: string | null }[]
) => Promise<Map<number, string | null>>;

export interface ReactionBatchDependencies {
    readonly writeReactions?: WriteBotReactions;
}

export interface ReactionBatchOutcome {
    readonly content: string;
    readonly isError: boolean;
    readonly traceArgument: string;
    readonly traceResult: string;
    /** One `#N：reason` line per item that really failed; the tool logs them */
    readonly failures: readonly string[];
    /** The reply was stopped by its user, so no failure warning is logged */
    readonly aborted: boolean;
}

/** Telegram's own words on a refused call, cut so a long one cannot flood the model */
const API_DESCRIPTION_MAX_CHARS = 200;

/** Cut by code points, so an emoji is never split in half */
const excerptByCodePoints = (text: string, maxChars: number): string => {
    const characters = Array.from(text);
    return characters.length <= maxChars ? text : `${characters.slice(0, maxChars).join('')}…`;
};

/**
 * One line: a reason is interpolated into a list and may carry Telegram's own
 * text, and a newline in it would forge another list item.
 */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

export const errorMessageOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

/** Telegram's two ways of saying the target no longer exists */
const isDeletedTargetError = (error: unknown): boolean =>
    error instanceof GrammyError &&
    error.error_code === 400 &&
    (error.description.includes('message to react not found') ||
        error.description.includes('MESSAGE_ID_INVALID'));

/** The target already has the state the call asked for: not a failure */
const isNotModifiedError = (error: unknown): boolean =>
    error instanceof GrammyError &&
    error.error_code === 400 &&
    (error.description.includes('message is not modified') ||
        error.description.includes('MESSAGE_NOT_MODIFIED'));

/** 429: the whole chat is rate-limited, so the remaining calls must stop too */
const isRateLimitError = (error: unknown): boolean =>
    error instanceof GrammyError && error.error_code === 429;

/** Refusals that will not change per message: the chat itself is the problem */
const CHAT_LEVEL_DESCRIPTIONS: readonly string[] = [
    'CHAT_WRITE_FORBIDDEN',
    'CHAT_ADMIN_REQUIRED',
    'CHAT_RESTRICTED',
    'have no rights',
    'not enough rights',
    'chat not found',
];

const isChatLevelError = (error: unknown): boolean =>
    error instanceof GrammyError &&
    (error.error_code === 403 ||
        CHAT_LEVEL_DESCRIPTIONS.some((description) => error.description.includes(description)));

/** The wait Telegram asked for; the description carries it only without parameters */
const retryAfterSecondsOf = (error: unknown): number | null => {
    if (!(error instanceof GrammyError)) return null;
    const retryAfter = error.parameters?.retry_after;
    if (typeof retryAfter === 'number') return retryAfter;
    const matched = /retry after (\d+)/i.exec(error.description);
    return matched?.[1] === undefined ? null : Number(matched[1]);
};

/** A refused call as the model reads it, in the single path's wording */
export const describeApiFailure = (error: unknown): string => {
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

/** The Bot API shape of one item's reaction: an emoji, or an empty list to clear */
export const reactionOf = (emoji: ReactionEmoji | null): ReactionType[] =>
    emoji === null ? [] : [{ type: 'emoji', emoji }];

/** One parsed item with the context entry it names (if any) */
interface PreparedItem {
    readonly messageNumber: number;
    readonly emoji: ReactionEmoji | null;
    /** undefined = this turn's context has no such `#N` */
    readonly entry: ContextIndexEntry | undefined;
}

type ItemResult =
    | { readonly kind: 'success'; readonly previousEmoji: string | null | undefined }
    | { readonly kind: 'failure'; readonly reason: string }
    | { readonly kind: 'unprocessed' };

/** Collapse repeated numbers: the last item's emoji wins, at the first position */
const dedupeByMessageNumber = (
    items: readonly ReactionBatchItem[]
): { readonly kept: readonly ReactionBatchItem[]; readonly notes: string[] } => {
    const positionOf = new Map<number, number>();
    const kept: ReactionBatchItem[] = [];
    const counts = new Map<number, number>();
    for (const item of items) {
        counts.set(item.messageNumber, (counts.get(item.messageNumber) ?? 0) + 1);
        const position = positionOf.get(item.messageNumber);
        if (position === undefined) {
            positionOf.set(item.messageNumber, kept.length);
            kept.push(item);
        } else {
            kept[position] = item;
        }
    }
    const notes: string[] = [];
    for (const [messageNumber, count] of counts) {
        if (count > 1) notes.push(`#${messageNumber} 在一批里出现了 ${count} 次，按最后一条设置。`);
    }
    return { kept, notes };
};

/** `#3 👍、#4 🤣、#5 取消`, or a count once that gets long */
const traceArgumentOf = (items: readonly ReactionBatchItem[]): string => {
    const first = items[0];
    if (first === undefined) return '空';
    if (items.length > 3) return traceText(`#${first.messageNumber} 等 ${items.length} 条`);
    return traceText(items.map((item) => `#${item.messageNumber} ${item.emoji ?? '取消'}`).join('、'));
};

/** One successful item, with what stood there before when the write knew it */
const successLineOf = (
    messageNumber: number,
    emoji: ReactionEmoji | null,
    previousEmoji: string | null | undefined
): string => {
    const reference = `#${messageNumber}`;
    if (emoji === null) {
        if (previousEmoji === undefined) return `${reference} 取消`;
        if (previousEmoji === null) return `${reference} 取消（原本没有）`;
        return `${reference} 取消（原来 ${previousEmoji}）`;
    }
    if (previousEmoji === undefined) return `${reference} ${emoji}`;
    if (previousEmoji === emoji) return `${reference} ${emoji}（已经是这个）`;
    if (previousEmoji !== null) return `${reference} ${emoji}（原来是 ${previousEmoji}，已换成 ${emoji}）`;
    return `${reference} ${emoji}`;
};

/** The API target of one item: a bot reply's body, else the message itself */
const apiTargetOf = (entry: ContextIndexEntry, bodyMessageIds: ReadonlyMap<number, number>): number =>
    entry.fromBot ? (bodyMessageIds.get(entry.messageId) ?? entry.messageId) : entry.messageId;

/**
 * Resolve every bot reply's body id with one query. A layout read that fails
 * (the BotResponse was cleaned up, or has no version row yet) is not worth
 * refusing the batch: the canonical id is still worth trying.
 */
const resolveBodyMessageIds = async (
    context: ReplyToolContext,
    prepared: readonly PreparedItem[]
): Promise<ReadonlyMap<number, number>> => {
    const firstMessageIds = [
        ...new Set(
            prepared.flatMap((item) =>
                item.entry !== undefined && item.entry.fromBot ? [item.entry.messageId] : []
            )
        ),
    ];
    if (firstMessageIds.length === 0) return new Map();
    try {
        return await findBotReplyBodyMessageIds(context.chatId, firstMessageIds);
    } catch (error) {
        console.warn(
            `[reaction] could not resolve the body messages of ${context.chatId}: ${errorMessageOf(error)}`
        );
        return new Map();
    }
};

/**
 * Write the successful items in one transaction. The write is the model-facing
 * copy only: a failure returns an empty map (previous state unknown) and the
 * batch still reports the reactions as set.
 */
const writeReactionsOrWarn = async (
    writeReactions: WriteBotReactions,
    context: ReplyToolContext,
    successes: readonly { readonly canonicalMessageId: number; readonly emoji: ReactionEmoji | null }[]
): Promise<ReadonlyMap<number, string | null>> => {
    try {
        return await writeReactions(
            context.chatId,
            successes.map((success) => ({
                canonicalMessageId: success.canonicalMessageId,
                emoji: success.emoji,
            }))
        );
    } catch (error) {
        console.warn(
            `[reaction] failed to store ${successes.length} bot reactions in ${context.chatId}: ` +
                errorMessageOf(error)
        );
        return new Map();
    }
};

export const runReactionBatch = async (
    items: readonly ReactionBatchItem[],
    context: ReplyToolContext,
    dependencies: ReactionBatchDependencies = {}
): Promise<ReactionBatchOutcome> => {
    const writeReactions: WriteBotReactions = dependencies.writeReactions ?? replaceBotReactions;
    const traceArgument = traceArgumentOf(items);
    const { kept, notes } = dedupeByMessageNumber(items);
    const prepared: PreparedItem[] = kept.map((item) => ({
        messageNumber: item.messageNumber,
        emoji: item.emoji,
        entry: context.contextIndex.get(item.messageNumber),
    }));

    const results = new Map<number, ItemResult>();
    for (const [index, item] of prepared.entries()) {
        if (item.entry === undefined) {
            results.set(index, {
                kind: 'failure',
                reason: `本次上下文没有 #${item.messageNumber} 这条消息。`,
            });
        }
    }

    const bodyMessageIds = await resolveBodyMessageIds(context, prepared);

    // A number of the batch can name the same API target (a bot reply's body id
    // is shared by two context numbers, or a message is repeated). The last one
    // wins, so the earlier one is dropped silently instead of calling twice.
    const lastIndexByTarget = new Map<number, number>();
    const targets: Array<number | undefined> = prepared.map((item) =>
        item.entry === undefined ? undefined : apiTargetOf(item.entry, bodyMessageIds)
    );
    for (const [index, target] of targets.entries()) {
        if (target !== undefined) lastIndexByTarget.set(target, index);
    }
    const requestOrder: number[] = [];
    for (const [index, item] of prepared.entries()) {
        const target = targets[index];
        if (target === undefined) continue;
        if (lastIndexByTarget.get(target) === index) {
            requestOrder.push(index);
            continue;
        }
        const survivorIndex = lastIndexByTarget.get(target);
        const survivor = survivorIndex === undefined ? undefined : prepared[survivorIndex];
        if (survivor !== undefined) {
            notes.push(
                `#${item.messageNumber} 和 #${survivor.messageNumber} 是同一条消息，` +
                    `按 #${survivor.messageNumber} 设置。`
            );
        }
    }

    const successes: Array<{
        readonly index: number;
        readonly canonicalMessageId: number;
        readonly emoji: ReactionEmoji | null;
    }> = [];
    let stopped = false;
    let aborted = false;

    for (const index of requestOrder) {
        if (stopped || aborted) break;
        const item = prepared[index];
        const target = targets[index];
        if (item === undefined || item.entry === undefined || target === undefined) continue;
        if (context.signal.aborted) {
            aborted = true;
            results.set(index, { kind: 'unprocessed' });
            break;
        }
        try {
            await runApiCall(context.chatId, () =>
                context.api.setMessageReaction(
                    context.chatId,
                    target,
                    reactionOf(item.emoji),
                    undefined,
                    toTelegramApiAbortSignal(context.signal)
                )
            );
            results.set(index, { kind: 'success', previousEmoji: undefined });
            successes.push({
                index,
                canonicalMessageId: item.entry.messageId,
                emoji: item.emoji,
            });
        } catch (error) {
            if (context.signal.aborted) {
                aborted = true;
                results.set(index, { kind: 'unprocessed' });
                break;
            }
            if (isNotModifiedError(error)) {
                // The target already is in the asked-for state: a success
                results.set(index, { kind: 'success', previousEmoji: undefined });
                successes.push({
                    index,
                    canonicalMessageId: item.entry.messageId,
                    emoji: item.emoji,
                });
                continue;
            }
            if (isRateLimitError(error)) {
                const retryAfter = retryAfterSecondsOf(error);
                results.set(index, {
                    kind: 'failure',
                    reason:
                        retryAfter === null
                            ? '被 Telegram 限流，剩余未设置。'
                            : `被 Telegram 限流，约 ${retryAfter} 秒，剩余未设置。`,
                });
                stopped = true;
                break;
            }
            if (isChatLevelError(error)) {
                results.set(index, {
                    kind: 'failure',
                    reason: '聊天权限不足，剩余未设置。',
                });
                stopped = true;
                break;
            }
            // A deleted target and any other refusal are this item's own problem
            results.set(index, { kind: 'failure', reason: describeApiFailure(error) });
        }
    }

    // An abort marks everything it did not reach; a deliberate stop does not
    // repeat itself on the remaining items (its reason already says so).
    if (aborted) {
        for (const index of requestOrder) {
            if (!results.has(index)) results.set(index, { kind: 'unprocessed' });
        }
    }

    if (successes.length > 0) {
        const previousByCanonical = await writeReactionsOrWarn(writeReactions, context, successes);
        for (const success of successes) {
            results.set(success.index, {
                kind: 'success',
                previousEmoji: previousByCanonical.get(success.canonicalMessageId),
            });
        }
    }

    const successLines: string[] = [];
    const failureLines: string[] = [];
    const logFailures: string[] = [];
    const successReferences: string[] = [];
    let setCount = 0;
    let cancelCount = 0;
    let unprocessedCount = 0;
    for (const [index, item] of prepared.entries()) {
        const result = results.get(index);
        if (result === undefined) continue;
        if (result.kind === 'success') {
            successLines.push(`- ${successLineOf(item.messageNumber, item.emoji, result.previousEmoji)}`);
            successReferences.push(`#${item.messageNumber}`);
            if (item.emoji === null) cancelCount += 1;
            else setCount += 1;
        } else if (result.kind === 'unprocessed') {
            unprocessedCount += 1;
            failureLines.push(`- #${item.messageNumber}：回复已停止，未处理。`);
        } else {
            const reason = oneLine(result.reason);
            failureLines.push(`- #${item.messageNumber}：${reason}`);
            logFailures.push(`#${item.messageNumber}：${reason}`);
        }
    }

    const contentLines: string[] = [];
    if (successLines.length === 0) {
        contentLines.push(`这 ${prepared.length} 条都没设置成：`);
        contentLines.push(...failureLines);
    } else {
        const references = successReferences.join('、');
        contentLines.push(
            setCount === 0
                ? `已取消 ${cancelCount} 条 reaction（${references}）：`
                : `已设置 ${successLines.length} 条 reaction（${references}）：`
        );
        contentLines.push(...successLines);
        if (failureLines.length > 0) {
            contentLines.push(`有 ${failureLines.length} 条没设置成：`);
            contentLines.push(...failureLines);
        }
    }
    contentLines.push(...notes);

    const firstFailure = logFailures[0];
    const traceResult =
        successLines.length === 0
            ? traceParts(
                  '全部失败',
                  firstFailure === undefined
                      ? `${unprocessedCount} 条未处理`
                      : excerptByCodePoints(firstFailure, 28)
              )
            : traceParts(
                  setCount > 0 ? `${setCount} 条设置` : null,
                  cancelCount > 0 ? `${cancelCount} 条取消` : null,
                  logFailures.length > 0 ? `${logFailures.length} 条失败` : null,
                  unprocessedCount > 0 ? `${unprocessedCount} 条未处理` : null
              );

    return {
        content: contentLines.join('\n'),
        isError: successLines.length === 0,
        traceArgument,
        traceResult,
        failures: logFailures,
        aborted,
    };
};
