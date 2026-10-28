/**
 * fetch_image: pull one specific picture into the model's context without
 * sending it anywhere. The companion to search_images for "let me look at that
 * one properly" — full size, OCR, or as a reference for generate_image.
 *
 * A GIF is different from a still picture here: handed over as `image/gif` a
 * model reads only its first frame (verified 2026-10-23 — `videoMetadata.fps`
 * is ignored for an image part), so the animation is re-encoded to mp4 and
 * replayed as a video part where the platform supports it. The chat still gets
 * the original GIF when the model sends it.
 *
 * Reading the same image twice returns the first read: the bytes are already in
 * the conversation, and only the id is needed for send_image / generate_image.
 */
import type { ToolHandler, ToolModelImage } from '../../ai/tools/tool-types.js';
import { fetchImageBytes } from '../../services/image-fetch-service.js';
import {
    downloadStickerPreview,
    StickerSetError,
    type StickerPreview,
    type StickerSetApi,
} from '../../services/sticker-set-service.js';
import { transcodeVideoToMp4 } from '../../services/tgs-client.js';
import { imageToolError } from './image-tool-result.js';
import { formatFetchResult, mediaToolErrors } from './image-tool-text.js';
import {
    candidateCaption,
    downloadCandidateMedia,
    MAX_ORIGINAL_IMAGE_BYTES,
    type ImageDownloadDependencies,
} from './image-source-download.js';
import { parseFetchImageArgs } from './media-tool-args.js';
import {
    nextFetchedImageId,
    nextFetchedStickerId,
    type ReplyMediaState,
    type SearchCandidate,
} from './reply-media-state.js';
import { padPackIndex, resolveStickerQuery } from './sticker-query.js';
import { FETCH_IMAGE_TOOL_NAME } from './tool-names.js';

const DESCRIPTION =
    '读取一张图片进你的上下文（不发给用户），用于确认图里到底是什么、做 OCR、或作为生图参考。' +
    '可以传 search_id（搜索结果编号，形如 s3）、image_id（之前读取过的图，形如 img1）' +
    '或 url（http(s) 图片直链）。默认读原图；只要认个大概可以传 view=\'thumbnail\'。' +
    '候选是动图（GIF）时，会转成视频给你看动作。' +
    '读过的图会得到编号 img1，可直接用于 send_image 或 generate_image 的 web_references。';

const STICKER_DESCRIPTION =
    '也可以传 sticker（贴纸包内序号或实际画面名称）读取贴纸，用于发送前确认画面；' +
    "读过的贴纸会得到 st1 编号，可直接 send_sticker(sticker='st1')，" +
    "也可以作为 generate_image 的参考（web_references 里 sticker='st1'）。";

const inputSchemaOf = (hasSticker: boolean) => ({
    type: 'object',
    properties: {
        search_id: { type: 'string', description: "搜索结果里的候选编号，形如 's3'" },
        image_id: { type: 'string', description: "已经读取过的图编号，形如 'img1'" },
        url: { type: 'string', description: 'http(s) 图片直链，可以是任意公开地址' },
        ...(hasSticker
            ? {
                  sticker: {
                      type: 'string',
                      description: "贴纸包内序号（01–72）或实际画面名称，如 '07'、'吃冰棒'、'st1'",
                  },
              }
            : {}),
        view: {
            type: 'string',
            enum: ['original', 'thumbnail'],
            description: "original（默认）= 原图；thumbnail = 缩略图，快且省 token。",
        },
    },
});

/** GIF → mp4, the only shape in which a model sees an animation move */
const transcodeGifToMp4 = async (gif: Buffer): Promise<Buffer | null> => {
    const result = await transcodeVideoToMp4(gif, 'image/gif');
    return result?.data ?? null;
};

export interface FetchImageDependencies extends ImageDownloadDependencies {
    /** Null/absent: no converter, the model gets the still frame */
    readonly transcodeAnimation?: (gif: Buffer) => Promise<Buffer | null>;
}

export interface FetchImageToolOptions {
    readonly state: ReplyMediaState;
    readonly dependencies: FetchImageDependencies;
    /** The platform replays an mp4 inside a tool result (Gemini today) */
    readonly canSeeAnimated?: boolean;
    /** Sticker previews; absent = this turn has no sticker tool */
    readonly sticker?: { readonly setName: string; readonly api: StickerSetApi };
}

/** Production wiring; tests pass their own */
export const PRODUCTION_FETCH_DEPENDENCIES: FetchImageDependencies = {
    fetchImage: fetchImageBytes,
    transcodeAnimation: transcodeGifToMp4,
};

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

