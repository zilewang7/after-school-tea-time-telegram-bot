/**
 * Offline cases for the price watcher's catalog half (pricing design
 * 2026-1113-1150 §5.2 / §8): fetch → compile → diff.
 *
 * The fetcher is always an injected stub reading trimmed copies of the real
 * 2026-11-13 snapshots under `fixtures/pricing/` — these cases never touch the
 * network. They pin down what the compiler must make of the catalogs:
 * - models.dev TOMLs: base prices, cache-write TTLs, the priority multiplier,
 *   scheduled `date.gte` windows, and the peak/off-peak base we refuse to
 *   compare (DeepSeek);
 * - the official Vertex page: current vs "starting 2026-12-01" rows, the
 *   Priority PayGo rows, and the nano-banana text-output correction;
 * - ephone/litellm: a gap filler and a warning-only cross-check;
 * - the differ: prices are compared, row identities are not — approved
 *   historical windows stay untouched, and only the scheduled change becomes
 *   a proposal.
 *
 * Run: pnpm test:offline price-watch
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';

const { CATALOG_MODEL_REFS, EPHONE_PRICING_URL, LITELLM_PRICING_URL, VERTEX_PRICING_URL, fetchPriceCatalogs, modelsDevTomlUrl } =
    await import('../../src/services/price-catalog-fetch.js');
const { compilePriceCandidates, diffPriceCandidates } = await import('../../src/services/price-catalog-compile.js');
const { seedPriceEntries } = await import('../../src/config/model-pricing.js');

type CatalogFetcher = import('../../src/services/price-catalog-types.js').CatalogFetcher;
type CatalogFetchResult = import('../../src/services/price-catalog-types.js').CatalogFetchResult;
type PriceCandidate = import('../../src/services/price-catalog-types.js').PriceCandidate;
type PriceEntry = import('../../src/config/model-pricing.js').PriceEntry;
type PriceTier = import('../../src/config/model-pricing.js').PriceTier;

const FIXTURE_DIRECTORY = fileURLToPath(new URL('./fixtures/pricing/', import.meta.url));
const fixture = (relativePath: string): string => readFileSync(join(FIXTURE_DIRECTORY, relativePath), 'utf8');

/** The fixed run clock: 2026-11-13, the day the snapshots were taken */
const NOW = new Date('2026-11-13T04:30:00Z');
/** What the compiler must use as the start of "the price in force today" */
const RUN_FROM = new Date('2026-11-13T04:30:00Z');
const DECEMBER_EVENT = new Date('2026-12-01T00:00:00Z');
const JANUARY_EVENT = new Date('2027-01-01T00:00:00Z');

const BODIES = ((): ReadonlyMap<string, string> => {
    const bodies = new Map<string, string>();
    for (const ref of CATALOG_MODEL_REFS) {
        if (ref.modelFile === '') continue;
        bodies.set(modelsDevTomlUrl(ref), fixture(`toml/${ref.model}.toml`));
    }
    bodies.set(VERTEX_PRICING_URL, fixture('vertex-pricing.html'));
    bodies.set(EPHONE_PRICING_URL, fixture('ephone-pricing.json'));
    bodies.set(LITELLM_PRICING_URL, fixture('litellm.json'));
    return bodies;
})();

interface StubOptions {
    /** Bodies replacing the fixture ones, by URL */
    readonly bodies?: ReadonlyMap<string, string>;
    /** URLs answered with 503 */
    readonly failing?: ReadonlySet<string>;
    /** URLs whose fetch rejects */
    readonly throwing?: ReadonlySet<string>;
}

const stubFetcher =
    (options: StubOptions = {}): CatalogFetcher =>
    async (url: string) => {
        if (options.throwing?.has(url) === true) throw new Error('network is down');
        if (options.failing?.has(url) === true) return { status: 503, body: 'unavailable' };
        const body = (options.bodies ?? BODIES).get(url);
        return body === undefined ? { status: 404, body: '' } : { status: 200, body };
    };

const withBodies = (replacements: ReadonlyMap<string, string>): ReadonlyMap<string, string> => {
    const bodies = new Map(BODIES);
    for (const [url, body] of replacements) bodies.set(url, body);
    return bodies;
};

