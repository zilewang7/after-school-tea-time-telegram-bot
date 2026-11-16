/**
 * Offline cases for the trial spend quota (design 2026-1116-1500 §D1/§D2/§D7,
 * test plan §8.1): what one trial user's replies have cost (row pricing at the
 * price in force, image generations, unpriced rows, the >= boundary) and the
 * gates at the entry points that can start a charged generation — a normal
 * reply, /picbanana, a retry button, a gen: button — plus what an allowed
 * turn's runtime tail and `/apply` show.
 *
 * Tiering is on (ACCESS_TIERS=1); the limit is overridden per case through
 * TRIAL_SPEND_LIMIT_USD. A refused entry must leave nothing behind: no typing,
 * no placeholder, no BotResponse and no model request (fetch is counted).
 *
 * Run: npx tsx scripts/offline/trial-quota.mts
 */
import { expect, reportResults, runCase, setupOfflineDb, takeMessageId, type CaseResult } from './harness.mts';
import {
    callbackUpdate,
    contextOf,
    createFakeBot,
    createFakeTelegram,
    lastToastOf,
    messageUpdate,
    quietly,
    waitUntil,
} from './fake-telegram.mts';

// Tiering is off in the harness by default; this file is about the quota.
process.env.ACCESS_TIERS = '1';
const OWNER_ID = 4242;
/** A positive TOOL_CHAT_IDS entry: full without any group */
const FULL_USER_ID = 5151;
/** Any user not listed anywhere: trial in every chat */
const TRIAL_USER_ID = 6262;

process.env.OWNER_USER_ID = String(OWNER_ID);
// Only the full user is listed: no group is an access group, so everyone else
// resolves as trial (the membership lookup is never asked without a group)
process.env.TOOL_CHAT_IDS = String(FULL_USER_ID);
delete process.env.ACCESS_GROUP_IDS;
process.env.DEFAULT_MODEL = 'gemini-4-argon';
process.env.BOT_USER_NAME = 'AfterSchoolTeatimeBot';
process.env.BOT_USER_ID = '7777';

await setupOfflineDb();

const dbIndex = await import('../../src/db/index.js');
const { sequelize } = await import('../../src/db/config.js');
const { findTrialReplyMetricsByUser, insertReplyMetric } = await import('../../src/db/queries/reply-metrics.js');
const { trialSpendLimitUsd, TRIAL_MODEL } = await import('../../src/config/trial-access.js');
const { buildRuntimeContext } = await import('../../src/ai/system-prompt/runtime-context.js');
const { buildStaticSystemPrompt } = await import('../../src/ai/system-prompt/index.js');
const { replyRowCostUsd, imageGenerationCostUsd } = await import('../../src/services/usage-cost.js');
const { checkTrialQuota, estimateTrialSpend } = await import('../../src/services/trial-quota.js');
const { triggerAccessNoteOf } = await import('../../src/reply/trigger-access-note.js');
const { handleReply, registerChatHandler } = await import('../../src/reply/chat-handler.js');
const { handleRetryRequest } = await import('../../src/reply/retry-handler.js');
const { registerGenerationCallbacks } = await import('../../src/cmd/menus/generation-menu.js');
const { registerApplyCommand } = await import('../../src/cmd/commands/apply.js');
const { listActiveSessions } = await import('../../src/services/bot-message-service.js');
const {
    TRIAL_CALLBACK_REFUSAL_TEXT,
    TRIAL_QUOTA_CALLBACK_TEXT,
    trialQuotaRefusalText,
} = await import('../../src/reply/commands/trial-refusal.js');

type ReplyMetricInput = import('../../src/db/queries/reply-metrics.js').ReplyMetricInput;

const json = (value: unknown): string => JSON.stringify(value);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Run `body` with one TRIAL_SPEND_LIMIT_USD, restoring the previous value */
const withLimit = async <T,>(limit: string, body: () => Promise<T>): Promise<T> => {
    const previous = process.env.TRIAL_SPEND_LIMIT_USD;
    process.env.TRIAL_SPEND_LIMIT_USD = limit;
    try {
        return await body();
    } finally {
        if (previous === undefined) delete process.env.TRIAL_SPEND_LIMIT_USD;
        else process.env.TRIAL_SPEND_LIMIT_USD = previous;
    }
};

