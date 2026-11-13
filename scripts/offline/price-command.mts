/**
 * Offline cases for the owner's `/pricing` command (pricing design
 * 2026-1113-1150 §5.5): who gets an answer at all, the manual run's summary,
 * the two-minute debounce, `status` (which must neither fetch nor run), the
 * usage fallback, and that a reply is stored like any other bot notice.
 *
 * The watcher runs through the real `runPriceWatchNow`, but its fetcher is a
 * stub: every catalog comes back as an empty document, so the run finds no
 * candidates and nothing leaves the process.
 *
 * Run: npx tsx scripts/offline/price-command.mts
 */
import type { Chat, Update } from 'grammy/types';
import { expect, reportResults, runCase, setupOfflineDb, takeMessageId, type CaseResult } from './harness.mts';
import {
    createFakeBot,
    messageUpdate,
    quietly,
    userOf,
} from './fake-telegram.mts';
import type { CatalogFetcher } from '../../src/services/price-catalog-types.js';

// The owner and the bot identity; read before anything under src/ is imported
process.env.OWNER_USER_ID = '4242';
process.env.OWNER_DISPLAY_NAME = '机主';
process.env.BOT_USER_ID = '7777';
process.env.BOT_NAME = 'K-ON';
// Default on; the stub fetcher below still keeps the run offline
process.env.PRICE_WATCH = '1';

const db = await setupOfflineDb();
const { Message } = db;
const pricingConfig = await import('../../src/config/model-pricing.js');
const service = await import('../../src/services/model-price-service.js');
const watch = await import('../../src/services/price-watch-service.js');
const pricingCommand = await import('../../src/cmd/commands/pricing.js');
const { ModelPriceEntry } = await import('../../src/db/modelPriceDTO.js');
const { PriceChangeProposal } = await import('../../src/db/priceChangeProposalDTO.js');
const { PriceWatchRun } = await import('../../src/db/priceWatchRunDTO.js');

const OWNER_ID = 4242;
const OUTSIDER_ID = 6262;
const GROUP_ID = -1009004242;

/** URLs the watcher's injected fetcher was asked for */
const fetchedUrls: string[] = [];

/** Empty catalogs: no candidate, no proposal, and no network */
const emptyCatalogs: CatalogFetcher = async (url) => {
    fetchedUrls.push(url);
    return { status: 200, body: url.endsWith('.toml') ? '' : '{}' };
};

watch.setPriceWatchFetcher(emptyCatalogs);

const { bot, telegram } = createFakeBot();
pricingCommand.registerPricingCommand(bot);

// ---- helpers ----

const payloadTextOf = (payload: Readonly<Record<string, unknown>>): string =>
    typeof payload.text === 'string' ? payload.text : '';

const repliesOf = (): readonly string[] =>
    telegram.callsOf('sendMessage').map((call) => payloadTextOf(call.payload));

const privateChatOf = (userId: number): Chat.PrivateChat => ({
    id: userId,
    type: 'private',
    first_name: `user-${userId}`,
});

/** A `/pricing` message in a private chat */
const privateCommandUpdate = (userId: number, text: string): Update => {
    const command = /^\S+/.exec(text)?.[0] ?? text;
    return {
        update_id: takeMessageId(),
        message: {
            message_id: takeMessageId(),
            date: Math.floor(Date.now() / 1000),
            chat: privateChatOf(userId),
            from: userOf(userId),
            text,
            entities: [{ type: 'bot_command', offset: 0, length: command.length }],
        },
    };
};

/** Run one command and return the texts the bot sent back */
const runCommand = async (text: string, userId: number = OWNER_ID): Promise<readonly string[]> => {
    telegram.reset();
    await quietly(() => bot.handleUpdate(privateCommandUpdate(userId, text)));
    return repliesOf();
};

/** Run one command from the owner inside a group */
const runGroupCommand = async (text: string): Promise<readonly string[]> => {
    telegram.reset();
    await quietly(() =>
        bot.handleUpdate(messageUpdate({ chatId: GROUP_ID, messageId: takeMessageId(), userId: OWNER_ID, text }))
    );
    return repliesOf();
};

/** Empty the pricing tables, reload the seed rows and forget the debounce clock */
const resetPricingDb = async (): Promise<void> => {
    await PriceChangeProposal.destroy({ where: {} });
    await PriceWatchRun.destroy({ where: {} });
    await ModelPriceEntry.destroy({ where: {} });
    pricingConfig.setPriceEntries([]);
    await service.loadModelPrices();
    pricingCommand.resetPricingCommandState();
    fetchedUrls.length = 0;
    telegram.reset();
};

const cases: CaseResult[] = [];

// ---- who gets an answer ----

cases.push(
    await runCase('only the owner in a private chat gets an answer', async () => {
        await resetPricingDb();
        const strangerReplies = await runCommand('/pricing', OUTSIDER_ID);
        expect(strangerReplies.length === 0, 'a stranger is ignored');
        const groupReplies = await runGroupCommand('/pricing');
        expect(groupReplies.length === 0, 'the owner in a group is ignored');
        expect(fetchedUrls.length === 0, 'and nothing was fetched');
        expect((await PriceWatchRun.count()) === 0, 'and no run was recorded');
    })
);