interface Pipeline {
    readonly fetched: CatalogFetchResult;
    readonly candidates: readonly PriceCandidate[];
    readonly warnings: readonly string[];
}

const runPipeline = async (options: StubOptions = {}, now: Date = NOW): Promise<Pipeline> => {
    const fetched = await fetchPriceCatalogs(stubFetcher(options));
    const compiled = compilePriceCandidates(fetched, { now });
    return { fetched, candidates: compiled.candidates, warnings: compiled.warnings };
};

const urlOfModel = (model: string): string => {
    const ref = CATALOG_MODEL_REFS.find((candidate) => candidate.model === model);
    if (ref === undefined) throw new Error(`no ref for ${model}`);
    return modelsDevTomlUrl(ref);
};

const candidateOf = (
    candidates: readonly PriceCandidate[],
    model: string,
    tier: PriceTier,
    from?: Date
): PriceCandidate | undefined =>
    candidates.find(
        (candidate) =>
            candidate.entry.model === model &&
            candidate.entry.tier === tier &&
            (from === undefined || candidate.entry.effectiveFrom.getTime() === from.getTime())
    );

const requireCandidate = (candidates: readonly PriceCandidate[], model: string, tier: PriceTier, from?: Date): PriceCandidate => {
    const candidate = candidateOf(candidates, model, tier, from);
    if (candidate === undefined) throw new Error(`no candidate for ${model}/${tier}`);
    return candidate;
};

/** Exact float comparison is fine here: these are sums of one or two factors */
const isNear = (actual: number | undefined, expected: number): boolean =>
    actual !== undefined && Math.abs(actual - expected) < 1e-9;

const draftsOf = (drafts: readonly import('../../src/services/price-catalog-types.js').ProposalDraft[], model: string) =>
    drafts.filter((draft) => draft.model === model);

const rowOf = (
    model: string,
    tier: PriceTier,
    values: { readonly input: number; readonly cached: number; readonly output: number },
    from: Date,
    to: Date | undefined
): PriceEntry => ({
    model,
    tier,
    inputPerM: values.input,
    cachedInputPerM: values.cached,
    outputPerM: values.output,
    effectiveFrom: from,
    ...(to === undefined ? {} : { effectiveTo: to }),
    source: 'manual',
    sourceUrl: 'https://example.invalid/pricing',
    checkedOn: '2026-11-07',
    confidence: 'high',
});

const results: CaseResult[] = [];

results.push(
    await runCase('every catalog is fetched in one go and none fails', async () => {
        const pipeline = await runPipeline();
        expect(pipeline.fetched.documents.tomlByModel.size === 16, `16 TOMLs (got ${pipeline.fetched.documents.tomlByModel.size})`);
        expect(pipeline.fetched.documents.vertexPricingHtml !== null, 'the Vertex page body is stored');
        expect(pipeline.fetched.documents.ephonePricingJson !== null, 'the ephone JSON is stored');
        expect(pipeline.fetched.documents.litellmJson !== null, 'the LiteLLM JSON is stored');
        expect(pipeline.fetched.errors.length === 0, `no errors (got ${pipeline.fetched.errors.join(' / ')})`);
        expect(pipeline.fetched.warnings.length === 0, `no warnings (got ${pipeline.fetched.warnings.join(' / ')})`);
    })
);

results.push(
    await runCase('a single dead TOML only loses that one model', async () => {
        const pipeline = await runPipeline({
            failing: new Set([urlOfModel('gpt-6-luna')]),
            throwing: new Set([urlOfModel('gpt-6-sol')]),
        });
        expect(pipeline.fetched.documents.tomlByModel.size === 14, 'the other 14 TOMLs are there');
        const fetchWarnings = pipeline.fetched.warnings.join(' | ');
        expect(fetchWarnings.includes('gpt-6-luna') && fetchWarnings.includes('gpt-6-sol'), `both failures warned (got ${fetchWarnings})`);
        expect(pipeline.fetched.errors.length === 0, 'a TOML failure is not a whole-source error');
        expect(candidateOf(pipeline.candidates, 'gpt-6-astra', 'standard') !== undefined, 'the rest compiles');
        expect(candidateOf(pipeline.candidates, 'gpt-6-luna', 'standard') === undefined, 'the dead model has no price');
    })
);

