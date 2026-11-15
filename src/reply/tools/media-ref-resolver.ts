/**
 * One image reference → bytes.
 *
 * Two features speak the same ids: `send_image` (a tool call names what to
 * deliver) and the rich body's inline markers (`![caption](g1)` names where a
 * picture goes). Both resolve through this module, so a candidate, a fetched
 * picture, a drawn one, a context image and a plain URL behave identically and
 * the two paths cannot drift apart.
 *
 * The ids are the ones the model already knows from the tool results and the
 * context: `g1` a picture `generate_image` drew in this reply, `img1` one
 * `fetch_image` read, `s1` a `search_images` candidate, `#12` / `#12:2` a
 * picture of a context message, and `https://…` a public image URL.
 */
import type { SniffedMediaMime } from '../../ai/image-generation/image-mime.js';
import { sniffMediaMime } from '../../ai/image-generation/image-mime.js';
import { fetchImageBytes } from '../../services/image-fetch-service.js';
import { loadMessageImages } from '../commands/reference-images.js';
import type { ContextIndex } from '../context-index.js';
import { mediaToolErrors } from './image-tool-text.js';
import { loadContextImages, type MessageImageLoader } from './image-references.js';
import {
    downloadCandidateMedia,
    MAX_ORIGINAL_IMAGE_BYTES,
    type ImageDownloadDependencies,
    type ImageFetch,
} from './image-source-download.js';
import type { ReplyMediaState, SearchCandidate } from './reply-media-state.js';

/** What the resolver needs from outside: a downloader and a message-image loader */
export interface MediaRefDependencies {
    readonly fetchImage: ImageFetch;
    readonly loadMessageImages: MessageImageLoader;
}

/** Production wiring: the same downloader and loader `send_image` always used */
export const PRODUCTION_MEDIA_REF_DEPENDENCIES: MediaRefDependencies = {
    fetchImage: fetchImageBytes,
    loadMessageImages,
};

/** A reference the model wrote, already classified */
export type MediaRef =
    | { readonly kind: 'id'; readonly id: string }
    | { readonly kind: 'candidate'; readonly id: string }
    | { readonly kind: 'message'; readonly number: number; readonly image: number }
    | { readonly kind: 'url'; readonly url: string };

/** The bytes one reference resolves to */
export interface ResolvedMediaBytes {
    /** What the chat receives: a GIF stays a GIF */
    readonly data: Buffer;
    readonly mimeType: SniffedMediaMime;
    /** What the model sees (and already saw, for a fetched image) */
    readonly still: { readonly data: Buffer; readonly mimeType: SniffedMediaMime };
    readonly sourcePage: string;
    readonly title?: string;
    /** Why this is not the original, when it is not */
    readonly note?: string;
    readonly candidateId?: string;
    readonly imageId?: string;
    /** `g1`: a picture this reply drew */
    readonly generatedId?: string;
    readonly contextNumber?: number;
}

export type MediaRefResolution =
    | (ResolvedMediaBytes & { readonly ok: true })
    | { readonly ok: false; readonly error: string };

export interface MediaRefResolveOptions {
    /** This reply's tool state: drawn and fetched pictures, candidates */
    readonly state: ReplyMediaState;
    readonly chatId: number;
    /** How the context numbered its messages: `#12` resolves through it */
    readonly contextIndex: ContextIndex;
    /** The reply's stop signal, when it has one */
    readonly signal?: AbortSignal;
    readonly dependencies?: MediaRefDependencies;
}

const GENERATED_OR_FETCHED = /^(?:g|img)\d+$/;
const CANDIDATE = /^s\d+$/;
const CONTEXT_MESSAGE = /^#(\d{1,3})(?::(\d+))?$/;

/**
 * Classify a reference as the model wrote it; null for anything this bot does
 * not resolve (an unknown id, a relative path, a malformed URL). A caller that
 * gets null leaves the text alone instead of turning it into a picture.
 */
export const parseMediaRef = (text: string): MediaRef | null => {
    const trimmed = text.trim();
    if (GENERATED_OR_FETCHED.test(trimmed)) return { kind: 'id', id: trimmed };
    if (CANDIDATE.test(trimmed)) return { kind: 'candidate', id: trimmed };
    const message = CONTEXT_MESSAGE.exec(trimmed);
    if (message !== null) {
        const number = Number(message[1]);
        const image = message[2] === undefined ? 1 : Number(message[2]);
        if (Number.isSafeInteger(number) && Number.isSafeInteger(image) && image >= 1) {
            return { kind: 'message', number, image };
        }
        return null;
    }
    if (/^https?:\/\/\S+$/.test(trimmed)) return { kind: 'url', url: trimmed };
    return null;
};

