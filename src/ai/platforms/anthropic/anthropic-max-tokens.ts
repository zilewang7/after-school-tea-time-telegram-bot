/**
 * The max_tokens of an Anthropic Messages request.
 *
 * max_tokens caps thinking and reply together, so a fixed small value cuts a
 * reply short at a high thinking effort. A request therefore asks for the
 * model's whole output limit from the model catalog (catalog row, else the
 * code seed), and for UNKNOWN_MODEL_MAX_TOKENS when the catalog has no number.
 * A provider or relay with a lower ceiling answers 400 naming max_tokens; the
 * reply then drops once to FALLBACK_MAX_TOKENS, the value every request used
 * before, and keeps it for its remaining rounds.
 */
import type { ModelCatalogCapabilities } from '../../../config/model-capabilities.js';
import { resolveModelTraits } from '../../model-traits.js';
import { errorTextOf, isParamRejection } from '../thinking-effort-wire.js';

/** A Claude id the catalog has no output limit for */
export const UNKNOWN_MODEL_MAX_TOKENS = 64_000;

/** The one-shot downgrade after a max_tokens 400 (the former fixed value) */
export const FALLBACK_MAX_TOKENS = 16_000;

/**
 * A 400 that blames max_tokens, e.g. "max_tokens: 128000 > 64000, which is the
 * maximum allowed number of output tokens for <model>"
 */
const MAX_TOKENS_REJECTION = /max[_\s]?tokens|maximum allowed number of output tokens/i;

/** One reply's max_tokens plus its one-shot downgrade state */
export interface MaxTokensWire {
    maxTokens: number;
    /** The reply already dropped to FALLBACK_MAX_TOKENS; it never changes again */
    degraded: boolean;
}

/** The model's output limit from its capabilities; UNKNOWN_MODEL_MAX_TOKENS without a usable number */
export const maxTokensOf = (capabilities: ModelCatalogCapabilities | null): number => {
    const limit = capabilities?.outputTokens;
    return typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0 ? limit : UNKNOWN_MODEL_MAX_TOKENS;
};

/** The wire state a reply starts with, from the catalog data of its model */
export const maxTokensWireOf = (model: string): MaxTokensWire => ({
    maxTokens: maxTokensOf(resolveModelTraits(model).capabilities),
    degraded: false,
});

/**
 * Drop to FALLBACK_MAX_TOKENS when `error` is a 400 that blames max_tokens and
 * the reply has not dropped yet; true when the round should be sent again.
 * A limit already at or below the fallback has nothing to drop to.
 */
export const lowerMaxTokensAfter = (wire: MaxTokensWire, model: string, error: unknown): boolean => {
    if (wire.degraded || wire.maxTokens <= FALLBACK_MAX_TOKENS || !isParamRejection(error, MAX_TOKENS_REJECTION)) {
        return false;
    }
    console.warn(
        `[anthropic] ${model} rejected max_tokens ${wire.maxTokens}; retrying with ${FALLBACK_MAX_TOKENS}: ${errorTextOf(error).slice(0, 200)}`
    );
    wire.maxTokens = FALLBACK_MAX_TOKENS;
    wire.degraded = true;
    return true;
};
