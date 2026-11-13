/**
 * Offline cases for token usage normalization and the cost estimate (design
 * §6.5, appendices A / B): every platform's raw usage shapes — both variants
 * where the field is still to be confirmed by a probe — mapped to the shared
 * meaning, estimateCostUsd per model, the price table, and the aggregation
 * SQL with its pricing flags, the per-model rollup and the priced share.
 * Then Priority PayGo (design §8.4): the priority part at the priority price,
 * the standard-price fallback of a model without one and its note, and both
 * sources of usage groups (the SQL aggregate and the reply detail) priced the
 * same way.
 *
 * Run: npx tsx scripts/offline/model-pricing.mts
 */
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';

await setupOfflineDb();
const {
    normalizeAnthropicUsage,
    normalizeChatCompletionsUsage,
    normalizeGeminiUsage,
    normalizeImagesUsage,
    normalizeResponsesUsage,
} = await import('../../src/ai/usage/index.js');
const { MODEL_PRICES, findModelPrice, SUBSCRIPTION_ROUTES } = await import('../../src/config/model-pricing.js');
const { estimateCostUsd, priceUsageGroup, rollupCostByModel, totalCost } = await import(
    '../../src/panel/stats/cost-estimate.js'
);
const { aggregateUsageByModelRoute, insertReplyMetric } = await import('../../src/db/queries/reply-metrics.js');
const { listReplyMetricsByReply } = await import('../../src/panel/views/reply-metrics-view.js');
const { OPENAI_IMAGE_MODEL } = await import('../../src/config/models.js');

type ReplyMetricInput = import('../../src/db/queries/reply-metrics.js').ReplyMetricInput;
type RoundUsage = import('../../src/ai/usage/index.js').RoundUsage;
type ModelPrice = import('../../src/config/model-pricing.js').ModelPrice;
type UsageTotals = import('../../src/panel/stats/cost-estimate.js').UsageTotals;

const json = (value: unknown): string => JSON.stringify(value);

const usage = (fields: Partial<RoundUsage>): RoundUsage => ({
    promptTokens: null,
    cachedTokens: null,
    cacheWriteTokens: null,
    outputTokens: null,
    thoughtsTokens: null,
    imageOutputTokens: null,
    ...fields,
});

const expectUsage = (actual: RoundUsage | null, expected: RoundUsage | null, label: string): void => {
    expect(json(actual) === json(expected), `${label} (got ${json(actual)})`);
};

/** Close enough for float sums of prices */
const near = (actual: number | null, expected: number): boolean =>
    actual !== null && Math.abs(actual - expected) < 1e-9;

const PRICED_CHAT = -1004400000001;
const OTHER_CHAT = -1004400000002;
const PRIORITY_CHAT = -1004400000003;
let nextFirstMessageId = 10_000;

const priceOf = (model: string): ModelPrice => {
    const found = findModelPrice(model);
    if (found === null) throw new Error(`${model} has no price`);
    return found;
};

/** Usage totals with nothing in them; each case says what it reports */
const ZERO_USAGE: UsageTotals = {
    promptTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    imageOutputTokens: 0,
    unsplitImageOutputTokens: 0,
    imagesWithoutUsage: 0,
    priorityPromptTokens: 0,
    priorityCachedTokens: 0,
    priorityOutputTokens: 0,
};

/** One million of each: a tier price reads straight off the cost */
const PER_MILLION = 1_000_000;

