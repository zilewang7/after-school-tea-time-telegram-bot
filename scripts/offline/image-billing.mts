/**
 * Offline cases for the image models' billing record (design 2026-1116-1500
 * §2.3 / D4 / D5): each successful generate_image call reports the image model
 * and its round usage into the attempt's metrics draft — a call-billed model
 * as a count only — failures are not recorded, and the finalize row's
 * imageGenerationUsage JSON carries exactly what the draft collected.
 *
 * The image model is a stub sendMessage: it reports usage through the sink the
 * tool put on the platform config, exactly as the Gemini platform does, and it
 * answers the generation with one picture. The draft is the real one, so the
 * aggregation and the finalize row are the production path.
 *
 * Run: npx tsx scripts/offline/image-billing.mts
 */
import {
    OFFLINE_CHAT_ID,
    expect,
    reportResults,
    runCase,
    setupOfflineDb,
    takeMessageId,
    type CaseResult,
} from './harness.mts';
import { createUnusedApi } from './fake-telegram.mts';
import type { ToolHandler, ToolResult } from '../../src/ai/tools/tool-types.js';
import type { PlatformConfig, StreamChunk, UnifiedMessage } from '../../src/ai/types.js';
import type { RoundUsage } from '../../src/ai/usage/usage-types.js';
import type { ContextIndex } from '../../src/reply/context-index.js';
import type { AnimationFrameLoader } from '../../src/reply/tools/animation-frame.js';
import type { ImageFetch } from '../../src/reply/tools/image-source-download.js';
import type { MessageImageLoader } from '../../src/reply/tools/image-references.js';
import type { ReplyMediaState } from '../../src/reply/tools/reply-media-state.js';
import type { ReplyMetricRecord } from '../../src/db/queries/reply-metrics.js';
import type { ReplyMetricsDraft } from '../../src/services/reply-metrics-draft.js';

await setupOfflineDb();

const { createGenerateImageTool } = await import('../../src/reply/tools/generate-image-tool.js');
const { createReplyMediaState } = await import('../../src/reply/tools/reply-media-state.js');
const { createReplyMetricsDraft, recordImageGeneration } = await import(
    '../../src/services/reply-metrics-draft.js'
);
const { recordReplyMetric } = await import('../../src/services/reply-metric-record.js');
const { findReplyMetricsByReply } = await import('../../src/db/queries/reply-metrics.js');
const { ReplyMetric } = await import('../../src/db/replyMetricDTO.js');
const { GEMINI_IMAGE_MODEL, OPENAI_IMAGE_MODEL } = await import('../../src/config/models.js');

const USER_ID = 5150;
const json = (value: unknown): string => JSON.stringify(value);

const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlZkAAAAASUVORK5CYII=',
    'base64'
);

/** Run `body` with console output captured instead of printed */
const captureConsole = async <T,>(body: () => Promise<T>): Promise<T> => {
    const original = { log: console.log, warn: console.warn, error: console.error };
    const record = (...args: unknown[]): void => {
        void args;
    };
    console.log = record;
    console.warn = record;
    console.error = record;
    try {
        return await body();
    } finally {
        console.log = original.log;
        console.warn = original.warn;
        console.error = original.error;
    }
};

// ---- the image model: a stub sendMessage that reports usage through the sink ----

interface ImageRequest {
    readonly messages: UnifiedMessage[];
    readonly config: PlatformConfig;
}

interface StubImageModelOptions {
    /**
     * One entry per request: the usage the platform would report. `null` is a
     * round that reported nothing; the last entry repeats for later requests.
     */
    readonly reports?: readonly (RoundUsage | null)[];
    /** Thrown instead of answering, e.g. the 429 the tool words as busy */
    readonly failWith?: Error;
}

/** The image model's answer: one picture and the closing done chunk */
const imageAnswer = (): readonly StreamChunk[] => [
    { type: 'image', imageData: PNG_BYTES, imageMimeType: 'image/png' },
    { type: 'done', rawResponse: { candidates: [{ finishReason: 'STOP' }] } },
];

