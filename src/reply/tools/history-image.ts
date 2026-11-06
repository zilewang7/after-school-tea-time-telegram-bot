/**
 * The history lane of fetch_image: an `hN` (or a t.me message link) → the
 * picture of that archived message.
 *
 * luoxu answers in two steps — which images the message carries
 * (`/message-images`) and the bytes of one of them (`/message-image?which=`) —
 * so the ordering and the "which one is worth showing" decision live here, in
 * one place, instead of being re-derived from the index text's `[image]`
 * markers (that is what made the two image inventories disagree, live 1106878).
 *
 * A video or an animation never enters the context as video: Telegram's own
 * thumbnail of one is its first frame, and only when there is no thumbnail do
 * the bytes get decoded through the converter.
 */
import {
    sniffImageMime,
    type SniffedImageMime,
} from '../../ai/image-generation/image-mime.js';
import {
    HISTORY_IMAGE_MAX_BYTES,
    type HistoryImageItem,
    type HistoryImageManifest,
    type HistoryMedia,
    type HistoryService,
} from '../../services/luoxu-history-service.js';
import { extractVideoFrame, type ExtractedFrame } from '../../services/tgs-client.js';
import { MAX_ORIGINAL_IMAGE_BYTES } from './image-source-download.js';
import { HISTORY_REF_HINT, parseHistoryReference } from './history-args.js';
import { mediumHintOf } from './history-text.js';
import type { HistoryState } from './history-state.js';
import { describeFailure, messageLink } from './history-tool-shared.js';

/** Decoder seam: tests pass a stub instead of the converter service */
export type HistoryFrameExtractor = (
    video: Buffer,
    mimeType: string,
    signal: AbortSignal
) => Promise<ExtractedFrame | null>;

export interface HistoryImageOptions {
    readonly state: HistoryState;
    readonly service: HistoryService;
    /** luoxu channel id of this chat; null when the chat is not archived */
    readonly channelId: number | null;
    readonly ownerUserId: number | null;
    readonly requesterUserId: number | null;
    /** Absent = the converter service */
    readonly extractFrame?: HistoryFrameExtractor;
}

/** One picture of an archived message, ready to hand to a model */
export interface ResolvedHistoryImage {
    readonly data: Buffer;
    readonly mimeType: SniffedImageMime;
    /** "消息图片" / "网页预览图" / "Instant View 第 1 张图" … */
    readonly label: string;
    /** 1-based position among this message's images */
    readonly index: number;
    readonly total: number;
    /** `h3` or the t.me link, as the model referred to it */
    readonly reference: string;
    readonly sourcePage: string;
    readonly width: number | null;
    readonly height: number | null;
    /** Why this is not the original, when it is not */
    readonly note: string | null;
    readonly items: readonly HistoryImageItem[];
}

export type HistoryImageOutcome =
    | { readonly ok: true; readonly image: ResolvedHistoryImage }
    | { readonly ok: false; readonly error: string };

/** How many page images precede this one, so its label says "第 2 张" */
const pageOrdinal = (items: readonly HistoryImageItem[], index: number): number =>
    items.slice(0, index + 1).filter((item) => item.source === 'page').length;

export const historyImageLabel = (item: HistoryImageItem, ordinal: number): string => {
    if (item.source === 'rich') return '富文本图片';
    if (item.source === 'preview') return '网页预览图';
    if (item.source === 'page') return `Instant View 第 ${ordinal} 张图`;

    if (item.kind === 'photo') return '消息图片';
    if (item.kind === 'sticker') return '贴纸';
    if (item.kind === 'animation') return '动图';
    if (item.kind === 'video') return '视频';
    return item.fileName === null ? '文件图片' : `文件图片 ${item.fileName}`;
};

/** `1 消息图片、2 网页预览图、3 Instant View 第 1 张图` */
export const describeHistoryImages = (items: readonly HistoryImageItem[]): string =>
    items
        .map((item, index) => `${index + 1} ${historyImageLabel(item, pageOrdinal(items, index))}`)
        .join('、');

/** Why a message has no image, said with the medium it does carry */
const describeEmptyMessage = (reference: string, media: HistoryMedia | null): string => {
    const medium = mediumHintOf(media);
    return medium === ''
        ? `${reference} 没有图片，也没有其它附件。`
        : `${reference} 没有图片，它的附件是 ${medium}。`;
};

