/**
 * Offline cases for the price watcher's approval UX (pricing design
 * 2026-1113-1150 §5.3): the private-chat proposal messages (rendering, units,
 * batching, messageId write-back), the owner's `pricing:` buttons (apply,
 * reject, refused presser, repeated press, failed write), and the two small
 * notices the watcher sends (auto-added models, heartbeat).
 *
 * The Bot API is a local fake and the DB is the harness scratch file: nothing
 * here touches the network. `/pricing` itself is covered by price-command.mts.
 *
 * Run: npx tsx scripts/offline/price-proposals.mts
 */
import type { Transformer } from 'grammy';
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';
import { callbackUpdate, createFakeBot, createFakeTelegram, lastToastOf, quietly } from './fake-telegram.mts';
import type { PriceEntry, PriceSource, PriceTier } from '../../src/config/model-pricing.js';
import type { ProposalDraft } from '../../src/services/price-catalog-types.js';
import type { PriceProposalView } from '../../src/services/model-price-service.js';

process.env.OWNER_USER_ID = '4242';
process.env.OWNER_DISPLAY_NAME = '机主';
process.env.BOT_USER_ID = '7777';
process.env.BOT_NAME = 'K-ON';
// The watcher's timer is never started here; the switch keeps it that way
process.env.PRICE_WATCH = '0';

const db = await setupOfflineDb();
const { Message } = db;
const pricingConfig = await import('../../src/config/model-pricing.js');
const service = await import('../../src/services/model-price-service.js');
const notify = await import('../../src/services/price-proposal-notify.js');
const approvalMenu = await import('../../src/cmd/menus/price-approval-menu.js');
const { ModelPriceEntry } = await import('../../src/db/modelPriceDTO.js');
const { PriceChangeProposal } = await import('../../src/db/priceChangeProposalDTO.js');
const { PriceWatchRun } = await import('../../src/db/priceWatchRunDTO.js');
const { SettingsAudit } = await import('../../src/db/settingsAuditDTO.js');
const { listSettingsAudit } = await import('../../src/db/queries/settings-audit.js');

const OWNER_ID = 4242;
const OUTSIDER_ID = 5151;
const CHECKED_ON = '2026-11-13';
const EFFECTIVE_FROM = new Date('2026-11-13T00:00:00Z');
const FUTURE_FROM = new Date('2026-12-01T00:00:00Z');

// ---- helpers ----

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** A recorded sendMessage payload, narrowed for the assertions */
const payloadTextOf = (payload: Readonly<Record<string, unknown>>): string =>
    typeof payload.text === 'string' ? payload.text : '';

const sentPayloadsOf = (telegram: { callsOf(method: string): { payload: Readonly<Record<string, unknown>> }[] }) =>
    telegram.callsOf('sendMessage').map((call) => call.payload);

interface ButtonSpec {
    readonly text: string;
    readonly callback_data: string;
}

const keyboardRowsOf = (payload: Readonly<Record<string, unknown>>): readonly (readonly ButtonSpec[])[] => {
    const markup = payload.reply_markup;
    if (!isRecord(markup) || !Array.isArray(markup.inline_keyboard)) return [];
    return markup.inline_keyboard.flatMap((row) => {
        if (!Array.isArray(row)) return [];
        const buttons = row.flatMap((button): ButtonSpec[] => {
            if (!isRecord(button)) return [];
            const text = typeof button.text === 'string' ? button.text : '';
            const callbackData = typeof button.callback_data === 'string' ? button.callback_data : '';
            if (text.length === 0 || callbackData.length === 0) return [];
            return [{ text, callback_data: callbackData }];
        });
        return buttons.length === 0 ? [] : [buttons];
    });
};

const callbackDataOf = (payload: Readonly<Record<string, unknown>>): readonly string[] =>
    keyboardRowsOf(payload).flatMap((row) => row.map((button) => button.callback_data));

/** The raw keyboard rows, empty ones included, to catch a padded keyboard */
const rawKeyboardRowsOf = (payload: Readonly<Record<string, unknown>>): readonly (readonly unknown[])[] => {
    const markup = payload.reply_markup;
    if (!isRecord(markup) || !Array.isArray(markup.inline_keyboard)) return [];
    return markup.inline_keyboard.filter((row): row is readonly unknown[] => Array.isArray(row));
};

