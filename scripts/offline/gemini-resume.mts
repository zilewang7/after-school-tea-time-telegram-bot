/**
 * Offline cases for resuming the Gemini client tool loop from a checkpoint
 * (design 2026-1112-1123 §6.1, §6.2, §6.5 steps 5-7; test plan §11 第 3 期
 * cases 4, 5 and 9 at the ai layer).
 *
 * Each case first runs a reply that is interrupted (an error, a stop, or a
 * consumer that walks away), keeps the last checkpoint it was handed, then
 * calls sendMessage again with `resumeFrom`. The platform runs a real
 * Vertex-mode SDK client over a fake fetch (support/fake-vertex.mts); its
 * sleeps return at once.
 *
 * Run: npx tsx scripts/offline/gemini-resume.mts
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import {
    createFakeVertex,
    httpErrorReply,
    midStreamErrorReply,
    type RecordedRequest,
    type ScriptedReply,
} from './support/fake-vertex.mts';
import {
    answer,
    asArray,
    asRecord,
    callsRound,
    consumeReply,
    errorMessage,
    event,
    frozenCopyOf,
    json,
    nonPlainPaths,
    signature,
    statusTexts,
    textOf,
    thoughtPart,
    usageLines,
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
const { createTurnTools, FREE_TOOL_ROUNDS_MAX, TOOL_LOOP_DEADLINE_MS } = await import('../../src/ai/tools/index.js');
const { createUsageSink } = await import('../../src/ai/usage/index.js');
const { INTERRUPTED_CALL_ERROR, LAST_TOOL_ROUND_NOTICE, STOPPED_DURING_CALL_NOTE } = await import(
    '../../src/ai/platforms/gemini/gemini-round-contents.js'
);
const { REPLAY_BATCH_SIZE } = await import('../../src/ai/platforms/gemini/gemini-loop-journal.js');

type UsageSink = import('../../src/ai/usage/index.js').UsageSink;

const vertex = createFakeVertex();

/** Every wait returns at once */
class InstantGeminiPlatform extends GeminiPlatform {
    protected override sleep(_ms: number, signal?: AbortSignal): Promise<void> {
        return signal?.aborted ? Promise.reject(new Error('Aborted')) : Promise.resolve();
    }
}

const platform = new InstantGeminiPlatform({ client: vertex.client, random: () => 0.5 });

const RATE_LIMITED = 'Resource exhausted. Please try again later.';
const INTERNAL = 'Internal error encountered.';
const BAD_REQUEST = 'Request contains an invalid argument.';

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const executions: string[] = [];
/** Runs inside a tool once it was recorded (moves the fake clock, presses stop) */
let duringTool: ((name: string) => void) | null = null;

const objectSchema = { type: 'object', properties: { topic: { type: 'string' } } };

const okResult = (content: string, extra: Partial<ToolResult> = {}): ToolResult => ({
    content,
    isError: false,
    images: [],
    record: null,
    ...extra,
});

const tool = (name: string, result: ToolResult): ToolHandler => ({
    definition: { name, description: `The ${name} tool`, inputSchema: objectSchema },
    execute: async () => {
        executions.push(name);
        duringTool?.(name);
        return result;
    },
});

const abortError = (): Error => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });

/** Runs until the reply's stop reaches it, then fails the way an aborted fetch does */
const untilStopped = (name: string): ToolHandler => ({
    definition: { name, description: `The ${name} tool`, inputSchema: objectSchema },
    execute: (_args, signal) => {
        executions.push(name);
        duringTool?.(name);
        return new Promise<ToolResult>((_resolve, reject) => {
            if (signal.aborted) reject(abortError());
            else signal.addEventListener('abort', () => reject(abortError()), { once: true });
        });
    },
});

const PICTURE_ONE = Buffer.from('first picture');
const PICTURE_TWO = Buffer.from('second picture');

const sendSms = tool('send_sms', okResult('SMS delivered to the owner'));
const slowSearch = untilStopped('slow_search');
const lookupA = tool('lookup_a', okResult('key is K-7731', { record: { provider: 'mcp', searchQueries: ['lookup_a'] } }));
const lookupB = tool('lookup_b', okResult('code word is AZALEA-42'));
const lookupC = tool('lookup_c', okResult('never needed'));
const makePictures = tool(
    'make_pictures',
    okResult('two pictures and a sticker made', {
        images: [
            { data: PICTURE_ONE, mimeType: 'image/png', caption: 'one' },
            { data: PICTURE_TWO, mimeType: 'image/png', caption: 'two' },
        ],
        stickers: [{ packIndex: 3, label: 'cat', emoji: '🐱', fileId: 'file-cat', fileUniqueId: 'unique-cat' }],
        record: { provider: 'mcp', searchQueries: ['make_pictures'] },
    })
);
const sendFile = tool('send_file', okResult('file sent'));

/** A no-cost tool; when the stop reached it while it ran it fails the way an aborted request does */
const generateImage: ToolHandler = {
    definition: { name: 'generate_image', description: 'The generate_image tool', inputSchema: objectSchema },
    execute: async (_args, signal) => {
        executions.push('generate_image');
        duringTool?.('generate_image');
        if (signal.aborted) throw abortError();
        return okResult('image generated');
    },
};

