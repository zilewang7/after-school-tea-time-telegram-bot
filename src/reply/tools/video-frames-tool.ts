/**
 * extract_frames: turn moments of a video/GIF/animation into stills the model
 * can look at (and the reply's other image tools can use).
 *
 * A dynamic message reaches the context as a video part, which the image
 * toolchain cannot reference. This tool takes the same message the model
 * already sees (`#N`), asks the converter for stills at the requested moments,
 * and registers each one as `imgN` — send_image, search_by_image and
 * generate_image then work unchanged. Nothing is delivered to the chat.
 *
 * A video over 20MB lives only in GCS. The bot signs a short read URL and lets
 * the sidecar's ffmpeg read it in place, so a 260MB clip never has to pass
 * through the bot process.
 */
import type { ToolHandler, ToolResult } from '../../ai/tools/tool-types.js';
import { getMessage } from '../../db/index.js';
import { createSignedReadUrl } from '../../services/gcs-service.js';
import { getCachedMedia } from '../../services/media-cache-service.js';
import { extractVideoFrames as productionExtractVideoFrames } from '../../services/tgs-client.js';
import { imageToolError } from './image-tool-result.js';
import { nextFetchedImageId, type ReplyMediaState } from './reply-media-state.js';
import type { ReplyToolContext } from './reply-tool-context.js';
import { EXTRACT_FRAMES_TOOL_NAME } from './tool-names.js';
import { traceParts, traceText } from './tool-trace.js';
import { parseExtractFramesArgs, type ExtractFramesArgs } from './video-frames-args.js';

/** Frames one reply may spend; each one is replayed to the model afterwards */
export const MAX_FRAMES_PER_REPLY = 6;
/** The signed-read limit the sidecar enforces (mirrored for an early answer) */
const MAX_REMOTE_SOURCE_BYTES = 300 * 1024 * 1024;
/** Signed URL lifetime: the sidecar reads immediately, this only covers a retry */
const SIGNED_URL_TTL_SECONDS = 300;

/** Media kinds that carry a moving picture the converter can decode */
const FRAME_MEDIA_KINDS = new Set([
    'animation',
    'video',
    'video_note',
    'video_sticker',
    'animated_sticker',
]);

const DESCRIPTION =
    '从视频/GIF/动图/动态贴纸消息中取出静帧，得到新的图片（不会自动发给用户）。' +
    'message 是上下文消息编号（#N 里的数字）。取帧方式：times=[3.5, 12] 按时刻精确取；' +
    '或 count=3（可配 start/end）均匀取；或 mode="first"/"last" 取首/末帧。' +
    'size 是长边像素（512/768/960/1280，默认 960）。' +
    '结果会告诉你视频时长与每帧的实际时间；每帧登记为新的 image_id（如 img7）：' +
    '发给用户用 send_image(image_id="img7")；以图搜图用 search_by_image(image_id="img7")；' +
    '也可当 generate_image 的参考图。' +
    `每条回复最多取 ${MAX_FRAMES_PER_REPLY} 帧，单次最多 6 帧。视频较大（>20MB）也能取（直连云端），但会慢一些。`;

const INPUT_SCHEMA = {
    type: 'object',
    properties: {
        message: {
            type: 'integer',
            minimum: 1,
            description: '视频/GIF/动态贴纸所在消息的编号（#N 里的数字）',
        },
        times: {
            type: 'array',
            items: { type: 'number', minimum: 0 },
            minItems: 1,
            maxItems: 6,
            description: '要取的时刻（秒，支持一位小数，如 3.5）；与 count 互斥',
        },
        count: {
            type: 'integer',
            minimum: 1,
            maximum: 6,
            description: '均匀取几帧（默认 3）；与 times 互斥',
        },
        mode: {
            type: 'string',
            enum: ['uniform', 'first', 'last'],
            description: '取帧方式：uniform 均匀（默认）、first 首帧、last 末帧；给了 times 时按 times',
        },
        start: { type: 'number', minimum: 0, description: 'uniform 的起点（秒），省略=0' },
        end: { type: 'number', minimum: 0, description: 'uniform 的终点（秒），省略=视频末尾' },
        size: {
            type: 'integer',
            enum: [512, 768, 960, 1280],
            description: '图片长边像素；省略=960。读字幕/小字用 1280，只需要看大概用 512/768',
        },
    },
    required: ['message'],
    additionalProperties: false,
};

/** The stored row as far as frame extraction cares */
export interface FrameMessageRow {
    readonly fileUniqueId: string | null;
}

/** The cached media fields frame extraction reads */
export interface FrameCachedMedia {
    readonly mime: string;
    readonly kind: string;
    readonly data: Buffer | null;
    readonly fileUri: string | null;
    readonly sizeBytes: number | null;
    readonly durationSeconds: number | null;
}

export interface ExtractFramesDependencies {
    readonly getMessage: (chatId: number, messageId: number) => Promise<FrameMessageRow | null>;
    readonly getCachedMedia: (fileUniqueId: string) => Promise<FrameCachedMedia | null>;
    readonly signReadUrl: (gsUri: string, ttlSeconds: number) => Promise<string | null>;
    readonly extractFrames: typeof productionExtractVideoFrames;
}

