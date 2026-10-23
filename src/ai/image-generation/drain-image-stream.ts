/**
 * Reads an image-model stream to its end without showing any of it.
 *
 * generate_image runs inside a chat reply, so the image model's own stream is
 * never displayed. What matters is its last image, the text it wrote and the
 * closing raw response, which carries the finish reason and prompt feedback.
 */
import { match, P } from 'ts-pattern';
import type { GroundingData, StreamChunk } from '../types.js';

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
    /** Search grounding of the generation (image references Google found) */
    readonly grounding: GroundingData | null;
}

const NOTHING_DRAINED: DrainedImageStream = {
    image: null,
    text: '',
    rawResponse: undefined,
    grounding: null,
};

const chunkKey = (chunk: NonNullable<GroundingData['groundingChunks']>[number]): string =>
    chunk.web?.uri ?? chunk.image?.sourceUri ?? chunk.image?.imageUri ?? JSON.stringify(chunk);

/** Rounds of one stream may report grounding apart; merge whatever arrived */
const mergeGrounding = (into: GroundingData | null, next: GroundingData): GroundingData => {
    if (!into) return next;

    const seenChunks = new Set((into.groundingChunks ?? []).map(chunkKey));
    const chunks = [
        ...(into.groundingChunks ?? []),
        ...(next.groundingChunks ?? []).filter((chunk) => !seenChunks.has(chunkKey(chunk))),
    ];
    const imageSearchQueries = [
        ...new Set([...(into.imageSearchQueries ?? []), ...(next.imageSearchQueries ?? [])]),
    ];
    const searchQueries = [...new Set([...into.searchQueries, ...next.searchQueries])];

    return {
        ...into,
        searchQueries,
        ...(imageSearchQueries.length > 0 ? { imageSearchQueries } : {}),
        ...(chunks.length > 0 ? { groundingChunks: chunks } : {}),
    };
};

const applyChunk = (drained: DrainedImageStream, chunk: StreamChunk): DrainedImageStream =>
    match(chunk)
        .returnType<DrainedImageStream>()
        .with({ type: 'image', imageData: P.nonNullable }, ({ imageData, imageMimeType }) => ({
            ...drained,
            image: { data: imageData, mimeType: imageMimeType ?? 'image/png' },
        }))
        .with({ type: 'text' }, ({ content }) => ({ ...drained, text: drained.text + (content ?? '') }))
        .with({ type: 'done' }, ({ rawResponse }) => ({ ...drained, rawResponse }))
        .with({ type: 'grounding', groundingMetadata: P.nonNullable }, ({ groundingMetadata }) => ({
            ...drained,
            grounding: mergeGrounding(drained.grounding, groundingMetadata),
        }))
        .otherwise(() => drained);

export const drainImageStream = async (stream: AsyncIterable<StreamChunk>): Promise<DrainedImageStream> => {
    let drained = NOTHING_DRAINED;
    for await (const chunk of stream) {
        drained = applyChunk(drained, chunk);
    }
    return drained;
};