results.push(
    await runCase('the models.dev priority multiplier becomes a priority row', async () => {
        const pipeline = await runPipeline();
        const hydrogen = requireCandidate(pipeline.candidates, 'gemini-4-hydrogen', 'priority');
        expect(isNear(hydrogen.entry.inputPerM, 2.7), `hydrogen priority input 2.70 (got ${hydrogen.entry.inputPerM})`);
        expect(isNear(hydrogen.entry.cachedInputPerM, 0.135), 'hydrogen priority cache read 0.135');
        expect(isNear(hydrogen.entry.outputPerM, 13.5), 'hydrogen priority output 13.50');
        expect(hydrogen.sourceKind === 'official', 'the official page wins for Gemini');
        const luna = requireCandidate(pipeline.candidates, 'gpt-6-luna', 'priority');
        expect(isNear(luna.entry.inputPerM, 0.2) && isNear(luna.entry.outputPerM, 1), 'gpt-6-luna priority is the TOML ×2');
        expect(luna.sourceKind === 'models-dev', 'a TOML-only model stays models-dev');
        const grok = requireCandidate(pipeline.candidates, 'grok-4.7', 'priority');
        expect(isNear(grok.entry.inputPerM, 4) && isNear(grok.entry.outputPerM, 12), 'grok-4.7 priority ×2');
    })
);

results.push(
    await runCase('official promo rows become the current price and the scheduled window', async () => {
        const pipeline = await runPipeline();
        const argonNow = requireCandidate(pipeline.candidates, 'gemini-4-argon', 'standard', RUN_FROM);
        expect(isNear(argonNow.entry.inputPerM, 2) && isNear(argonNow.entry.outputPerM, 10), 'argon promo 2/10 today');
        expect(argonNow.entry.effectiveTo?.getTime() === DECEMBER_EVENT.getTime(), 'today price ends at the 12-01 boundary');
        const argonFuture = requireCandidate(pipeline.candidates, 'gemini-4-argon', 'standard', DECEMBER_EVENT);
        expect(isNear(argonFuture.entry.inputPerM, 4) && isNear(argonFuture.entry.cachedInputPerM, 0.2), 'argon 4/0.20 from 12-01');
        expect(isNear(argonFuture.entry.outputPerM, 20), 'argon output 20 from 12-01');
        const argonPriority = requireCandidate(pipeline.candidates, 'gemini-4-argon', 'priority', DECEMBER_EVENT);
        expect(isNear(argonPriority.entry.inputPerM, 7.2) && isNear(argonPriority.entry.outputPerM, 36), 'argon priority 7.2/36 from 12-01');
        const carbonFuture = requireCandidate(pipeline.candidates, 'gemini-4-carbon', 'standard', DECEMBER_EVENT);
        expect(isNear(carbonFuture.entry.inputPerM, 4), 'carbon doubles with argon');
        const flashCurrent = requireCandidate(pipeline.candidates, 'gemini-3.8-flash', 'standard', RUN_FROM);
        expect(isNear(flashCurrent.entry.inputPerM, 0.75), '3.8-flash introductory price today');
        const flashFuture = requireCandidate(pipeline.candidates, 'gemini-3.8-flash', 'standard', JANUARY_EVENT);
        expect(isNear(flashFuture.entry.inputPerM, 1.5) && isNear(flashFuture.entry.cachedInputPerM, 0.15), '3.8-flash doubles from 2027-01-01');
    })
);

results.push(
    await runCase('the official page fixes the nano-banana text output the TOML folds', async () => {
        const pipeline = await runPipeline();
        const standard = requireCandidate(pipeline.candidates, 'gemini-nano-banana-2.1', 'standard');
        expect(isNear(standard.entry.outputPerM, 7.5), `text output is the official 7.50 (got ${standard.entry.outputPerM})`);
        expect(isNear(standard.entry.imageOutputPerM, 30), 'image output stays 30');
        expect(isNear(standard.entry.cachedInputPerM, 0.15), 'cache read 0.15');
        expect(standard.sourceKind === 'official', 'the official row is used');
        const priority = requireCandidate(pipeline.candidates, 'gemini-nano-banana-2.1', 'priority');
        expect(isNear(priority.entry.inputPerM, 2.7) && isNear(priority.entry.outputPerM, 13.5), 'nano-banana priority 2.7/13.5');
        const mismatch = pipeline.warnings.find((warning) => warning.includes('nano-banana') && warning.includes('不一致'));
        expect(mismatch !== undefined && mismatch.includes('30.00') && mismatch.includes('7.5'), `the TOML defect is reported (got ${String(mismatch)})`);
    })
);

