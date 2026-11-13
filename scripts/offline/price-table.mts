/**
 * Offline cases for the SQLite price table (pricing design 2026-1113-1150):
 * a fresh database seeds from the built-in rows, effective windows make a
 * scheduled price change switch without a release while history keeps the old
 * price, proposals are deduped / applied / rejected / expired in transactions,
 * every write is audited, and the metadata the panel reads is consistent.
 *
 * Run: npx tsx scripts/offline/price-table.mts
 */
import { setupOfflineDb, expect, reportResults, runCase, type CaseResult } from './harness.mts';

await setupOfflineDb();
const pricing = await import('../../src/config/model-pricing.js');
const service = await import('../../src/services/model-price-service.js');
const { ModelPriceEntry } = await import('../../src/db/modelPriceDTO.js');
const { PriceChangeProposal } = await import('../../src/db/priceChangeProposalDTO.js');
const { SettingsAudit } = await import('../../src/db/settingsAuditDTO.js');
const { ModelCatalogEntryRow } = await import('../../src/db/modelCatalogDTO.js');
const { backfillCatalogLabels, backfillCatalogSeedsOnly } = await import('../../src/db/schema-migrations.js');
const { modelConfigs } = await import('../../src/config/models.js');
const catalogService = await import('../../src/services/model-catalog-service.js');
const { sequelize } = await import('../../src/db/config.js');

const at = (iso: string): Date => new Date(iso);
const results: CaseResult[] = [];

const entry = (over: Partial<import('../../src/config/model-pricing.js').PriceEntry> & { model: string }): import('../../src/config/model-pricing.js').PriceEntry => ({
    tier: 'standard',
    inputPerM: 1,
    cachedInputPerM: 0.1,
    outputPerM: 2,
    effectiveFrom: at('2026-11-13T00:00:00Z'),
    source: 'models-dev',
    sourceUrl: 'https://example.test/pricing',
    checkedOn: '2026-11-13',
    confidence: 'high',
    ...over,
});

results.push(
    await runCase('the one-off cleanup drops models the first catalog watch auto-added', async () => {
        const now = new Date();
        // Both tables are already seeded by the startup loaders in production
        await service.loadModelPrices();
        await catalogService.loadModelCatalog();
        // The startup chain already ran the cleanup once; replay the upgrade
        await sequelize.query("DELETE FROM schema_migrations WHERE name = '20261113_catalog_legacy_cleanup'");
        await ModelCatalogEntryRow.create({
            id: 'gpt-4o',
            label: 'gpt-4o',
            enabled: 1,
            capabilities: '{}',
            source: 'models-dev',
            sourceUrl: 'https://example.test/models-dev',
            checkedOn: '2026-11-13',
            confidence: 'medium',
            note: 'auto-added by the price watcher',
            createdAt: now,
            updatedAt: now,
        });
        await ModelPriceEntry.create({
            model: 'gpt-4o',
            tier: 'standard',
            inputPerM: 2.5,
            cachedInputPerM: 1.25,
            cacheWritePerM: null,
            outputPerM: 10,
            imageOutputPerM: null,
            perImageUsd: null,
            effectiveFrom: new Date('2026-11-13T00:00:00Z'),
            effectiveTo: null,
            source: 'models-dev',
            sourceUrl: 'https://example.test/models-dev',
            checkedOn: '2026-11-13',
            confidence: 'medium',
            note: null,
        });
        const beforeCleanup = await ModelCatalogEntryRow.count();
        await backfillCatalogSeedsOnly();
        const afterCleanup = await ModelCatalogEntryRow.count();
        expect(
            afterCleanup === modelConfigs.length,
            `the catalog holds only the seeded menu (${afterCleanup} rows, ${beforeCleanup} before, ${modelConfigs.length} seeds)`
        );
        expect((await ModelPriceEntry.count({ where: { model: 'gpt-4o' } })) === 0, 'the auto-added price row is gone');
        // Recorded once: a second pass changes nothing
        await ModelCatalogEntryRow.create({
            id: 'gpt-5.2',
            label: 'gpt-5.2',
            enabled: 1,
            capabilities: '{}',
            source: 'models-dev',
            checkedOn: '2026-11-13',
            confidence: 'medium',
            note: null,
            createdAt: now,
            updatedAt: now,
        });
        await backfillCatalogSeedsOnly();
        expect((await ModelCatalogEntryRow.count()) === modelConfigs.length + 1, 'the cleanup runs exactly once');
    })
);

