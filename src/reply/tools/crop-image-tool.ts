/**
 * crop_image: hand one region of a picture back to the model, magnified.
 *
 * The model only says where; the sidecar crops from the bytes the context
 * already carries and scales the region up to the model's image budget. The
 * result is registered as `imgN` and replayed as a model-only image, so the
 * usual send_image / search_by_image / generate_image references work without
 * a single change here. Nothing is delivered to the chat by this tool.
 *
 * A 3×3 cell covers "the bottom-right part"; a named bbox with an explicit
 * unit covers coordinates. The sidecar answers with the source dimensions and
 * the box it actually used, and a too-small or out-of-range box comes back as
 * a 422 the model can fix by itself.
 */
import type { ToolHandler, ToolResult } from '../../ai/tools/tool-types.js';
import { sniffImageMime } from '../../ai/image-generation/image-mime.js';
import { cropImage as productionCropImage } from '../../services/tgs-client.js';
import { loadMessageImages } from '../commands/reference-images.js';
import { loadAnimationFrame } from './animation-frame.js';
import { cropBoxOfRegion, parseCropImageArgs, type CropImageBox } from './crop-image-args.js';
import { imageToolError } from './image-tool-result.js';
import { loadContextImages, type MessageImageLoader } from './image-references.js';
import {
    parseMediaRef,
    resolveMediaRef,
    type MediaRefDependencies,
    PRODUCTION_MEDIA_REF_DEPENDENCIES,
} from './media-ref-resolver.js';
import { nextFetchedImageId, type ReplyMediaState } from './reply-media-state.js';
import type { ReplyToolContext } from './reply-tool-context.js';
import { CROP_IMAGE_TOOL_NAME } from './tool-names.js';
import { traceParts, traceQuote, traceText } from './tool-trace.js';

/** Crops one reply may spend; each one is replayed to the model afterwards */
export const MAX_CROPS_PER_REPLY = 4;
/** The longest side the sidecar will hand back (its own cap, mirrored here) */
const MAX_OUTPUT_EDGE = 1536;
/** The inline image limit of the media cache; larger originals only exist as gs:// */
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

const DESCRIPTION =
    '裁出图片一块区域为新 imgN（不自动发出；用 send_image 发送，find_image(mode="reverse") 搜图）。' +
    `短边至少 48px，每回复最多裁 ${MAX_CROPS_PER_REPLY} 次。`;

const INPUT_SCHEMA = {
    type: 'object',
    properties: {
        source: { type: 'string', description: '图片来源：#N/#N:k/imgN/sN/gN' },
        region: {
            type: 'string',
            enum: [
                'top-left',
                'top',
                'top-right',
                'left',
                'center',
                'right',
                'bottom-left',
                'bottom',
                'bottom-right',
            ],
            description: '3×3 宫格（与 bbox 互斥）',
        },
        bbox: {
            type: 'object',
            description: '裁剪框（与 region 互斥）',
            properties: {
                x1: { type: 'number' },
                y1: { type: 'number' },
                x2: { type: 'number' },
                y2: { type: 'number' },
            },
            required: ['x1', 'y1', 'x2', 'y2'],
            additionalProperties: false,
        },
        unit: {
            type: 'string',
            enum: ['norm1000', 'px'],
            description: 'norm1000（默认 0–1000）/ px（源像素）',
        },
        scale: {
            type: 'number',
            minimum: 1,
            maximum: 4,
            description: '放大 1–4 倍，默认自动（≤1536）',
        },
        label: { type: 'string', description: '日志目标名' },
    },
    required: ['source'],
    additionalProperties: false,
};

export type CropImageExecutor = typeof productionCropImage;

export interface CropImageDependencies {
    readonly crop: CropImageExecutor;
    readonly loadMessageImages: MessageImageLoader;
    readonly mediaRefs: MediaRefDependencies;
}

const PRODUCTION_DEPENDENCIES: CropImageDependencies = {
    crop: productionCropImage,
    loadMessageImages,
    mediaRefs: PRODUCTION_MEDIA_REF_DEPENDENCIES,
};

export interface CropImageToolOptions {
    readonly state: ReplyMediaState;
    readonly context: Pick<ReplyToolContext, 'chatId' | 'contextIndex' | 'signal'>;
    /** Tests replace the sidecar and the database loader */
    readonly dependencies?: Partial<CropImageDependencies>;
}

type SourceBytes =
    | { readonly ok: true; readonly data: Buffer; readonly label: string }
    | { readonly ok: false; readonly error: string };