results.push(
    await runCase('candidates start at the run instant, future windows keep their boundary', async () => {
        const pipeline = await runPipeline();
        for (const candidate of pipeline.candidates) {
            expect(
                candidate.entry.effectiveFrom.getTime() >= RUN_FROM.getTime(),
                `${candidate.entry.model}/${candidate.entry.tier} never starts before the run`
            );
            expect(
                candidate.entry.effectiveFrom.getTime() === RUN_FROM.getTime() || candidate.entry.effectiveFrom.getTime() === DECEMBER_EVENT.getTime() || candidate.entry.effectiveFrom.getTime() === JANUARY_EVENT.getTime(),
                `${candidate.entry.model}/${candidate.entry.tier} starts at the run or a stated boundary (got ${candidate.entry.effectiveFrom.toISOString()})`
            );
        }
        const currentOnes = pipeline.candidates.filter((candidate) => candidate.entry.effectiveFrom.getTime() === RUN_FROM.getTime());
        expect(currentOnes.length > 0, 'there are current-price candidates');
        const later = await runPipeline({}, new Date('2026-12-02T10:00:00Z'));
        const argon = requireCandidate(later.candidates, 'gemini-4-argon', 'standard');
        expect(isNear(argon.entry.inputPerM, 4) && isNear(argon.entry.outputPerM, 20), 'after 12-01 the same window is the current price');
        expect(argon.entry.effectiveFrom.getTime() === new Date('2026-12-02T10:00:00Z').getTime(), 'retimed to that run');
    })
);

results.push(
    await runCase('the peak/off-peak catalog price is not compared against our peak table', async () => {
        const pipeline = await runPipeline();
        expect(candidateOf(pipeline.candidates, 'deepseek-flash', 'standard') === undefined, 'no deepseek candidate');
        expect(
            pipeline.warnings.some((warning) => warning.includes('deepseek-flash') && warning.includes('峰谷')),
            `the reason is a warning (got ${pipeline.warnings.join(' | ')})`
        );
    })
);

results.push(
    await runCase('cache write comes from the 5m TTL, OpenAI keeps none', async () => {
        const pipeline = await runPipeline();
        const sonnet = requireCandidate(pipeline.candidates, 'claude-sonnet-5-5', 'standard');
        expect(isNear(sonnet.entry.cacheWritePerM, 2.5), `sonnet-5-5 cache write 2.5 (got ${String(sonnet.entry.cacheWritePerM)})`);
        const luna = requireCandidate(pipeline.candidates, 'gpt-6-luna', 'standard');
        expect(luna.entry.cacheWritePerM === undefined, 'GPT writes have 30m/12h TTLs, so no cache-write price');
        expect(
            pipeline.warnings.some((warning) => warning.includes('gpt-6-luna') && warning.includes('30m') && warning.includes('12h')),
            'the skipped TTL choice is reported'
        );
    })
);

results.push(
    await runCase('a relay-only image id stays unpriced when ephone quotes CNY', async () => {
        const pipeline = await runPipeline();
        expect(candidateOf(pipeline.candidates, 'gpt-image-2.5-dev', 'standard') === undefined, 'no candidate');
        expect(
            pipeline.warnings.some((warning) => warning.includes('gpt-image-2.5-dev') && warning.includes('CNY')),
            `the reason is a warning (got ${pipeline.warnings.join(' | ')})`
        );
    })
);

