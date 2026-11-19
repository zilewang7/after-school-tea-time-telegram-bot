/**
 * Offline cases for the menu's Gemini 4 swap (2026-11-19): gemini-4-neon
 * replaces gemini-4-argon in the menu, its code seeds (capabilities and flat
 * prices), the fresh-database guard of the one-off migration, the upgrade of an
 * existing database (argon menu row out, neon row and its two price rows in,
 * recorded in schema_migrations) and the no-op of a recorded migration.
 *
 * Argon keeps its capability seed and its price rows for replies made before
 * the switch; only its `model_catalog` row is removed.
 *
 * Run: pnpm test:offline neon-model-swap
 */
import { setupOfflineDb, expect, reportResults, runCase, type CaseResult } from './harness.mts';

await setupOfflineDb();
const { QueryTypes } = await import('@sequelize/core');
const { sequelize } = await import('../../src/db/config.js');
const { ModelCatalogEntryRow } = await import('../../src/db/modelCatalogDTO.js');
const { ModelPriceEntry } = await import('../../src/db/modelPriceDTO.js');
const { backfillNeonMenuSwap } = await import('../../src/db/schema-migrations.js');
const { modelConfigs } = await import('../../src/config/models.js');
const { capabilitySeedOf } = await import('../../src/config/model-capability-seed.js');
const { findPriceAt, seedPriceEntries, setPriceEntries } = await import('../../src/config/model-pricing.js');
const { listModelCatalog, setModelCatalog } = await import('../../src/config/model-catalog.js');
const catalogService = await import('../../src/services/model-catalog-service.js');
const priceService = await import('../../src/services/model-price-service.js');

type ModelCatalogCapabilities = import('../../src/config/model-capabilities.js').ModelCatalogCapabilities;

const MIGRATION_NAME = '20261119_neon_menu_swap';
const GEMINI_PRICING_URL = 'https://cloud.google.com/vertex-ai/generative-ai/pricing';
const FROM_THE_START = '1970-01-01T00:00:00.000Z';
const AT_GA = new Date('2026-11-19T00:00:00Z');

const NEON_STANDARD = { inputPerM: 3, cachedInputPerM: 0.15, outputPerM: 15 };
const NEON_PRIORITY = { inputPerM: 5.4, cachedInputPerM: 0.27, outputPerM: 27 };

const json = (value: unknown): string => JSON.stringify(value);

/** How many rows the one-off migration is recorded as */
const migrationRows = async (): Promise<number> => {
    const rows = await sequelize.query<{ count: number }>(
        'SELECT COUNT(*) AS count FROM schema_migrations WHERE name = :name',
        { type: QueryTypes.SELECT, replacements: { name: MIGRATION_NAME } }
    );
    return rows[0]?.count ?? 0;
};

const dropMigrationRecord = async (): Promise<void> => {
    await sequelize.query('DELETE FROM schema_migrations WHERE name = :name', {
        replacements: { name: MIGRATION_NAME },
    });
};

const neonCapabilities = (): ModelCatalogCapabilities => {
    const capabilities = capabilitySeedOf('gemini-4-neon');
    if (capabilities === null) throw new Error('the code seed has no gemini-4-neon');
    return capabilities;
};

const argonCapabilities = (): ModelCatalogCapabilities => {
    const capabilities = capabilitySeedOf('gemini-4-argon');
    if (capabilities === null) throw new Error('the history seed lost gemini-4-argon');
    return capabilities;
};

const neonPriceRows = () =>
    ModelPriceEntry.findAll({ where: { model: 'gemini-4-neon' }, order: [['tier', 'ASC']] });

const results: CaseResult[] = [];

