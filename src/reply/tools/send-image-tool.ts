/**
 * send_image: put a real, existing picture into the reply. The only way the
 * model gives the chat an image it did not draw — search candidates, pictures
 * it already read, a picture from the context, or a link the conversation
 * carried.
 *
 * Sharing one "this reply already has an image" flag with generate_image keeps
 * delivery and version storage to their one-image assumption.
 *
 * A picture the reply did not already show the model comes back as a
 * model-only image: the model has to see what it is about to send, or it
 * captions a candidate from its title and describes a picture the chat never
 * saw (live 1106627: text about a solo meme next to a group poster). An image
 * the model read with fetch_image, or one taken from a context message, is
 * already in the conversation — attaching it again would only double its
 * tokens.
 */
import { sniffImageMime, type SniffedImageMime } from '../../ai/image-generation/image-mime.js';
import type { ToolHandler } from '../../ai/tools/tool-types.js';
import { fetchImageBytes } from '../../services/image-fetch-service.js';
import { loadMessageImages } from '../commands/reference-images.js';
import type { MessageImageLoader } from './image-references.js';
import { imageToolError } from './image-tool-result.js';
import { formatSendResult, mediaToolErrors } from './image-tool-text.js';
import {
    downloadCandidateImage,
    MAX_ORIGINAL_IMAGE_BYTES,
    type ImageFetch,
    type ImageDownloadDependencies,
} from './image-source-download.js';
import { parseSendImageArgs } from './media-tool-args.js';
import type { ReplyToolContext } from './reply-tool-context.js';
import type { ReplyMediaState, SearchCandidate } from './reply-media-state.js';
import { SEND_IMAGE_TOOL_NAME } from './tool-names.js';

const DESCRIPTION =
    '把一张真实存在的图片发到聊天里（会附在你这条回复后面，每条回复最多一张）。' +
    '来源可以是 search_id（搜索结果编号）、image_id（fetch_image 读过的图）、' +
    'message（上下文里某条消息的编号 #N）或 url（上下文里出现过的直链）。' +
    '这是“把找到的图给用户看”的唯一方式：用户要表情包/截图/新闻图时，先 search_images 找到，' +
    '再用本工具发，不要用 generate_image 画一张冒充。';

const INPUT_SCHEMA = {
    type: 'object',
    properties: {
        search_id: { type: 'string', description: "搜索结果里的候选编号，形如 's3'" },
        image_id: { type: 'string', description: "fetch_image 读过的图编号，形如 'img1'" },
        message: {
            type: 'integer',
            minimum: 1,
            description: '上下文里的消息编号（#N 里的数字），发这条消息里的图',
        },
        image: {
            type: 'integer',
            minimum: 1,
            description: '这条消息里的第几张图，从 1 开始；省略=第一张',
        },
        url: { type: 'string', description: '上下文里出现过的 http(s) 图片直链' },
        caption: {
            type: 'string',
            description: '随图发出的配文；不需要就省略。',
        },
    },
};

export interface SendImageToolDependencies {
    readonly fetchImage: ImageFetch;
    readonly loadMessageImages: MessageImageLoader;
}

export interface SendImageToolOptions {
    readonly state: ReplyMediaState;
    readonly context: Pick<ReplyToolContext, 'chatId' | 'contextIndex' | 'signal'>;
    readonly dependencies?: SendImageToolDependencies;
}

const PRODUCTION_DEPENDENCIES: SendImageToolDependencies = {
    fetchImage: fetchImageBytes,
    loadMessageImages,
};

type ResolvedBytes =
    | {
          readonly ok: true;
          readonly data: Buffer;
          readonly mimeType: SniffedImageMime;
          readonly sourcePage: string;
          readonly title?: string;
          /** Why this is not the original, when it is not */
          readonly note?: string;
          readonly candidateId?: string;
          readonly imageId?: string;
          readonly contextNumber?: number;
      }
    | { readonly ok: false; readonly error: string };

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
        originalSendable: true,
    };
};

