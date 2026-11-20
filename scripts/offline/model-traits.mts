/**
 * Offline cases for `RuntimeTraits`, per-platform pure code defaults,
 * `capabilitiesOf` equivalence, `[traits]` logging, and `reconcileCatalogTraits`
 * (design 2026-1114-0510 §5, S1 + S2).
 *
 * Run: pnpm test:offline model-traits
 */
import { setupOfflineDb, expect, reportResults, runCase, type CaseResult } from './harness.mts';

type ModelCatalogEntry = import('../../src/config/model-catalog.js').ModelCatalogEntry;

await setupOfflineDb();
const { sequelize } = await import('../../src/db/config.js');
const { ModelCatalogEntryRow } = await import('../../src/db/modelCatalogDTO.js');
const { emptyModelCapabilities } = await import('../../src/config/model-capabilities.js');
const { fallbackCapabilitiesOf, platformOfModelId, setModelCatalog, seedModelCatalogEntries } =
    await import('../../src/config/model-catalog.js');
const { platformTypeOf } = await import('../../src/config/platform-routing.js');
const { capabilitySeedIds } = await import('../../src/config/model-capability-seed.js');
const catalogService = await import('../../src/services/model-catalog-service.js');
const {
    isImageOutputModel,
    supportsGeminiFunctionTools,
    supportsGeminiImageSearchGrounding,
} = await import('../../src/ai/model-kinds.js');
const {
    capabilitiesOf,
    logReplyTraits,
    reconcileCatalogTraits,
    resolveModelTraits,
    resolveRuntimeTraits,
} = await import('../../src/ai/model-traits.js');
const { getModelCapabilities, getPlatform } = await import('../../src/ai/platform-factory.js');

const results: CaseResult[] = [];
const json = (value: unknown): string => JSON.stringify(value);

/** [imageOutput, geminiFunctionTools] as expected on the seed/catalog baseline */
const TODAY: Readonly<Record<string, readonly [boolean, boolean]>> = {
    'gpt-6-luna': [false, true],
    'gpt-6-sol': [false, true],
    'gpt-6-astra': [false, true],
    'claude-sonnet-5-5': [false, true],
    'claude-opus-5-5': [false, true],
    'gemini-4-hydrogen': [false, true],
    'gemini-4-neon': [false, true],
    'gemini-4-argon': [false, true],
    'gemini-4-carbon': [false, true],
    'gemini-3.8-flash': [false, true],
    'gemini-nano-banana-2.1': [true, false],
    'deepseek-flash': [false, true],
    'grok-4.7': [false, true],
    'grok-4.20-multi-agent-0309': [false, true],
    'mimo-v2.6-flash': [false, true],
    'mimo-v2.6-pro': [false, true],
    'gpt-image-2.5-dev': [true, false],
};

const valuesOf = (model: string): readonly [boolean, boolean] => [
    isImageOutputModel(model),
    supportsGeminiFunctionTools(model),
];

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
    await runCase('all seed, historical and unknown models match code predicates and capabilitiesOf', async () => {
        await catalogService.loadModelCatalog();
        expect(capabilitySeedIds().length === 17, 'the seed covers the 17 snapshot ids');
        for (const id of capabilitySeedIds()) {
            const expected = TODAY[id];
            if (expected === undefined) throw new Error(`no golden row for ${id}`);
            expect(json(valuesOf(id)) === json(expected), `${id}: ${json(valuesOf(id))} == ${json(expected)}`);

            const traits = resolveRuntimeTraits(id);
            const fromTraits = capabilitiesOf(traits);
            const fromPlatform = getPlatform(id).getModelCapabilities(id);
            const fromFactory = getModelCapabilities(id);
            expect(json(fromTraits) === json(fromPlatform), `${id}: capabilitiesOf matches platform`);
            expect(json(fromTraits) === json(fromFactory), `${id}: capabilitiesOf matches factory`);
        }

        const extra: Readonly<Record<string, readonly [boolean, boolean]>> = {
            'gemini-2.5-flash': [false, false],
            'gemini-2.5-pro': [false, false],
            'gemini-2.5-flash-lite': [false, false],
            'gemini-3-pro-image': [true, false],
            'gemini-3.1-flash-image': [true, false],
            'gpt-4o': [false, true],
            'gpt-6-chat': [false, true],
            'o3-mini': [false, true],
            'some-random-model': [false, true],
            'another-image-model': [true, false],
            'dall-e-3': [true, false],
            'deepseek-reasoner': [false, true],
            'grok-3': [false, true],
            'grok-code-1': [false, true],
            'mimo-v2.5-pro': [false, true],
        };
        for (const [id, expected] of Object.entries(extra)) {
            expect(json(valuesOf(id)) === json(expected), `${id}: ${json(valuesOf(id))} == ${json(expected)}`);
            const traits = resolveRuntimeTraits(id);
            expect(traits.origin === 'code', `${id}: code origin`);
            expect(traits.capabilities === null, `${id}: no capabilities`);
            expect(
                json(capabilitiesOf(traits)) === json(getPlatform(id).getModelCapabilities(id)),
                `${id}: capabilitiesOf matches platform`
            );
        }
        expect(resolveRuntimeTraits('some-random-model').platform === 'openai', 'unknown ids route to openai');
        expect(supportsGeminiImageSearchGrounding('gemini-nano-banana-2.1'), 'nano-banana can ground on images');
        expect(supportsGeminiImageSearchGrounding('gemini-3-pro-image') === false, 'gemini-3-pro-image cannot');
    })
);

