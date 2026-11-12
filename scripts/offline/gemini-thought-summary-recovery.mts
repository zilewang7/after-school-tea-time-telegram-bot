/**
 * Offline cases for the thought-summary filter where it meets the Gemini tool
 * loop's automatic recovery and its checkpoints (design 2026-1112-1123 §5.3,
 * §6.2). A summarizer stream is gemini-4-carbon's "Thinking Process:" scaffold
 * (the real production blocks of support/thought-summary-fixtures.mts); a
 * pass-through stream is any other thinking.
 *
 * These cases pin:
 * - a summarizer stream that breaks anywhere inside a block and is retried:
 *   only whole summaries show, nothing of the scaffold, nothing twice, and the
 *   retry's thinking sits one blank line after the §5.3 marker;
 * - when that marker shows: after a shown summary (also one the break itself
 *   released), never while the filter was still holding everything;
 * - a stop and an error in the middle of a block: shown and kept are clean;
 * - pass-through streams on every recovery path: the very chunks they had
 *   before the filter (the scripts of gemini-round-recovery.mts);
 * - checkpoints: the filter's decision and separator ride along, a resume
 *   goes on with them, the journal holds filtered thinking only and is
 *   replayed as it is, a malformed filter state is refused;
 * - the filter's log line on a resumed reply counts the resumed rounds only;
 * - flushBroken itself, next to flush: a broken stream gives up finished
 *   summaries only and drops text it had not decided on yet.
 *
 * The platform runs a real Vertex-mode SDK client over a fake fetch
 * (support/fake-vertex.mts); its sleeps return at once.
 *
 * Run: npx tsx scripts/offline/gemini-thought-summary-recovery.mts
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import {
    createFakeVertex,
    httpErrorReply,
    midStreamErrorReply,
    sseReply,
    stalledStreamReply,
    type ScriptedReply,
} from './support/fake-vertex.mts';
import {
    answer,
    asRecord,
    callPart,
    consumeReply,
    errorMessage,
    event,
    json,
    roundEvents,
    signature,
    textOf,
    textPart,
    thoughtPart,
    type ConsumeOptions,
    type ConsumedReply,
} from './support/gemini-loop-fixtures.mts';
import { THOUGHT_SUMMARY_FIXTURES, type ThoughtSummaryFixture } from './support/thought-summary-fixtures.mts';
import type { StreamChunk, UnifiedMessage } from '../../src/ai/types.js';
import type { ToolHandler } from '../../src/ai/tools/index.js';
import type { ToolLoopCheckpoint } from '../../src/ai/tools/tool-loop-checkpoint.js';

// Gemini client tools on, whatever the shell says (read lazily by the platform)
delete process.env.GEMINI_CLIENT_TOOLS;

const { GeminiPlatform } = await import('../../src/ai/platforms/gemini-platform.js');
const { createTurnTools } = await import('../../src/ai/tools/index.js');
const { isGeminiCheckpointState } = await import('../../src/ai/platforms/gemini/gemini-checkpoint.js');
const { createThoughtSummaryFilter } = await import('../../src/ai/platforms/gemini/gemini-thought-summary.js');

type GeminiCheckpointState = import('../../src/ai/platforms/gemini/gemini-checkpoint.js').GeminiCheckpointState;

const MODEL = 'gemini-3.8-flash';
const RATE_LIMITED = 'Resource exhausted. Please try again later.';
const INTERNAL = 'Internal error encountered.';
const BAD_REQUEST = 'Request contains an invalid argument.';

const vertex = createFakeVertex();

/** Records every wait and returns at once */
class InstantGeminiPlatform extends GeminiPlatform {
    readonly sleeps: number[] = [];

    protected override sleep(ms: number, signal?: AbortSignal): Promise<void> {
        this.sleeps.push(ms);
        return signal?.aborted ? Promise.reject(new Error('Aborted')) : Promise.resolve();
    }
}

// random 0.5: no jitter, every wait is the ladder's base value
const platform = new InstantGeminiPlatform({ client: vertex.client, random: () => 0.5 });

// ---------------------------------------------------------------------------
// Summarizer blocks
// ---------------------------------------------------------------------------

const fixtureAt = (index: number): ThoughtSummaryFixture => {
    const fixture = THOUGHT_SUMMARY_FIXTURES[index];
    if (fixture === undefined) throw new Error(`thought summary fixture ${index} is missing`);
    return fixture;
};

/** A draft glued to its final answer: one summary */
const GLUED_BLOCK = fixtureAt(0);
/** The answer only in the indented Final Polish draft */
const DRAFT_BLOCK = fixtureAt(1);
/** Cut before its answer: no summary */
const UNANSWERED_BLOCK = fixtureAt(2);
/** Two updates in one block */
const TWO_UPDATE_BLOCK = fixtureAt(3);
/** Quotes the "Thinking Process:" marker inside the block */
const QUOTING_BLOCK = fixtureAt(4);

const secondUpdateAt = TWO_UPDATE_BLOCK.expected.indexOf('\n\n**Formulating the final witty response**');
const FIRST_UPDATE = TWO_UPDATE_BLOCK.expected.slice(0, secondUpdateAt);

/** One heading per summary the fixtures carry: each may show at most once */
const SUMMARY_HEADINGS = [
    '**Unpacking linguistic mechanisms behind loanwords**',
    '**Investigating regional geography and platform algorithms**',
    '**Anticipating the streaming ban consequences**',
    '**Formulating the final witty response**',
    '**Optimizing code size and performance**',
];

/** What the summarizer's own scaffold leaves behind when it leaks */
const SCAFFOLD_TRACES = ['Thinking Process', 'Analyze the Request', 'Drafting', 'Final Polish', 'Word count', '\n    '];

const expectNoScaffold = (text: string, label: string): void => {
    for (const trace of SCAFFOLD_TRACES) {
        expect(!text.includes(trace), `${label}: no ${json(trace)} of the scaffold shows (got ${json(text.slice(0, 120))}…)`);
    }
};

const occurrences = (text: string, part: string): number => text.split(part).length - 1;

