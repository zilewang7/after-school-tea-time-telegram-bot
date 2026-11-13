/**
 * Offline cases for the price-segmented cost estimate (design §4.2): a window
 * that contains a price change is split at the change instants and each slice
 * is priced at the price in force when it started. The cases cross the two
 * promotional windows of the seed table — argon/carbon doubling on 2026-12-01
 * and gemini-3.8-flash doubling on 2027-01-01 — and check that:
 * - the segmented total equals the sum of the rows priced at their own
 *   startedAt (the per-row detail's cost), so no history drifts;
 * - a window ending before the change and one opened after it price the same
 *   row identically (the old price);
 * - a change-free window is one segment and prices exactly like the
 *   unsegmented estimate;
 * - every field of two (model, route) usage groups adds up;
 * - the pricing metadata block (version, checkedOn, sources, next changes,
 *   unpriced models, owner-only pending count) follows the fixed clock.
 *
 * The seed prices these cases rely on (config/model-pricing.ts):
 *   gemini-4-argon   2026-11-30: 2 / 0.1 / 10, priority 3.6 / 0.18 / 18
 *                    2026-12-01: 4 / 0.2 / 20, priority 7.2 / 0.36 / 36
 *   gemini-3.8-flash 2026-12-31: 0.75 / 0.075 / 3.75, priority 1.35 / …
 *                    2027-01-01: 1.5 / 0.15 / 7.5, priority 2.7 / …
 *
 * Run: npx tsx scripts/offline/price-segments.mts
 */
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';

await setupOfflineDb();
const { buildStats } = await import('../../src/panel/stats/build-stats.js');
const { findModelPrice, findPriceAt, priceChangeInstants, priceTableVersion } = await import(
    '../../src/config/model-pricing.js'
);
const { insertReplyMetric } = await import('../../src/db/queries/reply-metrics.js');
const { listReplyMetricsByReply } = await import('../../src/panel/views/reply-metrics-view.js');
const { mergeUsageGroupRows, priceUsageGroup } = await import('../../src/panel/stats/cost-estimate.js');
const { priceSegmentsOf } = await import('../../src/panel/stats/price-segments.js');
const { PriceChangeProposal } = await import('../../src/db/priceChangeProposalDTO.js');

type ReplyMetricInput = import('../../src/db/queries/reply-metrics.js').ReplyMetricInput;
type UsageGroupRow = import('../../src/db/queries/reply-metrics.js').UsageGroupRow;

const json = (value: unknown): string => JSON.stringify(value);

/** Every other chat of these cases, so windows never see two cases' rows */
const ARGON_CHAT = -1005500000001;
const FLASH_CHAT = -1005500000002;
const OLD_ROW_CHAT = -1005500000003;
const HYDROGEN_CHAT = -1005500000004;
const UNPRICED_CHAT = -1005500000005;
const EMPTY_CHAT = -1005500000006;

/** A row with the given instants and tokens; everything else fixed */
const metricRow = (fields: Partial<ReplyMetricInput>): ReplyMetricInput => ({
    chatId: ARGON_CHAT,
    userMessageId: 1,
    firstMessageId: 2,
    versionId: 1,
    triggerUserId: 42,
    model: 'gemini-4-argon',
    platform: 'gemini',
    route: null,
    commandType: 'chat',
    isRetry: false,
    startedAt: new Date('2026-11-30T23:00:00Z'),
    requestStartedAt: new Date('2026-11-30T23:00:00Z'),
    firstChunkAt: new Date('2026-11-30T23:00:02Z'),
    finishedAt: new Date('2026-11-30T23:00:05Z'),
    outcome: 'ok',
    errorKind: null,
    errorSummary: null,
    rounds: 1,
    toolCalls: 0,
    toolFailures: 0,
    toolUsage: [],
    promptTokens: 1_000_000,
    cachedTokens: 0,
    cacheWriteTokens: null,
    outputTokens: 0,
    thoughtsTokens: 0,
    imageOutputTokens: null,
    contextMessages: 4,
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
});

/** A priority-served round: promptTokens is the whole prompt, its priority part equal */
const priorityFields = (fields: Partial<ReplyMetricInput>): Partial<ReplyMetricInput> => ({
    rounds: 1,
    promptTokens: 1_000_000,
    cachedTokens: 0,
    outputTokens: 0,
    tierRequested: 'priority',
    priorityRounds: 1,
    priorityPromptTokens: 1_000_000,
    priorityCachedTokens: 0,
    priorityOutputTokens: 0,
    ...fields,
});

