/**
 * Offline cases for model traits and the data-vs-code shadow (thinking-effort
 * design 2026-1113-1742 §3.1): the resolution chain catalog → code seed → code
 * heuristics, the three predicates PR2 compares, the historical/unknown
 * fallbacks, the legacy/placeholder/schema-2 rows the loader turns into code
 * fallbacks, and the shadow diff dedupe/reset.
 *
 * PR2 must not change behavior: every predicate still returns the code result;
 * only when MODEL_TRAITS_SHADOW=1 does the data result get compared and logged.
 *
 * Run: pnpm test:offline model-traits
 */
import { setupOfflineDb, expect, reportResults, runCase, type CaseResult } from './harness.mts';

type ModelCatalogEntry = import('../../src/config/model-catalog.js').ModelCatalogEntry;
type ModelEffort = import('../../src/config/model-capabilities.js').ModelEffort;

await setupOfflineDb();
const { sequelize } = await import('../../src/db/config.js');
const { ModelCatalogEntryRow } = await import('../../src/db/modelCatalogDTO.js');
const { setModelCatalog, seedModelCatalogEntries } = await import('../../src/config/model-catalog.js');
const { capabilitySeedIds } = await import('../../src/config/model-capability-seed.js');
const catalogService = await import('../../src/services/model-catalog-service.js');
const {
    isImageOutputModel,
    supportsGeminiFunctionTools,
    supportsGeminiImageSearchGrounding,
    supportsXhighThinkingLevel,
} = await import('../../src/ai/model-kinds.js');
const {
    codeTraitValuesOf,
    dataTraitValuesOf,
    resolveModelTraits,
    resetTraitsShadow,
    traitsShadowDiffs,
} = await import('../../src/ai/model-traits.js');

const results: CaseResult[] = [];

/** [imageOutput, xhighThinking, geminiFunctionTools] as today's code returns them */
const TODAY: Readonly<Record<string, readonly [boolean, boolean, boolean]>> = {
    'gpt-6-luna': [false, false, true],
    'gpt-6-sol': [false, false, true],
    'gpt-6-astra': [false, false, true],
    'claude-sonnet-5-5': [false, false, true],
    'claude-opus-5-5': [false, false, true],
    'gemini-4-hydrogen': [false, true, true],
    'gemini-4-argon': [false, false, true],
    'gemini-4-carbon': [false, false, true],
    'gemini-3.8-flash': [false, false, true],
    'gemini-nano-banana-2.1': [true, false, false],
    'deepseek-flash': [false, false, true],
    'grok-4.7': [false, false, true],
    'grok-4.20-multi-agent-0309': [false, false, true],
    'mimo-v2.6-flash': [false, false, true],
    'mimo-v2.6-pro': [false, false, true],
    'gpt-image-2.5-dev': [true, false, false],
};

const valuesOf = (model: string): readonly [boolean, boolean, boolean] => [
    isImageOutputModel(model),
    supportsXhighThinkingLevel(model),
    supportsGeminiFunctionTools(model),
];

const sameValues = (model: string, expected: readonly [boolean, boolean, boolean]): boolean =>
    JSON.stringify(valuesOf(model)) === JSON.stringify(expected);

const createdRowIds: string[] = [];
const createRow = async (id: string, capabilities: string): Promise<void> => {
    await ModelCatalogEntryRow.create({
        id,
        label: id,
        enabled: 1,
        capabilities,
        platform: 'openai',
        source: 'models-dev',
        sourceUrl: null,
        checkedOn: '2026-11-13',
        confidence: 'medium',
        note: 'auto-added by the price watcher',
    });
    createdRowIds.push(id);
};

const dropCreatedRows = async (): Promise<void> => {
    for (const id of createdRowIds.splice(0)) {
        await ModelCatalogEntryRow.destroy({ where: { id } });
    }
    setModelCatalog([]);
};

