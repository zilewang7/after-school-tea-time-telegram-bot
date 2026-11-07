/**
 * Responses API `usage` (OpenAI through the relay, xAI direct).
 *
 * - prompt = input_tokens (cache hits included); cached = input_tokens_details.cached_tokens
 * - output = output_tokens; thoughts = output_tokens_details.reasoning_tokens
 *
 * Two shapes are accepted for what is unconfirmed: a relay may answer with the
 * chat.completions names (prompt_tokens / completion_tokens), and xAI may
 * leave reasoning out of output_tokens, which the total gives away
 * (outputExcludesReasoning) and which is then added back.
 */
import { isJsonObject } from '../../shared/json-object.js';
import { firstTokenCount, outputExcludesReasoning, tokenCountAt } from './usage-fields.js';
import type { RoundUsage } from './usage-types.js';

export const normalizeResponsesUsage = (usage: unknown): RoundUsage | null => {
    if (!isJsonObject(usage)) return null;
    const input = firstTokenCount(usage, [['input_tokens'], ['prompt_tokens']]);
    const output = firstTokenCount(usage, [['output_tokens'], ['completion_tokens']]);
    if (input === null && output === null) return null;

    const reasoning = firstTokenCount(usage, [
        ['output_tokens_details', 'reasoning_tokens'],
        ['completion_tokens_details', 'reasoning_tokens'],
    ]);
    const total = tokenCountAt(usage, ['total_tokens']);
    const addReasoning = outputExcludesReasoning({ input, output, reasoning, total });

    return {
        promptTokens: input,
        cachedTokens: firstTokenCount(usage, [
            ['input_tokens_details', 'cached_tokens'],
            ['prompt_tokens_details', 'cached_tokens'],
        ]),
        cacheWriteTokens: null,
        outputTokens: output === null ? null : addReasoning ? output + (reasoning ?? 0) : output,
        thoughtsTokens: reasoning,
        imageOutputTokens: null,
    };
};
