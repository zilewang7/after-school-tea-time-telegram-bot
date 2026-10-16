/**
 * Reads an image-model stream to its end without showing any of it.
 *
 * generate_image runs inside a chat reply, so the image model's own stream is
 * never displayed. What matters is its last image, the text it wrote and the
 * closing raw response, which carries the finish reason and prompt feedback.
 */
import { match, P } from 'ts-pattern';
import type { StreamChunk } from '../types.js';

export interface GeneratedImage {
    readonly data: Buffer;
    /** As the provider labelled it; png when it said nothing */
    readonly mimeType: string;
}

export interface DrainedImageStream {
    /** The stream's last image: the platform drops draft images, and the final one comes last */
    readonly image: GeneratedImage | null;
    /** Visible text, thinking excluded */
    readonly text: string;
    /** rawResponse of the closing done chunk */
    readonly rawResponse: unknown;
}

const NOTHING_DRAINED: DrainedImageStream = { image: null, text: '', rawResponse: undefined };

const applyChunk = (drained: DrainedImageStream, chunk: StreamChunk): DrainedImageStream =>
    match(chunk)
        .returnType<DrainedImageStream>()
        .with({ type: 'image', imageData: P.nonNullable }, ({ imageData, imageMimeType }) => ({
            ...drained,
            image: { data: imageData, mimeType: imageMimeType ?? 'image/png' },
        }))
        .with({ type: 'text' }, ({ content }) => ({ ...drained, text: drained.text + (content ?? '') }))
        .with({ type: 'done' }, ({ rawResponse }) => ({ ...drained, rawResponse }))
        .otherwise(() => drained);

export const drainImageStream = async (stream: AsyncIterable<StreamChunk>): Promise<DrainedImageStream> => {
    let drained = NOTHING_DRAINED;
    for await (const chunk of stream) {
        drained = applyChunk(drained, chunk);
    }
    return drained;
};
