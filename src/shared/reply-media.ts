/**
 * Reply pictures as one model: a reply may deliver up to MAX_REPLY_IMAGES
 * pictures, each either inline in a rich message body (`placement: 'inline'`,
 * with the media id the rich markdown references) or as trailing messages
 * (`placement: 'attachment'`, sent as one album when there are several).
 *
 * The type lives in the lowest layer because both the reply layer (delivery,
 * resolution) and the services layer (finalize, version replay, metrics) speak
 * it, and services may not import reply. The bytes are never kept here: a
 * stored picture is a content-addressed media_cache key plus its caption.
 */
import { createHash } from 'node:crypto';

/** Pictures one reply may deliver, inline and attachments together */
export const MAX_REPLY_IMAGES = 10;

/** A single picture's bytes; Telegram's photo upload hard limit is 10MiB */
export const MAX_REPLY_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * All pictures of one reply. The local Bot API server sent a 40.8MB package in
 * the 2026-11-15 probe, so this stays a product cap with headroom, not an API
 * limit.
 */
export const MAX_REPLY_IMAGE_TOTAL_BYTES = 40 * 1024 * 1024;

/** Telegram's album bounds for sendMediaGroup */
export const MIN_ALBUM_IMAGES = 2;
export const MAX_ALBUM_IMAGES = 10;

/**
 * Key prefix of a delivered reply picture in media_cache. The cache is also
 * keyed by Telegram file_unique_id, so a distinct prefix keeps the two key
 * spaces apart; content addressing makes the same picture stored once across
 * replies and versions.
 */
export const REPLY_MEDIA_KEY_PREFIX = 'out:sha256:';

/** The media_cache key of a delivered picture's bytes */
export const replyMediaKeyOf = (data: Buffer): string =>
    `${REPLY_MEDIA_KEY_PREFIX}${createHash('sha256').update(data).digest('hex')}`;

/** Where one picture of the reply goes: inside the rich body or after it */
export type ReplyMediaPlacement = 'inline' | 'attachment';

/**
 * One picture stored in a reply version. `mediaKey` absent means a legacy
 * single-image version whose bytes stay in `imageBase64`.
 */
export interface StoredReplyMedia {
    placement: ReplyMediaPlacement;
    /** inline only: the media id the rich markdown references (`img1`…) */
    id?: string;
    /** media_cache key of the bytes (replyMediaKeyOf) */
    mediaKey?: string;
    mimeType: string;
    sizeBytes: number;
    /** inline: the rich media block's caption source; attachment: the message caption */
    caption?: string;
    /** Captured from the API response when available; not a source of truth */
    fileId?: string;
    fileUniqueId?: string;
}

/** One picture about to be delivered, with its bytes still in memory */
export interface ReplyImageDelivery {
    placement: ReplyMediaPlacement;
    data: Buffer;
    mimeType: string;
    caption?: string;
    /** inline only */
    id?: string;
}

/** How the reply's pictures were actually delivered, for version storage */
export type ReplyImageDeliveryMode = 'rich' | 'attachments' | 'dropped';

/** Pictures of one reply, in delivery order (inline ones first as they appear) */
export type ReplyImages = readonly ReplyImageDelivery[];

/** Total bytes of the given pictures, for the per-reply budget */
export const replyImageBytesOf = (images: ReplyImages): number =>
    images.reduce((total, image) => total + image.data.length, 0);
