/**
 * Offline cases for the capability watcher's approval UX (thinking-effort
 * design 2026-1113-1742 §2.4/§6): the private-chat proposal message (render,
 * batching, messageId write-back), the owner's `catalog:` buttons (apply,
 * reject, refused presser, repeated press, failed write), the 14-day expiry,
 * the pending-row refresh, and the registry/version refresh the apply performs.
 *
 * The Bot API is a local fake and the DB is the harness scratch file: nothing
 * here touches the network. The watcher itself (compile/diff wiring) is covered
 * by `price-command.mts` and `catalog-capabilities.mts`.
 *
 * Run: npx tsx scripts/offline/capability-approval.mts
 */
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';
import { callbackUpdate, createFakeBot, createFakeTelegram, lastToastOf, quietly } from './fake-telegram.mts';
import type { CapabilityProposalDraft } from '../../src/services/capability-catalog-types.js';
import type { CapabilityProposalView } from '../../src/services/model-capability-service.js';
import type { ModelCatalogCapabilities, ModelEffort } from '../../src/config/model-capabilities.js';

process.env.OWNER_USER_ID = '4242';
process.env.OWNER_DISPLAY_NAME = '机主';
process.env.BOT_USER_ID = '7777';
process.env.BOT_NAME = 'K-ON';
// The watcher's timer is never started here; the switch keeps it that way
process.env.PRICE_WATCH = '0';

const db = await setupOfflineDb();
const catalogConfig = await import('../../src/config/model-catalog.js');
const catalogService = await import('../../src/services/model-catalog-service.js');
const service = await import('../../src/services/model-capability-service.js');
const notify = await import('../../src/services/capability-proposal-notify.js');
const approvalMenu = await import('../../src/cmd/menus/capability-approval-menu.js');
const { ModelCapabilityProposal } = await import('../../src/db/modelCapabilityProposalDTO.js');
const { ModelCatalogEntryRow } = await import('../../src/db/modelCatalogDTO.js');
const { SettingsAudit } = await import('../../src/db/settingsAuditDTO.js');
const { listSettingsAudit } = await import('../../src/db/queries/settings-audit.js');

const OWNER_ID = 4242;
const OUTSIDER_ID = 5151;
const CHECKED_ON = '2026-11-14';

// ---- helpers ----

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const payloadTextOf = (payload: Readonly<Record<string, unknown>>): string =>
    typeof payload.text === 'string' ? payload.text : '';

const sentPayloadsOf = (telegram: ReturnType<typeof createFakeTelegram>): readonly Readonly<Record<string, unknown>>[] =>
    telegram.callsOf('sendMessage').map((call) => call.payload);

const lastToastText = (telegram: ReturnType<typeof createFakeTelegram>): string => {
    const toast = lastToastOf(telegram);
    return typeof toast === 'string' ? toast : '';
};

const keyboardRowsOf = (payload: Readonly<Record<string, unknown>>): readonly (readonly unknown[])[] => {
    const markup = payload.reply_markup;
    if (!isRecord(markup) || !Array.isArray(markup.inline_keyboard)) return [];
    return markup.inline_keyboard.filter((row): row is readonly unknown[] => Array.isArray(row));
};

const callbackDataOf = (payload: Readonly<Record<string, unknown>>): readonly string[] =>
    keyboardRowsOf(payload).flatMap((row) =>
        row.flatMap((button): string[] => {
            if (!isRecord(button)) return [];
            return typeof button.callback_data === 'string' ? [button.callback_data] : [];
        })
    );

const keyboardRemoved = (payload: Readonly<Record<string, unknown>>): boolean => {
    const markup = payload.reply_markup;
    return isRecord(markup) && Array.isArray(markup.inline_keyboard) && markup.inline_keyboard.length === 0;
};

const entitiesOf = (payload: Readonly<Record<string, unknown>>): readonly Record<string, unknown>[] => {
    const entities = payload.entities;
    if (!Array.isArray(entities)) return [];
    return entities.filter(isRecord);
};

/** Empty every capability table and reload the seeded catalog (rows + registry) */
const resetCapabilityDb = async (): Promise<void> => {
    await ModelCapabilityProposal.destroy({ where: {} });
    await SettingsAudit.destroy({ where: {} });
    await ModelCatalogEntryRow.destroy({ where: {} });
    await quietly(() => catalogService.loadModelCatalog());
};

const currentOf = (model: string): ModelCatalogCapabilities => {
    const entry = catalogConfig.findModelCatalogEntry(model);
    if (entry === null) throw new Error(`no catalog entry for ${model}`);
    return entry.capabilities;
};

/** A draft whose payload is the current row with `build` applied */
const draftOf = (
    model: string,
    build: (current: ModelCatalogCapabilities) => ModelCatalogCapabilities
): CapabilityProposalDraft => {
    const baseline = currentOf(model);
    const built = build(baseline);
    const payload: ModelCatalogCapabilities = {
        ...built,
        schema: 1,
        ...(built.reasoning === undefined
            ? {}
            : {
                  reasoning: {
                      ...built.reasoning,
                      source: 'models-dev',
                      checkedOn: CHECKED_ON,
                      confidence: 'medium',
                  },
              }),
        source: 'models-dev',
        checkedOn: CHECKED_ON,
        confidence: 'medium',
    };
    return {
        model,
        payload,
        baseline,
        changes: [],
        note: `能力变化：contextTokens（models.dev，${CHECKED_ON}）`,
        checkedOn: CHECKED_ON,
    };
};

const withEfforts = (current: ModelCatalogCapabilities, efforts: readonly ModelEffort[]): ModelCatalogCapabilities => ({
    ...current,
    reasoningEffort: efforts,
    ...(current.reasoning === undefined ? {} : { reasoning: { ...current.reasoning, efforts } }),
});

