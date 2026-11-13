/**
 * Offline cases for the auto-add rule of the model catalog: a newer generation
 * of a family the menu already offers enters as a whole (however long ago it
 * shipped); inside the menu's generation only a newer minor of an offered
 * product line, or a brand-new line released in the last week. Old versions,
 * retired aliases, variants, artifacts and non-chat entries never do, and one
 * run adds at most five.
 *
 * Run: npx tsx scripts/offline/price-discovery.mts
 */
import { setupOfflineDb, expect, reportResults, runCase, type CaseResult } from './harness.mts';

await setupOfflineDb();
const { discoveredModelsOf } = await import('../../src/services/price-watch-service.js');
const { seedModelCatalogEntries, setModelCatalog } = await import('../../src/config/model-catalog.js');
const { catalogModelRefs } = await import('../../src/services/price-catalog-fetch.js');

const DAY_MS = 24 * 60 * 60 * 1000;
const recent = new Date(Date.now() - 2 * DAY_MS).toISOString().slice(0, 10);
const older = new Date(Date.now() - 27 * DAY_MS).toISOString().slice(0, 10);
const ancient = new Date('2024-05-13T00:00:00Z').toISOString().slice(0, 10);

interface ModelOverrides {
    readonly release_date?: string | null;
    readonly modalities?: { readonly input: readonly string[]; readonly output: readonly string[] };
    readonly cost?: { readonly input?: number; readonly output?: number };
}

const model = (id: string, over: ModelOverrides = {}): Record<string, unknown> => ({
    id,
    name: id,
    release_date: over.release_date === null ? undefined : over.release_date ?? recent,
    modalities: over.modalities ?? { input: ['text'], output: ['text'] },
    tool_call: true,
    cost: over.cost ?? { input: 1, output: 2 },
});

const catalogOf = (models: readonly Record<string, unknown>[]): string =>
    JSON.stringify({
        openai: { models: Object.fromEntries(models.map((entry) => [String(entry.id), entry])) },
    });

const idsOf = (body: string): readonly string[] => discoveredModelsOf(body, new Date()).map((item) => item.entry.id);
const results: CaseResult[] = [];

results.push(
    await runCase('a newer minor of a menu family is discovered', async () => {
        const ids = idsOf(catalogOf([model('gpt-6.1-sol')]));
        expect(ids.length === 1 && ids[0] === 'gpt-6.1-sol', `the newer minor is added (got ${ids.join(', ')})`);
        const carried = discoveredModelsOf(catalogOf([model('gpt-6.1-sol')]), new Date())[0];
        expect(carried?.entry.platform === 'openai', 'the platform is recorded for later metadata work');
        expect(carried?.entry.catalogKey === 'openai/gpt-6.1-sol', 'the catalog key is recorded');
    })
);

results.push(
    await runCase('an older version of a menu family never enters, however recent its date', async () => {
        // A recent release_date must not rescue an older version: the first run
        // added gpt-4o / gpt-5.2 exactly this way.
        const ids = idsOf(
            catalogOf([model('gpt-5.2'), model('gpt-4o'), model('gpt-5.6'), model('gemini-3.7-flash')])
        );
        expect(ids.length === 0, `older versions are skipped (got ${ids.join(', ')})`);
    })
);

results.push(
    await runCase('a newer minor enters however long ago it shipped', async () => {
        // gpt-6.1-sol shipped 45 days before the watcher first ran; the version
        // compare decides for a family the menu serves, not the release date.
        const ids = idsOf(catalogOf([model('gpt-6.1-sol', { release_date: older })]));
        expect(ids.length === 1 && ids[0] === 'gpt-6.1-sol', `the newer minor enters (got ${ids.join(', ')})`);
        const veryOld = idsOf(catalogOf([model('gpt-6.1-sol', { release_date: ancient })]));
        expect(veryOld.length === 1, 'the age is irrelevant once the version is newer');
    })
);

results.push(
    await runCase('an undated entry is not a new model', async () => {
        const undated = idsOf(catalogOf([model('gpt-6.1-terra', { release_date: null })]));
        expect(undated.length === 0, 'an undated entry is not a new model');
        const dated = idsOf(catalogOf([model('gpt-5.2', { release_date: ancient })]));
        expect(dated.length === 0, 'an old version never enters, whatever its date says');
    })
);

