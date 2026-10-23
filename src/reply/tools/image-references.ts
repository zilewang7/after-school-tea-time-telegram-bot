/**
 * generate_image references: `#N` (plus an optional 1-based image index) →
 * the bytes of that image, numbered exactly as the context showed it.
 *
 * A message's pictures are the ones its turn carried: its own attachments
 * first, then the media of its link previews. buildContext records that list
 * (`ContextIndexEntry.images`); the database loader is only the fallback for
 * pictures the turn did not carry — a bot reply whose bytes the daily cleanup
 * dropped but whose versions still keep them.
 *
 * Anything that cannot be used comes back as one error naming each problem,
 * followed by the context numbers that do carry images, so the model can fix
 * its call without guessing.
 */
import { sniffImageMime, type SniffedImageMime } from '../../ai/image-generation/image-mime.js';
import { inlineImageBytes } from '../context-images.js';
import type { ContextIndex, ContextIndexEntry } from '../context-index.js';
import type { MessageImage } from '../commands/reference-images.js';
import type { ImageReferenceArg } from './image-tool-args.js';

/** Reference images one request may carry */
export const MAX_REFERENCE_IMAGES = 6;
/** Inline request data limit per image */
export const MAX_REFERENCE_IMAGE_BYTES = 7 * 1024 * 1024;

export interface ReferenceImage {
    readonly data: Buffer;
    readonly mimeType: SniffedImageMime;
}

/** Images of one message as the context shows them (album members included) */
export type MessageImageLoader = (chatId: number, messageId: number) => Promise<readonly MessageImage[]>;

export interface ReferenceSource {
    readonly chatId: number;
    readonly contextIndex: ContextIndex;
    readonly loadMessageImages: MessageImageLoader;
}

export type ResolvedReferences =
    | { readonly ok: true; readonly images: readonly ReferenceImage[] }
    | { readonly ok: false; readonly error: string };

/**
 * One picture of a message: inline bytes, or a cloud-stored original (>20MB)
 * that no request can carry.
 */
export type LoadedContextImage =
    | { readonly kind: 'bytes'; readonly data: Buffer }
    | { readonly kind: 'cloud' };

/**
 * The pictures of one message, in context order. Reads the turn's own list and
 * falls back to the database only when the turn carried none.
 */
export const loadContextImages = async (
    chatId: number,
    entry: ContextIndexEntry,
    loadMessageImages: MessageImageLoader
): Promise<readonly LoadedContextImage[]> => {
    if (entry.images.length > 0) {
        return entry.images.map((image): LoadedContextImage => {
            const data = inlineImageBytes(image);
            return data === null ? { kind: 'cloud' } : { kind: 'bytes', data };
        });
    }

    const stored = await loadMessageImages(chatId, entry.messageId);
    return stored.map((image) => ({ kind: 'bytes', data: Buffer.from(image.data, 'base64') }));
};

type CheckedImage =
    | { readonly ok: true; readonly image: ReferenceImage }
    | { readonly ok: false; readonly problem: string };

interface ImagePick {
    /** `#N` and the image's position: the same pick twice is sent once */
    readonly key: string;
    readonly checked: CheckedImage;
}

/** `#3 的图` for a single image, `#3 的第 2 张图` inside an album */
const imageLabel = (contextNumber: number, imageNumber: number, imageCount: number): string =>
    imageCount > 1 ? `#${contextNumber} 的第 ${imageNumber} 张图` : `#${contextNumber} 的图`;

const checkImage = (loaded: LoadedContextImage, label: string): CheckedImage => {
    if (loaded.kind === 'cloud') {
        return { ok: false, problem: `${label}存在云端（超过 20MB），没法当参考` };
    }

    const { data } = loaded;
    const mimeType = sniffImageMime(data);
    if (mimeType === null) return { ok: false, problem: `${label}格式不支持（只支持 PNG、JPEG、WebP）` };
    if (data.length > MAX_REFERENCE_IMAGE_BYTES) return { ok: false, problem: `${label}超过 7MB` };
    return { ok: true, image: { data, mimeType } };
};

/** The images one reference points at, each checked */
const pickImages = (reference: ImageReferenceArg, loaded: readonly LoadedContextImage[]): ImagePick[] => {
    const imageNumbers =
        reference.image === undefined ? loaded.map((_, index) => index + 1) : [reference.image];

    return imageNumbers.map((imageNumber) => {
        const image = loaded[imageNumber - 1];
        return {
            key: `${reference.message}:${imageNumber}`,
            checked: image
                ? checkImage(image, imageLabel(reference.message, imageNumber, loaded.length))
                : {
                    ok: false,
                    problem: `#${reference.message} 只有 ${loaded.length} 张图，没有第 ${imageNumber} 张`,
                },
        };
    });
};

/** The context numbers that carry images, with how many each */
const describeImagesInContext = (contextIndex: ContextIndex): string => {
    const withImages = [...contextIndex.values()]
        .filter((entry) => entry.imageCount > 0)
        .sort((first, second) => first.number - second.number)
        .map((entry) => `#${entry.number}（${entry.imageCount} 张）`);
    return withImages.length > 0
        ? `当前上下文里带图的消息：${withImages.join('、')}`
        : '当前上下文里没有带图的消息';
};

export const resolveImageReferences = async (
    references: readonly ImageReferenceArg[],
    source: ReferenceSource
): Promise<ResolvedReferences> => {
    // One load per message, however many references point into it
    const imagesByNumber = new Map<number, readonly LoadedContextImage[]>();
    const loadImages = async (entry: ContextIndexEntry): Promise<readonly LoadedContextImage[]> => {
        const cached = imagesByNumber.get(entry.number);
        if (cached) return cached;
        const loaded = await loadContextImages(source.chatId, entry, source.loadMessageImages);
        imagesByNumber.set(entry.number, loaded);
        return loaded;
    };

    const pickedKeys = new Set<string>();
    const images: ReferenceImage[] = [];
    const problems: string[] = [];

    for (const reference of references) {
        const entry = source.contextIndex.get(reference.message);
        if (!entry) {
            problems.push(`#${reference.message} 不在当前上下文里`);
            continue;
        }

        const loaded = await loadImages(entry);
        if (loaded.length === 0) {
            problems.push(`#${reference.message} 这条消息没有可用的图片`);
            continue;
        }

        for (const pick of pickImages(reference, loaded)) {
            if (pickedKeys.has(pick.key)) continue;
            pickedKeys.add(pick.key);
            if (pick.checked.ok) {
                images.push(pick.checked.image);
            } else {
                problems.push(pick.checked.problem);
            }
        }
    }

    if (images.length > MAX_REFERENCE_IMAGES) {
        problems.push(`参考图最多 ${MAX_REFERENCE_IMAGES} 张，这次选了 ${images.length} 张；可以用 image 只选其中几张`);
    }

    if (problems.length > 0) {
        return {
            ok: false,
            error: [...new Set(problems), describeImagesInContext(source.contextIndex)].join('\n'),
        };
    }
    return { ok: true, images };
};