/** Telegram removes an inline keyboard with an explicitly empty one */
const keyboardRemoved = (payload: Readonly<Record<string, unknown>>): boolean => {
    const markup = payload.reply_markup;
    return isRecord(markup) && Array.isArray(markup.inline_keyboard) && markup.inline_keyboard.length === 0;
};

const entitiesOf = (payload: Readonly<Record<string, unknown>>): readonly Record<string, unknown>[] => {
    const entities = payload.entities;
    if (!Array.isArray(entities)) return [];
    return entities.filter(isRecord);
};

const buttonCallbackBytes = (payload: Readonly<Record<string, unknown>>): readonly number[] =>
    callbackDataOf(payload).map((data) => Buffer.byteLength(data, 'utf8'));

/** Telegram's limit for one button's callback_data */
const CALLBACK_DATA_LIMIT = 64;

const lastToastText = (telegram: Parameters<typeof lastToastOf>[0]): string => {
    const toast = lastToastOf(telegram);
    return typeof toast === 'string' ? toast : '';
};

/** Empty the pricing tables and reload the built-in seed rows */
const resetPricingDb = async (): Promise<void> => {
    await PriceChangeProposal.destroy({ where: {} });
    await PriceWatchRun.destroy({ where: {} });
    await SettingsAudit.destroy({ where: {} });
    await ModelPriceEntry.destroy({ where: {} });
    pricingConfig.setPriceEntries([]);
    await service.loadModelPrices();
};

const currentRowOf = async (model: string, tier: PriceTier): Promise<PriceEntry> => {
    const rows = await service.currentPriceRows();
    const row = rows.find((candidate) => candidate.model === model && candidate.tier === tier);
    if (row === undefined) throw new Error(`no current price row for ${model} · ${tier}`);
    return row;
};

const updateDraftFor = async (
    model: string,
    tier: PriceTier,
    values: { readonly inputPerM: number; readonly cachedInputPerM: number; readonly outputPerM: number },
    effectiveFrom: Date,
    source: PriceSource = 'models-dev'
): Promise<ProposalDraft> => {
    const baseline = await currentRowOf(model, tier);
    const entry: PriceEntry = {
        ...baseline,
        ...values,
        effectiveFrom,
        source,
        checkedOn: CHECKED_ON,
        confidence: source === 'official' ? 'high' : 'medium',
    };
    return {
        kind: 'update',
        model,
        tier,
        entry,
        baseline,
        note: 'models.dev TOML 与官方 Vertex 页一致',
    };
};

const newModelDraftOf = (model: string, inputPerM: number): ProposalDraft => ({
    kind: 'new_model',
    model,
    tier: 'standard',
    entry: {
        model,
        tier: 'standard',
        inputPerM,
        cachedInputPerM: inputPerM / 10,
        outputPerM: inputPerM * 4,
        effectiveFrom: EFFECTIVE_FROM,
        source: 'models-dev',
        checkedOn: CHECKED_ON,
        confidence: 'medium',
    },
    baseline: null,
    note: '新模型：目录有价，自动进菜单后需确认价格',
});

const seedProposals = async (drafts: readonly ProposalDraft[]): Promise<readonly PriceProposalView[]> => {
    await service.createOrRefreshProposals(drafts, null);
    return service.listPendingProposals();
};

const sendApprovalMessage = async (
    telegram: ReturnType<typeof createFakeTelegram>,
    proposals: readonly PriceProposalView[]
): Promise<readonly number[]> => notify.sendProposalMessage(telegram.api, { id: 1 }, proposals);

interface MenuBot {
    readonly bot: ReturnType<typeof createFakeBot>['bot'];
    readonly telegram: ReturnType<typeof createFakeBot>['telegram'];
}

const menuBotOf = (): MenuBot => {
    const { bot, telegram } = createFakeBot();
    approvalMenu.registerPriceApprovalCallbacks(bot);
    return { bot, telegram };
};

/** Press one approval button; the console stays quiet (expected failures log) */
const press = async (bot: MenuBot['bot'], messageId: number, userId: number, data: string): Promise<void> => {
    await quietly(() =>
        bot.handleUpdate(
            callbackUpdate({ chatId: OWNER_ID, messageId, userId, data })
        )
    );
};