const seedProposals = async (drafts: readonly CapabilityProposalDraft[]): Promise<readonly CapabilityProposalView[]> => {
    await service.createOrRefreshCapabilityProposals(drafts, null);
    return service.listPendingCapabilityProposals();
};

const sendApprovalMessage = async (
    telegram: ReturnType<typeof createFakeTelegram>,
    proposals: readonly CapabilityProposalView[]
): Promise<readonly number[]> => notify.sendCapabilityProposalMessage(telegram.api, proposals);

interface MenuBot {
    readonly bot: ReturnType<typeof createFakeBot>['bot'];
    readonly telegram: ReturnType<typeof createFakeTelegram>;
}

const menuBotOf = (): MenuBot => {
    const { bot, telegram } = createFakeBot();
    approvalMenu.registerCapabilityApprovalCallbacks(bot);
    return { bot, telegram };
};

/** Press one approval button; the console stays quiet (expected failures log) */
const press = async (bot: MenuBot['bot'], messageId: number, userId: number, data: string): Promise<void> => {
    await quietly(() =>
        bot.handleUpdate(callbackUpdate({ chatId: OWNER_ID, messageId, userId, data }))
    );
};

const statusOf = async (id: number): Promise<{ status: string; messageId: number | null }> => {
    const row = await ModelCapabilityProposal.findByPk(id);
    return { status: row?.status ?? 'missing', messageId: row?.messageId ?? null };
};

/** The callback a rendered message would carry for one proposal */
const applyCallbackOf = (proposal: CapabilityProposalView): string =>
    `catalog:apply:${proposal.id}:${proposal.detectedAt.getTime()}`;

/** The bulk callbacks a rendered message would carry for the whole pending list */
const latestDetectedAtMsOf = (proposals: readonly CapabilityProposalView[]): number =>
    proposals.reduce((latest, proposal) => Math.max(latest, proposal.detectedAt.getTime()), 0);

const allApplyCallbackOf = (proposals: readonly CapabilityProposalView[]): string =>
    `catalog:all:apply:${latestDetectedAtMsOf(proposals)}`;

const allRejectCallbackOf = (proposals: readonly CapabilityProposalView[]): string =>
    `catalog:all:reject:${latestDetectedAtMsOf(proposals)}`;

const rowCapabilitiesOf = async (model: string): Promise<Record<string, unknown>> => {
    const row = await ModelCatalogEntryRow.findByPk(model);
    if (row === null) throw new Error(`no catalog row for ${model}`);
    const parsed: unknown = JSON.parse(row.capabilities);
    if (!isRecord(parsed)) throw new Error('capabilities is not a JSON object');
    return parsed;
};

const cases: CaseResult[] = [];

// ---- the proposal message ----

cases.push(
    await runCase('the message shows model, field-level old → new and provenance', async () => {
        await resetCapabilityDb();
        const telegram = createFakeTelegram();
        const pending = await seedProposals([
            draftOf('gemini-4-hydrogen', (current) => ({
                ...withEfforts(current, ['low', 'medium', 'high']),
                contextTokens: 2_000_000,
            })),
            draftOf('gemini-4-argon', (current) => ({ ...current, outputTokens: 32_768, tools: false })),
        ]);
        expect(pending.length === 2, `two proposals are pending (got ${pending.length})`);

        const messageIds = await sendApprovalMessage(telegram, pending);
        expect(messageIds.length === 1, `one message carries both (got ${messageIds.length})`);
        const messageId = messageIds[0];
        if (messageId === undefined) throw new Error('the approval message was not sent');

        const payload = sentPayloadsOf(telegram)[0];
        if (payload === undefined) throw new Error('no sendMessage was recorded');
        const text = payloadTextOf(payload);

        expect(payload.chat_id === OWNER_ID, 'the message goes to the owner\'s own chat');
        expect(
            text.includes(`🧩 能力巡检：2 条待确认（目录 ${catalogConfig.modelCatalogVersion()}）`),
            `the header names the count and the catalog version (got ${JSON.stringify(text.slice(0, 100))})`
        );
        expect(text.includes('gemini-4-hydrogen'), 'the first model is titled');
        expect(text.includes('上下文上限：1048576 → 2000000'), `the token limit change is shown (got ${JSON.stringify(text)})`);
        expect(text.includes('思考档位：low/medium/high/xhigh → low/medium/high'), 'the effort list change is shown');
        expect(text.includes('gemini-4-argon'), 'the second model is titled');
        expect(text.includes('输出上限：65536 → 32768'), 'the second change is shown');
        expect(text.includes('工具调用：是 → 否'), 'a boolean capability is readable');
        expect(
            text.includes(`来源 models.dev（${CHECKED_ON}，置信 中）`),
            'the provenance line names the source, date and confidence'
        );
        const entities = entitiesOf(payload);
        expect(entities.some((entity) => entity.type === 'bold'), 'the header and titles are bold');
        const preview = payload.link_preview_options;
        expect(isRecord(preview) && preview.is_disabled === true, 'the link preview is disabled');

        const callbacks = callbackDataOf(payload);
        for (const proposal of pending) {
            expect(callbacks.includes(applyCallbackOf(proposal)), `proposal #${proposal.id} has its own button`);
        }
        expect(callbacks.includes(allApplyCallbackOf(pending)), 'the all-apply button carries the pending fingerprint');
        expect(callbacks.includes(allRejectCallbackOf(pending)), 'the all-reject button carries the pending fingerprint');
        expect(
            callbacks.every((callback) => /^catalog:(apply:\d+:\d+|all:(apply|reject):\d+)$/.test(callback)),
            `every button carries a fingerprint (got ${callbacks.join(', ')})`
        );
        expect(keyboardRowsOf(payload).length === 3, `one row per proposal plus the shared row (got ${keyboardRowsOf(payload).length})`);

        // The message id is written back onto every proposal it carries
        for (const proposal of pending) {
            const stored = await statusOf(proposal.id);
            expect(stored.messageId === messageId, `proposal #${proposal.id} remembers its message`);
        }

        // The notice itself is a bot row, so later contexts see what was asked
        const row = await db.Message.findOne({ where: { chatId: OWNER_ID, messageId } });
        expect(row !== null && row.fromBotSelf, 'the approval message is stored as a bot row');
        expect(row?.text === text, 'with the same text');
    })
);