results.push(
    await runCase('the label backfill renames old seeded labels only', async () => {
        await catalogService.loadModelCatalog();
        // Rows carry the display names now; put two back to what the first
        // seed wrote (the id, and the one model whose old name differed)
        await ModelCatalogEntryRow.update({ label: 'gpt-6-sol' }, { where: { id: 'gpt-6-sol' } });
        await ModelCatalogEntryRow.update(
            { label: 'grok-4.20-multi-agent' },
            { where: { id: 'grok-4.20-multi-agent-0309' } }
        );
        // A label the owner edited is not one of the old defaults
        await ModelCatalogEntryRow.update({ label: '我的自定义名字' }, { where: { id: 'gemini-4-argon' } });
        const nameOf = (id: string): string => modelConfigs.find((model) => model.id === id)?.name ?? id;
        await sequelize.query("DELETE FROM schema_migrations WHERE name = '20261113_catalog_labels'");
        await backfillCatalogLabels();
        const renamed = await ModelCatalogEntryRow.findByPk('gpt-6-sol');
        expect(renamed?.label === nameOf('gpt-6-sol'), `the id label becomes the display name (got ${renamed?.label})`);
        expect(nameOf('gpt-6-sol') === 'GPT-6 Sol', 'the seed label is the catalog display name');
        const renamedOldName = await ModelCatalogEntryRow.findByPk('grok-4.20-multi-agent-0309');
        expect(
            renamedOldName?.label === 'Grok 4.20 Multi-Agent',
            `the old non-id label is renamed too (got ${renamedOldName?.label})`
        );
        const edited = await ModelCatalogEntryRow.findByPk('gemini-4-argon');
        expect(edited?.label === '我的自定义名字', 'an edited label is never overwritten');
        // Runs once: a second pass leaves a new old-style label alone
        await ModelCatalogEntryRow.update({ label: 'gpt-6-sol' }, { where: { id: 'gpt-6-sol' } });
        await backfillCatalogLabels();
        const kept = await ModelCatalogEntryRow.findByPk('gpt-6-sol');
        expect(kept?.label === 'gpt-6-sol', 'the backfill runs exactly once');
    })
);

results.push(
    await runCase('a fresh database seeds from the built-in rows and loads the registry', async () => {
        await service.loadModelPrices();
        const version = pricing.priceTableVersion();
        expect(version.startsWith('p'), `table version is a database version (${version})`);
        const rows = await ModelPriceEntry.count();
        expect(rows > 0, `rows were seeded (${rows})`);
        const hydrogen = pricing.findPriceAt('gemini-4-hydrogen', at('2026-11-13T00:00:00Z'));
        expect(hydrogen?.inputPerM === 1.5 && hydrogen.outputPerM === 7.5, 'hydrogen uses the standard price');
        expect(hydrogen?.cachedInputPerM === 0.075, 'hydrogen cache-hit price');
        expect(hydrogen?.priority?.inputPerM === 2.7 && hydrogen?.priority.outputPerM === 13.5, 'hydrogen priority price');
        const sonnet = pricing.findPriceAt('claude-sonnet-5-5', at('2026-11-13T00:00:00Z'));
        expect(sonnet?.cachedInputPerM === 0.1, 'sonnet-5-5 cache-hit price is half of sonnet-5');
        expect(pricing.findPriceAt('no-such-model', at('2026-11-13T00:00:00Z')) === null, 'unknown ids stay unpriced');
    })
);