export const createFetchImageTool = (options: FetchImageToolOptions): ToolHandler => {
    const { state, dependencies } = options;
    const canSeeAnimated = options.canSeeAnimated === true;

    return {
        definition: {
            name: FETCH_IMAGE_TOOL_NAME,
            description:
                options.sticker === undefined ? DESCRIPTION : `${DESCRIPTION}${STICKER_DESCRIPTION}`,
            inputSchema: inputSchemaOf(options.sticker !== undefined),
        },
        statusText: '🖼 正在读图…',
        chatAction: 'typing',
        execute: async (rawArgs) => {
            const parsed = parseFetchImageArgs(rawArgs);
            if (!parsed.ok) return imageToolError(parsed.error);
            const args = parsed.args;

            // Re-reading is free: the bytes already ride the conversation
            if (args.imageId !== undefined) {
                const existing = state.fetched.get(args.imageId);
                if (!existing) return imageToolError(mediaToolErrors.unknownFetched(args.imageId));
                return {
                    content:
                        `已经读过 ${existing.id}（${existing.mimeType}，${Math.round(existing.data.length / 1024)}KB），` +
                        '图片就在上面的对话里，不用重复读取。\n' +
                        `可以直接 send_image(image_id='${existing.id}') 发出，或作为 generate_image 的参考图。`,
                    isError: false,
                    images: [],
                    record: null,
                };
            }

            if (args.sticker !== undefined) {
                const resolvedQuery = resolveStickerQuery(args.sticker, state);
                if (!resolvedQuery.ok) return imageToolError(resolvedQuery.error);
                const entry = resolvedQuery.entry;
                const existing = [...state.fetchedStickers.entries()].find(
                    ([, packIndex]) => packIndex === entry.packIndex
                );
                if (existing) {
                    return {
                        content:
                            `已经预览过 ${existing[0]}（${padPackIndex(entry.packIndex)} ${entry.label}），` +
                            '贴纸就在上面的对话里，不用重复读取。\n' +
                            `可以直接 send_sticker(sticker='${existing[0]}') 发出。`,
                        isError: false,
                        images: [],
                        record: null,
                    };
                }
                if (!options.sticker) return imageToolError('这个模型/这一轮没有配置贴纸预览。');

                let preview: StickerPreview;
                try {
                    preview = await downloadStickerPreview(
                        options.sticker.api,
                        options.sticker.setName,
                        entry,
                        'thumbnail',
                        dependencies.signal
                    );
                } catch (error) {
                    const message =
                        error instanceof StickerSetError
                            ? error.message
                            : `贴纸读不出来：${error instanceof Error ? error.message : String(error)}`;
                    return imageToolError(message);
                }

                const id = nextFetchedStickerId(state);
                state.fetchedStickers.set(id, entry.packIndex);
                const caption = `贴纸 ${id}：${padPackIndex(entry.packIndex)} ${entry.label}`;
                return {
                    content:
                        `已读取${caption}（320 缩略图，${Math.round(preview.data.length / 1024)}KB）。\n` +
                        `想发就 send_sticker(sticker='${id}')。`,
                    isError: false,
                    images: [],
                    modelImages: [{ data: preview.data, mimeType: preview.mimeType, caption }],
                    record: null,
                };
            }

            const candidate =
                args.searchId !== undefined
                    ? state.candidates.get(args.searchId)
                    : candidateOfUrl(args.url ?? '');
            if (!candidate) {
                return imageToolError(mediaToolErrors.unknownCandidate(args.searchId ?? ''));
            }

            const downloaded = await downloadCandidateMedia(candidate, dependencies, {
                preferThumbnail: args.view === 'thumbnail',
            });
            if (!downloaded.ok) return imageToolError(mediaToolErrors.downloadFailed(downloaded.error));

            const { media } = downloaded;
            if (media.deliverable.data.length > MAX_ORIGINAL_IMAGE_BYTES) {
                return imageToolError(mediaToolErrors.tooLarge(MAX_ORIGINAL_IMAGE_BYTES / 1024 / 1024));
            }

            const id = nextFetchedImageId(state);
            state.fetched.set(id, {
                id,
                data: media.deliverable.data,
                mimeType: media.deliverable.mimeType,
                still: media.still,
                sourcePage: candidate.sourcePage,
                ...(candidate.title === candidate.sourcePage ? {} : { title: candidate.title }),
                imageUrl: candidate.imageUrl,
                ...(args.searchId === undefined ? {} : { candidateId: args.searchId }),
            });

            const caption =
                args.searchId === undefined ? `[${id}] ${candidate.domain}` : candidateCaption(candidate);
            const animated = media.deliverable.mimeType === 'image/gif';
            const mp4 =
                animated && canSeeAnimated && dependencies.transcodeAnimation !== undefined
                    ? await dependencies.transcodeAnimation(media.deliverable.data)
                    : null;
            const note = animated
                ? mp4 === null
                    ? '动图，给你看的是第一帧'
                    : '动图，已转成 mp4 给你看动作'
                : media.deliverable.note;
            const modelImage: ToolModelImage =
                mp4 === null
                    ? { data: media.still.data, mimeType: media.still.mimeType, caption }
                    : { data: mp4, mimeType: 'video/mp4', caption: `${caption}（动图，转成视频看动作）` };

            const content = formatFetchResult({
                image: {
                    id,
                    mimeType: media.deliverable.mimeType,
                    dataLength: media.deliverable.data.length,
                    sourcePage: candidate.sourcePage,
                    ...(candidate.width === undefined ? {} : { width: candidate.width }),
                    ...(candidate.height === undefined ? {} : { height: candidate.height }),
                },
                ...(args.searchId === undefined ? {} : { fromCandidateId: args.searchId }),
                note,
            });

            return {
                content,
                isError: false,
                images: [],
                modelImages: [modelImage],
                record: {
                    provider: 'mcp',
                    searchQueries: [`${FETCH_IMAGE_TOOL_NAME}: ${args.searchId ?? candidate.domain}`],
                    citations: [{ uri: candidate.sourcePage, title: candidate.title }],
                },
            };
        },
    };
};
