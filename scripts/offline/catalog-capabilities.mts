/**
 * Offline cases for the capability data plane (thinking-effort design
 * 2026-1113-1742 §1.1/§2.3): the schema-1 normalizer, the code seed, the
 * provider/lab/api.json compiler with its source priority, the canonical lab
 * TOML fetch, and the differ's overlay and risk controls.
 *
 * The fixtures are trimmed copies of the real 2026-11-13 models.dev snapshot:
 * `fixtures/pricing/toml/` (provider TOML, price + capabilities sections),
 * `fixtures/pricing/lab/` (canonical lab TOML: limits and MIME modalities) and
 * `fixtures/pricing/api.json` (the aggregate). Cases never touch the network.
 *
 * Run: pnpm test:offline catalog-capabilities
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';

type CatalogDocuments = import('../../src/services/price-catalog-types.js').CatalogDocuments;
type CatalogFetcher = import('../../src/services/price-catalog-types.js').CatalogFetcher;
type CapabilityCandidate = import('../../src/services/capability-catalog-types.js').CapabilityCandidate;
type CapabilityPatch = import('../../src/services/capability-catalog-types.js').CapabilityPatch;
type CapabilityCompileResult = import('../../src/services/capability-catalog-types.js').CapabilityCompileResult;
type ModelCatalogCapabilities = import('../../src/config/model-capabilities.js').ModelCatalogCapabilities;
type ModelCatalogEntry = import('../../src/config/model-catalog.js').ModelCatalogEntry;

const { normalizeModelCapabilities } = await import('../../src/config/model-capabilities.js');
const { capabilitySeedIds, capabilitySeedOf } = await import('../../src/config/model-capability-seed.js');
const { seedModelCatalogEntries } = await import('../../src/config/model-catalog.js');
const { compileCapabilityObservations, diffCapabilityCandidates } = await import(
    '../../src/services/capability-catalog-compile.js'
);
const {
    CATALOG_MODEL_REFS,
    EPHONE_PRICING_URL,
    LITELLM_PRICING_URL,
    VERTEX_PRICING_URL,
    baseModelOfToml,
    fetchPriceCatalogs,
    modelsDevLabTomlUrl,
    modelsDevTomlUrl,
} = await import('../../src/services/price-catalog-fetch.js');

const FIXTURE_DIRECTORY = fileURLToPath(new URL('./fixtures/pricing/', import.meta.url));
const fixture = (relativePath: string): string => readFileSync(join(FIXTURE_DIRECTORY, relativePath), 'utf8');

/** The fixed run clock: 2026-11-13, the day the snapshot was taken */
const NOW = new Date('2026-11-13T04:30:00Z');
const CHECKED_ON = '2026-11-13';
/** The two price refs whose provider TOML names no `base_model`, so no lab document exists */
const NO_LAB_MODELS: ReadonlySet<string> = new Set(['claude-sonnet-5', 'grok-4.20-multi-agent-0309']);

const providerBodies = (): ReadonlyMap<string, string> =>
    new Map(CATALOG_MODEL_REFS.filter((ref) => ref.modelFile !== '').map((ref) => [ref.model, fixture(`toml/${ref.model}.toml`)]));

const labBodies = (): ReadonlyMap<string, string> =>
    new Map(
        CATALOG_MODEL_REFS.filter((ref) => !NO_LAB_MODELS.has(ref.model) && ref.modelFile !== '').map((ref) => [
            ref.model,
            fixture(`lab/${ref.model}.toml`),
        ])
    );

interface DocumentOverrides {
    readonly provider?: ReadonlyMap<string, string>;
    readonly lab?: ReadonlyMap<string, string>;
}

const documentsOf = (overrides: DocumentOverrides = {}): CatalogDocuments => ({
    tomlByModel: overrides.provider ?? providerBodies(),
    labTomlByModel: overrides.lab ?? labBodies(),
    vertexPricingHtml: null,
    ephonePricingJson: null,
    litellmJson: null,
});

const compileOf = (overrides: DocumentOverrides = {}, apiJson: string | null = fixture('api.json')): CapabilityCompileResult =>
    compileCapabilityObservations(documentsOf(overrides), { now: NOW, apiJson });

const candidateOf = (result: CapabilityCompileResult, model: string): CapabilityCandidate | undefined =>
    result.candidates.find((candidate) => candidate.model === model);

const requireCandidate = (result: CapabilityCompileResult, model: string): CapabilityCandidate => {
    const candidate = candidateOf(result, model);
    if (candidate === undefined) throw new Error(`no candidate for ${model}`);
    return candidate;
};

const patchOf = (model: string, patch: CapabilityPatch): CapabilityCandidate => ({
    model,
    patch,
    checkedOn: CHECKED_ON,
    origins: ['provider-toml'],
});

