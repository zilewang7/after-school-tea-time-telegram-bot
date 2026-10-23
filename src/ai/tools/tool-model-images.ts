/**
 * Tool results may carry pictures only the model should see (search
 * thumbnails, a page being checked). Each platform replays them its own way;
 * this file holds the parts that are the same everywhere: which images a round
 * produced, their data URLs and the label that ties them to the tool result.
 */
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
        '以下是上一条工具结果里的图片，顺序与之一致（有没有发给用户见该工具结果的文字）：',
        ...images.map((image, index) => `${index + 1}. ${image.caption}`),
    ].join('\n');
