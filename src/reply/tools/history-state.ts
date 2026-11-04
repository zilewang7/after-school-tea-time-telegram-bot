/**
 * The history working set of one reply: every message the history tools have
 * shown to the model, numbered `h1`, `h2`, … in first-seen order.
 *
 * Numbering is per reply and never persisted, exactly like the media ids: the
 * model can refer back to `h3` in a later tool call of the same reply, and two
 * searches that surface the same message keep the same number, so a search hit
 * and a full read are obviously the same thing.
 *
 * Entries are grown in place: a search registers the index text, a later read
 * adds the raw text and entities it fetched, and the id does not change.
 */
import type { HistoryForward, HistoryMedia, HistoryRawEntity } from '../../services/luoxu-history-service.js';

export interface HistoryMessageInput {
    /** luoxu group id (channel id), not the bot chat id */
    readonly channelId: number;
    readonly messageId: number;
    /** Unix seconds */
    readonly timestamp: number;
    readonly fromId: number | null;
    readonly fromName: string;
    readonly fromIsBot: boolean;
    /** The indexed text: HTML-escaped, possibly keyword-highlighted */
    readonly indexedHtml: string;
    /** Group title, for cross-group results */
    readonly groupName?: string;
    /** Raw message text from /messages, when it has been fetched */
    readonly rawText?: string;
    readonly entities?: readonly HistoryRawEntity[];
    readonly replyToId?: number | null;
    /** The medium the message carries (sticker / photo / file …) */
    readonly media?: HistoryMedia | null;
    /** Where it was forwarded from */
    readonly forward?: HistoryForward | null;
}

export interface HistoryEntry extends HistoryMessageInput {
    /** `hN`, 1-based, stable within the reply */
    readonly h: number;
}

export interface HistoryState {
    /** Register or grow a message; returns the entry with its stable id */
    readonly remember: (input: HistoryMessageInput) => HistoryEntry;
    readonly entryOf: (h: number) => HistoryEntry | undefined;
    readonly findByMessage: (channelId: number, messageId: number) => HistoryEntry | undefined;
    /** Every entry, in registration order */
    readonly entries: () => readonly HistoryEntry[];
    readonly size: () => number;
}

const messageKey = (channelId: number, messageId: number): string => `${channelId}:${messageId}`;

const merge = (existing: HistoryEntry, input: HistoryMessageInput): HistoryEntry => ({
    h: existing.h,
    channelId: existing.channelId,
    messageId: existing.messageId,
    timestamp: input.timestamp || existing.timestamp,
    fromId: input.fromId ?? existing.fromId,
    fromName: input.fromName || existing.fromName,
    fromIsBot: input.fromIsBot || existing.fromIsBot,
    indexedHtml: input.indexedHtml || existing.indexedHtml,
    groupName: input.groupName ?? existing.groupName,
    rawText: input.rawText ?? existing.rawText,
    entities: input.entities ?? existing.entities,
    replyToId: input.replyToId ?? existing.replyToId,
    media: input.media ?? existing.media,
    forward: input.forward ?? existing.forward,
});

export const createHistoryState = (): HistoryState => {
    const byNumber = new Map<number, HistoryEntry>();
    const byMessage = new Map<string, HistoryEntry>();
    let next = 1;

    const remember = (input: HistoryMessageInput): HistoryEntry => {
        const key = messageKey(input.channelId, input.messageId);
        const existing = byMessage.get(key);
        if (existing) {
            const grown = merge(existing, input);
            byMessage.set(key, grown);
            byNumber.set(grown.h, grown);
            return grown;
        }
        const entry: HistoryEntry = { ...input, h: next };
        next += 1;
        byMessage.set(key, entry);
        byNumber.set(entry.h, entry);
        return entry;
    };

    return {
        remember,
        entryOf: (h) => byNumber.get(h),
        findByMessage: (channelId, messageId) => byMessage.get(messageKey(channelId, messageId)),
        entries: () => [...byNumber.values()].sort((a, b) => a.h - b.h),
        size: () => byNumber.size,
    };
};
