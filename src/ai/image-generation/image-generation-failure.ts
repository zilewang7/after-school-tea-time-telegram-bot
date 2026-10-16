/**
 * Why an image request came back without an image, sorted into the cases the
 * chat model can act on: wait and retry, rephrase, or tell the user.
 */
import { match, P } from 'ts-pattern';
import { isJsonObject } from '../../shared/json-object.js';
import type { DrainedImageStream } from './drain-image-stream.js';

export type ImageGenerationFailure =
    /** HTTP 429 / RESOURCE_EXHAUSTED: the shared quota is congested for now */
    | { readonly kind: 'busy' }
    | { readonly kind: 'timeout' }
    /** The reply was stopped */
    | { readonly kind: 'stopped' }
    /** A filter the safety settings cannot switch off refused it */
    | { readonly kind: 'blocked'; readonly reason: string; readonly text: string }
    /** Finished without an image; reason is the finish reason, null when the response said none */
    | { readonly kind: 'no-image'; readonly reason: string | null; readonly text: string }
    /** Answered with text instead of an image */
    | { readonly kind: 'text-only'; readonly text: string }
    | { readonly kind: 'error'; readonly message: string };

/** What aborted a request, read off the signals that could have */
export interface AbortCauses {
    readonly stopped: boolean;
    /** The request's own deadline passed */
    readonly timedOut: boolean;
}

/** Long enough to say what went wrong, short enough to stay a tool result */
const ERROR_MESSAGE_MAX_LENGTH = 300;

const BLOCKED_FINISH_REASONS: ReadonlySet<string> = new Set([
    'IMAGE_SAFETY',
    'IMAGE_PROHIBITED_CONTENT',
    'SAFETY',
    'PROHIBITED_CONTENT',
    'BLOCKLIST',
    'SPII',
]);

const NO_IMAGE_FINISH_REASONS: ReadonlySet<string> = new Set([
    'NO_IMAGE',
    'IMAGE_OTHER',
    'IMAGE_RECITATION',
    'RECITATION',
    'OTHER',
]);

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const statusOf = (error: unknown): unknown => (isJsonObject(error) ? error.status : undefined);

const isQuotaError = (error: unknown): boolean => {
    const message = messageOf(error);
    return statusOf(error) === 429 || message.includes('429') || message.includes('RESOURCE_EXHAUSTED');
};

/** A request that threw: a stop wins over everything, the deadline over what it caused */
export const classifyGenerationError = (error: unknown, causes: AbortCauses): ImageGenerationFailure => {
    if (causes.stopped) return { kind: 'stopped' };
    // The platform's own per-attempt timeout rejects with a bare 'Timeout'
    if (causes.timedOut || messageOf(error) === 'Timeout') return { kind: 'timeout' };
    if (isQuotaError(error)) return { kind: 'busy' };
    return { kind: 'error', message: messageOf(error).slice(0, ERROR_MESSAGE_MAX_LENGTH) };
};

const blockReasonOf = (rawResponse: unknown): string | null =>
    match(rawResponse)
        .with({ promptFeedback: { blockReason: P.string.select() } }, (reason) => reason)
        .otherwise(() => null);

/** First candidate's finish reason; candidates may arrive as an object keyed 'undefined' */
const finishReasonOf = (rawResponse: unknown): string | null => {
    if (!isJsonObject(rawResponse)) return null;
    const { candidates } = rawResponse;
    const candidateList: unknown[] = Array.isArray(candidates)
        ? candidates
        : isJsonObject(candidates)
            ? Object.values(candidates)
            : [];
    return match(candidateList[0])
        .with({ finishReason: P.string.select() }, (reason) => reason)
        .otherwise(() => null);
};

/** A stream that ended without an image */
export const classifyMissingImage = (drained: DrainedImageStream): ImageGenerationFailure => {
    const text = drained.text.trim();

    const blockReason = blockReasonOf(drained.rawResponse);
    if (blockReason !== null) return { kind: 'blocked', reason: blockReason, text };

    const finishReason = finishReasonOf(drained.rawResponse);
    if (finishReason !== null && BLOCKED_FINISH_REASONS.has(finishReason)) {
        return { kind: 'blocked', reason: finishReason, text };
    }
    if (finishReason !== null && NO_IMAGE_FINISH_REASONS.has(finishReason)) {
        return { kind: 'no-image', reason: finishReason, text };
    }
    if (text) return { kind: 'text-only', text };
    return { kind: 'no-image', reason: finishReason, text: '' };
};

/**
 * The failure as one log fragment. The platform layer rethrows without
 * logging, so this is where the upstream message and reason codes surface;
 * the image model's own words stay out of the log.
 */
export const failureLogDetail = (failure: ImageGenerationFailure): string =>
    match(failure)
        .with({ kind: 'blocked' }, ({ reason }) => `blocked (${reason})`)
        .with({ kind: 'no-image' }, ({ reason }) => `no-image (${reason ?? 'no finish reason'})`)
        .with({ kind: 'error' }, ({ message }) => `error: ${message.replace(/\s+/g, ' ')}`)
        .otherwise(({ kind }) => kind);