results.push(
    await runCase('scheduled windows switch on time without a release', async () => {
        const beforeArgon = pricing.findPriceAt('gemini-4-argon', at('2026-11-30T12:00:00Z'));
        expect(beforeArgon?.inputPerM === 2 && beforeArgon.outputPerM === 10, 'argon promo before 12-01');
        const afterArgon = pricing.findPriceAt('gemini-4-argon', at('2026-12-01T00:00:00Z'));
        expect(afterArgon?.inputPerM === 4 && afterArgon.outputPerM === 20, 'argon doubles on 12-01');
        expect(afterArgon?.priority?.inputPerM === 7.2 && afterArgon?.priority.outputPerM === 36, 'argon priority doubles too');
        const afterFlash = pricing.findPriceAt('gemini-3.8-flash', at('2027-01-01T00:00:00Z'));
        expect(afterFlash?.inputPerM === 1.5 && afterFlash.outputPerM === 7.5, '3.8-flash doubles on 2027-01-01');
    })
);

results.push(
    await runCase('the registry exposes the window boundaries inside a range', async () => {
        const instants = pricing
            .priceChangeInstants(at('2026-11-01T00:00:00Z'), at('2027-02-01T00:00:00Z'))
            .map((instant) => instant.toISOString());
        expect(instants.includes('2026-12-01T00:00:00.000Z'), 'argon/carbon boundary is inside');
        expect(instants.includes('2027-01-01T00:00:00.000Z'), '3.8-flash boundary is inside');
        expect(pricing.priceChangeInstants(at('2026-12-02T00:00:00Z'), at('2026-12-03T00:00:00Z')).length === 0, 'no boundary in a quiet range');
    })
);

results.push(
    await runCase('a proposal is deduped and applying it writes the row, audits and reloads', async () => {
        const draft = {
            kind: 'update' as const,
            model: 'gemini-4-hydrogen',
            tier: 'standard' as const,
            entry: entry({ model: 'gemini-4-hydrogen' }),
            baseline: null,
            note: 'test proposal',
        };
        expect((await service.createOrRefreshProposals([draft], null)) === 1, 'one pending proposal');
        expect((await service.createOrRefreshProposals([draft], null)) === 1, 'the same proposal is deduped');
        const pending = await service.listPendingProposals();
        const target = pending.find((proposal) => proposal.model === 'gemini-4-hydrogen');
        expect(target !== undefined, 'it is listed as pending');
        if (target === undefined) return;
        const versionBefore = pricing.priceTableVersion();
        const applied = await service.applyProposals([target.id], 4242);
        expect(applied.applied === 1 && applied.skipped === 0, 'the proposal was applied');
        expect(pricing.priceTableVersion() !== versionBefore, 'the table version moved');
        const audits = await SettingsAudit.findAll({ where: { scope: 'pricing' } });
        expect(audits.length >= 1, `the write is audited (${audits.length})`);
        expect(audits[0]?.actorId === 4242, 'the actor is the owner who approved it');
        const again = await service.applyProposals([target.id], 4242);
        expect(again.applied === 0 && again.skipped === 1, 'a second click is a no-op');
    })
);