cases.push(
    await runCase('a source-only probe import shows the probe provenance, not the row source', async () => {
        await resetCapabilityDb();
        const telegram = createFakeTelegram();
        const baseline = currentOf('gemini-4-hydrogen');
        if (baseline.reasoning === undefined) throw new Error('the seeded hydrogen row has no reasoning section');
        // Probe result identical to the seed: only the reasoning provenance moves
        const id = await service.upsertCapabilityProposal({
            model: 'gemini-4-hydrogen',
            payload: {
                ...baseline,
                reasoning: {
                    ...baseline.reasoning,
                    source: 'probe',
                    checkedOn: '2026-11-14',
                    confidence: 'high',
                },
            },
            baseline,
            note: 'probe 实测与 seed 一致',
            checkedOn: '2026-11-14',
        });
        const pending = await service.listPendingCapabilityProposals();
        expect(pending.length === 1 && pending[0]?.id === id, 'one source-only proposal is pending');

        const messageIds = await sendApprovalMessage(telegram, pending);
        expect(messageIds.length === 1, 'one message is sent');
        const text = payloadTextOf(sentPayloadsOf(telegram)[0] ?? {});
        expect(text.includes('能力数据同步（字段值未变）'), `the message says nothing changed (got ${JSON.stringify(text)})`);
        expect(
            text.includes('来源 probe（2026-11-14，置信 高）'),
            `the probe provenance is shown, not the row source (got ${JSON.stringify(text)})`
        );
    })
);

cases.push(
    await runCase('more than four proposals are split, numbered and all still get their message id', async () => {
        await resetCapabilityDb();
        const telegram = createFakeTelegram();
        const models = ['gemini-4-hydrogen', 'gemini-4-argon', 'gemini-4-carbon', 'gpt-6-luna', 'claude-sonnet-5-5'];
        const drafts = models.map((model, index) =>
            draftOf(model, (current) => ({ ...current, contextTokens: 1_000_000 + index }))
        );
        const pending = await seedProposals(drafts);
        expect(pending.length === 5, `five proposals are pending (got ${pending.length})`);

        const messageIds = await sendApprovalMessage(telegram, pending);
        expect(messageIds.length === 2, `five proposals need two messages (got ${messageIds.length})`);

        const payloads = sentPayloadsOf(telegram);
        const first = payloads[0];
        const second = payloads[1];
        if (first === undefined || second === undefined) throw new Error('expected two sendMessage calls');
        expect(payloadTextOf(first).includes('还有 1 条'), 'the first message says more follow');
        expect(payloadTextOf(second).includes('第 5–5 条'), 'the second message numbers its range');
        expect(!payloadTextOf(second).includes('还有'), 'the last message does not announce more');
        expect(keyboardRowsOf(first).length === 5, `four apply rows plus the shared row (got ${keyboardRowsOf(first).length})`);
        expect(keyboardRowsOf(second).length === 2, `one apply row plus the shared row (got ${keyboardRowsOf(second).length})`);

        const firstBatch = await statusOf(pending[0]?.id ?? -1);
        const lastBatch = await statusOf(pending[4]?.id ?? -1);
        expect(firstBatch.messageId === messageIds[0], 'a proposal of the first batch points at the first message');
        expect(lastBatch.messageId === messageIds[1], 'the last proposal points at the second message');
    })
);

cases.push(
    await runCase('notifyPendingCapabilityProposals sends the pending list and returns the message count', async () => {
        await resetCapabilityDb();
        const { bot, telegram } = createFakeBot();
        const emptyCount = await quietly(() => notify.notifyPendingCapabilityProposals(bot));
        expect(emptyCount === 0, `nothing pending sends nothing (got ${emptyCount})`);

        await seedProposals([draftOf('gemini-4-carbon', (current) => ({ ...current, contextTokens: 1_100_000 }))]);
        const count = await quietly(() => notify.notifyPendingCapabilityProposals(bot));
        expect(count === 1, `one message is sent (got ${count})`);
        expect(sentPayloadsOf(telegram).length === 1, 'the fake api saw one sendMessage');
    })
);

// ---- the approval buttons ----

