/**
 * generate_image: the model draws (or edits) a picture that rides along with
 * its reply.
 *
 * The schema is static so the declaration stays byte-identical between
 * requests (prompt caching). A tool instance serves exactly one reply, which
 * is where the one-image-per-reply rule lives: delivery and version storage
 * hold a single image.
 */
import { sendMessage } from '../../ai/platform-factory.js';
import { generateImage, type SendImageRequest } from '../../ai/image-generation/generate-image.js';
import { failureLogDetail } from '../../ai/image-generation/image-generation-failure.js';
import type { ToolHandler } from '../../ai/tools/tool-types.js';
import { loadMessageImages } from '../commands/reference-images.js';
import { IMAGE_ASPECT_RATIOS, parseGenerateImageArgs } from './image-tool-args.js';
import { resolveImageReferences, type MessageImageLoader } from './image-references.js';
import {
    ONE_IMAGE_PER_REPLY,
    describeImageGenerationFailure,
    imageToolError,
    imageToolSuccess,
} from './image-tool-result.js';
import type { ReplyToolContext } from './reply-tool-context.js';
import { GENERATE_IMAGE_TOOL_NAME } from './tool-names.js';

export { IMAGE_ASPECT_RATIOS } from './image-tool-args.js';

const DESCRIPTION =
    '生成或修改一张图片，图片会带着 caption 附在你这条回复后面发出（每条回复最多一张）。' +
    '需要时你可以自己用它生成图片来回复，比如回复表情包、斗图，或者用户在对话中请你画图、编辑图片。' +
    '要参考或修改上下文里的图片（包括你自己之前生成的），在 references 里填图片所在消息的编号。';

const INPUT_SCHEMA = {
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
            description: '要参考或修改的图片；不填就是从零画。',
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
                        description: '这条消息里的第几张图，从 1 开始；省略就取这条消息的全部图',
                    },
                },
                required: ['message'],
            },
        },
        aspect_ratio: {
            type: 'string',
            enum: IMAGE_ASPECT_RATIOS,
            description: '画面比例；改图时省略就沿用原图比例。',
        },
    },
    required: ['prompt', 'caption'],
};

/** What the tool talks to; the offline tests swap both */
export interface GenerateImageToolDependencies {
    readonly sendMessage: SendImageRequest;
    readonly loadMessageImages: MessageImageLoader;
}

const PRODUCTION_DEPENDENCIES: GenerateImageToolDependencies = { sendMessage, loadMessageImages };

export const createGenerateImageTool = (
    context: ReplyToolContext,
    dependencies: GenerateImageToolDependencies = PRODUCTION_DEPENDENCIES
): ToolHandler => {
    // Set by the first image this reply got; a failed attempt leaves room for another
    let replyHasImage = false;

    return {
        definition: {
            name: GENERATE_IMAGE_TOOL_NAME,
            description: DESCRIPTION,
            inputSchema: INPUT_SCHEMA,
        },
        statusText: '🎨 正在画图…',
        chatAction: 'upload_photo',
        execute: async (rawArgs, signal) => {
            if (replyHasImage) return imageToolError(ONE_IMAGE_PER_REPLY);

            const parsed = parseGenerateImageArgs(rawArgs);
            if (!parsed.ok) return imageToolError(parsed.error);
            const { args } = parsed;

            const references = await resolveImageReferences(args.references, {
                chatId: context.chatId,
                contextIndex: context.contextIndex,
                loadMessageImages: dependencies.loadMessageImages,
            });
            if (!references.ok) return imageToolError(references.error);

            const outcome = await generateImage(
                { prompt: args.prompt, references: references.images, aspectRatio: args.aspectRatio },
                { sendMessage: dependencies.sendMessage, signal: AbortSignal.any([signal, context.signal]) }
            );
            console.log(
                `[generate_image] ${references.images.length} reference(s), aspect=${args.aspectRatio ?? 'auto'}: ` +
                    (outcome.ok ? `${outcome.image.mimeType} ${outcome.image.data.length}B` : failureLogDetail(outcome.failure))
            );
            if (!outcome.ok) return imageToolError(describeImageGenerationFailure(outcome.failure));

            replyHasImage = true;
            return imageToolSuccess(outcome.image, args);
        },
    };
};
