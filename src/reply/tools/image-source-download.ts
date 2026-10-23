/**
 * One place where a search candidate becomes bytes.
 *
 * A candidate yields up to two things, and they are not the same bytes:
 * - `deliverable`: what the chat receives. A GIF goes out as an animation.
 * - `still`: the static frame the model reads and that generate_image may use
 *   as a reference (a GIF handed to a model is read as one frame anyway, and
 *   the image model does not take GIF references at all).
 *
 * For a static picture both are the original bytes. For a GIF the original
 * animation is delivered while SearXNG's proxied thumbnail is the still. A
 * candidate whose original cannot be used falls back to the thumbnail for both.
 */
import type { SniffedMediaMime } from '../../ai/image-generation/image-mime.js';
import type { ImageFetchOutcome } from '../../services/image-fetch-service.js';
import type { SearchCandidate } from './reply-media-state.js';

/** Telegram-friendly bound for a picture the bot sends or the model reads */
export const MAX_ORIGINAL_IMAGE_BYTES = 8 * 1024 * 1024;
/** SearXNG thumbnails are 2–16KB; this only guards a mislabelled original */
export const MAX_THUMBNAIL_BYTES = 512 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10_000;

export type ImageFetch = (
    url: string,
    options: { maxBytes: number; timeoutMs?: number; signal?: AbortSignal }
) => Promise<ImageFetchOutcome>;

export interface ImageDownloadDependencies {
    readonly fetchImage: ImageFetch;
    /** The reply's stop signal, when the caller has one */
    readonly signal?: AbortSignal;
}

export interface DeliverableMedia {
    readonly data: Buffer;
    readonly mimeType: SniffedMediaMime;
    /** Why this is not the original animation, when it is not */
    readonly note?: string;
}

/**
 * The frame the model reads. Usually a still (PNG/JPEG/WebP); a GIF only when
 * a bare URL was handed in and no separate thumbnail exists — Gemini reads it
 * as one frame, generate_image refuses it.
 */
export interface StillImage {
    readonly data: Buffer;
    readonly mimeType: SniffedMediaMime;
}

export interface CandidateMedia {
    /** What the chat receives */
    readonly deliverable: DeliverableMedia;
    /** What the model reads and generate_image may reference */
    readonly still: StillImage;
}

export type CandidateDownload =
    | { readonly ok: true; readonly media: CandidateMedia }
    | { readonly ok: false; readonly error: string };

const download = async (
    dependencies: ImageDownloadDependencies,
    url: string,
    maxBytes: number
): Promise<ImageFetchOutcome> =>
    dependencies.fetchImage(url, {
        maxBytes,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
    });

const asStill = (image: { data: Buffer; mimeType: SniffedMediaMime }): StillImage | null =>
    image.mimeType === 'image/gif' ? null : { data: image.data, mimeType: image.mimeType };

const href = async (
    dependencies: ImageDownloadDependencies,
    candidate: SearchCandidate
): Promise<CandidateDownload> => {
    const thumbnail = await download(dependencies, candidate.thumbnailUrl, MAX_THUMBNAIL_BYTES);
    if (!thumbnail.ok) return { ok: false, error: thumbnail.error };

    const still = asStill(thumbnail.image);
    if (!still) return { ok: false, error: '缩略图不是静态图片' };

    return {
        ok: true,
        media: {
            deliverable: {
                data: thumbnail.image.data,
                mimeType: thumbnail.image.mimeType,
                ...(candidate.sendKind === 'static'
                    ? {}
                    : { note: '动图或原图不可用，发的是缩略图静帧' }),
            },
            still,
        },
    };
};

/**
 * The candidate's bytes. `preferThumbnail` is the explicit `view='thumbnail'`
 * request: the model wants a quick look, not the original.
 */
export const downloadCandidateMedia = async (
    candidate: SearchCandidate,
    dependencies: ImageDownloadDependencies,
    options: { preferThumbnail?: boolean } = {}
): Promise<CandidateDownload> => {
    if (options.preferThumbnail === true) {
        const thumbnail = await download(dependencies, candidate.thumbnailUrl, MAX_THUMBNAIL_BYTES);
        if (!thumbnail.ok) return { ok: false, error: thumbnail.error };
        return {
            ok: true,
            media: {
                deliverable: { data: thumbnail.image.data, mimeType: thumbnail.image.mimeType },
                still: {
                    data: thumbnail.image.data,
                    mimeType: thumbnail.image.mimeType === 'image/gif' ? 'image/jpeg' : thumbnail.image.mimeType,
                },
            },
        };
    }

    const original = await download(dependencies, candidate.imageUrl, MAX_ORIGINAL_IMAGE_BYTES);

    // A GIF is delivered as-is but read as a still: the thumbnail is that still
    // (and the only picture a model can be given without sending megabytes)
    if (original.ok && original.image.mimeType === 'image/gif') {
        if (candidate.thumbnailUrl === candidate.imageUrl) {
            // A bare URL has no separate thumbnail: the GIF itself is the still
            return {
                ok: true,
                media: {
                    deliverable: { data: original.image.data, mimeType: 'image/gif' },
                    still: { data: original.image.data, mimeType: 'image/gif' },
                },
            };
        }
        const thumbnail = await download(dependencies, candidate.thumbnailUrl, MAX_THUMBNAIL_BYTES);
        if (!thumbnail.ok) return { ok: false, error: thumbnail.error };
        const still = asStill(thumbnail.image);
        if (!still) return { ok: false, error: '缩略图不是静态图片' };

        return {
            ok: true,
            media: {
                deliverable: { data: original.image.data, mimeType: 'image/gif' },
                still,
            },
        };
    }

    // A static original serves both purposes
    if (original.ok) {
        const still = asStill(original.image);
        if (still) {
            return {
                ok: true,
                media: {
                    deliverable: { data: original.image.data, mimeType: original.image.mimeType },
                    still,
                },
            };
        }
    }

    // Original unusable (too large, an HTML page, a broken link, wrong format)
    return href(dependencies, candidate);
};

/** The candidate's caption for a model-facing image */
export const candidateCaption = (candidate: SearchCandidate): string =>
    `[${candidate.id}] ${candidate.title} — ${candidate.domain}`;