cases.push(
    await runCase('the owner applies one proposal: catalog written, registry refreshed, audit and message edited', async () => {
        await resetCapabilityDb();
        const versionBefore = catalogConfig.modelCatalogVersion();
        const telegram = createFakeTelegram();
        const pending = await seedProposals([
            draftOf('gemini-4-hydrogen', (current) => ({ ...current, contextTokens: 2_000_000 })),
        ]);
        const proposal = pending[0];
        if (proposal === undefined) throw new Error('no proposal was created');
        const messageId = (await sendApprovalMessage(telegram, pending))[0];
        if (messageId === undefined) throw new Error('the approval message was not sent');

        const { bot, telegram: menuTelegram } = menuBotOf();
        await press(bot, messageId, OWNER_ID, applyCallbackOf(proposal));

        expect(
            lastToastText(menuTelegram) === '已应用 1 条',
            `the toast confirms the apply (got ${JSON.stringify(lastToastText(menuTelegram))})`
        );
        const edits = menuTelegram.callsOf('editMessageText');
        expect(edits.length === 1, `the message is rewritten once (got ${edits.length})`);
        const edit = edits[0]?.payload;
        if (edit === undefined) throw new Error('no editMessageText was recorded');
        const editText = payloadTextOf(edit);
        expect(
            editText.startsWith('✅ 已应用 1 条能力提案'),
            `the rewritten message says what happened (got ${JSON.stringify(editText)})`
        );
        expect(editText.includes('gemini-4-hydrogen'), 'and names the model');
        expect(keyboardRemoved(edit), 'the buttons are removed with an empty keyboard');

        // Proposal decided, catalog row written as schema 1
        expect((await statusOf(proposal.id)).status === 'approved', 'the proposal is approved');
        const stored = await rowCapabilitiesOf('gemini-4-hydrogen');
        expect(stored.schema === 1, `the stored JSON is schema 1 (got ${String(stored.schema)})`);
        expect(stored.contextTokens === 2_000_000, `the approved capability was written (got ${String(stored.contextTokens)})`);

        // The in-memory registry serves the new value and the content version moved
        const refreshed = catalogConfig.findModelCatalogEntry('gemini-4-hydrogen');
        expect(refreshed?.capabilities.contextTokens === 2_000_000, 'the registry serves the new capability');
        expect(
            catalogConfig.modelCatalogVersion() !== versionBefore,
            `the catalog version moved (${versionBefore} → ${catalogConfig.modelCatalogVersion()})`
        );

        // One audit row with the capability key and both JSON snapshots
        const audit = await listSettingsAudit({ scope: 'model-catalog', limit: 10 });
        expect(audit.length === 1, `one audit row was written (got ${audit.length})`);
        const entry = audit[0];
        expect(entry?.actorId === OWNER_ID, 'the audit names the owner');
        expect(entry?.key === 'gemini-4-hydrogen:capabilities', `the audit key is model:capabilities (got ${entry?.key})`);
        expect((entry?.oldValue ?? '').includes('"contextTokens":1048576'), 'the audit keeps the old value');
        expect((entry?.newValue ?? '').includes('"contextTokens":2000000'), 'and the new one');

        // The stored copy of the message follows the edit
        const storedNotice = await db.Message.findOne({ where: { chatId: OWNER_ID, messageId } });
        expect((storedNotice?.text ?? '').startsWith('✅ 已应用 1 条'), 'the stored bot row is updated too');
    })
);

cases.push(
    await runCase('all apply writes every pending proposal and audits each row', async () => {
        await resetCapabilityDb();
        const telegram = createFakeTelegram();
        const pending = await seedProposals([
            draftOf('gemini-4-hydrogen', (current) => ({ ...current, outputTokens: 32_000 })),
            draftOf('gemini-4-argon', (current) => ({ ...current, contextTokens: 900_000 })),
        ]);
        const messageId = (await sendApprovalMessage(telegram, pending))[0];
        if (messageId === undefined) throw new Error('the approval message was not sent');

        const { bot, telegram: menuTelegram } = menuBotOf();
        await press(bot, messageId, OWNER_ID, allApplyCallbackOf(pending));

        expect(lastToastText(menuTelegram) === '已应用 2 条', `the toast counts both (got ${JSON.stringify(lastToastText(menuTelegram))})`);
        const edit = menuTelegram.callsOf('editMessageText')[0]?.payload;
        if (edit === undefined) throw new Error('no editMessageText was recorded');
        expect(payloadTextOf(edit).startsWith('✅ 已应用 2 条能力提案'), 'the message says both were applied');
        expect(keyboardRemoved(edit), 'the buttons are removed');
        const audit = await listSettingsAudit({ scope: 'model-catalog', limit: 10 });
        expect(audit.length === 2, `both writes are audited (got ${audit.length})`);
        expect((await rowCapabilitiesOf('gemini-4-hydrogen')).outputTokens === 32_000, 'the first row changed');
        expect((await rowCapabilitiesOf('gemini-4-argon')).contextTokens === 900_000, 'the second row changed');
    })
);

cases.push(
    await runCase('the owner rejects everything: catalog untouched, both proposals and audits recorded', async () => {
        await resetCapabilityDb();
        const telegram = createFakeTelegram();
        const pending = await seedProposals([
            draftOf('gemini-4-hydrogen', (current) => ({ ...current, contextTokens: 2_000_000 })),
            draftOf('gemini-4-argon', (current) => ({ ...current, tools: false })),
        ]);
        const messageId = (await sendApprovalMessage(telegram, pending))[0];
        if (messageId === undefined) throw new Error('the approval message was not sent');

        const { bot, telegram: menuTelegram } = menuBotOf();
        await press(bot, messageId, OWNER_ID, allRejectCallbackOf(pending));

        expect(lastToastText(menuTelegram) === '已忽略 2 条', 'the toast counts the rejections');
        const edit = menuTelegram.callsOf('editMessageText')[0]?.payload;
        if (edit === undefined) throw new Error('no editMessageText was recorded');
        expect(payloadTextOf(edit).startsWith('❌ 已忽略 2 条能力提案'), 'the message says they were rejected');
        expect(keyboardRemoved(edit), 'the buttons are removed');
        for (const proposal of pending) {
            expect((await statusOf(proposal.id)).status === 'rejected', `proposal #${proposal.id} is rejected`);
        }
        expect((await rowCapabilitiesOf('gemini-4-hydrogen')).contextTokens === 1_048_576, 'the catalog did not change');
        const audit = await listSettingsAudit({ scope: 'model-catalog', limit: 10 });
        expect(audit.length === 2, `both rejections are audited (got ${audit.length})`);
        expect(audit.every((entry) => entry.newValue === 'rejected'), 'the audit says rejected');
    })
);