const proposalsOfModel = async (model: string): Promise<readonly { id: number; status: string; messageId: number | null }[]> => {
    const rows = await PriceChangeProposal.findAll({ where: { model } });
    return rows.map((row) => ({ id: row.id, status: row.status, messageId: row.messageId }));
};

const cases: CaseResult[] = [];

// ---- the proposal message ----

cases.push(
    await runCase('the proposal message shows model, old → new, source and effective day', async () => {
        await resetPricingDb();
        const telegram = createFakeTelegram();
        const drafts = [
            await updateDraftFor(
                'gemini-4-hydrogen',
                'standard',
                { inputPerM: 3, cachedInputPerM: 0.15, outputPerM: 15 },
                EFFECTIVE_FROM
            ),
            await updateDraftFor(
                'gemini-4-argon',
                'priority',
                { inputPerM: 7.2, cachedInputPerM: 0.36, outputPerM: 36 },
                FUTURE_FROM,
                'official'
            ),
        ];
        const pending = await seedProposals(drafts);
        expect(pending.length === 2, `two proposals are pending (got ${pending.length})`);

        const messageIds = await sendApprovalMessage(telegram, pending);
        expect(messageIds.length === 1, `one message carries both (got ${messageIds.length})`);
        const messageId = messageIds[0];
        if (messageId === undefined) throw new Error('the approval message was not sent');

        const payload = sentPayloadsOf(telegram)[0];
        if (payload === undefined) throw new Error('no sendMessage was recorded');
        const text = payloadTextOf(payload);

        expect(payload.chat_id === OWNER_ID, 'the message goes to the owner\'s own chat');
        expect(text.includes('💰 价目巡检：2 条待确认'), `the header names the count (got ${JSON.stringify(text.slice(0, 80))})`);
        expect(text.includes('USD/1M token'), 'the unit is stated');
        expect(text.includes('gemini-4-hydrogen · standard（更新）'), 'the first proposal is titled');
        expect(
            text.includes('旧 输入 $1.5 / 缓存 $0.075 / 输出 $7.5 → 新 输入 $3 / 缓存 $0.15 / 输出 $15'),
            `old → new shows all three prices (got ${JSON.stringify(text)})`
        );
        expect(text.includes('来源 models.dev（2026-11-13）'), 'the source and checkedOn are shown');
        expect(text.includes('2026-11-13 起生效'), 'the effective day of the first row is shown');
        expect(text.includes('gemini-4-argon · priority（更新）'), 'the priority row is titled');
        expect(text.includes('2026-12-01 起生效'), 'the future window says when it starts');
        expect(text.includes('官方价目'), 'the official source label is used');

        const entities = entitiesOf(payload);
        expect(entities.some((entity) => entity.type === 'bold'), 'the header and titles are bold');
        const preview = payload.link_preview_options;
        expect(isRecord(preview) && preview.is_disabled === true, 'the link preview is disabled');
        expect(payload.reply_to_message_id === undefined, 'the message answers nothing');

        const callbacks = callbackDataOf(payload);
        const ids = pending.map((proposal) => proposal.id);
        for (const id of ids) {
            expect(callbacks.includes(`pricing:apply:${id}`), `proposal #${id} has its own apply button`);
        }
        expect(callbacks.includes('pricing:all:apply'), 'the all-apply button exists');
        expect(callbacks.includes('pricing:all:reject'), 'the all-reject button exists');
        expect(
            buttonCallbackBytes(payload).every((bytes) => bytes <= CALLBACK_DATA_LIMIT),
            'every callback_data fits Telegram\'s 64 bytes'
        );
        const rows = keyboardRowsOf(payload);
        expect(rows.length === 3, `one row per proposal plus the shared row (got ${rows.length})`);
        expect(
            rawKeyboardRowsOf(payload).every((row) => row.length > 0),
            'no empty keyboard row is padded into the keyboard'
        );
        expect(rawKeyboardRowsOf(payload).length === 3, 'the raw keyboard has the same three rows');

        // The message id is written back onto every proposal it carries
        const stored = await proposalsOfModel('gemini-4-hydrogen');
        expect(stored.length === 1 && stored[0]?.messageId === messageId, 'the message id is stored on the proposal');
        const argonStored = await proposalsOfModel('gemini-4-argon');
        expect(argonStored[0]?.messageId === messageId, 'and on the second proposal of the message');

        // The notice itself is a bot row, so later contexts see what was asked
        const row = await Message.findOne({ where: { chatId: OWNER_ID, messageId } });
        expect(row !== null && row.fromBotSelf, 'the approval message is stored as a bot row');
        expect(row?.text === text, 'with the same text');
    })
);