const stubImageModel = (options: StubImageModelOptions = {}) => {
    const requests: ImageRequest[] = [];
    const sendMessage = async (
        messages: UnifiedMessage[],
        config: PlatformConfig
    ): Promise<AsyncIterable<StreamChunk>> => {
        requests.push({ messages, config });
        if (options.failWith !== undefined) throw options.failWith;
        const reports = options.reports ?? [];
        const report = reports[requests.length - 1] ?? reports.at(-1) ?? null;
        // A platform reports each finished round; null still counts as a round
        config.usageSink?.addRound(report);
        return (async function* (): AsyncGenerator<StreamChunk> {
            yield* imageAnswer();
        })();
    };
    return { sendMessage, requests };
};

/** One Gemini image round: prompt text, thoughts and one 1K image's tokens */
const generation = (promptTokens: number, thoughtsTokens: number, imageTokens: number): RoundUsage => ({
    promptTokens,
    cachedTokens: 0,
    cacheWriteTokens: null,
    outputTokens: thoughtsTokens + imageTokens,
    thoughtsTokens,
    imageOutputTokens: imageTokens,
});

// ---- the tool under test: the production tool, the stub model, the real draft ----

const noMessageImages: MessageImageLoader = async () => [];
const noAnimationFrame: AnimationFrameLoader = async () => null;
const noNetworkFetch: ImageFetch = async () => ({ ok: false, error: 'offline: no network' });
const NO_CONTEXT: ContextIndex = new Map();

const draftFor = (): ReplyMetricsDraft =>
    createReplyMetricsDraft({ model: 'gemini-4-hydrogen', commandType: 'chat', triggerUserId: USER_ID, accessTier: 'trial' });

const toolFor = (
    draft: ReplyMetricsDraft | null,
    model: ReturnType<typeof stubImageModel>,
    state: ReplyMediaState = createReplyMediaState()
): ToolHandler =>
    createGenerateImageTool(
        {
            chatId: OFFLINE_CHAT_ID,
            chatTitle: '测试群',
            triggerMessageId: 1,
            requester: { userId: USER_ID, name: '张三' },
            contextIndex: NO_CONTEXT,
            signal: new AbortController().signal,
            api: createUnusedApi(),
        },
        state,
        {
            dependencies: {
                sendMessage: model.sendMessage,
                loadMessageImages: noMessageImages,
                loadAnimationFrame: noAnimationFrame,
                fetchImage: noNetworkFetch,
            },
            // What create-reply-tools hands the tool when the reply collects usage
            ...(draft === null
                ? {}
                : {
                      recordImageGeneration: (imageModel: string, usage: RoundUsage | null): void =>
                          recordImageGeneration(draft, imageModel, usage),
                  }),
        }
    );

const runTool = async (tool: ToolHandler, args: Record<string, unknown> = { prompt: '一只猫' }): Promise<ToolResult> =>
    captureConsole(() => tool.execute(args, new AbortController().signal));

const entriesOf = (draft: ReplyMetricsDraft): string => json(draft.imageGenerations);

/** The entry a reply would store for these generations; every field stated */
const entryOf = (fields: {
    readonly model: string;
    readonly generations: number;
    readonly generationsWithUsage: number;
    readonly promptTokens: number | null;
    readonly cachedTokens: number | null;
    readonly cacheWriteTokens: number | null;
    readonly outputTokens: number | null;
    readonly thoughtsTokens: number | null;
    readonly imageOutputTokens: number | null;
}) => ({
    model: fields.model,
    generations: fields.generations,
    generationsWithUsage: fields.generationsWithUsage,
    promptTokens: fields.promptTokens,
    cachedTokens: fields.cachedTokens,
    cacheWriteTokens: fields.cacheWriteTokens,
    outputTokens: fields.outputTokens,
    thoughtsTokens: fields.thoughtsTokens,
    imageOutputTokens: fields.imageOutputTokens,
});

/** The draft's one generation as the row would store it */
const recordRow = async (
    draft: ReplyMetricsDraft
): Promise<{
    readonly row: ReplyMetricRecord | undefined;
    readonly firstMessageId: number;
    readonly raw: { readonly imageGenerationUsage: string | null } | null;
}> => {
    const firstMessageId = takeMessageId();
    await recordReplyMetric(
        {
            chatId: OFFLINE_CHAT_ID,
            userMessageId: firstMessageId - 1,
            firstMessageId,
            model: 'gemini-4-hydrogen',
            isRetry: false,
            textBuffer: '画好了',
            images: [],
            metrics: draft,
        },
        { versionId: 1, errorMessage: undefined, errorKind: undefined, wasStoppedByUser: false, finishedAt: new Date() }
    );
    const [row] = await findReplyMetricsByReply(OFFLINE_CHAT_ID, firstMessageId);
    const raw = await ReplyMetric.findOne({ where: { chatId: OFFLINE_CHAT_ID, firstMessageId } });
    return { row, firstMessageId, raw };
};