cases.push(
    await runCase('a press from somebody else is refused and changes nothing', async () => {
        await resetCapabilityDb();
        const telegram = createFakeTelegram();
        const pending = await seedProposals([
            draftOf('gemini-4-carbon', (current) => ({ ...current, contextTokens: 1_100_000 })),
        ]);
        const proposal = pending[0];
        if (proposal === undefined) throw new Error('no proposal was created');
        const messageId = (await sendApprovalMessage(telegram, pending))[0];
        if (messageId === undefined) throw new Error('the approval message was not sent');

        const { bot, telegram: menuTelegram } = menuBotOf();
        await press(bot, messageId, OUTSIDER_ID, applyCallbackOf(proposal));

        expect(lastToastText(menuTelegram) === '只有机主可以审批', 'the outsider is told no');
        expect(menuTelegram.callsOf('editMessageText').length === 0, 'the message is left alone');
        expect((await statusOf(proposal.id)).status === 'pending', 'the proposal is still pending');
        const audit = await listSettingsAudit({ scope: 'model-catalog', limit: 10 });
        expect(audit.length === 0, 'nothing was audited');
        expect((await rowCapabilitiesOf('gemini-4-carbon')).contextTokens === 1_048_576, 'the catalog is untouched');
    })
);

cases.push(
    await runCase('a second press on a decided proposal answers 已处理 and writes nothing', async () => {
        await resetCapabilityDb();
        const telegram = createFakeTelegram();
        const pending = await seedProposals([
            draftOf('gemini-4-hydrogen', (current) => ({ ...current, contextTokens: 2_000_000 })),
        ]);
        const proposal = pending[0];
        if (proposal === undefined) throw new Error('no proposal was created');
        const messageId = (await sendApprovalMessage(telegram, pending))[0];
        if (messageId === undefined) throw new Error('the approval message was not sent');

        const { bot, telegram: menuTelegram } = menuBotOf();
        await press(bot, messageId, OWNER_ID, applyCallbackOf(proposal));
        expect((await listSettingsAudit({ scope: 'model-catalog', limit: 10 })).length === 1, 'the first press applied');

        await press(bot, messageId, OWNER_ID, applyCallbackOf(proposal));
        expect(lastToastText(menuTelegram) === '已处理', `the second press says it is done (got ${JSON.stringify(lastToastText(menuTelegram))})`);
        expect(menuTelegram.callsOf('editMessageText').length === 1, 'only the first press edited the message');
        expect((await listSettingsAudit({ scope: 'model-catalog', limit: 10 })).length === 1, 'nothing was audited twice');
    })
);

cases.push(
    await runCase('a failed write keeps the proposal pending and says so', async () => {
        await resetCapabilityDb();
        const broken = await ModelCapabilityProposal.create({
            model: 'gemini-4-hydrogen',
            payload: 'not-json',
            baseline: null,
            detectedAt: new Date(),
            status: 'pending',
        });

        // The service's transaction rolls back: the row is untouched
        let thrown = false;
        try {
            await service.applyCapabilityProposals([broken.id], OWNER_ID);
        } catch {
            thrown = true;
        }
        expect(thrown, 'applying a broken proposal throws');
        expect((await statusOf(broken.id)).status === 'pending', 'the proposal is still pending after the rollback');
        expect((await rowCapabilitiesOf('gemini-4-hydrogen')).contextTokens === 1_048_576, 'the catalog is untouched');
        expect((await listSettingsAudit({ scope: 'model-catalog', limit: 10 })).length === 0, 'nothing was audited');

        const { bot, telegram: menuTelegram } = menuBotOf();
        await press(bot, 900, OWNER_ID, `catalog:apply:${broken.id}:${broken.detectedAt.getTime()}`);
        expect(
            lastToastText(menuTelegram) === '写入失败，见日志',
            `the owner is told the write failed (got ${JSON.stringify(lastToastText(menuTelegram))})`
        );
        expect(menuTelegram.callsOf('editMessageText').length === 0, 'the message keeps its buttons');
    })
);

cases.push(
    await runCase('an unknown capability action is answered, and other callbacks pass through', async () => {
        await resetCapabilityDb();
        const { bot, telegram } = createFakeBot();
        approvalMenu.registerCapabilityApprovalCallbacks(bot);
        // Later in the chain, so it only runs when the capability handler called next()
        bot.on('callback_query:data', async (ctx) => {
            await ctx.answerCallbackQuery({ text: '其它菜单' });
        });

        await press(bot, 901, OWNER_ID, 'catalog:unknown');
        expect(lastToastText(telegram) === '按钮已失效', 'an unknown capability action answers');

        await press(bot, 901, OWNER_ID, 'resp:stop');
        expect(lastToastText(telegram) === '其它菜单', 'another menu keeps its callbacks');
    })
);

// ---- expiry and refresh ----

cases.push(
    await runCase('a pending proposal older than 14 days expires', async () => {
        await resetCapabilityDb();
        const pending = await seedProposals([
            draftOf('gemini-4-hydrogen', (current) => ({ ...current, contextTokens: 2_000_000 })),
        ]);
        const proposal = pending[0];
        if (proposal === undefined) throw new Error('no proposal was created');
        const old = new Date(Date.now() - 15 * 24 * 3600 * 1000);
        await ModelCapabilityProposal.update({ detectedAt: old }, { where: { id: proposal.id } });

        const expired = await service.expireStaleCapabilityProposals(new Date());
        expect(expired === 1, `one proposal expires (got ${expired})`);
        expect((await statusOf(proposal.id)).status === 'expired', 'the proposal is expired');
        expect((await service.countPendingCapabilityProposals()) === 0, 'nothing is pending any more');
    })
);

cases.push(
    await runCase('refresh: one pending row per model, latest payload kept, blank note gets the check date', async () => {
        await resetCapabilityDb();
        const baseline = currentOf('gemini-4-hydrogen');
        const firstId = await service.upsertCapabilityProposal({
            model: 'gemini-4-hydrogen',
            payload: { ...baseline, contextTokens: 2_000_000 },
            baseline,
            note: '首次能力变化',
            checkedOn: CHECKED_ON,
        });
        const secondId = await service.upsertCapabilityProposal({
            model: 'gemini-4-hydrogen',
            payload: { ...baseline, contextTokens: 3_000_000 },
            baseline,
            note: '',
            checkedOn: CHECKED_ON,
        });
        expect(secondId === firstId, `the pending row is refreshed, not duplicated (got ${firstId} / ${secondId})`);
        expect((await service.countPendingCapabilityProposals()) === 1, 'one pending row remains');
        const pending = await service.listPendingCapabilityProposals();
        expect(pending[0]?.payload.contextTokens === 3_000_000, 'the latest payload is kept');
        expect(
            (pending[0]?.note ?? '').includes(CHECKED_ON),
            `a blank note falls back to the check date (got ${JSON.stringify(pending[0]?.note)})`
        );
    })
);