cases.push(
    await runCase('more than eight proposals are split, numbered and all still get their message id', async () => {
        await resetPricingDb();
        const telegram = createFakeTelegram();
        const drafts = Array.from({ length: 10 }, (_unused, index) => newModelDraftOf(`offline-model-${index}`, 1 + index));
        const pending = await seedProposals(drafts);
        expect(pending.length === 10, `ten proposals are pending (got ${pending.length})`);

        const messageIds = await sendApprovalMessage(telegram, pending);
        expect(messageIds.length === 2, `ten proposals need two messages (got ${messageIds.length})`);

        const payloads = sentPayloadsOf(telegram);
        const first = payloads[0];
        const second = payloads[1];
        if (first === undefined || second === undefined) throw new Error('expected two sendMessage calls');

        expect(payloadTextOf(first).includes('还有 2 条'), 'the first message says more follow');
        expect(payloadTextOf(second).includes('第 9–10 条'), 'the second message numbers its range');
        expect(!payloadTextOf(second).includes('还有'), 'the last message does not announce more');
        expect(keyboardRowsOf(first).length === 9, `eight apply rows plus the shared row (got ${keyboardRowsOf(first).length})`);
        expect(keyboardRowsOf(second).length === 3, `two apply rows plus the shared row (got ${keyboardRowsOf(second).length})`);

        // The first eight proposals remember the first message, the rest the second
        const firstBatch = await proposalsOfModel('offline-model-0');
        expect(firstBatch[0]?.messageId === messageIds[0], 'a proposal of the first batch points at the first message');
        const lastBatch = await proposalsOfModel('offline-model-9');
        expect(lastBatch[0]?.messageId === messageIds[1], 'a proposal of the second batch points at the second message');
    })
);

// ---- the approval buttons ----