const sourceImageOf = async (
    source: string,
    options: CropImageToolOptions,
    dependencies: CropImageDependencies
): Promise<SourceBytes> => {
    const ref = parseMediaRef(source);
    if (ref === null) {
        return {
            ok: false,
            error: `无法识别的图片来源：${source}。用 #12（上下文消息图）、img3（读过的图）、s2（搜索候选）或 g1（本次画的图）。`,
        };
    }
    if (ref.kind === 'url') {
        return {
            ok: false,
            error: 'crop_image 暂不支持 https 图片直链；用上下文里的 #N、imgN、sN 或 gN。',
        };
    }
    const label = source;
    const state = options.state;
    const context = options.context;
    if (ref.kind === 'message') {
        const entry = context.contextIndex.get(ref.number);
        if (entry === undefined) return { ok: false, error: `#${ref.number} 不在当前上下文里。` };
        const loaded = await loadContextImages(
            context.chatId,
            entry,
            dependencies.loadMessageImages,
            loadAnimationFrame
        );
        if (loaded.length === 0) return { ok: false, error: `#${ref.number} 这条消息没有可用的图片。` };
        const picked = loaded[ref.image - 1];
        if (picked === undefined) {
            return { ok: false, error: `#${ref.number} 只有 ${loaded.length} 张图，没有第 ${ref.image} 张。` };
        }
        if (picked.kind === 'cloud') {
            return {
                ok: false,
                error: `#${ref.number} 的原图超过 20MB 存在云端，取不到字节；可以让用户重发一张较小的图。`,
            };
        }
        return { ok: true, data: picked.data, label };
    }
    const resolved = await resolveMediaRef(ref, {
        state,
        chatId: context.chatId,
        contextIndex: context.contextIndex,
        signal: context.signal,
        dependencies: dependencies.mediaRefs,
    });
    if (!resolved.ok) return { ok: false, error: resolved.error };
    return { ok: true, data: resolved.still.data, label: resolved.title ?? label };
};

/** The image a crop source resolved to had better be one of the three formats */
const checkSourceImage = (data: Buffer): string | null => {
    if (data.length === 0) return '这张图没有数据，没法裁剪。';
    if (data.length > MAX_SOURCE_BYTES) {
        return '这张图超过 20MB，没法裁剪；可以让用户重发一张小一点的图片。';
    }
    if (sniffImageMime(data) === null) return '这张不是 PNG/JPEG/WebP 图片，没法裁剪。';
    return null;
};

const clampHint = (box: CropImageBox, unit: 'norm1000' | 'px'): string | null => {
    if (unit !== 'norm1000') return null;
    const values = [box.x1, box.y1, box.x2, box.y2];
    if (values.every((value) => value >= 0 && value <= 1000)) return null;
    return 'norm1000 坐标要在 0-1000 之间（左/上为 0，右/下为 1000）；如果你有像素坐标，请设 unit="px" 并按原图尺寸给值。';
};