type ResolvedReference =
    | { readonly channelId: number; readonly messageId: number; readonly label: string }
    | { readonly error: string };

const resolveReference = (options: HistoryImageOptions, text: string): ResolvedReference => {
    const reference = parseHistoryReference(text);
    if (reference === null) return { error: `无法识别的引用「${text}」。${HISTORY_REF_HINT}` };

    if (reference.kind === 'number') {
        const entry = options.state.entryOf(reference.h);
        if (!entry) return { error: `没有 h${reference.h}——它不在本次回复的历史结果里。` };
        return { channelId: entry.channelId, messageId: entry.messageId, label: `h${reference.h}` };
    }
    if (reference.kind === 'context') {
        return { error: `#${reference.number} 的图已经在你这一轮的上下文里了，不需要从归档重读。` };
    }

    const isOwner = options.ownerUserId !== null && options.requesterUserId === options.ownerUserId;
    if (!isOwner && reference.channelId !== options.channelId) {
        return { error: '只能读取本群的消息。' };
    }
    return {
        channelId: reference.channelId,
        messageId: reference.messageId,
        label: messageLink(reference.channelId, reference.messageId),
    };
};

type Picture =
    | { readonly ok: true; readonly data: Buffer; readonly mimeType: SniffedImageMime; readonly fromFrame: boolean }
    | { readonly ok: false; readonly error: string };

/** Bytes as something a model can read; a video becomes its first frame */
const asPicture = async (
    data: Buffer,
    mime: string,
    signal: AbortSignal,
    extractFrame: HistoryFrameExtractor
): Promise<Picture> => {
    const direct = sniffImageMime(data);
    if (direct !== null) return { ok: true, data, mimeType: direct, fromFrame: false };

    if (mime.startsWith('video/')) {
        const frame = await extractFrame(data, mime, signal);
        if (frame === null) return { ok: false, error: '这段动图/视频的首帧没解码出来。' };
        return { ok: true, data: frame.data, mimeType: frame.mimeType, fromFrame: true };
    }
    return { ok: false, error: `这张图的格式读不了（${mime}，只支持 PNG、JPEG、WebP）。` };
};

interface Download {
    readonly ok: true;
    readonly picture: Picture & { readonly ok: true };
    /** The bytes are smaller than the original, i.e. luoxu served a thumbnail */
    readonly servedThumbnail: boolean;
    /** A format we cannot read, retried as the thumbnail Telegram keeps of it */
    readonly fromThumbnailRetry: boolean;
}

