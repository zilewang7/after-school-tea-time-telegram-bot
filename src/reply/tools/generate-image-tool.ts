/**
 * generate_image: the model draws (or edits) a picture it can look at.
 *
 * A drawing is not delivered. It is registered in the reply's media state as
 * `g1`, `g2`, … (at most MAX_GENERATED_IMAGES per reply) and handed back to the
 * model as a model-only image, so it can compare versions, keep editing one,
 * and send the one it picks with send_image — which is also the only way the
 * reply delivers an image, hence the shared one-attachment flag.
 *
 * The schema is static so the declaration stays byte-identical between
 * requests (prompt caching).
 */
import { sendMessage } from '../../ai/platform-factory.js';
import {
    generateImage,
    IMAGE_MODEL_CHOICES,
    type ImageModelChoice,
    type ImageReference,
    type SendImageRequest,
} from '../../ai/image-generation/generate-image.js';
import { failureLogDetail } from '../../ai/image-generation/image-generation-failure.js';
import { sniffImageMime } from '../../ai/image-generation/image-mime.js';
import type { ToolHandler } from '../../ai/tools/tool-types.js';
import { createUsageSink } from '../../ai/usage/index.js';
import type { RoundUsage, UsageSink } from '../../ai/usage/usage-types.js';
import { CALL_BILLED_IMAGE_MODELS, GEMINI_IMAGE_MODEL, OPENAI_IMAGE_MODEL } from '../../config/models.js';
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
    describeGenerateImageArgument,
    describeImageGenerationFailure,
    describeImageGenerationFailureTrace,
    imageToolError,
    imageToolSuccess,
} from './image-tool-result.js';
import type { ReplyToolContext } from './reply-tool-context.js';
import {
    generatedImageIds,
    MAX_GENERATED_IMAGES,
    nextGeneratedImageId,
    ONE_ATTACHMENT_PER_REPLY,
    type GeneratedImage,
    type ReplyMediaState,
} from './reply-media-state.js';
import { padPackIndex, resolveStickerQuery } from './sticker-query.js';
import { GENERATE_IMAGE_TOOL_NAME } from './tool-names.js';

export { IMAGE_ASPECT_RATIOS } from './image-tool-args.js';

const descriptionOf = (hasSticker: boolean, bananaOnly: boolean): string =>
    `生图或改图，返回 g1/g2…（不自动发出，用 send_image 发送，每回复最多10张；最多生成 ${MAX_GENERATED_IMAGES} 张）。` +
    `上下文图（含预览/历史，GIF取首帧）用 references；本回复图用 web_references（g1/img1/sN${hasSticker ? '/贴纸' : ''}）。` +
    (bananaOnly
        ? '仅限 banana 模型（支持 aspect_ratio 与 Google 图片参考）。'
        : '默认 banana（支持 aspect_ratio 与 Google 图片参考）；gpt 不支持这两项。');

const modelSchemaOf = (bananaOnly: boolean) =>
    bananaOnly
        ? {
              type: 'string',
              enum: ['banana'],
              description: '仅 banana（体验限制）',
          }
        : {
              type: 'string',
              enum: IMAGE_MODEL_CHOICES,
              description: 'banana（默认）/ gpt（不支持比例与搜图参考）',
          };

