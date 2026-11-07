/**
 * Anthropic Messages usage: `message_start.message.usage` plus the last
 * `message_delta.usage` of the stream.
 *
 * - prompt = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
 *   (input_tokens alone leaves the cache out)
 * - cached = cache_read_input_tokens; cacheWrite = cache_creation_input_tokens
 * - output = output_tokens (thinking included); thoughts only when the
 *   response carries output_tokens_details.thinking_tokens
 *
 * Every count is cumulative, and the official stream puts the input counts in
 * message_start while a converting relay may only fill them in message_delta
 * (or zero them there): the larger of the two is taken for each count, which
 * is right for both shapes.
 */
import { isJsonObject } from '../../shared/json-object.js';
import { largerCount, tokenCountAt, type FieldPath } from './usage-fields.js';
import type { RoundUsage } from './usage-types.js';

const THINKING_TOKENS: FieldPath = ['output_tokens_details', 'thinking_tokens'];

export const normalizeAnthropicUsage = (startUsage: unknown, deltaUsage: unknown): RoundUsage | null => {
    if (!isJsonObject(startUsage) && !isJsonObject(deltaUsage)) return null;
    const countOf = (path: FieldPath): number | null =>
        largerCount(tokenCountAt(startUsage, path), tokenCountAt(deltaUsage, path));

    const input = countOf(['input_tokens']);
    const output = countOf(['output_tokens']);
    if (input === null && output === null) return null;
    const cacheRead = countOf(['cache_read_input_tokens']);
    const cacheCreation = countOf(['cache_creation_input_tokens']);

    return {
        promptTokens: input === null ? null : input + (cacheRead ?? 0) + (cacheCreation ?? 0),
        cachedTokens: cacheRead,
        cacheWriteTokens: cacheCreation,
        outputTokens: output,
        thoughtsTokens: countOf(THINKING_TOKENS),
        imageOutputTokens: null,
    };
};