const expectEachSummaryOnce = (text: string, label: string): void => {
    for (const heading of SUMMARY_HEADINGS) {
        expect(occurrences(text, heading) <= 1, `${label}: ${heading} shows at most once (got ${occurrences(text, heading)})`);
    }
};

// ---------------------------------------------------------------------------
// Rounds on the wire
// ---------------------------------------------------------------------------

/** `text` in pieces of `size` characters, in order */
const piecesOf = (text: string, size: number): string[] => {
    const pieces: string[] = [];
    for (let start = 0; start < text.length; start += size) pieces.push(text.slice(start, start + size));
    return pieces;
};

/** Thinking as the upstream streams it: one thought part per event */
const thoughtEvents = (thinking: string, size = 400): unknown[] =>
    piecesOf(thinking, size).map((piece) => event([thoughtPart(piece)]));

/** A round that thinks `thinking`, then answers */
const thinkingAnswer = (thinking: string, reply: string, size = 400): ScriptedReply =>
    sseReply([...thoughtEvents(thinking, size), event([textPart(reply)], { finishReason: 'STOP' })]);

/** A round that thinks `thinking`, then calls lookup_a */
const thinkingCall = (thinking: string, label: string): ScriptedReply =>
    sseReply([
        ...thoughtEvents(thinking),
        event([callPart('lookup_a', { topic: label }, label, `call_${label}`)], { finishReason: 'STOP' }),
    ]);

/** A round that calls lookup_a without any thinking */
const silentCall = (label: string): ScriptedReply =>
    sseReply([event([callPart('lookup_a', { topic: label }, label, `call_${label}`)], { finishReason: 'STOP' })]);

/** Streams `thinking`, then the body ends in a Vertex error */
const brokenThinking = (thinking: string, code = 500, message = INTERNAL): ScriptedReply =>
    midStreamErrorReply(thoughtEvents(thinking), code, message);

const signedEmptyText = (label: string) => ({ text: '', thoughtSignature: signature(label) });

/** The §5.3 marker's own line */
const markerLine = (roundNumber: number): string =>
    `〔第 ${roundNumber} 轮生成中断，已自动重试，以下为重新生成的思考〕`;

/** The marker as the thinking shows it: one blank line before it and one after it */
const shownMarker = (roundNumber: number): string => `\n\n${markerLine(roundNumber)}\n\n`;

// ---------------------------------------------------------------------------
// Chunks as the consumer sees them
// ---------------------------------------------------------------------------

const thinkingChunk = (content: string): StreamChunk => ({ type: 'thinking', content });
const textChunk = (content: string): StreamChunk => ({ type: 'text', content });
const statusChunk = (text: string): StreamChunk => ({ type: 'status', status: { text, chatAction: 'typing' } });
const CLEARED_STATUS: StreamChunk = { type: 'status' };

const withoutDone = (chunks: readonly StreamChunk[]): StreamChunk[] => chunks.filter((chunk) => chunk.type !== 'done');

const thinkingContents = (chunks: readonly StreamChunk[]): string[] =>
    chunks.filter((chunk) => chunk.type === 'thinking').map((chunk) => chunk.content ?? '');

/** The thinking shown before the first status line: the failed attempt's own */
const thinkingBeforeFirstStatus = (chunks: readonly StreamChunk[]): string => {
    const firstStatus = chunks.findIndex((chunk) => chunk.type === 'status');
    return textOf(firstStatus === -1 ? chunks : chunks.slice(0, firstStatus), 'thinking');
};

const fresh = (chunks: readonly StreamChunk[]): StreamChunk[] => chunks.filter((chunk) => chunk.replay !== true);
const replayed = (chunks: readonly StreamChunk[]): StreamChunk[] => chunks.filter((chunk) => chunk.replay === true);

const thoughtSummaryLineOf = (lines: readonly string[]): string =>
    lines.find((line) => line.includes('thought summaries filtered')) ?? '';

/** A dropped block warns by design; mute it while that outcome is expected */
const withMutedWarnings = async (body: () => Promise<void>): Promise<void> => {
    const originalWarn = console.warn;
    console.warn = () => undefined;
    try {
        await body();
    } finally {
        console.warn = originalWarn;
    }
};

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------

const lookupA: ToolHandler = {
    definition: { name: 'lookup_a', description: 'The lookup_a tool', inputSchema: { type: 'object', properties: { topic: { type: 'string' } } } },
    execute: async () => ({ content: 'key is K-7731', isError: false, images: [], record: null }),
};
const turnTools = createTurnTools([lookupA]);

const userTurn: UnifiedMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'What is the code word?' }] }];

const reset = (replies: readonly ScriptedReply[]): void => {
    vertex.reset(replies);
    platform.sleeps.length = 0;
};

interface TurnOptions extends ConsumeOptions {
    readonly resumeFrom?: ToolLoopCheckpoint;
    readonly signal?: AbortSignal;
    readonly maxRetries?: number;
}

interface TurnResult extends ConsumedReply {
    readonly checkpoints: ToolLoopCheckpoint[];
}

/** One reply (a resume when `resumeFrom` is set), every checkpoint it hands over collected */
const runTurn = async (options: TurnOptions = {}): Promise<TurnResult> => {
    const checkpoints: ToolLoopCheckpoint[] = [];
    const consumed = await consumeReply(
        () =>
            platform.sendMessage(options.resumeFrom ? [] : userTurn, {
                model: MODEL,
                systemPrompt: 'offline system prompt',
                maxRetries: options.maxRetries ?? 3,
                tools: turnTools,
                checkpointSink: (checkpoint) => checkpoints.push(checkpoint),
                ...(options.resumeFrom ? { resumeFrom: options.resumeFrom } : {}),
                ...(options.signal ? { signal: options.signal } : {}),
            }),
        options
    );
    return { ...consumed, checkpoints };
};

const lastCheckpoint = (turn: TurnResult): ToolLoopCheckpoint => {
    const checkpoint = turn.checkpoints.at(-1);
    if (checkpoint === undefined) throw new Error(`no checkpoint was handed over (${errorMessage(turn.error)})`);
    return checkpoint;
};

