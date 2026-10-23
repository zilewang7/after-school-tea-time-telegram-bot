/**
 * `#N` → message index of one assembled context.
 *
 * buildContext numbers every message it puts in front of the model; tools that
 * take those numbers (image references) resolve them through this index, so
 * the number the model read is exactly the number that gets resolved.
 */
import type { ContextImage } from './context-images.js';

export interface ContextIndexEntry {
    /** The `#N` the model sees */
    readonly number: number;
    readonly messageId: number;
    /** One of the bot's own replies */
    readonly fromBot: boolean;
    /** The message's pictures as the turn shows them: attachments first, then link previews */
    readonly images: readonly ContextImage[];
    /** = images.length; kept so callers don't count everywhere */
    readonly imageCount: number;
}

/** Keyed by the context number */
export type ContextIndex = ReadonlyMap<number, ContextIndexEntry>;