// ---- stale approval messages (detectedAt fingerprint) ----

/** Overwrite one catalog row's capabilities JSON and reload the registry */
const rewriteRowCapabilities = async (
    model: string,
    build: (current: Record<string, unknown>) => Record<string, unknown>
): Promise<void> => {
    const current = await rowCapabilitiesOf(model);
    await ModelCatalogEntryRow.update({ capabilities: JSON.stringify(build(current)) }, { where: { id: model } });
    await quietly(() => catalogService.loadModelCatalog());
};

const reasoningRecordOf = (capabilities: Record<string, unknown>): Record<string, unknown> => {
    const reasoning = capabilities.reasoning;
    if (!isRecord(reasoning)) throw new Error('the row has no reasoning section');
    return reasoning;
};

cases.push(
    await runCase('a refreshed proposal cannot be approved from the old message', async () => {
        await resetCapabilityDb();
        const telegram = createFakeTelegram();
        const pending = await seedProposals([
            draftOf('gemini-4-hydrogen', (current) => ({ ...current, contextTokens: 2_000_000 })),
        ]);
        const proposal = pending[0];
        if (proposal === undefined) throw new Error('no proposal was created');
        const oldCallback = applyCallbackOf(proposal);
        const messageId = (await sendApprovalMessage(telegram, pending))[0];
        if (messageId === undefined) throw new Error('the approval message was not sent');

        // The next watch run refreshes the pending payload in place; a fresh
        // timestamp keeps the fingerprint distinct even on a fast machine
        await new Promise((resolve) => setTimeout(resolve, 5));
        const baseline = currentOf('gemini-4-hydrogen');
        await service.upsertCapabilityProposal({
            model: 'gemini-4-hydrogen',
            payload: { ...baseline, contextTokens: 3_000_000 },
            baseline,
            note: 'refresh',
            checkedOn: CHECKED_ON,
        });
        const refreshed = await service.listPendingCapabilityProposals();
        const refreshedProposal = refreshed[0];
        if (refreshedProposal === undefined) throw new Error('the refresh lost the proposal');
        expect(refreshedProposal.detectedAt.getTime() !== proposal.detectedAt.getTime(), 'the payload fingerprint moved');

        const { bot, telegram: menuTelegram } = menuBotOf();
        await press(bot, messageId, OWNER_ID, oldCallback);
        expect(
            lastToastText(menuTelegram) === '提案已更新，请查看最新消息',
            `the old message is refused (got ${JSON.stringify(lastToastText(menuTelegram))})`
        );
        expect(menuTelegram.callsOf('editMessageText').length === 0, 'the old message keeps its content');
        expect((await statusOf(proposal.id)).status === 'pending', 'the proposal is still pending');
        expect((await rowCapabilitiesOf('gemini-4-hydrogen')).contextTokens === 1_048_576, 'the catalog is untouched');
        expect((await listSettingsAudit({ scope: 'model-catalog', limit: 10 })).length === 0, 'nothing was audited');

        await press(bot, messageId, OWNER_ID, applyCallbackOf(refreshedProposal));
        expect(lastToastText(menuTelegram) === '已应用 1 条', 'the fresh fingerprint applies');
        expect((await rowCapabilitiesOf('gemini-4-hydrogen')).contextTokens === 3_000_000, 'the refreshed value is written');
    })
);

cases.push(
    await runCase('bulk apply from a stale message is refused when a payload was refreshed', async () => {
        await resetCapabilityDb();
        const telegram = createFakeTelegram();
        const pending = await seedProposals([
            draftOf('gemini-4-hydrogen', (current) => ({ ...current, outputTokens: 32_000 })),
            draftOf('gemini-4-argon', (current) => ({ ...current, contextTokens: 900_000 })),
        ]);
        const oldCallback = allApplyCallbackOf(pending);
        const messageId = (await sendApprovalMessage(telegram, pending))[0];
        if (messageId === undefined) throw new Error('the approval message was not sent');
        await new Promise((resolve) => setTimeout(resolve, 5));
        const baseline = currentOf('gemini-4-argon');
        await service.upsertCapabilityProposal({
            model: 'gemini-4-argon',
            payload: { ...baseline, contextTokens: 800_000 },
            baseline,
            note: 'refresh',
            checkedOn: CHECKED_ON,
        });
        const refreshed = await service.listPendingCapabilityProposals();

        const { bot, telegram: menuTelegram } = menuBotOf();
        await press(bot, messageId, OWNER_ID, oldCallback);
        expect(
            lastToastText(menuTelegram) === '提案已更新，请查看最新消息',
            `the stale bulk press is refused (got ${JSON.stringify(lastToastText(menuTelegram))})`
        );
        expect((await rowCapabilitiesOf('gemini-4-hydrogen')).outputTokens === 65_536, 'the first row is untouched');
        expect((await rowCapabilitiesOf('gemini-4-argon')).contextTokens === 1_048_576, 'the refreshed row is untouched');
        expect((await service.countPendingCapabilityProposals()) === 2, 'both proposals are still pending');

        await press(bot, messageId, OWNER_ID, allApplyCallbackOf(refreshed));
        expect(lastToastText(menuTelegram) === '已应用 2 条', 'the fresh bulk fingerprint applies both');
        expect((await rowCapabilitiesOf('gemini-4-argon')).contextTokens === 800_000, 'the refreshed value is written');
    })
);

