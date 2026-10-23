/**
 * The pictures of one context message, in the order the turn shows them.
 *
 * A message's pictures do not all live in the same place: its own attachments
 * come from the media cache, a web link's preview media and a t.me message
 * link's media come from two other caches. Tools that take a `#N` picture
 * reference (generate_image, send_image) must number them the way the model
 * sees them, so the list is captured once while the turn is assembled instead
 * of being re-derived from the database later.
 */
import type { UnifiedContentPart } from '../ai/types.js';

export type ContextImageOrigin = 'attachment' | 'linkPreview' | 'messageLink';

export interface ContextImage {
    readonly origin: ContextImageOrigin;
    /** The part the turn carries: inline imageData, or a media part with a gs:// fileUri */
    readonly part: UnifiedContentPart;
}

/** Whether the model looks at this part as a picture */
const isPicture = (part: UnifiedContentPart): boolean =>
    part.type === 'image' || (part.type === 'media' && (part.mimeType ?? '').startsWith('image/'));

export const contextImagesOf = (
    parts: readonly UnifiedContentPart[],
    origin: ContextImageOrigin
): ContextImage[] => parts.filter(isPicture).map((part) => ({ origin, part }));

/** Inline bytes of a picture; null when it only lives in cloud storage (>20MB) */
export const inlineImageBytes = (image: ContextImage): Buffer | null =>
    image.part.type === 'image' && image.part.imageData
        ? Buffer.from(image.part.imageData, 'base64')
        : null;