/** A bare URL as a candidate the downloader understands */
const urlCandidate = (url: string): SearchCandidate => {
    let domain = url;
    try {
        domain = new URL(url).hostname.replace(/^www\./, '');
    } catch {
        // Kept as the raw url; it was validated before this point
    }
    return {
        id: 'url',
        searchId: 'url',
        title: url,
        sourcePage: url,
        domain,
        imageUrl: url,
        thumbnailUrl: url,
        sendKind: 'static',
    };
};

/** The pictures of one context message, numbered as the context showed them */
const resolveMessageImage = async (
    contextNumber: number,
    imageIndex: number,
    options: MediaRefResolveOptions,
    dependencies: MediaRefDependencies
): Promise<MediaRefResolution> => {
    const entry = options.contextIndex.get(contextNumber);
    if (!entry) {
        return { ok: false, error: `#${contextNumber} 不在当前上下文里` };
    }

    const images = await loadContextImages(options.chatId, entry, dependencies.loadMessageImages);
    if (images.length === 0) {
        return { ok: false, error: `#${contextNumber} 这条消息没有可用的图片` };
    }

    const stored = images[imageIndex - 1];
    if (!stored) {
        return {
            ok: false,
            error: `#${contextNumber} 只有 ${images.length} 张图，没有第 ${imageIndex} 张`,
        };
    }

    // A picture kept in cloud storage is one of the >20MB originals
    if (stored.kind === 'cloud') {
        return { ok: false, error: mediaToolErrors.tooLarge(MAX_ORIGINAL_IMAGE_BYTES / 1024 / 1024) };
    }

    const data = stored.data;
    const mimeType = sniffMediaMime(data);
    if (!mimeType) return { ok: false, error: mediaToolErrors.notAnImage };
    if (data.length > MAX_ORIGINAL_IMAGE_BYTES) {
        return { ok: false, error: mediaToolErrors.tooLarge(MAX_ORIGINAL_IMAGE_BYTES / 1024 / 1024) };
    }

    return {
        ok: true,
        data,
        mimeType,
        still: { data, mimeType },
        sourcePage: '',
        contextNumber,
    };
};

/**
 * Resolve one reference to its bytes. Never throws for a bad reference: the
 * caller gets the model-facing reason and decides whether to skip the picture
 * or to fail the call.
 */
export const resolveMediaRef = async (
    ref: MediaRef,
    options: MediaRefResolveOptions
): Promise<MediaRefResolution> => {
    const dependencies = options.dependencies ?? PRODUCTION_MEDIA_REF_DEPENDENCIES;

    if (ref.kind === 'id') {
        // A picture the model drew in this reply, or one fetch_image read
        const drawn = options.state.generated.get(ref.id);
        if (drawn) {
            return {
                ok: true,
                data: drawn.data,
                mimeType: drawn.mimeType,
                still: { data: drawn.data, mimeType: drawn.mimeType },
                sourcePage: '',
                generatedId: drawn.id,
            };
        }
        const existing = options.state.fetched.get(ref.id);
        if (!existing) return { ok: false, error: mediaToolErrors.unknownFetched(ref.id) };
        return {
            ok: true,
            data: existing.data,
            mimeType: existing.mimeType,
            still: existing.still,
            sourcePage: existing.sourcePage,
            ...(existing.title === undefined ? {} : { title: existing.title }),
            imageId: existing.id,
            ...(existing.candidateId === undefined ? {} : { candidateId: existing.candidateId }),
        };
    }

    if (ref.kind === 'message') {
        return resolveMessageImage(ref.number, ref.image, options, dependencies);
    }

    const candidate =
        ref.kind === 'candidate' ? options.state.candidates.get(ref.id) : urlCandidate(ref.url);
    if (candidate === undefined) {
        return {
            ok: false,
            error: mediaToolErrors.unknownCandidate(ref.kind === 'candidate' ? ref.id : ref.url),
        };
    }

    const downloadDependencies: ImageDownloadDependencies = {
        fetchImage: dependencies.fetchImage,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    const downloaded = await downloadCandidateMedia(candidate, downloadDependencies);
    if (!downloaded.ok) return { ok: false, error: mediaToolErrors.downloadFailed(downloaded.error) };

    const { media } = downloaded;
    return {
        ok: true,
        data: media.deliverable.data,
        mimeType: media.deliverable.mimeType,
        still: media.still,
        sourcePage: candidate.sourcePage,
        ...(candidate.title === candidate.sourcePage ? {} : { title: candidate.title }),
        ...(media.deliverable.note === undefined ? {} : { note: media.deliverable.note }),
        ...(ref.kind === 'candidate' ? { candidateId: ref.id } : {}),
    };
};