const PRODUCTION_DEPENDENCIES: ExtractFramesDependencies = {
    getMessage: async (chatId, messageId) => {
        const row = await getMessage(chatId, messageId);
        return row === null ? null : { fileUniqueId: row.fileUniqueId };
    },
    getCachedMedia,
    signReadUrl: createSignedReadUrl,
    extractFrames: productionExtractVideoFrames,
};

export interface ExtractFramesToolOptions {
    readonly state: ReplyMediaState;
    readonly context: Pick<ReplyToolContext, 'chatId' | 'contextIndex' | 'signal'>;
    /** Tests replace the database, the signer and the sidecar */
    readonly dependencies?: Partial<ExtractFramesDependencies>;
}

type VideoSource =
    | {
          readonly ok: true;
          readonly source:
              | { readonly kind: 'bytes'; readonly data: Buffer; readonly mimeType: string }
              | {
                    readonly kind: 'url';
                    readonly url: string;
                    readonly mimeType: string;
                    readonly sourceBytes: number | null;
                };
          readonly messageId: number;
      }
    | { readonly ok: false; readonly error: string };

const isVideoMime = (mime: string): boolean => mime.startsWith('video/') || mime === 'image/gif';

const sourceOf = async (
    messageNumber: number,
    options: ExtractFramesToolOptions,
    dependencies: ExtractFramesDependencies
): Promise<VideoSource> => {
    const context = options.context;
    const entry = context.contextIndex.get(messageNumber);
    if (entry === undefined) return { ok: false, error: `#${messageNumber} 不在当前上下文里。` };
    const row = await dependencies.getMessage(context.chatId, entry.messageId);
    if (row === null || row.fileUniqueId === null || row.fileUniqueId === '') {
        return { ok: false, error: `#${messageNumber} 这条消息没有媒体。` };
    }
    const cached = await dependencies.getCachedMedia(row.fileUniqueId);
    if (cached === null) {
        return {
            ok: false,
            error: `这条消息的媒体已经过期（缓存只保留 7 天），没法再取帧。`,
        };
    }
    const allowedKind = FRAME_MEDIA_KINDS.has(cached.kind)
        || (cached.kind === 'document' && isVideoMime(cached.mime));
    if (!allowedKind || !isVideoMime(cached.mime)) {
        return {
            ok: false,
            error: `#${messageNumber} 不是视频/动图（它是图片/贴纸/音频/文件）；要看细节用 crop_image 或 fetch_image。`,
        };
    }
    if (cached.data !== null && cached.data.length > 0) {
        return {
            ok: true,
            source: { kind: 'bytes', data: cached.data, mimeType: cached.mime },
            messageId: entry.messageId,
        };
    }
    if (cached.fileUri === null) {
        return { ok: false, error: '这条消息的媒体字节已经不在缓存里了，没法再取帧。' };
    }
    const sourceBytes = cached.sizeBytes;
    if (sourceBytes !== null && sourceBytes > MAX_REMOTE_SOURCE_BYTES) {
        return {
            ok: false,
            error: '这个视频超过 300MB，暂时没法取帧；可以发一段短一点的，或者让我直接看视频。',
        };
    }
    const url = await dependencies.signReadUrl(cached.fileUri, SIGNED_URL_TTL_SECONDS);
    if (url === null) {
        return { ok: false, error: '这条视频存在云端，刚才没签出可读地址（签名失败）；稍后重试一次。' };
    }
    return {
        ok: true,
        source: { kind: 'url', url, mimeType: cached.mime, sourceBytes },
        messageId: entry.messageId,
    };
};

const framesRequestedOf = (args: ExtractFramesArgs): number => {
    if (args.times !== undefined && args.times.length > 0) return args.times.length;
    if (args.mode === 'first' || args.mode === 'last') return 1;
    return args.count ?? 3;
};

const formatSeconds = (value: number): string => `${value.toFixed(1)}s`;

