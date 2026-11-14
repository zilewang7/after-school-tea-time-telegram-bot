/**
 * The SDK request options of one sendWithRetry attempt (OpenAI and Anthropic
 * SDKs).
 *
 * The attempt's own signal, never the reply's: an attempt that runs out of
 * time is aborted by sendWithRetry, and only a request that listens to that
 * signal actually stops instead of streaming (and billing) next to its retry.
 * A stop still reaches it, through the attempt controller.
 *
 * No retries inside the SDK: sendWithRetry already retries what is worth it,
 * and the SDK's own two retries per call stacked on top of that (up to nine
 * requests for one round).
 */
export interface AttemptRequestOptions {
    readonly signal: AbortSignal;
    readonly maxRetries: 0;
}

export const attemptRequestOptions = (attemptSignal: AbortSignal): AttemptRequestOptions => ({
    signal: attemptSignal,
    maxRetries: 0,
});