const inputSchemaOf = (hasSticker: boolean, bananaOnly: boolean) => ({
    type: 'object',
    properties: {
        prompt: {
            type: 'string',
            description: '画面描述（中英文）；多图按特征指代，画面文字原样写出',
        },
        references: {
            type: 'array',
            description: '上下文参考图（含链接预览）',
            items: {
                type: 'object',
                properties: {
                    message: { type: 'integer', minimum: 1, description: '消息编号 #N' },
                    image: { type: 'integer', minimum: 1, description: '第几张图（默认全取）' },
                },
                required: ['message'],
            },
        },
        web_references: {
            type: 'array',
            description: hasSticker ? '额外参考图（gN/sN/imgN/贴纸）' : '额外参考图（gN/sN/imgN）',
            items: {
                type: 'object',
                properties: {
                    search_id: { type: 'string', description: '候选 sN' },
                    image_id: { type: 'string', description: 'gN 或 imgN' },
                    ...(hasSticker
                        ? {
                              sticker: { type: 'string', description: 'stN/序号/画面名' },
                          }
                        : {}),
                },
            },
        },
        model: modelSchemaOf(bananaOnly),
        aspect_ratio: {
            type: 'string',
            enum: IMAGE_ASPECT_RATIOS,
            description: '画面比例（仅 banana）',
        },
    },
    required: ['prompt'],
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
    /** Trial turn: banana is the only model on offer (design D3) */
    readonly bananaOnly?: boolean;
    /**
     * Where every successful generation is reported: the image model id and
     * its round usage (null for call-billed models, which report no tokens).
     * Absent = generations are not priced.
     */
    readonly recordImageGeneration?: (model: string, usage: RoundUsage | null) => void;
}

/** The image model a call picked, as the reply metrics key it */
const modelIdOf = (choice: ImageModelChoice): string =>
    choice === 'gpt' ? OPENAI_IMAGE_MODEL : GEMINI_IMAGE_MODEL;

/**
 * The sink's totals in the round shape the metrics draft adds up; null when a
 * sink was not created or the platform reported no usage at all.
 */
const roundUsageOf = (sink: UsageSink | undefined): RoundUsage | null => {
    if (sink === undefined) return null;
    const totals = sink.totals();
    const usage: RoundUsage = {
        promptTokens: totals.promptTokens,
        cachedTokens: totals.cachedTokens,
        cacheWriteTokens: totals.cacheWriteTokens,
        outputTokens: totals.outputTokens,
        thoughtsTokens: totals.thoughtsTokens,
        imageOutputTokens: totals.imageOutputTokens,
    };
    const reported =
        usage.promptTokens !== null ||
        usage.cachedTokens !== null ||
        usage.cacheWriteTokens !== null ||
        usage.outputTokens !== null ||
        usage.thoughtsTokens !== null ||
        usage.imageOutputTokens !== null;
    return reported ? usage : null;
};

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
            const generated = state.generated.get(reference.imageId);
            if (generated) {
                images.push({ data: generated.data, mimeType: generated.mimeType });
                continue;
            }
            const fetched = state.fetched.get(reference.imageId);
            if (!fetched) {
                problems.push(`${reference.imageId} 没有读过；先用 fetch_image 读取，或用本次生成的 g1`);
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
    const bananaOnly = options.bananaOnly === true;
    const recordImageGeneration = options.recordImageGeneration;

    return {
        definition: {
            name: GENERATE_IMAGE_TOOL_NAME,
            description: descriptionOf(hasSticker, bananaOnly),
            inputSchema: inputSchemaOf(hasSticker, bananaOnly),
        },
        statusText: '🎨 正在画图…',
        chatAction: 'upload_photo',
        execute: async (rawArgs, signal) => {
            // Pictures may already be on the reply: a drawn picture is only a
            // candidate until send_image adds it, so drawing after sending is fine.
            // A sticker or file, though, still excludes pictures.
            if (state.hasReplySticker || state.hasReplyFile) {
                return imageToolError(ONE_ATTACHMENT_PER_REPLY);
            }
            if (state.generated.size >= MAX_GENERATED_IMAGES) {
                return imageToolError(
                    `本条回复已经画了 ${MAX_GENERATED_IMAGES} 张（${generatedImageIds(state).join(' ')}），不能再画。` +
                        "用 send_image(image_id='gN') 把要发的发出去，可以多次 send_image 一起发（最多 10 张）。"
                );
            }

            const parsed = parseGenerateImageArgs(rawArgs);
            if (!parsed.ok) return imageToolError(parsed.error);
            const { args } = parsed;
            // The narrowed schema already hides gpt; a stale or hand-written call is refused here
            if (bananaOnly && args.model !== 'banana') {
                return imageToolError('体验用户只能使用 banana 生图；gpt 生图需要申请完整功能后才能使用。');
            }

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

            const modelId = modelIdOf(args.model);
            // A call-billed model has no token usage to price: only its count
            // reaches the metrics, so no sink rides its request.
            const usageSink =
                recordImageGeneration === undefined || CALL_BILLED_IMAGE_MODELS.has(modelId)
                    ? undefined
                    : createUsageSink();
            const outcome = await generateImage(
                {
                    prompt: args.prompt,
                    references: referenceImages,
                    aspectRatio: args.aspectRatio,
                    model: args.model,
                },
                {
                    sendMessage: dependencies.sendMessage,
                    signal: AbortSignal.any([signal, context.signal]),
                    ...(usageSink === undefined ? {} : { usageSink }),
                }
            );
            // The ratio only reaches the Gemini side; logging it for gpt would lie
            const aspectNote = args.model === 'banana' ? `, aspect=${args.aspectRatio ?? 'auto'}` : '';
            if (!outcome.ok) {
                console.log(
                    `[generate_image] model=${args.model}${aspectNote}, ${referenceImages.length} reference(s): ` +
                        failureLogDetail(outcome.failure)
                );
                return imageToolError(describeImageGenerationFailure(outcome.failure), {
                    argument: describeGenerateImageArgument(args, referenceImages.length),
                    result: describeImageGenerationFailureTrace(outcome.failure),
                });
            }

            const id = nextGeneratedImageId(state);
            const mimeType = sniffImageMime(outcome.image.data) ?? 'image/png';
            const drawn: GeneratedImage = { id, data: outcome.image.data, mimeType };
            state.generated.set(id, drawn);
            console.log(
                `[generate_image] ${id} model=${args.model}${aspectNote}, ${referenceImages.length} reference(s): ` +
                    `${outcome.image.mimeType} ${outcome.image.data.length}B ` +
                    `(${state.generated.size}/${MAX_GENERATED_IMAGES} for this reply, not sent)`
            );
            // After the picture is kept: a failed generation never reaches this
            // point, so only what was actually drawn is priced.
            recordImageGeneration?.(modelId, roundUsageOf(usageSink));
            return imageToolSuccess(
                drawn,
                args,
                MAX_GENERATED_IMAGES - state.generated.size,
                outcome.grounding,
                referenceImages.length
            );
        },
    };
};
