/**
 * Gemini `usageMetadata` (Vertex, the custom endpoint and OpenCode Go alike).
 *
 * - prompt = promptTokenCount (cache hits included), plus toolUsePromptTokenCount
 *   when it is not already part of it (below)
 * - output = candidatesTokenCount + thoughtsTokenCount: unlike the
 *   `[gemini-usage]` log line, output here includes the thoughts
 * - imageOutput = the IMAGE entries of candidatesTokensDetails; null without
 *   that list, so an image row without a split is priced as image output
 *
 * The REST API omits zero counts (proto3 JSON), so a missing count next to a
 * present prompt count is a zero. Whether toolUsePromptTokenCount is inside
 * promptTokenCount is not documented: total = prompt + candidates + thoughts
 * means it is, anything else means it has to be added (the documented reading
 * of totalTokenCount).
 */
import { isJsonObject } from '../../shared/json-object.js';
import { tokenCountAt } from './usage-fields.js';
import type { RoundUsage, ServedTier } from './usage-types.js';

const IMAGE_MODALITY = 'IMAGE';

/** Image tokens of a modality breakdown; null when there is no breakdown at all */
const imageModalityTokens = (details: unknown): number | null => {
    if (!Array.isArray(details)) return null;
    return details.reduce<number>((sum, entry) => {
        if (!isJsonObject(entry) || entry.modality !== IMAGE_MODALITY) return sum;
        return sum + (tokenCountAt(entry, ['tokenCount']) ?? 0);
    }, 0);
};

/** Vertex trafficType values, as production returned them (2026-11-11) */
const PRIORITY_TRAFFIC = 'ON_DEMAND_PRIORITY';
const STANDARD_TRAFFIC = 'ON_DEMAND';

/**
 * The tier a round was served at, read from `usageMetadata.trafficType` of
 * its last chunk. A priority request is downgraded silently when Vertex has
 * no capacity, so this, not the request, decides the price. Undefined when
 * the response did not say (relays, OpenCode Go) or named another tier.
 */
export const geminiServedTier = (usageMetadata: unknown): ServedTier | undefined => {
    if (!isJsonObject(usageMetadata)) return undefined;
    const { trafficType } = usageMetadata;
    if (trafficType === PRIORITY_TRAFFIC) return 'priority';
    if (trafficType === STANDARD_TRAFFIC) return 'standard';
    return undefined;
};

export const normalizeGeminiUsage = (usageMetadata: unknown): RoundUsage | null => {
    if (!isJsonObject(usageMetadata)) return null;
    const prompt = tokenCountAt(usageMetadata, ['promptTokenCount']);
    const candidates = tokenCountAt(usageMetadata, ['candidatesTokenCount']);
    const thoughts = tokenCountAt(usageMetadata, ['thoughtsTokenCount']);
    if (prompt === null && candidates === null && thoughts === null) return null;

    const candidateTokens = candidates ?? 0;
    const thoughtTokens = thoughts ?? 0;
    const toolUseTokens = tokenCountAt(usageMetadata, ['toolUsePromptTokenCount']) ?? 0;
    const total = tokenCountAt(usageMetadata, ['totalTokenCount']);
    const toolUseInsidePrompt =
        toolUseTokens === 0 || (prompt !== null && total === prompt + candidateTokens + thoughtTokens);

    return {
        promptTokens: prompt === null ? null : toolUseInsidePrompt ? prompt : prompt + toolUseTokens,
        cachedTokens: tokenCountAt(usageMetadata, ['cachedContentTokenCount']) ?? 0,
        cacheWriteTokens: null,
        outputTokens: candidateTokens + thoughtTokens,
        thoughtsTokens: thoughtTokens,
        imageOutputTokens: imageModalityTokens(usageMetadata.candidatesTokensDetails),
    };
};