const turnTools = createTurnTools([sendSms, slowSearch, lookupA, lookupB, lookupC, makePictures]);
const turnToolsWithFree = createTurnTools([lookupA, lookupB, sendFile]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const reset = (replies: readonly ScriptedReply[]): void => {
    vertex.reset(replies);
    executions.length = 0;
    duringTool = null;
};

const userTurn: UnifiedMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'What is the code word?' }] }];

interface TurnOptions extends ConsumeOptions {
    readonly resumeFrom?: ToolLoopCheckpoint;
    readonly tools?: TurnTools | null;
    readonly signal?: AbortSignal;
    readonly maxRetries?: number;
    readonly usageSink?: UsageSink;
    readonly serviceTier?: 'priority';
}

interface TurnResult extends ConsumedReply {
    readonly checkpoints: ToolLoopCheckpoint[];
    readonly requests: RecordedRequest[];
}

/** One reply (a resume when `resumeFrom` is set), every checkpoint it hands over collected */
const runTurn = async (options: TurnOptions = {}): Promise<TurnResult> => {
    const checkpoints: ToolLoopCheckpoint[] = [];
    const consumed = await consumeReply(
        () =>
            platform.sendMessage(options.resumeFrom ? [] : userTurn, {
                model: 'gemini-3.8-flash',
                systemPrompt: 'offline system prompt',
                maxRetries: options.maxRetries ?? 3,
                ...(options.tools === null ? {} : { tools: options.tools ?? turnTools }),
                checkpointSink: (checkpoint) => checkpoints.push(checkpoint),
                ...(options.resumeFrom ? { resumeFrom: options.resumeFrom } : {}),
                ...(options.signal ? { signal: options.signal } : {}),
                ...(options.usageSink ? { usageSink: options.usageSink } : {}),
                ...(options.serviceTier ? { serviceTier: options.serviceTier } : {}),
            }),
        options
    );
    return { ...consumed, checkpoints, requests: [...vertex.requests] };
};

/** The last checkpoint of an interrupted reply; the case fails without one */
const lastCheckpoint = (turn: TurnResult): ToolLoopCheckpoint => {
    const checkpoint = turn.checkpoints.at(-1);
    if (checkpoint === undefined) throw new Error(`no checkpoint was handed over (${errorMessage(turn.error)})`);
    return checkpoint;
};

interface Answer {
    readonly name: string;
    readonly output?: string;
    readonly error?: string;
    readonly notice?: string;
}

/** Every function response a request sends, in order */
const answersIn = (request: RecordedRequest | undefined): Answer[] =>
    asArray(request?.body.contents)
        .flatMap((content) => asArray(asRecord(content).parts))
        .map((part) => asRecord(asRecord(part).functionResponse))
        .filter((functionResponse) => typeof functionResponse.name === 'string')
        .map((functionResponse) => {
            const response = asRecord(functionResponse.response);
            return {
                name: String(functionResponse.name),
                ...(typeof response.output === 'string' ? { output: response.output } : {}),
                ...(typeof response.error === 'string' ? { error: response.error } : {}),
                ...(typeof response.notice === 'string' ? { notice: response.notice } : {}),
            };
        });

const isModeNone = (request: RecordedRequest | undefined): boolean =>
    asRecord(asRecord(request?.body.toolConfig).functionCallingConfig).mode === 'NONE';

/** The interrupted request's contents, minus the closing bracket: what the resumed body must start with */
const contentsPrefixOf = (request: RecordedRequest | undefined): string =>
    `{"contents":${JSON.stringify(request?.body.contents ?? []).slice(0, -1)}`;

const replayed = (chunks: readonly StreamChunk[]): StreamChunk[] => chunks.filter((chunk) => chunk.replay === true);
const fresh = (chunks: readonly StreamChunk[]): StreamChunk[] => chunks.filter((chunk) => chunk.replay !== true);

const doneOf = (chunks: readonly StreamChunk[]): StreamChunk | undefined => chunks.find((chunk) => chunk.type === 'done');

