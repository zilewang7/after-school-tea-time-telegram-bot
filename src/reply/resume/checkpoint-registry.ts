/**
 * The kept checkpoints of failed or stopped replies, in memory (design
 * 2026-1112-1123 §6.3, D3: a restart loses them and "重试" remains).
 *
 * One entry per reply, keyed chatId:firstMessageId. Entries live two hours;
 * at most ten are kept and at most 64 MB by estimate, the oldest going first
 * when a limit is passed. One that alone exceeds the byte limit is never
 * stored. There are no timers: expiry is checked whenever the registry is
 * read or written, and every finalization of a reply prunes it, so a quiet
 * bot does not hold a dead entry's memory until the next click.
 *
 * The resumable mark in src/state.ts is the single truth of whether a reply
 * can be continued. The registry sets it on every store, clears it when an
 * entry expires, is evicted, taken or dropped, and drops any entry whose mark
 * is gone (every finalization of the reply clears it) at the next prune. So
 * it never hands out an entry the buttons no longer offer.
 */
import {
    clearReplyResumable,
    markReplyResumable,
    resumableMarkOf,
} from '../../state.js';
import {
    checkpointMissingReason,
    type CheckpointMissingReason,
} from './checkpoint-missing-reason.js';
import { estimateCheckpointBytes } from './checkpoint-size.js';
import { withCompactedJournal } from './journal-compaction.js';
import type { ReplyCheckpoint } from './reply-checkpoint.js';

export interface CheckpointRegistryLimits {
    /** How long an entry lives after its save */
    readonly ttlMs: number;
    readonly maxEntries: number;
    /** Sum of the entries' estimated bytes */
    readonly maxBytes: number;
}

export const CHECKPOINT_REGISTRY_LIMITS: CheckpointRegistryLimits = {
    ttlMs: 2 * 60 * 60 * 1000,
    maxEntries: 10,
    maxBytes: 64 * 1024 * 1024,
};

export interface CheckpointRegistryOptions {
    readonly limits?: Partial<CheckpointRegistryLimits>;
    /** The registry's clock; tests move it */
    readonly now?: () => number;
    /** Epoch ms the process started: a version older than that lost its checkpoint to a restart */
    readonly processStartedAt?: number;
}

/** An entry ready to store: its journal compacted, its size estimated */
export interface PreparedCheckpoint {
    readonly checkpoint: ReplyCheckpoint;
    readonly bytes: number;
}

export interface CheckpointRegistry {
    /**
     * Compact and measure an entry before the reply is finalized, so the
     * metrics row can say whether it is kept. null: it alone exceeds the byte
     * limit and will not be stored.
     */
    readonly prepare: (checkpoint: ReplyCheckpoint) => PreparedCheckpoint | null;
    /**
     * Store a prepared entry (replacing the reply's earlier one) and mark the
     * reply resumable. Call it after the finalization, which clears the mark.
     */
    readonly save: (prepared: PreparedCheckpoint) => void;
    /** The reply's entry, left in place */
    readonly peek: (chatId: number, firstMessageId: number) => ReplyCheckpoint | undefined;
    /** The reply's entry, removed together with its mark */
    readonly take: (chatId: number, firstMessageId: number) => ReplyCheckpoint | undefined;
    /** Return a taken entry (and its mark) when the continue did not get going */
    readonly putBack: (checkpoint: ReplyCheckpoint) => void;
    /** Forget the reply's entry and its mark */
    readonly drop: (chatId: number, firstMessageId: number) => void;
    /** Why a version's entry is not there; for the log line of the click */
    readonly missingReason: (failedVersionCreatedAt: number) => CheckpointMissingReason;
    /** Drop the entries that expired or lost their mark; every finalization of a reply calls it */
    readonly prune: () => void;
    /** Entries held right now, those the next prune drops included; reading changes nothing */
    readonly size: () => number;
    /** Estimated bytes of the entries held right now, as size() counts them */
    readonly totalBytes: () => number;
}

const keyOf = (chatId: number, firstMessageId: number): string => `${chatId}:${firstMessageId}`;

const describe = (checkpoint: ReplyCheckpoint): string =>
    `chat=${checkpoint.chatId} first=${checkpoint.firstMessageId} version=${checkpoint.failedVersionId}`;

