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
    '裁出图片的一块区域，得到一张新图片（不会自动发给用户）。' +
    '图片来源用上下文引用：#12（第12条消息的图）、#12:2（该消息第2张）、img3（fetch_image 读过的图）、' +
    's2（搜索候选）、g1（generate_image 画出的图）。' +
    '区域二选一：region 是 3×3 宫格代号（top-left/top/.../bottom-right），用于“右下角那块”这类说法；' +
    'bbox 是 {x1,y1,x2,y2} 加 unit。unit 默认 norm1000（把图片看作 0-1000 相对坐标），' +
    '也可以 unit="px" 按源图原始像素给。本工具会在结果里告诉你原图尺寸、实际使用的框、输出尺寸；' +
    '框越界会被夹到图内，短边小于 48px 会报错。可选 scale=1-4 指定放大倍数（省略=自动把长边放到约 1024，最多 1536；' +
    '放大不会增加真实细节）。产物是新的 image_id（如 img3）：要发给用户用 send_image(image_id="img3")，' +
    '要以图搜图用 search_by_image(image_id="img3")，要裁得更近就再 crop_image(source="img3", …)。' +
    `每条回复最多裁 ${MAX_CROPS_PER_REPLY} 次。`;

const INPUT_SCHEMA = {
    type: 'object',
    properties: {
        source: {
            type: 'string',
            description: "#12（第12条消息的图）、#12:2（其第2张）、img3（fetch_image 读过的图）、s2（搜索候选）、g1（本次画的图）",
        },
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
            description: '3×3 宫格代号（与 bbox 二选一）。适合“右下角那块”这类描述',
        },
        bbox: {
            type: 'object',
            description: '裁剪框（与 region 二选一）',
            properties: {
                x1: { type: 'number', description: '左边界' },
                y1: { type: 'number', description: '上边界' },
                x2: { type: 'number', description: '右边界（应大于 x1）' },
                y2: { type: 'number', description: '下边界（应大于 y1）' },
            },
            required: ['x1', 'y1', 'x2', 'y2'],
            additionalProperties: false,
        },
        unit: {
            type: 'string',
            enum: ['norm1000', 'px'],
            description: 'bbox 的单位：norm1000=把图看作 0-1000 相对坐标（默认）；px=源图原始像素（结果里会回显原图尺寸）',
        },
        scale: {
            type: 'number',
            minimum: 1,
            maximum: 4,
            description: '放大倍数 1-4；省略=自动（长边约 1024，最多 1536）',
        },
        label: {
            type: 'string',
            description: '要裁的目标名（如“右下角的招牌”），写进工具日志，便于核对',
        },
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
                    `本条回复已经裁了 ${MAX_CROPS_PER_REPLY} 次，到上限了；直接用 send_image 或 search_by_image 处理现有的图。`
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
                    `要发给用户：send_image(image_id='${id}', caption='…')；要以图搜图：search_by_image(image_id='${id}')；` +
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
