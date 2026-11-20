/**
 * Several fetch_image sources in one call: read them with the lane's own
 * concurrency, give every picture its id in request order, and answer with one
 * compact result the model can act on.
 *
 * Downloads are the only work that runs at the same time; ids and the media
 * state are written afterwards in request order, so `imgN` stays continuous and
 * matches the order the model listed its sources in. A serial lane (avatar,
 * sticker) registers each read before starting the next one, so a second
 * spelling of the same target is answered from the state it just wrote.
 */
import type { GroundingCitation, GroundingData } from '../../ai/types.js';
import type { ToolModelImage } from '../../ai/tools/tool-types.js';
import { excerptOf, type LaneOutcome } from './fetch-image-lane-types.js';
import { readFetchSource, type FetchReadContext } from './fetch-image-lanes.js';
import { formatFetchBatchResult } from './image-tool-text.js';
import type { FetchSource } from './media-tool-args.js';
import { nextFetchedImageId, nextFetchedStickerId } from './reply-media-state.js';
import { traceParts, traceUrl } from './tool-trace.js';

/** How many reads of one lane may be in flight at once */
const concurrencyOf = (kind: FetchSource['kind']): number => {
    switch (kind) {
        // Plain HTTP downloads are independent; the common lane deserves the pool
        case 'candidate':
        case 'url':
            return 3;
        // luoxu answers each picture in two requests
        case 'history':
            return 2;
        // getChat has a 429 history and the Bot API is cheap to hit one at a time
        case 'sticker':
        case 'avatar':
        case 'image':
            return 1;
    }
};

/** A lane read must fail as one item, never as the whole batch */
const readSafely = async (source: FetchSource, context: FetchReadContext): Promise<LaneOutcome> => {
    try {
        return await readFetchSource(source, context);
    } catch (error) {
        return {
            ok: false,
            error: `读取失败：${error instanceof Error ? error.message : String(error)}`,
        };
    }
};

/** Read a lane's sources in chunks, keeping the outcomes in request order */
const readInChunks = async (
    sources: readonly FetchSource[],
    limit: number,
    context: FetchReadContext
): Promise<readonly LaneOutcome[]> => {
    const outcomes: LaneOutcome[] = [];
    for (let start = 0; start < sources.length; start += limit) {
        if (context.signal.aborted) {
            for (let index = start; index < sources.length; index += 1) {
                outcomes.push({ ok: false, error: '回复已停止，没有读取。' });
            }
            break;
        }
        const chunk = sources.slice(start, start + limit);
        const read = await Promise.all(chunk.map((source) => readSafely(source, context)));
        outcomes.push(...read);
    }
    return outcomes;
};

/** How one source is named when its read fails, in the result and in the log */
const sourceNameOf = (source: FetchSource): string => {
    switch (source.kind) {
        case 'candidate':
            return source.id;
        case 'image':
            return source.id;
        case 'url':
            return traceUrl(source.url);
        case 'history':
            return source.reference;
        case 'avatar':
            return `${source.target} 头像`;
        case 'sticker':
            return `贴纸「${source.query}」`;
    }
};

/** Every failed item names itself: the model retries just that one */
const failureLineOf = (source: FetchSource, error: string): string =>
    `${sourceNameOf(source)}：${error}`;

const uniqueCitations = (citations: readonly GroundingCitation[]): GroundingCitation[] => {
    const seen = new Set<string>();
    return citations.filter((citation) => {
        if (seen.has(citation.uri)) return false;
        seen.add(citation.uri);
        return true;
    });
};

export interface FetchBatchOutcome {
    readonly content: string;
    readonly isError: boolean;
    readonly modelImages: readonly ToolModelImage[];
    readonly record: GroundingData | null;
    readonly traceResult: string;
    /** The failed items, named by source; the tool logs them */
    readonly failures: readonly string[];
}

interface BatchTally {
    readonly lines: Array<{ readonly id: string; readonly summary: string }>;
    readonly sourcePages: Array<{ readonly id: string; readonly page: string }>;
    readonly failures: string[];
    readonly modelImages: ToolModelImage[];
    readonly citations: GroundingCitation[];
    readonly searchQueries: string[];
    /** Lines that carried new bytes; the rest are pictures already in context */
    freshCount: number;
}