results.push(
    await runCase('the menu models still answer exactly like the code heuristics', async () => {
        await catalogService.loadModelCatalog();
        expect(capabilitySeedIds().length === 16, 'the seed covers the 16 snapshot ids');
        for (const id of capabilitySeedIds()) {
            const expected = TODAY[id];
            if (expected === undefined) throw new Error(`no golden row for ${id}`);
            expect(sameValues(id, expected), `${id}: ${JSON.stringify(valuesOf(id))} == ${JSON.stringify(expected)}`);
            expect(
                JSON.stringify(codeTraitValuesOf(id)) ===
                    JSON.stringify({
                        imageOutput: expected[0],
                        xhighThinking: expected[1],
                        geminiFunctionTools: expected[2],
                    }),
                `${id}: codeTraitValuesOf matches the predicate trio`
            );
        }
    })
);

results.push(
    await runCase('historical and unknown ids keep the old heuristics', async () => {
        const historical: Readonly<Record<string, readonly [boolean, boolean, boolean]>> = {
            'gemini-2.5-flash': [false, false, false],
            'gemini-2.5-pro': [false, false, false],
            'gemini-2.5-flash-lite': [false, false, false],
            'gemini-3-pro-image': [true, false, false],
            'gemini-3.1-flash-image': [true, false, false],
            'gpt-4o': [false, false, true],
            'some-random-model': [false, false, true],
            'another-image-model': [true, false, false],
        };
        for (const [id, expected] of Object.entries(historical)) {
            expect(sameValues(id, expected), `${id}: ${JSON.stringify(valuesOf(id))} == ${JSON.stringify(expected)}`);
            expect(resolveModelTraits(id).origin === 'code', `${id}: code origin`);
            expect(resolveModelTraits(id).capabilities === null, `${id}: no capabilities`);
        }
        expect(resolveModelTraits('some-random-model').platform === 'openai', 'unknown ids route to openai');
        expect(supportsGeminiImageSearchGrounding('gemini-nano-banana-2.1'), 'nano-banana can ground on images');
        expect(supportsGeminiImageSearchGrounding('gemini-3-pro-image') === false, 'gemini-3-pro-image cannot');
    })
);

results.push(
    await runCase('the resolution chain is catalog → seed → code', async () => {
        await catalogService.loadModelCatalog();
        const hydrogen = resolveModelTraits('gemini-4-hydrogen');
        expect(hydrogen.origin === 'catalog', `a menu row resolves from the catalog (got ${hydrogen.origin})`);
        expect(hydrogen.platform === 'gemini', 'the platform comes from the prefix routing');
        expect(
            JSON.stringify(hydrogen.capabilities?.reasoning?.efforts ?? []) === '["low","medium","high","xhigh"]',
            'the catalog row carries the v1 reasoning data'
        );
        const nanoBanana = resolveModelTraits('gemini-nano-banana-2.1');
        expect(nanoBanana.origin === 'seed', `an id without a row resolves from the seed (got ${nanoBanana.origin})`);
        expect(nanoBanana.capabilities?.imageOutput === true, 'the seed knows it emits images');
        expect(resolveModelTraits('gpt-image-2.5-dev').origin === 'seed', 'the relay-only image id is seeded');
        expect(resolveModelTraits('no-such-model').origin === 'code', 'an unknown id falls back to code');
        expect(resolveModelTraits('no-such-model').capabilities === null, 'an unknown id has no capabilities');
        // The data side of the shadow for the seed snapshot
        expect(dataTraitValuesOf('gemini-4-hydrogen').xhighThinking === true, 'hydrogen data has xhigh');
        expect(dataTraitValuesOf('gemini-4-argon').xhighThinking === false, 'argon data has no xhigh');
        expect(dataTraitValuesOf('gemini-nano-banana-2.1').imageOutput === true, 'nano-banana data emits images');
        expect(dataTraitValuesOf('gemini-nano-banana-2.1').geminiFunctionTools === null, 'no toolsMixing data = unknown');
        expect(dataTraitValuesOf('no-such-model').imageOutput === null, 'no data = nothing to compare');
    })
);

