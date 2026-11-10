/**
 * The live thinking stream of a reply being generated (design §5.2).
 *
 * It starts on the first thinking chunk, before the version id (and therefore the
 * token) exists, which is why the key is the attempt — chat id, first message id
 * and 1-based version id — and not the token. The fast page polls it while the
 * reply runs; the version's stored `thinkingText` takes over once the process has
 * restarted (design §5.3).
 *
 * One instance is the whole process (the panel runs in the bot process); the
 * factory exists so offline cases can drive a deterministic clock and caps.
 */
import type { ThinkingStreamEntry } from './thinking-types.js';

/** The full thinking of one reply; the bot stores the same cap on the version */
export const THINKING_STREAM_MAX_LENGTH = 200_000;

/** Appended once when the cap is hit; the page shows it as part of the text */
export const THINKING_TRUNCATION_MARK = '\n\n…（思考过程超过 20 万字，已截断）';

/** Entries are dropped this long after their last append (design: 2 hours) */
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;

/** Above this many tracked attempts, stale ones are swept on append */
const SWEEP_THRESHOLD = 500;

export interface ThinkingStreamOptions {
    /** Clock in ms (default Date.now) */
    now?: () => number;
    maxLength?: number;
    truncationMark?: string;
    ttlMs?: number;
}

export interface ThinkingStream {
    /** Keep one thinking chunk of an attempt; no-op once finished or truncated */
    append(key: string, chunk: string): void;
    /** Mark the attempt's thinking as ended (finalize / stop / error all call it) */
    finish(key: string): void;
    /** The entry of one attempt; null once it never existed or expired */
    read(key: string): ThinkingStreamEntry | null;
    /** Drop expired entries; returns how many were removed */
    sweep(): number;
    size(): number;
}

const newEntry = (chunk: string, at: number, maxLength: number, truncationMark: string): ThinkingStreamEntry => {
    if (chunk.length <= maxLength) {
        return { text: chunk, truncated: false, done: false, finishedAt: null, updatedAt: at };
    }
    return {
        text: chunk.slice(0, maxLength) + truncationMark,
        truncated: true,
        done: false,
        finishedAt: null,
        updatedAt: at,
    };
};

export const createThinkingStream = (options: ThinkingStreamOptions = {}): ThinkingStream => {
    const clock = options.now ?? Date.now;
    const maxLength = options.maxLength ?? THINKING_STREAM_MAX_LENGTH;
    const truncationMark = options.truncationMark ?? THINKING_TRUNCATION_MARK;
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const entries = new Map<string, ThinkingStreamEntry>();

    const isExpired = (entry: ThinkingStreamEntry, at: number): boolean => at - entry.updatedAt >= ttlMs;

    const sweep = (): number => {
        const at = clock();
        let removed = 0;
        for (const [key, entry] of entries) {
            if (!isExpired(entry, at)) continue;
            entries.delete(key);
            removed += 1;
        }
        return removed;
    };

    const read = (key: string): ThinkingStreamEntry | null => {
        const entry = entries.get(key);
        if (entry === undefined) return null;
        if (isExpired(entry, clock())) {
            entries.delete(key);
            return null;
        }
        return entry;
    };

    const append = (key: string, chunk: string): void => {
        if (chunk === '') return;
        if (entries.size > SWEEP_THRESHOLD) sweep();
        const at = clock();
        const existing = entries.get(key);
        if (existing === undefined) {
            entries.set(key, newEntry(chunk, at, maxLength, truncationMark));
            return;
        }
        // The thinking has ended (or was cut): later chunks are not part of it
        if (existing.done || existing.truncated) return;
        const remaining = maxLength - existing.text.length;
        if (chunk.length <= remaining) {
            existing.text += chunk;
        } else {
            existing.text += chunk.slice(0, Math.max(0, remaining)) + truncationMark;
            existing.truncated = true;
        }
        existing.updatedAt = at;
    };

    const finish = (key: string): void => {
        const at = clock();
        const existing = entries.get(key);
        if (existing === undefined) {
            // A reply that produced no thinking still ends, so the page can say so
            entries.set(key, { text: '', truncated: false, done: true, finishedAt: at, updatedAt: at });
            return;
        }
        existing.done = true;
        existing.finishedAt = at;
        existing.updatedAt = at;
    };

    return { append, finish, read, sweep, size: () => entries.size };
};

/** The process-wide stream; the bot appends, the panel routes read */
export const thinkingStream = createThinkingStream();
