/**
 * One generate_image request: a single-turn call to the Gemini image model
 * through the platform path /picbanana uses (same client, safety settings and
 * draft-image skipping), with the generate_image output knobs on top.
 *
 * The reference images ride the user turn, ahead of the prompt: that is where
 * the model reads them, while images replayed in a model turn are ignored.
 * There is exactly one attempt. Whether to retry, rephrase or give up is the
 * chat model's call, so every failure comes back classified instead.
 *
 * The platform logs this request like any chat request: part sizes and the
 * prompt's first 100 characters, the same exposure the chat text it came
 * from already has. No secret travels in a prompt.
 */
import { GEMINI_IMAGE_MODEL } from '../../config/models.js';
import type {
    ImageOutputOptions,
    PlatformConfig,
    StreamChunk,
    UnifiedContentPart,
    UnifiedMessage,
} from '../types.js';
import { drainImageStream, type GeneratedImage } from './drain-image-stream.js';
import {
    classifyGenerationError,
    classifyMissingImage,
    type AbortCauses,
    type ImageGenerationFailure,
} from './image-generation-failure.js';
import { sniffImageMime } from './image-mime.js';

/** Wall-clock budget of one image request, stream included */
export const IMAGE_GENERATION_TIMEOUT_MS = 120_000;

/** Stands in for the image model's default system instruction on these requests */
const IMAGE_INSTRUCTION = 'Generate the image the user describes. Always respond with an image.';

/** From scratch there is no source shape to follow */
const DEFAULT_ASPECT_RATIO = '1:1';

export interface ImageReference {
    readonly data: Buffer;
    readonly mimeType: string;
}

export interface ImageGenerationRequest {
    readonly prompt: string;
    /** Images to follow or edit, in the order the prompt describes them */
    readonly references: readonly ImageReference[];
    /** Undefined: square from scratch, the source's shape when editing */
    readonly aspectRatio?: string;
}

/** The platform entry point (platform-factory's sendMessage) */
export type SendImageRequest = (
    messages: UnifiedMessage[],
    config: PlatformConfig
) => Promise<AsyncIterable<StreamChunk>>;

export interface ImageGenerationOptions {
    readonly sendMessage: SendImageRequest;
    /** Aborts when the reply is stopped */
    readonly signal: AbortSignal;
    /** Defaults to IMAGE_GENERATION_TIMEOUT_MS */
    readonly timeoutMs?: number;
}

export type ImageGenerationOutcome =
    | { readonly ok: true; readonly image: GeneratedImage }
    | { readonly ok: false; readonly failure: ImageGenerationFailure };

const buildRequestMessages = (request: ImageGenerationRequest): UnifiedMessage[] => {
    const referenceParts = request.references.map(
        (reference): UnifiedContentPart => ({
            type: 'image',
            imageData: reference.data.toString('base64'),
            mimeType: reference.mimeType,
            sizeBytes: reference.data.length,
        })
    );
    return [{ role: 'user', content: [...referenceParts, { type: 'text', text: request.prompt }] }];
};

const imageOutputFor = (request: ImageGenerationRequest): ImageOutputOptions => {
    const aspectRatio =
        request.aspectRatio ?? (request.references.length === 0 ? DEFAULT_ASPECT_RATIO : undefined);
    return {
        ...(aspectRatio === undefined ? {} : { aspectRatio }),
        imageSize: '1K',
        instruction: IMAGE_INSTRUCTION,
    };
};

export const generateImage = async (
    request: ImageGenerationRequest,
    options: ImageGenerationOptions
): Promise<ImageGenerationOutcome> => {
    const timeoutMs = options.timeoutMs ?? IMAGE_GENERATION_TIMEOUT_MS;
    const deadline = AbortSignal.timeout(timeoutMs);
    const abortCauses = (): AbortCauses => ({ stopped: options.signal.aborted, timedOut: deadline.aborted });

    try {
        const stream = await options.sendMessage(buildRequestMessages(request), {
            model: GEMINI_IMAGE_MODEL,
            signal: AbortSignal.any([options.signal, deadline]),
            maxRetries: 1,
            // The platform's per-attempt timeout must not undercut the deadline
            timeout: timeoutMs,
            imageOutput: imageOutputFor(request),
        });
        const drained = await drainImageStream(stream);

        // A stream cut short by an abort can end quietly, without an image
        const { stopped, timedOut } = abortCauses();
        if (stopped) return { ok: false, failure: { kind: 'stopped' } };
        if (!drained.image) {
            return { ok: false, failure: timedOut ? { kind: 'timeout' } : classifyMissingImage(drained) };
        }

        const { data, mimeType } = drained.image;
        return { ok: true, image: { data, mimeType: sniffImageMime(data) ?? mimeType } };
    } catch (error) {
        return { ok: false, failure: classifyGenerationError(error, abortCauses()) };
    }
};