results.push(
    await runCase('legacy, schema-2, broken and placeholder rows fall back to code', async () => {
        await createRow(
            'legacy-auto-model',
            JSON.stringify({
                kind: 'chat',
                vision: true,
                imageOutput: false,
                tools: true,
                reasoningEffort: ['low', 'high'],
                contextTokens: 200_000,
                outputTokens: 8_000,
            })
        );
        await createRow('future-schema-model', JSON.stringify({ schema: 2, kind: 'image', imageOutput: true, tools: false }));
        await createRow('broken-json-model', '{not json');
        await createRow('placeholder-model', '{}');
        await catalogService.loadModelCatalog();
        for (const id of ['legacy-auto-model', 'future-schema-model', 'broken-json-model', 'placeholder-model']) {
            const traits = resolveModelTraits(id);
            expect(traits.origin === 'code', `${id}: code origin (got ${traits.origin})`);
            expect(traits.capabilities === null, `${id}: the schema-less row is no data`);
            expect(sameValues(id, [false, false, true]), `${id}: the code heuristics still answer`);
        }
        await dropCreatedRows();
    })
);

results.push(
    await runCase('the shadow compares data with code and logs each model|field once', async () => {
        await catalogService.loadModelCatalog();
        const entries: readonly ModelCatalogEntry[] = seedModelCatalogEntries().map((entry) => {
            if (entry.id === 'gemini-4-hydrogen') {
                return { ...entry, capabilities: { ...entry.capabilities, imageOutput: true } };
            }
            if (entry.id === 'gemini-4-argon') {
                const reasoning = entry.capabilities.reasoning;
                const efforts: readonly ModelEffort[] = [...(reasoning?.efforts ?? []), 'xhigh'];
                return {
                    ...entry,
                    capabilities: {
                        ...entry.capabilities,
                        reasoning: { ...(reasoning === undefined ? { supported: true } : reasoning), efforts },
                    },
                };
            }
            return entry;
        });
        setModelCatalog(entries);
        process.env.MODEL_TRAITS_SHADOW = '1';
        resetTraitsShadow();
        try {
            expect(isImageOutputModel('gemini-4-hydrogen') === false, 'runtime still returns the code result');
            expect(supportsXhighThinkingLevel('gemini-4-argon') === false, 'runtime still returns the code result');
            const diffs = traitsShadowDiffs();
            expect(diffs.length === 2, `two diff lines (got ${diffs.length})`);
            const imageDiff = diffs.find((diff) => diff.field === 'imageOutput');
            const xhighDiff = diffs.find((diff) => diff.field === 'xhighThinking');
            expect(
                imageDiff?.model === 'gemini-4-hydrogen' && imageDiff.data === true && imageDiff.code === false,
                `imageOutput data=true code=false (got ${JSON.stringify(imageDiff)})`
            );
            expect(
                xhighDiff?.model === 'gemini-4-argon' && xhighDiff.data === true && xhighDiff.code === false,
                `xhighThinking data=true code=false (got ${JSON.stringify(xhighDiff)})`
            );
            // The same model|field is recorded (and printed) once
            isImageOutputModel('gemini-4-hydrogen');
            supportsXhighThinkingLevel('gemini-4-argon');
            expect(traitsShadowDiffs().length === 2, 'a repeated comparison is deduped');
        } finally {
            delete process.env.MODEL_TRAITS_SHADOW;
            resetTraitsShadow();
        }
        isImageOutputModel('gemini-4-hydrogen');
        expect(traitsShadowDiffs().length === 0, 'shadow off records nothing');
        // The data side stays readable while the runtime keeps the code result
        expect(dataTraitValuesOf('gemini-4-hydrogen').imageOutput === true, 'the data value is visible to the later PR');
        setModelCatalog([]);
    })
);

results.push(
    await runCase('the shadow is off by default', async () => {
        delete process.env.MODEL_TRAITS_SHADOW;
        resetTraitsShadow();
        isImageOutputModel('gemini-4-hydrogen');
        supportsXhighThinkingLevel('gemini-4-argon');
        expect(traitsShadowDiffs().length === 0, 'no diffs without the env switch');
        expect(
            dataTraitValuesOf('gemini-4-hydrogen').imageOutput === seedModelCatalogEntries().find(
                (entry) => entry.id === 'gemini-4-hydrogen'
            )?.capabilities.imageOutput,
            'the data value equals the seed value'
        );
        setModelCatalog([]);
        await sequelize.query('DELETE FROM model_catalog');
        setModelCatalog([]);
    })
);

reportResults(results);