results.push(
    await runCase('the menu seed carries Neon in Argon\'s slot and Neon is priced flat', async () => {
        const ids = modelConfigs.map((model) => model.id);
        expect(modelConfigs.length === 13, `still 13 menu models (got ${modelConfigs.length})`);
        expect(ids.includes('gemini-4-neon'), 'the menu offers gemini-4-neon');
        expect(!ids.includes('gemini-4-argon'), 'the menu no longer offers gemini-4-argon');
        const hydrogen = ids.indexOf('gemini-4-hydrogen');
        const neon = ids.indexOf('gemini-4-neon');
        const carbon = ids.indexOf('gemini-4-carbon');
        expect(neon === hydrogen + 1, `Neon keeps Argon's slot after Hydrogen (got ${neon})`);
        expect(carbon === neon + 1, `Carbon stays after Neon (got ${carbon})`);
        expect(
            modelConfigs.find((model) => model.id === 'gemini-4-neon')?.name === 'Gemini 4 Neon',
            'the button label is the display name'
        );

        const capabilities = neonCapabilities();
        expect(capabilities.kind === 'chat' && capabilities.vision && capabilities.tools, 'chat, vision and tools');
        expect(json(capabilities.reasoning?.efforts) === '["low","medium","high","xhigh"]', 'the four efforts, xhigh included');
        expect(capabilities.reasoning?.defaultEffort === 'high', 'the vendor default is HIGH');
        expect(capabilities.contextTokens === 1_048_576, 'the context limit');
        expect(capabilities.outputTokens === 65_536, 'the output limit');
        expect(json(capabilities.modalities?.input) === '["text","image","audio","video","pdf"]', 'the Gemini modalities');
        expect(capabilities.toolsMixing === 'allowed', 'mixed Gemini tools are allowed');
        expect(capabilities.checkedOn === '2026-11-19', `the capability check date (got ${String(capabilities.checkedOn)})`);
        expect(
            capabilities.reasoning?.checkedOn === '2026-11-19',
            `the reasoning check date (got ${String(capabilities.reasoning?.checkedOn)})`
        );
        expect(capabilities.reasoning?.source === 'code', 'the capability provenance stays the code seed');

        // The history seed keeps answering for argon (replies before the switch)
        expect(argonCapabilities().kind === 'chat', 'argon still has a capability seed for history');

        const neonSeedPrices = seedPriceEntries().filter((entry) => entry.model === 'gemini-4-neon');
        expect(neonSeedPrices.length === 2, `one standard and one priority row (got ${neonSeedPrices.length})`);
        for (const tier of ['standard', 'priority'] as const) {
            const windows = neonSeedPrices.filter((entry) => entry.tier === tier);
            expect(windows.length === 1, `${tier}: one flat window, no promotion boundary (got ${windows.length})`);
            const row = windows[0];
            if (row === undefined) throw new Error(`no neon ${tier} seed row`);
            expect(
                row.effectiveFrom.toISOString() === FROM_THE_START && row.effectiveTo === undefined,
                `${tier}: open-ended from the start of time`
            );
            expect(row.source === 'manual' && row.sourceUrl === GEMINI_PRICING_URL, `${tier}: the Vertex page is the source`);
            expect(row.checkedOn === '2026-11-19' && row.confidence === 'high', `${tier}: checked on GA, high confidence`);
            expect(row.cacheWritePerM === undefined && row.imageOutputPerM === undefined && row.perImageUsd === undefined, `${tier}: no extra prices`);
        }
        const standard = neonSeedPrices.find((entry) => entry.tier === 'standard');
        expect(json({ inputPerM: standard?.inputPerM, cachedInputPerM: standard?.cachedInputPerM, outputPerM: standard?.outputPerM }) === json(NEON_STANDARD), 'the standard price is 3 / 0.15 / 15');
        const priority = neonSeedPrices.find((entry) => entry.tier === 'priority');
        expect(json({ inputPerM: priority?.inputPerM, cachedInputPerM: priority?.cachedInputPerM, outputPerM: priority?.outputPerM }) === json(NEON_PRIORITY), 'the priority price is 5.4 / 0.27 / 27');
    })
);