results.push(
    await runCase('a USD per-call ephone price would price the image model per image', async () => {
        const ephone = {
            data: {
                model_info: [
                    {
                        model_name: 'gpt-image-2.5-dev',
                        price_config: {
                            original_price: {
                                conditions: [{ price: { quota_type: 'call', currency: 'USD', model_price: 0.06 } }],
                            },
                        },
                    },
                ],
            },
        };
        const bodies = withBodies(new Map([[EPHONE_PRICING_URL, JSON.stringify(ephone)]]));
        const pipeline = await runPipeline({ bodies });
        const candidate = requireCandidate(pipeline.candidates, 'gpt-image-2.5-dev', 'standard');
        expect(candidate.sourceKind === 'ephone' && candidate.entry.confidence === 'low', 'an ephone-only image row');
        expect(isNear(candidate.entry.perImageUsd, 0.06), `the per-call price becomes perImageUsd (got ${String(candidate.entry.perImageUsd)})`);
        const diff = diffPriceCandidates(pipeline.candidates, seedPriceEntries(), { now: NOW });
        const draft = diff.drafts.find((candidateDraft) => candidateDraft.model === 'gpt-image-2.5-dev');
        expect(draft !== undefined && draft.kind === 'new_model', 'the unpriced image model becomes a new_model proposal');
        expect(isNear(draft?.entry.perImageUsd, 0.06), 'the proposal keeps the per-image price');
    })
);

results.push(
    await runCase('every candidate carries its source URL, check date and confidence', async () => {
        const pipeline = await runPipeline();
        const argon = requireCandidate(pipeline.candidates, 'gemini-4-argon', 'standard');
        expect(argon.entry.source === 'official', 'Gemini rows say official');
        expect(argon.entry.sourceUrl === VERTEX_PRICING_URL, 'the official URL is recorded');
        expect(argon.entry.confidence === 'high', 'official is high confidence');
        expect(argon.entry.checkedOn === '2026-11-13', `checkedOn is the run day (got ${argon.entry.checkedOn})`);
        const luna = requireCandidate(pipeline.candidates, 'gpt-6-luna', 'standard');
        expect(luna.entry.source === 'models-dev' && luna.entry.sourceUrl === urlOfModel('gpt-6-luna'), 'TOML provenance');
        expect(luna.entry.confidence === 'medium', 'models.dev is medium confidence');
        expect(luna.note !== null && luna.note.includes('LiteLLM 一致'), `the cross-check result is in the note (got ${String(luna.note)})`);
        expect(luna.entry.note !== undefined, 'the row itself carries the note too');
    })
);

results.push(
    await runCase('a broken Vertex page degrades to the TOML values without throwing', async () => {
        const bodies = withBodies(new Map([[VERTEX_PRICING_URL, '<!doctype html><html><body><p>no tables here</p></body></html>']]));
        const pipeline = await runPipeline({ bodies });
        expect(pipeline.warnings.some((warning) => warning.includes('官方 Vertex 页')), `the page is reported (got ${pipeline.warnings.join(' | ')})`);
        const hydrogen = requireCandidate(pipeline.candidates, 'gemini-4-hydrogen', 'standard');
        expect(isNear(hydrogen.entry.inputPerM, 1.5) && hydrogen.sourceKind === 'models-dev', 'the TOML value still arrives');
        const nano = requireCandidate(pipeline.candidates, 'gemini-nano-banana-2.1', 'standard');
        expect(isNear(nano.entry.outputPerM, 30), `without the official page the TOML folds the output to 30 (got ${nano.entry.outputPerM})`);
    })
);

results.push(
    await runCase('a malformed TOML and broken JSON only warn', async () => {
        const bodies = withBodies(
            new Map([
                [urlOfModel('gpt-6-astra'), 'this is [not a toml'],
                [EPHONE_PRICING_URL, 'not json at all'],
                [LITELLM_PRICING_URL, '{broken'],
            ])
        );
        const pipeline = await runPipeline({ bodies });
        expect(pipeline.warnings.some((warning) => warning.includes('gpt-6-astra') && warning.includes('解析失败')), 'the TOML parse failure is a warning');
        expect(pipeline.warnings.some((warning) => warning.includes('ephone') && warning.includes('解析失败')), 'the ephone JSON failure is a warning');
        expect(pipeline.warnings.some((warning) => warning.includes('LiteLLM') && warning.includes('解析失败')), 'the LiteLLM JSON failure is a warning');
        expect(candidateOf(pipeline.candidates, 'gpt-6-luna', 'standard') !== undefined, 'the rest still compiles');
    })
);

