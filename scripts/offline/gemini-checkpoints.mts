/**
 * Offline cases for the checkpoints the Gemini client tool loop hands out
 * (design 2026-1112-1123 §6.2; test plan §11 第 3 期 case 1, and the value
 * rules of a checkpoint).
 *
 * The platform runs a real Vertex-mode SDK client over a fake fetch
 * (support/fake-vertex.mts); its sleeps return at once. Each case collects
 * every checkpoint handed to `checkpointSink`, with a deep copy taken at the
 * hand-over, and reads the Gemini state inside through the platform's own
 * type guard.
 *
 * Run: npx tsx scripts/offline/gemini-checkpoints.mts
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import { createFakeVertex, midStreamErrorReply, sseReply, stalledStreamReply, type ScriptedReply } from './support/fake-vertex.mts';
import {
    answer,
    asArray,
    asRecord,
    callPart,
    callsRound,
    consumeReply,
    errorMessage,
    event,
    frozenCopyOf,
    json,
    nonPlainPaths,
    statusTexts,
    textOf,
    textPart,
    thoughtPart,
    withFakeClock,
    type ConsumeOptions,
    type ConsumedReply,
} from './support/gemini-loop-fixtures.mts';
import type { StreamChunk, UnifiedMessage } from '../../src/ai/types.js';
import type { ToolHandler, ToolResult, TurnTools } from '../../src/ai/tools/index.js';
import type { ToolLoopCheckpoint } from '../../src/ai/tools/tool-loop-checkpoint.js';

// Gemini client tools on, whatever the shell says (read lazily by the platform)
delete process.env.GEMINI_CLIENT_TOOLS;

const { GeminiPlatform } = await import('../../src/ai/platforms/gemini-platform.js');
const { createTurnTools, TOOL_LOOP_DEADLINE_MS } = await import('../../src/ai/tools/index.js');
const { isGeminiCheckpointState } = await import('../../src/ai/platforms/gemini/gemini-checkpoint.js');
const { FUNCTION_CALLING_OFF_ERROR, INTERRUPTED_CALL_ERROR, LAST_TOOL_ROUND_NOTICE } = await import(
    '../../src/ai/platforms/gemini/gemini-round-contents.js'
);

type GeminiCheckpointState = import('../../src/ai/platforms/gemini/gemini-checkpoint.js').GeminiCheckpointState;
type GeminiLoopState = import('../../src/ai/platforms/gemini/gemini-loop-state.js').GeminiLoopState;

const vertex = createFakeVertex();

/** Every wait returns at once */
class InstantGeminiPlatform extends GeminiPlatform {
    protected override sleep(_ms: number, signal?: AbortSignal): Promise<void> {
        return signal?.aborted ? Promise.reject(new Error('Aborted')) : Promise.resolve();
    }
}

const platform = new InstantGeminiPlatform({ client: vertex.client, random: () => 0.5 });

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const executions: string[] = [];
/** Runs inside a tool, after it was recorded (e.g. to move the fake clock) */
let duringTool: ((name: string) => void) | null = null;

const objectSchema = { type: 'object', properties: { topic: { type: 'string' } } };

const PICTURE = Buffer.from('a picture lookup_b found');

const tool = (name: string, result: ToolResult): ToolHandler => ({
    definition: { name, description: `The ${name} tool`, inputSchema: objectSchema },
    execute: async () => {
        executions.push(name);
        duringTool?.(name);
        return result;
    },
});

const lookupA = tool('lookup_a', {
    content: 'key is K-7731',
    isError: false,
    images: [],
    record: { provider: 'mcp', searchQueries: ['lookup_a K-7731'] },
});
const lookupB = tool('lookup_b', {
    content: 'code word is AZALEA-42',
    isError: false,
    images: [{ data: PICTURE, mimeType: 'image/png', caption: 'found picture' }],
    record: null,
});
const sendFile = tool('send_file', { content: 'file sent', isError: false, images: [], record: null });

const turnTools = createTurnTools([lookupA, lookupB]);
const turnToolsWithFree = createTurnTools([lookupA, lookupB, sendFile]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface HandedOver {
    readonly checkpoint: ToolLoopCheckpoint;
    /** A deep copy taken at the hand-over */
    readonly frozen: string;
}

const reset = (replies: readonly ScriptedReply[]): void => {
    vertex.reset(replies);
    executions.length = 0;
    duringTool = null;
};

const userTurn: UnifiedMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'What is the code word?' }] }];

