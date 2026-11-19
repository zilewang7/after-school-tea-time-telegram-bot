/**
 * What generate_image tells the model, and the picture it hands back to it.
 *
 * A drawing is not delivered: it is registered as `g1`, `g2`, … in the reply's
 * media state and replayed to the model, which compares the versions and sends
 * the one it picks with send_image. See docs/2026-1104-1820.
 */
import { match } from 'ts-pattern';
import { IMAGE_GENERATION_TIMEOUT_MS } from '../../ai/image-generation/generate-image.js';
import type { ImageGenerationFailure } from '../../ai/image-generation/image-generation-failure.js';
import type { ToolCallTrace, ToolResult } from '../../ai/tools/tool-types.js';
import type { GroundingCitation, GroundingData } from '../../ai/types.js';
import type { GenerateImageArgs } from './image-tool-args.js';
import { MAX_GENERATED_IMAGES, type GeneratedImage } from './reply-media-state.js';
import { GENERATE_IMAGE_TOOL_NAME } from './tool-names.js';
import { traceBytes, traceParts, traceQuote } from './tool-trace.js';

/** The image model's own words are quoted, never dumped whole */
const MODEL_TEXT_MAX_CHARS = 500;
/** Prompt excerpt on the Tools block line */
const RECORD_PROMPT_CHARS = 40;
/** Prompt excerpt on the per-call log line */
const TRACE_PROMPT_CHARS = 28;

/** `PNG`, `JPEG`: the model reads this far more easily than a mime type */
const mimeLabel = (mimeType: string): string => mimeType.replace(/^image\//, '').toUpperCase();

const sizeLabel = (image: GeneratedImage): string =>
    `${mimeLabel(image.mimeType)}，${Math.max(1, Math.round(image.data.length / 1024))}KB`;

/** Cut by code points, so an emoji is never split in half */
const excerpt = (text: string, maxChars: number): string => Array.from(text).slice(0, maxChars).join('');

const withModelText = (summary: string, text: string): string =>
    text ? `${summary}模型回复：${excerpt(text, MODEL_TEXT_MAX_CHARS)}` : summary;

export const describeImageGenerationFailure = (failure: ImageGenerationFailure): string =>
    match(failure)
        .with({ kind: 'busy' }, () => '生图服务繁忙（429），可以稍后重试或换个说法。')
        .with(
            { kind: 'timeout' },
            () => `生图超时（超过 ${Math.round(IMAGE_GENERATION_TIMEOUT_MS / 1000)} 秒没有出图），可以稍后重试。`
        )
        .with({ kind: 'stopped' }, () => '这条回复已被停止，图片没有生成。')
        .with({ kind: 'blocked' }, ({ reason, text }) =>
            withModelText(`生图请求被 Gemini 的安全过滤拦下了（${reason}），没有出图。`, text)
        )
        .with({ kind: 'no-image' }, ({ reason, text }) =>
            withModelText(`生图模型没有出图（${reason ?? '返回为空'}）。`, text)
        )
        .with({ kind: 'text-only' }, ({ text }) =>
            `生图模型只回了文字、没有出图，它的原话：${excerpt(text, MODEL_TEXT_MAX_CHARS)}`
        )
        .with({ kind: 'error' }, ({ message }) => `生图失败：${message}`)
        .exhaustive();

export const imageToolError = (content: string, trace?: ToolCallTrace): ToolResult => ({
    content,
    isError: true,
    images: [],
    record: null,
    ...(trace === undefined ? {} : { trace }),
});

/**
 * The arguments of one drawing call as the log shows them: the prompt excerpt
 * plus only the choices that differ from the defaults.
 */
export const describeGenerateImageArgument = (
    args: GenerateImageArgs,
    /** Pictures actually handed to the model; 0 for a failure before they resolved */
    referenceCount = 0
): string =>
    traceParts(
        traceQuote(args.prompt, TRACE_PROMPT_CHARS),
        args.model === 'gpt' ? 'gpt' : null,
        args.model === 'banana' && args.aspectRatio !== undefined ? args.aspectRatio : null,
        referenceCount > 0 ? `参考 ${referenceCount} 张` : null
    );

/** The failure's kind as one short log word (the renderer adds 「失败：」) */
export const describeImageGenerationFailureTrace = (failure: ImageGenerationFailure): string =>
    match(failure)
        .with({ kind: 'busy' }, () => '服务繁忙')
        .with({ kind: 'timeout' }, () => '超时')
        .with({ kind: 'stopped' }, () => '已停止')
        .with({ kind: 'blocked' }, () => '被安全过滤拦下')
        .with({ kind: 'no-image' }, () => '没有出图')
        .with({ kind: 'text-only' }, () => '只回文字没出图')
        .with({ kind: 'error' }, () => '生图出错')
        .exhaustive();

/** The pages Google's image search grounded the drawing in */
const imageCitations = (grounding: GroundingData | null): GroundingCitation[] =>
    (grounding?.groundingChunks ?? []).flatMap((chunk) => {
        const uri = chunk.image?.sourceUri;
        if (!uri) return [];
        return [{ uri, title: chunk.image?.title ?? chunk.image?.domain }];
    });

export const imageToolSuccess = (
    image: GeneratedImage,
    args: GenerateImageArgs,
    /** Draws this reply still has after this one */
    remaining: number,
    grounding: GroundingData | null = null,
    /** Pictures actually handed to the model (references + web references) */
    referenceCount = 0
): ToolResult => {
    const promptLine = args.prompt.replace(/\s+/g, ' ').trim();
    const imageSearchQueries = grounding?.imageSearchQueries ?? [];
    // The Tools line names the model only when it is not the default one
    const toolLabel = args.model === 'gpt' ? `${GENERATE_IMAGE_TOOL_NAME}(gpt)` : GENERATE_IMAGE_TOOL_NAME;
    const size = sizeLabel(image);
    const id = image.id;
    return {
        content: [
            `已生成 ${id}（${size}），本条回复还没有发出图片。` +
                `要发就用 send_image(image_id='${id}', caption='…')；要继续改，在 web_references 里用 image_id='${id}'。`,
            remaining > 0
                ? `本条回复最多画 ${MAX_GENERATED_IMAGES} 张，还剩 ${remaining} 张。`
                : `本条回复已经画满 ${MAX_GENERATED_IMAGES} 张，不能再画；用 send_image 选一张发出。`,
        ].join('\n'),
        isError: false,
        images: [],
        // The model has to see what it drew, or it compares nothing and
        // describes a picture the chat never received (live 1114408).
        modelImages: [
            {
                data: image.data,
                mimeType: image.mimeType,
                caption: `${id} · 生成的图（${size}）`,
            },
        ],
        record: {
            provider: 'mcp',
            searchQueries: [
                `${toolLabel}: ${excerpt(promptLine, RECORD_PROMPT_CHARS)}`,
                ...imageSearchQueries.map((query) => `参考图搜索: ${excerpt(query, RECORD_PROMPT_CHARS)}`),
            ],
            citations: imageCitations(grounding),
        },
        trace: {
            argument: describeGenerateImageArgument(args, referenceCount),
            result: `${id} ${mimeLabel(image.mimeType)} ${traceBytes(image.data.length)}`,
        },
    };
};
