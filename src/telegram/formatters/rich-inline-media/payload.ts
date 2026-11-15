/**
 * One picture a rich message embeds: the markdown names it by id
 * (`![](tg://photo?id=img1 "caption")`), the bytes travel with the same
 * request (`rich_message.media`).
 *
 * The bytes are kept as a Buffer on purpose: a refused edit is retried by the
 * coordinator, and a stream or supplier source cannot be sent twice. The digest
 * lets the coordinator tell "the message already shows exactly this" from a
 * real change (same text, different pictures is a change).
 */
import { createHash } from 'node:crypto';
import { InputFile } from 'grammy';
import type { InputRichMessageMedia } from 'grammy/types';

export interface RichMediaPayload {
    /** The media id the body's markdown references: `img1`, `img2`, … */
    readonly id: string;
    /** The picture's bytes */
    readonly data: Buffer;
    /** Identity of the bytes (size and a short digest), for the sent-state comparison */
    readonly digest: string;
}

/** The payload of one picture, its digest computed once here */
export const richMediaPayloadOf = (id: string, data: Buffer): RichMediaPayload => ({
    id,
    data,
    digest: `${data.length}:${createHash('sha256').update(data).digest('hex').slice(0, 16)}`,
});

/**
 * The `media` field of a rich message: one upload per picture, or nothing at
 * all — Telegram would read an empty list as a field to validate, and the
 * request must stay byte-identical to the one a body without pictures sends.
 */
export const richMediaFieldOf = (
    media?: readonly RichMediaPayload[]
): { readonly media?: InputRichMessageMedia[] } => {
    if (media === undefined || media.length === 0) return {};
    return {
        // A fresh upload per attempt: a consumed InputFile cannot be sent twice
        media: media.map((picture) => ({
            id: picture.id,
            media: { type: 'photo', media: new InputFile(picture.data) },
        })),
    };
};

/** Total bytes of one payload list, for the log line */
export const richMediaBytesOf = (media?: readonly RichMediaPayload[]): number =>
    (media ?? []).reduce((total, picture) => total + picture.data.length, 0);

/** The identity of a whole media list: 'none' when the body carries no picture */
export const richMediaIdentityOf = (media?: readonly RichMediaPayload[]): string =>
    media === undefined || media.length === 0
        ? 'none'
        : media.map((picture) => `${picture.id}:${picture.digest}`).join(',');
