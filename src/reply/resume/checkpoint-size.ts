/**
 * How much memory a kept checkpoint holds on to, for the registry's byte
 * limit. An estimate: text and bytes are what make a checkpoint big (inline
 * pictures and videos as base64, files, widget HTML), so those are counted
 * and everything else costs a small flat amount.
 *
 * The same data sits in several places of one checkpoint: a picture's base64
 * in the request contents and in the context index, a drawn picture's buffer
 * in the media state and in the journal. Counting it each time would refuse
 * checkpoints that are not big at all, so every string and every buffer is
 * counted once: a string by its value, a buffer by its identity.
 */
import type { ReplyCheckpoint } from './reply-checkpoint.js';

/** Flat cost of a number, a flag or an object header; small next to any text */
const SLOT_BYTES = 8;

/**
 * Bytes held by everything reachable from `roots`. Walks plain objects,
 * arrays, maps and sets; functions are not followed.
 */
export const estimateRetainedBytes = (roots: readonly unknown[]): number => {
    const seenStrings = new Set<string>();
    const seenObjects = new Set<object>();
    // An explicit stack: request contents can nest deeper than a call stack likes
    const pending: unknown[] = [...roots];
    let total = 0;

    while (pending.length > 0) {
        const value = pending.pop();
        if (typeof value === 'string') {
            if (!seenStrings.has(value)) {
                seenStrings.add(value);
                // One byte per character: base64 and ASCII dominate the big strings
                total += value.length;
            }
            continue;
        }
        if (typeof value !== 'object' || value === null) {
            total += SLOT_BYTES;
            continue;
        }
        if (seenObjects.has(value)) continue;
        seenObjects.add(value);

        if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
            total += value.byteLength;
            continue;
        }
        total += SLOT_BYTES;
        if (value instanceof Map) {
            for (const [key, item] of value) pending.push(key, item);
        } else if (value instanceof Set) {
            for (const item of value) pending.push(item);
        } else if (Array.isArray(value)) {
            for (const item of value) pending.push(item);
        } else {
            for (const item of Object.values(value)) pending.push(item);
        }
    }
    return total;
};

/** The estimate of one entry, every part of it in one walk so shared data counts once */
export const estimateCheckpointBytes = (checkpoint: ReplyCheckpoint): number =>
    estimateRetainedBytes([
        checkpoint.loop,
        checkpoint.context,
        checkpoint.request,
        checkpoint.toolState.media,
        checkpoint.toolState.workspace,
        // The history state keeps its entries behind functions
        checkpoint.toolState.history.entries(),
    ]);