// ---- the manual run ----

cases.push(
    await runCase('the owner triggers a run and gets its summary', async () => {
        await resetPricingDb();
        const replies = await runCommand('/pricing');
        expect(replies.length === 1, `one reply comes back (got ${replies.length})`);
        expect(
            replies[0]?.includes('未发现价格变更'),
            `the summary reports the empty run (got ${JSON.stringify(replies[0])})`
        );
        expect(fetchedUrls.length > 0, 'the run used the injected fetcher');
        expect(
            fetchedUrls.every((url) => url.startsWith('https://')),
            'the URLs are the real catalog ones, not a fixture path'
        );
        const runs = await PriceWatchRun.findAll();
        expect(runs.length === 1, `one run row was written (got ${runs.length})`);
        expect(runs[0]?.outcome === 'ok', `the run recorded ok (got ${runs[0]?.outcome})`);
        expect(runs[0]?.finishedAt !== null, 'the run row was finished');

        const notice = await Message.findOne({
            where: { chatId: OWNER_ID, fromBotSelf: true },
            order: [['messageId', 'DESC']],
        });
        expect(notice !== null, 'the reply is stored as a bot row');
        expect((notice?.text ?? '').includes('未发现价格变更'), 'with the summary text');
    })
);

cases.push(
    await runCase('a second manual run within two minutes is answered, not repeated', async () => {
        await resetPricingDb();
        const first = await runCommand('/pricing');
        expect(first[0]?.includes('未发现价格变更'), 'the first call runs the watcher');
        const fetchesAfterFirst = fetchedUrls.length;
        const second = await runCommand('/pricing');
        expect(
            (second[0] ?? '').includes('刚刚已经跑过'),
            `the second says it just ran (got ${JSON.stringify(second[0])})`
        );
        expect(fetchedUrls.length === fetchesAfterFirst, 'no second fetch happened');
        expect((await PriceWatchRun.count()) === 1, 'only the first call recorded a run');
    })
);

// ---- status ----

cases.push(
    await runCase('/pricing status answers from the table without running the watcher', async () => {
        await resetPricingDb();
        const replies = await runCommand('/pricing status');
        const text = replies[0] ?? '';
        expect(text.includes('价目版本：'), `the table version is shown (got ${JSON.stringify(text.slice(0, 80))})`);
        expect(text.includes('最近核对：'), 'the freshness of the sources is shown');
        expect(text.includes('待确认提案：0'), 'the pending count is shown');
        expect(text.includes('未来 30 天'), 'the upcoming changes are shown');
        expect(text.includes('上次巡检：从未'), 'the watcher has not run yet');
        expect(fetchedUrls.length === 0, 'status does not fetch');
        expect((await PriceWatchRun.count()) === 0, 'status does not record a run');
    })
);

cases.push(
    await runCase('/pricing status counts pending proposals and the last run', async () => {
        await resetPricingDb();
        // A real proposal (the payload is a price entry, as the watcher writes it)
        await service.createOrRefreshProposals(
            [
                {
                    kind: 'new_model',
                    model: 'offline-pending',
                    tier: 'standard',
                    entry: {
                        model: 'offline-pending',
                        tier: 'standard',
                        inputPerM: 1,
                        cachedInputPerM: 0.1,
                        outputPerM: 4,
                        effectiveFrom: new Date('2026-11-13T00:00:00Z'),
                        source: 'models-dev',
                        checkedOn: '2026-11-13',
                        confidence: 'medium',
                    },
                    baseline: null,
                    note: '新模型：目录有价',
                },
            ],
            null
        );
        const replies = await runCommand('/pricing status');
        const text = replies[0] ?? '';
        expect(text.includes('待确认提案：1'), `the pending proposal is counted (got ${JSON.stringify(text)})`);

        // The manual run asks the owner about the pending proposal, in their DM
        await runCommand('/pricing');
        const approvals = telegram
            .callsOf('sendMessage')
            .filter((call) => typeof call.payload.reply_markup === 'object' && call.payload.reply_markup !== null);
        expect(approvals.length === 1, `one approval message was sent (got ${approvals.length})`);
        expect(approvals[0]?.payload.chat_id === OWNER_ID, 'and it went to the owner\'s private chat');

        // The run then shows up in the next status
        const laterReplies = await runCommand('/pricing status');
        const laterText = laterReplies[0] ?? '';
        expect(laterText.includes('（ok）'), `the last run outcome is shown (got ${JSON.stringify(laterText)})`);
    })
);

// ---- argument handling ----

cases.push(
    await runCase('an unknown argument answers the usage without fetching', async () => {
        await resetPricingDb();
        const replies = await runCommand('/pricing yesterday');
        expect(replies[0]?.includes('用法：/pricing'), `the usage comes back (got ${JSON.stringify(replies[0])})`);
        expect(fetchedUrls.length === 0, 'nothing was fetched');
    })
);

// Nothing startPriceWatch started, but the harness asks files to end what they
// began; this also forgets the injected fetcher.
watch.stopPriceWatch();
watch.setPriceWatchFetcher(null);
reportResults(cases);
