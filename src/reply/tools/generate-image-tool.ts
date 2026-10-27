/**
 * generate_image: the model draws (or edits) a picture that rides along with
 * its reply.
 *
 * The schema is static so the declaration stays byte-identical between
 * requests (prompt caching). A tool instance serves exactly one reply, which
 * is where the one-image-per-reply rule lives: delivery and version storage
 * hold a single image. The flag is shared with send_image, so a reply can end
 * with a found picture or a drawn one, never both.
 */
import { sendMessage } from '../../ai/platform-factory.js';
import { generateImage, type ImageReference, type SendImageRequest } from '../../ai/image-generation/generate-image.js';
import { failureLogDetail } from '../../ai/image-generation/image-generation-failure.js';
import { sniffImageMime } from '../../ai/image-generation/image-mime.js';
import type { ToolHandler } from '../../ai/tools/tool-types.js';
import { fetchImageBytes } from '../../services/image-fetch-service.js';
import type { StickerCatalogEntry } from '../../services/sticker-catalog.js';
import {
    downloadStickerPreview,
    StickerSetError,
    type StickerSetApi,
} from '../../services/sticker-set-service.js';
import { loadMessageImages } from '../commands/reference-images.js';
import { loadAnimationFrame, type AnimationFrameLoader } from './animation-frame.js';
import { IMAGE_ASPECT_RATIOS, parseGenerateImageArgs, type ImageWebReferenceArg } from './image-tool-args.js';
import {
    MAX_REFERENCE_IMAGE_BYTES,
    MAX_REFERENCE_IMAGES,
    resolveImageReferences,
    type MessageImageLoader,
} from './image-references.js';
import {
    downloadCandidateMedia,
    type ImageFetch,
} from './image-source-download.js';
import {
    ONE_IMAGE_PER_REPLY,
    describeImageGenerationFailure,
    imageToolError,
    imageToolSuccess,
} from './image-tool-result.js';
import type { ReplyToolContext } from './reply-tool-context.js';
import type { ReplyMediaState } from './reply-media-state.js';
import { padPackIndex, resolveStickerQuery } from './sticker-query.js';
import { GENERATE_IMAGE_TOOL_NAME } from './tool-names.js';

export { IMAGE_ASPECT_RATIOS } from './image-tool-args.js';

const descriptionOf = (hasSticker: boolean): string =>
    '生成或修改一张图片，图片会带着 caption 附在你这条回复后面发出（每条回复最多一张）。' +
    '只在需要“新画一张/改一张图”时使用；如果用户要的是真实存在的图片、表情包、截图、新闻图，' +
    '请先用 search_images 找到，再用 send_image 发，不要用本工具冒充“找到了”。' +
    '要参考或修改上下文里的图片（消息自带的附件、链接预览里的图、你自己之前生成的都算），在 references 里填消息编号；' +
    '消息里是动图（GIF/动态贴纸）时，用的是它的首帧；' +
    '同一条消息有多张时用 image 指明第几张，按消息里出现的顺序数：附件在前，链接预览的图在后。' +
    '要参考网上找到的图，在 web_references 里填 search_id / image_id。' +
    (hasSticker ? '要参考贴纸包里的贴纸，也在 web_references 里填 sticker（st1、包内序号或画面名）。' : '') +
    '生图模型在需要真实参考时会自动使用 Google 图片搜索；你可以在 prompt 里明确要求' +
    '“参考网络上真实的照片/地标/人物”，生成后参考来源会列在回复底部。';

