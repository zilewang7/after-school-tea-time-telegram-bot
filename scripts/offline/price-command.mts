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
const { ModelCapabilityProposal } = await import('../../src/db/modelCapabilityProposalDTO.js');
const { ModelCatalogEntryRow } = await import('../../src/db/modelCatalogDTO.js');
const catalogService = await import('../../src/services/model-catalog-service.js');
const catalogConfig = await import('../../src/config/model-catalog.js');

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

/**
 * A provider TOML whose reasoning section drifted from the code seed: the
 * watcher must propose the effort list change and nothing else.
 */
const DRIFT_TOML = `schema = 2

[capabilities]
tools = { supported = true }
reasoning = { supported = true, effort = ["low", "medium"] }
`;

const capabilityDriftCatalogs: CatalogFetcher = async (url) => {
    fetchedUrls.push(url);
    if (url.endsWith('/google-vertex/models/gemini-4-hydrogen.toml')) {
        return { status: 200, body: DRIFT_TOML };
    }
    return { status: 200, body: url.endsWith('.toml') ? '' : '{}' };
};

/** api.json with one new model of a known family: the run auto-adds it */
const DISCOVERY_API = JSON.stringify({
    openai: {
        models: {
            'gpt-7-audit': {
                id: 'gpt-7-audit',
                name: 'GPT-7 Audit',
                release_date: new Date().toISOString().slice(0, 10),
                limit: { context: 200_000, output: 32_000 },
                modalities: { input: ['text', 'image'], output: ['text'] },
                tool_call: true,
                reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
            },
        },
    },
});

const discoveryFetcher: CatalogFetcher = async (url) => {
    fetchedUrls.push(url);
    if (url.endsWith('api.json')) return { status: 200, body: DISCOVERY_API };
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

/** Empty the pricing/capability tables, reload the seeds and forget the debounce clock */
const resetPricingDb = async (): Promise<void> => {
    await PriceChangeProposal.destroy({ where: {} });
    await PriceWatchRun.destroy({ where: {} });
    await ModelPriceEntry.destroy({ where: {} });
    await ModelCapabilityProposal.destroy({ where: {} });
    await ModelCatalogEntryRow.destroy({ where: {} });
    pricingConfig.setPriceEntries([]);
    await service.loadModelPrices();
    await quietly(() => catalogService.loadModelCatalog());
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
        expect(text.includes('待确认提案：0'), 'the pending price count is shown');
        expect(text.includes('待确认能力提案：0'), 'the pending capability count is shown');
        expect(
            text.includes(`目录版本：${catalogConfig.modelCatalogVersion()}`),
            `the catalog version is shown (got ${JSON.stringify(text.slice(0, 200))})`
        );
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

// ---- the capability half of the run ----

cases.push(
    await runCase('a capability drift gets its own approval message after the price run', async () => {
        await resetPricingDb();
        watch.setPriceWatchFetcher(capabilityDriftCatalogs);
        try {
            const replies = await runCommand('/pricing');
            // The run sends the capability message before the command's own summary
            const capabilityText = replies.find((text) => text.startsWith('🧩 能力巡检：'));
            expect(capabilityText !== undefined, `an ability approval message was sent (got ${JSON.stringify(replies)})`);
            expect(
                (capabilityText ?? '').includes('1 条待确认'),
                `the message names the count (got ${JSON.stringify(capabilityText?.slice(0, 100))})`
            );
            expect(
                (capabilityText ?? '').includes('思考档位：low/medium/high/xhigh → low/medium'),
                'the field-level change is rendered'
            );
            const approvals = telegram
                .callsOf('sendMessage')
                .filter((call) => typeof call.payload.reply_markup === 'object' && call.payload.reply_markup !== null);
            expect(approvals.length === 1, `one approval message carries the buttons (got ${approvals.length})`);
            const summary = replies.find((text) => text !== capabilityText) ?? '';
            expect(summary.includes('1 条能力变更待确认'), `the summary counts the capability proposal (got ${JSON.stringify(summary)})`);

            const proposals = await ModelCapabilityProposal.findAll({ where: { model: 'gemini-4-hydrogen' } });
            expect(proposals.length === 1, `one capability proposal is pending (got ${proposals.length})`);
            expect(proposals[0]?.status === 'pending', 'it waits for the owner');
            const runs = await PriceWatchRun.findAll();
            expect(runs.length === 1 && runs[0]?.outcome === 'ok', 'the run recorded ok');
            expect(runs[0]?.proposals === 0, 'it counts price proposals only');

            const statusReplies = await runCommand('/pricing status');
            expect(
                (statusReplies[0] ?? '').includes('待确认能力提案：1'),
                `status counts the pending capability proposal (got ${JSON.stringify(statusReplies[0]?.slice(0, 120))})`
            );
        } finally {
            watch.setPriceWatchFetcher(emptyCatalogs);
        }
    })
);

// ---- auto-added model capabilities ----

cases.push(
    await runCase('a discovered model is written with schema-1 capabilities', async () => {
        await resetPricingDb();
        watch.setPriceWatchFetcher(discoveryFetcher);
        try {
            const replies = await runCommand('/pricing');
            expect(
                replies.some((text) => text.includes('gpt-7-audit')),
                `the new model is announced (got ${JSON.stringify(replies)})`
            );
            const row = await ModelCatalogEntryRow.findByPk('gpt-7-audit');
            expect(row !== null, 'the discovered row exists');
            if (row === null) return;
            const parsed: unknown = JSON.parse(row.capabilities);
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                throw new Error('the stored capabilities is not an object');
            }
            const capabilities = Object.fromEntries(Object.entries(parsed));
            expect(capabilities['schema'] === 1, `the row is schema 1 (got ${String(capabilities['schema'])})`);
            expect(capabilities['source'] === 'models-dev', 'the capability source is models-dev');
            expect(
                typeof capabilities['checkedOn'] === 'string' && String(capabilities['checkedOn']).length === 10,
                `the check date is written (got ${String(capabilities['checkedOn'])})`
            );
            expect(capabilities['kind'] === 'chat' && capabilities['vision'] === true, 'the legacy fields come from api.json');
            expect(capabilities['imageOutput'] === false && capabilities['tools'] === true, 'output modality and tools recorded');
            expect(
                JSON.stringify(capabilities['reasoningEffort']) === '["low","medium","high"]',
                `the legacy effort mirror is written (got ${JSON.stringify(capabilities['reasoningEffort'])})`
            );
            expect(capabilities['contextTokens'] === 200_000 && capabilities['outputTokens'] === 32_000, 'the limits are written');
            expect(Object.hasOwn(capabilities, 'reasoning') === false, 'no reasoning section is derived (the proposal fills it)');
            expect(row.source === 'models-dev', 'the row provenance is models-dev');
            const proposals = await ModelCapabilityProposal.findAll({ where: { model: 'gpt-7-audit' } });
            expect(proposals.length === 0, 'its capability proposal waits for the next run');
        } finally {
            await ModelCatalogEntryRow.destroy({ where: { id: 'gpt-7-audit' } });
            watch.setPriceWatchFetcher(emptyCatalogs);
            await quietly(() => catalogService.loadModelCatalog());
        }
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