results.push(
    await runCase('resolution chain is catalog → seed → code and broken/legacy rows fall back to code', async () => {
        await catalogService.loadModelCatalog();
        const hydrogen = resolveRuntimeTraits('gemini-4-hydrogen');
        expect(hydrogen.origin === 'catalog', `menu row resolves from catalog (got ${hydrogen.origin})`);
        expect(hydrogen.inCatalog, 'menu row is marked inCatalog');
        expect(hydrogen.platform === 'gemini', 'platform comes from prefix routing');
        expect(
            json(hydrogen.reasoning.value?.efforts ?? []) === '["low","medium","high","xhigh"]',
            'reasoning trait carries v1 data'
        );
        expect(hydrogen.reasoning.origin === 'data', 'reasoning origin is data');
        expect(hydrogen.imageOutput.origin === 'data', 'S5 makes imageOutput data-driven');
        expect(hydrogen.imageInput.origin === 'data', 'S6 makes verified imageInput data-driven');

        const nanoBanana = resolveRuntimeTraits('gemini-nano-banana-2.1');
        expect(nanoBanana.origin === 'seed', `seed-only id resolves from seed (got ${nanoBanana.origin})`);
        expect(!nanoBanana.inCatalog, 'seed-only id is not in catalog');
        expect(nanoBanana.imageOutput.dataValue === true, 'seed asserts imageOutput=true');
        expect(
            nanoBanana.mediaInput.dataValue === false && nanoBanana.mediaInput.codeValue === false,
            'nano-banana mediaInput aligns with code after video modality removal'
        );
        expect(!nanoBanana.mediaInput.differs, 'no nano-banana mediaInput diff');

        expect(resolveRuntimeTraits('gpt-image-2.5-dev').origin === 'seed', 'relay-only image id is seeded');
        expect(resolveRuntimeTraits('no-such-model').origin === 'code', 'unknown id falls back to code');
        expect(resolveRuntimeTraits('no-such-model').capabilities === null, 'unknown id has no capabilities');

        await createRow(
            'legacy-auto-model',
            json({
                kind: 'chat',
                vision: true,
                imageOutput: false,
                tools: true,
                reasoningEffort: ['low', 'high'],
                contextTokens: 200_000,
                outputTokens: 8_000,
            })
        );
        await createRow('future-schema-model', json({ schema: 2, kind: 'image', imageOutput: true, tools: false }));
        await createRow('broken-json-model', '{not json');
        await createRow('placeholder-model', '{}');
        await catalogService.loadModelCatalog();
        for (const id of ['legacy-auto-model', 'future-schema-model', 'broken-json-model', 'placeholder-model']) {
            const traits = resolveModelTraits(id);
            expect(traits.origin === 'code', `${id}: code origin (got ${traits.origin})`);
            expect(traits.capabilities === null, `${id}: schema-less row has no data`);
            const runtime = resolveRuntimeTraits(id);
            expect(runtime.inCatalog, `${id}: still recorded as inCatalog`);
            expect(runtime.origin === 'code', `${id}: runtime origin falls back to code`);
        }
        await dropCreatedRows();
    })
);

