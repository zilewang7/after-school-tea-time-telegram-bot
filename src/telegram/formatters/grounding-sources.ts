/**
 * The numbered source list of a grounded reply.
 *
 * One number per source, shared by the reply's superscript markers and the
 * `GoogleSearch` footer's `[n]` lines, so a number always means the same page.
 * Every chunk kind is resolved here — Google Search pages, Vertex AI Search
 * documents, Maps places and image-search pages — because they are numbered
 * together, not per kind.
 */
import type { GroundingData } from '../../ai/types.js';

type GroundingChunk = NonNullable<GroundingData['groundingChunks']>[number];

export interface GroundingSource {
    /** 1-based; continuous in chunk order across every chunk kind */
    readonly number: number;
    /** Index into the grounding step's `groundingChunks` */
    readonly chunkIndex: number;
    readonly title: string;
    readonly uri: string;
}

export interface GroundingSourceList {
    readonly sources: readonly GroundingSource[];
    /** A step's chunk index to the number it was given; unnumbered chunks are absent */
    readonly numberByChunk: ReadonlyMap<number, number>;
}

interface ChunkDescription {
    readonly uri: string;
    readonly title: string;
}

const firstValue = (...values: Array<string | undefined>): string | undefined =>
    values.map((value) => value?.trim()).find((value): value is string => Boolean(value));

/** The page a chunk points at, whatever kind it is; null when it has no uri */
const describeChunk = (chunk: GroundingChunk): ChunkDescription | null => {
    const web = chunk.web;
    if (web?.uri) {
        return { uri: web.uri, title: firstValue(web.title) ?? 'no title' };
    }

    const retrievedContext = chunk.retrievedContext;
    if (retrievedContext?.uri) {
        return {
            uri: retrievedContext.uri,
            title: firstValue(retrievedContext.title, retrievedContext.documentName) ?? 'no title',
        };
    }

    const maps = chunk.maps;
    if (maps?.uri) {
        return { uri: maps.uri, title: firstValue(maps.title) ?? 'no title' };
    }

    const image = chunk.image;
    const imageUri = image?.sourceUri ?? image?.imageUri;
    if (imageUri) {
        return { uri: imageUri, title: firstValue(image?.title, image?.domain) ?? 'no title' };
    }

    return null;
};

/**
 * Numbers the step's renderable sources. A chunk without a uri is not a
 * source: it has nothing to open and no title worth a line, so it neither
 * takes a number nor shifts the ones after it.
 */
export const resolveGroundingSources = (metadata: GroundingData): GroundingSourceList => {
    const sources: GroundingSource[] = [];
    const numberByChunk = new Map<number, number>();
    const numberByUri = new Map<string, number>();

    (metadata.groundingChunks ?? []).forEach((chunk, chunkIndex) => {
        const description = describeChunk(chunk);
        if (description === null) return;

        // The same page found twice gets one number, both chunks pointing at it
        const knownNumber = numberByUri.get(description.uri);
        if (knownNumber !== undefined) {
            numberByChunk.set(chunkIndex, knownNumber);
            return;
        }

        const number = sources.length + 1;
        numberByUri.set(description.uri, number);
        numberByChunk.set(chunkIndex, number);
        sources.push({
            number,
            chunkIndex,
            title: description.title,
            uri: description.uri,
        });
    });

    return { sources, numberByChunk };
};

/** Telegram drops `text_link` for anything but http(s) and tg */
export const isLinkableSourceUrl = (url: string): boolean => /^https?:\/\//i.test(url);
