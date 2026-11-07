/**
 * chat.completions `usage`, from the last chunk of a stream requested with
 * `stream_options: { include_usage: true }` (DeepSeek and MiMo, direct).
 *
 * - prompt = prompt_tokens; with DeepSeek's prompt_cache_hit_tokens and
 *   prompt_cache_miss_tokens both present, their sum (the whole input by
 *   definition, whichever way prompt_tokens was counted)
 * - cached = prompt_cache_hit_tokens (DeepSeek), else
 *   prompt_tokens_details.cached_tokens (the OpenAI shape MiMo is assumed to use)
 * - output = completion_tokens, reasoning added back when the total shows it
 *   was left out; thoughts = completion_tokens_details.reasoning_tokens
 */
import { isJsonObject } from '../../shared/json-object.js';
import { firstTokenCount, outputExcludesReasoning, tokenCountAt } from './usage-fields.js';
import type { RoundUsage } from './usage-types.js';

/** The whole input: the DeepSeek hit + miss split when both are there */
const promptTokensOf = (usage: Record<string, unknown>): number | null => {
    const hits = tokenCountAt(usage, ['prompt_cache_hit_tokens']);
    const misses = tokenCountAt(usage, ['prompt_cache_miss_tokens']);
    if (hits !== null && misses !== null) return hits + misses;
    return firstTokenCount(usage, [['prompt_tokens'], ['input_tokens']]);
};

export const normalizeChatCompletionsUsage = (usage: unknown): RoundUsage | null => {
    if (!isJsonObject(usage)) return null;
    const prompt = promptTokensOf(usage);
    const completion = firstTokenCount(usage, [['completion_tokens'], ['output_tokens']]);
    if (prompt === null && completion === null) return null;

    const reasoning = firstTokenCount(usage, [
        ['completion_tokens_details', 'reasoning_tokens'],
        ['reasoning_tokens'],
        ['output_tokens_details', 'reasoning_tokens'],
    ]);
    const total = tokenCountAt(usage, ['total_tokens']);
    const addReasoning = outputExcludesReasoning({ input: prompt, output: completion, reasoning, total });

    return {
        promptTokens: prompt,
        cachedTokens: firstTokenCount(usage, [
            ['prompt_cache_hit_tokens'],
            ['prompt_tokens_details', 'cached_tokens'],
            ['input_tokens_details', 'cached_tokens'],
        ]),
        cacheWriteTokens: null,
        outputTokens: completion === null ? null : addReasoning ? completion + (reasoning ?? 0) : completion,
        thoughtsTokens: reasoning,
        imageOutputTokens: null,
    };
};
