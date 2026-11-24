/**
 * What a luoxu media descriptor names when it is not an ordinary medium.
 *
 * luoxu's `/messages` describes a message's own media as `photo` / `video` /
 * `sticker` / … for the types it models, and falls back to the raw MTProto
 * class name (`MessageMediaPoll`, `MessageMediaContact`, …) for the rest. Two
 * surfaces need that mapping:
 *
 * - the history tools word it like the live context (`[sent a poll]`), so a
 *   message read from the archive looks like the same message seen live;
 * - the missing-row backfill stores it as `telegram_messages.messageKind`, so
 *   a recovered row is not a blank hole in the context.
 *
 * The `kind` tokens match `MessageKind` in `src/db/message-kind.ts`. This
 * module lives in `shared` (layer 0) because the services layer (backfill) and
 * the reply layer (history tools) both need it.
 */
export interface LuoxuRawMedia {
    /** `telegram_messages.messageKind` token; `unsupported` when this build has no kind for it */
    readonly kind: string;
    /** English noun phrase as the live context words it: `[sent <label>]` */
    readonly label: string;
}

const RAW_MEDIA_TYPES: Readonly<Record<string, LuoxuRawMedia>> = {
    MessageMediaPoll: { kind: 'poll', label: 'a poll' },
    MessageMediaContact: { kind: 'contact', label: 'a contact card' },
    MessageMediaGeo: { kind: 'location', label: 'a location' },
    MessageMediaGeoLive: { kind: 'live_location', label: 'a live location' },
    MessageMediaVenue: { kind: 'venue', label: 'a venue' },
    MessageMediaDice: { kind: 'dice', label: 'a dice roll' },
    MessageMediaGame: { kind: 'game', label: 'a game' },
    MessageMediaInvoice: { kind: 'invoice', label: 'an invoice' },
    MessageMediaStory: { kind: 'story', label: 'a story' },
    MessageMediaPaidMedia: { kind: 'paid_media', label: 'paid media' },
    MessageMediaToDo: { kind: 'checklist', label: 'a checklist' },
    MessageMediaGiveaway: { kind: 'unsupported', label: 'a giveaway' },
    MessageMediaGiveawayResults: { kind: 'unsupported', label: 'a giveaway' },
    MessageMediaUnsupported: { kind: 'unsupported', label: 'an unsupported message' },
    MessageMediaEmpty: { kind: 'unsupported', label: 'an empty media' },
    MessageMediaVideoStream: { kind: 'unsupported', label: 'a video stream' },
};

/** `MessageMediaGeoLive` → `geo live`, for a class name this build does not list */
const wordsOfClassName = (className: string): string =>
    className
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .trim();

/**
 * The kind and English label of one luoxu media `type`, or null for the
 * ordinary media types (`photo`, `video`, `document`, …) that callers already
 * word themselves. A `MessageMedia*` class this build does not list still gets
 * `unsupported` plus a readable label, so it is never rendered as nothing.
 */
export const luoxuRawMediaOf = (type: string): LuoxuRawMedia | null => {
    const known = RAW_MEDIA_TYPES[type];
    if (known !== undefined) return known;
    if (!type.startsWith('MessageMedia')) return null;
    const words = wordsOfClassName(type.slice('MessageMedia'.length));
    if (words === '') return null;
    const article = /^[aeiou]/.test(words) ? 'an' : 'a';
    return { kind: 'unsupported', label: `${article} ${words}` };
};
