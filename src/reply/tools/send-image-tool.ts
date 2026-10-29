/**
 * send_image: put a real, existing picture into the reply. The only way the
 * model gives the chat an image it did not draw — search candidates, pictures
 * it already read, a picture from the context, or any public image url.
 *
 * A GIF goes out as an animation (`sendAnimation`, see the delivery layer); the
 * model is shown its still frame, because a model reads a GIF as one frame
 * anyway and the still is all it needs to caption it.
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
import { sniffMediaMime, type SniffedMediaMime } from '../../ai/image-generation/image-mime.js';
import type { ToolHandler } from '../../ai/tools/tool-types.js';
import { fetchImageBytes } from '../../services/image-fetch-service.js';
import { loadMessageImages } from '../commands/reference-images.js';
import { loadContextImages, type MessageImageLoader } from './image-references.js';
import { imageToolError } from './image-tool-result.js';
import { formatSendResult, mediaToolErrors } from './image-tool-text.js';
import {
    downloadCandidateMedia,
    MAX_ORIGINAL_IMAGE_BYTES,
    type ImageFetch,
    type ImageDownloadDependencies,
} from './image-source-download.js';
import { parseSendImageArgs } from './media-tool-args.js';
import type { ReplyToolContext } from './reply-tool-context.js';
import type { ReplyMediaState, SearchCandidate } from './reply-media-state.js';
import { SEND_IMAGE_TOOL_NAME } from './tool-names.js';

const DESCRIPTION =
    '将一张已有图片发送到聊天（附于当前回复末尾，每条回复最多附带一张图片或贴纸）。' +
    '支持传入 search_id（搜索候选编号）、image_id（fetch_image 已读图片编号）、' +
    'message（上下文消息编号 #N）或 url（http(s) 图片直链）。GIF 候选将作为动图发送。';

const INPUT_SCHEMA = {
    type: 'object',
    properties: {
        search_id: { type: 'string', description: "搜索结果里的候选编号，形如 's3'" },
        image_id: { type: 'string', description: "fetch_image 读过的图编号，形如 'img1'" },
        message: {
            type: 'integer',
            minimum: 1,
            description: '上下文里的消息编号（#N 里的数字），发这条消息里的图（含链接预览里的图）',
        },
        image: {
            type: 'integer',
            minimum: 1,
            description: '这条消息里的第几张图，从 1 开始（附件在前，链接预览里的图在后）；省略=第一张',
        },
        url: { type: 'string', description: 'http(s) 图片直链，可以是任意公开地址' },
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

interface MediaBytes {
    /** What the chat receives: a GIF stays a GIF */
    readonly data: Buffer;
    readonly mimeType: SniffedMediaMime;
    /** What the model sees (and already saw, for a fetched image) */
    readonly still: { readonly data: Buffer; readonly mimeType: SniffedMediaMime };
}

type ResolvedBytes =
    | (MediaBytes & {
          readonly ok: true;
          readonly sourcePage: string;
          readonly title?: string;
          /** Why this is not the original, when it is not */
          readonly note?: string;
          readonly candidateId?: string;
          readonly imageId?: string;
          readonly contextNumber?: number;
      })
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
        sendKind: 'static',
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

        const images = await loadContextImages(context.chatId, entry, dependencies.loadMessageImages);
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
                still: existing.still,
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
            if (state.hasReplyImage || state.hasReplySticker) return imageToolError(mediaToolErrors.alreadyHasImage);

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
            const animated = resolved.mimeType === 'image/gif';
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
                    ...(animated ? { animated: true } : {}),
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
                                  data: resolved.still.data,
                                  mimeType: resolved.still.mimeType,
                                  caption: `你刚发出的图片 ${label}${
                                      resolved.title === undefined ? '' : ` · ${resolved.title}`
                                  }${animated ? '（动图，这里是它的第一帧）' : ''}`,
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