cases.push(
    await runCase('the owner applies one proposal: row written, registry refreshed, audit and message edited', async () => {
        await resetPricingDb();
        const telegram = createFakeTelegram();
        const pending = await seedProposals([
            await updateDraftFor(
                'gemini-4-hydrogen',
                'standard',
                { inputPerM: 3, cachedInputPerM: 0.15, outputPerM: 15 },
                EFFECTIVE_FROM
            ),
        ]);
        const proposal = pending[0];
        if (proposal === undefined) throw new Error('no proposal was created');
        const messageIds = await sendApprovalMessage(telegram, pending);
        const messageId = messageIds[0];
        if (messageId === undefined) throw new Error('the approval message was not sent');

        const { bot, telegram: menuTelegram } = menuBotOf();
        await press(bot, messageId, OWNER_ID, `pricing:apply:${proposal.id}`);

        expect(lastToastText(menuTelegram) === '已应用 1 条', `the toast confirms the apply (got ${JSON.stringify(lastToastText(menuTelegram))})`);
        const edits = menuTelegram.callsOf('editMessageText');
        expect(edits.length === 1, `the message is rewritten once (got ${edits.length})`);
        const edit = edits[0]?.payload;
        if (edit === undefined) throw new Error('no editMessageText was recorded');
        const editText = payloadTextOf(edit);
        expect(editText.startsWith('✅ 已应用 1 条价格提案'), `the rewritten message says what happened (got ${JSON.stringify(editText)})`);
        expect(editText.includes('gemini-4-hydrogen · standard'), 'and names the row');
        expect(keyboardRemoved(edit), 'the buttons are removed with an empty keyboard');

        // Proposal decided, old window closed, new window in force
        const [stored] = await proposalsOfModel('gemini-4-hydrogen');
        expect(stored?.status === 'approved', `the proposal is approved (got ${stored?.status})`);
        const rows = await ModelPriceEntry.findAll({ where: { model: 'gemini-4-hydrogen', tier: 'standard' } });
        expect(rows.length === 2, `the table now holds two windows (got ${rows.length})`);
        const applied = rows.find((row) => row.effectiveFrom.getTime() === EFFECTIVE_FROM.getTime());
        expect(applied?.inputPerM === 3, 'the approved price was written');
        const closed = rows.find((row) => row.effectiveFrom.getTime() !== EFFECTIVE_FROM.getTime());
        expect(closed?.effectiveTo?.getTime() === EFFECTIVE_FROM.getTime(), 'the previous window was closed at the change');

        const before = pricingConfig.findPriceAt('gemini-4-hydrogen', new Date('2020-01-01T00:00:00Z'));
        expect(before?.inputPerM === 1.5, 'history keeps the old price');
        const now = pricingConfig.findPriceAt('gemini-4-hydrogen', new Date('2026-11-14T00:00:00Z'));
        expect(now?.inputPerM === 3, `the registry serves the new price (got ${now?.inputPerM})`);

        const audit = await listSettingsAudit({ scope: 'pricing', limit: 10 });
        expect(audit.length === 1, `one audit row was written (got ${audit.length})`);
        const entry = audit[0];
        expect(entry?.actorId === OWNER_ID, 'the audit names the owner');
        expect(entry?.key === 'gemini-4-hydrogen:standard', `the audit key is model:tier (got ${entry?.key})`);
        expect((entry?.oldValue ?? '').includes('"inputPerM":1.5'), 'the audit keeps the old value');
        expect((entry?.newValue ?? '').includes('"inputPerM":3'), 'and the new one');

        // The stored copy of the message follows the edit
        const storedNotice = await Message.findOne({ where: { chatId: OWNER_ID, messageId } });
        expect((storedNotice?.text ?? '').startsWith('✅ 已应用 1 条'), 'the stored bot row is updated too');
    })
);

cases.push(
    await runCase('a press from somebody else is refused and changes nothing', async () => {
        await resetPricingDb();
        const telegram = createFakeTelegram();
        const pending = await seedProposals([
            await updateDraftFor(
                'gemini-4-carbon',
                'standard',
                { inputPerM: 9, cachedInputPerM: 0.9, outputPerM: 45 },
                EFFECTIVE_FROM
            ),
        ]);
        const proposal = pending[0];
        if (proposal === undefined) throw new Error('no proposal was created');
        const messageIds = await sendApprovalMessage(telegram, pending);
        const messageId = messageIds[0];
        if (messageId === undefined) throw new Error('the approval message was not sent');

        const { bot, telegram: menuTelegram } = menuBotOf();
        await press(bot, messageId, OUTSIDER_ID, `pricing:apply:${proposal.id}`);

        expect(lastToastText(menuTelegram) === '只有机主可以审批', 'the outsider is told no');
        expect(menuTelegram.callsOf('editMessageText').length === 0, 'the message is left alone');
        const [stored] = await proposalsOfModel('gemini-4-carbon');
        expect(stored?.status === 'pending', 'the proposal is still pending');
        const audit = await listSettingsAudit({ scope: 'pricing', limit: 10 });
        expect(audit.length === 0, 'nothing was audited');
    })
);

