/**
 * Google Search grounding of Gemini responses: reading it off a streamed chunk,
 * and merging the grounding of several tool rounds into one search block.
 */
import type { Candidate, GroundingMetadata } from '@google/genai';
import type { GroundingData } from '../../types.js';

type GroundingChunk = NonNullable<GroundingData['groundingChunks']>[number];

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
    const searchEntryPoint = metadata.searchEntryPoint;
    const groundingChunks = metadata.groundingChunks ?? [];
    const groundingSupports = metadata.groundingSupports ?? [];

    if (
        !searchQueries.length &&
        !groundingChunks.length &&
        !groundingSupports.length &&
        !searchEntryPoint
    ) {
        return null;
    }

    return { searchQueries, searchEntryPoint, groundingChunks };
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

/** A source is the same source when its uri is; uri-less entries compare whole */
const groundingChunkKey = (groundingChunk: GroundingChunk): string =>
    groundingChunk.web?.uri ?? JSON.stringify(groundingChunk);

/**
 * One search block for the whole reply. Every round of a tool loop reports
 * the searches the turn has done so far, so the rounds overlap: queries and
 * sources are de-duplicated, and the distinct search pages Google rendered
 * are joined so each query keeps its link. Null when no round grounded.
 */
export const mergeGroundingData = (steps: readonly GroundingData[]): GroundingData | null => {
    if (steps.length === 0) return null;

    const searchQueries = uniqueBy(
        steps.flatMap((step) => step.searchQueries),
        (query) => query
    );
    const groundingChunks = uniqueBy(
        steps.flatMap((step) => step.groundingChunks ?? []),
        groundingChunkKey
    );
    const renderedContents = uniqueBy(
        steps
            .map((step) => step.searchEntryPoint?.renderedContent)
            .filter((content): content is string => typeof content === 'string' && content.length > 0),
        (content) => content
    );

    return {
        searchQueries,
        ...(renderedContents.length > 0
            ? { searchEntryPoint: { renderedContent: renderedContents.join('') } }
            : {}),
        groundingChunks,
    };
};
