/**
 * Tool results may carry pictures only the model should see (search
 * thumbnails, a page being checked). Each platform replays them its own way;
 * this file holds the parts that are the same everywhere: which images a round
 * produced, their data URLs and the label that ties them to the tool result.
 */
import type { SniffedImageMime } from '../image-generation/image-mime.js';
import type { ExecutedToolCall } from './tool-round.js';
import type { ToolModelImage } from './tool-types.js';

/** Every model-only image of a tool round, in call then image order */
export const modelImagesOf = (executedCalls: readonly ExecutedToolCall[]): ToolModelImage[] =>
    executedCalls.flatMap(({ result }) => result.modelImages ?? []);

/** `data:image/jpeg;base64,…`, the shape every OpenAI-compatible input takes */
export const imageDataUrl = (image: ToolModelImage): string =>
    `data:${image.mimeType};base64,${image.data.toString('base64')}`;

/**
 * The text that goes with the images when they travel as a separate user turn
 * (the OpenAI-compatible replay): without it the model sees pictures with no
 * idea which candidate they are.
 */
export const modelImagesIntro = (images: readonly ToolModelImage[]): string =>
    [
        '上一条工具结果附带的图片（按顺序排列，是否已发送给用户见对应工具结果）：',
        ...images.map((image, index) => `${index + 1}. ${image.caption}`),
    ].join('\n');

/**
 * A picture the non-Gemini replays can take: everything but the mp4. Those
 * platforms append a user message of images; an mp4 there would be a 400.
 */
export const isStillImage = (
    image: ToolModelImage
): image is ToolModelImage & { readonly mimeType: SniffedImageMime | 'image/gif' } =>
    image.mimeType !== 'video/mp4';
