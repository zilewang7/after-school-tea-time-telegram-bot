/**
 * Offline cases for the panel's phase 3 endpoints, through hono's
 * `app.request()` with self-signed initData and a fake getChatMember (like
 * panel-api.mts): GET /api/stats (chat and all-chats views, ranges, buckets,
 * no user ids or names for anyone), GET /api/status (process facts for the
 * owner only, live replies and recent errors filtered by access, trigger
 * text for members only, non-candidate chats never looked up) and the
 * dashboard's 7-day `summary`. Then Priority PayGo (design §8.4): the hit rate
 * over the replies that asked for it, the stray rounds kept apart, and the
 * split cost in the model table, the cost groups, the total and the summary.
 *
 * Run: npx tsx scripts/offline/panel-stats.mts
 */
import { GrammyError } from 'grammy';
import { expect, reportResults, runCase, setupOfflineDb, takeMessageId, type CaseResult } from './harness.mts';
import { contextOf, createFakeTelegram, messageUpdate } from './fake-telegram.mts';
import { signInitData, type InitDataUserInput } from '../lib/init-data.mts';

const BOT_TOKEN = '123456789:AAFakeOfflineTokenForPanelStats_0123';
const OWNER_ID = 4343;
const ALICE: InitDataUserInput = { id: 5301, first_name: 'Alice', last_name: 'Liddell', username: 'alice' };
const BOB: InitDataUserInput = { id: 5302, first_name: 'Bob' };
const OWNER: InitDataUserInput = { id: OWNER_ID, first_name: 'Owner' };

/** Alice is a member; nobody else is */
const GROUP_MAIN = -1001300000001;
/** Nobody here: the owner observes, Alice never even gets looked up */
const GROUP_OTHER = -1001300000002;
/** Alice and Bob spoke here; Alice is a member, Bob left */
const GROUP_CALC = -1001300000003;
/** One conversation tree for the conversation statistics */
const GROUP_CONV = -1001300000004;
/** Priority PayGo rows, inserted by their own case after the others ran */
const GROUP_PRIORITY = -1001300000005;

process.env.OWNER_USER_ID = String(OWNER_ID);
process.env.DEFAULT_MODEL = 'env-default-model';
delete process.env.ALLOWED_CHAT_IDS;

await setupOfflineDb();
const registry = await import('../../src/db/queries/panel-registry.js');
const { ChatMemberSeen } = await import('../../src/db/chatMemberSeenDTO.js');
const dbIndex = await import('../../src/db/index.js');
const { Message } = await import('../../src/db/messageDTO.js');
const { loadChatSettingsCache } = await import('../../src/services/chat-settings-service.js');
const { createPanelApp } = await import('../../src/panel/app.js');
const { insertReplyMetric } = await import('../../src/db/queries/reply-metrics.js');
const { pushRecentReplyError } = await import('../../src/services/recent-reply-errors.js');
const responseHandler = await import('../../src/reply/response-handler.js');
const { markRequestStarted } = await import('../../src/services/reply-metrics-draft.js');
const { STATS_TIME_ZONE } = await import('../../src/panel/stats/time-buckets.js');
const { priceTableVersion } = await import('../../src/config/model-pricing.js');
const { PriceChangeProposal } = await import('../../src/db/priceChangeProposalDTO.js');

type MembershipLookup = import('../../src/panel/access/membership.js').MembershipLookup;
type ReplyMetricInput = import('../../src/db/queries/reply-metrics.js').ReplyMetricInput;
type ChatContext = import('../../src/reply/response-handler.js').ChatContext;

const json = (value: unknown): string => JSON.stringify(value);
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ---- membership, app, requests ----

const grammyError = (code: number, description: string): GrammyError =>
    new GrammyError(`(${code}: ${description})`, { ok: false, error_code: code, description }, 'getChatMember', {});

const lookups: string[] = [];
const fakeLookup: MembershipLookup = async (chatId, userId) => {
    lookups.push(`${chatId}:${userId}`);
    if (userId === ALICE.id && (chatId === GROUP_MAIN || chatId === GROUP_CALC || chatId === GROUP_CONV)) {
        return { status: 'member' };
    }
    if (userId === BOB.id && chatId === GROUP_CALC) return { status: 'left' };
    throw grammyError(400, 'Bad Request: user not found');
};

const app = createPanelApp({
    botToken: BOT_TOKEN,
    membershipLookup: fakeLookup,
    staticRoot: '/nonexistent/panel-stats-static',
    startedAt: new Date(Date.now() - 90_000),
    version: 'abc1234',
    rateLimit: { limit: 10_000, windowMs: 60_000 },
});

const call = async (path: string, user: InitDataUserInput, startParam?: string): Promise<{ status: number; body: any }> => {
    const initData = signInitData({
        botToken: BOT_TOKEN,
        user,
        authDate: Math.floor(Date.now() / 1000),
        ...(startParam !== undefined ? { startParam } : {}),
    });
    const response = await app.request(path, { headers: { 'X-Init-Data': initData } });
    const text = await response.text();
    let body: unknown;
    try {
        body = JSON.parse(text);
    } catch {
        body = { notJson: text };
    }
    return { status: response.status, body };
};

