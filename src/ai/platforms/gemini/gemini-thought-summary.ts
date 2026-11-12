/**
 * What Gemini 4's thought summary is worth showing, on Vertex.
 *
 * `includeThoughts` returns a *summary* of the model's thinking: a small
 * summarizer model writes one "heading + ≤50 word paragraph" update per
 * thinking segment. On `gemini-4-carbon` the API hands back the summarizer's
 * own generation, which starts with its "Thinking Process:" scaffold (the
 * summarizer restating its instructions, drafting, counting words). argon and
 * 3.8-flash on the same endpoint return only the summary, so the intended
 * shape is unambiguous — see docs/2026-1112-1255.
 *
 * This module recognises that stream and keeps only the summaries. A stream
 * that does not start with the scaffold is passed through untouched, with no
 * buffering, so every other model (and every other platform) is unaffected.
 *
 * A block is the text between two scaffold starts. One block can carry several
 * updates (1-18 in production) — the later ones are appended without a new
 * scaffold — so every clean summary in a block is kept, in order. A block whose
 * only usable text is the indented draft of the summarizer's "Final Polish"
 * step still yields that draft: it is the answer the summarizer stopped after.
 */

/** A block starts at the summarizer's scaffold: marker, blank line, numbered step */
const BLOCK_START_AT = /^Thinking Process:\n\n\d+\.\s+\*\*/;
const BLOCK_START_MARKER = 'Thinking Process:';
/** Enough text for BLOCK_START_AT to decide; a shorter tail simply waits */
const BLOCK_START_LOOKAHEAD = 120;

/** One candidate answer: a bold heading followed by a blank line and a paragraph */
const HEADING_CANDIDATE = /\*\*([^*\n]{1,80})\*\*\n\n/g;
/** A heading glued to the end of the paragraph before it (the next update's) */
const GLUED_HEADING = /\*\*[^*\n]{1,80}\*\*$/;

/** The summarizer's own detection prefix; anything else is passed through */
const SUMMARY_START = 'Thinking Process:\n\n';

/** A paragraph that is prose: one line, no list or step marker */
const isAnswerParagraph = (paragraph: string): boolean =>
    paragraph !== '' &&
    paragraph.includes('\n') === false &&
    /^(?:\d+[.)]\s|\*\s|[-+]\s)/.test(paragraph) === false;

export interface ThoughtSummaryStats {
    /** The stream was recognised as a summarizer stream */
    readonly detected: boolean;
    /** Thinking characters the upstream sent */
    readonly rawChars: number;
    /** Characters that reach the display and the stored version */
    readonly cleanChars: number;
    readonly blocks: number;
    readonly summaries: number;
    /** Blocks with no usable summary (the upstream stopped before its answer) */
    readonly dropped: number;
}

/**
 * What the filter knows between rounds, as plain data: a tool loop checkpoint
 * keeps it and a resume restores it. Nothing is held between rounds (a round
 * ends with flush, a broken attempt with flushBroken), so the held text is not
 * part of it.
 */
export interface ThoughtSummaryFilterState {
    /** Whether the stream was recognised as a summarizer stream, or not decided yet */
    readonly mode: 'detecting' | 'filtering' | 'passthrough';
    /** A summary went out already: the next one starts after a blank line */
    readonly emitted: boolean;
}

export interface ThoughtSummaryFilter {
    /** Clean text that may be shown now; empty while a block is still arriving */
    push(text: string): string;
    /** Clean text left when the stream or the round ends */
    flush(): string;
    /**
     * Clean text left when the stream broke off: only the summaries the cut
     * block finished. Text held while the stream was not recognised yet is
     * dropped, as it may be the scaffold's start; nothing stays held.
     */
    flushBroken(): string;
    stats(): ThoughtSummaryStats;
    /** A copy of what holds across rounds; read it right after flush or flushBroken */
    state(): ThoughtSummaryFilterState;
}

interface Candidate {
    readonly heading: string;
    readonly paragraph: string;
    readonly indented: boolean;
}

const readCandidate = (block: string, match: RegExpMatchArray): Candidate => {
    const after = block.slice((match.index ?? 0) + match[0].length);
    const rawParagraph = after.split(/\n{2,}/)[0] ?? '';
    const paragraph = rawParagraph.replace(GLUED_HEADING, '').trim();
    return { heading: match[1] ?? '', paragraph, indented: /^\s/.test(rawParagraph) };
};

/**
 * Every summary a block carries, in the order the summarizer wrote them.
 * Empty when the block has none (a scaffold cut before its answer).
 */
export const extractThoughtSummaries = (block: string): string[] => {
    const clean: Candidate[] = [];
    let lastDraft: Candidate | null = null;
    for (const match of block.matchAll(HEADING_CANDIDATE)) {
        const candidate = readCandidate(block, match);
        if (isAnswerParagraph(candidate.paragraph) === false) continue;
        if (candidate.indented) {
            lastDraft = candidate;
            continue;
        }
        clean.push(candidate);
    }
    // A block that stopped right after the indented Final Polish draft still
    // carries the intended answer in that draft.
    const chosen = clean.length > 0 ? clean : lastDraft === null ? [] : [lastDraft];
    return chosen.map((candidate) => `**${candidate.heading}**\n\n${candidate.paragraph}`);
};