results.push(
    await runCase('ephone fills a model the other sources cannot price', async () => {
        // Both the TOML (404) and the official page (503) are down for carbon
        const bodies = new Map(BODIES);
        bodies.delete(urlOfModel('gemini-4-carbon'));
        const fetched = await fetchPriceCatalogs(stubFetcher({ bodies, failing: new Set([VERTEX_PRICING_URL]) }));
        expect(fetched.documents.tomlByModel.has('gemini-4-carbon') === false, 'the carbon TOML is gone');
        const compiled = compilePriceCandidates(fetched, { now: NOW });
        const carbon = requireCandidate(compiled.candidates, 'gemini-4-carbon', 'standard');
        expect(carbon.sourceKind === 'ephone', 'ephone is the fallback source');
        expect(carbon.entry.source === 'ephone' && carbon.entry.confidence === 'low', 'low-confidence ephone row');
        expect(carbon.entry.sourceUrl === EPHONE_PRICING_URL, 'the ephone URL is recorded');
        expect(isNear(carbon.entry.inputPerM, 4) && isNear(carbon.entry.outputPerM, 20), 'the ephone value is compiled as-is');
    })
);

results.push(
    await runCase('a mismatch against LiteLLM only warns and does not move the price', async () => {
        const isRecord = (value: unknown): value is Record<string, unknown> =>
            typeof value === 'object' && value !== null && !Array.isArray(value);
        const litellm: unknown = JSON.parse(fixture('litellm.json'));
        if (!isRecord(litellm)) throw new Error('the LiteLLM fixture is not an object');
        const luna = litellm['gpt-6-luna'];
        if (!isRecord(luna)) throw new Error('the LiteLLM fixture lacks gpt-6-luna');
        luna.input_cost_per_token = 1.5e-7;
        const bodies = withBodies(new Map([[LITELLM_PRICING_URL, JSON.stringify(litellm)]]));
        const pipeline = await runPipeline({ bodies });
        expect(
            pipeline.warnings.some((warning) => warning.includes('gpt-6-luna') && warning.includes('LiteLLM 与主源不一致')),
            `the mismatch is a warning (got ${pipeline.warnings.join(' | ')})`
        );
        const candidate = requireCandidate(pipeline.candidates, 'gpt-6-luna', 'standard');
        expect(isNear(candidate.entry.inputPerM, 0.1), 'the candidate still holds the catalog value');
        expect(candidate.note !== null && !candidate.note.includes('LiteLLM 一致'), 'no "LiteLLM agrees" note on a mismatch');
    })
);

results.push(
    await runCase('diff: today matches the table, only the missing priority tiers are proposed', async () => {
        const pipeline = await runPipeline();
        const diff = diffPriceCandidates(pipeline.candidates, seedPriceEntries(), { now: NOW });
        const proposed = diff.drafts.map((draft) => `${draft.model}/${draft.tier}`).sort();
        expect(
            JSON.stringify(proposed) ===
                JSON.stringify(['gpt-6-astra/priority', 'gpt-6-luna/priority', 'gpt-6-sol/priority', 'grok-4.20-multi-agent-0309/priority', 'grok-4.7/priority']),
            `exactly the five missing priority tiers (got ${proposed.join(', ')})`
        );
        for (const draft of diff.drafts) {
            expect(draft.kind === 'update' && draft.baseline === null, `${draft.model}/${draft.tier} is a new tier, not a replacement`);
            expect(draft.entry.effectiveFrom.getTime() === RUN_FROM.getTime(), 'starts at the run instant');
            expect(draft.note.includes('新增档位'), `the note says new tier (got ${draft.note})`);
        }
        expect(draftsOf(diff.drafts, 'gemini-4-argon').length === 0, 'the matching 12-01 window already in the table is not re-proposed');
        expect(
            diff.warnings.some((warning) => warning.includes('deepseek-flash') && warning.includes('源缺价')),
            'the model no source could price is reported'
        );
    })
);