cases.push(
    await runCase('the owner rejects everything: no price row changes, both proposals and audits recorded', async () => {
        await resetPricingDb();
        const telegram = createFakeTelegram();
        const pending = await seedProposals([
            await updateDraftFor(
                'gemini-4-carbon',
                'standard',
                { inputPerM: 9, cachedInputPerM: 0.9, outputPerM: 45 },
                EFFECTIVE_FROM
            ),
            await updateDraftFor(
                'gemini-4-argon',
                'priority',
                { inputPerM: 9.9, cachedInputPerM: 0.9, outputPerM: 49.5 },
                EFFECTIVE_FROM
            ),
        ]);
        const messageIds = await sendApprovalMessage(telegram, pending);
        const messageId = messageIds[0];
        if (messageId === undefined) throw new Error('the approval message was not sent');
        const rowsBefore = await ModelPriceEntry.count();

        const { bot, telegram: menuTelegram } = menuBotOf();
        await press(bot, messageId, OWNER_ID, 'pricing:all:reject');

        expect(lastToastText(menuTelegram) === '已忽略 2 条', 'the toast counts the rejections');
        const edit = menuTelegram.callsOf('editMessageText')[0]?.payload;
        if (edit === undefined) throw new Error('no editMessageText was recorded');
        const editText = payloadTextOf(edit);
        expect(editText.startsWith('❌ 已忽略 2 条价格提案'), `the message says the proposals were rejected (got ${JSON.stringify(editText)})`);
        expect(keyboardRemoved(edit), 'the buttons are removed with an empty keyboard');

        const carbon = await proposalsOfModel('gemini-4-carbon');
        const argon = await proposalsOfModel('gemini-4-argon');
        expect(carbon[0]?.status === 'rejected' && argon[0]?.status === 'rejected', 'both proposals are rejected');
        expect((await ModelPriceEntry.count()) === rowsBefore, 'the price table did not change');
        expect(pricingConfig.findPriceAt('gemini-4-argon', new Date())?.priority?.inputPerM === 3.6, 'the registry serves the old price');

        const audit = await listSettingsAudit({ scope: 'pricing', limit: 10 });
        expect(audit.length === 2, `both rejections are audited (got ${audit.length})`);
        expect(audit.every((entry) => entry.newValue === 'rejected'), 'the audit says rejected');
    })
);

cases.push(
    await runCase('a second press on a decided proposal answers 已处理 and writes nothing', async () => {
        await resetPricingDb();
        const telegram = createFakeTelegram();
        const pending = await seedProposals([
            await updateDraftFor(
                'gemini-4-hydrogen',
                'standard',
                { inputPerM: 3, cachedInputPerM: 0.15, outputPerM: 15 },
                EFFECTIVE_FROM
            ),
        ]);
        const proposal = pending[0];
        if (proposal === undefined) throw new Error('no proposal was created');
        const messageId = (await sendApprovalMessage(telegram, pending))[0];
        if (messageId === undefined) throw new Error('the approval message was not sent');

        const { bot, telegram: menuTelegram } = menuBotOf();
        await press(bot, messageId, OWNER_ID, `pricing:apply:${proposal.id}`);
        const auditAfterFirst = await listSettingsAudit({ scope: 'pricing', limit: 10 });
        expect(auditAfterFirst.length === 1, 'the first press applied the proposal');

        await press(bot, messageId, OWNER_ID, `pricing:apply:${proposal.id}`);
        expect(lastToastText(menuTelegram) === '已处理', `the second press says it is done (got ${JSON.stringify(lastToastText(menuTelegram))})`);
        expect(menuTelegram.callsOf('editMessageText').length === 1, 'only the first press edited the message');
        const auditAfterSecond = await listSettingsAudit({ scope: 'pricing', limit: 10 });
        expect(auditAfterSecond.length === 1, 'nothing was audited twice');
        const rows = await ModelPriceEntry.findAll({ where: { model: 'gemini-4-hydrogen', tier: 'standard' } });
        expect(rows.length === 2, 'the table still holds exactly the two windows');
    })
);

cases.push(
    await runCase('a failed write keeps the proposal pending and says so', async () => {
        await resetPricingDb();
        const broken = await PriceChangeProposal.create({
            kind: 'update',
            model: 'offline-broken',
            tier: 'standard',
            effectiveFrom: EFFECTIVE_FROM,
            payload: 'not-json',
            detectedAt: new Date(),
            status: 'pending',
        });
        const rowsBefore = await ModelPriceEntry.count();

        // The service's transaction rolls back: the row is untouched
        let thrown = false;
        try {
            await service.applyProposals([broken.id], OWNER_ID);
        } catch {
            thrown = true;
        }
        expect(thrown, 'applying a broken proposal throws');
        const afterService = await PriceChangeProposal.findByPk(broken.id);
        expect(afterService?.status === 'pending', 'the proposal is still pending after the rollback');
        expect((await ModelPriceEntry.count()) === rowsBefore, 'no price row was written');

        const { bot, telegram: menuTelegram } = menuBotOf();
        await press(bot, 900, OWNER_ID, `pricing:apply:${broken.id}`);
        expect(lastToastText(menuTelegram) === '写入失败，见日志', `the owner is told the write failed (got ${JSON.stringify(lastToastText(menuTelegram))})`);
        expect(menuTelegram.callsOf('editMessageText').length === 0, 'the message keeps its buttons');
    })
);