interface TurnOptions extends ConsumeOptions {
    readonly tools?: TurnTools;
    readonly signal?: AbortSignal;
    /** false: no checkpointSink at all */
    readonly collect?: boolean;
}

interface TurnResult extends ConsumedReply {
    readonly handedOver: HandedOver[];
}

const runTurn = async (options: TurnOptions = {}): Promise<TurnResult> => {
    const handedOver: HandedOver[] = [];
    const consumed = await consumeReply(
        () =>
            platform.sendMessage(userTurn, {
                model: 'gemini-3.8-flash',
                systemPrompt: 'offline system prompt',
                maxRetries: 3,
                tools: options.tools ?? turnTools,
                ...(options.signal ? { signal: options.signal } : {}),
                ...(options.collect === false
                    ? {}
                    : {
                          checkpointSink: (checkpoint: ToolLoopCheckpoint) => {
                              handedOver.push({ checkpoint, frozen: frozenCopyOf(checkpoint) });
                          },
                      }),
            }),
        options
    );
    return { ...consumed, handedOver };
};

const stateOf = (checkpoint: ToolLoopCheckpoint | undefined): GeminiCheckpointState => {
    const state = checkpoint?.state;
    if (!isGeminiCheckpointState(state)) throw new Error(`not a Gemini checkpoint state: ${json(state)}`);
    return state;
};

const loopOf = (checkpoint: ToolLoopCheckpoint | undefined): GeminiLoopState => stateOf(checkpoint).loop;

interface Answer {
    readonly name: string;
    readonly output?: string;
    readonly error?: string;
    readonly notice?: string;
}

/** The function responses of a kept round */
const answersOf = (loop: GeminiLoopState, roundIndex: number): Answer[] =>
    (loop.toolRounds[roundIndex]?.responseParts ?? []).map((part) => {
        const response = asRecord(part.functionResponse?.response);
        return {
            name: part.functionResponse?.name ?? '',
            ...(typeof response.output === 'string' ? { output: response.output } : {}),
            ...(typeof response.error === 'string' ? { error: response.error } : {}),
            ...(typeof response.notice === 'string' ? { notice: response.notice } : {}),
        };
    });

const isModeNone = (index: number): boolean =>
    asRecord(asRecord(vertex.requests[index]?.body.toolConfig).functionCallingConfig).mode === 'NONE';

/** Keys sorted: the SDK may write the same object with another key order */
const canonical = (value: unknown): string =>
    JSON.stringify(value, (_key, nested: unknown) =>
        typeof nested === 'object' && nested !== null && !Array.isArray(nested)
            ? Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)))
            : nested
    );

const journalTypes = (checkpoint: ToolLoopCheckpoint | undefined): string[] =>
    (checkpoint?.journal ?? []).map((chunk) => chunk.type);

const summaryOf = (handedOver: readonly HandedOver[]): string =>
    json(
        handedOver.map(({ checkpoint }) => ({
            rounds: checkpoint.completedRounds,
            usage: checkpoint.toolUsage,
            journal: journalTypes(checkpoint),
        }))
    );

