/**
 * fetch_image: pull one specific picture into the model's context without
 * sending it anywhere. The companion to search_images for "let me look at that
 * one properly" — full size, OCR, or as a reference for generate_image.
 *
 * Reading the same image twice returns the first read: the bytes are already in
 * the conversation, and only the id is needed for send_image / generate_image.
 */
import type { ToolHandler } from '../../ai/tools/tool-types.js';
import { fetchImageBytes } from '../../services/image-fetch-service.js';
import { imageToolError } from './image-tool-result.js';
import { formatFetchResult, mediaToolErrors } from './image-tool-text.js';
import {
    candidateCaption,
    downloadCandidateImage,
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

export interface FetchImageToolOptions {
    readonly state: ReplyMediaState;
    readonly dependencies: ImageDownloadDependencies;
}

/** Production wiring; tests pass their own */
export const PRODUCTION_FETCH_DEPENDENCIES: ImageDownloadDependencies = { fetchImage: fetchImageBytes };

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
    originalSendable: true,
});

const thumbnailNoteOf = (candidate: SearchCandidate, usedThumbnail: boolean): string | undefined => {
    if (!usedThumbnail) return undefined;
    return candidate.originalSendable
        ? '原图取不到，给的是缩略图静帧'
        : '原图是动图或格式不支持，给的是缩略图静帧';
};

export const createFetchImageTool = (options: FetchImageToolOptions): ToolHandler => {
    const { state, dependencies } = options;

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

            const downloaded = await downloadCandidateImage(candidate, dependencies, {
                preferThumbnail: args.view === 'thumbnail',
            });
            if (!downloaded.ok) return imageToolError(mediaToolErrors.downloadFailed(downloaded.error));

            const { bytes } = downloaded;
            if (bytes.data.length > MAX_ORIGINAL_IMAGE_BYTES) {
                return imageToolError(mediaToolErrors.tooLarge(MAX_ORIGINAL_IMAGE_BYTES / 1024 / 1024));
            }

            const id = nextFetchedImageId(state);
            state.fetched.set(id, {
                id,
                data: bytes.data,
                mimeType: bytes.mimeType,
                sourcePage: candidate.sourcePage,
                ...(candidate.title === candidate.sourcePage ? {} : { title: candidate.title }),
                imageUrl: bytes.url,
                ...(args.searchId === undefined ? {} : { candidateId: args.searchId }),
            });

            const content = formatFetchResult({
                image: {
                    id,
                    mimeType: bytes.mimeType,
                    dataLength: bytes.data.length,
                    sourcePage: candidate.sourcePage,
                    ...(candidate.width === undefined ? {} : { width: candidate.width }),
                    ...(candidate.height === undefined ? {} : { height: candidate.height }),
                },
                ...(args.searchId === undefined ? {} : { fromCandidateId: args.searchId }),
                ...(thumbnailNoteOf(candidate, bytes.usedThumbnail) === undefined
                    ? {}
                    : { note: thumbnailNoteOf(candidate, bytes.usedThumbnail) }),
            });

            return {
                content,
                isError: false,
                images: [],
                modelImages: [
                    {
                        data: bytes.data,
                        mimeType: bytes.mimeType,
                        caption: args.searchId === undefined ? `[${id}] ${candidate.domain}` : candidateCaption(candidate),
                    },
                ],
                record: {
                    provider: 'mcp',
                    searchQueries: [`${FETCH_IMAGE_TOOL_NAME}: ${args.searchId ?? candidate.domain}`],
                    citations: [{ uri: candidate.sourcePage, title: candidate.title }],
                },
            };
        },
    };
};