results.push(
    await runCase('a fresh database is left to the code seeds: nothing inserted, nothing recorded', async () => {
        await ModelCatalogEntryRow.destroy({ where: {} });
        await dropMigrationRecord();
        await backfillNeonMenuSwap();
        expect((await ModelCatalogEntryRow.count()) === 0, 'the empty catalog stays empty');
        expect((await migrationRows()) === 0, 'the migration is not recorded for a fresh database');

        // The startup loaders then seed the menu and the price table from code
        await catalogService.loadModelCatalog();
        await priceService.loadModelPrices();
        const neon = await ModelCatalogEntryRow.findByPk('gemini-4-neon');
        expect(neon !== null, 'loadModelCatalog() seeds the neon row');
        expect(neon?.enabled === 1 && neon.label === 'Gemini 4 Neon', 'enabled and labelled like the menu');
        expect(neon?.platform === 'gemini' && neon.source === 'manual', 'platform and source from the seed');
        expect(
            neon?.checkedOn === '2026-11-19' && neon.confidence === 'high',
            "the row-level provenance is the seed's own check date (Neon's launch day), not the 2026-11-13 snapshot"
        );
        expect(neon?.capabilities === json(neonCapabilities()), 'the seeded capabilities equal the code seed');
        expect((await ModelCatalogEntryRow.findByPk('gemini-4-argon')) === null, 'the fresh seed has no argon row');
        expect((await ModelCatalogEntryRow.count()) === 13, 'a fresh database seeds the whole menu');

        const price = findPriceAt('gemini-4-neon', AT_GA);
        expect(
            json({ inputPerM: price?.inputPerM, cachedInputPerM: price?.cachedInputPerM, outputPerM: price?.outputPerM }) ===
                json(NEON_STANDARD),
            `loadModelPrices() seeds the neon standard row (got ${json(price)})`
        );
        expect(json(price?.priority) === json(NEON_PRIORITY), 'the seeded priority tier is visible');
        expect((await migrationRows()) === 0, 'the code-seed path still records no migration');
    })
);

