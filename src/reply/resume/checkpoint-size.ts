/**
 * How much memory a kept checkpoint holds on to, for the registry's byte
 * limit. An estimate: text and bytes are what make a checkpoint big (inline
 * pictures and videos as base64, files, widget HTML), so those are counted
 * as V8 stores them, and everything else costs a flat amount.
 *
 * The same data sits in several places of one checkpoint: a picture's base64
 * in the request contents and in the context index, a drawn picture's buffer
 * in the media state and in the journal. Counting it each time would refuse
 * checkpoints that are not big at all, so every string and every buffer is
 * counted once: a string by its value, a buffer by its identity.
 */
import type { ReplyCheckpoint } from './reply-checkpoint.js';

/** A number, a flag or a reference */
const SLOT_BYTES = 8;
/** An object, array, map or set besides what it holds: what the heap retains for a small one */
const OBJECT_BYTES = 48;
/**
 * Characters looked at to tell how a string is stored. Bounded, so a 10 MB
 * base64 string is not scanned whole; spread over the string, so text that
 * turns Chinese after an ASCII start is still seen.
 */
const ENCODING_PROBES = 1024;
const LATIN1_MAX_CODE = 0xff;

/**
 * V8 keeps a string one byte per character while every character is Latin-1
 * (base64, ASCII) and two bytes per character otherwise (CJK text)
 */
const bytesPerCharacterOf = (value: string): number => {
    const probes = Math.min(value.length, ENCODING_PROBES);
    const stride = value.length / probes;
    for (let probe = 0; probe < probes; probe += 1) {
        if (value.charCodeAt(Math.floor(probe * stride)) > LATIN1_MAX_CODE) return 2;
    }
    return 1;
};

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
                total += value.length * bytesPerCharacterOf(value);
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
        total += OBJECT_BYTES;
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