const stateOf = (checkpoint: ToolLoopCheckpoint): GeminiCheckpointState => {
    if (!isGeminiCheckpointState(checkpoint.state)) throw new Error(`not a Gemini checkpoint state: ${json(checkpoint.state)}`);
    return checkpoint.state;
};

/** Round 1 thinks `thinking` and calls; round 2 is refused: the checkpoint after round 1 */
const checkpointAfter = async (round1: ScriptedReply): Promise<ToolLoopCheckpoint> => {
    reset([round1, httpErrorReply(400, BAD_REQUEST)]);
    const interrupted = await runTurn();
    expect(asRecord(interrupted.error).status === 400, `round 2 is refused (got ${errorMessage(interrupted.error)})`);
    const checkpoint = lastCheckpoint(interrupted);
    expect(checkpoint.completedRounds === 1, `round 1 is kept (got ${checkpoint.completedRounds})`);
    return checkpoint;
};

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

/** Where in TWO_UPDATE_BLOCK a break lands, and what the failed attempt shows of it */
interface NamedCut {
    readonly what: string;
    readonly at: number;
    /** The failed attempt's thinking: GLUED_BLOCK's summary, then what the cut block finished */
    readonly shown: string;
}

const twoUpdateRaw = TWO_UPDATE_BLOCK.raw;
const draftParagraphAt = twoUpdateRaw.indexOf('    I am recognizing that my teasing');
const gluedAnswerAt = twoUpdateRaw.indexOf('.**Anticipating the streaming ban consequences**\n\nI am recognizing') + 1;
const firstAnswerParagraphAt = gluedAnswerAt + '**Anticipating the streaming ban consequences**\n\n'.length;
const firstAnswerEndAt = twoUpdateRaw.indexOf('caught his attention.\n\n**Formulating') + 'caught his attention.\n\n'.length;
const secondParagraphAt = twoUpdateRaw.indexOf('I am wrapping up');

const NAMED_CUTS: readonly NamedCut[] = [
    { what: 'inside the block start', at: 8, shown: GLUED_BLOCK.expected },
    { what: 'in the scaffold', at: twoUpdateRaw.indexOf('3.  **Drafting the Paragraph:**') + 20, shown: GLUED_BLOCK.expected },
    { what: 'inside the indented draft paragraph', at: draftParagraphAt + 40, shown: GLUED_BLOCK.expected },
    { what: 'inside the heading glued to the draft', at: gluedAnswerAt + 12, shown: GLUED_BLOCK.expected },
    // The draft before the glued heading is finished, and it is the same answer
    { what: 'inside the first answer paragraph', at: firstAnswerParagraphAt + 30, shown: `${GLUED_BLOCK.expected}\n\n${FIRST_UPDATE}` },
    { what: 'right after the first answer and its blank line', at: firstAnswerEndAt, shown: `${GLUED_BLOCK.expected}\n\n${FIRST_UPDATE}` },
    { what: 'inside the second answer paragraph', at: secondParagraphAt + 30, shown: `${GLUED_BLOCK.expected}\n\n${FIRST_UPDATE}` },
    { what: 'at the end of the block', at: twoUpdateRaw.length, shown: `${GLUED_BLOCK.expected}\n\n${TWO_UPDATE_BLOCK.expected}` },
];

/** The retry's own thinking wherever it streams QUOTING_BLOCK then DRAFT_BLOCK */
const RETRY_THINKING = `${QUOTING_BLOCK.expected}\n\n${DRAFT_BLOCK.expected}`;