const downloadPicture = async (
    options: HistoryImageOptions,
    channelId: number,
    messageId: number,
    item: HistoryImageItem,
    wantThumbnail: boolean,
    signal: AbortSignal
): Promise<Download | { readonly ok: false; readonly error: string }> => {
    const extractFrame = options.extractFrame ?? extractVideoFrame;
    const fetchBytes = async (thumb: boolean) => {
        try {
            return await options.service.imageBytes(channelId, messageId, item.which, { thumb, signal });
        } catch (error) {
            throw new Error(describeFailure(error));
        }
    };

    let bytes;
    try {
        bytes = await fetchBytes(wantThumbnail);
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (bytes === null) return { ok: false, error: '这张图在归档里取不到了（可能已被删除）。' };

    const servedThumbnail = wantThumbnail && item.size !== null && bytes.data.length < item.size;
    const picture = await asPicture(bytes.data, bytes.mime, signal, extractFrame);
    if (picture.ok) {
        return { ok: true, picture, servedThumbnail, fromThumbnailRetry: false };
    }

    // An unreadable original may still have the JPEG thumbnail Telegram keeps
    if (wantThumbnail) return { ok: false, error: picture.error };
    let thumbnail;
    try {
        thumbnail = await fetchBytes(true);
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (thumbnail === null) return { ok: false, error: picture.error };

    const retried = await asPicture(thumbnail.data, thumbnail.mime, signal, extractFrame);
    if (!retried.ok) return { ok: false, error: picture.error };
    return { ok: true, picture: retried, servedThumbnail: true, fromThumbnailRetry: true };
};

const noteOf = (
    view: 'original' | 'thumbnail',
    download: Download,
    item: HistoryImageItem,
    oversized: boolean,
    animated: boolean
): string | null => {
    // Telegram's own thumbnail of a video is its first frame, so both paths
    // give the model the same thing
    if (animated) return '动图/视频的首帧';
    if (download.fromThumbnailRetry) return '原格式读不了，给你的是缩略图';
    if (!download.servedThumbnail) return null;
    if (view === 'thumbnail') return '缩略图';
    if (!oversized || item.size === null) return null;
    return `原图 ${Math.round(item.size / 1024 / 1024)}MB，超过 ${MAX_ORIGINAL_IMAGE_BYTES / 1024 / 1024}MB 上限，给你的是缩略图`;
};

const pickImage = (
    manifest: HistoryImageManifest,
    reference: string,
    index: number
): { readonly item: HistoryImageItem } | { readonly error: string } => {
    if (manifest.images.length === 0) {
        return { error: describeEmptyMessage(reference, manifest.media) };
    }
    if (index > manifest.images.length) {
        return {
            error:
                `${reference} 只有 ${manifest.images.length} 张图，没有第 ${index} 张` +
                `（${describeHistoryImages(manifest.images)}）。`,
        };
    }
    const item = manifest.images[index - 1];
    return item ? { item } : { error: `${reference} 没有第 ${index} 张图。` };
};

/**
 * Read one picture of an archived message. Every failure is a sentence the
 * model can act on; nothing here throws.
 */
export const loadHistoryImage = async (
    options: HistoryImageOptions,
    text: string,
    index: number,
    view: 'original' | 'thumbnail',
    signal: AbortSignal
): Promise<HistoryImageOutcome> => {
    const resolved = resolveReference(options, text);
    if ('error' in resolved) return { ok: false, error: resolved.error };

    let manifest: HistoryImageManifest;
    try {
        manifest = await options.service.images(resolved.channelId, resolved.messageId, { signal });
    } catch (error) {
        return { ok: false, error: describeFailure(error) };
    }

    const picked = pickImage(manifest, resolved.label, index);
    if ('error' in picked) return { ok: false, error: picked.error };
    const { item } = picked;

    const animated = item.kind === 'video' || item.kind === 'animation' || item.mime.startsWith('video/');
    const oversized = item.size !== null && item.size > MAX_ORIGINAL_IMAGE_BYTES;
    // A video/animation is only ever shown by its still, so it always takes the
    // cheap variant; an oversized original does too.
    const wantThumbnail = view === 'thumbnail' || animated || oversized;

    const download = await downloadPicture(
        options,
        resolved.channelId,
        resolved.messageId,
        item,
        wantThumbnail,
        signal
    );
    if (!download.ok) return { ok: false, error: `${resolved.label}：${download.error}` };
    if (download.picture.data.length > HISTORY_IMAGE_MAX_BYTES) {
        return { ok: false, error: `${resolved.label} 的图太大，没法放进上下文。` };
    }

    return {
        ok: true,
        image: {
            data: download.picture.data,
            mimeType: download.picture.mimeType,
            label: historyImageLabel(item, pageOrdinal(manifest.images, index - 1)),
            index,
            total: manifest.images.length,
            reference: resolved.label,
            sourcePage: messageLink(resolved.channelId, resolved.messageId),
            width: item.width,
            height: item.height,
            note: noteOf(view, download, item, oversized, animated),
            items: manifest.images,
        },
    };
};

/**
 * What the model reads after a history picture arrives: which one it got, what
 * else that message carries, and the two calls that can use the id.
 */
export const formatHistoryImageResult = (id: string, image: ResolvedHistoryImage): string => {
    const size =
        image.width !== null && image.height !== null ? `${image.width}x${image.height}，` : '';
    const note = image.note === null ? '' : `，${image.note}`;
    const others =
        image.total > 2 ? `；换一张用 image=2–${image.total}` : image.total === 2 ? '；换一张用 image=2' : '';
    return [
        `已读取 ${id}：${image.reference} 第 ${image.index}/${image.total} 张（${image.label}），` +
            `${size}${image.mimeType}，${Math.round(image.data.length / 1024)}KB${note}。`,
        `来源页：${image.sourcePage}`,
        `这条消息共 ${image.total} 张图：${describeHistoryImages(image.items)}${others}。`,
        `可以直接作为 generate_image 的参考图（web_references），或 send_image(image_id='${id}') 发出。`,
    ].join('\n');
};
