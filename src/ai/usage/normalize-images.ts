/**
 * OpenAI images API (`images.generate` / `images.edit`) `usage`, as the GPT
 * image models report it. Whether the relay passes it through is unconfirmed;
 * without it the round counts with no usage.
 *
 * - prompt = input_tokens (text and reference images)
 * - output = output_tokens; imageOutput = output_tokens_details.image_tokens,
 *   else the whole output (the endpoint only returns pictures)
 */
import { isJsonObject } from '../../shared/json-object.js';
import { firstTokenCount, tokenCountAt } from './usage-fields.js';
import type { RoundUsage } from './usage-types.js';

export const normalizeImagesUsage = (usage: unknown): RoundUsage | null => {
    if (!isJsonObject(usage)) return null;
    const input = firstTokenCount(usage, [['input_tokens'], ['prompt_tokens']]);
    const output = firstTokenCount(usage, [['output_tokens'], ['completion_tokens']]);
    if (input === null && output === null) return null;

    return {
        promptTokens: input,
        cachedTokens: tokenCountAt(usage, ['input_tokens_details', 'cached_tokens']),
        cacheWriteTokens: null,
        outputTokens: output,
        thoughtsTokens: null,
        imageOutputTokens: tokenCountAt(usage, ['output_tokens_details', 'image_tokens']) ?? output,
    };
};