export const createExtractFramesTool = (options: ExtractFramesToolOptions): ToolHandler => {
    const dependencies: ExtractFramesDependencies = { ...PRODUCTION_DEPENDENCIES, ...options.dependencies };
    const state = options.state;
    let framesEmitted = 0;

    return {
        definition: {
            name: EXTRACT_FRAMES_TOOL_NAME,
            description: DESCRIPTION,
            inputSchema: INPUT_SCHEMA,
        },
        statusText: '🎞️ 正在取帧…',
        chatAction: 'upload_photo',
        execute: async (rawArgs): Promise<ToolResult> => {
            const parsed = parseExtractFramesArgs(rawArgs);
            if (!parsed.ok) return imageToolError(parsed.error);
            const args = parsed.args;
            const rejected = (message: string, traceArgument?: string): ToolResult => {
                console.warn(`[extract_frames] rejected: message=#${args.message} reason=${message}`);
                return imageToolError(
                    message,
                    traceArgument === undefined ? undefined : { argument: traceArgument }
                );
            };
            const requested = framesRequestedOf(args);
            const remaining = MAX_FRAMES_PER_REPLY - framesEmitted;
            const argumentTrace = traceParts(
                traceText(`#${args.message}`),
                args.times === undefined ? traceText(args.mode) : traceText(args.times.map(formatSeconds).join(',')),
                traceText(`${args.size}px`)
            );
            if (requested > remaining) {
                if (remaining === 0) {
                    return rejected(
                        `本条回复最多取 ${MAX_FRAMES_PER_REPLY} 帧，已经用完了；可以用 send_image 发已有的帧。`,
                        argumentTrace
                    );
                }
                return rejected(
                    `本条回复最多取 ${MAX_FRAMES_PER_REPLY} 帧，已经用了 ${framesEmitted} 帧、还剩 ${remaining} 帧；` +
                        `把 times/count 减到 ${remaining} 个，或先发已有的帧。`,
                    argumentTrace
                );
            }
            const resolved = await sourceOf(args.message, options, dependencies);
            if (!resolved.ok) return rejected(resolved.error, argumentTrace);
            const outcome = await dependencies.extractFrames({
                source:
                    resolved.source.kind === 'bytes'
                        ? {
                              kind: 'bytes',
                              data: resolved.source.data,
                              mimeType: resolved.source.mimeType,
                          }
                        : {
                              kind: 'url',
                              url: resolved.source.url,
                              mimeType: resolved.source.mimeType,
                              ...(resolved.source.sourceBytes === null
                                  ? {}
                                  : { sourceBytes: resolved.source.sourceBytes }),
                          },
                mode: args.mode,
                ...(args.times === undefined ? {} : { times: args.times }),
                ...(args.count === undefined ? {} : { count: args.count }),
                ...(args.start === undefined ? {} : { start: args.start }),
                ...(args.end === undefined ? {} : { end: args.end }),
                size: args.size,
            });
            if (!outcome.ok) {
                if (outcome.reason === 'invalid-time') {
                    if (outcome.duration !== undefined) {
                        return rejected(
                            `这个视频只有 ${formatSeconds(outcome.duration)}，取不了这些时刻；可以取 0 到 ${formatSeconds(Math.max(0, outcome.duration - 0.1))} 之间的帧。`,
                            argumentTrace
                        );
                    }
                    return rejected('取帧的时间点超出视频范围；可以先取首帧看看时长，再按实际时长给 times。', argumentTrace);
                }
                if (outcome.reason === 'too-large') {
                    return rejected('这个视频太大，暂时没法取帧；可以发一段短一点的，或者让我直接看视频。', argumentTrace);
                }
                if (outcome.reason === 'unsupported') {
                    return rejected('这个视频的格式不支持抽帧；可以发一段 mp4 再试。', argumentTrace);
                }
                return rejected('取帧服务暂时失败（超时），可以重试一次；仍失败就先根据视频本身回答。', argumentTrace);
            }
            const ids: string[] = [];
            const lines: string[] = [];
            const modelImages = [];
            for (const frame of outcome.frames) {
                const id = nextFetchedImageId(state);
                state.fetched.set(id, {
                    id,
                    data: frame.data,
                    mimeType: frame.mimeType,
                    still: { data: frame.data, mimeType: frame.mimeType },
                    sourcePage: '',
                    title: `#${args.message} @${formatSeconds(frame.actualT)}`,
                    imageUrl: '',
                });
                framesEmitted += 1;
                ids.push(id);
                const format = frame.mimeType === 'image/png' ? 'PNG' : 'JPEG';
                lines.push(`${lines.length + 1}. ${formatSeconds(frame.actualT)} → ${id}`);
                modelImages.push({
                    data: frame.data,
                    mimeType: frame.mimeType,
                    caption: `[#${args.message} @${formatSeconds(frame.actualT)}] ${args.size}px ${format}`,
                });
            }
            const remainingAfter = MAX_FRAMES_PER_REPLY - framesEmitted;
            const notes = outcome.notes.length === 0 ? '' : `（${outcome.notes.join('；')}）`;
            console.log(
                `[extract_frames] ok message=#${args.message} mode=${args.mode} ` +
                    `duration=${outcome.duration.toFixed(1)} frames=${ids.length} ids=${ids.join(',')}`
            );
            return {
                content: [
                    `已从 #${args.message} 的视频（${formatSeconds(outcome.duration)}，${outcome.width}×${outcome.height}）` +
                        `取出 ${ids.length} 帧（${args.size}px 长边）${notes}：`,
                    ...lines,
                    `图片按上述顺序附在本结果后。可 send_image(image_id='${ids[0]}')、search_by_image(image_id='${ids[0]}')` +
                        `或当 generate_image 的参考图；本条回复最多 ${MAX_FRAMES_PER_REPLY} 帧，还剩 ${remainingAfter} 帧。`,
                ].join('\n'),
                isError: false,
                images: [],
                modelImages,
                record: null,
                trace: {
                    argument: argumentTrace,
                    result: ids.join(','),
                },
            };
        },
    };
};
