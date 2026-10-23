/**
 * One place where a search candidate becomes bytes: the original when it can
 * be sent or read, otherwise SearXNG's proxied thumbnail, which also covers
 * GIF sources as a still frame.
 */
import type { SniffedImageMime } from '../../ai/image-generation/image-mime.js';
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

export interface CandidateBytes {
    readonly data: Buffer;
    readonly mimeType: SniffedImageMime;
    /** The original was unusable, this is the thumbnail */
    readonly usedThumbnail: boolean;
    readonly url: string;
}

export type CandidateDownload =
    | { readonly ok: true; readonly bytes: CandidateBytes }
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

/**
 * The candidate's bytes. `preferThumbnail` is the explicit `view='thumbnail'`
 * request; a candidate that cannot be sent as-is (GIF/SVG/unknown) always uses
 * the thumbnail, and a failed original falls back to it too.
 */
export const downloadCandidateImage = async (
    candidate: SearchCandidate,
    dependencies: ImageDownloadDependencies,
    options: { preferThumbnail?: boolean } = {}
): Promise<CandidateDownload> => {
    if (options.preferThumbnail === true || !candidate.originalSendable) {
        const thumbnail = await download(dependencies, candidate.thumbnailUrl, MAX_THUMBNAIL_BYTES);
        if (thumbnail.ok) {
            return {
                ok: true,
                bytes: {
                    data: thumbnail.image.data,
                    mimeType: thumbnail.image.mimeType,
                    usedThumbnail: !options.preferThumbnail && !candidate.originalSendable,
                    url: candidate.thumbnailUrl,
                },
            };
        }
        return { ok: false, error: thumbnail.error };
    }

    const original = await download(dependencies, candidate.imageUrl, MAX_ORIGINAL_IMAGE_BYTES);
    if (original.ok) {
        return {
            ok: true,
            bytes: {
                data: original.image.data,
                mimeType: original.image.mimeType,
                usedThumbnail: false,
                url: candidate.imageUrl,
            },
        };
    }

    const thumbnail = await download(dependencies, candidate.thumbnailUrl, MAX_THUMBNAIL_BYTES);
    if (thumbnail.ok) {
        return {
            ok: true,
            bytes: {
                data: thumbnail.image.data,
                mimeType: thumbnail.image.mimeType,
                usedThumbnail: true,
                url: candidate.thumbnailUrl,
            },
        };
    }

    return { ok: false, error: `${original.error}；缩略图也取不到：${thumbnail.error}` };
};

/** The candidate's caption for a model-facing image */
export const candidateCaption = (candidate: SearchCandidate): string =>
    `[${candidate.id}] ${candidate.title} — ${candidate.domain}`;
