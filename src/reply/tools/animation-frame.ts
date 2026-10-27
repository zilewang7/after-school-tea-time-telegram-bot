/**
 * The still of an animated message.
 *
 * A GIF or an animated sticker reaches the context as a video part, so it has
 * no picture a tool can reference. The bytes already live in the media cache;
 * the converter service decodes the first frame, and that frame stands in for
 * the animation wherever a still is needed (generate_image references,
 * search_by_image).
 */
import { getMessage } from '../../db/index.js';
import { getCachedMedia } from '../../services/media-cache-service.js';
import { extractVideoFrame, type ExtractedFrame } from '../../services/tgs-client.js';
import type { LoadedContextImage } from './image-references.js';

/** Media kinds whose first frame is a meaningful still */
const ANIMATION_KINDS = new Set(['animation', 'video_sticker', 'animated_sticker']);

export type AnimationFrameLoader = (
    chatId: number,
    messageId: number
) => Promise<LoadedContextImage | null>;

/** Decoder seam: tests pass a stub instead of the converter service */
export type FrameExtractor = (
    video: Buffer,
    mimeType: string
) => Promise<ExtractedFrame | null>;

/**
 * One message's first frame, or null when it is not an animation, its bytes
 * are gone, or the converter is unavailable. Never throws: a missing still is
 * an ordinary "no picture" for the caller.
 */
export const createAnimationFrameLoader = (
    extract: FrameExtractor = extractVideoFrame
): AnimationFrameLoader => async (chatId, messageId) => {
    const message = await getMessage(chatId, messageId);
    if (!message?.fileUniqueId) return null;

    const cached = await getCachedMedia(message.fileUniqueId);
    if (!cached || !ANIMATION_KINDS.has(cached.kind) || !cached.mime.startsWith('video/')) {
        return null;
    }

    // >20MB media lives in GCS; decoding would cost an egress download
    if (cached.fileUri) return { kind: 'cloud' };
    if (!cached.data || cached.data.length === 0) return null;

    const startedAt = Date.now();
    const frame = await extract(cached.data, cached.mime);
    if (!frame) {
        console.warn(
            `[animation-frame] failed uid=${message.fileUniqueId} mime=${cached.mime} bytes=${cached.data.length}`
        );
        return null;
    }

    console.log(
        `[animation-frame] ok uid=${message.fileUniqueId} mime=${frame.mimeType} ` +
            `bytes=${frame.data.length} ms=${Date.now() - startedAt}`
    );
    return { kind: 'bytes', data: frame.data };
};

/** Production loader: first frame through tgs-converter */
export const loadAnimationFrame: AnimationFrameLoader = createAnimationFrameLoader();