const inputSchemaOf = (hasSticker: boolean) => ({
    type: 'object',
    properties: {
        prompt: {
            type: 'string',
            description:
                '画面描述，中英文均可。参考多张图时按画面特征描述每张（如"那张穿红衣服的人像"），' +
                '不要用"第一张图"这类序号指代；图里要出现的文字原样写进来。',
        },
        caption: {
            type: 'string',
            description: '随图发出的配文，显示在图片下方。',
        },
        references: {
            type: 'array',
            description: '要参考或修改的上下文图片（消息附件、链接预览里的图都算）；不填就是从零画。',
            items: {
                type: 'object',
                properties: {
                    message: {
                        type: 'integer',
                        minimum: 1,
                        description: '图片所在消息的编号（#N 里的数字）',
                    },
                    image: {
                        type: 'integer',
                        minimum: 1,
                        description:
                            '这条消息里的第几张图，从 1 开始（附件在前，链接预览的图在后）；省略就取这条消息的全部图',
                    },
                },
                required: ['message'],
            },
        },
        web_references: {
            type: 'array',
            description: hasSticker
                ? '要参考的额外图片（search_images 的候选、fetch_image 读过的图、贴纸包里的贴纸）。'
                : '要参考的网上图片（search_images 的候选或 fetch_image 读过的图）。',
            items: {
                type: 'object',
                properties: {
                    search_id: { type: 'string', description: "搜索结果候选编号，形如 's2'" },
                    image_id: { type: 'string', description: "已读图编号，形如 'img1'" },
                    ...(hasSticker
                        ? {
                              sticker: {
                                  type: 'string',
                                  description: "贴纸：st1（fetch_image 预览过的）、包内序号 07 或实际画面名，如 '吃冰棒'",
                              },
                          }
                        : {}),
                },
            },
        },
        aspect_ratio: {
            type: 'string',
            enum: IMAGE_ASPECT_RATIOS,
            description: '画面比例；改图时省略就沿用原图比例。',
        },
    },
    required: ['prompt', 'caption'],
});

/** What the tool talks to; the offline tests swap all of it */
export interface GenerateImageToolDependencies {
    readonly sendMessage: SendImageRequest;
    readonly loadMessageImages: MessageImageLoader;
    readonly loadAnimationFrame: AnimationFrameLoader;
    readonly fetchImage: ImageFetch;
}

/** The fixed pack, when this turn has the sticker tools */
export interface StickerReferenceSource {
    readonly setName: string;
    readonly api: StickerSetApi;
}

export interface GenerateImageToolOptions {
    readonly dependencies?: GenerateImageToolDependencies;
    /** Absent: the schema has no sticker field and references to stickers are refused */
    readonly sticker?: StickerReferenceSource;
}

const PRODUCTION_DEPENDENCIES: GenerateImageToolDependencies = {
    sendMessage,
    loadMessageImages,
    loadAnimationFrame,
    fetchImage: fetchImageBytes,
};

type ResolvedWebReferences =
    | { readonly ok: true; readonly images: readonly ImageReference[] }
    | { readonly ok: false; readonly error: string };

const NON_VISION_REFERENCE =
    '这张图不能作为参考：不是 PNG/JPEG/WebP，或下载失败。换一张，或用上下文里的图。';

/** One sticker reference → the pack's original webp, never the 320px preview */
const loadStickerReference = async (
    entry: StickerCatalogEntry,
    source: StickerReferenceSource,
    signal: AbortSignal
): Promise<ImageReference> => {
    const preview = await downloadStickerPreview(source.api, source.setName, entry, 'original', signal);
    return { data: preview.data, mimeType: preview.mimeType };
};