results.push(
    await runCase('reconcileCatalogTraits computes deterministic code vs data diffs and logReplyTraits prints [traits]', async () => {
        await catalogService.loadModelCatalog();
        const reconciliation = reconcileCatalogTraits();
        expect(reconciliation.rows.length === 17, `all 13 menu + 4 seed-only rows reconciled (got ${reconciliation.rows.length})`);

        const nano = reconciliation.rows.find((row) => row.model === 'gemini-nano-banana-2.1');
        const nanoMedia = nano?.entries.find((entry) => entry.field === 'mediaInput');
        expect(
            nanoMedia?.data === false && nanoMedia.code === false && nanoMedia.differs === false,
            `nano-banana mediaInput agrees (got ${json(nanoMedia)})`
        );

        const gptImage = reconciliation.rows.find((row) => row.model === 'gpt-image-2.5-dev');
        const gptVision = gptImage?.entries.find((entry) => entry.field === 'imageInput');
        expect(
            gptVision?.data === false && gptVision.code === true && gptVision.differs === true,
            `gpt-image-2.5-dev vision diff surfaced (got ${json(gptVision)})`
        );

        const claude = reconciliation.rows.find((row) => row.model === 'claude-sonnet-5-5');
        const claudeOut = claude?.entries.find((entry) => entry.field === 'outputTokens');
        expect(
            claudeOut?.data === 128_000 && claudeOut.runtime === 128_000 && claudeOut.origin === 'data' && claudeOut.differs === false,
            `claude outputTokens is data-driven (got ${json(claudeOut)})`
        );

        // Injected disagreement surfaces immediately in reconciliation and [traits] log
        const modified: readonly ModelCatalogEntry[] = seedModelCatalogEntries().map((entry) =>
            entry.id === 'gemini-4-hydrogen'
                ? { ...entry, capabilities: { ...entry.capabilities, imageOutput: true } }
                : entry
        );
        setModelCatalog(modified, 'offline-reconcile');
        const customRecon = reconcileCatalogTraits();
        const hydro = customRecon.rows.find((row) => row.model === 'gemini-4-hydrogen');
        const hydroImg = hydro?.entries.find((entry) => entry.field === 'imageOutput');
        expect(
            hydroImg?.data === true &&
                hydroImg.code === false &&
                hydroImg.runtime === true &&
                hydroImg.origin === 'data' &&
                hydroImg.differs === true,
            `injected imageOutput drives runtime and records diff (got ${json(hydroImg)})`
        );

        const logged: string[] = [];
        const originalLog = console.log;
        console.log = (...args: unknown[]) => {
            logged.push(args.map((arg) => String(arg)).join(' '));
        };
        try {
            logReplyTraits(resolveRuntimeTraits('gemini-4-hydrogen'));
        } finally {
            console.log = originalLog;
        }
        expect(
            logged.length === 1 &&
                logged[0] !== undefined &&
                logged[0].includes('[traits] model=gemini-4-hydrogen') &&
                logged[0].includes('catalog=offline-reconcile') &&
                logged[0].includes('codeFallback=[imageSearchGrounding]') &&
                logged[0].includes('imageOutput:true!=false'),
            `[traits] log line reports remaining code fallbacks and diffs (got ${json(logged)})`
        );

        setModelCatalog([]);
        await sequelize.query('DELETE FROM model_catalog');
        setModelCatalog([]);
    })
);

