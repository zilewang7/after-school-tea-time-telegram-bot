/**
 * One fetch_image source → what the model gets for it, whichever lane it comes
 * from. The single read (one source per call) and the batch both go through
 * here; the lane owns its download, its safety rails, its state field and the
 * text a single read shows, while the caller owns ids and formatting.
 */
import type { StickerPreview, StickerSetApi } from '../../services/sticker-set-service.js';
import { downloadStickerPreview, StickerSetError } from '../../services/sticker-set-service.js';
import type { HistoryImageOptions } from './history-image.js';
import { formatHistoryImageResult, loadHistoryImage } from './history-image.js';
import { candidateCaption, downloadCandidateMedia, MAX_ORIGINAL_IMAGE_BYTES } from './image-source-download.js';
import { formatFetchResult, mediaToolErrors } from './image-tool-text.js';
import {
    laneSummaryOf,
    shortTitleOf,
    type FetchImageDependencies,
    type LaneOutcome,
} from './fetch-image-lane-types.js';
import { readAvatarSource, type AvatarLaneOptions } from './avatar-lane.js';
import type { FetchSource } from './media-tool-args.js';
import type { ReplyMediaState, SearchCandidate } from './reply-media-state.js';
import { padPackIndex, resolveStickerQuery } from './sticker-query.js';
import { traceParts, traceUrl } from './tool-trace.js';

/** The two lanes that download a public url through the shared downloader */
type MediaFetchSource =
    | { readonly kind: 'candidate'; readonly id: string }
    | { readonly kind: 'url'; readonly url: string };

export interface FetchReadContext {
    readonly state: ReplyMediaState;
    readonly dependencies: FetchImageDependencies;
    /** The platform replays an mp4 inside a tool result (Gemini today) */
    readonly canSeeAnimated: boolean;
    readonly view: 'original' | 'thumbnail';
    /** 1-based position among an archived message's pictures */
    readonly imageIndex: number;
    readonly signal: AbortSignal;
    /** Absent = this turn has no sticker tool */
    readonly sticker?: { readonly setName: string; readonly api: StickerSetApi };
    /** The archive lane; absent = this turn has no history tools */
    readonly history?: HistoryImageOptions;
    /** The avatar lane; absent = this turn cannot read avatars */
    readonly avatar?: AvatarLaneOptions;
}

/** A url the model supplied, dressed as a candidate so one downloader serves both */
const candidateOfUrl = (url: string): SearchCandidate => ({
    id: 'url',
    searchId: 'url',
    title: url,
    sourcePage: url,
    domain: (() => {
        try {
            return new URL(url).hostname.replace(/^www\./, '');
        } catch {
            return url;
        }
    })(),
    imageUrl: url,
    thumbnailUrl: url,
    sendKind: 'static',
});