/** Extra pictures → bytes the image model takes, in the order the model listed them */
const resolveWebReferences = async (
    references: readonly ImageWebReferenceArg[],
    state: ReplyMediaState,
    dependencies: GenerateImageToolDependencies,
    signal: AbortSignal,
    sticker: StickerReferenceSource | undefined
): Promise<ResolvedWebReferences> => {
    const images: ImageReference[] = [];
    const problems: string[] = [];
    const seenStickers = new Set<number>();

    for (const reference of references) {
        if (reference.sticker !== undefined) {
            if (!sticker) {
                problems.push('这一轮不能引用贴纸（没有配置贴纸包）。');
                continue;
            }
            const resolved = resolveStickerQuery(reference.sticker, state);
            if (!resolved.ok) {
                problems.push(resolved.error);
                continue;
            }
            const entry = resolved.entry;
            if (seenStickers.has(entry.packIndex)) continue;
            seenStickers.add(entry.packIndex);
            try {
                const loaded = await loadStickerReference(entry, sticker, signal);
                if (loaded.data.length > MAX_REFERENCE_IMAGE_BYTES) {
                    problems.push(`${padPackIndex(entry.packIndex)} ${entry.label} 超过 7MB`);
                    continue;
                }
                images.push(loaded);
            } catch (error) {
                problems.push(
                    error instanceof StickerSetError
                        ? error.message
                        : `${padPackIndex(entry.packIndex)} ${entry.label} 读不出来：` +
                              (error instanceof Error ? error.message : String(error))
                );
            }
            continue;
        }

        if (reference.imageId !== undefined) {
            const fetched = state.fetched.get(reference.imageId);
            if (!fetched) {
                problems.push(`${reference.imageId} 没有读过；先用 fetch_image 读取`);
                continue;
            }
            // A GIF is stored with its still frame: the image model takes no GIF
            const still = sniffImageMime(fetched.still.data);
            if (!still) {
                problems.push(`${reference.imageId} ${NON_VISION_REFERENCE}`);
                continue;
            }
            images.push({ data: fetched.still.data, mimeType: still });
            continue;
        }

        const searchId = reference.searchId ?? '';
        const candidate = state.candidates.get(searchId);
        if (!candidate) {
            problems.push(`${searchId} 不是本次的搜索结果编号`);
            continue;
        }

        const downloaded = await downloadCandidateMedia(candidate, { fetchImage: dependencies.fetchImage, signal });
        if (!downloaded.ok) {
            problems.push(`${searchId} 取不到图：${downloaded.error}`);
            continue;
        }
        const mimeType = sniffImageMime(downloaded.media.still.data);
        if (!mimeType) {
            problems.push(`${searchId} ${NON_VISION_REFERENCE}`);
            continue;
        }
        images.push({ data: downloaded.media.still.data, mimeType });
    }

    if (problems.length > 0) return { ok: false, error: `参数有误：\n${problems.map((p) => `- ${p}`).join('\n')}` };
    return { ok: true, images };
};

export const createGenerateImageTool = (
    context: ReplyToolContext,
    state: ReplyMediaState,
    options: GenerateImageToolOptions = {}
): ToolHandler => {
    const dependencies = options.dependencies ?? PRODUCTION_DEPENDENCIES;
    const hasSticker = options.sticker !== undefined;

    return {
        definition: {
            name: GENERATE_IMAGE_TOOL_NAME,
            description: descriptionOf(hasSticker),
            inputSchema: inputSchemaOf(hasSticker),
        },
        statusText: '🎨 正在画图…',
        chatAction: 'upload_photo',
        execute: async (rawArgs, signal) => {
            if (state.hasReplyImage || state.hasReplySticker) return imageToolError(ONE_IMAGE_PER_REPLY);

            const parsed = parseGenerateImageArgs(rawArgs);
            if (!parsed.ok) return imageToolError(parsed.error);
            const { args } = parsed;

            const references = await resolveImageReferences(args.references, {
                chatId: context.chatId,
                contextIndex: context.contextIndex,
                loadMessageImages: dependencies.loadMessageImages,
                loadAnimationFrame: dependencies.loadAnimationFrame,
            });
            if (!references.ok) return imageToolError(references.error);

            const web = await resolveWebReferences(
                args.webReferences,
                state,
                dependencies,
                AbortSignal.any([signal, context.signal]),
                options.sticker
            );
            if (!web.ok) return imageToolError(web.error);

            const referenceImages = [...references.images, ...web.images];
            if (referenceImages.length > MAX_REFERENCE_IMAGES) {
                return imageToolError(
                    `参考图最多 ${MAX_REFERENCE_IMAGES} 张（现在 ${referenceImages.length} 张）。` +
                        '去掉几张再试：references 和 web_references 合计不能超。'
                );
            }

            const outcome = await generateImage(
                {
                    prompt: args.prompt,
                    references: referenceImages,
                    aspectRatio: args.aspectRatio,
                },
                { sendMessage: dependencies.sendMessage, signal: AbortSignal.any([signal, context.signal]) }
            );
            console.log(
                `[generate_image] ${referenceImages.length} reference(s), aspect=${args.aspectRatio ?? 'auto'}: ` +
                    (outcome.ok ? `${outcome.image.mimeType} ${outcome.image.data.length}B` : failureLogDetail(outcome.failure))
            );
            if (!outcome.ok) return imageToolError(describeImageGenerationFailure(outcome.failure));

            state.hasReplyImage = true;
            return imageToolSuccess(outcome.image, args, outcome.grounding);
        },
    };
};
