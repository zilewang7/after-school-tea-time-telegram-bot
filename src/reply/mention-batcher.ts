/**
 * Debounce window that merges a burst of trigger messages into a single reply.
 *
 * Private chat: one user forwarding several messages at once, or an album
 * followed by a typed question. Only forwards and media messages open a window
 * (they signal "more may follow"); a plain typed message with no open window
 * triggers immediately, so ordinary conversation gains zero latency, and a
 * typed message that lands in an open window closes it on the spot — it is
 * usually the question that ends the burst.
 *
 * Group chat: a trigger is always explicit (@mention or a reply to the bot), so
 * every trigger keeps the window open and the batch is keyed by the *context*
 * (the reply tree) instead of by sender: two people answering in the same
 * context within the window merge into one reply instead of two. Messages from
 * different contexts never share a batch.
 *
 * At flush time the earlier members are linked to the newest message (the
 * anchor) via message_links, so a private-chat burst rides into the context
 * through the same mechanism /chat uses. In groups the members already share
 * the context, so the links are redundant but harmless.
 */
import type { Context } from 'grammy';
import { isGroupChat } from '../util.js';

/** Never keep extending the window past this, however the burst trickles in */
const MAX_WINDOW_MS = 10_000;
/** A burst larger than this flushes immediately */
const MAX_BATCH_SIZE = 20;

/** Read per call so offline tests can inject a short window at runtime */
const windowMs = (): number => {
    const parsed = Number(process.env.MENTION_BATCH_WINDOW_MS);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 500;
};

export type MentionBatchFlush = (
    anchorCtx: Context,
    earlierMessageIds: number[]
) => Promise<void>;

export interface MentionBatchOptions {
    /** Identity of the context (reply-tree root) — required in group chats */
    contextKey?: number;
    onFlush: MentionBatchFlush;
}

interface PendingBatch {
    /** Members that arrived before the current anchor, oldest first */
    earlierMessageIds: number[];
    anchorCtx: Context;
    anchorMessageId: number;
    openedAt: number;
    timer: NodeJS.Timeout;
    onFlush: MentionBatchFlush;
}

/** Open windows, keyed by `chatId:ctx:<rootId>` (groups) or `chatId:user:<id>` */
const pendingBatches = new Map<string, PendingBatch>();

const hasMedia = (ctx: Context): boolean => {
    const msg = ctx.message;
    if (!msg) return false;
    return Boolean(
        msg.photo || msg.video || msg.document || msg.sticker ||
        msg.voice || msg.audio || msg.video_note || msg.animation
    );
};

/**
 * Whether this message may still be followed by more of the same burst. In a
 * group every trigger counts (the merge is bounded by the context instead), in
 * private only forwards and media signal "more may follow".
 */
const keepsWindowOpen = (ctx: Context): boolean =>
    isGroupChat(ctx) || Boolean(ctx.message?.forward_origin) || hasMedia(ctx);

/** Batch key for this message, or null when there is nothing to key on */
const batchKeyOf = (ctx: Context, contextKey: number | undefined): string | null => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return null;

    if (isGroupChat(ctx)) {
        return contextKey === undefined ? null : `${chatId}:ctx:${contextKey}`;
    }

    const userId = ctx.message?.from?.id;
    return userId === undefined ? null : `${chatId}:user:${userId}`;
};

const runFlush = (key: string): void => {
    const batch = pendingBatches.get(key);
    if (!batch) return;
    pendingBatches.delete(key);
    clearTimeout(batch.timer);
    batch.onFlush(batch.anchorCtx, batch.earlierMessageIds).catch((error) => {
        console.error('[mention-batcher] flush failed:', error);
    });
};

/**
 * Route one trigger-eligible, non-command message through the batch window.
 * The caller must already hold the message's idempotency claim. The flush
 * callback fires exactly once per batch, with the newest message as anchor.
 */
export const submitToMentionBatch = (
    ctx: Context,
    options: MentionBatchOptions
): void => {
    const { onFlush } = options;
    const messageId = ctx.message?.message_id;
    const key = batchKeyOf(ctx, options.contextKey);

    if (key === null || messageId === undefined) {
        // Nothing to key a batch on — behave like an immediate trigger
        onFlush(ctx, []).catch((error) => {
            console.error('[mention-batcher] flush failed:', error);
        });
        return;
    }

    const existing = pendingBatches.get(key);

    if (existing) {
        existing.earlierMessageIds.push(existing.anchorMessageId);
        existing.anchorCtx = ctx;
        existing.anchorMessageId = messageId;

        const overCap =
            existing.earlierMessageIds.length + 1 >= MAX_BATCH_SIZE ||
            Date.now() - existing.openedAt >= MAX_WINDOW_MS;
        if (!keepsWindowOpen(ctx) || overCap) {
            // A typed message ends the private burst; caps end it defensively
            runFlush(key);
            return;
        }

        clearTimeout(existing.timer);
        existing.timer = setTimeout(() => runFlush(key), windowMs());
        return;
    }

    if (!keepsWindowOpen(ctx)) {
        onFlush(ctx, []).catch((error) => {
            console.error('[mention-batcher] flush failed:', error);
        });
        return;
    }

    pendingBatches.set(key, {
        earlierMessageIds: [],
        anchorCtx: ctx,
        anchorMessageId: messageId,
        openedAt: Date.now(),
        onFlush,
        timer: setTimeout(() => runFlush(key), windowMs()),
    });
};