results.push(
    await runCase('an existing database swaps Argon for Neon, adds the two prices and records the migration once', async () => {
        await catalogService.loadModelCatalog();
        await priceService.loadModelPrices();
        // Simulate a pre-swap production database: an argon menu row, no neon row
        await ModelCatalogEntryRow.destroy({ where: { id: 'gemini-4-neon' } });
        await ModelCatalogEntryRow.create({
            id: 'gemini-4-argon',
            label: 'Gemini 4 Argon',
            enabled: 1,
            capabilities: json(argonCapabilities()),
            platform: 'gemini',
            catalogKey: null,
            source: 'manual',
            sourceUrl: null,
            checkedOn: '2026-11-13',
            confidence: 'high',
            note: null,
        });
        await ModelPriceEntry.destroy({ where: { model: 'gemini-4-neon' } });
        await dropMigrationRecord();
        await catalogService.loadModelCatalog();
        await priceService.loadModelPrices();
        expect(!listModelCatalog().some((entry) => entry.id === 'gemini-4-neon'), 'pre-swap: neon is not in the menu');
        expect(listModelCatalog().some((entry) => entry.id === 'gemini-4-argon'), 'pre-swap: argon is in the menu');
        expect(findPriceAt('gemini-4-neon', AT_GA) === null, 'pre-swap: neon has no price');

        await backfillNeonMenuSwap();

        const neon = await ModelCatalogEntryRow.findByPk('gemini-4-neon');
        expect(neon !== null, 'the migration inserts the neon row');
        expect(neon?.enabled === 1, 'the row is enabled');
        expect(neon?.label === 'Gemini 4 Neon', `the label is the display name (got ${String(neon?.label)})`);
        expect(neon?.capabilities === json(neonCapabilities()), 'the capabilities JSON is exactly the code seed');
        expect(neon?.platform === 'gemini' && neon.catalogKey === null, 'platform gemini, no catalog key');
        expect(neon?.source === 'manual' && neon.sourceUrl === null, 'manual source, no URL');
        expect(neon?.checkedOn === '2026-11-19' && neon.confidence === 'high', 'the row says when the swap was checked');
        expect((await ModelCatalogEntryRow.findByPk('gemini-4-argon')) === null, 'the argon menu row is deleted');

        const prices = await neonPriceRows();
        expect(prices.length === 2, `exactly the standard and priority rows (got ${prices.length})`);
        for (const expectation of [
            { tier: 'standard', values: NEON_STANDARD },
            { tier: 'priority', values: NEON_PRIORITY },
        ]) {
            const row = prices.find((candidate) => candidate.tier === expectation.tier);
            if (row === undefined) throw new Error(`no ${expectation.tier} neon price row`);
            expect(row.inputPerM === expectation.values.inputPerM && row.cachedInputPerM === expectation.values.cachedInputPerM && row.outputPerM === expectation.values.outputPerM, `${row.tier}: the shipped values`);
            expect(row.cacheWritePerM === null && row.imageOutputPerM === null && row.perImageUsd === null, `${row.tier}: no extra prices`);
            expect(row.effectiveFrom.toISOString() === FROM_THE_START && row.effectiveTo === null, `${row.tier}: open-ended from epoch`);
            expect(row.source === 'manual' && row.sourceUrl === GEMINI_PRICING_URL, `${row.tier}: the manual Vertex source`);
            expect(row.checkedOn === '2026-11-19' && row.confidence === 'high', `${row.tier}: checked on GA`);
        }
        expect((await migrationRows()) === 1, 'the migration is recorded exactly once');

        // Both loaders serve the swapped data
        await catalogService.loadModelCatalog();
        await priceService.loadModelPrices();
        expect(listModelCatalog().some((entry) => entry.id === 'gemini-4-neon'), 'the menu lists neon after the reload');
        const price = findPriceAt('gemini-4-neon', AT_GA);
        expect(
            json({ inputPerM: price?.inputPerM, cachedInputPerM: price?.cachedInputPerM, outputPerM: price?.outputPerM }) ===
                json(NEON_STANDARD) && json(price?.priority) === json(NEON_PRIORITY),
            `the registry serves the swapped price (got ${json(price)})`
        );

        // A second run changes nothing: no duplicates, no resurrected argon
        const catalogCount = await ModelCatalogEntryRow.count();
        const priceCount = await ModelPriceEntry.count();
        await backfillNeonMenuSwap();
        expect((await ModelCatalogEntryRow.count()) === catalogCount, 'no catalog row added or removed twice');
        expect((await ModelPriceEntry.count()) === priceCount, 'no duplicate price rows');
        expect((await neonPriceRows()).length === 2, 'still exactly two neon price rows');
        expect((await migrationRows()) === 1, 'still exactly one migration record');
        expect((await ModelCatalogEntryRow.findByPk('gemini-4-argon')) === null, 'argon does not come back');
    })
);

results.push(
    await runCase('once recorded, the migration never revisits an edited row', async () => {
        expect((await migrationRows()) === 1, 'the previous case left the migration recorded');
        await ModelCatalogEntryRow.update(
            { label: 'Owner Edited Neon' },
            { where: { id: 'gemini-4-neon' } }
        );
        await ModelCatalogEntryRow.update(
            { capabilities: JSON.stringify({ schema: 1, kind: 'chat', contextTokens: 1 }) },
            { where: { id: 'gemini-4-neon' } }
        );
        await backfillNeonMenuSwap();
        const neon = await ModelCatalogEntryRow.findByPk('gemini-4-neon');
        expect(neon?.label === 'Owner Edited Neon', 'the owner-edited label is not overwritten');
        expect(neon?.capabilities === JSON.stringify({ schema: 1, kind: 'chat', contextTokens: 1 }), 'the edited capabilities stay');
        expect((await migrationRows()) === 1, 'the migration stays recorded once');
        expect((await neonPriceRows()).length === 2, 'the price rows are untouched too');
    })
);

// Back to the code seeds for the in-memory registries; the rows above belong to
// this file's scratch database, which the harness removes when the file ends.
await ModelCatalogEntryRow.destroy({ where: {} });
await ModelPriceEntry.destroy({ where: { model: 'gemini-4-neon' } });
await dropMigrationRecord();
setModelCatalog([]);
setPriceEntries([]);

reportResults(results);