/** Run `body` with the panel's request log and the reply pipeline's chatter silenced */
const quietly = async <T,>(body: () => Promise<T>): Promise<T> => {
    const original = { log: console.log, warn: console.warn, error: console.error };
    console.log = () => undefined;
    console.warn = () => undefined;
    console.error = () => undefined;
    try {
        return await body();
    } finally {
        Object.assign(console, original);
    }
};

// ---- fixtures ----

await registry.upsertChatNow({ id: GROUP_MAIN, type: 'supergroup', title: 'Main', username: 'main_group' });
await registry.upsertChatNow({ id: GROUP_OTHER, type: 'supergroup', title: 'Other' });
await registry.upsertChatNow({ id: GROUP_CALC, type: 'supergroup', title: 'Calc' });
await registry.upsertChatNow({ id: ALICE.id, type: 'private', first_name: 'Alice', last_name: 'Liddell' });
// Alice spoke in Calc only: Main reaches her candidates through the start_param hint alone
await ChatMemberSeen.create({ chatId: GROUP_CALC, userId: ALICE.id, firstSeenAt: new Date(), lastSeenAt: new Date(), messageCount: 3 });
await ChatMemberSeen.create({ chatId: GROUP_CALC, userId: BOB.id, firstSeenAt: new Date(), lastSeenAt: new Date(), messageCount: 1 });
await loadChatSettingsCache();

let nextFirstMessageId = 70_000;

