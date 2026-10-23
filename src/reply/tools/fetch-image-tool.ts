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
    type ReplyMediaState,
    type SearchCandidate,
} from './reply-media-state.js';
import { FETCH_IMAGE_TOOL_NAME } from './tool-names.js';

const DESCRIPTION =
    '读取一张图片进你的上下文（不发给用户），用于确认图里到底是什么、做 OCR、或作为生图参考。' +
    '可以传 search_id（搜索结果编号，形如 s3）、image_id（之前读取过的图，形如 img1）' +
    '或 url（上下文里出现过的图片直链）。默认读原图；只要认个大概可以传 view=\'thumbnail\'。' +
    '候选是动图（GIF）时，会转成视频给你看动作。' +
    '读过的图会得到编号 img1，可直接用于 send_image 或 generate_image 的 web_references。';

const INPUT_SCHEMA = {
    type: 'object',
    properties: {
        search_id: { type: 'string', description: "搜索结果里的候选编号，形如 's3'" },
        image_id: { type: 'string', description: "已经读取过的图编号，形如 'img1'" },
        url: { type: 'string', description: '上下文里出现过的 http(s) 图片直链' },
        view: {
            type: 'string',
            enum: ['original', 'thumbnail'],
            description: "original（默认）= 原图；thumbnail = 缩略图，快且省 token。",
        },
    },
};

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
            description: DESCRIPTION,
            inputSchema: INPUT_SCHEMA,
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

            const candidate =
                args.searchId !== undefined
                    ? state.candidates.get(args.searchId)
                    : args.url !== undefined
                      ? candidateOfUrl(args.url)
                      : undefined;
            if (!candidate) {
                return imageToolError(
                    args.searchId !== undefined
                        ? mediaToolErrors.unknownCandidate(args.searchId)
                        : mediaToolErrors.urlNotAllowed
                );
            }
            if (args.url !== undefined && !state.allowedUrls.has(args.url)) {
                return imageToolError(mediaToolErrors.urlNotAllowed);
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