results.push(
    await runCase('S3/S4/S5 data-driven cutover: OpenAI reasoning, Gemini mixing/grounding, Grok tools, imageOutput', async () => {
        const baseSeed = seedModelCatalogEntries();
        const gpt7: ModelCatalogEntry = {
            id: 'gpt-7-new',
            label: 'GPT 7 New',
            enabled: true,
            platform: 'openai',
            capabilities: {
                ...emptyModelCapabilities(),
                schema: 1,
                kind: 'chat',
                tools: true,
                reasoning: { supported: true, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
            },
            source: 'official',
            checkedOn: '2026-11-20',
            confidence: 'high',
            note: 'test',
        };
        const customPainter: ModelCatalogEntry = {
            id: 'custom-painter-v1',
            label: 'Custom Painter',
            enabled: true,
            platform: 'openai',
            capabilities: {
                ...emptyModelCapabilities(),
                schema: 1,
                kind: 'image',
                imageOutput: false,
                modalities: { input: ['text'], output: ['image'] },
                tools: false,
                provenance: {
                    'modalities.output': { source: 'official', checkedOn: '2026-11-20', confidence: 'high' },
                },
            },
            source: 'official',
            checkedOn: '2026-11-20',
            confidence: 'high',
            note: 'test',
        };
        const geminiImageWithTools: ModelCatalogEntry = {
            id: 'gemini-3-pro-image',
            label: 'Gemini 3 Pro Image',
            enabled: false,
            platform: 'gemini',
            capabilities: {
                ...emptyModelCapabilities(),
                schema: 1,
                kind: 'image',
                imageOutput: true,
                tools: true,
                toolsMixing: 'allowed',
                nativeTools: { imageSearchGrounding: true },
                provenance: {
                    imageOutput: { source: 'official', checkedOn: '2026-11-20', confidence: 'high' },
                    tools: { source: 'official', checkedOn: '2026-11-20', confidence: 'high' },
                },
            },
            source: 'official',
            checkedOn: '2026-11-20',
            confidence: 'high',
            note: 'test',
        };
        const grokServerOnly: ModelCatalogEntry = {
            id: 'grok-5-reasoning',
            label: 'Grok 5 Reasoning',
            enabled: true,
            platform: 'grok',
            capabilities: {
                ...emptyModelCapabilities(),
                schema: 1,
                kind: 'chat',
                tools: false,
                provenance: {
                    tools: { source: 'official', checkedOn: '2026-11-20', confidence: 'high' },
                },
            },
            source: 'official',
            checkedOn: '2026-11-20',
            confidence: 'high',
            note: 'test',
        };
        const overridden = baseSeed.map((entry) => {
            if (entry.id === 'gpt-6-luna') {
                return {
                    ...entry,
                    capabilities: {
                        ...entry.capabilities,
                        reasoning: { supported: false, efforts: [], defaultEffort: null },
                    },
                };
            }
            if (entry.id === 'gemini-4-hydrogen') {
                return {
                    ...entry,
                    capabilities: {
                        ...entry.capabilities,
                        toolsMixing: 'denied' as const,
                    },
                };
            }
            return entry;
        });
        setModelCatalog([...overridden, gpt7, customPainter, geminiImageWithTools, grokServerOnly], 's345');
        try {
            // S3: OpenAI reasoning.supported data-driven with code fallback
            expect(
                capabilitiesOf(resolveRuntimeTraits('gpt-7-new')).supportsThinking === true,
                'unknown gpt-7-new gains supportsThinking from catalog reasoning.supported'
            );
            expect(
                capabilitiesOf(resolveRuntimeTraits('gpt-6-luna')).supportsThinking === false,
                'gpt-6-luna reasoning.supported=false overrides prefix heuristic'
            );
            expect(
                capabilitiesOf(resolveRuntimeTraits('o3-mini')).supportsThinking === true &&
                    capabilitiesOf(resolveRuntimeTraits('gpt-4.1')).supportsThinking === false,
                'uncatalogued OpenAI ids fall back to openaiCodeTraitsOf'
            );

            // S4: Gemini toolsMixing, imageSearchGrounding, Grok tools, image-model guard
            expect(
                supportsGeminiFunctionTools('gemini-4-hydrogen') === false &&
                    capabilitiesOf(resolveRuntimeTraits('gemini-4-hydrogen')).supportsClientTools === false,
                'catalog toolsMixing=denied disables Gemini function tools and clientTools'
            );
            expect(
                supportsGeminiFunctionTools('gemini-3-pro-image') === false &&
                    capabilitiesOf(resolveRuntimeTraits('gemini-3-pro-image')).supportsClientTools === false,
                'image model keeps tools disabled even when catalog asserts toolsMixing=allowed'
            );
            expect(
                supportsGeminiImageSearchGrounding('gemini-3-pro-image') === true,
                'catalog nativeTools.imageSearchGrounding drives imageSearchGrounding'
            );
            expect(
                capabilitiesOf(resolveRuntimeTraits('grok-5-reasoning')).supportsClientTools === false,
                'catalog tools=false disables Grok client tools without multi-agent in id'
            );

            // S5: imageOutput data-driven (imageOutput flag or modalities.output)
            expect(
                isImageOutputModel('custom-painter-v1') === true &&
                    capabilitiesOf(resolveRuntimeTraits('custom-painter-v1')).supportsImageOutput === true,
                'modalities.output including image drives isImageOutputModel and supportsImageOutput'
            );
        } finally {
            setModelCatalog([]);
        }
    })
);

results.push(
    await runCase('S6 provenance-gated cutover for imageInput, mediaInput, and clientTools', async () => {
        const partialProvenance: ModelCatalogEntry = {
            id: 'gemini-4-partial',
            label: 'Gemini 4 Partial Provenance',
            enabled: true,
            platform: 'gemini',
            capabilities: {
                ...emptyModelCapabilities(),
                schema: 1,
                kind: 'chat',
                vision: false,
                tools: false,
                toolsMixing: 'allowed',
                modalities: { input: ['text'], output: ['text'] },
                provenance: {
                    tools: { source: 'manual', checkedOn: '2026-11-20', confidence: 'high' },
                },
            },
            source: 'models-dev',
            checkedOn: '2026-11-20',
            confidence: 'high',
        };
        const lowConfidence: ModelCatalogEntry = {
            id: 'gpt-6-low-conf',
            label: 'GPT 6 Low Confidence',
            enabled: true,
            platform: 'openai',
            capabilities: {
                ...emptyModelCapabilities(),
                schema: 1,
                kind: 'chat',
                vision: false,
                tools: false,
                provenance: {
                    vision: { source: 'models-dev', checkedOn: '2026-11-20', confidence: 'low' },
                    tools: { source: 'models-dev', checkedOn: '2026-11-20', confidence: 'low' },
                },
            },
            source: 'models-dev',
            checkedOn: '2026-11-20',
            confidence: 'low',
        };
        const verifiedAll: ModelCatalogEntry = {
            id: 'mimo-v2.6-text-only',
            label: 'MiMo Verified Text Only',
            enabled: true,
            platform: 'mimo',
            capabilities: {
                ...emptyModelCapabilities(),
                schema: 1,
                kind: 'chat',
                vision: false,
                tools: true,
                modalities: { input: ['text'], output: ['text'] },
                provenance: {
                    vision: { source: 'official', checkedOn: '2026-11-20', confidence: 'high' },
                    'modalities.input': { source: 'official', checkedOn: '2026-11-20', confidence: 'high' },
                    tools: { source: 'official', checkedOn: '2026-11-20', confidence: 'high' },
                },
            },
            source: 'official',
            checkedOn: '2026-11-20',
            confidence: 'high',
        };
        const verifiedImageGuard: ModelCatalogEntry = {
            id: 'custom-verified-image',
            label: 'Custom Verified Image',
            enabled: false,
            platform: 'openai',
            capabilities: {
                ...emptyModelCapabilities(),
                schema: 1,
                kind: 'image',
                imageOutput: true,
                vision: true,
                tools: true,
                provenance: {
                    imageOutput: { source: 'manual', checkedOn: '2026-11-20', confidence: 'high' },
                    tools: { source: 'manual', checkedOn: '2026-11-20', confidence: 'high' },
                    vision: { source: 'manual', checkedOn: '2026-11-20', confidence: 'high' },
                },
            },
            source: 'manual',
            checkedOn: '2026-11-20',
            confidence: 'high',
        };
        const dallePartialProvenance: ModelCatalogEntry = {
            id: 'dall-e-4',
            label: 'DALL-E 4',
            enabled: false,
            platform: 'openai',
            capabilities: {
                ...emptyModelCapabilities(),
                schema: 1,
                kind: 'chat',
                imageOutput: false,
                vision: true,
                provenance: {
                    vision: { source: 'models-dev', checkedOn: '2026-11-20', confidence: 'high' },
                },
            },
            source: 'models-dev',
            checkedOn: '2026-11-20',
            confidence: 'high',
        };
        const openaiNanoBananaVerifiedFalse: ModelCatalogEntry = {
            id: 'custom-nano-banana-chat',
            label: 'Nano Banana Chat Override',
            enabled: false,
            platform: 'openai',
            capabilities: {
                ...emptyModelCapabilities(),
                schema: 1,
                kind: 'chat',
                imageOutput: false,
                provenance: {
                    imageOutput: { source: 'manual', checkedOn: '2026-11-20', confidence: 'high' },
                },
            },
            source: 'manual',
            checkedOn: '2026-11-20',
            confidence: 'high',
        };

        setModelCatalog(
            [
                partialProvenance,
                lowConfidence,
                verifiedAll,
                verifiedImageGuard,
                dallePartialProvenance,
                openaiNanoBananaVerifiedFalse,
            ],
            's6-prov'
        );
        try {
            const partial = resolveRuntimeTraits('gemini-4-partial');
            expect(
                partial.clientTools.origin === 'data' && partial.clientTools.value === false,
                'verified tools provenance cuts over clientTools'
            );
            expect(
                partial.imageInput.origin === 'code' &&
                    partial.imageInput.value === true &&
                    partial.imageInput.dataValue === false &&
                    partial.imageInput.differs === true,
                'absent vision provenance keeps code fallback while surfacing reconciliation diff'
            );
            expect(
                partial.mediaInput.origin === 'code' &&
                    partial.mediaInput.value === true &&
                    partial.mediaInput.dataValue === false &&
                    partial.mediaInput.differs === true,
                'absent modalities.input provenance keeps Gemini code mediaInput while surfacing diff'
            );

            const low = resolveRuntimeTraits('gpt-6-low-conf');
            expect(
                low.imageInput.origin === 'code' &&
                    low.imageInput.value === true &&
                    low.clientTools.origin === 'code' &&
                    low.clientTools.value === true,
                'low-confidence field provenance does not cut over vision or tools'
            );

            const mimo = resolveRuntimeTraits('mimo-v2.6-text-only');
            expect(
                mimo.imageInput.origin === 'data' &&
                    mimo.imageInput.value === false &&
                    mimo.mediaInput.origin === 'data' &&
                    mimo.mediaInput.value === false &&
                    mimo.clientTools.origin === 'data' &&
                    mimo.clientTools.value === true,
                'verified field provenance drives imageInput, mediaInput, and clientTools from catalog'
            );

            const imgGuard = resolveRuntimeTraits('custom-verified-image');
            expect(
                imgGuard.imageOutput.value === true && imgGuard.clientTools.value === false,
                'imageOutput keeps clientTools disabled even with verified tools=true'
            );

            const dalle = resolveRuntimeTraits('dall-e-4');
            expect(
                dalle.imageOutput.origin === 'code' &&
                    dalle.imageOutput.value === true &&
                    isImageOutputModel('dall-e-4', dalle) === true,
                'partial provenance without imageOutput/modalities.output keeps dall-e-4 on code imageOutput=true'
            );

            const nanoOpenaiCode = resolveRuntimeTraits('openai-nano-banana-uncatalogued');
            expect(
                isImageOutputModel('openai-nano-banana-uncatalogued', nanoOpenaiCode) === true &&
                    capabilitiesOf(nanoOpenaiCode).supportsImageOutput === true,
                'uncatalogued OpenAI nano-banana matches in both isImageOutputModel and supportsImageOutput'
            );

            const nanoVerifiedChat = resolveRuntimeTraits('custom-nano-banana-chat');
            expect(
                nanoVerifiedChat.imageOutput.origin === 'data' &&
                    nanoVerifiedChat.imageOutput.value === false &&
                    isImageOutputModel('custom-nano-banana-chat', nanoVerifiedChat) === false,
                'verified catalog imageOutput=false overrides nano-banana name heuristic cleanly'
            );
        } finally {
            setModelCatalog([]);
        }
    })
);

results.push(
    await runCase('layer-0 platform routing matches and fallbackCapabilitiesOf counts dall-e as image', async () => {
        for (const id of [
            'gemini-4-neon',
            'deepseek-flash',
            'grok-4.7',
            'mimo-v2.6-pro',
            'claude-sonnet-5-5',
            'gpt-6-luna',
            'unknown-id',
        ]) {
            expect(
                platformOfModelId(id) === platformTypeOf(id),
                `${id}: catalog platform matches layer-0 routing (${platformOfModelId(id)} == ${platformTypeOf(id)})`
            );
        }
        const dalle = fallbackCapabilitiesOf('dall-e-3');
        expect(dalle.kind === 'image' && dalle.imageOutput === true && dalle.tools === false, 'dall-e-3 fallback is image');
        const plain = fallbackCapabilitiesOf('gpt-7-custom');
        expect(plain.kind === 'chat' && plain.imageOutput === false && plain.tools === true, 'non-image fallback is chat');
    })
);

reportResults(results);