results.push(
    await runCase('diff: a drifted price is proposed with the row it replaces', async () => {
        const pipeline = await runPipeline();
        const current = [
            ...seedPriceEntries().filter((row) => row.model !== 'gemini-4-hydrogen'),
            { ...rowOf('gemini-4-hydrogen', 'standard', { input: 0.75, cached: 0.075, output: 3.75 }, new Date('1970-01-01T00:00:00Z'), undefined) },
        ];
        const diff = diffPriceCandidates(pipeline.candidates, current, { now: NOW });
        const hydrogen = draftsOf(diff.drafts, 'gemini-4-hydrogen');
        const standard = hydrogen.find((draft) => draft.tier === 'standard');
        expect(standard !== undefined, 'the drifted standard price is proposed');
        expect(standard?.kind === 'update' && standard.baseline !== null, 'it replaces the in-force row');
        expect(isNear(standard?.baseline?.inputPerM, 0.75), 'the baseline is the old price');
        expect(isNear(standard?.entry.inputPerM, 1.5) && isNear(standard?.entry.outputPerM, 7.5), 'the new price is the catalog one');
        expect(standard?.entry.effectiveFrom.getTime() === RUN_FROM.getTime(), 'the new row starts at the run instant');
        expect(standard?.note.includes('0.75/0.075/3.75') === true, `the note shows old and new (got ${String(standard?.note)})`);
        const priority = hydrogen.find((draft) => draft.tier === 'priority');
        expect(priority !== undefined && priority.baseline === null, 'the missing priority tier comes with it');
    })
);

results.push(
    await runCase('diff: approved history is never compared or reverted', async () => {
        const pipeline = await runPipeline();
        const historical = rowOf(
            'gemini-4-hydrogen',
            'standard',
            { input: 3, cached: 0.3, output: 15 },
            new Date('2025-01-01T00:00:00Z'),
            new Date('2025-06-01T00:00:00Z')
        );
        const diff = diffPriceCandidates(pipeline.candidates, [...seedPriceEntries(), historical], { now: NOW });
        expect(draftsOf(diff.drafts, 'gemini-4-hydrogen').length === 0, 'the closed 2025 window raises no proposal');
        expect(diff.drafts.every((draft) => draft.entry.effectiveFrom.getTime() >= RUN_FROM.getTime()), 'no proposal writes into the past');
    })
);

results.push(
    await runCase('diff: a scheduled window missing from the table is proposed at its boundary', async () => {
        const pipeline = await runPipeline();
        const withoutFuture = seedPriceEntries().filter((row) => row.effectiveFrom.getTime() < new Date('2026-11-01T00:00:00Z').getTime());
        const diff = diffPriceCandidates(pipeline.candidates, withoutFuture, { now: NOW });
        for (const model of ['gemini-4-argon', 'gemini-4-carbon']) {
            for (const tier of ['standard', 'priority'] as const) {
                const draft = draftsOf(diff.drafts, model).find(
                    (candidate) => candidate.tier === tier && candidate.entry.effectiveFrom.getTime() === DECEMBER_EVENT.getTime()
                );
                if (draft === undefined) throw new Error(`${model}/${tier} 12-01 window is missing`);
                expect(draft.entry.effectiveFrom.getTime() === DECEMBER_EVENT.getTime(), 'at the exact boundary');
                expect(draft.entry.effectiveFrom.getTime() > NOW.getTime(), 'in the future');
                expect(draft.entry.effectiveTo === undefined, 'open-ended');
            }
        }
        const argonStandard = draftsOf(diff.drafts, 'gemini-4-argon').find(
            (draft) => draft.tier === 'standard' && draft.entry.effectiveFrom.getTime() === DECEMBER_EVENT.getTime()
        );
        expect(argonStandard?.baseline === null, 'no row is in force at the exclusive boundary, so nothing is replaced');
        expect(isNear(argonStandard?.entry.inputPerM, 4) && isNear(argonStandard?.entry.outputPerM, 20), 'the new window carries 4/20');
    })
);

results.push(
    await runCase('diff: the new 12-01 row is not proposed again, but a changed one is', async () => {
        const pipeline = await runPipeline();
        const seeded = seedPriceEntries();
        const consistent = diffPriceCandidates(pipeline.candidates, seeded, { now: NOW });
        expect(draftsOf(consistent.drafts, 'gemini-4-argon').length === 0, 'the row already at 12-01 matches');

        const changed = seeded.map((row) =>
            row.model === 'gemini-4-argon' && row.tier === 'standard' && row.effectiveFrom.getTime() === DECEMBER_EVENT.getTime()
                ? { ...row, inputPerM: 9, cachedInputPerM: 0.9, outputPerM: 45 }
                : row
        );
        const diff = diffPriceCandidates(pipeline.candidates, changed, { now: NOW });
        const draft = draftsOf(diff.drafts, 'gemini-4-argon').find((candidate) => candidate.tier === 'standard');
        expect(draft !== undefined && draft.kind === 'update', 'the wrong future row is replaced');
        expect(draft?.baseline?.inputPerM === 9, 'the baseline is the row at the same start');
        expect(draft?.entry.effectiveFrom.getTime() === DECEMBER_EVENT.getTime(), 'the replacement keeps the boundary');
    })
);

