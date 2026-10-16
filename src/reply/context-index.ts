/**
 * `#N` → message index of one assembled context.
 *
 * buildContext numbers every message it puts in front of the model; tools that
 * take those numbers (image references) resolve them through this index, so
 * the number the model read is exactly the number that gets resolved.
 */

export interface ContextIndexEntry {
    /** The `#N` the model sees */
    readonly number: number;
    readonly messageId: number;
    /** One of the bot's own replies */
    readonly fromBot: boolean;
    /** Images attached to the message itself (album members included), before capability filtering */
    readonly imageCount: number;
}

/** Keyed by the context number */
export type ContextIndex = ReadonlyMap<number, ContextIndexEntry>;