// ---- apply guard rails (baseline drift / unchanged / missing row) ----

cases.push(
    await runCase('a proposal whose catalog row drifted is superseded, never applied', async () => {
        await resetCapabilityDb();
        const telegram = createFakeTelegram();
        const pending = await seedProposals([
            draftOf('gemini-4-hydrogen', (current) => ({ ...current, contextTokens: 2_000_000 })),
        ]);
        const proposal = pending[0];
        if (proposal === undefined) throw new Error('no proposal was created');
        const messageId = (await sendApprovalMessage(telegram, pending))[0];
        if (messageId === undefined) throw new Error('the approval message was not sent');

        // Somebody changed the same row after the proposal was drafted
        await rewriteRowCapabilities('gemini-4-hydrogen', (current) => ({ ...current, contextTokens: 1_500_000 }));

        const { bot, telegram: menuTelegram } = menuBotOf();
        await press(bot, messageId, OWNER_ID, applyCallbackOf(proposal));
        expect(
            lastToastText(menuTelegram) === '数据已变化，请重新审批',
            `the drift is reported (got ${JSON.stringify(lastToastText(menuTelegram))})`
        );
        expect((await statusOf(proposal.id)).status === 'superseded', 'the proposal is superseded');
        expect((await rowCapabilitiesOf('gemini-4-hydrogen')).contextTokens === 1_500_000, 'the newer data survives');
        expect((await listSettingsAudit({ scope: 'model-catalog', limit: 10 })).length === 0, 'no write was audited');
        const edit = menuTelegram.callsOf('editMessageText')[0]?.payload;
        if (edit === undefined) throw new Error('no editMessageText was recorded');
        expect(payloadTextOf(edit).includes('数据已变化'), 'the rewritten message says the data moved');
    })
);

cases.push(
    await runCase('an approval that merges into the current values is reported as unchanged', async () => {
        await resetCapabilityDb();
        const current = currentOf('gemini-4-carbon');
        const proposalId = await service.upsertCapabilityProposal({
            model: 'gemini-4-carbon',
            payload: current,
            baseline: current,
            note: 'noop',
            checkedOn: CHECKED_ON,
        });
        const pending = await service.listPendingCapabilityProposals();
        const telegram = createFakeTelegram();
        const messageId = (await sendApprovalMessage(telegram, pending))[0];
        if (messageId === undefined) throw new Error('the approval message was not sent');

        const pendingProposal = pending[0];
        if (pendingProposal === undefined) throw new Error('no pending proposal');
        const { bot, telegram: menuTelegram } = menuBotOf();
        await press(bot, messageId, OWNER_ID, applyCallbackOf(pendingProposal));
        expect(lastToastText(menuTelegram) === '与当前一致', `the no-op is reported (got ${JSON.stringify(lastToastText(menuTelegram))})`);
        expect((await statusOf(proposalId)).status === 'approved', 'the press still decides the proposal');
        expect((await listSettingsAudit({ scope: 'model-catalog', limit: 10 })).length === 0, 'nothing was written');
        const edit = menuTelegram.callsOf('editMessageText')[0]?.payload;
        if (edit === undefined) throw new Error('no editMessageText was recorded');
        expect(payloadTextOf(edit).startsWith('ℹ️ 能力提案与当前一致'), 'the rewritten message says it matches');
    })
);

cases.push(
    await runCase('a manual reasoning row keeps its values and is reported unchanged', async () => {
        await resetCapabilityDb();
        await rewriteRowCapabilities('gemini-4-hydrogen', (current) => ({
            ...current,
            reasoning: { ...reasoningRecordOf(current), source: 'manual' },
        }));
        const pending = await seedProposals([draftOf('gemini-4-hydrogen', (current) => withEfforts(current, ['low']))]);
        const proposal = pending[0];
        if (proposal === undefined) throw new Error('no proposal was created');
        const telegram = createFakeTelegram();
        const messageId = (await sendApprovalMessage(telegram, pending))[0];
        if (messageId === undefined) throw new Error('the approval message was not sent');

        const { bot, telegram: menuTelegram } = menuBotOf();
        await press(bot, messageId, OWNER_ID, applyCallbackOf(proposal));
        expect(lastToastText(menuTelegram) === '与当前一致', `the silent no-op is now reported (got ${JSON.stringify(lastToastText(menuTelegram))})`);
        expect((await statusOf(proposal.id)).status === 'approved', 'the proposal is decided');
        const stored = await rowCapabilitiesOf('gemini-4-hydrogen');
        expect(JSON.stringify(reasoningRecordOf(stored).efforts) === '["low","medium","high","xhigh"]', 'the manual effort list survives');
        expect(reasoningRecordOf(stored).source === 'manual', 'the manual source survives');
        expect((await listSettingsAudit({ scope: 'model-catalog', limit: 10 })).length === 0, 'nothing was written');
    })
);

cases.push(
    await runCase('an official row keeps its values when an approval is pressed', async () => {
        await resetCapabilityDb();
        await rewriteRowCapabilities('gemini-4-hydrogen', (current) => ({
            ...current,
            source: 'official',
            reasoning: { ...reasoningRecordOf(current), source: 'official' },
        }));
        const pending = await seedProposals([
            draftOf('gemini-4-hydrogen', (current) => ({
                ...withEfforts(current, ['low', 'medium']),
                contextTokens: 2_000_000,
            })),
        ]);
        const proposal = pending[0];
        if (proposal === undefined) throw new Error('no proposal was created');
        const telegram = createFakeTelegram();
        const messageId = (await sendApprovalMessage(telegram, pending))[0];
        if (messageId === undefined) throw new Error('the approval message was not sent');

        const { bot, telegram: menuTelegram } = menuBotOf();
        await press(bot, messageId, OWNER_ID, applyCallbackOf(proposal));
        expect(lastToastText(menuTelegram) === '与当前一致', `the official data is not overwritten (got ${JSON.stringify(lastToastText(menuTelegram))})`);
        const stored = await rowCapabilitiesOf('gemini-4-hydrogen');
        expect(stored.source === 'official', 'the row source stays official');
        expect(reasoningRecordOf(stored).source === 'official', 'the reasoning source stays official');
        expect(JSON.stringify(reasoningRecordOf(stored).efforts) === '["low","medium","high","xhigh"]', 'the official effort list survives');
        expect(stored.contextTokens === 1_048_576, 'the official token limit survives');
        expect((await listSettingsAudit({ scope: 'model-catalog', limit: 10 })).length === 0, 'nothing was written');
    })
);

