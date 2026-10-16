/**
 * Opening round 1 of a Gemini tool loop, with its one-shot fallbacks.
 *
 * A 400 that blames the function declarations is retried once without them;
 * any other 400 on a request carrying non-image media is retried once without
 * that media. Whatever round 1 finally sent (contents and tools) is what
 * every later round builds on; later rounds never fall back.
 */
import type { GenerateContentResponse } from '@google/genai';
import { hasNonImageMedia, stripNonImageMedia } from './gemini-media-fallback.js';
import {
    httpStatusOf,
    isFunctionDeclarationError,
    withoutFunctionDeclarations,
    type GeminiRoundRequest,
} from './gemini-tool-request.js';

export interface OpenedGeminiRound {
    readonly stream: AsyncIterable<GenerateContentResponse>;
    /** Taken before the request was sent (see GeminiRequestUsage) */
    readonly requestStartedAt: number;
    readonly streamOpenedAt: number;
}

/**
 * Sends one round and returns its open stream. Transport retries happen in
 * here, around opening the stream only; `maxRetries` overrides the default.
 */
export type OpenGeminiRound = (
    request: GeminiRoundRequest,
    maxRetries?: number
) => Promise<OpenedGeminiRound>;

export interface FirstGeminiRound {
    /** What round 1 finally sent: later rounds reuse its contents and tools */
    readonly request: GeminiRoundRequest;
    readonly opened: OpenedGeminiRound;
}

/** Same cap the media fallback always had: one attempt */
const FALLBACK_MAX_RETRIES = 1;

const describeError = (error: unknown): string =>
    (error instanceof Error ? error.message : String(error)).slice(0, 300);

/** The request to retry round 1 with, or null when the error is final */
const fallbackRequestFor = (
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

export const openFirstGeminiRound = async (
    openRound: OpenGeminiRound,
    request: GeminiRoundRequest,
    model: string
): Promise<FirstGeminiRound> => {
    try {
        return { request, opened: await openRound(request) };
    } catch (error) {
        const fallbackRequest = fallbackRequestFor(request, error, model);
        if (fallbackRequest === null) throw error;
        return {
            request: fallbackRequest,
            opened: await openRound(fallbackRequest, FALLBACK_MAX_RETRIES),
        };
    }
};