results.push(
    await runCase('a future window closes the open row and leaves no hole', async () => {
        const draft = {
            kind: 'update' as const,
            model: 'deepseek-flash',
            tier: 'standard' as const,
            entry: entry({
                model: 'deepseek-flash',
                inputPerM: 0.4,
                cachedInputPerM: 0.008,
                outputPerM: 1.6,
                effectiveFrom: at('2026-12-15T00:00:00Z'),
            }),
            baseline: null,
            note: 'future price',
        };
        await service.createOrRefreshProposals([draft], null);
        const target = (await service.listPendingProposals()).find((proposal) => proposal.model === 'deepseek-flash');
        expect(target !== undefined, 'the future window is proposed');
        if (target === undefined) return;
        await service.applyProposals([target.id], 4242);
        expect(pricing.findPriceAt('deepseek-flash', at('2026-12-14T00:00:00Z'))?.inputPerM === 0.3, 'old price before the window');
        expect(pricing.findPriceAt('deepseek-flash', at('2026-12-16T00:00:00Z'))?.inputPerM === 0.4, 'new price inside the window');
        const rows = (
            await ModelPriceEntry.findAll({ where: { model: 'deepseek-flash', tier: 'standard' } })
        ).sort((first, second) => first.effectiveFrom.getTime() - second.effectiveFrom.getTime());
        expect(rows.length >= 2, `the table split into windows (${rows.length})`);
        for (const [index, row] of rows.slice(0, -1).entries()) {
            const next = rows[index + 1];
            expect(
                row.effectiveTo !== null && next !== undefined && row.effectiveTo.getTime() === next.effectiveFrom.getTime(),
                `window ${index} ends where the next begins`
            );
        }
    })
);

results.push(
    await runCase('rejecting a proposal leaves the table and its prices alone', async () => {
        const draft = {
            kind: 'update' as const,
            model: 'gpt-6-luna',
            tier: 'standard' as const,
            entry: entry({ model: 'gpt-6-luna', inputPerM: 9, outputPerM: 9 }),
            baseline: null,
            note: 'should be rejected',
        };
        await service.createOrRefreshProposals([draft], null);
        const target = (await service.listPendingProposals()).find((proposal) => proposal.model === 'gpt-6-luna');
        expect(target !== undefined, 'the proposal is pending');
        if (target === undefined) return;
        const rejected = await service.rejectProposals([target.id], 4242);
        expect(rejected === 1, 'it was rejected');
        expect(pricing.findPriceAt('gpt-6-luna', at('2026-11-13T00:00:00Z'))?.inputPerM === 0.1, 'the price did not change');
        const row = await PriceChangeProposal.findByPk(target.id);
        expect(row?.status === 'rejected' && row.decidedBy === 4242, 'the row records the decision');
    })
);

results.push(
    await runCase('stale proposals expire instead of staying actionable', async () => {
        const draft = {
            kind: 'update' as const,
            model: 'mimo-v2.6-flash',
            tier: 'standard' as const,
            entry: entry({ model: 'mimo-v2.6-flash', inputPerM: 5 }),
            baseline: null,
            note: 'old proposal',
        };
        await service.createOrRefreshProposals([draft], null);
        const target = (await service.listPendingProposals()).find((proposal) => proposal.model === 'mimo-v2.6-flash');
        expect(target !== undefined, 'the proposal is pending first');
        if (target === undefined) return;
        await PriceChangeProposal.update(
            { detectedAt: new Date('2026-10-01T00:00:00Z') },
            { where: { id: target.id } }
        );
        const expired = await service.expireStaleProposals(at('2026-11-13T00:00:00Z'));
        expect(expired >= 1, `the stale proposal expired (${expired})`);
        const row = await PriceChangeProposal.findByPk(target.id);
        expect(row?.status === 'expired', 'the row is expired, not pending');
    })
);

results.push(
    await runCase('the panel metadata reads the table, the sources and the next changes', async () => {
        const now = at('2026-11-13T00:00:00Z');
        const meta = await service.loadPriceTableMeta(now);
        expect(meta.version === pricing.priceTableVersion(), 'version matches the registry');
        expect(meta.checkedOn !== null, 'the oldest checkedOn is reported');
        expect(meta.sources.some((source) => source.kind === 'manual'), 'the seeded source is listed');
        expect(
            meta.nextChanges.some((change) => change.model === 'gemini-4-argon' && change.at.startsWith('2026-12-01')),
            'the argon change is in the next 30 days'
        );
        expect(Array.isArray(meta.unpricedModels), 'unpriced models is a list');
        const status = await service.priceWatchStatus();
        expect(status.version === pricing.priceTableVersion(), 'status carries the version');
        expect(status.pendingProposals === 0, 'nothing is pending after the cases above');
    })
);

reportResults(results);