const metricRow = (fields: Partial<ReplyMetricInput>): ReplyMetricInput => {
    const startedAt = fields.startedAt ?? new Date(Date.now() - HOUR_MS);
    nextFirstMessageId += 2;
    return {
        chatId: GROUP_MAIN,
        userMessageId: nextFirstMessageId - 1,
        firstMessageId: nextFirstMessageId,
        versionId: 1,
        triggerUserId: ALICE.id,
        model: 'gemini-4-argon',
        platform: 'gemini',
        route: null,
        commandType: 'chat',
        isRetry: false,
        startedAt,
        requestStartedAt: new Date(startedAt.getTime() + 500),
        firstChunkAt: new Date(startedAt.getTime() + 2500),
        finishedAt: new Date(startedAt.getTime() + 6500),
        outcome: 'ok',
        errorKind: null,
        errorSummary: null,
        rounds: 1,
        toolCalls: 0,
        toolFailures: 0,
        toolUsage: [],
        promptTokens: 1000,
        cachedTokens: 400,
        cacheWriteTokens: null,
        outputTokens: 100,
        thoughtsTokens: 30,
        imageOutputTokens: null,
        contextMessages: 4,
        contextImages: 1,
        textChars: 400,
        thinkingChars: 100,
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

const MAIN_ROWS: ReplyMetricInput[] = [
    metricRow({ toolCalls: 3, toolFailures: 1, toolUsage: [{ name: 'search_history', count: 2, failed: 1 }, { name: 'fetch_url', count: 1, failed: 0 }], rounds: 3 }),
    metricRow({ startedAt: new Date(Date.now() - 2 * HOUR_MS), toolCalls: 1, toolUsage: [{ name: 'search_history', count: 1, failed: 0 }], rounds: 2 }),
    metricRow({ model: 'deepseek-flash', platform: 'deepseek', triggerUserId: BOB.id, promptTokens: 500, cachedTokens: 0, outputTokens: 50, thoughtsTokens: 0 }),
    metricRow({ outcome: 'error', errorKind: 'rate_limit', errorSummary: '429 Too Many Requests', promptTokens: null, outputTokens: null, firstChunkAt: null, rounds: 0, startedAt: new Date(Date.now() - 3 * DAY_MS) }),
    metricRow({ outcome: 'stopped', isRetry: true, versionId: 2, startedAt: new Date(Date.now() - 2 * DAY_MS) }),
    metricRow({ model: 'my-own-model', platform: 'openai', outcome: 'empty', textChars: 0 }),
    // 30 days back: only in 30d / 90d / all
    metricRow({ startedAt: new Date(Date.now() - 30 * DAY_MS + HOUR_MS) }),
];
const OTHER_ROWS: ReplyMetricInput[] = [
    metricRow({ chatId: GROUP_OTHER, triggerUserId: 9999, outcome: 'error', errorKind: 'upstream', errorSummary: '503 overloaded', promptTokens: null, outputTokens: null }),
];
// Four rows with known first-chunk times: 1s, 2s, 3s, 4s
const CALC_ROWS: ReplyMetricInput[] = [1000, 2000, 3000, 4000].map((firstChunkMs, index) => {
    const startedAt = new Date(Date.now() - (index + 1) * HOUR_MS);
    return metricRow({
        chatId: GROUP_CALC,
        startedAt,
        requestStartedAt: startedAt,
        firstChunkAt: new Date(startedAt.getTime() + firstChunkMs),
        finishedAt: new Date(startedAt.getTime() + firstChunkMs + 1000),
        outcome: index === 3 ? 'error' : 'ok',
        errorKind: index === 3 ? 'timeout' : null,
        model: 'gpt-6-luna',
        platform: 'openai',
        promptTokens: 1000,
        cachedTokens: 0,
        outputTokens: 100,
    });
});
for (const row of [...MAIN_ROWS, ...OTHER_ROWS, ...CALC_ROWS]) await insertReplyMetric(row);

// One conversation tree for the conversation statistics: two replies inside it
// and one reply of the same chat outside it
await registry.upsertChatNow({ id: GROUP_CONV, type: 'supergroup', title: 'Conv' });

const seedTreeMessage = (messageId: number, fields: { fromBot?: boolean; replyToId: number | null; text: string }) =>
    Message.create({
        chatId: GROUP_CONV,
        messageId,
        fromBotSelf: fields.fromBot === true,
        userId: fields.fromBot === true ? 7777 : ALICE.id,
        date: new Date(),
        userName: fields.fromBot === true ? 'Bot' : 'Alice',
        text: fields.text,
        quoteText: null,
        file: null,
        fileMime: null,
        fileUniqueId: null,
        replyToId: fields.replyToId,
        chatCommand: null,
        modelParts: null,
        mediaHint: null,
        forwardOrigin: null,
        forwardFromId: null,
        viaBot: null,
        ocrText: null,
    });

const convRoot = takeMessageId();
const convBot1 = takeMessageId();
const convUser2 = takeMessageId();
const convBot2 = takeMessageId();
const convOutsideBot = takeMessageId();
await seedTreeMessage(convRoot, { replyToId: null, text: '会话根' });
await seedTreeMessage(convBot1, { fromBot: true, replyToId: convRoot, text: '树内回复一' });
await seedTreeMessage(convUser2, { replyToId: convBot1, text: '树内追问' });
await seedTreeMessage(convBot2, { fromBot: true, replyToId: convUser2, text: '树内回复二' });
await seedTreeMessage(convOutsideBot, { fromBot: true, replyToId: null, text: '同一聊天但不在树里' });

await insertReplyMetric(
    metricRow({
        chatId: GROUP_CONV,
        userMessageId: convRoot,
        firstMessageId: convBot1,
        rounds: 2,
        toolCalls: 1,
        toolUsage: [{ name: 'search_history', count: 1, failed: 0 }],
    })
);
await insertReplyMetric(
    metricRow({
        chatId: GROUP_CONV,
        userMessageId: convUser2,
        firstMessageId: convBot2,
        outcome: 'error',
        errorKind: 'timeout',
        errorSummary: 'timed out',
        promptTokens: null,
        outputTokens: null,
        firstChunkAt: null,
        startedAt: new Date(Date.now() - 5 * DAY_MS),
    })
);
await insertReplyMetric(
    metricRow({
        chatId: GROUP_CONV,
        userMessageId: 1,
        firstMessageId: convOutsideBot,
        model: 'deepseek-flash',
        platform: 'deepseek',
        startedAt: new Date(Date.now() - 2 * DAY_MS),
    })
);

/** Ids and names that must never reach a statistics response */
const PERSONAL_MARKERS = [String(ALICE.id), String(BOB.id), '9999', 'Alice', 'Liddell', 'Bob', 'triggerUserId'];
const leaksPersonalData = (body: unknown): string | undefined => PERSONAL_MARKERS.find((marker) => json(body).includes(marker));

/** Bucket times and request times differ between two calls; the tables must not */
const withoutClock = (body: any) => ({ ...body, from: undefined, to: undefined });

// ---- live replies for /api/status ----

const startLiveReply = async (chatId: number, text: string): Promise<ChatContext> => {
    const messageId = takeMessageId();
    await dbIndex.saveMessage({ chatId, messageId, userId: ALICE.id, date: new Date(), userName: 'alice-stored', message: text });
    const ctx = contextOf(messageUpdate({ chatId, messageId, userId: ALICE.id, text }), createFakeTelegram());
    const chatContext = await quietly(() => responseHandler.createChatContext(ctx, { model: 'gemini-4-argon' }));
    if (!chatContext) throw new Error('no chat context');
    return chatContext;
};

const LONG_TRIGGER = '请帮我总结一下今天群里关于新版本发布计划的全部讨论内容，并列出每个人负责的任务和截止时间';
const liveMain = await startLiveReply(GROUP_MAIN, LONG_TRIGGER);
const liveOther = await startLiveReply(GROUP_OTHER, '另一个群的秘密问题');
const livePrivate = await startLiveReply(ALICE.id, '私聊里的问题');
markRequestStarted(liveMain.session.metrics);
liveMain.session.statusLine = '🔍 正在搜索…';

pushRecentReplyError({ at: new Date(), chatId: GROUP_OTHER, model: 'gemini-4-argon', errorKind: 'upstream', errorSummary: 'other chat failure', firstMessageId: 1 });
pushRecentReplyError({ at: new Date(), chatId: GROUP_MAIN, model: 'deepseek-flash', errorKind: 'rate_limit', errorSummary: 'main chat failure', firstMessageId: 2 });

// ---- cases ----

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: "stats for a chat: members and observers get the same tables, nobody's id or name",
        body: async () => {
            const member = await quietly(() => call(`/api/stats?chatId=${GROUP_MAIN}&range=7d`, ALICE));
            const observer = await quietly(() => call(`/api/stats?chatId=${GROUP_MAIN}&range=7d`, OWNER));
            expect(member.status === 200 && observer.status === 200, `200 for both (got ${member.status} / ${observer.status})`);
            const body = member.body;
            expect(
                json(Object.keys(body).sort()) ===
                    json(['bucket', 'chatId', 'chats', 'cost', 'costGroups', 'errorKinds', 'from', 'kpis', 'models', 'outcomes', 'pricing', 'range', 'recentErrors', 'series', 'timeZone', 'to', 'tools']),
                `top-level keys (got ${json(Object.keys(body))})`
            );
            expect(
                body.chatId === GROUP_MAIN && body.range === '7d' && body.bucket === 'day' && body.timeZone === STATS_TIME_ZONE,
                `scope, bucketed in the bot's zone (got ${body.timeZone})`
            );
            expect(json(withoutClock(member.body)) === json(withoutClock(observer.body)), 'the observer sees exactly what members see');
            expect(leaksPersonalData(member.body) === undefined, `no user id or name (found ${leaksPersonalData(member.body)})`);

            const { kpis } = body;
            expect(kpis.replies === 6 && kpis.retries === 1 && kpis.triggerUsers === 2, `volume over 7 days (got ${json(kpis)})`);
            expect(kpis.errorReplies === 1 && kpis.errorRate === Math.round((1 / 6) * 10_000) / 10_000, 'error rate');
            expect(json(body.outcomes) === json({ ok: 3, error: 1, stopped: 1, empty: 1 }), `outcomes (got ${json(body.outcomes)})`);
            expect(kpis.firstChunkP50Ms === 2000 && kpis.durationP50Ms === 6500, `speed (got ${kpis.firstChunkP50Ms} / ${kpis.durationP50Ms})`);
            expect(
                kpis.repliesWithUsage === 5 && kpis.promptTokens === 4500 && kpis.cachedTokens === 1600 && kpis.cacheHitRate === Math.round((1600 / 4500) * 10_000) / 10_000,
                `tokens over rows with usage (got ${json(kpis)})`
            );
            expect(kpis.toolCalls === 4 && kpis.toolFailures === 1 && kpis.avgContextMessages === 4, 'tools and context');
            expect(
                json(body.tools) ===
                    json([
                        { name: 'search_history', calls: 3, failures: 1, replies: 2, failureRate: Math.round((1 / 3) * 10_000) / 10_000 },
                        { name: 'fetch_url', calls: 1, failures: 0, replies: 1, failureRate: 0 },
                    ]),
                `tools, most calls first (got ${json(body.tools)})`
            );
            const [first, second] = body.models;
            expect(first?.model === 'gemini-4-argon' && first.replies === 4 && first.pricing === 'priced' && typeof first.costUsd === 'number', `argon first (got ${json(first)})`);
            expect(body.models.some((row: any) => row.model === 'my-own-model' && row.pricing === 'unpriced' && row.costUsd === null), 'an unpriced model row');
            expect(second?.replies === 1, 'then the single-reply models');
            expect(body.cost.pricedReplyRatio === Math.round((4 / 6) * 10_000) / 10_000, `priced share (got ${body.cost.pricedReplyRatio})`);
            expect(body.kpis.costUsd === body.cost.costUsd, 'the KPI cost is the total');
            expect(json(body.errorKinds) === json([{ kind: 'rate_limit', count: 1 }]), 'error kinds');
            expect(
                body.recentErrors.length === 1 &&
                    body.recentErrors[0].chatTitle === null &&
                    body.recentErrors[0].errorSummary === '429 Too Many Requests' &&
                    typeof body.recentErrors[0].firstMessageId === 'number',
                `recent errors without titles in a chat view (got ${json(body.recentErrors)})`
            );
            const { series } = body;
            expect(series.buckets.length >= 7 && series.buckets.length <= 8, `7 days of buckets (got ${series.buckets.length})`);
            const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);
            expect(sum(series.replies) === 6 && sum(series.errors) === 1, 'the series adds up to the KPIs');
            expect(
                series.byModel.every((line: any) => line.values.length === series.buckets.length) && series.byChat === null && body.chats === null,
                'every line has a value per bucket; no per-chat lines in a chat view'
            );

            const stranger = await quietly(() => call(`/api/stats?chatId=${GROUP_MAIN}`, BOB));
            expect(stranger.status === 403 && stranger.body?.error?.code === 'forbidden', 'a non-member is refused');
        },
    },
    {
        name: 'stats without a chat: owner only, with per-chat rows and lines',
        body: async () => {
            const refused = await quietly(() => call('/api/stats', ALICE));
            expect(refused.status === 403 && refused.body?.error?.code === 'forbidden', 'a member is not the owner');
            const owner = await quietly(() => call('/api/stats?range=7d', OWNER));
            expect(owner.status === 200 && owner.body.chatId === null, 'the owner gets every chat');
            const chats = owner.body.chats;
            expect(
                json(chats.map((chat: any) => [chat.chatId, chat.title, chat.replies])) ===
                    json([[GROUP_MAIN, 'Main', 6], [GROUP_CALC, 'Calc', 4], [GROUP_CONV, 'Conv', 3], [GROUP_OTHER, 'Other', 1]]),
                `per-chat rows, most replies first (got ${json(chats)})`
            );
            expect(
                owner.body.series.byChat.some((line: any) => line.key === String(GROUP_MAIN) && line.label === 'Main'),
                'per-chat lines carry the title'
            );
            expect(owner.body.recentErrors.some((row: any) => row.chatTitle === 'Other'), 'errors name their chat for the owner');
            expect(!json(owner.body).includes('triggerUserId') && !json(owner.body).includes(String(ALICE.id)), 'still no user ids');
        },
    },
    {
        name: 'ranges: hourly for 24h, daily otherwise, all from the first row; unknown ranges are 400',
        body: async () => {
            const day = await quietly(() => call(`/api/stats?chatId=${GROUP_MAIN}&range=24h`, ALICE));
            expect(day.body.bucket === 'hour' && day.body.series.buckets.length >= 24 && day.body.series.buckets.length <= 25, `24h: hourly (got ${day.body.series.buckets.length})`);
            expect(/^\d{4}-\d{2}-\d{2} \d{2}:00$/.test(day.body.series.buckets[0]), `hour labels (got ${day.body.series.buckets[0]})`);
            expect(day.body.kpis.replies === 4, `the last 24h (got ${day.body.kpis.replies})`);
            const month = await quietly(() => call(`/api/stats?chatId=${GROUP_MAIN}&range=30d`, ALICE));
            expect(month.body.kpis.replies === 7, '30d reaches the old row');
            const all = await quietly(() => call(`/api/stats?chatId=${GROUP_MAIN}&range=all`, ALICE));
            expect(
                all.body.kpis.replies === 7 && all.body.bucket === 'day' && Date.parse(all.body.from) <= Date.now() - 29 * DAY_MS,
                `all starts at the first row (got ${all.body.from})`
            );
            const defaulted = await quietly(() => call(`/api/stats?chatId=${GROUP_MAIN}`, ALICE));
            expect(defaulted.body.range === '7d', 'the default range is 7d');
            const invalid = await quietly(() => call(`/api/stats?chatId=${GROUP_MAIN}&range=1y`, ALICE));
            expect(invalid.status === 400 && invalid.body?.error?.code === 'invalid', 'an unknown range is 400');
            const badChat = await quietly(() => call('/api/stats?chatId=abc', ALICE));
            expect(badChat.status === 400, 'a malformed chatId is 400');
        },
    },
    {
        name: 'percentiles interpolate, per-model speed and token averages',
        body: async () => {
            const calc = await quietly(() => call(`/api/stats?chatId=${GROUP_CALC}&range=7d`, ALICE));
            const { kpis, models } = calc.body;
            expect(kpis.firstChunkP50Ms === 2500 && kpis.firstChunkP95Ms === 3850, `p50 / p95 of 1-4s (got ${kpis.firstChunkP50Ms} / ${kpis.firstChunkP95Ms})`);
            expect(kpis.durationP50Ms === 3500, `duration p50 (got ${kpis.durationP50Ms})`);
            const [luna] = models;
            expect(
                luna?.model === 'gpt-6-luna' &&
                    luna.errorRate === 0.25 &&
                    luna.avgPromptTokens === 1000 &&
                    luna.outputCharsPerSecond === 400 &&
                    luna.costUsd === Math.round(((4000 * 0.1 + 400 * 0.5) / 1e6) * 1e6) / 1e6,
                `the model row (got ${json(luna)})`
            );
        },
    },
    {
        name: "the dashboard summary: the last 7 days, null for a chat without replies",
        body: async () => {
            const dashboard = await quietly(() => call(`/api/chats/${GROUP_MAIN}`, ALICE));
            const { summary } = dashboard.body;
            expect(
                json(Object.keys(summary).sort()) ===
                    json(['costUsd', 'days', 'errorRate', 'errorReplies', 'firstChunkP50Ms', 'pricedReplyRatio', 'replies']),
                `summary keys (got ${json(summary)})`
            );
            expect(
                summary.days === 7 &&
                    summary.replies === 6 &&
                    summary.errorReplies === 1 &&
                    summary.firstChunkP50Ms === 2000 &&
                    typeof summary.costUsd === 'number' &&
                    summary.pricedReplyRatio === Math.round((4 / 6) * 10_000) / 10_000,
                `values (got ${json(summary)})`
            );
            const observed = await quietly(() => call(`/api/chats/${GROUP_MAIN}`, OWNER));
            expect(json(observed.body.summary) === json(summary), 'the observer gets the same summary');
            const quiet = await quietly(() => call(`/api/chats/${ALICE.id}`, ALICE));
            expect(quiet.status === 200 && quiet.body.summary === null, 'no replies in 7 days: null');
        },
    },
    {
        name: 'status for the owner: process facts, every live reply observed without its trigger text',
        body: async () => {
            const owner = await quietly(() => call('/api/status', OWNER));
            expect(owner.status === 200, '200');
            const { process: facts } = owner.body;
            expect(
                facts.online === true &&
                    facts.version === 'abc1234' &&
                    facts.uptimeSeconds >= 90 &&
                    facts.testInstance === false &&
                    facts.globalDefaultModel === 'env-default-model' &&
                    facts.globalDefaultModelSource === 'env' &&
                    Array.isArray(facts.mcpServers) &&
                    facts.lastCleanup === null &&
                    facts.pricing?.version === priceTableVersion() &&
                    facts.pricing.lastRunAt === null &&
                    facts.pricing.lastOutcome === null &&
                    facts.pricing.pendingProposals === 0,
                `process facts and the price watcher's (got ${json(facts)})`
            );
            const active = owner.body.active;
            expect(active.length === 3, `all three live replies (got ${active.length})`);
            expect(active.every((entry: any) => entry.access === 'observer' && entry.trigger === null), 'observed, never with the trigger');
            expect(!json(owner.body).includes('秘密问题') && !json(owner.body).includes('私聊里的问题'), 'no trigger text anywhere');
            const main = active.find((entry: any) => entry.chat.chatId === GROUP_MAIN);
            expect(
                main?.phase === 'waiting' &&
                    main.statusLine === '🔍 正在搜索…' &&
                    main.model === 'gemini-4-argon' &&
                    main.chat.title === 'Main' &&
                    typeof main.elapsedMs === 'number',
                `phase, status line and chat of a live reply (got ${json(main)})`
            );
            expect(active.find((entry: any) => entry.chat.chatId === GROUP_OTHER)?.phase === 'preparing', 'no request yet: preparing');
            expect(owner.body.recentErrors.length >= 2 && owner.body.recentErrors[0].errorSummary === 'main chat failure', 'recent errors, newest first');
        },
    },
    {
        name: 'status for a member: own chats with the trigger, candidates only, nothing else looked up',
        body: async () => {
            lookups.length = 0;
            const plain = await quietly(() => call('/api/status', ALICE));
            expect(plain.status === 200 && plain.body.process === null, 'no process facts for a member');
            const chatIds = plain.body.active.map((entry: any) => entry.chat.chatId);
            expect(json(chatIds) === json([ALICE.id]), `only her private chat: Main is no candidate without the hint (got ${json(chatIds)})`);
            const privateEntry = plain.body.active[0];
            expect(
                privateEntry.access === 'member' &&
                    privateEntry.trigger?.text === '私聊里的问题' &&
                    typeof privateEntry.trigger?.authorName === 'string' &&
                    privateEntry.trigger.messageId === livePrivate.userMessageId,
                `members see what the reply answers (got ${json(privateEntry)})`
            );
            expect(plain.body.recentErrors.length === 0, 'no errors of her chats');
            expect(!lookups.some((key) => key.startsWith(String(GROUP_OTHER)) || key.startsWith(String(GROUP_MAIN))), `chats outside her candidates were never looked up (got ${json(lookups)})`);

            const hinted = await quietly(() => call('/api/status', ALICE, `c${GROUP_MAIN}`));
            const main = hinted.body.active.find((entry: any) => entry.chat.chatId === GROUP_MAIN);
            expect(
                main?.access === 'member' &&
                    main.trigger?.text === `${Array.from(LONG_TRIGGER).slice(0, 40).join('')}…` &&
                    main.trigger.messageId === liveMain.userMessageId,
                `with the Direct Link hint Main shows, trigger cut to 40 characters (got ${json(main)})`
            );
            expect(!hinted.body.active.some((entry: any) => entry.chat.chatId === GROUP_OTHER), 'never the chat she is not in');
            expect(
                json(hinted.body.recentErrors.map((entry: any) => entry.errorSummary)) === json(['main chat failure']),
                `errors of visible chats only (got ${json(hinted.body.recentErrors)})`
            );

            const stranger = await quietly(() => call('/api/status', BOB));
            expect(stranger.status === 200 && stranger.body.active.length === 0 && stranger.body.recentErrors.length === 0, 'a stranger sees nothing live');
        },
    },
    {
        name: "a conversation's statistics: only the tree's replies, its whole life, observers included",
        body: async () => {
            const path = `/api/chats/${GROUP_CONV}/conversations/${convRoot}/stats`;
            const member = await quietly(() => call(path, ALICE));
            expect(member.status === 200, `200 for a member (got ${member.status} ${json(member.body).slice(0, 160)})`);
            const body = member.body;
            expect(body.chatId === GROUP_CONV && body.range === 'all' && body.bucket === 'day', "the tree's whole life, bucketed by day");
            expect(body.kpis.replies === 2, `only the two replies of the tree (got ${body.kpis.replies})`);
            expect(
                body.kpis.errorReplies === 1 && json(body.outcomes) === json({ ok: 1, error: 1, stopped: 0, empty: 0 }),
                'outcomes of the tree only'
            );
            expect(
                json(body.models.map((row: any) => row.model)) === json(['gemini-4-argon']),
                `the outside reply's model is left out (got ${json(body.models.map((row: any) => row.model))})`
            );
            expect(body.chats === null, 'no chat ranking for one conversation');
            expect(leaksPersonalData(body) === undefined, `no user id or name (found ${leaksPersonalData(body)})`);
            expect(body.from <= body.to && body.series.buckets.length > 0, 'the series spans the tree');

            const observer = await quietly(() => call(path, OWNER));
            expect(
                observer.status === 200 && json(withoutClock(observer.body)) === json(withoutClock(member.body)),
                'an observer sees the same statistics'
            );

            const missing = await quietly(() => call(`/api/chats/${GROUP_CONV}/conversations/999999999/stats`, ALICE));
            expect(missing.status === 404, `an unknown root is a 404 (got ${missing.status})`);
        },
    },
    {
        name: 'a finished reply leaves the live list',
        body: async () => {
            await quietly(async () => {
                for (const live of [liveMain, liveOther, livePrivate]) {
                    await responseHandler.sendFinalResponse(live, { text: 'done', thinkingText: '', images: [] });
                }
            });
            const owner = await quietly(() => call('/api/status', OWNER));
            expect(owner.body.active.length === 0, `nothing live any more (got ${owner.body.active.length})`);
        },
    },
];

