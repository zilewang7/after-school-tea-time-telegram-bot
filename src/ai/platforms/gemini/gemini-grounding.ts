/**
 * Google Search grounding of Gemini responses: reading it off a streamed chunk,
 * and merging the grounding of several tool rounds into one search block.
 */
import type { Candidate, GroundingMetadata } from '@google/genai';
import type { GroundingData, GroundingSupportData } from '../../types.js';

type GroundingChunk = NonNullable<GroundingData['groundingChunks']>[number];
type ChunkSupport = NonNullable<GroundingMetadata['groundingSupports']>[number];

/** Indices as the API should send them: whole, non-negative, no repeats */
const uniqueIndices = (indices: readonly (number | undefined)[]): number[] =>
    indices.reduce<number[]>((kept, index) => {
        if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return kept;
        return kept.includes(index) ? kept : [...kept, index];
    }, []);

/**
 * Only the segment text and the chunk indices are kept: the byte offsets are
 * the one thing that cannot be used later (see GroundingSupportData).
 */
const toGroundingSupport = (support: ChunkSupport): GroundingSupportData | null => {
    const text = support.segment?.text;
    const indices = uniqueIndices(support.groundingChunkIndices ?? []);
    if (!text || indices.length === 0) return null;
    return { segment: { text }, groundingChunkIndices: indices };
};

/**
 * Any single one of these fields means the turn touched an external source, so
 * keep whatever arrived. Requiring webSearchQueries dropped whole grounded
 * replies whose query list came back empty (urlContext-only turns, or a relay
 * that strips the field), leaving a visibly searched answer with no sources.
 */
const toGroundingData = (metadata: GroundingMetadata | undefined): GroundingData | null => {
    if (!metadata) return null;

    const searchQueries = (metadata.webSearchQueries ?? []).filter(
        (query: unknown) => query && String(query).trim().length > 0
    );
    // Image-search grounding reports its queries apart from the web ones
    const imageSearchQueries = (metadata.imageSearchQueries ?? []).filter(
        (query: unknown) => query && String(query).trim().length > 0
    );
    const searchEntryPoint = metadata.searchEntryPoint;
    const groundingChunks = metadata.groundingChunks ?? [];
    const groundingSupports = (metadata.groundingSupports ?? []).flatMap((support) => {
        const mapped = toGroundingSupport(support);
        return mapped === null ? [] : [mapped];
    });

    if (
        !searchQueries.length &&
        !imageSearchQueries.length &&
        !groundingChunks.length &&
        !groundingSupports.length &&
        !searchEntryPoint
    ) {
        return null;
    }

    return {
        searchQueries,
        ...(imageSearchQueries.length > 0 ? { imageSearchQueries } : {}),
        searchEntryPoint,
        groundingChunks,
        ...(groundingSupports.length > 0 ? { groundingSupports } : {}),
    };
};

/** The first candidate grounding a chunk carries, or null */
export const extractGroundingMetadata = (chunk: {
    readonly candidates?: readonly Candidate[];
}): GroundingData | null => {
    const candidates = chunk.candidates;
    if (!candidates) return null;

    // Array format, plus the object-with-'undefined'-key Google API bug:
    // iterating a plain object throws, so normalise to a list first.
    const candidateList = Array.isArray(candidates)
        ? candidates
        : Object.values<Candidate>(candidates);

    for (const candidate of candidateList) {
        const grounding = toGroundingData(candidate?.groundingMetadata);
        if (grounding) return grounding;
    }

    return null;
};

const uniqueBy = <T>(items: readonly T[], keyOf: (item: T) => string): T[] => {
    const seenKeys = new Set<string>();
    return items.filter((item) => {
        const key = keyOf(item);
        if (seenKeys.has(key)) return false;
        seenKeys.add(key);
        return true;
    });
};

/**
 * A source is the same source when its uri is: a web page, the page an image
 * chunk came from (imageUri alone is the CDN copy, which rotates), a retrieved
 * document, or a Maps place. Keeping the type out of the key means the same
 * page found by two tools is numbered once.
 */
const groundingChunkKey = (groundingChunk: GroundingChunk): string =>
    groundingChunk.web?.uri ??
    groundingChunk.retrievedContext?.uri ??
    groundingChunk.maps?.uri ??
    groundingChunk.image?.sourceUri ??
    groundingChunk.image?.imageUri ??
    JSON.stringify(groundingChunk);

const supportKey = (support: GroundingSupportData): string =>
    `${support.segment?.text ?? ''}\u0000${(support.groundingChunkIndices ?? []).join(',')}`;

/**
 * One search block for the whole reply. Every round of a tool loop reports
 * the searches the turn has done so far, so the rounds overlap: queries and
 * sources are de-duplicated, and the distinct search pages Google rendered
 * are joined so each query keeps its link. Null when no round grounded.
 *
 * Supports are re-pointed at the merged chunk list: a support's indices belong
 * to its own round's chunk array, which dedupe can shorten.
 */
export const mergeGroundingData = (steps: readonly GroundingData[]): GroundingData | null => {
    if (steps.length === 0) return null;

    const searchQueries = uniqueBy(
        steps.flatMap((step) => step.searchQueries),
        (query) => query
    );
    const imageSearchQueries = uniqueBy(
        steps.flatMap((step) => step.imageSearchQueries ?? []),
        (query) => query
    );
    const groundingChunks = uniqueBy(
        steps.flatMap((step) => step.groundingChunks ?? []),
        groundingChunkKey
    );
    const mergedIndexByChunkKey = new Map(
        groundingChunks.map((chunk, index): [string, number] => [groundingChunkKey(chunk), index])
    );
    const groundingSupports = uniqueBy(
        steps.flatMap((step) => {
            const stepChunkKeys = (step.groundingChunks ?? []).map(groundingChunkKey);
            return (step.groundingSupports ?? []).flatMap((support) => {
                const text = support.segment?.text;
                if (!text) return [];
                const mergedIndices = uniqueIndices(
                    (support.groundingChunkIndices ?? []).map((index) => {
                        const key = stepChunkKeys[index];
                        return key === undefined ? undefined : mergedIndexByChunkKey.get(key);
                    })
                );
                if (mergedIndices.length === 0) return [];
                return [{ segment: { text }, groundingChunkIndices: mergedIndices }];
            });
        }),
        supportKey
    );
    const renderedContents = uniqueBy(
        steps
            .map((step) => step.searchEntryPoint?.renderedContent)
            .filter((content): content is string => typeof content === 'string' && content.length > 0),
        (content) => content
    );

    return {
        searchQueries,
        ...(imageSearchQueries.length > 0 ? { imageSearchQueries } : {}),
        ...(renderedContents.length > 0
            ? { searchEntryPoint: { renderedContent: renderedContents.join('') } }
            : {}),
        groundingChunks,
        ...(groundingSupports.length > 0 ? { groundingSupports } : {}),
    };
};