/** A candidate's or a url's bytes, read exactly as a single fetch_image reads them */
const readMediaSource = async (
    source: MediaFetchSource,
    context: FetchReadContext
): Promise<LaneOutcome> => {
    const candidate =
        source.kind === 'candidate' ? context.state.candidates.get(source.id) : candidateOfUrl(source.url);
    if (!candidate) {
        return {
            ok: false,
            error: mediaToolErrors.unknownCandidate(source.kind === 'candidate' ? source.id : ''),
        };
    }

    const downloaded = await downloadCandidateMedia(candidate, context.dependencies, {
        preferThumbnail: context.view === 'thumbnail',
    });
    if (!downloaded.ok) return { ok: false, error: mediaToolErrors.downloadFailed(downloaded.error) };

    const { media } = downloaded;
    if (media.deliverable.data.length > MAX_ORIGINAL_IMAGE_BYTES) {
        return {
            ok: false,
            error: mediaToolErrors.tooLarge(MAX_ORIGINAL_IMAGE_BYTES / 1024 / 1024),
        };
    }

    const animated = media.deliverable.mimeType === 'image/gif';
    const mp4 =
        animated && context.canSeeAnimated && context.dependencies.transcodeAnimation !== undefined
            ? await context.dependencies.transcodeAnimation(media.deliverable.data)
            : null;
    const note = animated
        ? mp4 === null
            ? '动图，给你看的是第一帧'
            : '动图，已转成 mp4 给你看动作'
        : media.deliverable.note;
    const candidateId = source.kind === 'candidate' ? source.id : undefined;
    const label =
        source.kind === 'candidate'
            ? `候选 ${candidate.id}「${shortTitleOf(candidate.title)}」`
            : `直链 ${traceUrl(source.url)}`;

    return {
        ok: true,
        status: 'read',
        read: {
            kind: 'image',
            data: mp4 ?? media.still.data,
            mimeType: mp4 === null ? media.still.mimeType : 'video/mp4',
            register: (id) => {
                context.state.fetched.set(id, {
                    id,
                    data: media.deliverable.data,
                    mimeType: media.deliverable.mimeType,
                    still: media.still,
                    sourcePage: candidate.sourcePage,
                    ...(candidate.title === candidate.sourcePage ? {} : { title: candidate.title }),
                    imageUrl: candidate.imageUrl,
                    ...(candidateId === undefined ? {} : { candidateId }),
                });
            },
            materialize: (id) => {
                const caption =
                    source.kind === 'candidate' ? candidateCaption(candidate) : `[${id}] ${candidate.domain}`;
                return {
                    content: formatFetchResult({
                        image: {
                            id,
                            mimeType: media.deliverable.mimeType,
                            dataLength: media.deliverable.data.length,
                            sourcePage: candidate.sourcePage,
                            ...(candidate.width === undefined ? {} : { width: candidate.width }),
                            ...(candidate.height === undefined ? {} : { height: candidate.height }),
                        },
                        ...(candidateId === undefined ? {} : { fromCandidateId: candidateId }),
                        ...(note === undefined ? {} : { note }),
                    }),
                    caption: mp4 === null ? caption : `${caption}（动图，转成视频看动作）`,
                    traceResult: traceParts(
                        id,
                        candidate.width !== undefined && candidate.height !== undefined
                            ? `${candidate.width}×${candidate.height}`
                            : null
                    ),
                };
            },
            summary: laneSummaryOf({
                label,
                mimeType: media.deliverable.mimeType,
                dataLength: media.deliverable.data.length,
                width: candidate.width,
                height: candidate.height,
                note,
            }),
            sourcePage: candidate.sourcePage,
            citation: { uri: candidate.sourcePage, title: candidate.title },
            searchQuery: `fetch_image: ${candidateId ?? candidate.domain}`,
        },
    };
};

/** One picture of an archived message */
const readHistorySource = async (
    reference: string,
    context: FetchReadContext
): Promise<LaneOutcome> => {
    if (context.history === undefined) {
        return { ok: false, error: '这一轮没有历史归档工具，读不了归档里的图。' };
    }
    const resolved = await loadHistoryImage(
        context.history,
        reference,
        context.imageIndex,
        context.view,
        context.signal
    );
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { image } = resolved;
    const label = `${image.reference} 第 ${image.index}/${image.total} 张（${image.label}）`;

    return {
        ok: true,
        status: 'read',
        read: {
            kind: 'image',
            data: image.data,
            mimeType: image.mimeType,
            register: (id) => {
                context.state.fetched.set(id, {
                    id,
                    data: image.data,
                    mimeType: image.mimeType,
                    still: { data: image.data, mimeType: image.mimeType },
                    sourcePage: image.sourcePage,
                    title: `${image.reference} ${image.label}`,
                    imageUrl: image.sourcePage,
                });
            },
            materialize: (id) => ({
                content: formatHistoryImageResult(id, image),
                caption: label,
                traceResult: traceParts(
                    `${id} ${image.label}`,
                    image.total > 1 ? `${image.index}/${image.total}` : null,
                    image.width !== null && image.height !== null ? `${image.width}×${image.height}` : null
                ),
            }),
            summary: laneSummaryOf({
                label,
                mimeType: image.mimeType,
                dataLength: image.data.length,
                width: image.width,
                height: image.height,
                note: image.note,
            }),
            sourcePage: image.sourcePage,
            citation: { uri: image.sourcePage, title: `${image.reference} ${image.label}` },
            searchQuery: `fetch_image: ${image.reference}`,
        },
    };
};