cases.push({
    name: 'Priority PayGo: hits over the replies that asked, stray rounds apart, the split cost everywhere',
    body: async () => {
        await registry.upsertChatNow({ id: GROUP_PRIORITY, type: 'supergroup', title: 'Priority' });
        const priorityRow = (fields: Partial<ReplyMetricInput>): ReplyMetricInput =>
            metricRow({ chatId: GROUP_PRIORITY, triggerUserId: 9999, ...fields });
        const rows: ReplyMetricInput[] = [
            // Asked: 1 of 3 rounds served at the priority tier
            priorityRow({
                rounds: 3,
                promptTokens: 3000,
                cachedTokens: 1000,
                outputTokens: 300,
                tierRequested: 'priority',
                priorityRounds: 1,
                priorityPromptTokens: 1000,
                priorityCachedTokens: 500,
                priorityOutputTokens: 100,
            }),
            // Asked, both rounds downgraded
            priorityRow({ rounds: 2, promptTokens: 2000, cachedTokens: 0, outputTokens: 200, tierRequested: 'priority' }),
            // Asked, failed without usage: its round still counts in the denominator
            priorityRow({
                rounds: 1,
                outcome: 'error',
                errorKind: 'rate_limit',
                errorSummary: '429',
                promptTokens: null,
                cachedTokens: null,
                outputTokens: null,
                firstChunkAt: null,
                tierRequested: 'priority',
            }),
            // Never asked, yet one round came back at the priority tier
            priorityRow({
                rounds: 2,
                promptTokens: 1000,
                cachedTokens: 0,
                outputTokens: 100,
                priorityRounds: 1,
                priorityPromptTokens: 500,
                priorityCachedTokens: 0,
                priorityOutputTokens: 50,
            }),
            // A model without a priority price, with a stray priority round
            // (nano-banana has one since 2026-11-13, so MiMo stands in here)
            priorityRow({
                model: 'mimo-v2.6-flash',
                platform: 'mimo',
                promptTokens: 100,
                cachedTokens: 0,
                outputTokens: 10,
                priorityRounds: 1,
                priorityPromptTokens: 100,
                priorityCachedTokens: 0,
                priorityOutputTokens: 10,
            }),
            priorityRow({ model: 'deepseek-flash', platform: 'deepseek', promptTokens: 500, cachedTokens: 0, outputTokens: 50 }),
        ];
        for (const row of rows) await insertReplyMetric(row);

        const stats = await quietly(() => call(`/api/stats?chatId=${GROUP_PRIORITY}&range=7d`, OWNER));
        expect(stats.status === 200, `200 (got ${stats.status})`);
        const { kpis, models, costGroups, cost } = stats.body;
        const modelRow = (model: string) => models.find((row: any) => row.model === model);
        const hitsOf = (row: any) => ({
            priorityReplies: row?.priorityReplies,
            priorityRequestedRounds: row?.priorityRequestedRounds,
            priorityHitRounds: row?.priorityHitRounds,
            priorityHitRate: row?.priorityHitRate,
            strayPriorityRounds: row?.strayPriorityRounds,
        });
        const oneInSix = Math.round((1 / 6) * 10_000) / 10_000;
        expect(
            json(hitsOf(modelRow('gemini-4-argon'))) ===
                json({ priorityReplies: 3, priorityRequestedRounds: 6, priorityHitRounds: 1, priorityHitRate: oneInSix, strayPriorityRounds: 1 }),
            `argon: 1 of the 6 asked rounds hit, the stray round kept apart (got ${json(hitsOf(modelRow('gemini-4-argon')))})`
        );
        expect(
            json(hitsOf(modelRow('deepseek-flash'))) ===
                json({ priorityReplies: 0, priorityRequestedRounds: 0, priorityHitRounds: 0, priorityHitRate: null, strayPriorityRounds: 0 }),
            'a model that never asked: zeros and no rate'
        );
        expect(
            json(hitsOf(kpis)) ===
                json({ priorityReplies: 3, priorityRequestedRounds: 6, priorityHitRounds: 1, priorityHitRate: oneInSix, strayPriorityRounds: 2 }),
            `the KPIs: the same hit rate, both stray rounds (got ${json(hitsOf(kpis))})`
        );

        const argonCost = (4000 * 2 + 500 * 0.1 + 450 * 10 + 1000 * 3.6 + 500 * 0.18 + 150 * 18) / 1e6;
        // No priority price: the stray priority round is priced at the standard one
        const fallbackCost = (100 * 0.14 + 10 * 0.28) / 1e6;
        const deepseekCost = (500 * 0.3 + 50 * 1.2) / 1e6;
        const usd = (value: number): number => Math.round(value * 1e6) / 1e6;
        const argon = modelRow('gemini-4-argon');
        expect(
            argon?.costUsd === usd(argonCost) && argon.pricing === 'priced' && argon.priorityAtStandardPrice === false,
            `argon's row: standard part + priority part at 1.8x (got ${argon?.costUsd}, want ${usd(argonCost)})`
        );
        const fallback = modelRow('mimo-v2.6-flash');
        expect(
            fallback?.costUsd === usd(fallbackCost) && fallback.priorityAtStandardPrice === true,
            `no priority price: the standard price, and the row says so (got ${json(fallback)})`
        );
        expect(modelRow('deepseek-flash')?.priorityAtStandardPrice === false, 'no priority rounds: no note');
        expect(
            costGroups.find((group: any) => group.model === 'mimo-v2.6-flash')?.priorityAtStandardPrice === true &&
                costGroups.find((group: any) => group.model === 'gemini-4-argon')?.priorityAtStandardPrice === false,
            'the cost groups carry the note too'
        );
        expect(
            cost.costUsd === usd(argonCost + fallbackCost + deepseekCost) && kpis.costUsd === cost.costUsd,
            `the total follows the split (got ${cost.costUsd})`
        );

        const dashboard = await quietly(() => call(`/api/chats/${GROUP_PRIORITY}`, OWNER));
        expect(
            dashboard.body.summary?.costUsd === cost.costUsd,
            `the dashboard summary prices the same way (got ${dashboard.body.summary?.costUsd})`
        );
    },
});

