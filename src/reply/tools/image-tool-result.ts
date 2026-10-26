/**
 * What generate_image tells the model, and what its success adds to the reply.
 */
import { match } from 'ts-pattern';
import { IMAGE_GENERATION_TIMEOUT_MS } from '../../ai/image-generation/generate-image.js';
import type { GeneratedImage } from '../../ai/image-generation/drain-image-stream.js';
import type { ImageGenerationFailure } from '../../ai/image-generation/image-generation-failure.js';
import type { ToolResult } from '../../ai/tools/tool-types.js';
import type { GroundingCitation, GroundingData } from '../../ai/types.js';
import type { GenerateImageArgs } from './image-tool-args.js';
import { GENERATE_IMAGE_TOOL_NAME } from './tool-names.js';

export const ONE_IMAGE_PER_REPLY = '这条回复已经有一张图或贴纸了，每条回复只能发一个视觉附件。';
const IMAGE_READY = '图片已生成，会带着配文附在你这条回复后面发出。';

/** The image model's own words are quoted, never dumped whole */
const MODEL_TEXT_MAX_CHARS = 500;
/** Prompt excerpt on the Tools block line */
const RECORD_PROMPT_CHARS = 40;

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

export const imageToolError = (content: string): ToolResult => ({
    content,
    isError: true,
    images: [],
    record: null,
});

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
    grounding: GroundingData | null = null
): ToolResult => {
    const promptLine = args.prompt.replace(/\s+/g, ' ').trim();
    const imageSearchQueries = grounding?.imageSearchQueries ?? [];
    return {
        content: IMAGE_READY,
        isError: false,
        images: [
            {
                data: image.data,
                mimeType: image.mimeType,
                ...(args.caption ? { caption: args.caption } : {}),
            },
        ],
        record: {
            provider: 'mcp',
            searchQueries: [
                `${GENERATE_IMAGE_TOOL_NAME}: ${excerpt(promptLine, RECORD_PROMPT_CHARS)}`,
                ...imageSearchQueries.map((query) => `参考图搜索: ${excerpt(query, RECORD_PROMPT_CHARS)}`),
            ],
            citations: imageCitations(grounding),
        },
    };
};