/** The replay is the journal itself, each chunk marked, in order and at its granularity */
const expectReplayOf = (chunks: readonly StreamChunk[], journal: readonly StreamChunk[], label: string): void => {
    const head = chunks.slice(0, journal.length);
    expect(
        json(head) === json(journal.map((chunk) => ({ ...chunk, replay: true }))),
        `${label}: the journal comes first, every chunk marked replay (got ${json(head.map((chunk) => chunk.type))})`
    );
    expect(replayed(chunks).length === journal.length, `${label}: and nothing after it is marked`);
};

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const cases: Array<{ name: string; body: () => Promise<void> }> = [
    {
        name: '5. a failed round 3: the resumed request is byte for byte what round 3 sent, signatures included; no tool runs again',
        body: async () => {
            reset([
                callsRound('r1', [{ name: 'lookup_a' }]),
                callsRound('r2', [{ name: 'lookup_b' }]),
                httpErrorReply(400, BAD_REQUEST),
            ]);
            const interrupted = await runTurn();
            expect(asRecord(interrupted.error).status === 400, `round 3 fails (got ${errorMessage(interrupted.error)})`);
            const checkpoint = lastCheckpoint(interrupted);
            expect(checkpoint.completedRounds === 2, `two rounds kept (got ${checkpoint.completedRounds})`);
            const round3 = interrupted.requests[2];

            reset([answer('Resumed answer.')]);
            const usageSink = createUsageSink();
            const resumed = await runTurn({ resumeFrom: checkpoint, usageSink });

            expect(resumed.error === null, `the resume finishes (got ${errorMessage(resumed.error)})`);
            expect(resumed.requests.length === 1, 'one request');
            expect(resumed.requests[0]?.rawBody === round3?.rawBody, 'the resumed request is the failed round 3, byte for byte');
            expect(
                [signature('r1-0'), signature('r2-0')].every((value) => resumed.requests[0]?.rawBody.includes(value) === true),
                'both thought signatures ride along'
            );
            expect(executions.length === 0, `no tool ran again (got ${json(executions)})`);
            expectReplayOf(resumed.chunks, checkpoint.journal, 'case 5');
            expect(textOf(fresh(resumed.chunks)) === 'Resumed answer.', 'then the new round streams');
            expect(
                json(doneOf(resumed.chunks)?.agentStats?.toolUsage) ===
                    json([
                        { name: 'lookup_a', count: 1 },
                        { name: 'lookup_b', count: 1 },
                    ]),
                `the done chunk's tool usage is cumulative (got ${json(doneOf(resumed.chunks)?.agentStats)})`
            );
            const totals = usageSink.totals();
            expect(totals.rounds === 1 && totals.promptTokens === 100, `the sink counts the new round only (got ${json(totals)})`);
            expect(
                json(usageLines(resumed.lines).map((line) => /round=(\d+)/.exec(line)?.[1])) === '["3"]',
                `the usage line says round 3 (got ${json(usageLines(resumed.lines))})`
            );
            expect(
                resumed.lines.some((line) => line.includes(' summary rounds=1 calls=0 ') && line.endsWith(' resumed=2')),
                `the summary counts this request and names the resume (got ${json(resumed.lines.filter((line) => line.includes('summary')))})`
            );
        },
    },
    {
        name: '4. a stop during the 2nd of 3 calls: the 1st keeps its result, the 2nd says the stop may have taken effect, the 3rd is not run',
        body: async () => {
            const controller = new AbortController();
            reset([callsRound('r1', [{ name: 'send_sms' }, { name: 'slow_search' }, { name: 'lookup_c' }]), answer('never sent')]);
            duringTool = (name) => {
                if (name === 'slow_search') controller.abort();
            };
            const interrupted = await runTurn({ signal: controller.signal, stopSignal: controller.signal });

            expect(json(executions) === '["send_sms","slow_search"]', `lookup_c never ran (got ${json(executions)})`);
            const checkpoint = lastCheckpoint(interrupted);
            expect(checkpoint.completedRounds === 1, 'round 1 is kept');
            expect(
                json(checkpoint.toolUsage) ===
                    json([
                        { name: 'send_sms', count: 1 },
                        { name: 'slow_search', count: 1, failed: 1 },
                    ]),
                `the usage of the two calls that ran (got ${json(checkpoint.toolUsage)})`
            );
            const round1 = interrupted.requests[0];

            reset([answer('Stopped, then resumed.')]);
            const resumed = await runTurn({ resumeFrom: checkpoint });

            expect(resumed.error === null, `the resume finishes (got ${errorMessage(resumed.error)})`);
            const answers = answersIn(resumed.requests[0]);
            expect(answers.length === 3, `three answers (got ${json(answers)})`);
            expect(
                answers[0]?.output?.startsWith('SMS delivered to the owner\n\n[工具轮次] 本次回复已调用工具 2 次。') === true,
                `send_sms: its real result (got ${json(answers[0])})`
            );
            expect(
                answers[1]?.error?.startsWith(`Tool slow_search failed: This operation was aborted\n\n${STOPPED_DURING_CALL_NOTE}`) === true,
                `slow_search: its error, then the stop note (got ${json(answers[1])})`
            );
            expect(json(answers[2]) === json({ name: 'lookup_c', error: INTERRUPTED_CALL_ERROR }), `lookup_c: not run (got ${json(answers[2])})`);
            expect(executions.length === 0, `send_sms is not called again (got ${json(executions)})`);
            expect(
                resumed.requests[0]?.rawBody.startsWith(contentsPrefixOf(round1)) === true,
                'the resumed body starts with what round 1 sent, byte for byte'
            );
            expect(resumed.requests[0]?.rawBody.includes(signature('r1-0')) === true, "round 1's signature rides along");
        },
    },
    {
        name: '4b. a call that started after the stop never ran: no stop note on it',
        body: async () => {
            const controller = new AbortController();
            // not_offered names no tool of the turn: no status line before it, so it runs right after the stopped call
            reset([callsRound('r1', [{ name: 'slow_search' }, { name: 'not_offered' }]), answer('never sent')]);
            duringTool = () => controller.abort();
            const interrupted = await runTurn({ signal: controller.signal, stopSignal: controller.signal });
            const checkpoint = lastCheckpoint(interrupted);

            reset([answer('Resumed.')]);
            const resumed = await runTurn({ resumeFrom: checkpoint });

            const answers = answersIn(resumed.requests[0]);
            expect(answers[0]?.error?.includes(STOPPED_DURING_CALL_NOTE) === true, `slow_search carries the note (got ${json(answers[0])})`);
            expect(
                answers[1]?.error?.startsWith('Unknown tool not_offered') === true && answers[1]?.error?.includes(STOPPED_DURING_CALL_NOTE) === false,
                `the call after the stop does not (got ${json(answers[1])})`
            );
        },
    },
    {
        name: "4c. a consumer that walks away, or throws, halfway through a call's products: the replay has each product once",
        body: async () => {
            for (const label of ['walks away', 'throws'] as const) {
                reset([callsRound('r1', [{ name: 'lookup_a' }, { name: 'make_pictures' }]), answer('never sent')]);
                const interrupted = await runTurn(
                    label === 'walks away'
                        ? { breakAfter: (chunk) => chunk.type === 'image' }
                        : {
                              onChunk: (chunk) => {
                                  if (chunk.type === 'image') throw new Error('the consumer failed');
                              },
                          }
                );
                expect(
                    interrupted.chunks.filter((chunk) => chunk.type === 'image').length === 1,
                    `${label}: the consumer saw only the first picture`
                );
                expect(label === 'walks away' || errorMessage(interrupted.error) === 'the consumer failed', `${label}: its own error comes out`);
                const checkpoint = lastCheckpoint(interrupted);

                reset([answer('All delivered.')]);
                const resumed = await runTurn({ resumeFrom: checkpoint });

                const replay = replayed(resumed.chunks);
                const images = replay.filter((chunk) => chunk.type === 'image');
                expect(
                    images.length === 2 && images[0]?.imageData === PICTURE_ONE && images[1]?.imageData === PICTURE_TWO,
                    `${label}: both pictures once, in order (got ${images.length})`
                );
                expect(replay.filter((chunk) => chunk.type === 'sticker').length === 1, `${label}: the sticker once`);
                expect(
                    json(replay.filter((chunk) => chunk.type === 'grounding').map((chunk) => chunk.groundingMetadata?.searchQueries)) ===
                        json([['lookup_a'], ['make_pictures']]),
                    `${label}: each record once`
                );
                expect(executions.length === 0, `${label}: no tool ran again`);
                expect(textOf(fresh(resumed.chunks)) === 'All delivered.', `${label}: then the reply goes on`);
            }
        },
    },
    {
        name: '9a. counts and clocks go on: round numbers, the call count, tool time and wall time without the gap',
        body: async () => {
            await withFakeClock(async (jump) => {
                const toolSeconds: Record<string, number> = { lookup_a: 100, lookup_b: 50 };
                const charge = (name: string): void => jump((toolSeconds[name] ?? 0) * 1000);
                reset([
                    callsRound('r1', [{ name: 'lookup_a' }]),
                    callsRound('r2', [{ name: 'lookup_b' }]),
                    httpErrorReply(503, 'The service is currently unavailable.'),
                    httpErrorReply(503, 'The service is currently unavailable.'),
                    httpErrorReply(503, 'The service is currently unavailable.'),
                ]);
                duringTool = charge;
                const interrupted = await runTurn();
                const checkpoint = lastCheckpoint(interrupted);
                expect(checkpoint.completedRounds === 2, `two rounds kept (got ${checkpoint.completedRounds})`);

                // The click comes 50 minutes later: past the 20-minute wall if it counted
                jump(50 * 60_000);
                reset([callsRound('r3', [{ name: 'lookup_a' }]), answer('The code word is AZALEA-42.')]);
                duringTool = charge;
                const usageSink = createUsageSink();
                const resumed = await runTurn({ resumeFrom: checkpoint, usageSink });

                expect(resumed.error === null && resumed.requests.length === 2, `two requests (got ${resumed.requests.length} / ${errorMessage(resumed.error)})`);
                expect(
                    json(usageLines(resumed.lines).map((line) => /round=(\d+)/.exec(line)?.[1])) === '["3","4"]',
                    `the usage lines go on with rounds 3 and 4 (got ${json(usageLines(resumed.lines))})`
                );
                const lastAnswer = answersIn(resumed.requests[1]).at(-1);
                expect(lastAnswer?.output?.includes('[工具轮次] 本次回复已调用工具 3 次。') === true, `the call count goes on (got ${json(lastAnswer)})`);
                expect(
                    lastAnswer?.output?.includes('[时间] 工具实际耗时 250s / 预算 600s（还剩 350s）；本次回复实际已用 250s。') === true,
                    `tool time and wall time carry over, the gap does not count (got ${json(lastAnswer)})`
                );
                expect(!isModeNone(resumed.requests[1]), 'so round 4 may still call');
                expect(
                    json(doneOf(resumed.chunks)?.agentStats?.toolUsage) ===
                        json([
                            { name: 'lookup_a', count: 2 },
                            { name: 'lookup_b', count: 1 },
                        ]),
                    `cumulative tool usage (got ${json(doneOf(resumed.chunks)?.agentStats)})`
                );
                const totals = usageSink.totals();
                expect(totals.rounds === 2 && totals.roundRetries === 0, `the sink counts the two new rounds only (got ${json(totals)})`);
                expect(
                    resumed.checkpoints.every((item) => item.completedRounds >= 3) && resumed.checkpoints.at(-1)?.completedRounds === 3,
                    'the resumed loop hands out its own checkpoints from round 3 on'
                );
            });
        },
    },
    {
        name: '9b. the automatic recovery budget starts afresh',
        body: async () => {
            reset([
                midStreamErrorReply([event([thoughtPart('r1 broken')])], 500, INTERNAL),
                callsRound('r1', [{ name: 'lookup_a' }]),
                midStreamErrorReply([event([thoughtPart('r2 broken')])], 500, INTERNAL),
                callsRound('r2', [{ name: 'lookup_b' }]),
                midStreamErrorReply([event([thoughtPart('r3 broken')])], 500, INTERNAL),
            ]);
            const interrupted = await runTurn();
            expect(
                asRecord(interrupted.error).status === 500 &&
                    interrupted.lines.some((line) => line.includes('round=3 gave up after 1 attempts: stream_reply_limit')),
                'the third broken stream of the reply is final'
            );
            const checkpoint = lastCheckpoint(interrupted);

            reset([midStreamErrorReply([event([thoughtPart('r3 broken again')])], 500, INTERNAL), answer('Recovered.')]);
            const usageSink = createUsageSink();
            const resumed = await runTurn({ resumeFrom: checkpoint, usageSink });

            expect(resumed.error === null && resumed.requests.length === 2, `the resume retries the broken stream (got ${errorMessage(resumed.error)})`);
            expect(resumed.requests[0]?.rawBody === resumed.requests[1]?.rawBody, 'the same request again');
            expect(usageSink.totals().roundRetries === 1, 'one automatic retry counted');
        },
    },
    {
        name: '9c. a checkpoint in no-cost mode resumes in no-cost mode, and its no-cost rounds keep counting',
        body: async () => {
            await withFakeClock(async (jump) => {
                const freeRounds = FREE_TOOL_ROUNDS_MAX - 1;
                reset([
                    callsRound('r1', [{ name: 'lookup_a' }]),
                    ...Array.from({ length: freeRounds }, (_unused, index) => callsRound(`f${index + 1}`, [{ name: 'send_file' }])),
                    httpErrorReply(400, BAD_REQUEST),
                ]);
                duringTool = () => {
                    duringTool = null;
                    jump(TOOL_LOOP_DEADLINE_MS + 1_000);
                };
                const interrupted = await runTurn({ tools: turnToolsWithFree });
                const checkpoint = lastCheckpoint(interrupted);
                expect(checkpoint.completedRounds === freeRounds + 1, `round 1 and ${freeRounds} no-cost rounds kept`);

                reset([callsRound('last', [{ name: 'send_file' }, { name: 'lookup_b' }]), answer('Handed over.')]);
                const resumed = await runTurn({ resumeFrom: checkpoint, tools: turnToolsWithFree });

                expect(resumed.error === null && resumed.requests.length === 2, `two requests (got ${resumed.requests.length})`);
                expect(json(executions) === '["send_file"]', `only the no-cost tool runs (got ${json(executions)})`);
                expect(!isModeNone(resumed.requests[0]), 'the resumed no-cost round may still call');
                const answers = answersIn(resumed.requests[1]).slice(-2);
                expect(
                    answers[0]?.output?.includes('只能再调用不产生开销的工具') === true && answers[1]?.error?.startsWith('Unknown tool lookup_b') === true,
                    `send_file ran as a no-cost call, lookup_b was refused (got ${json(answers)})`
                );
                expect(
                    isModeNone(resumed.requests[1]) && answers.every((item) => item.notice === LAST_TOOL_ROUND_NOTICE),
                    `that was the ${FREE_TOOL_ROUNDS_MAX}th no-cost round: the next one is final`
                );
            });
        },
    },
    {
        name: '9d. a checkpoint before a final round, and one after a final round that still called, resume in the same mode',
        body: async () => {
            await withFakeClock(async (jump) => {
                const useUpBudget = (): void => {
                    duringTool = null;
                    jump(TOOL_LOOP_DEADLINE_MS + 1_000);
                };
                reset([callsRound('r1', [{ name: 'lookup_a' }]), httpErrorReply(400, BAD_REQUEST)]);
                duringTool = useUpBudget;
                const beforeFinal = lastCheckpoint(await runTurn({ tools: createTurnTools([lookupA, lookupB]) }));

                reset([answer('Final answer.')]);
                const resumedFinal = await runTurn({ resumeFrom: beforeFinal, tools: createTurnTools([lookupA, lookupB]) });
                expect(resumedFinal.error === null && isModeNone(resumedFinal.requests[0]), 'the resumed final round has function calling off');

                reset([
                    callsRound('r1', [{ name: 'lookup_a' }]),
                    callsRound('r2', [{ name: 'lookup_b' }]),
                    httpErrorReply(400, BAD_REQUEST),
                ]);
                duringTool = useUpBudget;
                const afterFinalCalls = lastCheckpoint(await runTurn({ tools: createTurnTools([lookupA, lookupB]) }));
                expect(afterFinalCalls.completedRounds === 2, 'the final round that called is kept');

                reset([callsRound('r3', [{ name: 'lookup_b' }]), answer('never sent')]);
                const resumedAfter = await runTurn({ resumeFrom: afterFinalCalls, tools: createTurnTools([lookupA, lookupB]) });
                expect(
                    resumedAfter.error === null && resumedAfter.requests.length === 1 && executions.length === 0,
                    `no second extra round: the call is not run and the reply ends (got ${resumedAfter.requests.length})`
                );
                expect(
                    resumedAfter.lines.some((line) => line.includes('round 3 still asked for 1 function call(s)')),
                    'the ignored call is logged'
                );
            });
        },
    },
    {
        name: '9e. a stop in the call of the last allowed no-cost round: the resume may call again, the call runs, then the cap applies',
        body: async () => {
            await withFakeClock(async (jump) => {
                const controller = new AbortController();
                const tools = createTurnTools([lookupA, generateImage]);
                reset([
                    callsRound('r1', [{ name: 'lookup_a' }]),
                    ...Array.from({ length: FREE_TOOL_ROUNDS_MAX }, (_unused, index) => callsRound(`f${index + 1}`, [{ name: 'generate_image' }])),
                    answer('never sent'),
                ]);
                let imageCalls = 0;
                duringTool = (name) => {
                    if (name === 'lookup_a') jump(TOOL_LOOP_DEADLINE_MS + 1_000);
                    imageCalls += name === 'generate_image' ? 1 : 0;
                    if (imageCalls === FREE_TOOL_ROUNDS_MAX) controller.abort();
                };
                const interrupted = await runTurn({ tools, signal: controller.signal, stopSignal: controller.signal });
                expect(
                    executions.length === FREE_TOOL_ROUNDS_MAX + 1 && interrupted.requests.length === FREE_TOOL_ROUNDS_MAX + 1,
                    `round 1, then ${FREE_TOOL_ROUNDS_MAX} no-cost rounds, the last one stopped in its call (got ${json(executions)})`
                );
                const checkpoint = lastCheckpoint(interrupted);
                expect(checkpoint.completedRounds === FREE_TOOL_ROUNDS_MAX + 1, `every round is kept (got ${checkpoint.completedRounds})`);

                reset([callsRound('again', [{ name: 'generate_image' }]), answer('Here is the picture.')]);
                duringTool = null;
                const resumed = await runTurn({ resumeFrom: checkpoint, tools });

                expect(resumed.error === null && resumed.requests.length === 2, `two requests (got ${resumed.requests.length} / ${errorMessage(resumed.error)})`);
                const stoppedAnswer = answersIn(resumed.requests[0]).at(-1);
                expect(
                    !isModeNone(resumed.requests[0]) && stoppedAnswer?.notice === undefined,
                    `the resumed round is the interrupted no-cost round again, not the final one (got ${json(stoppedAnswer)})`
                );
                expect(stoppedAnswer?.error?.includes(STOPPED_DURING_CALL_NOTE) === true, 'the stopped call carries the stop note');
                expect(json(executions) === '["generate_image"]', `the call issued again runs (got ${json(executions)})`);
                const capAnswer = answersIn(resumed.requests[1]).at(-1);
                expect(
                    isModeNone(resumed.requests[1]) &&
                        capAnswer?.notice === LAST_TOOL_ROUND_NOTICE &&
                        capAnswer.output?.includes('只能再调用不产生开销的工具') === true,
                    `that round was the ${FREE_TOOL_ROUNDS_MAX}th no-cost round: the next one is final (got ${json(capAnswer)})`
                );
            });
        },
    },
    {
        name: '9f. the budget used up partway through a normal round: the resume is a normal round again, with and without no-cost tools',
        body: async () => {
            for (const [label, tools] of [
                ['without no-cost tools', createTurnTools([lookupA, lookupB])],
                ['with no-cost tools', turnToolsWithFree],
            ] as const) {
                await withFakeClock(async (jump) => {
                    reset([callsRound('r1', [{ name: 'lookup_a' }, { name: 'lookup_b' }]), answer('never sent')]);
                    duringTool = (name) => {
                        if (name === 'lookup_a') jump(TOOL_LOOP_DEADLINE_MS + 1_000);
                    };
                    // The consumer walks away at lookup_a's record: lookup_b never runs
                    const interrupted = await runTurn({ tools, breakAfter: (chunk) => chunk.type === 'grounding' });
                    expect(json(executions) === '["lookup_a"]', `${label}: only lookup_a ran (got ${json(executions)})`);
                    const checkpoint = lastCheckpoint(interrupted);

                    reset([callsRound('again', [{ name: 'lookup_b' }]), answer('The code word is AZALEA-42.')]);
                    duringTool = null;
                    const resumed = await runTurn({ resumeFrom: checkpoint, tools });

                    expect(resumed.error === null && resumed.requests.length === 2, `${label}: two requests (got ${errorMessage(resumed.error)})`);
                    const answers = answersIn(resumed.requests[0]);
                    expect(
                        !isModeNone(resumed.requests[0]) &&
                            answers.every((item) => item.notice === undefined && item.output?.includes('只能再调用不产生开销的工具') !== true) &&
                            answers[1]?.error === INTERRUPTED_CALL_ERROR,
                        `${label}: the resumed round is a normal one, lookup_b answered as not run (got ${json(answers)})`
                    );
                    expect(json(executions) === '["lookup_b"]', `${label}: lookup_b, issued again, runs (got ${json(executions)})`);
                    const afterRound = answersIn(resumed.requests[1]).at(-1);
                    expect(
                        label === 'without no-cost tools'
                            ? isModeNone(resumed.requests[1]) && afterRound?.notice === LAST_TOOL_ROUND_NOTICE
                            : !isModeNone(resumed.requests[1]) && afterRound?.output?.includes('只能再调用不产生开销的工具') === true,
                        `${label}: once that round's calls ran, the budget is judged (got ${json(afterRound)})`
                    );
                });
            }
        },
    },
    {
        name: '9g. a round whose last call was stopped ran every call, yet is not over: the budget it used up is not judged from it',
        body: async () => {
            await withFakeClock(async (jump) => {
                const controller = new AbortController();
                const tools = createTurnTools([lookupA, slowSearch]);
                reset([callsRound('r1', [{ name: 'lookup_a' }, { name: 'slow_search' }]), answer('never sent')]);
                duringTool = (name) => {
                    if (name === 'lookup_a') jump(TOOL_LOOP_DEADLINE_MS + 1_000);
                    if (name === 'slow_search') controller.abort();
                };
                const interrupted = await runTurn({ tools, signal: controller.signal, stopSignal: controller.signal });
                expect(json(executions) === '["lookup_a","slow_search"]', `every call of the round ran (got ${json(executions)})`);
                const checkpoint = lastCheckpoint(interrupted);

                reset([answer('Resumed after the stop.')]);
                duringTool = null;
                const resumed = await runTurn({ resumeFrom: checkpoint, tools });

                expect(resumed.error === null, `the resume finishes (got ${errorMessage(resumed.error)})`);
                const answers = answersIn(resumed.requests[0]);
                expect(
                    !isModeNone(resumed.requests[0]) && answers.every((item) => item.notice === undefined),
                    `the resumed round may still call: the stopped call can be issued again (got ${json(answers)})`
                );
                expect(answers[1]?.error?.includes(STOPPED_DURING_CALL_NOTE) === true, `slow_search carries the stop note (got ${json(answers[1])})`);
            });
        },
    },
    {
        name: 'after a resume: new checkpoints hold the old journal plus the new chunks; a resume that fails at once hands out nothing',
        body: async () => {
            reset([callsRound('r1', [{ name: 'lookup_a' }]), httpErrorReply(400, BAD_REQUEST)]);
            const checkpoint = lastCheckpoint(await runTurn());
            const frozen = frozenCopyOf(checkpoint);

            reset([httpErrorReply(400, BAD_REQUEST)]);
            const failedAtOnce = await runTurn({ resumeFrom: checkpoint });
            expect(asRecord(failedAtOnce.error).status === 400, 'the resumed round fails');
            expect(failedAtOnce.checkpoints.length === 0, 'and nothing is handed over: the caller keeps the one it had');

            reset([callsRound('r2', [{ name: 'lookup_b' }]), answer('Done.')]);
            const resumed = await runTurn({ resumeFrom: checkpoint });
            expect(resumed.error === null, `the second resume finishes (got ${errorMessage(resumed.error)})`);
            expect(resumed.checkpoints.length === 3, `before, after the call, next round (got ${resumed.checkpoints.length})`);
            const old = checkpoint.journal;
            expect(
                resumed.checkpoints.every(
                    (item) =>
                        item.journal.length > old.length &&
                        old.every((chunk, index) => item.journal[index] === chunk) &&
                        item.journal.every((chunk) => chunk.replay === undefined && chunk.type !== 'status')
                ),
                'each starts with the old journal, chunk for chunk, and holds no replay flag'
            );
            expect(
                resumed.checkpoints.every((item) => nonPlainPaths(item).length === 0),
                'and each is plain data like any other checkpoint'
            );
            const added = resumed.checkpoints.at(-1)?.journal.slice(old.length) ?? [];
            expect(textOf(added, 'thinking') === 'plan r2', `then round 2's own output (got ${json(added)})`);
            expect(frozenCopyOf(checkpoint) === frozen, 'the checkpoint resumed from is unchanged, twice over');
        },
    },
    {
        name: 'the resume status line shows after the replay, goes when the stream opens, and never outlives a retry status or an error',
        body: async () => {
            reset([callsRound('r1', [{ name: 'lookup_a' }]), httpErrorReply(400, BAD_REQUEST)]);
            const checkpoint = lastCheckpoint(await runTurn());

            reset([answer('Opened.')]);
            const opened = await runTurn({ resumeFrom: checkpoint });
            const firstStatus = opened.chunks.findIndex((chunk) => chunk.type === 'status');
            expect(firstStatus === checkpoint.journal.length, 'the status follows the replay at once');
            expect(
                json(statusTexts(opened.chunks)) === json(['⟳ 从第 2 轮继续', '(clear)']),
                `the resume line, cleared once the stream opened (got ${json(statusTexts(opened.chunks))})`
            );
            expect(opened.chunks[firstStatus + 1]?.type === 'status', 'cleared before the first new chunk');

            reset([httpErrorReply(429, RATE_LIMITED), answer('Second attempt.')]);
            const retried = await runTurn({ resumeFrom: checkpoint });
            expect(
                json(statusTexts(retried.chunks)) ===
                    json(['⟳ 从第 2 轮继续', '⟳ 第 2 轮被限流（429），15 秒后第 2 次尝试', '⟳ 第 2 轮重试中（第 2 次尝试）', '(clear)']),
                `a refused opening replaces it with the retry status (got ${json(statusTexts(retried.chunks))})`
            );

            for (const maxRetries of [3, 1]) {
                reset([httpErrorReply(400, BAD_REQUEST)]);
                const failed = await runTurn({ resumeFrom: checkpoint, maxRetries });
                expect(asRecord(failed.error).status === 400, `maxRetries ${maxRetries}: the error comes out`);
                expect(
                    json(statusTexts(failed.chunks)) === json(['⟳ 从第 2 轮继续', '(clear)']),
                    `maxRetries ${maxRetries}: the line is cleared before the error (got ${json(statusTexts(failed.chunks))})`
                );
            }
        },
    },
    {
        name: 'a long replay gives the event loop a turn between batches',
        body: async () => {
            reset([callsRound('r1', [{ name: 'lookup_a' }]), httpErrorReply(400, BAD_REQUEST)]);
            const checkpoint = lastCheckpoint(await runTurn());
            const longJournal: StreamChunk[] = Array.from({ length: 1_000 }, (_unused, index) => ({ type: 'text', content: `${index} ` }));

            reset([answer('After a long replay.')]);
            let seenWhenTimerRan: number | null = null;
            let seen = 0;
            setImmediate(() => {
                seenWhenTimerRan = seen;
            });
            const resumed = await runTurn({
                resumeFrom: { ...checkpoint, journal: longJournal },
                onChunk: () => {
                    seen += 1;
                },
            });

            expect(resumed.error === null && replayed(resumed.chunks).length === 1_000, 'the whole journal is replayed');
            expect(
                seenWhenTimerRan !== null && seenWhenTimerRan <= REPLAY_BATCH_SIZE,
                `a macrotask ran after at most one batch (ran after ${seenWhenTimerRan} chunks)`
            );
        },
    },
    {
        name: 'a checkpoint of another platform, a foreign state, a mismatched count, or no tools: rejected before anything is sent',
        body: async () => {
            reset([callsRound('r1', [{ name: 'lookup_a' }]), httpErrorReply(400, BAD_REQUEST)]);
            const checkpoint = lastCheckpoint(await runTurn());

            const attempts: Array<[string, ToolLoopCheckpoint, TurnTools | null, string]> = [
                ['another platform', { ...checkpoint, platform: 'openai' }, turnTools, 'Cannot resume a openai checkpoint'],
                ['a foreign state', { ...checkpoint, state: { kind: 'openai-tool-loop', messages: [] } }, turnTools, 'does not hold a Gemini tool loop state'],
                ['a state of the wrong shape', { ...checkpoint, state: { ...asRecord(checkpoint.state), loop: { roundNumber: '2' } } }, turnTools, 'does not hold a Gemini tool loop state'],
                ['a mismatched count', { ...checkpoint, completedRounds: 4 }, turnTools, 'keeps 4 round(s) but its loop opens round 2'],
                ['no tools', checkpoint, null, 'runs no client tools'],
            ];
            for (const [label, broken, tools, message] of attempts) {
                reset([answer('never sent')]);
                const rejected = await runTurn({ resumeFrom: broken, tools });
                expect(errorMessage(rejected.error).includes(message), `${label}: rejected (got ${errorMessage(rejected.error)})`);
                expect(rejected.chunks.length === 0 && vertex.requests.length === 0, `${label}: nothing yielded, nothing sent`);
            }
        },
    },
    {
        name: "a resumed round never takes round 1's 400 fallback",
        body: async () => {
            reset([callsRound('r1', [{ name: 'lookup_a' }]), httpErrorReply(400, BAD_REQUEST)]);
            const checkpoint = lastCheckpoint(await runTurn());

            reset([
                httpErrorReply(400, `Invalid JSON payload received. Unknown name "$schema" at 'tools[2].function_declarations[0].parameters'`),
                answer('never sent'),
            ]);
            const rejected = await runTurn({ resumeFrom: checkpoint });
            expect(
                asRecord(rejected.error).status === 400 && vertex.requests.length === 1,
                `the 400 ends the resume, no request without the declarations (got ${vertex.requests.length})`
            );
        },
    },
    {
        name: 'Priority PayGo: the header rides the resumed rounds when this call asks for it, and only then',
        body: async () => {
            reset([callsRound('r1', [{ name: 'lookup_a' }]), httpErrorReply(400, BAD_REQUEST)]);
            const checkpoint = lastCheckpoint(await runTurn({ serviceTier: 'priority' }));

            reset([callsRound('r2', [{ name: 'lookup_b' }]), answer('Priority answer.')]);
            const usageSink = createUsageSink();
            const withPriority = await runTurn({ resumeFrom: checkpoint, serviceTier: 'priority', usageSink });
            expect(
                withPriority.requests.length === 2 &&
                    withPriority.requests.every((request) => request.headers['x-vertex-ai-llm-shared-request-type'] === 'priority'),
                'every resumed round asks for priority'
            );
            expect(usageSink.totals().tierRequested === 'priority', 'and the sink knows it was asked for');

            reset([answer('Standard answer.')]);
            const without = await runTurn({ resumeFrom: checkpoint });
            expect(
                without.requests[0]?.headers['x-vertex-ai-llm-shared-request-type'] === undefined,
                'a resume that does not ask for it sends no header, whatever the interrupted reply asked'
            );
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
reportResults(results);