/** A stored row; tokens default to none, so each case says what it reports */
const metricRow = (fields: Partial<ReplyMetricInput>): ReplyMetricInput => {
    const startedAt = fields.startedAt ?? new Date(Date.now() - 60_000);
    nextFirstMessageId += 1;
    return {
        chatId: PRICED_CHAT,
        userMessageId: nextFirstMessageId - 1,
        firstMessageId: nextFirstMessageId,
        versionId: 1,
        triggerUserId: 42,
        model: 'gemini-4-argon',
        platform: 'gemini',
        route: null,
        commandType: 'chat',
        isRetry: false,
        startedAt,
        requestStartedAt: startedAt,
        firstChunkAt: startedAt,
        finishedAt: new Date(startedAt.getTime() + 5000),
        outcome: 'ok',
        errorKind: null,
        errorSummary: null,
        rounds: 1,
        toolCalls: 0,
        toolFailures: 0,
        toolUsage: [],
        promptTokens: null,
        cachedTokens: null,
        cacheWriteTokens: null,
        outputTokens: null,
        thoughtsTokens: null,
        imageOutputTokens: null,
        contextMessages: 3,
        contextImages: 0,
        textChars: 10,
        thinkingChars: 0,
        hasImage: false,
        imageCount: 0,
        hasSticker: false,
        hasFile: false,
        roundRetries: null,
        tierRequested: null,
        priorityRounds: null,
        priorityPromptTokens: null,
        priorityCachedTokens: null,
        priorityOutputTokens: null,
        resumedRounds: null,
        checkpointRounds: null,
        ...fields,
    };
};

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'Gemini: output = candidates + thoughts, prompt keeps the cache hits, IMAGE split only when listed',
        body: async () => {
            // The production sample from §3.4
            expectUsage(
                normalizeGeminiUsage({
                    promptTokenCount: 20831,
                    cachedContentTokenCount: 17947,
                    thoughtsTokenCount: 179,
                    candidatesTokenCount: 28,
                    totalTokenCount: 21038,
                }),
                usage({ promptTokens: 20831, cachedTokens: 17947, outputTokens: 207, thoughtsTokens: 179 }),
                'the production sample'
            );
            expectUsage(
                normalizeGeminiUsage({
                    promptTokenCount: 20,
                    candidatesTokenCount: 1130,
                    totalTokenCount: 1150,
                    candidatesTokensDetails: [
                        { modality: 'IMAGE', tokenCount: 1120 },
                        { modality: 'TEXT', tokenCount: 10 },
                    ],
                }),
                usage({ promptTokens: 20, cachedTokens: 0, outputTokens: 1130, thoughtsTokens: 0, imageOutputTokens: 1120 }),
                'an image reply: the IMAGE entries are the image output; omitted zero counts read as 0'
            );
            expectUsage(
                normalizeGeminiUsage({
                    promptTokenCount: 50,
                    candidatesTokenCount: 5,
                    candidatesTokensDetails: [{ modality: 'TEXT', tokenCount: 5 }],
                }),
                usage({ promptTokens: 50, cachedTokens: 0, outputTokens: 5, thoughtsTokens: 0, imageOutputTokens: 0 }),
                'a text reply with a modality list has 0 image output'
            );
            expectUsage(normalizeGeminiUsage(undefined), null, 'no usageMetadata is no usage');
            expectUsage(normalizeGeminiUsage({ trafficType: 'ON_DEMAND' }), null, 'a block without counts is no usage');
        },
    },
    {
        name: 'Gemini toolUsePromptTokenCount: inside the prompt when the total says so, added otherwise',
        body: async () => {
            const base = { promptTokenCount: 1000, candidatesTokenCount: 50, thoughtsTokenCount: 10, toolUsePromptTokenCount: 300 };
            expectUsage(
                normalizeGeminiUsage({ ...base, totalTokenCount: 1060 }),
                usage({ promptTokens: 1000, cachedTokens: 0, outputTokens: 60, thoughtsTokens: 10 }),
                'total = prompt + candidates + thoughts: already part of the prompt'
            );
            expectUsage(
                normalizeGeminiUsage({ ...base, totalTokenCount: 1360 }),
                usage({ promptTokens: 1300, cachedTokens: 0, outputTokens: 60, thoughtsTokens: 10 }),
                'total includes it on top: added to the prompt'
            );
            expectUsage(
                normalizeGeminiUsage(base),
                usage({ promptTokens: 1300, cachedTokens: 0, outputTokens: 60, thoughtsTokens: 10 }),
                'no total: the documented reading, added'
            );
        },
    },
    {
        name: 'Responses API (OpenAI, Grok): reasoning inside output unless the total shows otherwise',
        body: async () => {
            expectUsage(
                normalizeResponsesUsage({
                    input_tokens: 1000,
                    input_tokens_details: { cached_tokens: 800 },
                    output_tokens: 300,
                    output_tokens_details: { reasoning_tokens: 200 },
                    total_tokens: 1300,
                }),
                usage({ promptTokens: 1000, cachedTokens: 800, outputTokens: 300, thoughtsTokens: 200 }),
                'OpenAI: output_tokens already holds the reasoning'
            );
            expectUsage(
                normalizeResponsesUsage({
                    input_tokens: 1000,
                    input_tokens_details: { cached_tokens: 0 },
                    output_tokens: 100,
                    output_tokens_details: { reasoning_tokens: 200 },
                    total_tokens: 1300,
                }),
                usage({ promptTokens: 1000, cachedTokens: 0, outputTokens: 300, thoughtsTokens: 200 }),
                'xAI shape with reasoning outside output_tokens: added back'
            );
            expectUsage(
                normalizeResponsesUsage({ prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }),
                usage({ promptTokens: 12, outputTokens: 3 }),
                'a relay answering with chat.completions names'
            );
            expectUsage(normalizeResponsesUsage(null), null, 'a response without usage');
        },
    },
    {
        name: 'Anthropic: prompt = input + cache_read + cache_creation; the larger cumulative count wins',
        body: async () => {
            expectUsage(
                normalizeAnthropicUsage(
                    { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 1 },
                    { output_tokens: 420 }
                ),
                usage({ promptTokens: 1050, cachedTokens: 900, cacheWriteTokens: 50, outputTokens: 420 }),
                'official stream: input in message_start, cumulative output in the last message_delta'
            );
            expectUsage(
                normalizeAnthropicUsage(
                    { input_tokens: 0, output_tokens: 0 },
                    { input_tokens: 640, output_tokens: 88, output_tokens_details: { thinking_tokens: 60 } }
                ),
                usage({ promptTokens: 640, outputTokens: 88, thoughtsTokens: 60 }),
                'a converting relay that only fills message_delta, thinking tokens included'
            );
            expectUsage(
                normalizeAnthropicUsage({ input_tokens: 500, output_tokens: 1 }, { input_tokens: 0, output_tokens: 70 }),
                usage({ promptTokens: 500, outputTokens: 70 }),
                'a zeroed input count in message_delta never overrides message_start'
            );
            expectUsage(normalizeAnthropicUsage(undefined, undefined), null, 'no usage events at all');
        },
    },
    {
        name: 'chat.completions (DeepSeek, MiMo): DeepSeek cache split, OpenAI-shaped details, reasoning by the total',
        body: async () => {
            expectUsage(
                normalizeChatCompletionsUsage({
                    prompt_tokens: 1000,
                    prompt_cache_hit_tokens: 600,
                    prompt_cache_miss_tokens: 400,
                    completion_tokens: 250,
                    completion_tokens_details: { reasoning_tokens: 200 },
                    total_tokens: 1250,
                }),
                usage({ promptTokens: 1000, cachedTokens: 600, outputTokens: 250, thoughtsTokens: 200 }),
                'DeepSeek'
            );
            expectUsage(
                normalizeChatCompletionsUsage({
                    prompt_tokens: 400,
                    prompt_cache_hit_tokens: 600,
                    prompt_cache_miss_tokens: 400,
                    completion_tokens: 50,
                }),
                usage({ promptTokens: 1000, cachedTokens: 600, outputTokens: 50 }),
                'a prompt_tokens that left the hits out: hit + miss is the whole input'
            );
            expectUsage(
                normalizeChatCompletionsUsage({
                    prompt_tokens: 700,
                    prompt_tokens_details: { cached_tokens: 512 },
                    completion_tokens: 90,
                    completion_tokens_details: { reasoning_tokens: 60 },
                    total_tokens: 790,
                }),
                usage({ promptTokens: 700, cachedTokens: 512, outputTokens: 90, thoughtsTokens: 60 }),
                'MiMo, OpenAI shape: completion already holds the reasoning'
            );
            expectUsage(
                normalizeChatCompletionsUsage({
                    prompt_tokens: 700,
                    completion_tokens: 30,
                    completion_tokens_details: { reasoning_tokens: 60 },
                    total_tokens: 790,
                }),
                usage({ promptTokens: 700, outputTokens: 90, thoughtsTokens: 60 }),
                'MiMo, reasoning outside completion_tokens: added back'
            );
            expectUsage(normalizeChatCompletionsUsage(undefined), null, 'a stream without the usage chunk');
        },
    },
    {
        name: 'images API: the output is image output unless split',
        body: async () => {
            expectUsage(
                normalizeImagesUsage({ input_tokens: 50, output_tokens: 4160, total_tokens: 4210 }),
                usage({ promptTokens: 50, outputTokens: 4160, imageOutputTokens: 4160 }),
                'no split: every output token is an image token'
            );
            expectUsage(
                normalizeImagesUsage({
                    input_tokens: 50,
                    input_tokens_details: { cached_tokens: 10 },
                    output_tokens: 4200,
                    output_tokens_details: { image_tokens: 4160, text_tokens: 40 },
                }),
                usage({ promptTokens: 50, cachedTokens: 10, outputTokens: 4200, imageOutputTokens: 4160 }),
                'with a split'
            );
            expectUsage(normalizeImagesUsage(undefined), null, 'a relay that drops usage');
        },
    },
    {
        name: 'estimateCostUsd prices each model at its list price',
        body: async () => {
            const price = priceOf;
            const zero = ZERO_USAGE;
            const argon = estimateCostUsd(price('gemini-4-argon'), {
                ...zero,
                promptTokens: 20831,
                cachedTokens: 17947,
                outputTokens: 207,
            });
            expect(near(argon, (2884 * 2 + 17947 * 0.1 + 207 * 10) / 1e6), `argon: uncached + cached + output (got ${argon})`);

            const sonnet = estimateCostUsd(price('claude-sonnet-5'), {
                ...zero,
                promptTokens: 1050,
                cachedTokens: 900,
                cacheWriteTokens: 50,
                outputTokens: 420,
            });
            expect(near(sonnet, (100 * 2 + 900 * 0.2 + 50 * 2.5 + 420 * 10) / 1e6), `sonnet: cache writes at their own price (got ${sonnet})`);

            const opus = estimateCostUsd(price('claude-opus-5-5'), { ...zero, promptTokens: 1000, outputTokens: 100 });
            expect(near(opus, (1000 * 4 + 100 * 20) / 1e6), `opus (got ${opus})`);

            const banana = price('gemini-nano-banana-2.1');
            const split = estimateCostUsd(banana, { ...zero, promptTokens: 20, outputTokens: 1130, imageOutputTokens: 1120 });
            expect(near(split, (20 * 1.5 + 10 * 7.5 + 1120 * 30) / 1e6), `image tokens at the image price, the rest as text (got ${split})`);
            const unsplit = estimateCostUsd(banana, { ...zero, promptTokens: 20, outputTokens: 1130, unsplitImageOutputTokens: 1130 });
            expect(near(unsplit, (20 * 1.5 + 1130 * 30) / 1e6), `an image row without a split is all image output (got ${unsplit})`);
            const perImage = estimateCostUsd(banana, { ...zero, imagesWithoutUsage: 2 });
            expect(near(perImage, 2 * 0.0336), `images without usage at the per-image price (got ${perImage})`);

            const deepseek = estimateCostUsd(price('deepseek-flash'), { ...zero, promptTokens: 1000, cachedTokens: 600, outputTokens: 250 });
            expect(near(deepseek, (400 * 0.3 + 600 * 0.006 + 250 * 1.2) / 1e6), `deepseek at the peak price (got ${deepseek})`);
            const luna = estimateCostUsd(price('gpt-6-luna'), { ...zero, promptTokens: 1000, cachedTokens: 800, outputTokens: 300 });
            expect(near(luna, (200 * 0.1 + 800 * 0.01 + 300 * 0.5) / 1e6), `luna, reasoning billed as output (got ${luna})`);
            // Vertex published the standard price on 2026-11-12; 0.75/3.75 was the Batch tier
            const hydrogen = estimateCostUsd(price('gemini-4-hydrogen'), {
                ...zero,
                promptTokens: 1000,
                cachedTokens: 600,
                outputTokens: 200,
            });
            expect(
                near(hydrogen, (400 * 1.5 + 600 * 0.075 + 200 * 7.5) / 1e6),
                `hydrogen at the published standard price (got ${hydrogen})`
            );

            // Sonnet 5.5 is the Anthropic id the menu offers: cache hits cost half of 5's
            const sonnet55 = estimateCostUsd(price('claude-sonnet-5-5'), {
                ...zero,
                promptTokens: 1050,
                cachedTokens: 900,
                outputTokens: 420,
            });
            expect(
                near(sonnet55, (150 * 2 + 900 * 0.1 + 420 * 10) / 1e6),
                `sonnet-5-5: half-price cache hits (got ${sonnet55})`
            );
        },
    },
    {
        name: 'the price table: complete entries, the relay-only image id stays unpriced',
        body: async () => {
            const entries = Object.entries(MODEL_PRICES);
            expect(
                entries.length === 16,
                `the appendix models, gemini-4-carbon and both Anthropic ids (got ${entries.length})`
            );
            for (const [model, price] of entries) {
                const numbers = [price.inputPerM, price.cachedInputPerM, price.outputPerM];
                expect(
                    numbers.every((value) => Number.isFinite(value) && value > 0) &&
                        price.cachedInputPerM <= price.inputPerM &&
                        price.sourceUrl.startsWith('https://') &&
                        /^\d{4}-\d{2}-\d{2}$/.test(price.checkedOn),
                    `${model}: positive prices, cache no dearer than input, https source, checked date`
                );
            }
            expect(findModelPrice(OPENAI_IMAGE_MODEL) === null, `${OPENAI_IMAGE_MODEL} has no official price`);
            expect(findModelPrice('my-own-model') === null, 'a free-form id is unpriced');
            expect(findModelPrice('toString') === null && findModelPrice('__proto__') === null, 'no prototype keys');
            expect(SUBSCRIPTION_ROUTES.has('opencode-go') && SUBSCRIPTION_ROUTES.size === 1, 'opencode-go is the subscription lane');
        },
    },
    {
        name: 'aggregation and flags: unpriced, subscription, no_usage, output-only rows, image fallback, partial, priced share',
        body: async () => {
            const rows: ReplyMetricInput[] = [
                // priced: two argon rows on Vertex
                metricRow({ promptTokens: 1000, cachedTokens: 500, outputTokens: 100, thoughtsTokens: 40 }),
                metricRow({ promptTokens: 2000, cachedTokens: 0, outputTokens: 200, thoughtsTokens: 80 }),
                // subscription: argon over OpenCode Go
                metricRow({ route: 'opencode-go', promptTokens: 5000, cachedTokens: 0, outputTokens: 500 }),
                // unpriced: a free-form id
                metricRow({ model: 'my-own-model', platform: 'openai', promptTokens: 10, outputTokens: 10 }),
                // no_usage: every token column NULL
                metricRow({ model: 'deepseek-flash', platform: 'deepseek' }),
                // an output-only row is not a row with usage
                metricRow({ model: 'grok-4.7', platform: 'grok', outputTokens: 77 }),
                // image rows: usage without IMAGE split, and one without usage carrying 2 images
                metricRow({
                    model: 'gemini-nano-banana-2.1',
                    commandType: 'picbanana',
                    promptTokens: 20,
                    cachedTokens: 0,
                    outputTokens: 1130,
                    imageCount: 1,
                    hasImage: true,
                }),
                metricRow({ model: 'gemini-nano-banana-2.1', commandType: 'picbanana', imageCount: 2, hasImage: true }),
                // partial: flash priced on Vertex, its large-media lane without usage
                metricRow({ model: 'gemini-3.8-flash', promptTokens: 1000, cachedTokens: 0, outputTokens: 100 }),
                metricRow({ model: 'gemini-3.8-flash', route: 'large-media' }),
                // outside the window: another chat, and an old row
                metricRow({ chatId: OTHER_CHAT, promptTokens: 9_999_999, outputTokens: 9_999_999 }),
                metricRow({ startedAt: new Date(Date.now() - 40 * 24 * 3600 * 1000), promptTokens: 9_999_999, outputTokens: 1 }),
            ];
            for (const row of rows) await insertReplyMetric(row);

            const groups = await aggregateUsageByModelRoute({
                since: new Date(Date.now() - 7 * 24 * 3600 * 1000),
                chatId: PRICED_CHAT,
            });
            const priced = groups.map((group) => priceUsageGroup(group));
            const find = (model: string, route: string | null) => {
                const group = priced.find((entry) => entry.group.model === model && entry.group.route === route);
                if (!group) throw new Error(`no group ${model}/${route ?? 'null'} (got ${json(groups)})`);
                return group;
            };

            const argon = find('gemini-4-argon', null);
            expect(
                argon.group.replies === 2 &&
                    argon.group.repliesWithUsage === 2 &&
                    argon.group.promptTokens === 3000 &&
                    argon.group.cachedTokens === 500 &&
                    argon.group.thoughtsTokens === 120,
                `the window keeps to the chat and the last 7 days (got ${json(argon.group)})`
            );
            expect(
                argon.pricing === 'priced' && near(argon.costUsd, (2500 * 2 + 500 * 0.1 + 300 * 10) / 1e6),
                `argon on Vertex is priced (got ${json(argon)})`
            );
            const subscription = find('gemini-4-argon', 'opencode-go');
            expect(subscription.pricing === 'subscription' && subscription.costUsd === 0, 'opencode-go costs 0');
            const unpriced = find('my-own-model', null);
            expect(unpriced.pricing === 'unpriced' && unpriced.costUsd === null, 'a model without a price is unpriced, cost null');
            const noUsage = find('deepseek-flash', null);
            expect(noUsage.pricing === 'no_usage' && noUsage.costUsd === null, 'all-NULL usage is no_usage, never $0');
            const outputOnly = find('grok-4.7', null);
            expect(
                outputOnly.group.repliesWithUsage === 0 &&
                    outputOnly.group.outputTokens === 0 &&
                    outputOnly.pricing === 'no_usage' &&
                    outputOnly.costUsd === null,
                `an output-only row adds no tokens and no cost (got ${json(outputOnly)})`
            );
            const banana = find('gemini-nano-banana-2.1', null);
            expect(
                banana.group.unsplitImageOutputTokens === 1130 &&
                    banana.group.imagesWithoutUsage === 2 &&
                    banana.group.imageRowsWithoutUsage === 1,
                `image sums (got ${json(banana.group)})`
            );
            expect(
                banana.pricing === 'priced' && near(banana.costUsd, (20 * 1.5 + 1130 * 30) / 1e6 + 2 * 0.0336),
                `the row with usage is priced by tokens only, the row without by image (got ${banana.costUsd})`
            );
            expect(banana.pricedReplies === 2, 'both image rows count as priced');

            const rollups = rollupCostByModel(priced);
            const argonRollup = rollups.get('gemini-4-argon');
            expect(
                argonRollup?.pricing === 'priced' && near(argonRollup.costUsd, argon.costUsd ?? -1),
                `argon across routes: priced, the subscription adds 0 (got ${json(argonRollup)})`
            );
            const flashRollup = rollups.get('gemini-3.8-flash');
            expect(
                flashRollup?.pricing === 'partial' && near(flashRollup.costUsd, (1000 * 0.75 + 100 * 3.75) / 1e6),
                `flash with a route lacking usage is partial (got ${json(flashRollup)})`
            );
            expect(rollups.get('my-own-model')?.pricing === 'unpriced', 'an unpriced model stays unpriced');

            const totals = totalCost(priced);
            const replies = 10;
            const pricedReplies = 2 + 1 + 2 + 1; // argon, opencode-go, both banana rows, flash
            expect(
                near(totals.pricedReplyRatio, pricedReplies / replies),
                `priced share = (priced + subscription with usage + per-image rows) / replies (got ${totals.pricedReplyRatio})`
            );
            const expectedTotal = priced.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0);
            expect(near(totals.costUsd, expectedTotal), 'the total sums every group with a cost');
            expect(json(totalCost([])) === json({ costUsd: null, pricedReplyRatio: null }), 'nothing to price: both null');
        },
    },
];

