/**
 * Opening one attempt of a Gemini tool loop round: the seam between the
 * platform (which owns the client and the transport timeout) and the round
 * runner (which decides whether a failed attempt is tried again).
 */
import type { GenerateContentResponse } from '@google/genai';
import type { GeminiRoundRequest } from './gemini-tool-request.js';

export interface OpenedGeminiRound {
    readonly stream: AsyncIterable<GenerateContentResponse>;
    /** Taken before the request was sent (see GeminiRequestUsage) */
    readonly requestStartedAt: number;
    readonly streamOpenedAt: number;
}

/**
 * Sends one attempt of a round and returns its open stream; no transport
 * retry happens in here. `attemptSignal` follows the reply's stop signal,
 * and the runner aborts it once the attempt failed, which also ends a
 * stream the SDK would otherwise leave open.
 */
export type OpenGeminiRound = (
    request: GeminiRoundRequest,
    attemptSignal: AbortSignal
) => Promise<OpenedGeminiRound>;
