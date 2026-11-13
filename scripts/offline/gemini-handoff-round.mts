/**
 * Offline cases for the Gemini hand-off round (design 2026-1113-0105 §5.2,
 * test plan §7.3): after the no-cost rounds are used up, a turn that offers
 * leave_handoff gets one more round with only that tool declared, and the
 * round after it is the plain final answer.
 *
 * The platform runs a real Vertex-mode SDK client over a fake fetch
 * (support/fake-vertex.mts), like gemini-round-recovery.mts.
 *
 * Run: npx tsx scripts/offline/gemini-handoff-round.mts
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import {
    createFakeVertex,
    httpErrorReply,
    sseReply,
    type RecordedRequest,
    type ScriptedReply,
} from './support/fake-vertex.mts';
import type { StreamChunk, UnifiedMessage } from '../../src/ai/types.js';
import type { ToolHandler, ToolResult, TurnTools } from '../../src/ai/tools/index.js';

delete process.env.GEMINI_CLIENT_TOOLS;

const { GeminiPlatform } = await import('../../src/ai/platforms/gemini-platform.js');
const { createTurnTools, FREE_TOOL_ROUNDS_MAX, TOOL_LOOP_DEADLINE_MS } = await import(
    '../../src/ai/tools/index.js'
);

type UsageSink = import('../../src/ai/usage/index.js').UsageSink;

const vertex = createFakeVertex();

class RecordingGeminiPlatform extends GeminiPlatform {
    protected override sleep(_ms: number, signal?: AbortSignal): Promise<void> {
        return signal?.aborted ? Promise.reject(new Error('Aborted')) : Promise.resolve();
    }
}

const platform = new RecordingGeminiPlatform({ client: vertex.client, random: () => 0.5 });

// ---------------------------------------------------------------------------
// Fixtures (Vertex wire events, one round each)
// ---------------------------------------------------------------------------

const json = (value: unknown): string => JSON.stringify(value);

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : {};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const signature = (label: string): string => Buffer.from(`signature-${label}`).toString('base64');

const USAGE = {
    promptTokenCount: 100,
    cachedContentTokenCount: 40,
    candidatesTokenCount: 7,
    thoughtsTokenCount: 3,
    totalTokenCount: 110,
};

const event = (parts: readonly unknown[], finishReason?: string) => ({
    candidates: [
        {
            content: { role: 'model', parts },
            ...(finishReason === undefined ? {} : { finishReason }),
        },
    ],
    ...(finishReason === undefined ? {} : { usageMetadata: USAGE, modelVersion: 'offline-model' }),
});

const thoughtPart = (text: string) => ({ text, thought: true });
const textPart = (text: string) => ({ text });
const callPart = (name: string, args: Record<string, unknown>, label: string) => ({
    functionCall: { id: `call_${label}`, name, args },
    thoughtSignature: signature(label),
});

const roundEvents = (rounds: readonly unknown[][]): unknown[] =>
    rounds.map((parts, index) => event(parts, index === rounds.length - 1 ? 'STOP' : undefined));

const answer = (text: string): ScriptedReply => sseReply(roundEvents([[thoughtPart('plan')], [textPart(text)]]));

const callRound = (name: string, args: Record<string, unknown>, label: string): ScriptedReply =>
    sseReply(roundEvents([[thoughtPart(`plan ${label}`)], [callPart(name, args, label), textPart('')]]));

const malformedRound = (): ScriptedReply => sseReply([event([textPart('')], 'MALFORMED_FUNCTION_CALL')]);

// ---------------------------------------------------------------------------
// Fake tools
// ---------------------------------------------------------------------------

const executions: string[] = [];
let afterChargedCall: (() => void) | null = null;

const okResult = (content: string): ToolResult => ({ content, isError: false, images: [], record: null });

const emptySchema = { type: 'object', properties: {} };

const chargedTool = (name: string, content: string): ToolHandler => ({
    definition: { name, description: `The ${name} tool`, inputSchema: emptySchema },
    execute: async () => {
        executions.push(name);
        afterChargedCall?.();
        return okResult(content);
    },
});

const freeTool = (name: string, content: string): ToolHandler => ({
    definition: { name, description: `The ${name} tool`, inputSchema: emptySchema },
    execute: async () => {
        executions.push(name);
        return okResult(content);
    },
});

const lookupTool = chargedTool('lookup_a', 'the key is K-1');
const sendFileTool = freeTool('send_file', 'file sent');
const leaveHandoffTool = freeTool('leave_handoff', '已写入交接文档 handoff.md');

const turnTools = createTurnTools([lookupTool, sendFileTool]);
const turnToolsWithHandoff = createTurnTools([lookupTool, sendFileTool, leaveHandoffTool]);

// ---------------------------------------------------------------------------
// Request-body readers
// ---------------------------------------------------------------------------

const declarationNames = (request: RecordedRequest | undefined): string[] =>
    asArray(asRecord(request?.body).tools)
        .map(asRecord)
        .flatMap((tool) => asArray(tool.functionDeclarations))
        .map((declaration) => asRecord(declaration).name)
        .filter((name): name is string => typeof name === 'string');

const isModeNone = (request: RecordedRequest | undefined): boolean =>
    asRecord(asRecord(asRecord(request?.body).toolConfig).functionCallingConfig).mode === 'NONE';

interface FunctionResponseView {
    readonly name: string;
    readonly output: string;
    readonly notice: string;
}

const functionResponsesOf = (request: RecordedRequest | undefined): FunctionResponseView[] =>
    asArray(asRecord(request?.body).contents)
        .map(asRecord)
        .flatMap((content) => asArray(content.parts))
        .map(asRecord)
        .filter((part) => part.functionResponse !== undefined)
        .map((part) => asRecord(part.functionResponse))
        .map((response) => ({
            name: typeof response.name === 'string' ? response.name : '',
            output: typeof asRecord(response.response).output === 'string' ? String(asRecord(response.response).output) : '',
            notice:
                typeof asRecord(response.response).notice === 'string' ? String(asRecord(response.response).notice) : '',
        }));

// ---------------------------------------------------------------------------
// Turn runner
// ---------------------------------------------------------------------------

interface TurnOptions {
    readonly tools?: TurnTools;
    readonly signal?: AbortSignal;
    readonly usageSink?: UsageSink;
    readonly onChunk?: (chunk: StreamChunk) => void;
    readonly checkpoints?: unknown[];
}

interface TurnResult {
    readonly chunks: StreamChunk[];
    readonly lines: string[];
    readonly error: unknown;
}

const userTurn = (text: string): UnifiedMessage[] => [{ role: 'user', content: [{ type: 'text', text }] }];

const runTurn = async (options: TurnOptions = {}): Promise<TurnResult> => {
    const lines: string[] = [];
    const chunks: StreamChunk[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    const record = (...args: unknown[]): void => {
        lines.push(args.map((arg) => (arg instanceof Error ? arg.message : typeof arg === 'string' ? arg : json(arg))).join(' '));
    };
    console.log = record;
    console.warn = record;
    console.error = record;
    let error: unknown = null;
    try {
        const stream = await platform.sendMessage(userTurn('Please finish the task.'), {
            model: 'gemini-3.8-flash',
            systemPrompt: 'offline system prompt',
            maxRetries: 3,
            tools: options.tools ?? turnToolsWithHandoff,
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.usageSink ? { usageSink: options.usageSink } : {}),
            ...(options.checkpoints
                ? { checkpointSink: (checkpoint: unknown) => options.checkpoints?.push(checkpoint) }
                : {}),
        });
        for await (const chunk of stream) {
            chunks.push(chunk);
            options.onChunk?.(chunk);
        }
    } catch (caught) {
        error = caught;
    } finally {
        Object.assign(console, original);
    }
    return { chunks, lines, error };
};

const textOf = (chunks: readonly StreamChunk[]): string =>
    chunks
        .filter((chunk) => chunk.type === 'text')
        .map((chunk) => chunk.content ?? '')
        .join('');

const doneUsageOf = (chunks: readonly StreamChunk[]): string[] => {
    const done = chunks.find((chunk) => chunk.type === 'done');
    return (done?.agentStats?.toolUsage ?? []).map((usage) => usage.name);
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

const withFakeClock = async (body: (jump: (milliseconds: number) => void) => Promise<void>): Promise<void> => {
    const realNow = Date.now;
    let offsetMs = 0;
    Date.now = () => realNow() + offsetMs;
    try {
        await body((milliseconds) => {
            offsetMs += milliseconds;
        });
    } finally {
        Date.now = realNow;
    }
};

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const freeRoundScript = (): ScriptedReply[] =>
    Array.from({ length: FREE_TOOL_ROUNDS_MAX }, (_unused, index) => callRound('send_file', {}, `free${index}`));

const reset = (replies: readonly ScriptedReply[]): void => {
    vertex.reset(replies);
    executions.length = 0;
    afterChargedCall = null;
};

const cases: Array<{ name: string; body: () => Promise<void> }> = [
    {
        name: 'without leave_handoff nothing changes: the no-cost cap still leads straight to the final round',
        body: async () => {
            await withFakeClock(async (jump) => {
                reset([callRound('lookup_a', {}, 'r1'), ...freeRoundScript(), answer('Done.')]);
                afterChargedCall = () => jump(TOOL_LOOP_DEADLINE_MS + 1000);

                const { chunks, error } = await runTurn({ tools: turnTools });

                expect(error === null, `the reply finishes (got ${errorMessage(error)})`);
                expect(vertex.requests.length === 1 + FREE_TOOL_ROUNDS_MAX + 1, `rounds 1 + free + final (got ${vertex.requests.length})`);
                const final = vertex.requests.at(-1);
                expect(isModeNone(final), 'the last round is the final round (mode NONE)');
                expect(declarationNames(final).length === 2, 'the final round carries the whole declaration list');
                expect(
                    !vertex.requests.some((request) => declarationNames(request).includes('leave_handoff')),
                    'the tool is never declared'
                );
                expect(textOf(chunks) === 'Done.', 'the final text is the answer');
            });
        },
    },
    {
        name: 'the no-cost cap offers the hand-off round: only leave_handoff is declared, and the answer ends it',
        body: async () => {
            await withFakeClock(async (jump) => {
                reset([callRound('lookup_a', {}, 'r1'), ...freeRoundScript(), answer('Handoff round answer.')]);
                afterChargedCall = () => jump(TOOL_LOOP_DEADLINE_MS + 1000);

                const { chunks, error } = await runTurn({ tools: turnToolsWithHandoff });

                expect(error === null, `the reply finishes (got ${errorMessage(error)})`);
                expect(
                    vertex.requests.length === 1 + FREE_TOOL_ROUNDS_MAX + 1,
                    `no extra round after an answer in the hand-off round (got ${vertex.requests.length})`
                );
                const handoff = vertex.requests[1 + FREE_TOOL_ROUNDS_MAX];
                expect(handoff !== undefined && !isModeNone(handoff), 'the hand-off round is not the final round');
                expect(json(declarationNames(handoff)) === '["leave_handoff"]', `only leave_handoff is declared (got ${json(declarationNames(handoff))})`);
                const lastFreeRound = vertex.requests[FREE_TOOL_ROUNDS_MAX];
                const notices = functionResponsesOf(handoff).map((response) => response.notice);
                expect(
                    notices.some((notice) => notice.includes('except leave_handoff')),
                    `the free round's responses point at the handoff tool (got ${json(notices)})`
                );
                const outputs = functionResponsesOf(handoff).map((response) => response.output);
                expect(
                    outputs.some((output) => output.includes('免费轮次') || output.includes('leave_handoff')),
                    `the round notice tells the model what is left (got ${json(outputs)})`
                );
                expect(lastFreeRound !== undefined, 'the fifth no-cost round was sent');
                expect(textOf(chunks) === 'Handoff round answer.', 'the hand-off round answer is the reply');
            });
        },
    },
    {
        name: 'a hand-off call really runs, is answered for real, and one final round writes the answer',
        body: async () => {
            await withFakeClock(async (jump) => {
                reset([
                    callRound('lookup_a', {}, 'r1'),
                    ...freeRoundScript(),
                    callRound('leave_handoff', { content: 'next: write section three' }, 'h1'),
                    answer('Final answer.'),
                ]);
                afterChargedCall = () => jump(TOOL_LOOP_DEADLINE_MS + 1000);

                const { chunks, error } = await runTurn({ tools: turnToolsWithHandoff });

                expect(error === null, `the reply finishes (got ${errorMessage(error)})`);
                expect(vertex.requests.length === 1 + FREE_TOOL_ROUNDS_MAX + 2, `the answer round follows (got ${vertex.requests.length})`);
                expect(
                    json(executions.filter((name) => name === 'leave_handoff')) === '["leave_handoff"]',
                    `the tool ran once (got ${json(executions)})`
                );
                const answerRound = vertex.requests.at(-1);
                expect(isModeNone(answerRound), 'the answer round is the final round');
                expect(declarationNames(answerRound).length === 3, 'the final round carries the whole declaration list again');
                const handoffResponses = functionResponsesOf(answerRound).filter((response) => response.name === 'leave_handoff');
                expect(handoffResponses.length === 1, 'the call is answered');
                expect(handoffResponses[0]?.output.includes('已写入交接文档'), 'the model reads the real tool result');
                expect(handoffResponses[0]?.notice.includes('answer the user now'), 'the answer-now notice rides along');
                expect(json(doneUsageOf(chunks)).includes('leave_handoff'), 'the reply usage counts the call');
                expect(textOf(chunks) === 'Final answer.', 'the answer round writes the reply');
            });
        },
    },
    {
        name: 'the answer round can no longer call anything',
        body: async () => {
            await withFakeClock(async (jump) => {
                reset([
                    callRound('lookup_a', {}, 'r1'),
                    ...freeRoundScript(),
                    callRound('leave_handoff', { content: 'note' }, 'h1'),
                    sseReply(roundEvents([[thoughtPart('again')], [callPart('lookup_a', {}, 'late'), textPart('Answer with a stray call.')]])),
                ]);
                afterChargedCall = () => jump(TOOL_LOOP_DEADLINE_MS + 1000);

                const { chunks, lines, error } = await runTurn({ tools: turnToolsWithHandoff });

                expect(error === null, `the reply finishes (got ${errorMessage(error)})`);
                expect(
                    json(executions.filter((name) => name === 'lookup_a')) === '["lookup_a"]',
                    `the late call never runs (got ${json(executions)})`
                );
                expect(textOf(chunks) === 'Answer with a stray call.', 'its text is still the answer');
                expect(lines.some((line) => line.includes('still asked for')), 'the stray call is logged and ignored');
            });
        },
    },
    {
        name: 'a 400 on the hand-off round falls back to the plain final round instead of failing the reply',
        body: async () => {
            await withFakeClock(async (jump) => {
                reset([
                    callRound('lookup_a', {}, 'r1'),
                    ...freeRoundScript(),
                    httpErrorReply(400, 'unexpected request'),
                    answer('Fallback answer.'),
                ]);
                afterChargedCall = () => jump(TOOL_LOOP_DEADLINE_MS + 1000);

                const { chunks, lines, error } = await runTurn({ tools: turnToolsWithHandoff });

                expect(error === null, `the reply finishes (got ${errorMessage(error)})`);
                expect(vertex.requests.length === 1 + FREE_TOOL_ROUNDS_MAX + 2, `one downgraded final round (got ${vertex.requests.length})`);
                expect(lines.some((line) => line.includes('[handoff] round rejected (400)')), 'the downgrade is logged');
                expect(isModeNone(vertex.requests.at(-1)), 'the downgraded round is the final round');
                expect(textOf(chunks) === 'Fallback answer.', 'the reply is delivered');
            });
        },
    },
    {
        name: 'a malformed hand-off round ends at the final round, never opens another hand-off round',
        body: async () => {
            await withFakeClock(async (jump) => {
                reset([
                    callRound('lookup_a', {}, 'r1'),
                    ...freeRoundScript(),
                    malformedRound(),
                    answer('After malformed.'),
                ]);
                afterChargedCall = () => jump(TOOL_LOOP_DEADLINE_MS + 1000);

                const { chunks, error } = await runTurn({ tools: turnToolsWithHandoff });

                expect(error === null, `the reply finishes (got ${errorMessage(error)})`);
                expect(vertex.requests.length === 1 + FREE_TOOL_ROUNDS_MAX + 2, `one final round only (got ${vertex.requests.length})`);
                const afterMalformed = vertex.requests.at(-1);
                expect(isModeNone(afterMalformed), 'the follow-up is a plain final round');
                expect(textOf(chunks) === 'After malformed.', 'the final text is delivered');
            });
        },
    },
    {
        name: 'after the hand-off call the checkpoint already points at the answer round',
        body: async () => {
            await withFakeClock(async (jump) => {
                const checkpoints: unknown[] = [];
                reset([
                    callRound('lookup_a', {}, 'r1'),
                    ...freeRoundScript(),
                    callRound('leave_handoff', { content: 'note' }, 'h1'),
                    answer('Done.'),
                ]);
                afterChargedCall = () => jump(TOOL_LOOP_DEADLINE_MS + 1000);

                const { error } = await runTurn({ tools: turnToolsWithHandoff, checkpoints });

                expect(error === null, `the reply finishes (got ${errorMessage(error)})`);
                const states = checkpoints.map((checkpoint) => asRecord(asRecord(checkpoint).state).loop).map(asRecord);
                const answerState = states.find((loop) => asRecord(loop.request).final === true && loop.handoffRound === false);
                expect(answerState !== undefined, 'a checkpoint points at the final answer round');
                expect(answerState?.mayAskAgain === false, 'the answer round is the last word');
                const loops = states.map((loop) => loop.handoffRound);
                expect(loops.includes(true), 'a checkpoint keeps the hand-off round for a resume');
            });
        },
    },
    {
        name: 'a stop inside the hand-off call keeps the hand-off round checkpoint and sends no answer',
        body: async () => {
            await withFakeClock(async (jump) => {
                const controller = new AbortController();
                const checkpoints: unknown[] = [];
                const stopTool: ToolHandler = {
                    definition: { name: 'leave_handoff', description: 'stop here', inputSchema: emptySchema },
                    execute: async () => {
                        executions.push('leave_handoff');
                        controller.abort();
                        return okResult('stopped while writing');
                    },
                };
                const tools = createTurnTools([lookupTool, sendFileTool, stopTool]);
                reset([
                    callRound('lookup_a', {}, 'r1'),
                    ...freeRoundScript(),
                    callRound('leave_handoff', { content: 'note' }, 'h1'),
                    answer('never sent'),
                ]);
                afterChargedCall = () => jump(TOOL_LOOP_DEADLINE_MS + 1000);

                const { chunks, error } = await runTurn({
                    tools,
                    signal: controller.signal,
                    checkpoints,
                });

                expect(error === null, `a stopped reply ends without an error (got ${errorMessage(error)})`);
                expect(vertex.requests.length === 1 + FREE_TOOL_ROUNDS_MAX + 1, `no answer round is sent (got ${vertex.requests.length})`);
                expect(textOf(chunks) !== 'never sent', 'the scripted answer never ran');
                const states = checkpoints.map((checkpoint) => asRecord(asRecord(checkpoint).state).loop).map(asRecord);
                const handoffKept = states.find((loop) => asRecord(loop.request).final === false && loop.handoffRound === true);
                expect(handoffKept !== undefined, 'the checkpoint keeps the hand-off round');
                expect(
                    json(declarationNamesFromLoop(handoffKept)).includes('leave_handoff'),
                    `the kept request still declares only leave_handoff (got ${json(declarationNamesFromLoop(handoffKept))})`
                );
            });
        },
    },
];

/** Declaration names from a checkpoint's stored round request */
function declarationNamesFromLoop(loop: Record<string, unknown> | undefined): string[] {
    return asArray(asRecord(asRecord(loop).request).tools)
        .map(asRecord)
        .flatMap((tool) => asArray(tool.functionDeclarations))
        .map((declaration) => asRecord(declaration).name)
        .filter((name): name is string => typeof name === 'string');
}

const results: CaseResult[] = [];
for (const { name, body } of cases) {
    results.push(await runCase(name, body));
}
await reportResults(results);