cases.push({
    name: 'pricing metadata on /api/stats: version, freshness, next changes, unpriced models, owner-only pending count',
    body: async () => {
        const pending = await PriceChangeProposal.create({
            kind: 'update',
            model: 'gemini-4-argon',
            tier: 'standard',
            effectiveFrom: new Date('2026-12-01T00:00:00Z'),
            payload: '{}',
            detectedAt: new Date(),
            status: 'pending',
        });
        try {
            const member = await quietly(() => call(`/api/stats?chatId=${GROUP_MAIN}&range=7d`, ALICE));
            expect(member.status === 200 && member.body.pricing !== undefined, '200 with the pricing block');
            const meta = member.body.pricing;
            expect(meta.version === priceTableVersion(), `the price table version (got ${json(meta.version)})`);
            expect(
                typeof meta.checkedOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(meta.checkedOn),
                `the oldest checkedOn (got ${json(meta.checkedOn)})`
            );
            expect(
                meta.sources.length > 0 &&
                    meta.sources.every((source: any) =>
                        ['manual', 'models-dev', 'official', 'ephone'].includes(source.kind) && typeof source.checkedOn === 'string'
                    ),
                `the source list (got ${json(meta.sources)})`
            );
            expect(
                Array.isArray(meta.nextChanges) &&
                    meta.nextChanges.every((change: any) => typeof change.at === 'string' && typeof change.summary === 'string'),
                `the next price changes (got ${json(meta.nextChanges)})`
            );
            expect(
                meta.unpricedModels.includes('my-own-model'),
                `a model of the window without a price (got ${json(meta.unpricedModels)})`
            );
            expect(meta.pendingProposals === 0, `a member sees no pending proposals (got ${meta.pendingProposals})`);

            const owner = await quietly(() => call('/api/stats?range=7d', OWNER));
            expect(owner.status === 200, '200 for the owner');
            expect(owner.body.pricing.pendingProposals === 1, `the owner sees the pending proposal (got ${owner.body.pricing.pendingProposals})`);
            expect(
                json(owner.body.pricing.nextChanges) === json(meta.nextChanges),
                'the rest of the block does not depend on who asks'
            );

            const stranger = await quietly(() => call(`/api/stats?chatId=${GROUP_MAIN}&range=7d`, BOB));
            expect(stranger.status === 403 && stranger.body?.pricing === undefined, 'no metadata for a non-member');
        } finally {
            await pending.destroy();
        }
    },
});

const jsonObjectOf = async (response: Response): Promise<Record<string, unknown>> => {
    const body: unknown = await response.json();
    return typeof body === 'object' && body !== null ? Object.fromEntries(Object.entries(body)) : {};
};

cases.push({
    name: 'health reports the in-memory price table version without auth or the database',
    body: async () => {
        const response = await app.request('/api/health');
        const body = await jsonObjectOf(response);
        expect(response.status === 200 && body.ok === true, '200 ok');
        expect(body.priceTableVersion === priceTableVersion(), `priceTableVersion (got ${json(body.priceTableVersion)})`);
        await PriceChangeProposal.destroy({ where: { status: 'pending' } });
        const again = await app.request('/api/health');
        expect((await jsonObjectOf(again)).priceTableVersion === priceTableVersion(), 'it is the memory value, not a DB read');
    },
});

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
reportResults(results);
