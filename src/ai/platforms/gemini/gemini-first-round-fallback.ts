/**
 * Round 1's one-shot fallbacks.
 *
 * A 400 that blames the function declarations is retried once without them;
 * any other 400 on a request carrying non-image media is retried once without
 * that media. Whatever round 1 finally sent (contents and tools) is what
 * every later round builds on; later rounds never fall back.
 */
import { hasNonImageMedia, stripNonImageMedia } from './gemini-media-fallback.js';
import {
    httpStatusOf,
    isFunctionDeclarationError,
    withoutFunctionDeclarations,
    type GeminiRoundRequest,
} from './gemini-tool-request.js';

const describeError = (error: unknown): string =>
    (error instanceof Error ? error.message : String(error)).slice(0, 300);

/** The request to send round 1 again with, or null when the error is not one of the two */
export const firstRoundFallbackFor = (
    request: GeminiRoundRequest,
    error: unknown,
    model: string
): GeminiRoundRequest | null => {
    if (isFunctionDeclarationError(error)) {
        console.error(
            `[gemini] ${model} rejected the function declarations with 400; retrying without client tools: ${describeError(error)}`
        );
        return { ...request, tools: withoutFunctionDeclarations(request.tools) };
    }
    if (httpStatusOf(error) === 400 && hasNonImageMedia(request.contents)) {
        console.warn(
            `[gemini] ${model} rejected a media part with 400; retrying without non-image media`
        );
        return { ...request, contents: stripNonImageMedia(request.contents) };
    }
    return null;
};