cases.push(
    {
        name: 'priority prices: the Gemini chat models and the image model at 1.8 times standard; carbon is argon',
        body: async () => {
            const withPriority = Object.entries(MODEL_PRICES)
                .filter(([, price]) => price.priority !== undefined)
                .map(([model]) => model)
                .sort();
            expect(
                json(withPriority) ===
                    json([
                        'gemini-3.8-flash',
                        'gemini-4-argon',
                        'gemini-4-carbon',
                        'gemini-4-hydrogen',
                        'gemini-nano-banana-2.1',
                    ]),
                `the Gemini models and the image model have one (got ${json(withPriority)})`
            );
            for (const model of withPriority) {
                const price = priceOf(model);
                const priority = price.priority;
                expect(
                    priority !== undefined &&
                        near(priority.inputPerM, price.inputPerM * 1.8) &&
                        near(priority.cachedInputPerM, price.cachedInputPerM * 1.8) &&
                        near(priority.outputPerM, price.outputPerM * 1.8),
                    `${model}: 1.8 times each standard price (got ${json(priority)})`
                );
            }
            expect(
                json(priceOf('gemini-4-argon').priority) === json({ inputPerM: 3.6, cachedInputPerM: 0.18, outputPerM: 18 }),
                'argon: 3.60 / 0.18 / 18'
            );
            expect(
                json(priceOf('gemini-3.8-flash').priority) === json({ inputPerM: 1.35, cachedInputPerM: 0.135, outputPerM: 6.75 }),
                'flash: 1.35 / 0.135 / 6.75'
            );
            // Only the date it was checked on differs
            const { checkedOn: _carbonChecked, ...carbon } = priceOf('gemini-4-carbon');
            const { checkedOn: _argonChecked, ...argon } = priceOf('gemini-4-argon');
            expect(json(carbon) === json(argon), `carbon is priced like argon, no longer "unpriced" (got ${json(carbon)})`);
        },
    },
    {
        name: 'estimateCostUsd: (total - priority part) at standard + priority part at priority; no priority price = standard',
        body: async () => {
            const argon = priceOf('gemini-4-argon');
            // One million of each kind, all at the priority tier: the cost is the priority prices
            const allPriority: UsageTotals = {
                ...ZERO_USAGE,
                promptTokens: 2 * PER_MILLION,
                cachedTokens: PER_MILLION,
                outputTokens: PER_MILLION,
                priorityPromptTokens: 2 * PER_MILLION,
                priorityCachedTokens: PER_MILLION,
                priorityOutputTokens: PER_MILLION,
            };
            const priorityOnly = estimateCostUsd(argon, allPriority);
            expect(near(priorityOnly, 3.6 + 0.18 + 18), `every round at the priority tier (got ${priorityOnly})`);

            // A reply whose round 1 was downgraded and round 2 served at the priority tier
            const mixed: UsageTotals = {
                ...ZERO_USAGE,
                promptTokens: 2200,
                cachedTokens: 1500,
                outputTokens: 130,
                priorityPromptTokens: 1200,
                priorityCachedTokens: 900,
                priorityOutputTokens: 80,
            };
            const standardPart = (400 * 2 + 600 * 0.1 + 50 * 10) / 1e6;
            const priorityPart = (300 * 3.6 + 900 * 0.18 + 80 * 18) / 1e6;
            const mixedCost = estimateCostUsd(argon, mixed);
            expect(near(mixedCost, standardPart + priorityPart), `the split (got ${mixedCost})`);
            const withoutSplit = estimateCostUsd(argon, { ...mixed, priorityPromptTokens: 0, priorityCachedTokens: 0, priorityOutputTokens: 0 });
            expect(
                near(withoutSplit, (700 * 2 + 1500 * 0.1 + 130 * 10) / 1e6) && mixedCost > withoutSplit,
                `the same tokens all at standard cost less (got ${withoutSplit})`
            );

            // A model without a priority price: the priority part at the standard price, i.e. the old total
            const deepseek = priceOf('deepseek-flash');
            expect(deepseek.priority === undefined, 'deepseek has no priority price');
            const fallback = estimateCostUsd(deepseek, { ...mixed });
            const asStandard = estimateCostUsd(deepseek, { ...mixed, priorityPromptTokens: 0, priorityCachedTokens: 0, priorityOutputTokens: 0 });
            expect(near(fallback, asStandard), `no priority price: priced as if standard (got ${fallback} vs ${asStandard})`);
        },
    },
    {
        name: 'priced groups: the split from the SQL aggregate and the reply detail alike; the note for a model without a priority price',
        body: async () => {
            const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
            const mixedRow = metricRow({
                chatId: PRIORITY_CHAT,
                rounds: 2,
                promptTokens: 2200,
                cachedTokens: 1500,
                outputTokens: 130,
                tierRequested: 'priority',
                priorityRounds: 1,
                priorityPromptTokens: 1200,
                priorityCachedTokens: 900,
                priorityOutputTokens: 80,
            });
            // Priority rounds on a model the table has no priority price for
            const unpricedTierRow = metricRow({
                chatId: PRIORITY_CHAT,
                model: 'grok-4.7',
                promptTokens: 1000,
                cachedTokens: 0,
                outputTokens: 100,
                priorityRounds: 1,
                priorityPromptTokens: 1000,
                priorityCachedTokens: 0,
                priorityOutputTokens: 100,
            });
            // Asked for priority, every round downgraded: standard price, no note
            const downgradedRow = metricRow({
                chatId: PRIORITY_CHAT,
                model: 'gemini-4-carbon',
                promptTokens: 1000,
                cachedTokens: 0,
                outputTokens: 100,
                tierRequested: 'priority',
            });
            for (const row of [mixedRow, unpricedTierRow, downgradedRow]) await insertReplyMetric(row);

            const priced = (await aggregateUsageByModelRoute({ since, chatId: PRIORITY_CHAT })).map((group) => priceUsageGroup(group));
            const find = (model: string) => {
                const group = priced.find((entry) => entry.group.model === model);
                if (!group) throw new Error(`no group ${model}`);
                return group;
            };
            const mixedCost = (400 * 2 + 600 * 0.1 + 50 * 10 + 300 * 3.6 + 900 * 0.18 + 80 * 18) / 1e6;
            const argon = find('gemini-4-argon');
            expect(
                argon.pricing === 'priced' && near(argon.costUsd, mixedCost) && !argon.priorityAtStandardPrice,
                `the SQL group is split (got ${json(argon)})`
            );
            const withStandardFallback = find('grok-4.7');
            expect(
                withStandardFallback.pricing === 'priced' &&
                    near(withStandardFallback.costUsd, (1000 * 2 + 100 * 6) / 1e6) &&
                    withStandardFallback.priorityAtStandardPrice,
                `no priority price: standard price, and the group says so (got ${json(withStandardFallback)})`
            );
            const carbon = find('gemini-4-carbon');
            expect(
                carbon.pricing === 'priced' && near(carbon.costUsd, (1000 * 2 + 100 * 10) / 1e6) && !carbon.priorityAtStandardPrice,
                `carbon is priced; asked but downgraded is the standard price (got ${json(carbon)})`
            );

            const rollups = rollupCostByModel(priced);
            expect(
                rollups.get('grok-4.7')?.priorityAtStandardPrice === true &&
                    rollups.get('gemini-4-argon')?.priorityAtStandardPrice === false,
                'the per-model rollup carries the note'
            );
            const totals = totalCost(priced);
            expect(
                near(totals.costUsd, mixedCost + (1000 * 2 + 100 * 6) / 1e6 + (1000 * 2 + 100 * 10) / 1e6),
                `the total follows the split (got ${totals.costUsd})`
            );

            // The reply detail prices one row through asUsageGroup: same split, same note
            const detailOf = async (row: ReplyMetricInput) =>
                (await listReplyMetricsByReply(PRIORITY_CHAT, row.firstMessageId, { access: 'observer' })).get(1)?.[0];
            const mixedDetail = await detailOf(mixedRow);
            expect(
                mixedDetail?.costUsd === Math.round(mixedCost * 1e6) / 1e6 && mixedDetail.priorityAtStandardPrice === false,
                `the reply detail is split too (got ${json(mixedDetail)})`
            );
            const fallbackDetail = await detailOf(unpricedTierRow);
            expect(
                fallbackDetail?.priorityAtStandardPrice === true && fallbackDetail.pricing === 'priced',
                `the reply detail notes the standard-price fallback (got ${json(fallbackDetail)})`
            );
        },
    }
);

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
reportResults(results);