/** Every checkpoint: unchanged since the hand-over, plain data, no status and no replay in its journal */
const expectValues = (handedOver: readonly HandedOver[], label: string): void => {
    handedOver.forEach(({ checkpoint, frozen }, index) => {
        expect(frozenCopyOf(checkpoint) === frozen, `${label}: checkpoint ${index} is unchanged since it was handed over`);
        const paths = nonPlainPaths(checkpoint);
        expect(paths.length === 0, `${label}: checkpoint ${index} is plain data (got ${json(paths)})`);
        expect(
            checkpoint.journal.every((chunk) => chunk.type !== 'status' && chunk.replay === undefined),
            `${label}: checkpoint ${index}'s journal has no status line and no replay flag`
        );
    });
};

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const cases: Array<{ name: string; body: () => Promise<void> }> = [
    {
        name: '1a. a normal tool round: before its calls, after each call, and once the next request is worked out',
        body: async () => {
            reset([callsRound('r1', [{ name: 'lookup_a' }, { name: 'lookup_b' }]), answer('The code word is AZALEA-42.')]);

            const { error, handedOver, chunks } = await runTurn();

            expect(error === null, `the reply finishes (got ${errorMessage(error)})`);
            expect(handedOver.length === 4, `four checkpoints (got ${summaryOf(handedOver)})`);
            const [beforeCalls, afterFirst, afterSecond, nextRound] = handedOver.map((item) => item.checkpoint);
            expect(
                handedOver.every(({ checkpoint }) => checkpoint.platform === 'gemini' && checkpoint.completedRounds === 1),
                'every one keeps round 1; the next round is 2'
            );

            // Moment 2: the stream completed, no call ran yet
            const before = loopOf(beforeCalls);
            expect(before.roundNumber === 2 && before.executedCallCount === 0, 'before the calls: round 2 next, no call counted');
            expect(
                json(answersOf(before, 0)) ===
                    json([
                        { name: 'lookup_a', error: INTERRUPTED_CALL_ERROR },
                        { name: 'lookup_b', error: INTERRUPTED_CALL_ERROR },
                    ]),
                `before the calls: both answered as interrupted (got ${json(answersOf(before, 0))})`
            );
            expect(json(beforeCalls?.toolUsage) === '[]', 'before the calls: no tool usage');
            expect(json(journalTypes(beforeCalls)) === '["thinking"]', `before the calls: the round's thinking only (got ${json(journalTypes(beforeCalls))})`);

            // Moment 3: after each call, its products included before they are yielded
            const first = loopOf(afterFirst);
            const firstAnswers = answersOf(first, 0);
            expect(
                firstAnswers[0]?.output?.startsWith('key is K-7731\n\n[工具轮次] 本次回复已调用工具 1 次。') === true &&
                    firstAnswers[1]?.error === INTERRUPTED_CALL_ERROR,
                `after lookup_a: its real result counted once, lookup_b interrupted (got ${json(firstAnswers)})`
            );
            expect(json(afterFirst?.toolUsage) === json([{ name: 'lookup_a', count: 1 }]), 'after lookup_a: its usage');
            expect(
                json(journalTypes(afterFirst)) === '["thinking","grounding"]' &&
                    json(afterFirst?.journal[1]?.groundingMetadata?.searchQueries) === '["lookup_a K-7731"]',
                `after lookup_a: its record is in the journal (got ${json(journalTypes(afterFirst))})`
            );
            const second = loopOf(afterSecond);
            expect(
                answersOf(second, 0).every((item) => item.output?.includes('本次回复已调用工具 2 次') === true) &&
                    second.executedCallCount === 2,
                `after lookup_b: both real, two calls (got ${json(answersOf(second, 0))})`
            );
            expect(
                json(journalTypes(afterSecond)) === '["thinking","grounding","image"]' &&
                    afterSecond?.journal[2]?.imageData === PICTURE,
                'after lookup_b: its picture, the same Buffer'
            );

            // Moment 1: the next request, as it was then sent
            const next = loopOf(nextRound);
            expect(
                canonical(next.request.contents) === canonical(vertex.requests[1]?.body.contents),
                'the last checkpoint holds the very contents round 2 was sent with'
            );
            expect(next.request.final === false && next.toolRounds.length === 1, 'not final, one kept round');
            expect(json(journalTypes(nextRound)) === json(journalTypes(afterSecond)), 'the same journal as after the last call');
            expect(
                chunks.some((chunk) => chunk.type === 'status') && textOf(chunks) === 'The code word is AZALEA-42.',
                'the reply itself streamed as usual'
            );
            expectValues(handedOver, '1a');
        },
    },
    {
        name: '1b. a failed call: the next round is final, nothing kept besides the count',
        body: async () => {
            reset([sseReply([event([textPart('Trying.')], { finishReason: 'MALFORMED_FUNCTION_CALL' })]), answer('Plain answer.')]);

            const { error, handedOver } = await runTurn();

            expect(error === null && vertex.requests.length === 2, `two requests (got ${vertex.requests.length})`);
            expect(handedOver.length === 1, `one checkpoint (got ${summaryOf(handedOver)})`);
            const loop = loopOf(handedOver[0]?.checkpoint);
            expect(
                handedOver[0]?.checkpoint.completedRounds === 1 && loop.request.final && loop.toolRounds.length === 0,
                'round 2 is the final one, built on round 1 alone'
            );
            expect(isModeNone(1), 'and it was sent with function calling off');
            expect(json(journalTypes(handedOver[0]?.checkpoint)) === '["text"]', 'the text it showed is journaled');
            expectValues(handedOver, '1b');
        },
    },
    {
        name: '1c. the budget runs out in a call: the final round, then a final round that still called',
        body: async () => {
            await withFakeClock(async (jump) => {
                reset([
                    callsRound('r1', [{ name: 'lookup_a' }]),
                    callsRound('r2', [{ name: 'lookup_b' }], { text: 'Let me check once more.' }),
                    answer('Final answer.'),
                ]);
                duringTool = () => {
                    duringTool = null;
                    jump(TOOL_LOOP_DEADLINE_MS + 1_000);
                };

                const { error, handedOver } = await runTurn();

                expect(error === null && vertex.requests.length === 3, `three requests (got ${vertex.requests.length})`);
                expect(json(executions) === '["lookup_a"]', `the final round's call never ran (got ${json(executions)})`);
                expect(handedOver.length === 4, `four checkpoints (got ${summaryOf(handedOver)})`);
                const afterCall = loopOf(handedOver[1]?.checkpoint);
                expect(
                    afterCall.request.final && answersOf(afterCall, 0)[0]?.notice === LAST_TOOL_ROUND_NOTICE,
                    'after the call that used the budget up: the next round is final and the answer says so'
                );
                const nextRound = loopOf(handedOver[2]?.checkpoint);
                expect(
                    nextRound.request.final && nextRound.toolTimeMs >= TOOL_LOOP_DEADLINE_MS && nextRound.mayAskAgain,
                    'the round-1 checkpoint: final next, the tool time spent, may still ask again'
                );
                const finalCalls = handedOver[3]?.checkpoint;
                const finalLoop = loopOf(finalCalls);
                expect(
                    finalCalls?.completedRounds === 2 && finalLoop.request.final && !finalLoop.mayAskAgain,
                    'after the final round that called: round 3 is final and there is no further extra round'
                );
                expect(
                    json(answersOf(finalLoop, 1)) === json([{ name: 'lookup_b', error: FUNCTION_CALLING_OFF_ERROR }]),
                    `its call is answered as not run (got ${json(answersOf(finalLoop, 1))})`
                );
                expect(
                    canonical(finalLoop.request.contents) === canonical(vertex.requests[2]?.body.contents) && isModeNone(2),
                    'round 3 went out exactly as the checkpoint holds it'
                );
                expectValues(handedOver, '1c');
            });
        },
    },
    {
        name: '1d. no-cost rounds: a no-cost tool round, then the way out of no-cost mode',
        body: async () => {
            await withFakeClock(async (jump) => {
                reset([
                    callsRound('r1', [{ name: 'lookup_a' }]),
                    callsRound('f1', [{ name: 'send_file' }]),
                    sseReply([event([textPart('Almost.')], { finishReason: 'MALFORMED_FUNCTION_CALL' })]),
                    answer('Files sent.'),
                ]);
                duringTool = () => {
                    duringTool = null;
                    jump(TOOL_LOOP_DEADLINE_MS + 1_000);
                };

                const { error, handedOver } = await runTurn({ tools: turnToolsWithFree });

                expect(error === null && vertex.requests.length === 4, `four requests (got ${vertex.requests.length} / ${errorMessage(error)})`);
                expect(json(executions) === '["lookup_a","send_file"]', `each call ran once (got ${json(executions)})`);
                expect(handedOver.length === 7, `seven checkpoints (got ${summaryOf(handedOver)})`);
                const [, , afterRound1, beforeFree, afterFree, afterFreeRound, freeExit] = handedOver.map((item) => loopOf(item.checkpoint));
                expect(afterRound1?.freeMode === true && afterRound1.freeRounds === 0, 'after round 1: no-cost mode, no no-cost round yet');
                expect(
                    beforeFree?.freeMode === true && beforeFree.freeRounds === 1 && answersOf(beforeFree, 1)[0]?.error === INTERRUPTED_CALL_ERROR,
                    'before the no-cost call: counted as a no-cost round, the call interrupted'
                );
                const freeAnswer = afterFree === undefined ? undefined : answersOf(afterFree, 1)[0];
                expect(
                    afterFree?.executedCallCount === 2 && freeAnswer?.output?.includes('只能再调用不产生开销的工具') === true,
                    `after the no-cost call: its result with the no-cost notice (got ${json(freeAnswer)})`
                );
                expect(afterFreeRound?.freeMode === true && afterFreeRound.request.final === false, 'after the no-cost round: still no-cost, not final');
                expect(
                    freeExit?.freeMode === false && freeExit.request.final && freeExit.roundNumber === 4,
                    'the round that did not call ends no-cost mode: round 4 is final'
                );
                expect(isModeNone(3) && !isModeNone(2), 'round 4 went out with function calling off, round 3 did not');
                expectValues(handedOver, '1d');
            });
        },
    },
    {
        name: '1e. a stop right after the stream completed: the round is kept, no call runs',
        body: async () => {
            const controller = new AbortController();
            // 'Thinking' could still be the start of the summarizer's scaffold, so
            // the filter holds it until the stream has ended: the one chunk the
            // stop lands on comes after the body closed with the finish reason
            reset([
                sseReply([event([thoughtPart('Thinking')]), event([callPart('lookup_a', { topic: 'r1' }, 'r1-0', 'call_r1_0')], { finishReason: 'STOP' })]),
                answer('never sent'),
            ]);

            const { handedOver, chunks, lines } = await runTurn({
                signal: controller.signal,
                onChunk: (chunk) => {
                    if (chunk.type === 'thinking') controller.abort();
                },
            });

            expect(
                textOf(chunks, 'thinking') === 'Thinking' && lines.some((line) => line.startsWith('[gemini-usage] ')),
                `the stop came on the flushed thinking, after round 1 had completed (got ${json(lines.filter((line) => line.startsWith('[gemini')))})`
            );
            expect(vertex.requests.length === 1 && executions.length === 0, 'nothing more is sent and no tool runs');
            expect(handedOver.length === 1, `one checkpoint (got ${summaryOf(handedOver)})`);
            const loop = loopOf(handedOver[0]?.checkpoint);
            expect(
                handedOver[0]?.checkpoint.completedRounds === 1 &&
                    json(answersOf(loop, 0)) === json([{ name: 'lookup_a', error: INTERRUPTED_CALL_ERROR }]),
                'it keeps round 1 with its call answered as interrupted'
            );
            expect(json(journalTypes(handedOver[0]?.checkpoint)) === '["thinking"]', 'with the thinking the stop landed on');
            expect(chunks.at(-1)?.type === 'done', 'the stopped loop still ends with done');
        },
    },
    {
        name: '1g. a stop after the finish reason arrived, the connection still open: kept like a completed round, no call runs',
        body: async () => {
            const controller = new AbortController();
            // The text rides the chunk that carries the finish reason; the body then
            // stays open until the stop aborts it
            reset([
                stalledStreamReply([
                    event([thoughtPart('plan r1')]),
                    event([textPart('Let me check.'), callPart('lookup_a', { topic: 'r1' }, 'r1-0', 'call_r1_0')], { finishReason: 'STOP' }),
                ]),
                answer('never sent'),
            ]);

            const { error, handedOver, chunks, lines } = await runTurn({
                signal: controller.signal,
                onChunk: (chunk) => {
                    if (chunk.type === 'text') controller.abort();
                },
            });

            expect(error === null, `no error comes out: the loop's own stop check ends it (got ${errorMessage(error)})`);
            expect(vertex.requests.length === 1 && executions.length === 0, 'nothing more is sent and no tool runs');
            expect(vertex.requests[0]?.signal?.aborted === true, 'the stop reached the open body');
            expect(handedOver.length === 1, `one checkpoint, as after a completed stream (got ${summaryOf(handedOver)})`);
            const loop = loopOf(handedOver[0]?.checkpoint);
            expect(
                handedOver[0]?.checkpoint.completedRounds === 1 &&
                    json(answersOf(loop, 0)) === json([{ name: 'lookup_a', error: INTERRUPTED_CALL_ERROR }]),
                `it keeps round 1 with its call answered as interrupted (got ${json(answersOf(loop, 0))})`
            );
            expect(
                json(journalTypes(handedOver[0]?.checkpoint)) === '["thinking","text"]',
                `with the round's whole output (got ${json(journalTypes(handedOver[0]?.checkpoint))})`
            );
            expect(
                lines.some((line) => line.includes('round=1 attempt=1 broke after finishReason=STOP')),
                `the kept round is logged (got ${json(lines.filter((line) => line.startsWith('[gemini-recover]')))})`
            );
            expect(chunks.at(-1)?.type === 'done', 'the stopped loop ends with done');
        },
    },
    {
        name: '1f. a round that fails mid-stream after thinking and a retry marker: the last checkpoint is the one before it',
        body: async () => {
            reset([
                callsRound('r1', [{ name: 'lookup_a' }]),
                midStreamErrorReply([event([thoughtPart('round 2 first thoughts')])], 500, 'Internal error encountered.'),
                midStreamErrorReply([event([thoughtPart('round 2 second thoughts')])], 500, 'Internal error encountered.'),
            ]);

            const { error, handedOver, chunks } = await runTurn();

            expect(asRecord(error).status === 500, `the second break ends the reply (got ${errorMessage(error)})`);
            const shown = textOf(chunks, 'thinking');
            expect(
                shown.includes('round 2 first thoughts') && shown.includes('〔第 2 轮生成中断') && shown.includes('round 2 second thoughts'),
                `the user saw round 2's thinking and the marker (got ${json(shown)})`
            );
            expect(handedOver.length === 3, `three checkpoints, all from round 1 (got ${summaryOf(handedOver)})`);
            const last = handedOver.at(-1)?.checkpoint;
            const kept = textOf(last?.journal ?? [], 'thinking');
            expect(
                last?.completedRounds === 1 && kept === 'plan r1',
                `the last one holds round 1's output only (got ${json(kept)})`
            );
            expect(
                statusTexts(chunks).includes('⟳ 第 2 轮服务端出错（5xx），5 秒后第 2 次尝试'),
                'the retry status was shown, and is no part of any journal'
            );
            expectValues(handedOver, '1f');
        },
    },
    {
        name: 'without a checkpointSink the requests are the same bytes',
        body: async () => {
            const script = (): ScriptedReply[] => [
                callsRound('r1', [{ name: 'lookup_a' }, { name: 'lookup_b' }]),
                callsRound('r2', [{ name: 'lookup_b' }]),
                answer('Done.'),
            ];
            reset(script());
            const collected = await runTurn();
            const withSink = vertex.requests.map((request) => request.rawBody);
            reset(script());
            const plain = await runTurn({ collect: false });
            const withoutSink = vertex.requests.map((request) => request.rawBody);

            expect(collected.error === null && plain.error === null, 'both replies finish');
            expect(collected.handedOver.length > 0 && plain.handedOver.length === 0, 'only the first one took checkpoints');
            expect(withSink.length === 3 && json(withSink) === json(withoutSink), 'every request is byte for byte the same');
            expect(
                json(collected.chunks) === json(plain.chunks),
                'and the chunks the consumer saw are the same'
            );
        },
    },
    {
        name: 'a consumer that walks away at a chunk ends the loop; nothing is handed over after that',
        body: async () => {
            reset([callsRound('r1', [{ name: 'lookup_a' }, { name: 'lookup_b' }]), answer('never sent')]);

            const { handedOver, chunks } = await runTurn({
                breakAfter: (chunk: StreamChunk) => chunk.type === 'grounding',
            });

            expect(json(executions) === '["lookup_a"]', `lookup_b never ran (got ${json(executions)})`);
            expect(vertex.requests.length === 1, 'no further request');
            expect(handedOver.length === 2, `before the calls and after lookup_a (got ${summaryOf(handedOver)})`);
            expect(chunks.at(-1)?.type === 'grounding', 'the consumer stopped at lookup_a\'s record');
            expect(
                asArray(loopOf(handedOver[1]?.checkpoint).toolRounds).length === 1,
                'the last checkpoint keeps round 1 with lookup_a run'
            );
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
reportResults(results);