export const createCheckpointRegistry = (options: CheckpointRegistryOptions = {}): CheckpointRegistry => {
    const limits: CheckpointRegistryLimits = { ...CHECKPOINT_REGISTRY_LIMITS, ...options.limits };
    // Date.now looked up on every read, like the marks' clock in state.ts:
    // the two must agree on what has expired
    const now = options.now ?? ((): number => Date.now());
    const processStartedAt = options.processStartedAt ?? performance.timeOrigin;
    // Insertion order is save order; eviction still compares savedAt, since a
    // put-back entry returns at the end with its original save time
    const entries = new Map<string, PreparedCheckpoint>();

    const expiresAtOf = (checkpoint: ReplyCheckpoint): number => checkpoint.savedAt + limits.ttlMs;

    const holdsMark = (checkpoint: ReplyCheckpoint, at: number): boolean =>
        resumableMarkOf(checkpoint.chatId, checkpoint.firstMessageId, at)?.versionId ===
        checkpoint.failedVersionId;

    /** Remove an entry and the mark that points at it (not a newer mark) */
    const remove = (key: string, stored: PreparedCheckpoint): void => {
        entries.delete(key);
        const { chatId, firstMessageId, failedVersionId } = stored.checkpoint;
        clearReplyResumable(chatId, firstMessageId, failedVersionId);
    };

    /** Drop what expired and what lost its mark since the last touch */
    const prune = (at: number): void => {
        for (const [key, stored] of entries) {
            if (at >= expiresAtOf(stored.checkpoint)) {
                console.log(`[resume] checkpoint expired ${describe(stored.checkpoint)}`);
                remove(key, stored);
            } else if (!holdsMark(stored.checkpoint, at)) {
                entries.delete(key);
            }
        }
    };

    const bytesHeld = (): number => [...entries.values()].reduce((sum, stored) => sum + stored.bytes, 0);

    /** The earliest saved entry other than `keep` */
    const oldestKeyExcept = (keep: string): string | undefined => {
        let oldestKey: string | undefined;
        let oldestSavedAt = Infinity;
        for (const [key, stored] of entries) {
            if (key === keep || stored.checkpoint.savedAt >= oldestSavedAt) continue;
            oldestKey = key;
            oldestSavedAt = stored.checkpoint.savedAt;
        }
        return oldestKey;
    };

    const evictOverLimits = (keep: string): void => {
        while (entries.size > limits.maxEntries || bytesHeld() > limits.maxBytes) {
            const oldestKey = oldestKeyExcept(keep);
            const oldest = oldestKey === undefined ? undefined : entries.get(oldestKey);
            if (oldestKey === undefined || oldest === undefined) return;
            console.log(`[resume] checkpoint evicted ${describe(oldest.checkpoint)} bytes=${oldest.bytes}`);
            remove(oldestKey, oldest);
        }
    };

    const store = (prepared: PreparedCheckpoint): void => {
        prune(now());
        const { checkpoint } = prepared;
        const key = keyOf(checkpoint.chatId, checkpoint.firstMessageId);
        entries.delete(key);
        entries.set(key, prepared);
        markReplyResumable(checkpoint.chatId, checkpoint.firstMessageId, {
            versionId: checkpoint.failedVersionId,
            expiresAt: expiresAtOf(checkpoint),
        });
        evictOverLimits(key);
    };

    const measure = (checkpoint: ReplyCheckpoint): PreparedCheckpoint => ({
        checkpoint,
        bytes: estimateCheckpointBytes(checkpoint),
    });

    const read = (chatId: number, firstMessageId: number): PreparedCheckpoint | undefined => {
        prune(now());
        return entries.get(keyOf(chatId, firstMessageId));
    };

    return {
        prepare: (checkpoint) => {
            const prepared = measure({ ...checkpoint, loop: withCompactedJournal(checkpoint.loop) });
            if (prepared.bytes <= limits.maxBytes) return prepared;
            console.log(`[resume] checkpoint not kept, ${prepared.bytes} bytes ${describe(checkpoint)}`);
            return null;
        },
        save: (prepared) => {
            store(prepared);
            console.log(
                `[resume] checkpoint kept ${describe(prepared.checkpoint)} rounds=${prepared.checkpoint.loop.completedRounds} bytes=${prepared.bytes}`
            );
        },
        peek: (chatId, firstMessageId) => read(chatId, firstMessageId)?.checkpoint,
        take: (chatId, firstMessageId) => {
            const stored = read(chatId, firstMessageId);
            if (stored === undefined) return undefined;
            remove(keyOf(chatId, firstMessageId), stored);
            return stored.checkpoint;
        },
        putBack: (checkpoint) => store(measure(checkpoint)),
        drop: (chatId, firstMessageId) => {
            const stored = read(chatId, firstMessageId);
            if (stored !== undefined) remove(keyOf(chatId, firstMessageId), stored);
        },
        missingReason: (failedVersionCreatedAt) =>
            checkpointMissingReason({
                failedVersionCreatedAt,
                processStartedAt,
                now: now(),
                ttlMs: limits.ttlMs,
            }),
        prune: () => prune(now()),
        size: () => entries.size,
        totalBytes: bytesHeld,
    };
};

/** The registry of this process */
export const checkpointRegistry = createCheckpointRegistry();