results.push(
    await runCase('diff: a model with no row at all becomes a new-model proposal', async () => {
        const pipeline = await runPipeline();
        const withoutSonnet = seedPriceEntries().filter((row) => row.model !== 'claude-sonnet-5-5');
        const diff = diffPriceCandidates(pipeline.candidates, withoutSonnet, { now: NOW });
        const draft = draftsOf(diff.drafts, 'claude-sonnet-5-5').find((candidate) => candidate.tier === 'standard');
        expect(draft !== undefined && draft.kind === 'new_model', 'a never-priced model is new_model');
        expect(draft?.baseline === null, 'nothing to replace');
        expect(draft?.entry.effectiveFrom.getTime() === RUN_FROM.getTime(), 'starts at the run instant');
        expect(draft?.note.includes('新模型') === true, `the note says so (got ${String(draft?.note)})`);
    })
);

results.push(
    await runCase('diff: an expiring window without a successor becomes a reminder', async () => {
        const pipeline = await runPipeline();
        const current = [
            ...seedPriceEntries().filter((row) => row.model !== 'gpt-6-luna'),
            { ...rowOf('gpt-6-luna', 'standard', { input: 0.1, cached: 0.01, output: 0.5 }, new Date('1970-01-01T00:00:00Z'), new Date('2026-11-16T00:00:00Z')) },
        ];
        const diff = diffPriceCandidates(pipeline.candidates, current, { now: NOW });
        const expiry = diff.drafts.find((draft) => draft.kind === 'expiry' && draft.model === 'gpt-6-luna');
        expect(expiry !== undefined, 'the expiring row is reported');
        expect(expiry?.tier === 'standard' && expiry.baseline === null, 'a reminder has no baseline');
        expect(expiry?.note.includes('到期') === true, `the note says so (got ${String(expiry?.note)})`);
        expect(
            diff.drafts.every((draft) => draft.kind !== 'expiry' || draft.model !== 'gemini-4-argon'),
            'a row with a known successor is not an expiry'
        );
    })
);

results.push(
    await runCase('diff: a sub-0.5% difference is the same price', async () => {
        const pipeline = await runPipeline();
        const base = requireCandidate(pipeline.candidates, 'gemini-4-argon', 'standard', RUN_FROM);
        const nudged: PriceCandidate = { ...base, entry: { ...base.entry, inputPerM: 2.008 } };
        const candidates = pipeline.candidates.map((candidate) => (candidate === base ? nudged : candidate));
        const diff = diffPriceCandidates(candidates, seedPriceEntries(), { now: NOW });
        const argonAtNow = draftsOf(diff.drafts, 'gemini-4-argon').filter((draft) => draft.entry.effectiveFrom.getTime() === RUN_FROM.getTime());
        expect(argonAtNow.length === 0, 'a 0.4% drift stays under the tolerance');
    })
);

results.push(
    await runCase('diff: an implausible jump is refused instead of proposed', async () => {
        const pipeline = await runPipeline();
        const base = requireCandidate(pipeline.candidates, 'gemini-4-hydrogen', 'standard', RUN_FROM);
        const inflated: PriceCandidate = { ...base, entry: { ...base.entry, inputPerM: 150, outputPerM: 750 } };
        const candidates = pipeline.candidates.map((candidate) => (candidate === base ? inflated : candidate));
        const diff = diffPriceCandidates(candidates, seedPriceEntries(), { now: NOW });
        expect(draftsOf(diff.drafts, 'gemini-4-hydrogen').length === 0, 'no hydrogen proposal');
        expect(
            diff.warnings.some((warning) => warning.includes('gemini-4-hydrogen') && warning.includes('涨幅超过')),
            `the jump is warned about (got ${diff.warnings.join(' | ')})`
        );
    })
);

reportResults(results);