cases.push(
    await runCase('a proposal whose catalog row disappeared is superseded, not left pending', async () => {
        await resetCapabilityDb();
        const pending = await seedProposals([
            draftOf('gemini-4-carbon', (current) => ({ ...current, contextTokens: 1_100_000 })),
        ]);
        const proposal = pending[0];
        if (proposal === undefined) throw new Error('no proposal was created');
        const telegram = createFakeTelegram();
        const messageId = (await sendApprovalMessage(telegram, pending))[0];
        if (messageId === undefined) throw new Error('the approval message was not sent');

        await ModelCatalogEntryRow.destroy({ where: { id: 'gemini-4-carbon' } });
        await quietly(() => catalogService.loadModelCatalog());

        const { bot, telegram: menuTelegram } = menuBotOf();
        await press(bot, messageId, OWNER_ID, applyCallbackOf(proposal));
        expect(lastToastText(menuTelegram) === '数据已变化，请重新审批', `the missing row is reported (got ${JSON.stringify(lastToastText(menuTelegram))})`);
        expect((await statusOf(proposal.id)).status === 'superseded', 'the proposal is decided instead of stuck');
        expect((await service.countPendingCapabilityProposals()) === 0, 'nothing is left pending');
        expect((await listSettingsAudit({ scope: 'model-catalog', limit: 10 })).length === 0, 'nothing was audited');
    })
);

// ---- probe priority while pending ----

cases.push(
    await runCase('a pending probe proposal blocks the upstream draft until it is decided', async () => {
        await resetCapabilityDb();
        const baseline = currentOf('gemini-4-hydrogen');
        const reasoning = baseline.reasoning;
        if (reasoning === undefined) throw new Error('the seeded hydrogen row has no reasoning section');
        const probeId = await service.upsertCapabilityProposal({
            model: 'gemini-4-hydrogen',
            payload: {
                ...baseline,
                reasoningEffort: ['low'],
                reasoning: { ...reasoning, efforts: ['low'], source: 'probe', checkedOn: CHECKED_ON, confidence: 'high' },
            },
            baseline,
            note: 'probe',
            checkedOn: CHECKED_ON,
        });
        const upstreamDraft: CapabilityProposalDraft = {
            model: 'gemini-4-hydrogen',
            payload: {
                ...baseline,
                reasoningEffort: ['low', 'medium'],
                reasoning: {
                    ...reasoning,
                    efforts: ['low', 'medium'],
                    source: 'models-dev',
                    checkedOn: CHECKED_ON,
                    confidence: 'medium',
                },
            },
            baseline,
            changes: [],
            note: 'watch',
            checkedOn: CHECKED_ON,
        };

        const blocked = await service.createOrRefreshCapabilityProposals([upstreamDraft], null);
        expect(blocked.pending === 1, `one pending proposal remains (got ${blocked.pending})`);
        expect(blocked.skipped.length === 1 && blocked.skipped[0]?.model === 'gemini-4-hydrogen', 'the upstream draft is skipped');
        expect(
            (blocked.skipped[0]?.reason ?? '').includes('probe 提案待审批'),
            `the skip is explained (got ${JSON.stringify(blocked.skipped)})`
        );
        const still = await service.findCapabilityProposal(probeId);
        expect(still?.payload.reasoning?.source === 'probe', 'the probe payload is kept');
        expect(JSON.stringify(still?.payload.reasoning?.efforts) === '["low"]', 'the probe efforts are kept');

        // Once the owner decides the probe proposal, the next run may draft again
        await service.rejectCapabilityProposals([probeId], OWNER_ID);
        const allowed = await service.createOrRefreshCapabilityProposals([upstreamDraft], null);
        expect(allowed.skipped.length === 0, 'nothing is blocked after the probe decision');
        const refreshed = await service.listPendingCapabilityProposals();
        expect(refreshed[0]?.payload.reasoning?.source === 'models-dev', 'the upstream payload lands');
    })
);

// ---- concurrent proposal writes ----

cases.push(
    await runCase('two concurrent proposal writes end with one pending row instead of an error', async () => {
        await resetCapabilityDb();
        const baseline = currentOf('deepseek-flash');
        const ids = await Promise.all([
            service.upsertCapabilityProposal({
                model: 'deepseek-flash',
                payload: { ...baseline, contextTokens: 1_100_000 },
                baseline,
                note: 'one',
                checkedOn: CHECKED_ON,
            }),
            service.upsertCapabilityProposal({
                model: 'deepseek-flash',
                payload: { ...baseline, contextTokens: 1_200_000 },
                baseline,
                note: 'two',
                checkedOn: CHECKED_ON,
            }),
        ]);
        expect(ids[0] === ids[1], `both writes resolve to one row (got ${ids.join(' / ')})`);
        expect((await service.countPendingCapabilityProposals()) === 1, 'one pending row exists');
        const pending = await service.listPendingCapabilityProposals();
        expect(
            pending[0]?.payload.contextTokens === 1_100_000 || pending[0]?.payload.contextTokens === 1_200_000,
            `the newest write wins (got ${String(pending[0]?.payload.contextTokens)})`
        );
    })
);

// The catalog is not a reply path here; nothing was started that needs stopping.
reportResults(cases);