// ---- cases ----

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'one banana generation records the image model and its round usage',
        body: async () => {
            const draft = draftFor();
            const model = stubImageModel({ reports: [generation(39, 654, 1120)] });
            const result = await runTool(toolFor(draft, model));

            expect(!result.isError, `the generation succeeded (got ${json(result.content)})`);
            expect(
                model.requests.length === 1 && model.requests[0]?.config.usageSink !== undefined,
                'a usage sink rode the image request'
            );
            const expected = entryOf({
                model: GEMINI_IMAGE_MODEL,
                generations: 1,
                generationsWithUsage: 1,
                promptTokens: 39,
                cachedTokens: 0,
                cacheWriteTokens: null,
                outputTokens: 1774,
                thoughtsTokens: 654,
                imageOutputTokens: 1120,
            });
            expect(
                entriesOf(draft) === json([expected]),
                `one entry with the round's tokens (got ${entriesOf(draft)})`
            );
        },
    },
    {
        name: 'two generations of one model add up: counts and every token field',
        body: async () => {
            const draft = draftFor();
            const model = stubImageModel({ reports: [generation(39, 654, 1120), generation(41, 898, 1166)] });
            const tool = toolFor(draft, model);
            await runTool(tool);
            await runTool(tool);

            const expected = entryOf({
                model: GEMINI_IMAGE_MODEL,
                generations: 2,
                generationsWithUsage: 2,
                promptTokens: 80,
                cachedTokens: 0,
                cacheWriteTokens: null,
                outputTokens: 3838,
                thoughtsTokens: 1552,
                imageOutputTokens: 2286,
            });
            expect(
                entriesOf(draft) === json([expected]),
                `the two rounds are summed (got ${entriesOf(draft)})`
            );
        },
    },
    {
        name: 'a generation whose round reports no usage counts without tokens',
        body: async () => {
            const draft = draftFor();
            const model = stubImageModel({ reports: [null] });
            const result = await runTool(toolFor(draft, model));

            expect(!result.isError, 'the generation succeeded');
            const expected = entryOf({
                model: GEMINI_IMAGE_MODEL,
                generations: 1,
                generationsWithUsage: 0,
                promptTokens: null,
                cachedTokens: null,
                cacheWriteTokens: null,
                outputTokens: null,
                thoughtsTokens: null,
                imageOutputTokens: null,
            });
            expect(
                entriesOf(draft) === json([expected]),
                `the count is kept, the tokens stay null (got ${entriesOf(draft)})`
            );
        },
    },
    {
        name: 'a failed generation is not recorded',
        body: async () => {
            const draft = draftFor();
            const model = stubImageModel({ failWith: new Error('生图服务繁忙（429），可以稍后重试') });
            const result = await runTool(toolFor(draft, model));

            expect(result.isError, 'the tool reports the failure back to the model');
            expect(
                model.requests.length === 1 && model.requests[0]?.config.usageSink !== undefined,
                'a sink rode the failed request'
            );
            expect(entriesOf(draft) === '[]', `nothing was recorded (got ${entriesOf(draft)})`);
        },
    },
    {
        name: 'a generation with no recorder is not priced: no sink rides the request',
        body: async () => {
            const model = stubImageModel({ reports: [generation(39, 654, 1120)] });
            const result = await runTool(toolFor(null, model));

            expect(!result.isError, 'the generation succeeded');
            expect(
                model.requests.length === 1 && model.requests[0]?.config.usageSink === undefined,
                'no sink is created when nobody collects usage'
            );
        },
    },
    {
        name: 'gpt is call-billed: only the count is recorded, no sink rides its request',
        body: async () => {
            const draft = draftFor();
            // The relay may report usage, but a call-billed model is priced per image
            const model = stubImageModel({ reports: [generation(39, 654, 1120)] });
            const result = await runTool(toolFor(draft, model), { prompt: '一只猫', model: 'gpt' });

            expect(!result.isError, 'the generation succeeded');
            expect(
                model.requests.length === 1 && model.requests[0]?.config.usageSink === undefined,
                'a call-billed model must not carry a usage sink'
            );
            const expected = entryOf({
                model: OPENAI_IMAGE_MODEL,
                generations: 1,
                generationsWithUsage: 0,
                promptTokens: null,
                cachedTokens: null,
                cacheWriteTokens: null,
                outputTokens: null,
                thoughtsTokens: null,
                imageOutputTokens: null,
            });
            expect(entriesOf(draft) === json([expected]), `count only (got ${entriesOf(draft)})`);
        },
    },
    {
        name: 'banana and gpt in one reply are grouped per model',
        body: async () => {
            const draft = draftFor();
            const model = stubImageModel({ reports: [generation(39, 654, 1120)] });
            const tool = toolFor(draft, model);
            await runTool(tool, { prompt: '香蕉画的', model: 'banana' });
            await runTool(tool, { prompt: 'gpt 画的', model: 'gpt' });

            const banana = entryOf({
                model: GEMINI_IMAGE_MODEL,
                generations: 1,
                generationsWithUsage: 1,
                promptTokens: 39,
                cachedTokens: 0,
                cacheWriteTokens: null,
                outputTokens: 1774,
                thoughtsTokens: 654,
                imageOutputTokens: 1120,
            });
            const gpt = entryOf({
                model: OPENAI_IMAGE_MODEL,
                generations: 1,
                generationsWithUsage: 0,
                promptTokens: null,
                cachedTokens: null,
                cacheWriteTokens: null,
                outputTokens: null,
                thoughtsTokens: null,
                imageOutputTokens: null,
            });
            expect(
                entriesOf(draft) === json([banana, gpt]),
                `one entry per model, first-seen order (got ${entriesOf(draft)})`
            );
        },
    },
    {
        name: 'at most five pictures: the refused sixth is not recorded',
        body: async () => {
            const draft = draftFor();
            const model = stubImageModel({
                reports: Array.from({ length: 5 }, () => generation(39, 654, 1120)),
            });
            const tool = toolFor(draft, model);
            for (let index = 0; index < 5; index += 1) {
                const drawn = await runTool(tool, { prompt: `第 ${index + 1} 张` });
                expect(!drawn.isError, `picture ${index + 1} was drawn`);
            }
            const refused = await runTool(tool, { prompt: '第六张' });

            expect(refused.isError, 'the sixth call is refused');
            expect(model.requests.length === 5, `no sixth request went out (got ${model.requests.length})`);
            expect(
                entriesOf(draft) ===
                    json([
                        entryOf({
                            model: GEMINI_IMAGE_MODEL,
                            generations: 5,
                            generationsWithUsage: 5,
                            promptTokens: 195,
                            cachedTokens: 0,
                            cacheWriteTokens: null,
                            outputTokens: 8870,
                            thoughtsTokens: 3270,
                            imageOutputTokens: 5600,
                        }),
                    ]),
                `five generations are recorded (got ${entriesOf(draft)})`
            );
        },
    },
    {
        name: 'finalize writes imageGenerationUsage: the draft JSON on the row, NULL without generations',
        body: async () => {
            const draft = draftFor();
            const model = stubImageModel({ reports: [generation(39, 654, 1120)] });
            await runTool(toolFor(draft, model));

            const drawn = await recordRow(draft);
            expect(
                drawn.row !== undefined && json(drawn.row.imageGenerationUsage) === entriesOf(draft),
                `the row carries the draft's entries (got ${json(drawn.row?.imageGenerationUsage)})`
            );
            expect(
                typeof drawn.raw?.imageGenerationUsage === 'string' && drawn.raw.imageGenerationUsage !== 'null',
                `the column stores the JSON text (got ${json(drawn.raw?.imageGenerationUsage)})`
            );

            const empty = await recordRow(draftFor());
            expect(
                empty.row !== undefined && empty.row.imageGenerationUsage.length === 0,
                `a reply without a generation reads back empty (got ${json(empty.row?.imageGenerationUsage)})`
            );
            expect(empty.raw?.imageGenerationUsage === null, 'and the column is NULL');
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
reportResults(results);