export const createSendImageTool = (options: SendImageToolOptions): ToolHandler => {
    const { state, context } = options;
    const dependencies = options.dependencies ?? PRODUCTION_DEPENDENCIES;
    const downloadDependencies: ImageDownloadDependencies = {
        fetchImage: dependencies.fetchImage,
        signal: context.signal,
    };

    const resolveMessageImage = async (
        contextNumber: number,
        imageIndex: number
    ): Promise<ResolvedBytes> => {
        const entry = context.contextIndex.get(contextNumber);
        if (!entry) {
            return { ok: false, error: `#${contextNumber} 不在当前上下文里` };
        }

        const images = await dependencies.loadMessageImages(context.chatId, entry.messageId);
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

        const data = Buffer.from(stored.data, 'base64');
        const mimeType = sniffImageMime(data);
        if (!mimeType) return { ok: false, error: mediaToolErrors.notAnImage };
        if (data.length > MAX_ORIGINAL_IMAGE_BYTES) {
            return { ok: false, error: mediaToolErrors.tooLarge(MAX_ORIGINAL_IMAGE_BYTES / 1024 / 1024) };
        }

        return {
            ok: true,
            data,
            mimeType,
            sourcePage: '',
            contextNumber,
        };
    };

    const resolveBytes = async (args: {
        readonly searchId: string | undefined;
        readonly imageId: string | undefined;
        readonly message: number | undefined;
        readonly image: number | undefined;
        readonly url: string | undefined;
    }): Promise<ResolvedBytes> => {
        if (args.imageId !== undefined) {
            const existing = state.fetched.get(args.imageId);
            if (!existing) return { ok: false, error: mediaToolErrors.unknownFetched(args.imageId) };
            return {
                ok: true,
                data: existing.data,
                mimeType: existing.mimeType,
                sourcePage: existing.sourcePage,
                ...(existing.title === undefined ? {} : { title: existing.title }),
                imageId: existing.id,
                ...(existing.candidateId === undefined ? {} : { candidateId: existing.candidateId }),
            };
        }

        if (args.message !== undefined) return resolveMessageImage(args.message, args.image ?? 1);

        const candidate =
            args.searchId !== undefined
                ? state.candidates.get(args.searchId)
                : urlCandidate(args.url ?? '');
        if (!candidate) return { ok: false, error: mediaToolErrors.unknownCandidate(args.searchId ?? '') };
        if (args.url !== undefined && !state.allowedUrls.has(args.url)) {
            return { ok: false, error: mediaToolErrors.urlNotAllowed };
        }

        const downloaded = await downloadCandidateImage(candidate, downloadDependencies);
        if (!downloaded.ok) return { ok: false, error: mediaToolErrors.downloadFailed(downloaded.error) };

        const { bytes } = downloaded;
        return {
            ok: true,
            data: bytes.data,
            mimeType: bytes.mimeType,
            sourcePage: candidate.sourcePage,
            ...(candidate.title === candidate.sourcePage ? {} : { title: candidate.title }),
            ...(bytes.usedThumbnail ? { note: '原图不可用，发的是缩略图静帧' } : {}),
            ...(args.searchId === undefined ? {} : { candidateId: args.searchId }),
        };
    };

    return {
        definition: {
            name: SEND_IMAGE_TOOL_NAME,
            description: DESCRIPTION,
            inputSchema: INPUT_SCHEMA,
        },
        statusText: '📤 正在发图…',
        chatAction: 'upload_photo',
        execute: async (rawArgs) => {
            if (state.hasReplyImage) return imageToolError(mediaToolErrors.alreadyHasImage);

            const parsed = parseSendImageArgs(rawArgs);
            if (!parsed.ok) return imageToolError(parsed.error);
            const args = parsed.args;
            if (
                args.searchId === undefined &&
                args.imageId === undefined &&
                args.message === undefined &&
                args.url === undefined
            ) {
                return imageToolError(mediaToolErrors.noImageSource);
            }

            const resolved = await resolveBytes(args);
            if (!resolved.ok) return imageToolError(resolved.error);

            state.hasReplyImage = true;
            const note = resolved.note;
            const label =
                resolved.candidateId ??
                resolved.imageId ??
                (resolved.contextNumber === undefined ? 'url' : `#${resolved.contextNumber}`);

            return {
                content: formatSendResult({
                    ...(resolved.candidateId === undefined ? {} : { candidateId: resolved.candidateId }),
                    ...(resolved.imageId === undefined ? {} : { imageId: resolved.imageId }),
                    ...(resolved.contextNumber === undefined
                        ? {}
                        : { contextNumber: resolved.contextNumber }),
                    ...(note === undefined ? {} : { note }),
                    ...(resolved.sourcePage === '' ? {} : { sourcePage: resolved.sourcePage }),
                }),
                isError: false,
                images: [
                    {
                        data: resolved.data,
                        mimeType: resolved.mimeType,
                        ...(args.caption ? { caption: args.caption } : {}),
                    },
                ],
                ...(resolved.imageId === undefined && resolved.contextNumber === undefined
                    ? {
                          modelImages: [
                              {
                                  data: resolved.data,
                                  mimeType: resolved.mimeType,
                                  caption: `你刚发出的图片 ${label}${
                                      resolved.title === undefined ? '' : ` · ${resolved.title}`
                                  }`,
                              },
                          ],
                      }
                    : {}),
                record:
                    resolved.sourcePage === ''
                        ? null
                        : {
                              provider: 'mcp',
                              searchQueries: [
                                  `${SEND_IMAGE_TOOL_NAME}: ${
                                      resolved.candidateId ?? resolved.imageId ?? resolved.contextNumber ?? 'url'
                                  }`,
                              ],
                              citations: [
                                  {
                                      uri: resolved.sourcePage,
                                      ...(resolved.title === undefined ? {} : { title: resolved.title }),
                                  },
                              ],
                          },
            };
        },
    };
};