export const createCropImageTool = (options: CropImageToolOptions): ToolHandler => {
    const dependencies: CropImageDependencies = { ...PRODUCTION_DEPENDENCIES, ...options.dependencies };
    const state = options.state;
    let crops = 0;

    return {
        definition: {
            name: CROP_IMAGE_TOOL_NAME,
            description: DESCRIPTION,
            inputSchema: INPUT_SCHEMA,
        },
        statusText: '✂️ 正在裁剪图片…',
        chatAction: 'upload_photo',
        execute: async (rawArgs): Promise<ToolResult> => {
            const parsed = parseCropImageArgs(rawArgs);
            if (!parsed.ok) return imageToolError(parsed.error);
            const args = parsed.args;
            const rejected = (message: string, traceArgument?: string): ToolResult => {
                console.warn(`[crop_image] rejected: source=${args.source} label=${args.label ?? ''} reason=${message}`);
                return imageToolError(
                    message,
                    traceArgument === undefined ? undefined : { argument: traceArgument }
                );
            };
            if (crops >= MAX_CROPS_PER_REPLY) {
                return rejected(
                    `本条回复已经裁了 ${MAX_CROPS_PER_REPLY} 次，到上限了；直接用 send_image 或 find_image(mode='reverse') 处理现有的图。`
                );
            }
            const box: CropImageBox =
                args.region === undefined
                    ? (args.bbox ?? { x1: 0, y1: 0, x2: 0, y2: 0 })
                    : cropBoxOfRegion(args.region);
            const unit: 'norm1000' | 'px' = args.region === undefined ? args.unit : 'norm1000';
            const hint = clampHint(box, unit);
            if (hint !== null) return rejected(hint);

            const source = await sourceImageOf(args.source, options, dependencies);
            if (!source.ok) return rejected(source.error);
            const problem = checkSourceImage(source.data);
            if (problem !== null) return rejected(problem);

            const outcome = await dependencies.crop({
                data: source.data,
                x1: box.x1,
                y1: box.y1,
                x2: box.x2,
                y2: box.y2,
                unit,
                maxEdge: MAX_OUTPUT_EDGE,
                ...(args.scale === undefined ? {} : { scale: args.scale }),
            });
            const argumentTrace = traceParts(
                traceQuote(args.label ?? args.source, 28),
                args.region === undefined
                    ? traceText(`${unit} [${box.x1},${box.y1},${box.x2},${box.y2}]`)
                    : traceText(args.region)
            );
            if (!outcome.ok) {
                if (outcome.reason === 'invalid-box') {
                    const dimensions =
                        outcome.sourceWidth !== undefined && outcome.sourceHeight !== undefined
                            ? `原图是 ${outcome.sourceWidth}×${outcome.sourceHeight}。`
                            : '';
                    const misuse =
                        unit === 'px'
                        && outcome.sourceWidth !== undefined
                        && outcome.sourceHeight !== undefined
                        && [box.x1, box.y1, box.x2, box.y2].every((value) => value <= 1000)
                        && (outcome.sourceWidth > 1000 || outcome.sourceHeight > 1000)
                            ? 'bbox 看起来是 0-1000 归一化，但按 unit="px" 解释了；按相对位置请用 unit="norm1000"，按像素请按原图尺寸给值。'
                            : outcome.message ?? '框无效或太小。';
                    return rejected(
                        `裁剪失败：${misuse}${dimensions}短边至少 48px；可以用 region 取整块再试。`,
                        argumentTrace
                    );
                }
                if (outcome.reason === 'unsupported') {
                    return rejected('裁剪失败：这张图的格式不支持（只支持 PNG/JPEG/WebP）；换一张图再试。', argumentTrace);
                }
                if (outcome.reason === 'too-large') {
                    return rejected('裁剪失败：图片太大，没法裁剪；可以让用户重发一张小一点的图片。', argumentTrace);
                }
                return rejected('裁剪服务暂时失败（超时），可以重试一次；仍失败就先用原图，别卡在这里。', argumentTrace);
            }

            const id = nextFetchedImageId(state);
            state.fetched.set(id, {
                id,
                data: outcome.data,
                mimeType: outcome.mimeType,
                still: { data: outcome.data, mimeType: outcome.mimeType },
                sourcePage: '',
                title: `${args.source} 裁剪`,
                imageUrl: '',
            });
            crops += 1;
            const remaining = MAX_CROPS_PER_REPLY - crops;
            const flags = outcome.flags.length === 0 ? '' : `（${outcome.flags.join('、')}）`;
            const actualBox = outcome.box;
            const format = outcome.mimeType === 'image/png' ? 'PNG' : 'JPEG';
            const kilobytes = Math.max(1, Math.round(outcome.data.length / 1024));
            console.log(
                `[crop_image] ok source=${args.source} box=${actualBox.x1},${actualBox.y1},${actualBox.x2},${actualBox.y2} ` +
                    `out=${outcome.outputWidth}x${outcome.outputHeight} ${format} img=${id}`
            );
            return {
                content: [
                    `已从 ${args.source} 裁出 [x ${actualBox.x1}-${actualBox.x2}, y ${actualBox.y1}-${actualBox.y2}]` +
                        `（原图 ${outcome.sourceWidth}×${outcome.sourceHeight}）→ 新图 ${id}` +
                        `（${outcome.outputWidth}×${outcome.outputHeight}，${format} ${kilobytes}KB）${flags}，本条回复还没发出图片。`,
                    `要发给用户：send_image(image_id='${id}', caption='…')；要以图搜图：find_image(mode='reverse', image_id='${id}')；` +
                        `再近一点：crop_image(source='${id}', …)。本条回复最多裁 ${MAX_CROPS_PER_REPLY} 次，还剩 ${remaining} 次。`,
                ].join('\n'),
                isError: false,
                images: [],
                modelImages: [
                    {
                        data: outcome.data,
                        mimeType: outcome.mimeType,
                        caption: `${args.source} 裁剪 [x ${actualBox.x1}-${actualBox.x2}, y ${actualBox.y1}-${actualBox.y2}] → ${outcome.outputWidth}×${outcome.outputHeight}`,
                    },
                ],
                record: null,
                trace: {
                    argument: argumentTrace,
                    result: `${id} ${outcome.outputWidth}×${outcome.outputHeight}`,
                },
            };
        },
    };
};