/** One sticker preview of the pack */
const readStickerSource = async (query: string, context: FetchReadContext): Promise<LaneOutcome> => {
    const resolvedQuery = resolveStickerQuery(query, context.state);
    if (!resolvedQuery.ok) return { ok: false, error: resolvedQuery.error };
    const entry = resolvedQuery.entry;

    const existing = [...context.state.fetchedStickers.entries()].find(
        ([, packIndex]) => packIndex === entry.packIndex
    );
    if (existing !== undefined) {
        const [existingId] = existing;
        return {
            ok: true,
            status: 'reuse',
            id: existingId,
            content:
                `已经预览过 ${existingId}（${padPackIndex(entry.packIndex)} ${entry.label}），` +
                '贴纸就在上面的对话里，不用重复读取。\n' +
                `可以直接 send_sticker(sticker='${existingId}') 发出。`,
            traceResult: `已预览过 ${existingId}`,
        };
    }
    if (context.sticker === undefined) {
        return { ok: false, error: '这个模型/这一轮没有配置贴纸预览。' };
    }

    let preview: StickerPreview;
    try {
        preview = await downloadStickerPreview(
            context.sticker.api,
            context.sticker.setName,
            entry,
            'thumbnail',
            context.dependencies.signal
        );
    } catch (error) {
        const message =
            error instanceof StickerSetError
                ? error.message
                : `贴纸读不出来：${error instanceof Error ? error.message : String(error)}`;
        return { ok: false, error: message };
    }

    const name = `${padPackIndex(entry.packIndex)} ${entry.label}`;
    return {
        ok: true,
        status: 'read',
        read: {
            kind: 'sticker',
            data: preview.data,
            mimeType: preview.mimeType,
            register: (id) => {
                context.state.fetchedStickers.set(id, entry.packIndex);
            },
            materialize: (id) => ({
                content:
                    `已读取贴纸 ${id}：${name}（320 缩略图，${Math.round(preview.data.length / 1024)}KB）。\n` +
                    `想发就 send_sticker(sticker='${id}')。`,
                caption: `贴纸 ${id}：${name}`,
                traceResult: `${id} 预览 320`,
            }),
            summary: laneSummaryOf({
                label: `贴纸 ${name}（320 缩略图）`,
                mimeType: preview.mimeType,
                dataLength: preview.data.length,
            }),
            sourcePage: null,
        },
    };
};

/** An id the model already read: only the reminder, the bytes are in the conversation */
const readImageIdSource = (id: string, state: ReplyMediaState): LaneOutcome => {
    const existing = state.fetched.get(id);
    if (!existing) return { ok: false, error: mediaToolErrors.unknownFetched(id) };
    return {
        ok: true,
        status: 'reuse',
        id,
        content:
            `已经读过 ${existing.id}（${existing.mimeType}，${Math.round(existing.data.length / 1024)}KB），` +
            '图片就在上面的对话里，不用重复读取。\n' +
            `可以直接 send_image(image_id='${existing.id}') 发出，或作为 generate_image 的参考图。`,
        traceResult: '已读过',
    };
};

/** The one entry point: a normalized source → bytes, state field and text */
export const readFetchSource = async (
    source: FetchSource,
    context: FetchReadContext
): Promise<LaneOutcome> => {
    switch (source.kind) {
        case 'candidate':
        case 'url':
            return readMediaSource(source, context);
        case 'image':
            return readImageIdSource(source.id, context.state);
        case 'sticker':
            return readStickerSource(source.query, context);
        case 'history':
            return readHistorySource(source.reference, context);
        case 'avatar':
            if (context.avatar === undefined) return { ok: false, error: '这一轮没有配置头像读取。' };
            return readAvatarSource(source.target, context.view, context.state, context.avatar, context.signal);
    }
};
