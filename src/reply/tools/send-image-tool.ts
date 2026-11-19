/**
 * send_image: put a real, existing picture into the reply. The only way the
 * model gives the chat an image it did not draw — search candidates, pictures
 * it already read, a picture from the context, or any public image url.
 *
 * A reply may carry several pictures now: the tool may be called again and
 * each picture is appended to the reply's attachment list (one album when
 * there are several stills). The per-picture ids and limits live in
 * `ReplyMediaState`, so the model reads "the k-th of ten" instead of a
 * one-attachment rule.
 *
 * A GIF goes out as an animation (`sendAnimation`, see the delivery layer); the
 * model is shown its still frame, because a model reads a GIF as one frame
 * anyway and the still is all it needs to caption it.
 *
 * A picture the reply did not already show the model comes back as a
 * model-only image: the model has to see what it is about to send, or it
 * captions a candidate from its title and describes a picture the chat never
 * saw (live 1106627: text about a solo meme next to a group poster). An image
 * the model read with fetch_image, or one taken from a context message, is
 * already in the conversation — attaching it again would only double its
 * tokens.
 */
import type { ToolHandler } from '../../ai/tools/tool-types.js';
import {
    MAX_REPLY_IMAGE_BYTES,
    MAX_REPLY_IMAGES,
    MAX_REPLY_IMAGE_TOTAL_BYTES,
} from '../../shared/reply-media.js';
import { imageToolError } from './image-tool-result.js';
import { formatSendResult, mediaToolErrors } from './image-tool-text.js';
import { parseSendImageArgs } from './media-tool-args.js';
import {
    parseMediaRef,
    PRODUCTION_MEDIA_REF_DEPENDENCIES,
    resolveMediaRef,
    type MediaRef,
    type MediaRefDependencies,
} from './media-ref-resolver.js';
import type { ReplyToolContext } from './reply-tool-context.js';
import { ONE_ATTACHMENT_PER_REPLY, type ReplyMediaState } from './reply-media-state.js';
import { SEND_IMAGE_TOOL_NAME } from './tool-names.js';
import { traceParts, traceUrl } from './tool-trace.js';

const DESCRIPTION =
    '将一张已有图片发送到聊天（附在当前回复末尾，可与其它图片一起发出）。' +
    `支持传入 image_id（generate_image 本次生成的 g1、fetch_image 已读的 img1）、` +
    'search_id（搜索候选编号）、message（上下文消息编号 #N）或 url（http(s) 图片直链）。' +
    `每条回复最多 ${MAX_REPLY_IMAGES} 张，多张会作为一条相册发出；GIF 候选将作为动图单独发送。`;

const INPUT_SCHEMA = {
    type: 'object',
    properties: {
        search_id: { type: 'string', description: "搜索结果里的候选编号，形如 's3'" },
        image_id: {
            type: 'string',
            description: "图片编号：generate_image 本次生成的 g1，或 fetch_image 读过的 img1",
        },
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
            description: '随这张图发出的配文；不需要就省略。',
        },
    },
};

/** The downloader and image loader the resolver needs; injectable for tests */
export type SendImageToolDependencies = MediaRefDependencies;

export interface SendImageToolOptions {
    readonly state: ReplyMediaState;
    readonly context: Pick<ReplyToolContext, 'chatId' | 'contextIndex' | 'signal'>;
    readonly dependencies?: SendImageToolDependencies;
}

/** The reference the parsed arguments name; the parser guarantees exactly one */
const mediaRefOfArgs = (args: {
    readonly searchId: string | undefined;
    readonly imageId: string | undefined;
    readonly message: number | undefined;
    readonly image: number | undefined;
    readonly url: string | undefined;
}): MediaRef | null => {
    if (args.imageId !== undefined) return parseMediaRef(args.imageId);
    if (args.message !== undefined) {
        return { kind: 'message', number: args.message, image: args.image ?? 1 };
    }
    if (args.searchId !== undefined) return parseMediaRef(args.searchId);
    if (args.url !== undefined) return { kind: 'url', url: args.url };
    return null;
};

export const createSendImageTool = (options: SendImageToolOptions): ToolHandler => {
    const { state, context } = options;
    const dependencies = options.dependencies ?? PRODUCTION_MEDIA_REF_DEPENDENCIES;

    return {
        definition: {
            name: SEND_IMAGE_TOOL_NAME,
            description: DESCRIPTION,
            inputSchema: INPUT_SCHEMA,
        },
        statusText: '📤 正在发图…',
        chatAction: 'upload_photo',
        execute: async (rawArgs) => {
            // Stickers, files and cards keep their one-attachment-per-reply rule;
            // pictures among themselves are a list now
            if (state.hasReplySticker || state.hasReplyFile || state.hasReplyWidget) {
                return imageToolError(ONE_ATTACHMENT_PER_REPLY);
            }

            const parsed = parseSendImageArgs(rawArgs);
            if (!parsed.ok) return imageToolError(parsed.error);
            const args = parsed.args;
            const ref = mediaRefOfArgs(args);
            if (ref === null) return imageToolError(mediaToolErrors.noImageSource);

            const resolved = await resolveMediaRef(ref, {
                state,
                chatId: context.chatId,
                contextIndex: context.contextIndex,
                ...(context.signal === undefined ? {} : { signal: context.signal }),
                dependencies,
            });
            if (!resolved.ok) return imageToolError(resolved.error);

            // The picture joins the reply's attachment list; the limits are the
            // reply's, not this call's
            const nextCount = state.imageCount + 1;
            if (nextCount > MAX_REPLY_IMAGES) {
                return imageToolError(mediaToolErrors.imageLimitReached(MAX_REPLY_IMAGES));
            }
            if (resolved.data.length > MAX_REPLY_IMAGE_BYTES) {
                return imageToolError(mediaToolErrors.tooLarge(MAX_REPLY_IMAGE_BYTES / 1024 / 1024));
            }
            const nextBytes = state.imageBytes + resolved.data.length;
            if (nextBytes > MAX_REPLY_IMAGE_TOTAL_BYTES) {
                return imageToolError(
                    mediaToolErrors.imageTotalTooLarge(MAX_REPLY_IMAGE_TOTAL_BYTES / 1024 / 1024)
                );
            }

            state.imageCount = nextCount;
            state.imageBytes = nextBytes;
            state.hasReplyImage = true;

            const animated = resolved.mimeType === 'image/gif';
            const note = resolved.note;
            const label =
                resolved.candidateId ??
                resolved.imageId ??
                resolved.generatedId ??
                (resolved.contextNumber === undefined ? 'url' : `#${resolved.contextNumber}`);
            // The log names a url by its host only: a query string can carry a secret
            const traceArgument = args.url === undefined ? label : traceUrl(args.url);
            const captionChars = Array.from(args.caption.trim()).length;
            const traceResult = traceParts(
                `第 ${state.imageCount}/${MAX_REPLY_IMAGES} 张`,
                animated ? '动图' : null,
                captionChars > 0 ? `配文 ${captionChars} 字` : null
            );

            return {
                content: formatSendResult({
                    index: state.imageCount,
                    limit: MAX_REPLY_IMAGES,
                    ...(resolved.candidateId === undefined ? {} : { candidateId: resolved.candidateId }),
                    ...(resolved.imageId === undefined ? {} : { imageId: resolved.imageId }),
                    ...(resolved.generatedId === undefined ? {} : { generatedId: resolved.generatedId }),
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
                ...(resolved.imageId === undefined &&
                resolved.generatedId === undefined &&
                resolved.contextNumber === undefined
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
                trace: { argument: traceArgument, result: traceResult },
            };
        },
    };
};