const entryOf = (model: string, overrides: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry => {
    const seed = seedModelCatalogEntries().find((entry) => entry.id === model);
    if (seed === undefined) throw new Error(`no seed entry for ${model}`);
    return { ...seed, ...overrides };
};

const requireSeedCapabilities = (model: string): ModelCatalogCapabilities => {
    const seed = capabilitySeedOf(model);
    if (seed === null) throw new Error(`no seed for ${model}`);
    return seed;
};

const isEfforts = (capabilities: ModelCatalogCapabilities, expected: readonly string[]): boolean =>
    JSON.stringify(capabilities.reasoning?.efforts ?? []) === JSON.stringify(expected);

const results: CaseResult[] = [];

// ---------------------------------------------------------------------------
// Schema-1 normalizer (design §1.1 rules 1-9)
// ---------------------------------------------------------------------------

results.push(
    await runCase('a schema-1 object keeps every section and syncs the legacy mirror', async () => {
        const normalized = normalizeModelCapabilities({
            schema: 1,
            kind: 'chat',
            vision: true,
            imageOutput: false,
            tools: true,
            reasoningEffort: ['high', 'low'],
            contextTokens: 1_048_576,
            outputTokens: 65_536,
            modalities: { input: ['text', 'image/png', 'application/pdf'], output: ['text'] },
            reasoning: {
                supported: true,
                toggle: false,
                efforts: ['medium', 'low', 'high'],
                defaultEffort: 'high',
                defaultEnabled: null,
                source: 'models-dev',
                checkedOn: '2026-11-13',
                confidence: 'high',
            },
            apis: { 'generate-content': { reasoning: true, tools: true, structuredOutput: true } },
            toolsMixing: 'allowed',
            nativeTools: { imageSearchGrounding: true },
            source: 'models-dev',
            checkedOn: '2026-11-13',
            confidence: 'high',
        });
        const capabilities = normalized.capabilities;
        expect(normalized.warnings.length === 0, `no warnings (got ${normalized.warnings.join(' / ')})`);
        expect(capabilities.schema === 1, 'the schema version is 1');
        expect(isEfforts(capabilities, ['low', 'medium', 'high']), 'efforts are filtered and ordered');
        expect(JSON.stringify(capabilities.reasoningEffort) === '["low","medium","high"]', 'the legacy mirror follows reasoning.efforts');
        expect(capabilities.reasoning?.defaultEffort === 'high', 'a valid default effort is kept');
        expect(capabilities.toolsMixing === 'allowed', 'toolsMixing is kept');
        expect(capabilities.nativeTools?.imageSearchGrounding === true, 'nativeTools is kept');
        expect(capabilities.source === 'models-dev', 'row provenance is kept');
        expect(
            JSON.stringify(capabilities.modalities?.input) === '["text","image","pdf"]',
            `MIME is coerced to coarse classes (got ${JSON.stringify(capabilities.modalities?.input)})`
        );
        expect(capabilities.apis?.['generate-content']?.structuredOutput === true, 'the API subset is kept');
    })
);

results.push(
    await runCase('a missing field is unknown, not false: a legacy object keeps the old defaults', async () => {
        const normalized = normalizeModelCapabilities({});
        const capabilities = normalized.capabilities;
        expect(normalized.warnings.length === 0, 'an empty object is not an error');
        expect(capabilities.schema === undefined, 'no schema means a legacy row');
        expect(capabilities.kind === 'chat' && capabilities.tools === true, 'the old defaults are unchanged');
        expect(capabilities.vision === false && capabilities.imageOutput === false, 'the old booleans are unchanged');
        expect(capabilities.reasoningEffort.length === 0, 'no efforts');
        expect(capabilities.contextTokens === null && capabilities.outputTokens === null, 'no limits');
        expect(
            capabilities.reasoning === undefined && capabilities.modalities === undefined && capabilities.apis === undefined,
            'no v1 section is invented'
        );
    })
);

results.push(
    await runCase('a non-1 schema is read as legacy data and the original fields survive', async () => {
        const normalized = normalizeModelCapabilities({
            schema: 2,
            kind: 'image',
            vision: true,
            imageOutput: true,
            tools: false,
            reasoningEffort: ['low', 'xhigh'],
            contextTokens: 131_072,
            outputTokens: 32_768,
            reasoning: { supported: true, efforts: ['low'] },
        });
        const capabilities = normalized.capabilities;
        expect(capabilities.schema === undefined, 'a future schema is not taken as v1 data');
        expect(capabilities.kind === 'image' && capabilities.vision === true, 'the legacy fields still parse');
        expect(JSON.stringify(capabilities.reasoningEffort) === '["low","xhigh"]', 'the legacy efforts still parse');
        expect(capabilities.contextTokens === 131_072, 'the legacy limits still parse');
        expect(capabilities.reasoning === undefined, 'the v1 reasoning section is ignored');
        expect(
            normalized.warnings.some((warning) => warning.includes('schema')),
            `the schema version is warned about (got ${normalized.warnings.join(' / ')})`
        );
    })
);

results.push(
    await runCase('an unknown enum value drops the smallest unit, not the whole section', async () => {
        const normalized = normalizeModelCapabilities({
            schema: 1,
            kind: 'chat',
            tools: true,
            reasoning: { supported: true, efforts: ['low', 'turbo', 'high', 'low'] },
        });
        const capabilities = normalized.capabilities;
        expect(isEfforts(capabilities, ['low', 'high']), `the bad effort is dropped (got ${JSON.stringify(capabilities.reasoning?.efforts)})`);
        expect(capabilities.reasoning?.supported === true, 'the reasoning section survives');
        expect(
            normalized.warnings.some((warning) => warning.includes('turbo')),
            'the dropped value is named in the warnings'
        );
    })
);

results.push(
    await runCase('reasoning rules: default effort outside the list becomes null, supported=false clears', async () => {
        const outside = normalizeModelCapabilities({
            schema: 1,
            reasoning: { supported: true, efforts: ['low', 'medium'], defaultEffort: 'xhigh' },
        });
        expect(outside.capabilities.reasoning?.defaultEffort === null, 'a default outside efforts is null');
        expect(
            outside.warnings.some((warning) => warning.includes('defaultEffort')),
            'the clamp is explained'
        );
        const unsupported = normalizeModelCapabilities({
            schema: 1,
            reasoning: { supported: false, efforts: ['low'], defaultEffort: 'low', toggle: true },
        });
        expect(isEfforts(unsupported.capabilities, []), 'supported=false clears the efforts');
        expect(unsupported.capabilities.reasoning?.defaultEffort === null, 'supported=false clears the default effort');
        const noToggle = normalizeModelCapabilities({
            schema: 1,
            reasoning: { supported: true, efforts: ['low'], defaultEnabled: true },
        });
        expect(noToggle.capabilities.reasoning?.defaultEnabled === null, 'defaultEnabled needs a toggle model');
    })
);

results.push(
    await runCase('token limits must be positive integers within the sanity ceiling', async () => {
        for (const [value, expected] of [
            [1_048_576, 1_048_576],
            [0, null],
            [-1, null],
            [1.5, null],
            [10_000_001, null],
        ] as const) {
            const normalized = normalizeModelCapabilities({ schema: 1, contextTokens: value });
            expect(
                normalized.capabilities.contextTokens === expected,
                `contextTokens ${value} → ${String(expected)} (got ${String(normalized.capabilities.contextTokens)})`
            );
        }
        const warned = normalizeModelCapabilities({ schema: 1, outputTokens: -5 });
        expect(warned.warnings.length === 1, 'an invalid limit is reported');
    })
);

results.push(
    await runCase('modalities accept MIME types and coarse names, unknown ones drop one by one', async () => {
        const normalized = normalizeModelCapabilities({
            schema: 1,
            modalities: {
                input: ['image/png', 'text', 'application/pdf', 'image/heic', 'video/mp4', 'audio/mpeg', 'application/x-weird'],
                output: ['text', 'image/jpeg'],
            },
        });
        const capabilities = normalized.capabilities;
        expect(
            JSON.stringify(capabilities.modalities?.input) === '["text","image","audio","video","pdf"]',
            `coarse classes in ladder order (got ${JSON.stringify(capabilities.modalities?.input)})`
        );
        expect(
            JSON.stringify(capabilities.modalities?.output) === '["text","image"]',
            'output image evidence is kept'
        );
        expect(capabilities.imageOutput === true, 'image output is derived from the modalities');
        expect(capabilities.vision === true, 'image input is derived from the modalities');
        expect(
            normalized.warnings.some((warning) => warning.includes('application/x-weird')),
            'the unknown MIME is named in the warnings'
        );
    })
);

results.push(
    await runCase('unknown values and unknown keys never poison a section', async () => {
        const normalized = normalizeModelCapabilities({
            schema: 1,
            kind: 'robot',
            toolsMixing: 'sometimes',
            nativeTools: { imageSearchGrounding: true, telepathy: true },
            apis: { responses: { reasoning: 'yes', tools: true }, telepathy: { reasoning: true } },
            reasoning: { supported: 'yes' },
            modalities: { input: [] },
        });
        const capabilities = normalized.capabilities;
        expect(capabilities.kind === 'chat', 'an unknown kind falls back to chat');
        expect(capabilities.toolsMixing === undefined, 'an unknown toolsMixing is dropped');
        expect(capabilities.nativeTools?.imageSearchGrounding === true, 'known native tools survive');
        expect(capabilities.apis?.responses?.tools === true, 'known API flags survive');
        expect(capabilities.apis?.responses?.reasoning === undefined, 'a non-boolean API flag is dropped');
        expect(capabilities.reasoning === undefined, 'reasoning without supported is dropped as a whole');
        expect(capabilities.modalities === undefined, 'an empty modality list is unknown, not "none"');
        expect(normalized.warnings.length >= 5, `each drop is warned (got ${normalized.warnings.length})`);
    })
);

results.push(
    await runCase('a non-object capabilities value becomes the empty schema-less shape', async () => {
        const normalized = normalizeModelCapabilities('{"schema":1}');
        expect(normalized.capabilities.schema === undefined, 'a string is not v1 data');
        expect(normalized.capabilities.tools === true, 'the legacy default applies');
        expect(normalized.warnings.length === 1, 'the value is reported once');
    })
);

// ---------------------------------------------------------------------------
// The code seed
// ---------------------------------------------------------------------------

results.push(
    await runCase('the seed covers the 16 snapshot ids and normalizes without warnings', async () => {
        const ids = capabilitySeedIds();
        expect(ids.length === 16, `16 seeded ids (got ${ids.length})`);
        const menuIds = seedModelCatalogEntries().map((entry) => entry.id);
        expect(menuIds.every((id) => ids.includes(id)), 'every menu id is seeded');
        expect(
            ['gemini-nano-banana-2.1', 'gpt-image-2.5-dev', 'gemini-3.8-flash'].every((id) => ids.includes(id)),
            'the image models and gemini-3.8-flash are seeded'
        );
        for (const id of ids) {
            const seed = capabilitySeedOf(id);
            if (seed === null) throw new Error(`no seed for ${id}`);
            const normalized = normalizeModelCapabilities(seed);
            expect(normalized.warnings.length === 0, `${id}: the seed normalizes clean (${normalized.warnings.join(' / ')})`);
            expect(normalized.capabilities.schema === 1, `${id}: the seed is schema 1`);
            expect(
                JSON.stringify(normalized.capabilities.reasoningEffort) ===
                    JSON.stringify(normalized.capabilities.reasoning?.efforts ?? []),
                `${id}: the legacy mirror equals reasoning.efforts`
            );
        }
        expect(capabilitySeedOf('no-such-model') === null, 'an unknown id has no seed');
        expect(capabilitySeedOf('constructor') === null, 'object prototype keys are not seeds');
    })
);

// ---------------------------------------------------------------------------
// The compiler: provider TOML, lab TOML, api.json
// ---------------------------------------------------------------------------

results.push(
    await runCase('hydrogen: the provider TOML gives the four levels and the vendor default', async () => {
        const compiled = compileOf();
        const candidate = requireCandidate(compiled, 'gemini-4-hydrogen');
        expect(
            JSON.stringify(candidate.patch.reasoning?.efforts) === '["low","medium","high","xhigh"]',
            `the effort list (got ${JSON.stringify(candidate.patch.reasoning?.efforts)})`
        );
        expect(candidate.patch.reasoning?.defaultEffort === 'high', 'the vendor default is high');
        expect(candidate.patch.reasoning?.toggle === undefined, 'an absent toggle is not asserted');
        expect(candidate.patch.contextTokens === 1_048_576 && candidate.patch.outputTokens === 65_536, 'limits come from the lab TOML');
        expect(
            JSON.stringify(candidate.patch.modalities?.input) === '["text","image","audio","video","pdf"]',
            'the provider TOML modalities win (full MIME set)'
        );
        expect(candidate.patch.kind === 'chat' && candidate.patch.vision === true, 'kind/vision derive from modalities');
        expect(candidate.origins.includes('provider-toml') && candidate.origins.includes('lab-toml'), 'both documents contributed');
        expect(
            JSON.stringify(candidate.patch.apis?.['generate-content']) ===
                '{"reasoning":true,"tools":true,"structuredOutput":true}',
            'the per-API subset follows the model flags'
        );
    })
);

results.push(
    await runCase('the image model is an image model from its TOML, not from its id', async () => {
        const candidate = requireCandidate(compileOf(), 'gemini-nano-banana-2.1');
        expect(candidate.patch.kind === 'image', 'kind comes from api.json type/modalities');
        expect(candidate.patch.imageOutput === true, 'output image evidence sets imageOutput');
        expect(
            JSON.stringify(candidate.patch.modalities?.output) === '["text","image"]',
            'the output modalities include image'
        );
        expect(candidate.patch.tools === false, 'tools come from the lab TOML (provider has no tools section)');
        expect(
            JSON.stringify(candidate.patch.reasoning?.efforts) === '["minimal","medium","high"]',
            'image thinking levels are read'
        );
        expect(candidate.patch.reasoning?.defaultEffort === 'medium', 'the image vendor default is medium');
        expect(candidate.patch.apis?.['generate-content']?.structuredOutput === false, 'per-API structured output is false');
        expect(
            Object.hasOwn(candidate.patch, 'toolsMixing') === false && Object.hasOwn(candidate.patch, 'nativeTools') === false,
            'local-only fields are never observed'
        );
    })
);

results.push(
    await runCase('kind needs output-modality evidence, an api.json type alone is not enough', async () => {
        const apiOnly = JSON.stringify({
            'google-vertex': {
                models: {
                    'gemini-4-hydrogen': { type: 'image', limit: { context: 1_000, output: 100 } },
                },
            },
        });
        const empty = { provider: new Map<string, string>(), lab: new Map<string, string>() };
        const compiled = compileOf(empty, apiOnly);
        const candidate = requireCandidate(compiled, 'gemini-4-hydrogen');
        expect(candidate.patch.kind === undefined, 'no kind without output modalities');
        expect(
            compiled.warnings.some((warning) => warning.includes('没有输出模态证据')),
            `the unsupported type is warned about (got ${JSON.stringify(compiled.warnings)})`
        );

        const disagreeing = JSON.stringify({
            'google-vertex': {
                models: {
                    'gemini-4-hydrogen': {
                        type: 'image',
                        modalities: { input: ['text'], output: ['text'] },
                        limit: { context: 1_000, output: 100 },
                    },
                },
            },
        });
        const disagreed = compileOf(empty, disagreeing);
        const disagreedCandidate = requireCandidate(disagreed, 'gemini-4-hydrogen');
        expect(disagreedCandidate.patch.kind === 'chat', 'the output modalities win over the type');
        expect(
            disagreed.warnings.some((warning) => warning.includes('不一致')),
            `the disagreement is warned about (got ${JSON.stringify(disagreed.warnings)})`
        );
    })
);

results.push(
    await runCase('source priority: the provider TOML wins over the lab TOML and api.json', async () => {
        const candidate = requireCandidate(compileOf(), 'deepseek-flash');
        expect(
            candidate.patch.contextTokens === 1_048_576 && candidate.patch.outputTokens === 393_216,
            'the provider limits (binary) win over the lab decimals'
        );
        const apiOnly = compileOf({ lab: new Map() });
        const claude = requireCandidate(apiOnly, 'claude-sonnet-5');
        expect(
            claude.patch.contextTokens === 1_000_000 && claude.patch.outputTokens === 128_000,
            'without a lab TOML the api.json limits fill in'
        );
        expect(
            JSON.stringify(claude.patch.modalities?.input) === '["text","image","pdf"]',
            'the api.json coarse modalities fill in'
        );
    })
);

results.push(
    await runCase('an unknown effort value is dropped with a warning, the rest compiles', async () => {
        const providers = new Map(providerBodies());
        const hydrogen = providers.get('gemini-4-hydrogen');
        if (hydrogen === undefined) throw new Error('no hydrogen fixture');
        providers.set('gemini-4-hydrogen', hydrogen.replace('["low", "medium", "high", "xhigh"]', '["low", "turbo", "high"]'));
        const compiled = compileOf({ provider: providers });
        const candidate = requireCandidate(compiled, 'gemini-4-hydrogen');
        expect(
            JSON.stringify(candidate.patch.reasoning?.efforts) === '["low","high"]',
            `the bad level is dropped (got ${JSON.stringify(candidate.patch.reasoning?.efforts)})`
        );
        expect(
            compiled.warnings.some((warning) => warning.includes('turbo')),
            `the bad level is warned about (got ${compiled.warnings.join(' / ')})`
        );
    })
);

results.push(
    await runCase('a broken document only warns: the compiler never throws', async () => {
        const hydrogenRef = CATALOG_MODEL_REFS.filter((ref) => ref.model === 'gemini-4-hydrogen');
        const broken = compileCapabilityObservations(
            { tomlByModel: new Map([['gemini-4-hydrogen', 'this is [not a toml']]), labTomlByModel: new Map(), vertexPricingHtml: null, ephonePricingJson: null, litellmJson: null },
            { now: NOW, refs: hydrogenRef }
        );
        expect(broken.candidates.length === 0, 'nothing is compiled from a broken document');
        expect(broken.warnings.some((warning) => warning.includes('解析失败')), 'the parse failure is a warning');
        const weird = compileCapabilityObservations(
            {
                tomlByModel: new Map([['gemini-4-hydrogen', 'schema = 2\ncapabilities = 1\nmodalities = "no"']]),
                labTomlByModel: new Map([['gemini-4-hydrogen', 'schema = 2\nlimit = 4']]),
                vertexPricingHtml: null,
                ephonePricingJson: null,
                litellmJson: null,
            },
            { now: NOW, refs: hydrogenRef }
        );
        expect(weird.candidates.length === 0, 'wrong shapes yield no assertions');
        expect(weird.warnings.length > 0, 'the wrong shapes are warned about');
        const json = compileOf({}, '{not json');
        expect(candidateOf(json, 'gemini-4-hydrogen') !== undefined, 'a broken api.json still leaves the TOML candidates');
        expect(json.warnings.some((warning) => warning.includes('api.json')), 'the broken api.json is warned about');
    })
);

// ---------------------------------------------------------------------------
// Canonical lab TOML fetch
// ---------------------------------------------------------------------------

interface StubOptions {
    readonly bodies?: ReadonlyMap<string, string>;
    readonly failing?: ReadonlySet<string>;
}

const catalogBodies = (): Map<string, string> => {
    const bodies = new Map<string, string>();
    for (const ref of CATALOG_MODEL_REFS) {
        if (ref.modelFile === '') continue;
        bodies.set(modelsDevTomlUrl(ref), fixture(`toml/${ref.model}.toml`));
    }
    bodies.set(VERTEX_PRICING_URL, fixture('vertex-pricing.html'));
    bodies.set(EPHONE_PRICING_URL, fixture('ephone-pricing.json'));
    bodies.set(LITELLM_PRICING_URL, fixture('litellm.json'));
    return bodies;
};

const stubFetcher =
    (options: StubOptions = {}): CatalogFetcher =>
    async (url: string) => {
        if (options.failing?.has(url) === true) return { status: 503, body: 'unavailable' };
        const body = (options.bodies ?? catalogBodies()).get(url);
        return body === undefined ? { status: 404, body: '' } : { status: 200, body };
    };

const providerWithBaseModel = (): Map<string, string> => {
    const bodies = new Map(catalogBodies());
    const ref = CATALOG_MODEL_REFS.find((candidate) => candidate.model === 'gemini-4-hydrogen');
    if (ref === undefined) throw new Error('no hydrogen ref');
    bodies.set(modelsDevTomlUrl(ref), `base_model = "google/gemini-4-hydrogen"\n${fixture('toml/gemini-4-hydrogen.toml')}`);
    bodies.set(modelsDevLabTomlUrl('google/gemini-4-hydrogen'), fixture('lab/gemini-4-hydrogen.toml'));
    return bodies;
};

results.push(
    await runCase('the lab URL is derived from the provider TOML base_model', async () => {
        expect(
            modelsDevLabTomlUrl('google/gemini-4-hydrogen') ===
                'https://raw.githubusercontent.com/sst/models.dev/dev/models/google/gemini-4-hydrogen.toml',
            `the canonical lab URL (got ${modelsDevLabTomlUrl('google/gemini-4-hydrogen')})`
        );
        expect(
            baseModelOfToml('schema = 2\nbase_model = "deepseek/deepseek-v4.1-flash-1017"\n') ===
                'deepseek/deepseek-v4.1-flash-1017',
            'base_model is read from the provider TOML'
        );
        expect(baseModelOfToml('schema = 2\n') === null, 'a provider TOML without base_model has none');
        expect(baseModelOfToml('not a toml [') === null, 'a broken body has none');
    })
);

results.push(
    await runCase('the lab TOML is fetched in the same batch and stored by our model id', async () => {
        const fetched = await fetchPriceCatalogs(stubFetcher({ bodies: providerWithBaseModel() }));
        expect(fetched.errors.length === 0, `no errors (got ${fetched.errors.join(' / ')})`);
        expect(
            fetched.warnings.length === 0,
            `no warnings (got ${fetched.warnings.join(' / ')})`
        );
        expect(fetched.documents.labTomlByModel.size === 1, `one lab document (got ${fetched.documents.labTomlByModel.size})`);
        expect(
            fetched.documents.labTomlByModel.get('gemini-4-hydrogen')?.includes('[limit]') === true,
            'the lab body is stored under our id'
        );
    })
);

results.push(
    await runCase('a model without base_model has no lab document and no warning', async () => {
        const fetched = await fetchPriceCatalogs(stubFetcher());
        expect(fetched.documents.tomlByModel.size === 16, 'the 16 provider TOMLs are still fetched');
        expect(fetched.documents.labTomlByModel.size === 0, 'no lab document is requested without base_model');
        expect(fetched.warnings.length === 0, `no warnings (got ${fetched.warnings.join(' / ')})`);
    })
);

results.push(
    await runCase('a dead lab document is a warning, never an error', async () => {
        const bodies = providerWithBaseModel();
        const labUrl = modelsDevLabTomlUrl('google/gemini-4-hydrogen');
        bodies.delete(labUrl);
        const fetched = await fetchPriceCatalogs(stubFetcher({ bodies, failing: new Set([labUrl]) }));
        expect(fetched.errors.length === 0, 'the price run still has its sources');
        expect(fetched.documents.labTomlByModel.size === 0, 'the lab document is absent');
        expect(
            fetched.warnings.some((warning) => warning.includes('canonical lab TOML')),
            `the failure is warned as a lab failure (got ${fetched.warnings.join(' / ')})`
        );
    })
);

// ---------------------------------------------------------------------------
// The differ: zero drift, overlay, risk controls
// ---------------------------------------------------------------------------

results.push(
    await runCase('the seed is the snapshot: a run over the downloaded catalogs finds no drift', async () => {
        const compiled = compileOf();
        const diff = diffCapabilityCandidates(compiled.candidates, seedModelCatalogEntries(), { now: NOW });
        expect(
            diff.drafts.length === 0,
            `no draft (got ${diff.drafts.map((draft) => `${draft.model}:${draft.changes.map((change) => change.field).join('+')}`).join(', ')})`
        );
        expect(diff.warnings.length === 0, `no warning (got ${diff.warnings.join(' / ')})`);
    })
);

results.push(
    await runCase('a value the seed lacks is proposed once, with the lab value', async () => {
        const compiled = compileOf();
        const entries = seedModelCatalogEntries().map((entry) =>
            entry.id === 'grok-4.7'
                ? { ...entry, capabilities: { ...entry.capabilities, outputTokens: null } }
                : entry
        );
        const diff = diffCapabilityCandidates(compiled.candidates, entries, { now: NOW });
        expect(diff.drafts.length === 1, `exactly one draft (got ${diff.drafts.length}: ${diff.drafts.map((draft) => draft.model).join(', ')})`);
        const draft = diff.drafts[0];
        if (draft === undefined) throw new Error('no draft');
        expect(draft.model === 'grok-4.7', `the draft is grok-4.7 (got ${draft.model})`);
        expect(
            draft.changes.length === 1 && draft.changes[0]?.field === 'outputTokens',
            `its only change is the unknown output limit (got ${JSON.stringify(draft.changes)})`
        );
        expect(draft.changes[0]?.oldValue === '未知' && draft.changes[0]?.newValue === '500000', '未知 -> 500000');
        expect(draft.payload.schema === 1, 'the payload is schema 1');
        expect(draft.payload.outputTokens === 500_000, 'the payload carries the proposed limit');
        expect(draft.payload.reasoningEffort.length === 4, 'the payload mirrors the legacy effort list');
    })
);

results.push(
    await runCase('a catalog row with matching data produces no draft at all', async () => {
        const compiled = compileOf();
        const hydrogen = requireCandidate(compiled, 'gemini-4-hydrogen');
        const seed = seedModelCatalogEntries();
        const diff = diffCapabilityCandidates([hydrogen], seed, { now: NOW });
        expect(diff.drafts.length === 0, `no draft (got ${diff.drafts.length})`);
        expect(diff.warnings.length === 0, 'no warnings either');
        const unchanged: CapabilityCandidate = {
            ...hydrogen,
            patch: { contextTokens: 1_048_576, tools: true, kind: 'chat' },
        };
        expect(diffCapabilityCandidates([unchanged], seed, { now: NOW }).drafts.length === 0, 'equal values never draft');
    })
);

results.push(
    await runCase('the overlay preserves local fields and only replaces asserted ones', async () => {
        const current = entryOf('gemini-4-hydrogen', {
            capabilities: {
                ...requireSeedCapabilities('gemini-4-hydrogen'),
                toolsMixing: 'allowed',
                nativeTools: { imageSearchGrounding: true },
                contextTokens: 1_000_000,
            },
        });
        const candidate = patchOf('gemini-4-hydrogen', {
            reasoning: { efforts: ['low', 'medium'] },
            contextTokens: 2_000_000,
        });
        const diff = diffCapabilityCandidates([candidate], [current], { now: NOW });
        expect(diff.drafts.length === 1, 'the change is drafted');
        const draft = diff.drafts[0];
        if (draft === undefined) throw new Error('no draft');
        expect(draft.payload.contextTokens === 2_000_000, 'the asserted limit is replaced');
        expect(draft.payload.toolsMixing === 'allowed', 'toolsMixing is never proposed away');
        expect(draft.payload.nativeTools?.imageSearchGrounding === true, 'nativeTools is never proposed away');
        expect(
            JSON.stringify(draft.payload.reasoning?.efforts) === '["low","medium"]',
            'the asserted effort list replaces the old one'
        );
        expect(draft.payload.reasoning?.defaultEffort === null, 'a default outside the new list is clamped');
        expect(
            JSON.stringify(draft.payload.reasoningEffort) === '["low","medium"]',
            'the legacy mirror follows the new list'
        );
        expect(draft.payload.tools === true && draft.payload.vision === true, 'unasserted fields keep the current values');
        expect(draft.payload.source === 'models-dev', 'upstream-asserted fields update the row provenance');
        expect(draft.baseline === current.capabilities, 'the baseline is the row capabilities snapshot');
        expect(draft.changes.some((change) => change.field === 'contextTokens'), 'the change is rendered');
        const fields = draft.changes.map((change) => change.field).join(',');
        expect(!fields.includes('toolsMixing') && !fields.includes('nativeTools'), 'local-only fields are not in the change list');
    })
);

results.push(
    await runCase('a legacy row is upgraded in place when upstream asserts a field', async () => {
        const legacy = seedModelCatalogEntries().find((entry) => entry.id === 'gpt-6-luna');
        if (legacy === undefined) throw new Error('no luna row');
        const current: ModelCatalogEntry = {
            ...legacy,
            capabilities: {
                kind: 'chat',
                vision: false,
                imageOutput: false,
                tools: true,
                reasoningEffort: ['low'],
                contextTokens: null,
                outputTokens: null,
            },
        };
        const diff = diffCapabilityCandidates([patchOf('gpt-6-luna', { contextTokens: 1_050_000 })], [current], { now: NOW });
        expect(diff.drafts.length === 1, 'the asserted limit drafts');
        const draft = diff.drafts[0];
        if (draft === undefined) throw new Error('no draft');
        expect(draft.payload.schema === 1, 'the payload is schema 1');
        expect(draft.payload.contextTokens === 1_050_000, 'the asserted limit is written');
        expect(draft.payload.kind === 'chat' && draft.payload.tools === true, 'the legacy fields are preserved');
    })
);

results.push(
    await runCase('risk controls: retired rows, auto-added rows and unknown rows are not drafted', async () => {
        const compiled = compileOf();
        const disabled = seedModelCatalogEntries().map((entry) =>
            entry.id === 'gemini-4-hydrogen' ? { ...entry, enabled: false } : entry
        );
        const disabledDiff = diffCapabilityCandidates(
            [patchOf('gemini-4-hydrogen', { contextTokens: 999 })],
            disabled,
            { now: NOW }
        );
        expect(disabledDiff.drafts.length === 0, 'a disabled row is never proposed');
        const addedDiff = diffCapabilityCandidates([patchOf('gemini-4-hydrogen', { contextTokens: 999 })], seedModelCatalogEntries(), {
            now: NOW,
            justAddedModels: ['gemini-4-hydrogen'],
        });
        expect(addedDiff.drafts.length === 0, 'a just auto-added row waits a run');
        const unknownDiff = diffCapabilityCandidates([patchOf('no-such-model', { tools: false })], seedModelCatalogEntries(), {
            now: NOW,
        });
        expect(unknownDiff.drafts.length === 0, 'a candidate that is not a catalog row is skipped');
        const seedOnly = candidateOf(compiled, 'gemini-nano-banana-2.1');
        if (seedOnly === undefined) throw new Error('no nano-banana candidate');
        expect(candidateOf(compiled, 'gemini-3.8-flash') !== undefined, 'a seed-only id still gets a candidate');
        expect(
            diffCapabilityCandidates([seedOnly], seedModelCatalogEntries(), { now: NOW }).drafts.length === 0,
            'a candidate with no catalog row has nothing to write'
        );
    })
);

results.push(
    await runCase('risk controls: at most eight proposals per run', async () => {
        const entries = seedModelCatalogEntries().slice(0, 10);
        const candidates = entries.map((entry, index) => patchOf(entry.id, { contextTokens: index + 1 }));
        const diff = diffCapabilityCandidates(candidates, seedModelCatalogEntries(), { now: NOW });
        expect(diff.drafts.length === 8, `the cap holds (got ${diff.drafts.length})`);
        expect(
            diff.warnings.some((warning) => warning.includes('上限')),
            `the truncation is warned about (got ${diff.warnings.join(' / ')})`
        );
    })
);

results.push(
    await runCase('locally maintained capabilities are never proposed over', async () => {
        const manualRow: ModelCatalogEntry = entryOf('gemini-4-hydrogen', {
            capabilities: { ...entryOf('gemini-4-hydrogen').capabilities, source: 'manual' },
        });
        const manualDiff = diffCapabilityCandidates([patchOf('gemini-4-hydrogen', { contextTokens: 999 })], [manualRow], {
            now: NOW,
        });
        expect(manualDiff.drafts.length === 0, 'a manual row is not drafted');
        expect(
            manualDiff.warnings.some((warning) => warning.includes('上游与本地覆盖不一致')),
            'the inconsistency is logged'
        );
        const seedReasoning = requireSeedCapabilities('gemini-4-hydrogen').reasoning;
        if (seedReasoning === undefined) throw new Error('the hydrogen seed lost its reasoning section');
        const probeReasoning: ModelCatalogEntry = entryOf('gemini-4-hydrogen', {
            capabilities: {
                ...entryOf('gemini-4-hydrogen').capabilities,
                reasoning: { ...seedReasoning, source: 'probe' },
            },
        });
        const mixedDiff = diffCapabilityCandidates(
            [patchOf('gemini-4-hydrogen', { contextTokens: 999, reasoning: { efforts: ['low'] } })],
            [probeReasoning],
            { now: NOW }
        );
        expect(mixedDiff.drafts.length === 1, 'the non-reasoning field still drafts');
        const draft = mixedDiff.drafts[0];
        if (draft === undefined) throw new Error('no draft');
        expect(
            JSON.stringify(draft.changes.map((change) => change.field)) === '["contextTokens"]',
            `only the context limit changes (got ${JSON.stringify(draft.changes)})`
        );
        expect(
            JSON.stringify(draft.payload.reasoning?.efforts) === '["low","medium","high","xhigh"]',
            'the probe reasoning list is untouched'
        );
        expect(draft.payload.reasoning?.source === 'probe', 'the probe provenance is untouched');

        const officialRow: ModelCatalogEntry = entryOf('gemini-4-hydrogen', {
            capabilities: {
                ...entryOf('gemini-4-hydrogen').capabilities,
                source: 'official',
                reasoning: { ...seedReasoning, source: 'official' },
            },
        });
        const officialDiff = diffCapabilityCandidates(
            [patchOf('gemini-4-hydrogen', { contextTokens: 999, reasoning: { efforts: ['low'] } })],
            [officialRow],
            { now: NOW }
        );
        expect(officialDiff.drafts.length === 0, 'an official row is not drafted (design §2.1: official = 人工 seed, 不进巡检)');
        expect(
            officialDiff.warnings.some(
                (warning) => warning.includes('官方文档') && warning.includes('上游与本地覆盖不一致')
            ),
            `the official inconsistency is logged with its source (got ${JSON.stringify(officialDiff.warnings)})`
        );
    })
);

reportResults(results);
