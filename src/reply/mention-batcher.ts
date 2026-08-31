/**
 * Debounce window that merges a burst of trigger messages — one user forwarding
 * several messages at once, or an album followed by a typed question — into a
 * single reply trigger. At flush time the earlier members get linked to the
 * newest message (the anchor) via message_links, so the whole burst rides into
 * the context through the same mechanism /chat uses.
 *
 * Only forwards and media messages open a window (they signal "more may
 * follow"); a plain typed message with no open window triggers immediately, so
 * ordinary conversation gains zero latency. A typed message that lands in an
 * open window closes it on the spot — it is usually the question that ends the
 * burst.
 */
import type { Context } from 'grammy';

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

interface PendingBatch {
    /** Members that arrived before the current anchor, oldest first */
    earlierMessageIds: number[];
    anchorCtx: Context;
    anchorMessageId: number;
    openedAt: number;
    timer: NodeJS.Timeout;
    onFlush: MentionBatchFlush;
}

/** Open windows, keyed by `chatId:userId` */
const pendingBatches = new Map<string, PendingBatch>();

const hasMedia = (ctx: Context): boolean => {
    const msg = ctx.message;
    if (!msg) return false;
    return Boolean(
        msg.photo || msg.video || msg.document || msg.sticker ||
        msg.voice || msg.audio || msg.video_note || msg.animation
    );
};

/** Forwards and media messages signal "more may follow"; plain text does not */
const mayHaveFollowUps = (ctx: Context): boolean =>
    Boolean(ctx.message?.forward_origin) || hasMedia(ctx);

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
export const submitToMentionBatch = (ctx: Context, onFlush: MentionBatchFlush): void => {
    const chatId = ctx.chat?.id;
    const messageId = ctx.message?.message_id;
    const userId = ctx.message?.from?.id;
    if (chatId === undefined || messageId === undefined || userId === undefined) {
        // Nothing to key a batch on — behave like an immediate trigger
        onFlush(ctx, []).catch((error) => {
            console.error('[mention-batcher] flush failed:', error);
        });
        return;
    }

    const key = `${chatId}:${userId}`;
    const existing = pendingBatches.get(key);

    if (existing) {
        existing.earlierMessageIds.push(existing.anchorMessageId);
        existing.anchorCtx = ctx;
        existing.anchorMessageId = messageId;

        const overCap =
            existing.earlierMessageIds.length + 1 >= MAX_BATCH_SIZE ||
            Date.now() - existing.openedAt >= MAX_WINDOW_MS;
        if (!mayHaveFollowUps(ctx) || overCap) {
            // A typed message ends the burst; caps end it defensively
            runFlush(key);
            return;
        }

        clearTimeout(existing.timer);
        existing.timer = setTimeout(() => runFlush(key), windowMs());
        return;
    }

    if (!mayHaveFollowUps(ctx)) {
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