let nextMessageId = 100_000;
const insertRow = async (fields: Partial<ReplyMetricInput>): Promise<ReplyMetricInput> => {
    nextMessageId += 2;
    const row = metricRow({ userMessageId: nextMessageId - 1, firstMessageId: nextMessageId, ...fields });
    await insertReplyMetric(row);
    return row;
};

/** Dollars to the micro-dollar, the API's rounding */
const usd = (value: number): number => Math.round(value * 1e6) / 1e6;

/** The cost of one stored attempt, as the reply detail shows it */
const detailCostUsd = async (chatId: number, firstMessageId: number): Promise<number | null> => {
    const byVersion = await listReplyMetricsByReply(chatId, firstMessageId, { access: 'observer' });
    const views = [...byVersion.values()].flat();
    if (views.length === 0) throw new Error(`no detail for ${firstMessageId}`);
    return views[0]?.costUsd ?? null;
};

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'across 2026-11-30 / 12-01 (argon doubles): segments add up to the per-row prices',
        body: async () => {
            const rows = [
                // 2.00 at the promotional price
                await insertRow({ chatId: ARGON_CHAT, startedAt: new Date('2026-11-30T23:00:00Z') }),
                // 4.00 the next day
                await insertRow({ chatId: ARGON_CHAT, startedAt: new Date('2026-12-01T01:00:00Z') }),
                // priority rounds: 3.60 before, 7.20 after
                await insertRow({ chatId: ARGON_CHAT, ...priorityFields({ startedAt: new Date('2026-11-30T23:30:00Z') }) }),
                await insertRow({ chatId: ARGON_CHAT, ...priorityFields({ startedAt: new Date('2026-12-01T00:30:00Z') }) }),
            ];
            const now = new Date('2026-12-02T00:00:00Z');
            const stats = await buildStats({ chatId: ARGON_CHAT, range: '7d', now });

            expect(stats.range === '7d' && stats.kpis.replies === 4, `4 replies in the window (got ${stats.kpis.replies})`);
            // 2 + 4 + 3.6 + 7.2
            expect(stats.cost.costUsd === 16.8, `the segmented total (got ${json(stats.cost.costUsd)})`);
            expect(stats.kpis.costUsd === stats.cost.costUsd, 'the KPI cost is the total');
            expect(stats.cost.pricedReplyRatio === 1, `every reply priced (got ${json(stats.cost.pricedReplyRatio)})`);

            // The merged group is one row: the price change must not split it
            expect(stats.costGroups.length === 1, `one (model, route) group (got ${json(stats.costGroups.map((group) => group.model))})`);
            const [group] = stats.costGroups;
            expect(
                group?.model === 'gemini-4-argon' &&
                    group.replies === 4 &&
                    group.costUsd === 16.8 &&
                    group.usage.promptTokens === 4_000_000 &&
                    group.usage.priorityPromptTokens === 2_000_000 &&
                    group.usage.priorityRounds === 2,
                `the usage sums add up, the cost is the sum of the segments (got ${json(group)})`
            );
            expect(stats.models.length === 1 && stats.models[0]?.costUsd === 16.8, `one model row, same cost (got ${json(stats.models)})`);

            // The per-row detail prices each attempt at its own startedAt
            const detailCosts = await Promise.all(rows.map((row) => detailCostUsd(ARGON_CHAT, row.firstMessageId)));
            expect(
                json(detailCosts) === json([2, 4, 3.6, 7.2]),
                `per-row detail: 2 / 4 / 3.6 / 7.2 (got ${json(detailCosts)})`
            );
            const summed = detailCosts.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);
            expect(usd(summed) === stats.cost.costUsd, `segments == row-by-row sum (got ${usd(summed)} vs ${stats.cost.costUsd})`);

            // The change instants are inside this window, so it really was split
            expect(
                json(
                    priceChangeInstants(new Date('2026-11-25T00:00:00Z'), now).map((instant) => instant.toISOString())
                ) === json(['2026-12-01T00:00:00.000Z']),
                'the window contains exactly the 2026-12-01 change'
            );
        },
    },
    {
        name: 'across 2026-12-31 / 2027-01-01 (gemini-3.8-flash doubles): same rule',
        body: async () => {
            const rows = [
                await insertRow({
                    chatId: FLASH_CHAT,
                    model: 'gemini-3.8-flash',
                    startedAt: new Date('2026-12-31T23:00:00Z'),
                }),
                await insertRow({
                    chatId: FLASH_CHAT,
                    model: 'gemini-3.8-flash',
                    startedAt: new Date('2027-01-01T01:00:00Z'),
                }),
            ];
            const stats = await buildStats({ chatId: FLASH_CHAT, range: '7d', now: new Date('2027-01-02T00:00:00Z') });
            // 0.75 + 1.50
            expect(stats.cost.costUsd === 2.25, `the segmented total (got ${json(stats.cost.costUsd)})`);
            const detailCosts = await Promise.all(rows.map((row) => detailCostUsd(FLASH_CHAT, row.firstMessageId)));
            expect(json(detailCosts) === json([0.75, 1.5]), `per-row detail: 0.75 / 1.5 (got ${json(detailCosts)})`);
            expect(
                usd(detailCosts.reduce<number>((sum, cost) => sum + (cost ?? 0), 0)) === stats.cost.costUsd,
                'segments == row-by-row sum'
            );
        },
    },
    {
        name: 'history does not drift: a row made before the change keeps its old price in a later window',
        body: async () => {
            const row = await insertRow({
                chatId: OLD_ROW_CHAT,
                startedAt: new Date('2026-11-29T23:00:00Z'),
            });
            // A 24h window that ends before the change: the promotional price
            const before = await buildStats({ chatId: OLD_ROW_CHAT, range: '24h', now: new Date('2026-11-30T12:00:00Z') });
            expect(before.cost.costUsd === 2, `before the change: 2.00 (got ${json(before.cost.costUsd)})`);
            expect((await detailCostUsd(OLD_ROW_CHAT, row.firstMessageId)) === 2, 'the detail says 2.00 too');

            // A window opened after the change: the same old row is still 2.00,
            // even though the price in force at the query time is 4.00
            const after = await buildStats({ chatId: OLD_ROW_CHAT, range: '90d', now: new Date('2026-12-02T00:00:00Z') });
            expect(after.cost.costUsd === 2, `after the change the old row is still 2.00 (got ${json(after.cost.costUsd)})`);
            const priceAtQueryTime = findPriceAt('gemini-4-argon', new Date('2026-12-02T00:00:00Z'));
            expect(priceAtQueryTime?.inputPerM === 4, 'the price in force at 12-02 is 4.00 (what a drifting estimate would use)');
        },
    },
    {
        name: 'a change-free window is one segment and prices like the unsegmented estimate',
        body: async () => {
            const now = new Date('2026-11-13T12:00:00Z');
            const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            expect(priceSegmentsOf(since, now).length === 1, `one segment (got ${priceSegmentsOf(since, now).length})`);

            await insertRow({
                chatId: HYDROGEN_CHAT,
                model: 'gemini-4-hydrogen',
                startedAt: new Date('2026-11-13T10:00:00Z'),
                promptTokens: 1_000_000,
                outputTokens: 1_000_000,
            });
            const stats = await buildStats({ chatId: HYDROGEN_CHAT, range: '24h', now });
            // 1.50 in + 7.50 out
            expect(stats.cost.costUsd === 9, `1.50 + 7.50 (got ${json(stats.cost.costUsd)})`);
            const current = findModelPrice('gemini-4-hydrogen');
            expect(current?.inputPerM === 1.5 && current.outputPerM === 7.5, 'the current price is the same as the window one');
        },
    },
    {
        name: 'mergeUsageGroupRows: every field adds up, routes and models stay apart, first-seen order',
        body: async () => {
            const first: UsageGroupRow = {
                model: 'm',
                route: 'r',
                replies: 2,
                repliesWithUsage: 1,
                promptTokens: 10,
                cachedTokens: 4,
                cacheWriteTokens: 1,
                outputTokens: 5,
                thoughtsTokens: 2,
                imageOutputTokens: 1,
                unsplitImageOutputTokens: 3,
                imagesWithoutUsage: 2,
                imageRowsWithoutUsage: 1,
                priorityRounds: 1,
                priorityPromptTokens: 6,
                priorityCachedTokens: 2,
                priorityOutputTokens: 3,
            };
            const second: UsageGroupRow = { ...first, route: 'r', replies: 3, promptTokens: 20, priorityRounds: 2 };
            const otherRoute: UsageGroupRow = { ...first, route: 'other' };
            const merged = mergeUsageGroupRows([first, otherRoute, second]);
            expect(merged.length === 2, `two (model, route) keys (got ${json(merged.map((group) => group.route))})`);
            const [r, other] = merged;
            expect(r?.route === 'r' && other?.route === 'other', 'first-seen order kept');
            expect(
                r !== undefined &&
                    r.replies === 5 &&
                    r.repliesWithUsage === 2 &&
                    r.promptTokens === 30 &&
                    r.cachedTokens === 8 &&
                    r.outputTokens === 10,
                `the numbers add up (got ${json(r)})`
            );
            expect(
                r !== undefined &&
                    r.priorityRounds === 3 &&
                    r.priorityPromptTokens === 12 &&
                    r.priorityOutputTokens === 6 &&
                    r.imagesWithoutUsage === 4,
                `the priority and image fields add up too (got ${json(r)})`
            );
            expect(other?.replies === 2, 'a different route is not merged in');
            expect(merged.length === 2 && json(mergeUsageGroupRows([])) === '[]', 'nothing in, nothing out');
        },
    },
    {
        name: 'priceUsageGroup takes an external price: old, current and unpriced',
        body: async () => {
            const group: UsageGroupRow = {
                model: 'gemini-4-argon',
                route: null,
                replies: 1,
                repliesWithUsage: 1,
                promptTokens: 1_000_000,
                cachedTokens: 0,
                cacheWriteTokens: 0,
                outputTokens: 0,
                thoughtsTokens: 0,
                imageOutputTokens: 0,
                unsplitImageOutputTokens: 0,
                imagesWithoutUsage: 0,
                imageRowsWithoutUsage: 0,
                priorityRounds: 0,
                priorityPromptTokens: 0,
                priorityCachedTokens: 0,
                priorityOutputTokens: 0,
            };
            const old = priceUsageGroup(group, findPriceAt('gemini-4-argon', new Date('2026-11-30T23:00:00Z')));
            expect(old.costUsd === 2 && old.pricing === 'priced', `the old price: 2.00 (got ${json(old.costUsd)})`);
            const next = priceUsageGroup(group, findPriceAt('gemini-4-argon', new Date('2026-12-01T01:00:00Z')));
            expect(next.costUsd === 4, `the new price: 4.00 (got ${json(next.costUsd)})`);
            const unpriced = priceUsageGroup(group, null);
            expect(unpriced.costUsd === null && unpriced.pricing === 'unpriced', 'an explicit null price: unpriced, not $0');
            const implicit = priceUsageGroup(group);
            expect(implicit.costUsd === 2, `without a price the current one is used (got ${json(implicit.costUsd)})`);
        },
    },
    {
        name: 'pricing metadata: fixed clock, owner-only pending count, unpriced models',
        body: async () => {
            await insertRow({
                chatId: UNPRICED_CHAT,
                model: 'my-unpriced-model',
                platform: 'openai',
                startedAt: new Date('2026-11-12T09:00:00Z'),
            });
            const pending = await PriceChangeProposal.create({
                kind: 'update',
                model: 'gemini-4-argon',
                tier: 'standard',
                effectiveFrom: new Date('2026-12-01T00:00:00Z'),
                payload: '{}',
                detectedAt: new Date('2026-11-13T00:00:00Z'),
                status: 'pending',
            });
            try {
                const now = new Date('2026-11-13T12:00:00Z');
                const anonymous = await buildStats({ chatId: EMPTY_CHAT, range: '7d', now });
                const owner = await buildStats({ chatId: EMPTY_CHAT, range: '7d', now, isOwner: true });
                expect(anonymous.cost.costUsd === null && anonymous.kpis.replies === 0, 'an empty window has no cost, never $0');

                const meta = anonymous.pricing;
                expect(meta.version === priceTableVersion(), `the registry version (got ${meta.version})`);
                expect(
                    typeof meta.checkedOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(meta.checkedOn),
                    `the oldest checkedOn date (got ${json(meta.checkedOn)})`
                );
                expect(
                    meta.sources.length > 0 && meta.sources.every((source) => typeof source.checkedOn === 'string'),
                    `the source list (got ${json(meta.sources)})`
                );
                expect(
                    json(meta.nextChanges.map((change) => [change.at, change.model, change.tier])) ===
                        json([
                            ['2026-12-01T00:00:00.000Z', 'gemini-4-argon', 'standard'],
                            ['2026-12-01T00:00:00.000Z', 'gemini-4-argon', 'priority'],
                            ['2026-12-01T00:00:00.000Z', 'gemini-4-carbon', 'standard'],
                            ['2026-12-01T00:00:00.000Z', 'gemini-4-carbon', 'priority'],
                        ]),
                    `windows starting within 30 days, in time order (got ${json(meta.nextChanges)})`
                );
                expect(
                    meta.unpricedModels.includes('my-unpriced-model') && !meta.unpricedModels.includes('gemini-4-argon'),
                    `recent replies of a model without a price (got ${json(meta.unpricedModels)})`
                );
                expect(meta.pendingProposals === 0, `a non-owner sees no pending proposals (got ${meta.pendingProposals})`);
                expect(owner.pricing.pendingProposals === 1, `the owner sees the pending proposal (got ${owner.pricing.pendingProposals})`);
                expect(json(owner.pricing.nextChanges) === json(meta.nextChanges), 'the rest of the block does not depend on the owner');
            } finally {
                await pending.destroy();
            }
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
reportResults(results);