const emptyTally = (): BatchTally => ({
    lines: [],
    sourcePages: [],
    failures: [],
    modelImages: [],
    citations: [],
    searchQueries: [],
    freshCount: 0,
});

/** One outcome into the answer: an id, a reuse note, or a named failure */
const absorb = (
    tally: BatchTally,
    source: FetchSource,
    outcome: LaneOutcome,
    context: FetchReadContext
): void => {
    if (!outcome.ok) {
        tally.failures.push(failureLineOf(source, outcome.error));
        return;
    }
    if (outcome.status === 'reuse') {
        // An alias of a picture already listed in this batch stays one line
        if (!tally.lines.some((line) => line.id === outcome.id)) {
            tally.lines.push({ id: outcome.id, summary: '（已经读过，不再重复附）' });
        }
        return;
    }

    const { read } = outcome;
    const id = read.kind === 'sticker' ? nextFetchedStickerId(context.state) : nextFetchedImageId(context.state);
    read.register(id);
    const materialized = read.materialize(id);
    tally.lines.push({ id, summary: read.summary });
    tally.freshCount += 1;
    tally.modelImages.push({ data: read.data, mimeType: read.mimeType, caption: materialized.caption });
    if (read.sourcePage !== null) tally.sourcePages.push({ id, page: read.sourcePage });
    if (read.citation !== undefined) tally.citations.push(read.citation);
    if (read.searchQuery !== undefined) tally.searchQueries.push(read.searchQuery);
};

export const runFetchImageBatch = async (
    sources: readonly FetchSource[],
    skippedDuplicates: readonly string[],
    context: FetchReadContext
): Promise<FetchBatchOutcome> => {
    const first = sources[0];
    const limit = concurrencyOf(first?.kind ?? 'candidate');
    const kind: 'image' | 'sticker' = first?.kind === 'sticker' ? 'sticker' : 'image';
    const tally = emptyTally();

    if (limit === 1) {
        // A serial lane registers each read before the next one runs, so an
        // alias of the same target hits the reuse short circuit instead of
        // downloading (and numbering) the same picture twice.
        for (const source of sources) {
            const outcome: LaneOutcome = context.signal.aborted
                ? { ok: false, error: '回复已停止，没有读取。' }
                : await readSafely(source, context);
            absorb(tally, source, outcome, context);
        }
    } else {
        const outcomes = await readInChunks(sources, limit, context);
        for (let index = 0; index < sources.length; index += 1) {
            const source = sources[index];
            const outcome = outcomes[index];
            if (source === undefined || outcome === undefined) continue;
            absorb(tally, source, outcome, context);
        }
    }

    const content = formatFetchBatchResult({
        kind,
        lines: tally.lines,
        freshCount: tally.freshCount,
        failures: tally.failures,
        skippedDuplicates,
        sourcePages: tally.sourcePages,
    });
    const citationList = uniqueCitations(tally.citations);
    const queries = [...new Set(tally.searchQueries)];
    const record: GroundingData | null =
        citationList.length === 0 && queries.length === 0
            ? null
            : {
                  provider: 'mcp',
                  searchQueries: queries,
                  ...(citationList.length === 0 ? {} : { citations: citationList }),
              };
    const firstId = tally.lines[0]?.id;
    const firstFailure = tally.failures[0] ?? '';
    const traceResult =
        firstId === undefined
            ? traceParts(`${tally.failures.length} 项失败`, excerptOf(firstFailure, 28))
            : traceParts(
                  tally.freshCount === 0 ? '已在上下文里' : `${firstId} 等 ${tally.lines.length} 张`,
                  tally.failures.length > 0 ? `${tally.failures.length} 项失败` : null
              );

    return {
        content,
        isError: tally.lines.length === 0,
        modelImages: tally.modelImages,
        record,
        traceResult,
        failures: tally.failures,
    };
};