/** Run `body`, counting every fetch call: a refused entry may make none */
const countingModelRequests = async <T,>(body: () => Promise<T>): Promise<{ result: T; fetchCalls: number }> => {
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (input, init) => {
        fetchCalls += 1;
        return realFetch(input, init);
    };
    try {
        return { result: await body(), fetchCalls };
    } finally {
        globalThis.fetch = realFetch;
    }
};

let nextRowId = 900_000;
const takeRowIds = (): { chatId: number; firstMessageId: number } => {
    nextRowId += 2;
    return { chatId: -1009000000000 - nextRowId, firstMessageId: nextRowId + 1 };
};

/** A stored reply_metrics row with every column given; one round with usage unless overridden */
const storedRow = (fields: Partial<ReplyMetricInput>): ReplyMetricInput => {
    const ids = takeRowIds();
    const now = Date.now();
    return {
        chatId: ids.chatId,
        userMessageId: ids.firstMessageId - 1,
        firstMessageId: ids.firstMessageId,
        versionId: 1,
        triggerUserId: null,
        model: TRIAL_MODEL,
        platform: 'gemini',
        route: null,
        commandType: 'chat',
        isRetry: false,
        startedAt: new Date(now - 60_000),
        requestStartedAt: null,
        firstChunkAt: null,
        finishedAt: new Date(now),
        outcome: 'ok',
        errorKind: null,
        errorSummary: null,
        rounds: 1,
        toolCalls: 0,
        toolFailures: 0,
        toolUsage: [],
        promptTokens: 1000,
        cachedTokens: 0,
        cacheWriteTokens: null,
        outputTokens: 100,
        thoughtsTokens: null,
        imageOutputTokens: null,
        contextMessages: 1,
        contextImages: 0,
        textChars: 1,
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

/** One trial-tier row of `userId` worth roughly `costUsd` ($1.5 per 1M hydrogen input tokens) */
const insertTrialSpend = async (userId: number, costUsd: number): Promise<void> => {
    await insertReplyMetric(
        storedRow({
            triggerUserId: userId,
            accessTier: 'trial',
            promptTokens: Math.round((costUsd / 1.5) * 1_000_000),
            cachedTokens: 0,
            outputTokens: 0,
            startedAt: new Date('2026-11-15T00:00:00Z'),
        })
    );
};

/** A message as the user posts it in their private chat (the fake API accepts any id) */
const privateChatIdOf = (userId: number): number => userId;

/** A stored bot reply a retry button may be pressed on */
const insertBotReply = async (chatId: number, firstMessageId: number, userId: number): Promise<void> => {
    await dbIndex.BotResponse.create({
        messageId: firstMessageId,
        chatId,
        userMessageId: firstMessageId - 1,
        currentVersionIndex: 0,
        versions: JSON.stringify([
            {
                versionId: 1,
                createdAt: new Date().toISOString(),
                messageIds: [firstMessageId],
                currentMessageId: firstMessageId,
                text: '旧回复',
                wasStoppedByUser: false,
            },
        ]),
        buttonState: dbIndex.ButtonState.HAS_VERSIONS,
        metadata: JSON.stringify({ model: TRIAL_MODEL, hasImage: false }),
    });
    expect(userId > 0, 'the fixture author is a real user id');
};

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'each row is priced at the price in force when it started (across a price change)',
        body: async () => {
            const userId = 6401;
            const before = new Date('2026-11-15T00:00:00Z');
            const after = new Date('2026-12-02T00:00:00Z');
            // gemini-4-argon: 2 / 0.1 / 10 until 2026-12-01, then 4 / 0.2 / 20
            for (const startedAt of [before, after]) {
                await insertReplyMetric(
                    storedRow({
                        triggerUserId: userId,
                        accessTier: 'trial',
                        model: 'gemini-4-argon',
                        startedAt,
                        promptTokens: 1_000_000,
                        cachedTokens: 0,
                        cacheWriteTokens: null,
                        outputTokens: 0,
                    })
                );
            }

            const rows = await findTrialReplyMetricsByUser(userId);
            expect(rows.length === 2, `both rows are read (got ${rows.length})`);
            expect(rows[0] !== undefined && replyRowCostUsd(rows[0]).costUsd === 2, 'the pre-change row prices at 2/M');
            expect(rows[1] !== undefined && replyRowCostUsd(rows[1]).costUsd === 4, 'the post-change row prices at 4/M');

            const spend = await withLimit('1000', () => estimateTrialSpend(userId));
            expect(
                spend.usedUsd === 6 && spend.exceeded === false && spend.unpricedRows === 0,
                `the sum keeps each row's own price (got ${json(spend)})`
            );
            expect(spend.limitUsd === 1000, 'the limit comes from the environment override');
        },
    },
    {
        name: 'only this user\'s trial rows count: full, owner and pre-feature (NULL) rows never do',
        body: async () => {
            const userId = 6402;
            const otherUserId = 6403;
            const trialRowOf = (tier: 'trial' | 'full' | null): ReplyMetricInput =>
                storedRow({
                    triggerUserId: userId,
                    accessTier: tier,
                    model: 'gemini-4-argon',
                    // all three rows cost the same $2
                    promptTokens: 1_000_000,
                    cachedTokens: 0,
                    cacheWriteTokens: null,
                    outputTokens: 0,
                    startedAt: new Date('2026-11-15T00:00:00Z'),
                });
            await insertReplyMetric(trialRowOf('trial'));
            await insertReplyMetric(trialRowOf('full'));
            await insertReplyMetric(trialRowOf(null));
            await insertReplyMetric(
                storedRow({
                    triggerUserId: otherUserId,
                    accessTier: 'trial',
                    model: 'gemini-4-argon',
                    promptTokens: 1_000_000,
                    cachedTokens: 0,
                    cacheWriteTokens: null,
                    outputTokens: 0,
                    startedAt: new Date('2026-11-15T00:00:00Z'),
                })
            );

            const spend = await estimateTrialSpend(userId);
            expect(spend.usedUsd === 2, `only the trial row is counted (got ${json(spend)})`);
            expect((await estimateTrialSpend(otherUserId)).usedUsd === 2, "another user's rows are not counted");
        },
    },
    {
        name: 'in-reply image generations are part of the estimate (per image when a generation reported no usage)',
        body: async () => {
            const userId = 6404;
            await insertReplyMetric(
                storedRow({
                    triggerUserId: userId,
                    accessTier: 'trial',
                    model: TRIAL_MODEL,
                    // a chat part with nothing to price: 0 tokens is still usage
                    promptTokens: 0,
                    cachedTokens: 0,
                    outputTokens: 0,
                    imageGenerationUsage: [
                        {
                            model: 'gemini-nano-banana-2.1',
                            generations: 2,
                            generationsWithUsage: 0,
                            promptTokens: null,
                            cachedTokens: null,
                            cacheWriteTokens: null,
                            outputTokens: null,
                            thoughtsTokens: null,
                            imageOutputTokens: null,
                        },
                        {
                            model: 'gpt-image-2.5-dev',
                            generations: 1,
                            generationsWithUsage: 0,
                            promptTokens: null,
                            cachedTokens: null,
                            cacheWriteTokens: null,
                            outputTokens: null,
                            thoughtsTokens: null,
                            imageOutputTokens: null,
                        },
                    ],
                })
            );

            const spend = await estimateTrialSpend(userId);
            const expected = 2 * 0.0336 + 0.1048;
            expect(
                Math.abs(spend.usedUsd - expected) < 1e-6,
                `banana per image ($0.0336 x2) plus gpt ($0.1048) (got ${json(spend)})`
            );
            expect(spend.unpricedRows === 0, 'a per-image price means the row is priced');
        },
    },
    {
        name: 'a banana generation that reported usage is priced by its tokens',
        body: async () => {
            const userId = 6405;
            const image = {
                model: 'gemini-nano-banana-2.1',
                generations: 1,
                generationsWithUsage: 1,
                promptTokens: 78,
                cachedTokens: 0,
                cacheWriteTokens: null,
                outputTokens: 1120,
                thoughtsTokens: 1308,
                imageOutputTokens: 1120,
            };
            await insertReplyMetric(
                storedRow({
                    triggerUserId: userId,
                    accessTier: 'trial',
                    model: TRIAL_MODEL,
                    promptTokens: 0,
                    cachedTokens: 0,
                    outputTokens: 0,
                    imageGenerationUsage: [image],
                })
            );
            const rows = await findTrialReplyMetricsByUser(userId);
            const row = rows[0];
            if (row === undefined) throw new Error('the row was not stored');
            const imageCost = imageGenerationCostUsd(row);
            expect(
                imageCost.generations === 1 && imageCost.pricedGenerations === 1 && imageCost.costUsd !== null,
                `the generation is priced from its usage (got ${json(imageCost)})`
            );
            // 78 input tokens at 1.5/M + 1120 image tokens at 30/M
            const expected = (78 * 1.5 + 1120 * 30) / 1_000_000;
            expect(
                Math.abs((imageCost.costUsd ?? 0) - expected) < 1e-9,
                `per-token image cost (got ${json(imageCost)})`
            );
        },
    },
    {
        name: 'a row nothing can price is only reported: an unknown model, and an image row without usage falls back to its per-image price',
        body: async () => {
            const userId = 6406;
            await insertReplyMetric(
                storedRow({
                    triggerUserId: userId,
                    accessTier: 'trial',
                    model: 'unknown-model-for-quota',
                    promptTokens: 10,
                    cachedTokens: 0,
                    outputTokens: 10,
                })
            );
            // A /picgpt row: the images API reports no usage, so it is priced per image
            await insertReplyMetric(
                storedRow({
                    triggerUserId: userId,
                    accessTier: 'trial',
                    model: 'gpt-image-2.5-dev',
                    commandType: 'picgpt',
                    promptTokens: null,
                    cachedTokens: null,
                    outputTokens: null,
                    imageOutputTokens: null,
                    imageCount: 2,
                    hasImage: true,
                })
            );

            const spend = await estimateTrialSpend(userId);
            expect(spend.unpricedRows === 1, `the unknown model is reported, never counted as 0 (got ${json(spend)})`);
            expect(
                Math.abs(spend.usedUsd - 2 * 0.1048) < 1e-6,
                `the no-usage image row is priced per image (got ${json(spend)})`
            );
        },
    },
    {
        name: 'the boundary is inclusive: usedUsd === limitUsd refuses the next generation',
        body: async () => {
            const userId = 6407;
            // hydrogen input 1.5/M: 2M tokens = exactly $3
            await insertReplyMetric(
                storedRow({
                    triggerUserId: userId,
                    accessTier: 'trial',
                    model: TRIAL_MODEL,
                    promptTokens: 2_000_000,
                    cachedTokens: 0,
                    cacheWriteTokens: null,
                    outputTokens: 0,
                    startedAt: new Date('2026-11-15T00:00:00Z'),
                })
            );

            const spend = await withLimit('3', () => estimateTrialSpend(userId));
            expect(spend.usedUsd === 3 && spend.exceeded === true, `$3 of $3 is over the cap (got ${json(spend)})`);
            const gate = await withLimit('3', () => checkTrialQuota('trial', userId));
            expect(gate !== null && gate.exceeded === true, 'the gate agrees');
        },
    },
    {
        name: 'TRIAL_SPEND_LIMIT_USD: default, valid override, and every invalid value falls back to 3',
        body: async () => {
            const previous = process.env.TRIAL_SPEND_LIMIT_USD;
            try {
                delete process.env.TRIAL_SPEND_LIMIT_USD;
                expect(trialSpendLimitUsd() === 3, 'unset means $3');
                process.env.TRIAL_SPEND_LIMIT_USD = '';
                expect(trialSpendLimitUsd() === 3, 'empty means $3');
                process.env.TRIAL_SPEND_LIMIT_USD = 'abc';
                expect(trialSpendLimitUsd() === 3, 'not a number means $3');
                process.env.TRIAL_SPEND_LIMIT_USD = '0';
                expect(trialSpendLimitUsd() === 3, 'zero means $3: 0 must never lock everyone out');
                process.env.TRIAL_SPEND_LIMIT_USD = '-1';
                expect(trialSpendLimitUsd() === 3, 'a negative value means $3');
                process.env.TRIAL_SPEND_LIMIT_USD = '0.5';
                expect(trialSpendLimitUsd() === 0.5, 'a positive number is the limit');
                const spend = await estimateTrialSpend(6408);
                expect(spend.limitUsd === 0.5 && spend.usedUsd === 0, 'the estimate carries the overridden limit');
            } finally {
                if (previous === undefined) delete process.env.TRIAL_SPEND_LIMIT_USD;
                else process.env.TRIAL_SPEND_LIMIT_USD = previous;
            }
        },
    },
    {
        name: 'the gate returns null for everyone the cap does not apply to',
        body: async () => {
            expect((await checkTrialQuota('full', TRIAL_USER_ID)) === null, 'a full user is not capped');
            expect((await checkTrialQuota('owner', TRIAL_USER_ID)) === null, 'the owner is not capped');
            expect((await checkTrialQuota('trial', null)) === null, 'a row without a user id is not capped');
            const previous = process.env.ACCESS_TIERS;
            try {
                process.env.ACCESS_TIERS = '0';
                expect((await checkTrialQuota('trial', TRIAL_USER_ID)) === null, 'ACCESS_TIERS=0 disables the cap');
            } finally {
                process.env.ACCESS_TIERS = previous ?? '1';
            }
        },
    },
    {
        name: 'a reply over the cap: one notice, no typing, no placeholder, no BotResponse, no model request',
        body: async () => {
            const userId = 6410;
            const chatId = privateChatIdOf(userId);
            await insertTrialSpend(userId, 1);

            await withLimit('0.01', async () => {
                const spend = await estimateTrialSpend(userId);
                const messageId = takeMessageId();
                const telegram = createFakeTelegram();
                const ctx = contextOf(
                    messageUpdate({ chatId, messageId, userId, text: '@AfterSchoolTeatimeBot 你好' }),
                    telegram
                );
                const { fetchCalls } = await countingModelRequests(() =>
                    quietly(() => handleReply(ctx, { mention: true }))
                );

                const sends = telegram.callsOf('sendMessage');
                expect(sends.length === 1, `exactly one notice (got ${sends.length})`);
                expect(
                    sends[0]?.payload.text === trialQuotaRefusalText(spend),
                    `the refusal names the used amount and the application path (got ${json(sends[0]?.payload.text)})`
                );
                expect(telegram.callsOf('sendChatAction').length === 0, 'the typing indicator never starts');
                expect(telegram.callsOf('editMessageText').length === 0, 'no placeholder is created or edited');
                expect(fetchCalls === 0, `no model request (got ${fetchCalls})`);
                expect(
                    (await dbIndex.BotResponse.findOne({ where: { chatId, userMessageId: messageId } })) === null,
                    'no BotResponse row'
                );
            });
        },
    },
    {
        name: '/picbanana over the cap: the long notice before the media wait, no generation session',
        body: async () => {
            const userId = 6411;
            const chatId = privateChatIdOf(userId);
            await insertTrialSpend(userId, 1);

            await withLimit('0.01', async () => {
                const { bot, telegram } = createFakeBot();
                registerChatHandler(bot);
                await quietly(() =>
                    bot.handleUpdate(
                        messageUpdate({ chatId, messageId: takeMessageId(), userId, text: '/picbanana 一只猫' })
                    )
                );
                await waitUntil('the /picbanana refusal', () => telegram.callsOf('sendMessage').length > 0);
                await sleep(50); // the handler runs detached from the update loop

                const sends = telegram.callsOf('sendMessage');
                expect(sends.length === 1, `one notice, not a media wait plus a notice (got ${sends.length})`);
                expect(
                    String(sends[0]?.payload.text ?? '').includes('体验额度已用完'),
                    `the notice is the spend refusal (got ${json(sends[0]?.payload.text)})`
                );
                expect(telegram.callsOf('sendChatAction').length === 0, 'nothing starts');
                expect(listActiveSessions().length === 0, 'no generation session');
            });
        },
    },
    {
        name: 'a retry over the cap: the notice, no session, the reply untouched; the cap reads the presser',
        body: async () => {
            // The reply belongs to chat -6412x; the author A spent nothing, the
            // presser B is over the cap: exactly the presser's spend must refuse
            const author = 6412;
            const presser = 6413;
            const chatId = -1006412000000;
            const firstMessageId = 641_200;
            await insertBotReply(chatId, firstMessageId, author);
            await insertTrialSpend(presser, 1);

            await withLimit('0.01', async () => {
                const spend = await estimateTrialSpend(presser);
                const telegram = createFakeTelegram();
                const ctx = contextOf(
                    callbackUpdate({ chatId, messageId: firstMessageId, userId: presser, data: 'resp:retry' }),
                    telegram
                );
                await quietly(() => handleRetryRequest(ctx, firstMessageId));

                const sends = telegram.callsOf('sendMessage');
                expect(sends.length === 1, `one notice (got ${sends.length})`);
                expect(
                    sends[0]?.payload.text === trialQuotaRefusalText(spend),
                    `the notice carries the presser's amount (got ${json(sends[0]?.payload.text)})`
                );
                expect(listActiveSessions().length === 0, 'startRetry never runs');
                expect(telegram.callsOf('editMessageText').length === 0, 'the reply is left as it was');
                expect((await estimateTrialSpend(author)).usedUsd === 0, "the original author's spend is not the gate");
            });
        },
    },
    {
        name: 'gen: buttons: reroll/retry/rewrite are refused with the short toast; cancel and full users are answered as usual',
        body: async () => {
            const userId = 6414;
            const chatId = privateChatIdOf(userId);
            await insertTrialSpend(userId, 1);
            const { bot, telegram } = createFakeBot();
            registerGenerationCallbacks(bot);

            const press = async (presserId: number, data: string): Promise<void> => {
                await quietly(() =>
                    bot.handleUpdate(
                        callbackUpdate({ chatId, messageId: takeMessageId(), userId: presserId, data })
                    )
                );
            };

            await withLimit('0.01', async () => {
                for (const data of ['gen:reroll:job-1', 'gen:retry:action-1', 'gen:rewrite:action-2']) {
                    telegram.reset();
                    await press(userId, data);
                    expect(
                        lastToastOf(telegram) === TRIAL_QUOTA_CALLBACK_TEXT,
                        `${data} over the cap answers the quota toast (got ${json(lastToastOf(telegram))})`
                    );
                }
                telegram.reset();
                await press(userId, 'gen:cancel:job-1');
                expect(
                    typeof lastToastOf(telegram) === 'string' &&
                        lastToastOf(telegram) !== TRIAL_QUOTA_CALLBACK_TEXT,
                    `cancel is not a generation and is answered as usual (got ${json(lastToastOf(telegram))})`
                );
            });

            // Under the cap the same trial presser gets the command refusal, not the quota one
            telegram.reset();
            await press(userId, 'gen:reroll:job-1');
            expect(
                lastToastOf(telegram) === TRIAL_CALLBACK_REFUSAL_TEXT,
                `under the cap the trial command rule answers (got ${json(lastToastOf(telegram))})`
            );

            // The owner is never capped
            telegram.reset();
            await press(OWNER_ID, 'gen:retry:action-1');
            expect(
                lastToastOf(telegram) !== TRIAL_QUOTA_CALLBACK_TEXT &&
                    lastToastOf(telegram) !== TRIAL_CALLBACK_REFUSAL_TEXT,
                `a full user reaches the normal path (got ${json(lastToastOf(telegram))})`
            );
        },
    },
    {
        name: 'an allowed trial turn reports its spend in the runtime tail, and /apply shows it too',
        body: async () => {
            const userId = 6415;
            await insertTrialSpend(userId, 1.5); // $1.50 of the cap
            const spend = await estimateTrialSpend(userId);
            expect(spend.usedUsd === 1.5 && spend.exceeded === false, `under the cap (got ${json(spend)})`);

            const note = triggerAccessNoteOf(
                { userId, name: '张三', tier: 'trial', application: null },
                spend
            );
            expect(note !== null && note.usedUsd === 1.5 && note.limitUsd === 3, 'the note carries the amounts');
            const block = buildRuntimeContext(TRIAL_MODEL, [], null, null, note);
            expect(
                block.includes('体验额度：已用约 $1.50 / $3.00'),
                `the trigger line appends the spend (got ${json(block)})`
            );
            expect(
                triggerAccessNoteOf({ userId, name: '张三', tier: 'full', application: null }, spend) === null,
                'a full turn carries no note'
            );
            // The static head must stay byte-identical for the prefix cache
            const head = buildStaticSystemPrompt(TRIAL_MODEL, { trial: true });
            expect(!head.includes('体验额度'), 'the static trial section carries no spend fact');

            const { bot, telegram } = createFakeBot();
            registerApplyCommand(bot);
            await quietly(() =>
                bot.handleUpdate(
                    messageUpdate({ chatId: privateChatIdOf(userId), messageId: takeMessageId(), userId, text: '/apply' })
                )
            );
            const status = String(telegram.callsOf('sendMessage').at(-1)?.payload.text ?? '');
            expect(status.includes('体验额度：已用约 $1.50 / $3.00'), `the /apply status shows the spend (got ${json(status)})`);
            expect(status.includes('/apply 你是谁 | 你要做什么'), 'and still shows how to apply');
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}

await sequelize.close();
reportResults(results);