const cases: Array<{ name: string; body: () => Promise<void> }> = [
    {
        name: '1. a summarizer stream cut anywhere in a block and retried: whole summaries only, none twice, the retry one blank line after the marker',
        body: async () => {
            expect(
                [draftParagraphAt, gluedAnswerAt, firstAnswerEndAt, secondParagraphAt].every((at) => at > 0),
                'every named position exists in the block (sanity)'
            );
            const allowed = [
                GLUED_BLOCK.expected,
                `${GLUED_BLOCK.expected}\n\n${FIRST_UPDATE}`,
                `${GLUED_BLOCK.expected}\n\n${TWO_UPDATE_BLOCK.expected}`,
            ];
            const sweep = Array.from({ length: Math.floor(twoUpdateRaw.length / 113) }, (_unused, index) => (index + 1) * 113);
            const cuts: Array<{ readonly what: string; readonly at: number; readonly shown: string | null }> = [
                ...NAMED_CUTS,
                ...sweep.map((at) => ({ what: `at ${at}`, at, shown: null })),
            ];
            let lastAllowedIndex = -1;
            for (const cut of [...cuts].sort((left, right) => left.at - right.at)) {
                reset([
                    brokenThinking(`${GLUED_BLOCK.raw}${twoUpdateRaw.slice(0, cut.at)}`),
                    thinkingAnswer(`${QUOTING_BLOCK.raw}${DRAFT_BLOCK.raw}`, 'The answer.'),
                ]);
                const { chunks, error } = await runTurn();
                const label = `cut ${cut.what}`;

                expect(error === null && vertex.requests.length === 2, `${label}: retried once (got ${errorMessage(error)})`);
                expect(vertex.requests[0]?.rawBody === vertex.requests[1]?.rawBody, `${label}: the same request again`);
                const failedShown = thinkingBeforeFirstStatus(chunks);
                const allowedIndex = allowed.indexOf(failedShown);
                expect(allowedIndex !== -1, `${label}: the failed attempt shows whole summaries only (got ${json(failedShown.slice(GLUED_BLOCK.expected.length))})`);
                if (cut.shown !== null) {
                    expect(failedShown === cut.shown, `${label}: the failed attempt shows exactly what the block finished`);
                }
                expect(allowedIndex >= lastAllowedIndex, `${label}: a later cut never shows less`);
                lastAllowedIndex = allowedIndex;
                const shown = textOf(chunks, 'thinking');
                expect(
                    shown === `${failedShown}${shownMarker(1)}${RETRY_THINKING}`,
                    `${label}: the marker, then the retry's summaries one blank line after it (got ${json(shown.slice(failedShown.length, failedShown.length + 90))})`
                );
                expectNoScaffold(shown, label);
                expectEachSummaryOnce(shown, label);
                expect(textOf(chunks) === 'The answer.', `${label}: the retry answers`);
            }
        },
    },
    {
        name: '2a. the marker follows a summary the failed attempt showed, and comes right before the retry\'s first chunk',
        body: async () => {
            reset([
                brokenThinking(`${GLUED_BLOCK.raw}${UNANSWERED_BLOCK.raw.slice(0, 300)}`, 429, RATE_LIMITED),
                thinkingAnswer(`${QUOTING_BLOCK.raw}${DRAFT_BLOCK.raw}`, 'The answer.'),
            ]);
            const { chunks, error } = await runTurn();

            expect(error === null && json(platform.sleeps) === '[15000]', `one 15 s wait (got ${json(platform.sleeps)} / ${errorMessage(error)})`);
            const types = chunks.map((chunk) => chunk.type);
            const clearedAt = chunks.findIndex((chunk) => chunk.type === 'status' && chunk.status === undefined);
            const markerAt = chunks.findIndex((chunk) => (chunk.content ?? '').includes(markerLine(1)));
            expect(clearedAt > 0 && markerAt === clearedAt + 1, `the marker is the retry's first chunk once the stream opened (got ${json(types)})`);
            expect(chunks[markerAt + 1]?.type === 'thinking', 'and the retry\'s first summary follows it');
            expect(
                textOf(chunks, 'thinking') === `${GLUED_BLOCK.expected}${shownMarker(1)}${RETRY_THINKING}`,
                `the summary, the marker, the retry's summaries (got ${json(textOf(chunks, 'thinking'))})`
            );

            // A refused opening in between: the marker still waits for the attempt that streams
            reset([
                brokenThinking(`${GLUED_BLOCK.raw}${UNANSWERED_BLOCK.raw.slice(0, 300)}`, 429, RATE_LIMITED),
                httpErrorReply(429, RATE_LIMITED),
                thinkingAnswer(`${QUOTING_BLOCK.raw}${DRAFT_BLOCK.raw}`, 'The answer.'),
            ]);
            const refusedBetween = await runTurn();
            expect(
                refusedBetween.error === null && json(platform.sleeps) === '[15000,45000]',
                `three attempts (got ${json(platform.sleeps)} / ${errorMessage(refusedBetween.error)})`
            );
            expect(
                textOf(refusedBetween.chunks, 'thinking') === `${GLUED_BLOCK.expected}${shownMarker(1)}${RETRY_THINKING}`,
                `one marker, one blank line on each side (got ${json(textOf(refusedBetween.chunks, 'thinking'))})`
            );
        },
    },
    {
        name: '2b. no marker while the filter was still holding everything: a block cut in its scaffold, or a start not decided yet',
        body: async () => {
            for (const [label, failedThinking] of [
                ['a block cut in its scaffold', GLUED_BLOCK.raw.slice(0, Math.floor(GLUED_BLOCK.raw.length / 2))],
                ['a block cut before its answer', UNANSWERED_BLOCK.raw],
                ['the start of the scaffold, not decided yet', 'Thinking Process:\n\n'],
                ['blank space before the scaffold', '\n\n  '],
            ] as const) {
                reset([brokenThinking(failedThinking), thinkingAnswer(`${QUOTING_BLOCK.raw}${DRAFT_BLOCK.raw}`, 'The answer.')]);
                const { chunks, error } = await runTurn();

                expect(error === null && vertex.requests.length === 2, `${label}: retried (got ${errorMessage(error)})`);
                expect(thinkingBeforeFirstStatus(chunks) === '', `${label}: the failed attempt shows nothing (got ${json(thinkingBeforeFirstStatus(chunks))})`);
                expect(
                    textOf(chunks, 'thinking') === RETRY_THINKING,
                    `${label}: no marker, and the retry's first summary starts the thinking (got ${json(textOf(chunks, 'thinking').slice(0, 80))})`
                );
            }
        },
    },
    {
        name: '2c. a summary the break itself released counts as shown: the marker follows it',
        body: async () => {
            // The whole block arrived but no next block started: only the break releases it
            reset([brokenThinking(GLUED_BLOCK.raw), thinkingAnswer(`${QUOTING_BLOCK.raw}${DRAFT_BLOCK.raw}`, 'The answer.')]);
            const { chunks } = await runTurn();

            expect(
                thinkingBeforeFirstStatus(chunks) === GLUED_BLOCK.expected,
                `the break releases the finished block before the wait (got ${json(thinkingBeforeFirstStatus(chunks))})`
            );
            expect(
                textOf(chunks, 'thinking') === `${GLUED_BLOCK.expected}${shownMarker(1)}${RETRY_THINKING}`,
                `then the marker and the retry (got ${json(textOf(chunks, 'thinking'))})`
            );
        },
    },
    {
        name: '2d. a later round: the marker names it after a shown summary, and is left out when nothing showed; summaries stay one blank line apart',
        body: async () => {
            reset([
                thinkingCall(GLUED_BLOCK.raw, 'r1'),
                brokenThinking(twoUpdateRaw.slice(0, 900)),
                thinkingAnswer(QUOTING_BLOCK.raw, 'The answer.'),
            ]);
            const quiet = await runTurn();
            expect(quiet.error === null && vertex.requests.length === 3, `round 2 is retried (got ${errorMessage(quiet.error)})`);
            expect(
                textOf(quiet.chunks, 'thinking') === `${GLUED_BLOCK.expected}\n\n${QUOTING_BLOCK.expected}`,
                `no marker, one blank line between the rounds' summaries (got ${json(textOf(quiet.chunks, 'thinking'))})`
            );

            reset([
                thinkingCall(GLUED_BLOCK.raw, 'r1'),
                brokenThinking(`${twoUpdateRaw}${UNANSWERED_BLOCK.raw.slice(0, 300)}`),
                thinkingAnswer(QUOTING_BLOCK.raw, 'The answer.'),
            ]);
            const shown = await runTurn();
            expect(
                textOf(shown.chunks, 'thinking') ===
                    `${GLUED_BLOCK.expected}\n\n${TWO_UPDATE_BLOCK.expected}${shownMarker(2)}${QUOTING_BLOCK.expected}`,
                `round 2's summary, the marker of round 2, the retry (got ${json(textOf(shown.chunks, 'thinking'))})`
            );
            expectEachSummaryOnce(textOf(shown.chunks, 'thinking'), 'later round');
            // The retry's only block is held until its round ends, so its answer text is the first visible chunk
            const markerAt = shown.chunks.findIndex((chunk) => (chunk.content ?? '').includes(markerLine(2)));
            expect(
                json(shown.chunks.slice(markerAt + 1, markerAt + 3).map((chunk) => chunk.type)) === '["text","thinking"]',
                `the marker goes out before the answer, the summary after it (got ${json(shown.chunks.map((chunk) => chunk.type))})`
            );
        },
    },
    {
        name: '3a. a stop in the middle of a block: what shows and what the checkpoint keeps is clean',
        body: async () => {
            const controller = new AbortController();
            const draftCut = DRAFT_BLOCK.raw.indexOf('    I am now looking into') + 30;
            reset([
                thinkingCall(GLUED_BLOCK.raw, 'r1'),
                // The second read ends one block and stops inside the next one's draft paragraph
                stalledStreamReply([
                    event([thoughtPart(twoUpdateRaw.slice(0, 1_000))]),
                    event([thoughtPart(`${twoUpdateRaw.slice(1_000)}${DRAFT_BLOCK.raw.slice(0, draftCut)}`)]),
                ]),
                answer('never sent'),
            ]);
            const turn = await runTurn({
                signal: controller.signal,
                // The stop lands once round 2 showed its summary; this consumer reads on to the end
                onChunk: (chunk) => {
                    if ((chunk.content ?? '').includes('**Formulating the final witty response**')) controller.abort();
                },
            });

            expect(turn.error !== null && vertex.requests.length === 2, `the stop ends the reply (got ${vertex.requests.length})`);
            expect(platform.sleeps.length === 0, 'with no wait');
            const shown = textOf(turn.chunks, 'thinking');
            expect(
                shown === `${GLUED_BLOCK.expected}\n\n${TWO_UPDATE_BLOCK.expected}`,
                `the cut draft never shows (got ${json(shown.slice(GLUED_BLOCK.expected.length))})`
            );
            expectNoScaffold(shown, 'stop');
            const kept = lastCheckpoint(turn);
            expect(
                kept.completedRounds === 1 && textOf(kept.journal, 'thinking') === GLUED_BLOCK.expected,
                `the checkpoint keeps round 1's summary only (got ${json(textOf(kept.journal, 'thinking'))})`
            );
        },
    },
    {
        name: '3b. an error that ends the reply in the middle of a block: what shows and what the checkpoint keeps is clean',
        body: async () => {
            const draftCut = DRAFT_BLOCK.raw.indexOf('    I am now looking into') + 30;
            const midDraft = `${twoUpdateRaw}${DRAFT_BLOCK.raw.slice(0, draftCut)}`;
            const variants: ReadonlyArray<{
                readonly label: string;
                readonly round1: ScriptedReply;
                readonly failing: ScriptedReply;
                readonly maxRetries: number;
                readonly status: number;
                readonly shown: string;
                readonly kept: string;
            }> = [
                {
                    label: 'a 400 in the stream',
                    round1: thinkingCall(GLUED_BLOCK.raw, 'r1'),
                    failing: brokenThinking(midDraft, 400, BAD_REQUEST),
                    maxRetries: 3,
                    status: 400,
                    shown: `${GLUED_BLOCK.expected}\n\n${TWO_UPDATE_BLOCK.expected}`,
                    kept: GLUED_BLOCK.expected,
                },
                {
                    label: 'a 500 with one attempt only',
                    round1: thinkingCall(GLUED_BLOCK.raw, 'r1'),
                    failing: brokenThinking(midDraft, 500, INTERNAL),
                    maxRetries: 1,
                    status: 500,
                    shown: `${GLUED_BLOCK.expected}\n\n${TWO_UPDATE_BLOCK.expected}`,
                    kept: GLUED_BLOCK.expected,
                },
                {
                    // Round 1 had no thinking: round 2's start is still undecided when it breaks
                    label: 'the start of the scaffold, not decided yet',
                    round1: silentCall('r1'),
                    failing: brokenThinking('Thinking Process:\n\n', 500, INTERNAL),
                    maxRetries: 1,
                    status: 500,
                    shown: '',
                    kept: '',
                },
            ];
            for (const { label, round1, failing, maxRetries, status, shown, kept } of variants) {
                reset([round1, failing, answer('never sent')]);
                const turn = await runTurn({ maxRetries });

                expect(
                    asRecord(turn.error).status === status && vertex.requests.length === 2,
                    `${label}: the error ends the reply (got ${errorMessage(turn.error)})`
                );
                const shownThinking = textOf(turn.chunks, 'thinking');
                expect(shownThinking === shown, `${label}: whole summaries only (got ${json(shownThinking.slice(GLUED_BLOCK.expected.length))})`);
                expectNoScaffold(shownThinking, label);
                expect(textOf(lastCheckpoint(turn).journal, 'thinking') === kept, `${label}: the checkpoint keeps round 1's thinking only`);
            }
        },
    },
    {
        name: '4. pass-through thinking on every recovery path: the same chunks as before the filter',
        body: async () => {
            // gemini-round-recovery.mts case 1
            reset([
                midStreamErrorReply([event([thoughtPart('first thoughts')])], 429, RATE_LIMITED),
                sseReply(roundEvents([[thoughtPart('second thoughts')], [textPart('The answer.')], [signedEmptyText('a1')]])),
            ]);
            const marked = await runTurn();
            expect(
                json(withoutDone(marked.chunks)) ===
                    json([
                        thinkingChunk('first thoughts'),
                        statusChunk('⟳ 第 1 轮被限流（429），15 秒后第 2 次尝试'),
                        statusChunk('⟳ 第 1 轮重试中（第 2 次尝试）'),
                        CLEARED_STATUS,
                        thinkingChunk(shownMarker(1)),
                        thinkingChunk('second thoughts'),
                        textChunk('The answer.'),
                    ]),
                `a break after thinking (got ${json(withoutDone(marked.chunks))})`
            );

            // gemini-round-recovery.mts case 2, the quiet break
            reset([midStreamErrorReply([event([signedEmptyText('quiet')])], 500, INTERNAL), answer('After a quiet break.')]);
            const quiet = await runTurn();
            expect(
                json(withoutDone(quiet.chunks)) ===
                    json([
                        statusChunk('⟳ 第 1 轮服务端出错（5xx），5 秒后第 2 次尝试'),
                        statusChunk('⟳ 第 1 轮重试中（第 2 次尝试）'),
                        CLEARED_STATUS,
                        thinkingChunk('thinking before After a quiet break.'),
                        textChunk('After a quiet break.'),
                    ]),
                `a break that showed nothing (got ${json(withoutDone(quiet.chunks))})`
            );

            // gemini-round-recovery.mts case 5, the mixed ladder
            reset([
                midStreamErrorReply([event([thoughtPart('before the break')])], 429, RATE_LIMITED),
                httpErrorReply(429, RATE_LIMITED),
                answer('Third time.'),
            ]);
            const mixed = await runTurn();
            expect(
                json(withoutDone(mixed.chunks)) ===
                    json([
                        thinkingChunk('before the break'),
                        statusChunk('⟳ 第 1 轮被限流（429），15 秒后第 2 次尝试'),
                        statusChunk('⟳ 第 1 轮重试中（第 2 次尝试）'),
                        statusChunk('⟳ 第 1 轮被限流（429），45 秒后第 3 次尝试'),
                        statusChunk('⟳ 第 1 轮重试中（第 3 次尝试）'),
                        CLEARED_STATUS,
                        thinkingChunk(shownMarker(1)),
                        thinkingChunk('thinking before Third time.'),
                        textChunk('Third time.'),
                    ]),
                `a break, then a refused opening (got ${json(withoutDone(mixed.chunks))})`
            );

            // gemini-round-recovery.mts case 3, a later round
            reset([
                sseReply(roundEvents([[thoughtPart('plan r1')], [callPart('lookup_a', { topic: 'falcon' }, 'r1', 'call_r1'), textPart('')]])),
                midStreamErrorReply([event([thoughtPart('round 2 thinking')])], 500, INTERNAL),
                answer('The code word is AZALEA-42.'),
            ]);
            const later = await runTurn();
            expect(
                json(thinkingContents(later.chunks)) ===
                    json(['plan r1', 'round 2 thinking', shownMarker(2), 'thinking before The code word is AZALEA-42.']),
                `a later round, chunk for chunk (got ${json(thinkingContents(later.chunks))})`
            );

            // Every part is its own chunk at once: nothing is held back, on either attempt
            const firstThoughts = '**Planning the lookup**\n\nI am checking the source first.';
            const secondThoughts = 'second thoughts, one character at a time';
            reset([
                midStreamErrorReply(piecesOf(firstThoughts, 1).map((piece) => event([thoughtPart(piece)])), 500, INTERNAL),
                sseReply([...piecesOf(secondThoughts, 1).map((piece) => event([thoughtPart(piece)])), event([textPart('Done.')], { finishReason: 'STOP' })]),
            ]);
            const perCharacter = await runTurn();
            expect(
                json(withoutDone(perCharacter.chunks)) ===
                    json([
                        ...piecesOf(firstThoughts, 1).map(thinkingChunk),
                        statusChunk('⟳ 第 1 轮服务端出错（5xx），5 秒后第 2 次尝试'),
                        statusChunk('⟳ 第 1 轮重试中（第 2 次尝试）'),
                        CLEARED_STATUS,
                        thinkingChunk(shownMarker(1)),
                        ...piecesOf(secondThoughts, 1).map(thinkingChunk),
                        textChunk('Done.'),
                    ]),
                `one chunk per part, no buffering (got ${json(thinkingContents(perCharacter.chunks).slice(0, 8))}…)`
            );

            // A break that ends the reply, and the log line pass-through never writes
            reset([midStreamErrorReply([event([thoughtPart('x')])], 500, INTERNAL), answer('never sent')]);
            const single = await runTurn({ maxRetries: 1 });
            expect(
                asRecord(single.error).status === 500 && json(withoutDone(single.chunks)) === json([thinkingChunk('x')]),
                `one attempt: the thinking as it came, then the error (got ${json(single.chunks)})`
            );
            for (const turn of [marked, quiet, mixed, later, perCharacter, single]) {
                expect(thoughtSummaryLineOf(turn.lines) === '', 'a pass-through reply writes no filter line');
            }
        },
    },
    {
        name: '5a. a checkpoint says what the filter decided: filtering with or without a summary out, pass-through, undecided',
        body: async () => {
            const filtering = await checkpointAfter(thinkingCall(GLUED_BLOCK.raw, 'r1'));
            expect(
                json(stateOf(filtering).thoughtSummary) === json({ mode: 'filtering', emitted: true }),
                `a summarizer round with a summary out (got ${json(stateOf(filtering).thoughtSummary)})`
            );
            expect(
                json(filtering.journal.filter((chunk) => chunk.type === 'thinking')) === json([thinkingChunk(GLUED_BLOCK.expected)]),
                `its journal holds the summary, never the scaffold (got ${json(textOf(filtering.journal, 'thinking').slice(0, 80))})`
            );

            const dropped = await checkpointAfter(thinkingCall(UNANSWERED_BLOCK.raw, 'r1'));
            expect(
                json(stateOf(dropped).thoughtSummary) === json({ mode: 'filtering', emitted: false }) &&
                    textOf(dropped.journal, 'thinking') === '',
                `a summarizer round whose block was dropped (got ${json(stateOf(dropped).thoughtSummary)})`
            );

            const passthrough = await checkpointAfter(thinkingCall('plan r1', 'r1'));
            expect(
                json(stateOf(passthrough).thoughtSummary) === json({ mode: 'passthrough', emitted: false }) &&
                    textOf(passthrough.journal, 'thinking') === 'plan r1',
                `a pass-through round (got ${json(stateOf(passthrough).thoughtSummary)})`
            );

            const undecided = await checkpointAfter(silentCall('r1'));
            expect(
                json(stateOf(undecided).thoughtSummary) === json({ mode: 'detecting', emitted: false }),
                `a round without thinking (got ${json(stateOf(undecided).thoughtSummary)})`
            );
        },
    },
    {
        name: '5b. a resume filters from its first chunk and puts exactly one blank line after the replayed summary',
        body: async () => {
            const checkpoint = await checkpointAfter(thinkingCall(GLUED_BLOCK.raw, 'r1'));

            reset([thinkingAnswer(twoUpdateRaw, 'Resumed answer.')]);
            const resumed = await runTurn({ resumeFrom: checkpoint });
            expect(resumed.error === null, `the resume finishes (got ${errorMessage(resumed.error)})`);
            expect(
                textOf(resumed.chunks, 'thinking') === `${GLUED_BLOCK.expected}\n\n${TWO_UPDATE_BLOCK.expected}`,
                `the replayed summary, one blank line, the next one (got ${json(textOf(resumed.chunks, 'thinking'))})`
            );
            expect(
                json(thinkingContents(fresh(resumed.chunks))) === json([`\n\n${TWO_UPDATE_BLOCK.expected}`]),
                `the resumed round shows its block once it is finished (got ${json(thinkingContents(fresh(resumed.chunks)))})`
            );

            // A fresh filter would pass this stream through: it does not open with the scaffold
            const opening = '**Checking the second source**\n\nI am comparing both lookups before I answer.';
            reset([thinkingAnswer(`${opening}\n\n${twoUpdateRaw}`, 'Resumed answer.', 50)]);
            const restored = await runTurn({ resumeFrom: checkpoint });
            const shown = textOf(restored.chunks, 'thinking');
            expect(
                shown === `${GLUED_BLOCK.expected}\n\n${opening}\n\n${TWO_UPDATE_BLOCK.expected}`,
                `the restored filter keeps filtering from the first chunk (got ${json(shown.slice(GLUED_BLOCK.expected.length, GLUED_BLOCK.expected.length + 160))})`
            );
            expectNoScaffold(shown, 'restored filter');
        },
    },
    {
        name: '5c. a pass-through reply resumes as pass-through; a checkpoint before any thinking decides on the resumed stream',
        body: async () => {
            const passthrough = await checkpointAfter(thinkingCall('plan r1', 'r1'));
            reset([thinkingAnswer(GLUED_BLOCK.raw, 'Resumed answer.')]);
            const resumedPassthrough = await runTurn({ resumeFrom: passthrough });
            expect(
                json(thinkingContents(fresh(resumedPassthrough.chunks))) === json(piecesOf(GLUED_BLOCK.raw, 400)),
                'the decision holds: the resumed stream passes through, part by part'
            );
            expect(thoughtSummaryLineOf(resumedPassthrough.lines) === '', 'and no filter line is written');

            const undecided = await checkpointAfter(silentCall('r1'));
            reset([thinkingAnswer(GLUED_BLOCK.raw, 'Resumed answer.')]);
            const decidedFiltering = await runTurn({ resumeFrom: undecided });
            expect(
                json(thinkingContents(decidedFiltering.chunks)) === json([GLUED_BLOCK.expected]),
                `undecided, then a summarizer stream: filtered, nothing before the first summary (got ${json(thinkingContents(decidedFiltering.chunks))})`
            );
            expect(thoughtSummaryLineOf(decidedFiltering.lines) !== '', 'and the filter line is written');

            reset([thinkingAnswer('plan r2', 'Resumed answer.')]);
            const decidedPassthrough = await runTurn({ resumeFrom: undecided });
            expect(
                json(thinkingContents(decidedPassthrough.chunks)) === json(['plan r2']) &&
                    thoughtSummaryLineOf(decidedPassthrough.lines) === '',
                `undecided, then other thinking: passed through (got ${json(thinkingContents(decidedPassthrough.chunks))})`
            );
        },
    },
    {
        name: '5d. the journal is filtered thinking only, and the replay is not filtered a second time',
        body: async () => {
            const checkpoint = await checkpointAfter(thinkingCall(GLUED_BLOCK.raw, 'r1'));
            expectNoScaffold(textOf(checkpoint.journal, 'thinking'), 'journal');

            reset([thinkingAnswer(twoUpdateRaw, 'Resumed answer.')]);
            const resumed = await runTurn({ resumeFrom: checkpoint });
            expect(
                json(replayed(resumed.chunks)) === json(checkpoint.journal.map((chunk) => ({ ...chunk, replay: true }))),
                `the replay is the journal chunk for chunk (got ${json(replayed(resumed.chunks))})`
            );

            // A journal the filter would change: the replay still shows it as it is
            const scaffoldJournal: StreamChunk[] = [thinkingChunk(UNANSWERED_BLOCK.raw), thinkingChunk(GLUED_BLOCK.raw)];
            reset([thinkingAnswer(twoUpdateRaw, 'Resumed answer.')]);
            const replayedAsIs = await runTurn({ resumeFrom: { ...checkpoint, journal: scaffoldJournal } });
            expect(
                json(thinkingContents(replayed(replayedAsIs.chunks))) === json([UNANSWERED_BLOCK.raw, GLUED_BLOCK.raw]),
                'the replay never goes through the filter'
            );
            expect(
                thoughtSummaryLineOf(replayedAsIs.lines).includes(` raw=${twoUpdateRaw.length} `),
                `and the filter never saw it (got ${json(thoughtSummaryLineOf(replayedAsIs.lines))})`
            );
        },
    },
    {
        name: '5e. a checkpoint whose filter state is malformed is refused before anything is sent',
        body: async () => {
            const checkpoint = await checkpointAfter(thinkingCall(GLUED_BLOCK.raw, 'r1'));
            const state = asRecord(checkpoint.state);
            const withoutFilter = Object.fromEntries(Object.entries(state).filter(([key]) => key !== 'thoughtSummary'));
            const variants: Array<[string, unknown]> = [
                ['no filter state', withoutFilter],
                ['a null filter state', { ...state, thoughtSummary: null }],
                ['an unknown mode', { ...state, thoughtSummary: { mode: 'summarizing', emitted: true } }],
                ['emitted not a boolean', { ...state, thoughtSummary: { mode: 'filtering', emitted: 'yes' } }],
                ['emitted missing', { ...state, thoughtSummary: { mode: 'filtering' } }],
            ];
            for (const [label, malformed] of variants) {
                reset([answer('never sent')]);
                const refused = await runTurn({ resumeFrom: { ...checkpoint, state: malformed } });
                expect(
                    errorMessage(refused.error).includes('does not hold a Gemini tool loop state'),
                    `${label}: refused (got ${errorMessage(refused.error)})`
                );
                expect(refused.chunks.length === 0 && vertex.requests.length === 0, `${label}: nothing yielded, nothing sent`);
            }
        },
    },
    {
        name: '6. the filter line of a resumed reply counts the resumed rounds only',
        body: async () => {
            const checkpoint = await checkpointAfter(thinkingCall(GLUED_BLOCK.raw, 'r1'));

            reset([thinkingAnswer(twoUpdateRaw, 'Resumed answer.')]);
            const resumed = await runTurn({ resumeFrom: checkpoint });
            expect(
                thoughtSummaryLineOf(resumed.lines) ===
                    `[gemini] ${MODEL} thought summaries filtered raw=${twoUpdateRaw.length} ` +
                        `clean=${TWO_UPDATE_BLOCK.expected.length} blocks=1 summaries=2 dropped=0`,
                `round 1's block is not counted again (got ${json(thoughtSummaryLineOf(resumed.lines))})`
            );

            reset([sseReply([event([textPart('No thinking this time.')], { finishReason: 'STOP' })])]);
            const quiet = await runTurn({ resumeFrom: checkpoint });
            expect(
                thoughtSummaryLineOf(quiet.lines) ===
                    `[gemini] ${MODEL} thought summaries filtered raw=0 clean=0 blocks=0 summaries=0 dropped=0`,
                `a resumed round without thinking claims nothing (got ${json(thoughtSummaryLineOf(quiet.lines))})`
            );
        },
    },
    {
        name: '7. flushBroken at the filter itself: finished summaries only, undecided text dropped, nothing held after it',
        body: async () => {
            await withMutedWarnings(async () => {
                const midAnswer = `${GLUED_BLOCK.raw}${twoUpdateRaw.slice(0, secondParagraphAt + 30)}`;

                // A stream that ends (flush) keeps every candidate; one that broke keeps finished ones only
                const ended = createThoughtSummaryFilter();
                const endedPushed = ended.push(midAnswer);
                const endedTail = ended.flush();
                expect(endedPushed === GLUED_BLOCK.expected, 'the first block is released once the second starts');
                expect(endedTail.includes('I am wrapping up my reaso'), `flush still releases the last candidate as it is (got ${json(endedTail)})`);

                const broken = createThoughtSummaryFilter();
                expect(broken.push(midAnswer) === GLUED_BLOCK.expected, 'the same push releases the same block');
                expect(broken.flushBroken() === `\n\n${FIRST_UPDATE}`, 'flushBroken keeps the finished update only, one blank line on');
                expect(broken.flush() === '' && broken.flushBroken() === '', 'nothing is held afterwards');
                expect(
                    json(broken.stats()) ===
                        json({
                            detected: true,
                            rawChars: midAnswer.length,
                            cleanChars: GLUED_BLOCK.expected.length + FIRST_UPDATE.length,
                            blocks: 2,
                            summaries: 2,
                            dropped: 0,
                        }),
                    `the cut block counts as a block (got ${json(broken.stats())})`
                );
                expect(json(broken.state()) === json({ mode: 'filtering', emitted: true }), 'the decision and the separator stay');

                const cutInScaffold = createThoughtSummaryFilter();
                cutInScaffold.push(`${GLUED_BLOCK.raw}Thinking Process:\n\n1.  **Analyze`);
                expect(cutInScaffold.flushBroken() === '', 'a block cut in its scaffold gives nothing');
                expect(
                    cutInScaffold.stats().blocks === 2 && cutInScaffold.stats().dropped === 1,
                    `and counts as dropped (got ${json(cutInScaffold.stats())})`
                );

                const undecided = createThoughtSummaryFilter();
                expect(undecided.push('Thinking Process:\n\n') === '', 'a start that is not decided yet is held');
                expect(undecided.flushBroken() === '', 'flushBroken drops it');
                expect(json(undecided.state()) === json({ mode: 'detecting', emitted: false }), 'and the next stream decides');
                expect(undecided.push(GLUED_BLOCK.raw) === '' && undecided.flush() === GLUED_BLOCK.expected, 'the next stream is recognised from its start');

                const passthrough = createThoughtSummaryFilter();
                expect(passthrough.push('plan') === 'plan' && passthrough.flushBroken() === '', 'pass-through holds nothing to drop');
                expect(json(passthrough.state()) === json({ mode: 'passthrough', emitted: false }), 'and stays pass-through');

                const resumed = createThoughtSummaryFilter({ mode: 'filtering', emitted: true });
                resumed.push(twoUpdateRaw.slice(0, firstAnswerEndAt));
                expect(resumed.flushBroken() === `\n\n${FIRST_UPDATE}`, 'a restored filter separates its first summary too');
            });
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
reportResults(results);