/**
 * A cut block up to its last blank line: a paragraph after it may stop
 * mid-sentence, every one before it is finished
 */
const finishedPartOf = (block: string): string => {
    const lastBlankLine = block.lastIndexOf('\n\n');
    return lastBlankLine === -1 ? '' : block.slice(0, lastBlankLine + 2);
};

/** Index of the next block start at or after `from`, or -1 when not complete yet */
const findNextBlockStart = (text: string, from: number): number => {
    let index = text.indexOf(BLOCK_START_MARKER, from);
    while (index !== -1) {
        if (BLOCK_START_AT.test(text.slice(index, index + BLOCK_START_LOOKAHEAD))) return index;
        index = text.indexOf(BLOCK_START_MARKER, index + 1);
    }
    return -1;
};

/**
 * True while `held` could still become the summarizer's start. The first
 * chunk can end anywhere inside the signature, so the decision waits for a
 * mismatch; leading blank space is held (dropped when filtering, released
 * when passing through).
 */
const couldStillBeSummaryStart = (held: string): boolean => {
    const trimmed = held.replace(/^\s+/, '');
    if (SUMMARY_START.startsWith(trimmed)) return true;
    if (trimmed.startsWith(SUMMARY_START) === false) return false;
    const rest = trimmed.slice(SUMMARY_START.length);
    return (
        rest === '' ||
        /^\d+$/.test(rest) ||
        /^\d+\.$/.test(rest) ||
        /^\d+\.\s+$/.test(rest) ||
        /^\d+\.\s+\*$/.test(rest) ||
        /^\d+\.\s+\*\*$/.test(rest)
    );
};

const FRESH_FILTER: ThoughtSummaryFilterState = { mode: 'detecting', emitted: false };

export const createThoughtSummaryFilter = (
    initial: ThoughtSummaryFilterState = FRESH_FILTER
): ThoughtSummaryFilter => {
    let mode: ThoughtSummaryFilterState['mode'] = initial.mode;
    let held = '';
    let emitted = initial.emitted;
    const stats = {
        detected: initial.mode === 'filtering',
        rawChars: 0,
        cleanChars: 0,
        blocks: 0,
        summaries: 0,
        dropped: 0,
    };

    /** Turn one block into the text to release now; `finished` is the part whose summaries count */
    const release = (block: string, finished: string = block): string => {
        // Blank space between blocks is a separator, not a block
        if (block.trim() === '') return '';
        const summaries = extractThoughtSummaries(finished);
        stats.blocks += 1;
        if (summaries.length === 0) {
            stats.dropped += 1;
            console.warn(`[gemini] thought summary: a block yielded no summary (len=${block.length})`);
            return '';
        }
        stats.summaries += summaries.length;
        const text = summaries.join('\n\n');
        stats.cleanChars += text.length;
        const output = emitted ? `\n\n${text}` : text;
        emitted = true;
        return output;
    };

    /** Release every completed block in `held`, keeping the last one pending */
    const drainCompletedBlocks = (): string => {
        let output = '';
        for (;;) {
            const start = findNextBlockStart(held, 1);
            if (start === -1) break;
            const block = held.slice(0, start);
            held = held.slice(start);
            output += release(block);
        }
        return output;
    };

    const push = (text: string): string => {
        stats.rawChars += text.length;
        if (mode === 'passthrough') return text;
        held += text;
        if (mode === 'detecting') {
            // The stream may open with blank space before the scaffold
            const trimmed = held.replace(/^\s+/, '');
            if (BLOCK_START_AT.test(trimmed)) {
                mode = 'filtering';
                stats.detected = true;
                held = trimmed;
                return drainCompletedBlocks();
            }
            if (couldStillBeSummaryStart(held)) return '';
            mode = 'passthrough';
            const released = held;
            held = '';
            return released;
        }
        return drainCompletedBlocks();
    };

    const flush = (): string => {
        if (mode === 'detecting') {
            const released = held;
            held = '';
            return released;
        }
        if (mode !== 'filtering' || held.trim() === '') {
            held = '';
            return '';
        }
        const block = held;
        held = '';
        return release(block);
    };

    const flushBroken = (): string => {
        const block = held;
        held = '';
        // Undecided text belongs to an attempt that is thrown away; passing it
        // through could show the scaffold's first line
        if (mode !== 'filtering') return '';
        return release(block, finishedPartOf(block));
    };

    return {
        push,
        flush,
        flushBroken,
        stats: () => ({ ...stats }),
        state: () => ({ mode, emitted }),
    };
};

/** The one-line log for a reply, or null when the stream was not a summarizer stream */
export const thoughtSummaryLogLine = (model: string, stats: ThoughtSummaryStats): string | null =>
    stats.detected === false
        ? null
        : `[gemini] ${model} thought summaries filtered raw=${stats.rawChars} clean=${stats.cleanChars} ` +
          `blocks=${stats.blocks} summaries=${stats.summaries} dropped=${stats.dropped}`;