cases.push(
    await runCase('an unknown pricing action is answered, and other callbacks pass through', async () => {
        await resetPricingDb();
        const { bot, telegram } = createFakeBot();
        approvalMenu.registerPriceApprovalCallbacks(bot);
        // Later in the chain, so it only runs when the pricing handler called next()
        bot.on('callback_query:data', async (ctx) => {
            await ctx.answerCallbackQuery({ text: '其它菜单' });
        });

        await press(bot, 901, OWNER_ID, 'pricing:unknown');
        expect(lastToastText(telegram) === '按钮已失效', 'an unknown pricing action answers');

        await press(bot, 901, OWNER_ID, 'resp:stop');
        expect(lastToastText(telegram) === '其它菜单', 'a non-pricing callback reaches the next handler');

        await press(bot, 901, OWNER_ID, 'pricing:all:apply');
        expect(lastToastText(telegram) === '已处理', 'an empty pending list answers 已处理');
    })
);

// ---- the small notices ----

cases.push(
    await runCase('the auto-added catalog models and the heartbeat notice reach the owner', async () => {
        await resetPricingDb();
        const telegram = createFakeTelegram();

        const catalogMessageId = await notify.sendModelCatalogNotice(telegram.api, ['gpt-7-luna', 'gemini-5-pro']);
        expect(catalogMessageId !== null, 'the catalog notice went out');
        if (catalogMessageId === null) throw new Error('the catalog notice was not sent');
        const catalogPayload = sentPayloadsOf(telegram)[0];
        if (catalogPayload === undefined) throw new Error('no sendMessage was recorded');
        const catalogText = payloadTextOf(catalogPayload);
        expect(catalogText.includes('模型目录新增'), 'the catalog notice says what it is');
        expect(catalogText.includes('gpt-7-luna') && catalogText.includes('gemini-5-pro'), 'and names every model');
        expect(catalogText.includes('价格待审批'), 'and says the price still needs approval');
        expect(catalogPayload.reply_markup === undefined, 'the catalog notice has no buttons');
        const catalogRow = await Message.findOne({ where: { chatId: OWNER_ID, messageId: catalogMessageId } });
        expect(catalogRow !== null, 'the catalog notice is stored as a bot row');

        telegram.reset();
        const noticeId = await notify.sendOwnerNotice(telegram.api, '价目巡检已停摆超过 36 小时。');
        expect(noticeId !== null, 'the heartbeat notice went out');
        expect(payloadTextOf(sentPayloadsOf(telegram)[0] ?? {}).includes('36 小时'), 'with its text');

        telegram.reset();
        const emptyId = await notify.sendModelCatalogNotice(telegram.api, []);
        expect(emptyId === null, 'an empty catalog notice is skipped');
        expect(sentPayloadsOf(telegram).length === 0, 'and sends nothing');
    })
);

cases.push(
    await runCase('a refused send only logs: the proposals stay pending without a message id', async () => {
        await resetPricingDb();
        const telegram = createFakeTelegram();
        const refuseSend: Transformer = (previous, method, payload, signal) => {
            if (method === 'sendMessage') return Promise.reject(new Error('offline: bot is blocked'));
            return previous(method, payload, signal);
        };
        telegram.api.config.use(refuseSend);
        const pending = await seedProposals([newModelDraftOf('offline-refused', 2)]);

        const messageIds = await quietly(() => notify.sendProposalMessage(telegram.api, { id: 3 }, pending));
        expect(messageIds.length === 0, `no message id comes back (got ${messageIds.length})`);
        const stored = await proposalsOfModel('offline-refused');
        expect(stored[0]?.messageId === null, 'the proposal keeps no message pointer');
        expect(stored[0]?.status === 'pending', 'and stays pending');

        const noticeId = await quietly(() => notify.sendOwnerNotice(telegram.api, 'hello'));
        expect(noticeId === null, 'a notice that could not be sent reports null');
    })
);

reportResults(cases);
