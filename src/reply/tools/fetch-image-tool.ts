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
import type { ToolHandler, ToolModelImage, ToolResult } from '../../ai/tools/tool-types.js';
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
    '将一张图片加载到当前上下文中（仅模型可见，不发送给用户），用于查看细节、识别文字或作为生图参考。' +
    '支持传入 search_id（搜索候选编号，如 s3）、image_id（已读取图片编号，如 img1）或 url（http(s) 图片直链）。' +
    "默认读取原图；传 view='thumbnail' 则读取缩略图。GIF 动图会转换为视频以展示完整动作。" +
    '读取后返回编号 imgN，可用于 send_image 或 generate_image 的 web_references。';

const STICKER_DESCRIPTION =
    '也可传入 sticker（贴纸包内序号 01–72，或 send_sticker 目录里的画面名称）预览贴纸；' +
    '返回编号 stN，之后可用 send_sticker(sticker=…) 发出，或作为 generate_image 的 web_references。';

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
                      description: "贴纸包内序号（01–72）或 send_sticker 目录里的画面名称，如 '07'、'吃冰棒'",
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

/**
 * A rejected call leaves no other trace (the tool log keeps counts and errors
 * only), so the reason gets its own line — the rule send_sticker already
 * follows. The request is named by the one argument the model picked, and a
 * url only by its host: a query string can carry a secret.
 */
const REJECTION_LOG_MAX_CHARS = 200;

const hostOfUrl = (raw: string): string => {
    try {
        return new URL(raw).hostname;
    } catch {
        return '<无法解析的地址>';
    }
};

export const describeFetchImageRequest = (args: Readonly<Record<string, unknown>>): string => {
    const textOf = (key: string): string | undefined => {
        const value = args[key];
        return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
    };
    const sticker = textOf('sticker');
    if (sticker !== undefined) return `sticker=${sticker}`;
    const searchId = textOf('search_id');
    if (searchId !== undefined) return `search_id=${searchId}`;
    const imageId = textOf('image_id');
    if (imageId !== undefined) return `image_id=${imageId}`;
    const url = textOf('url');
    if (url !== undefined) return `url=${hostOfUrl(url)}`;
    return '没有取图来源';
};

/** The one line a rejection leaves behind; pure so a test can pin its shape */
export const fetchImageRejectionLine = (request: string, message: string): string =>
    Array.from(`${request} → ${message}`.replace(/\s+/g, ' '))
        .slice(0, REJECTION_LOG_MAX_CHARS)
        .join('');

const reject = (request: string, message: string): ToolResult => {
    console.warn(`[fetch_image] rejected: ${fetchImageRejectionLine(request, message)}`);
    return imageToolError(message);
};

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
            const request = describeFetchImageRequest(rawArgs);
            const parsed = parseFetchImageArgs(rawArgs);
            if (!parsed.ok) return reject(request, parsed.error);
            const args = parsed.args;

            // Re-reading is free: the bytes already ride the conversation
            if (args.imageId !== undefined) {
                const existing = state.fetched.get(args.imageId);
                if (!existing) return reject(request, mediaToolErrors.unknownFetched(args.imageId));
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
                if (!resolvedQuery.ok) return reject(request, resolvedQuery.error);
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
                if (!options.sticker) return reject(request, '这个模型/这一轮没有配置贴纸预览。');

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
                    return reject(request, message);
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
                return reject(request, mediaToolErrors.unknownCandidate(args.searchId ?? ''));
            }

            const downloaded = await downloadCandidateMedia(candidate, dependencies, {
                preferThumbnail: args.view === 'thumbnail',
            });
            if (!downloaded.ok) return reject(request, mediaToolErrors.downloadFailed(downloaded.error));

            const { media } = downloaded;
            if (media.deliverable.data.length > MAX_ORIGINAL_IMAGE_BYTES) {
                return reject(request, mediaToolErrors.tooLarge(MAX_ORIGINAL_IMAGE_BYTES / 1024 / 1024));
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