results.push(
    await runCase('a new family line qualifies only while it is fresh', async () => {
        // claude-fable-5-2 is not in the menu; it was added manually in production
        const fresh = idsOf(
            JSON.stringify({
                anthropic: { models: { 'claude-fable-5-2': model('claude-fable-5-2') } },
            })
        );
        expect(fresh.length === 1, `a fresh line is added (got ${fresh.join(', ')})`);
        // deepseek-v4-flash is a retired alias of a family with no numeric menu
        // version; a 27-day-old release must not come back
        const stale = idsOf(
            JSON.stringify({
                deepseek: { models: { 'deepseek-v4-flash': model('deepseek-v4-flash', { release_date: older }) } },
            })
        );
        expect(stale.length === 0, `a stale alias is skipped (got ${stale.join(', ')})`);
    })
);

results.push(
    await runCase('variants, artifacts, image models and unknown families are skipped', async () => {
        const ids = idsOf(
            catalogOf([
                model('gpt-6.1-sol-preview'),
                model('gpt-6.1-sol-thinking'),
                model('gpt-6.1-image', { modalities: { input: ['text'], output: ['text', 'image'] } }),
                model('llama-4-70b'),
            ]).replace('"openai":{"models":', '"openai":{"models":')
        );
        expect(ids.length === 0, `only plain chat releases qualify (got ${ids.join(', ')})`);
        const artifact = idsOf(
            JSON.stringify({ openai: { models: { 'gpt-6.1-sol@default': model('gpt-6.1-sol@default') } } })
        );
        expect(artifact.length === 0, 'a routing artifact is not a model id');
    })
);

results.push(
    await runCase('one run adds at most five models', async () => {
        const models = Array.from({ length: 8 }, (_, index) => model(`gpt-6.2-variant${index}`));
        const ids = idsOf(catalogOf(models));
        expect(ids.length === 5, `the cap holds (got ${ids.length})`);
    })
);

results.push(
    await runCase('a newer minor of an offered product line enters while its sibling generation is in the menu', async () => {
        // Production state after the first auto-add: gpt-6.1-terra already made
        // the gpt family 6.1, so comparing only family versions would never let
        // gpt-6.1-sol in (it is newer only than its own line, gpt-6-sol).
        const seed = seedModelCatalogEntries();
        const template = seed.find((entry) => entry.id === 'gpt-6-sol');
        if (template === undefined) throw new Error('the seed menu lost gpt-6-sol');
        setModelCatalog([...seed, { ...template, id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' }]);
        const lineUpgrade = idsOf(catalogOf([model('gpt-6.1-sol', { release_date: older })]));
        expect(
            lineUpgrade.length === 1 && lineUpgrade[0] === 'gpt-6.1-sol',
            `the line upgrade enters (got ${lineUpgrade.join(', ')})`
        );
        const unknownLine = idsOf(catalogOf([model('gpt-6.1-nova', { release_date: older })]));
        expect(
            unknownLine.length === 0,
            `an unknown line of the same generation still needs a fresh release (got ${unknownLine.join(', ')})`
        );
        const freshLine = idsOf(catalogOf([model('gpt-6.1-nova')]));
        expect(freshLine.length === 1, `a brand-new line enters while fresh (got ${freshLine.join(', ')})`);
        setModelCatalog([]);
    })
);

results.push(
    await runCase('a model the watcher added is tracked like a shipped one', async () => {
        const seed = seedModelCatalogEntries();
        const template = seed.find((entry) => entry.id === 'gpt-6-sol');
        if (template === undefined) throw new Error('the seed menu lost gpt-6-sol');
        setModelCatalog([
            ...seed,
            // What an auto-added row looks like: the catalog key of its source
            { ...template, id: 'gpt-6.1-sol', catalogKey: 'openai/gpt-6.1-sol' },
            // A manually added row has no source page and cannot be tracked
            { ...template, id: 'some-manual-model' },
        ]);
        const refs = catalogModelRefs();
        const added = refs.find((ref) => ref.model === 'gpt-6.1-sol');
        expect(
            added?.provider === 'openai' && added.modelFile === 'gpt-6.1-sol',
            `the auto-added model gets a models.dev ref (got ${JSON.stringify(added)})`
        );
        expect(!refs.some((ref) => ref.model === 'some-manual-model'), 'a row without a catalog key is not tracked');
        expect(refs.filter((ref) => ref.model === 'gpt-6-sol').length === 1, 'a shipped ref is not duplicated');
        setModelCatalog([]);
    })
);

reportResults(results);
