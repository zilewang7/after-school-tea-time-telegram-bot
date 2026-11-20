/**
 * The price watcher: one run fetches the catalogs, compiles the table they
 * imply, diffs it against the rows in force, records proposals and asks the
 * owner from a private chat (pricing design 2026-1113-1150).
 *
 * The same run also compiles the model-capability half from the documents it
 * already downloaded (thinking-effort design 2026-1113-1742 §2.3): capability
 * proposals go out in their own private message after the price one, and a
 * change only lands in the catalog after the owner presses its button.
 *
 * Runs in the bot process because the approval is a Telegram message with
 * inline buttons: the daily timer and the owner's `/pricing` share one path
 * and one lock. Everything here is best-effort: a failed source, a slow CDN
 * or an unreachable Telegram never touches the reply path — errors are logged
 * and recorded on the run row, and the previous price table keeps working.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Api } from 'grammy';
import { isTestInstance } from '../config/instance.js';
import type { PlatformLaneFingerprints } from '../config/model-capabilities.js';
import { isJsonObject } from '../shared/json-object.js';
import { familyLineOf, productLineOf, versionOf } from '../shared/model-line.js';
import { getOwnerUserId } from '../config/owner.js';
import {
    allPriceEntries,
    seedPriceEntries,
    type PriceEntry,
} from '../config/model-pricing.js';
import {
    findModelCatalogEntry,
    listAllModelCatalog,
    modelCatalogVersion,
    platformOfModelId,
    type ModelCatalogCapabilities,
    type ModelCatalogEntry,
} from '../config/model-catalog.js';
import {
    createOrRefreshProposals,
    expireStaleProposals,
    finishWatchRun,
    isPriceProposalDueForNotification,
    loadPriceTableMeta,
    listPendingProposals,
    loadModelPrices,
    priceWatchStatus,
    startWatchRun,
} from './model-price-service.js';
import {
    countPendingCapabilityProposals,
    createOrRefreshCapabilityProposals,
    expireStaleCapabilityProposals,
    isCapabilityProposalDueForNotification,
    listPendingCapabilityProposals,
} from './model-capability-service.js';
import {
    listActiveModelIdsFromMetrics,
    listRecentCapabilityEventMetrics,
} from '../db/queries/reply-metrics.js';
import {
    addCatalogModels,
    ensureReferenceCatalogRows,
} from './model-catalog-service.js';
import {
    diffPriceCandidates,
    compilePriceCandidates,
} from './price-catalog-compile.js';
import {
    compileCapabilityObservations,
    compileTrafficContradictions,
    diffCapabilityCandidates,
    mergeCapabilityDrafts,
} from './capability-catalog-compile.js';
import { catalogModelRefs, fetchPriceCatalogs } from './price-catalog-fetch.js';
import type { CatalogFetcher, ProposalDraft } from './price-catalog-types.js';
import {
    sendModelCatalogNotice,
    sendOwnerNotice,
    sendProposalMessage,
} from './price-proposal-notify.js';
import { sendCapabilityProposalMessage } from './capability-proposal-notify.js';

/** How one run ended; `busy`/`disabled` never touched the network */
export interface WatchRunResult {
    readonly outcome: 'ok' | 'failed' | 'busy' | 'disabled';
    /** Pending price proposals after the run */
    readonly proposals: number;
    /** Pending capability proposals after the run */
    readonly capabilityProposals: number;
    /** Private-chat messages the run sent (0 when nothing needed approval) */
    readonly messageIds: readonly number[];
    /** Models the run added to the menu automatically */
    readonly addedModels: readonly string[];
    readonly warnings: readonly string[];
    readonly errors: readonly string[];
}

const DISABLED: WatchRunResult = {
    outcome: 'disabled',
    proposals: 0,
    capabilityProposals: 0,
    messageIds: [],
    addedModels: [],
    warnings: [],
    errors: [],
};

/** Providers whose models we can serve: canonical vendors of our routes */
const DISCOVERY_PROVIDERS: ReadonlySet<string> = new Set([
    'openai',
    'anthropic',
    'google-vertex',
    'deepseek',
    'xai',
    'xiaomi',
]);

/** Model families our platform routing and prompts already handle by prefix */
const CHAT_FAMILY_PREFIXES: readonly string[] = [
    'gpt-',
    'claude-',
    'gemini-',
    'deepseek-',
    'grok-',
    'mimo-',
];

/** Ids that are not chat replies and must never enter the menu by themselves */
const NON_CHAT_ID = /image|embedding|tts|audio|live|realtime|computer-use|imagen|veo|sora|whisper|transcribe|rerank|moderation|ocr|speech/i;

/**
 * Variant ids of a model already in the menu: a new suffix would offer the
 * same model again (or an experimental build), not a new release.
 */
const VARIANT_SUFFIX = /-(preview|exp|experimental|alpha|beta|thinking|nothinking|nothink|chat|instruct|deprecated|legacy|latest|high|medium|low|max|mini-high)$/i;

/**
 * "Same family enters the menu automatically" means a *newer generation* of a
 * family we already offer, a newer minor of a product line we offer
 * (gpt-6.1-sol next to gpt-6-sol), or — for a line we never named — a release
 * from the last days. The catalog also lists old models (gpt-4o, gpt-5.2, ...)
 * and retired aliases (deepseek-v4-flash), so a bare prefix match is not enough.
 *
 * Release age only gates a line the menu never named: gpt-6.1-sol shipped 45
 * days before the first watch run and still belongs in the menu.
 */
const MAX_NEW_FAMILY_AGE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Ids with a routing suffix are artifacts, not model ids */
const ARTIFACT_ID = /[@:]/;

const releaseAgeDays = (releaseDate: unknown, now: Date): number | null => {
    if (typeof releaseDate !== 'string' || releaseDate === '') return null;
    const releasedAt = Date.parse(releaseDate);
    if (!Number.isFinite(releasedAt)) return null;
    const age = (now.getTime() - releasedAt) / DAY_MS;
    return age >= -1 ? age : null;
};

/** Newest version the menu already offers, per family and per product line */
interface MenuVersions {
    readonly families: ReadonlyMap<string, number>;
    readonly products: ReadonlyMap<string, number>;
}

const recordNewest = (versions: Map<string, number>, line: string, version: number): void => {
    const current = versions.get(line);
    if (current === undefined || version > current) versions.set(line, version);
};

const menuVersionsOf = (menuIds: readonly string[]): MenuVersions => {
    const families = new Map<string, number>();
    const products = new Map<string, number>();
    for (const id of menuIds) {
        const family = familyLineOf(id);
        const version = versionOf(id, family);
        if (version === null) continue;
        recordNewest(families, family, version);
        recordNewest(products, productLineOf(id), version);
    }
    return { families, products };
};

/**
 * Whether the catalog entry may enter the menu by itself. It may never be an
 * older generation than the menu already offers; a newer generation enters as
 * a whole; inside the menu's generation, only a newer minor of an offered
 * product line, or a brand-new line released in the last days.
 */
const qualifiesForAutoAdd = (
    id: string,
    releaseDate: unknown,
    menu: MenuVersions,
    now: Date
): boolean => {
    const age = releaseAgeDays(releaseDate, now);
    // An undated entry is unverified, never a new release
    if (age === null) return false;
    const family = familyLineOf(id);
    const version = versionOf(id, family);
    const familyVersion = menu.families.get(family);
    // Never resurrect an older generation, however recent its date: the first
    // watch run added gpt-4o / gpt-5.2 exactly this way.
    if (version !== null && familyVersion !== undefined && version < familyVersion) return false;
    if (version !== null && familyVersion !== undefined && version > familyVersion) return true;
    // Inside the menu's generation: the newer minor of an offered product line
    // (gpt-6.1-terra in the menu must not hide gpt-6.1-sol).
    const productVersion = version === null ? undefined : menu.products.get(productLineOf(id));
    if (version !== null && productVersion !== undefined) return version > productVersion;
    // A product line the menu never named: only a release from the last days.
    return age <= MAX_NEW_FAMILY_AGE_DAYS;
};

/** At most this many new models enter the menu per run */
const MAX_AUTO_ADDED_MODELS = 5;

const envInt = (name: string, fallback: number): number => {
    const parsed = Number.parseInt(process.env[name] ?? '', 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

/** On unless explicitly off; never on for the test instance or without an owner */
const watchEnabled = (): boolean =>
    process.env.PRICE_WATCH !== '0' && !isTestInstance() && getOwnerUserId() !== null;

let running = false;
let schedulerActive = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let fetcherOverride: CatalogFetcher | null = null;

/** Offline tests inject a stub fetcher; production uses the network */
export const setPriceWatchFetcher = (fetcher: CatalogFetcher | null): void => {
    fetcherOverride = fetcher;
};

const networkFetcher = (timeoutMs: number): CatalogFetcher => async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { status: response.status, body: await response.text() };
};

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

const hostOfUrl = (baseUrl: string): string | null => {
    if (baseUrl === '') return null;
    try {
        return new URL(baseUrl).host;
    } catch {
        return baseUrl;
    }
};

const laneIdForHost = (
    host: string | null,
    kind: 'openai' | 'anthropic' | 'grok' | 'deepseek' | 'mimo'
): string => {
    if (kind === 'openai') {
        if (host === null) return 'official-openai';
        if (host.endsWith('ephone.ai')) return 'ephone';
        if (host.endsWith('openai.com')) return 'official-openai';
        return `openai-relay:${host}`;
    }
    if (kind === 'anthropic') {
        if (host === null) return 'official-anthropic';
        if (host.endsWith('ephone.ai')) return 'ephone';
        if (host.endsWith('anthropic.com')) return 'official-anthropic';
        return `anthropic-relay:${host}`;
    }
    if (kind === 'grok') {
        if (host === null || host.endsWith('x.ai')) return 'official-xai';
        return `grok-relay:${host}`;
    }
    if (kind === 'deepseek') {
        if (host === null || host.endsWith('deepseek.com')) return 'official-deepseek';
        return `deepseek-relay:${host}`;
    }
    if (host === null || host.endsWith('xiaomimimo.com')) return 'official-mimo';
    return `mimo-relay:${host}`;
};

const shortHash = (value: string): string =>
    createHash('sha256').update(value).digest('hex').slice(0, 8);

const withLaneFingerprint = (laneId: string, kind: 'key' | 'project', value: string | null): string => {
    if (value === null || value === '') return laneId;
    return `${laneId}#${kind === 'key' ? 'k' : 'p'}${shortHash(value)}`;
};

/**
 * Compute per-platform live lane fingerprints matching `scripts/probe/effort-env.mts`
 * (`host + key/project sha256 prefix`). Platforms without configured credentials
 * are omitted so unconfigured test environments never unfreeze valid probe entries.
 */
export const liveLaneFingerprints = (
    env: Readonly<Record<string, string | undefined>> = process.env,
    credentialsFileExists: (path: string) => boolean = existsSync
): PlatformLaneFingerprints => {
    const read = (key: string): string => (env[key] ?? '').trim();
    const fingerprints: {
        openai?: string;
        anthropic?: string;
        gemini?: string;
        grok?: string;
        deepseek?: string;
        mimo?: string;
    } = {};

    const openAiCompatible = (options: {
        readonly urlKey: string;
        readonly keyKey: string;
        readonly kind: 'openai' | 'grok' | 'mimo';
        readonly defaultBaseUrl: string;
    }): string | undefined => {
        const apiKey = read(options.keyKey);
        if (apiKey === '') return undefined;
        const explicitUrl = read(options.urlKey);
        const baseUrl = explicitUrl !== '' ? explicitUrl : options.defaultBaseUrl;
        return withLaneFingerprint(laneIdForHost(hostOfUrl(baseUrl), options.kind), 'key', apiKey);
    };

    const openaiLane = openAiCompatible({
        urlKey: 'OPENAI_API_URL',
        keyKey: 'OPENAI_API_KEY',
        kind: 'openai',
        defaultBaseUrl: 'https://api.openai.com/v1',
    });
    if (openaiLane !== undefined) fingerprints.openai = openaiLane;

    const grokLane = openAiCompatible({
        urlKey: 'GROK_API_URL',
        keyKey: 'GROK_API_KEY',
        kind: 'grok',
        defaultBaseUrl: 'https://api.openai.com/v1',
    });
    if (grokLane !== undefined) fingerprints.grok = grokLane;

    const mimoLane = openAiCompatible({
        urlKey: 'MIMO_API_URL',
        keyKey: 'MIMO_API_KEY',
        kind: 'mimo',
        defaultBaseUrl: 'https://api.xiaomimimo.com/v1',
    });
    if (mimoLane !== undefined) fingerprints.mimo = mimoLane;

    const anthropicUrl = read('ANTHROPIC_API_URL');
    const openAiUrl = read('OPENAI_API_URL');
    const anthropicBase = anthropicUrl !== '' ? anthropicUrl : openAiUrl.replace(/\/v1\/?$/, '');
    const anthropicKey = read('ANTHROPIC_API_KEY') !== '' ? read('ANTHROPIC_API_KEY') : read('OPENAI_API_KEY');
    if (anthropicKey !== '') {
        fingerprints.anthropic = withLaneFingerprint(
            laneIdForHost(hostOfUrl(anthropicBase), 'anthropic'),
            'key',
            anthropicKey
        );
    }

    const deepseekKey = read('DEEPSEEK_API_KEY');
    if (deepseekKey !== '') {
        const baseUrl = read('DEEPSEEK_API_URL') || 'https://api.deepseek.com/v1';
        fingerprints.deepseek = withLaneFingerprint(laneIdForHost(hostOfUrl(baseUrl), 'deepseek'), 'key', deepseekKey);
    } else {
        const openAiKey = read('OPENAI_API_KEY');
        if (openAiKey !== '') {
            const baseUrl = openAiUrl !== '' ? openAiUrl : 'https://api.openai.com/v1';
            fingerprints.deepseek = withLaneFingerprint(
                `${laneIdForHost(hostOfUrl(baseUrl), 'openai')}:openai-fallback`,
                'key',
                openAiKey
            );
        }
    }

    const geminiUrl = read('GEMINI_API_URL');
    const geminiKey = read('GEMINI_API_KEY');
    const project = read('GOOGLE_CLOUD_PROJECT');
    const location = read('GOOGLE_CLOUD_LOCATION') || 'global';
    const credentialsPath = read('GOOGLE_APPLICATION_CREDENTIALS');
    if (geminiUrl !== '') {
        fingerprints.gemini = withLaneFingerprint(
            `gemini-relay:${hostOfUrl(geminiUrl) ?? geminiUrl}`,
            'key',
            geminiKey
        );
    } else if (project !== '' && credentialsPath !== '' && credentialsFileExists(credentialsPath)) {
        fingerprints.gemini = withLaneFingerprint(`vertex-adc@${location}`, 'project', project);
    } else if (geminiKey !== '') {
        fingerprints.gemini = withLaneFingerprint('vertex-express', 'key', geminiKey);
    }

    return fingerprints;
};

/** A model the aggregate catalog offers but our menu does not know yet */
interface DiscoveredModel {
    readonly entry: ModelCatalogEntry;
    readonly price: PriceEntry | null;
}

interface ModelsDevCost {
    readonly input?: number;
    readonly output?: number;
    readonly cache_read?: number;
    readonly cache_write?: number;
}

interface ModelsDevModel {
    readonly id?: string;
    readonly name?: string;
    /** YYYY-MM-DD the vendor released it; the auto-add window reads this */
    readonly release_date?: string;
    readonly cost?: ModelsDevCost;
    readonly limit?: { readonly context?: number; readonly output?: number };
    readonly modalities?: { readonly input?: readonly string[]; readonly output?: readonly string[] };
    readonly tool_call?: boolean;
    readonly reasoning_options?: readonly {
        readonly type?: string;
        readonly values?: readonly string[];
    }[];
}

interface ModelsDevProvider {
    readonly models?: Record<string, ModelsDevModel>;
}

const effortsOf = (model: ModelsDevModel): readonly string[] => {
    const options = model.reasoning_options ?? [];
    const effort = options.find((option) => option.type === 'effort');
    return effort?.values ?? [];
};

/**
 * The capabilities an auto-added row starts with: schema 1 (design §1.1-6) with
 * the seven legacy fields and models.dev provenance. No reasoning section is
 * derived here — the capability proposal is what fills it, with owner approval.
 */
const capabilitiesOf = (model: ModelsDevModel, checkedOn: string): ModelCatalogCapabilities => ({
    schema: 1,
    kind: 'chat',
    vision: (model.modalities?.input ?? []).includes('image'),
    imageOutput: (model.modalities?.output ?? []).includes('image'),
    tools: model.tool_call === true,
    reasoningEffort: effortsOf(model),
    contextTokens: model.limit?.context ?? null,
    outputTokens: model.limit?.output ?? null,
    source: 'models-dev',
    checkedOn,
    confidence: 'medium',
});

const discoveredPriceOf = (model: ModelsDevModel, sourceUrl: string, checkedOn: string): PriceEntry | null => {
    const cost = model.cost;
    if (cost?.input === undefined || cost.output === undefined) return null;
    return {
        model: '',
        tier: 'standard',
        inputPerM: cost.input,
        cachedInputPerM: cost.cache_read ?? cost.input,
        outputPerM: cost.output,
        ...(cost.cache_write === undefined ? {} : { cacheWritePerM: cost.cache_write }),
        effectiveFrom: new Date(),
        source: 'models-dev',
        sourceUrl,
        checkedOn,
        confidence: 'medium',
        note: 'auto-discovered by the price watcher',
    };
};

/** Shallow shape check: a JSON object whose values are provider objects */
const isModelsDevCatalog = (value: unknown): value is Record<string, ModelsDevProvider> =>
    isJsonObject(value) && Object.values(value).every((provider) => isJsonObject(provider));

/** Parse models.dev `api.json` once; returns null on missing/malformed input */
export const parseModelsDevApiJson = (body: string | null): Record<string, ModelsDevProvider> | null => {
    if (body === null) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return null;
    }
    return isModelsDevCatalog(parsed) ? parsed : null;
};

/** Parse (or reuse) the models.dev aggregate and keep chat models of our families */
export const discoveredModelsOf = (
    bodyOrParsed: string | Record<string, ModelsDevProvider>,
    now: Date = new Date()
): readonly DiscoveredModel[] => {
    const providers = typeof bodyOrParsed === 'string' ? parseModelsDevApiJson(bodyOrParsed) : bodyOrParsed;
    if (providers === null) return [];
    const checkedOn = isoDay(now);
    const menuIds = listAllModelCatalog()
        .filter((entry) => entry.enabled)
        .map((entry) => entry.id);
    const menu = menuVersionsOf(menuIds);
    const discovered: DiscoveredModel[] = [];
    for (const providerId of DISCOVERY_PROVIDERS) {
        const models = providers[providerId]?.models;
        if (models === undefined) continue;
        for (const [modelId, model] of Object.entries(models)) {
            const id = model.id ?? modelId;
            if (NON_CHAT_ID.test(id)) continue;
            if (VARIANT_SUFFIX.test(id)) continue;
            if (ARTIFACT_ID.test(id)) continue;
            if (!CHAT_FAMILY_PREFIXES.some((prefix) => id.toLowerCase().startsWith(prefix))) continue;
            if (!qualifiesForAutoAdd(id, model.release_date, menu, now)) continue;
            if (findModelCatalogEntry(id) !== null) continue;
            const capabilities = capabilitiesOf(model, checkedOn);
            if (capabilities.imageOutput) continue;
            const label = model.name ?? id;
            const sourceUrl = `https://models.dev/?model=${encodeURIComponent(`${providerId}/${modelId}`)}`;
            const price = discoveredPriceOf(model, sourceUrl, checkedOn);
            discovered.push({
                entry: {
                    id,
                    label,
                    platform: platformOfModelId(id),
                    catalogKey: `${providerId}/${modelId}`,
                    enabled: true,
                    capabilities,
                    source: 'models-dev',
                    sourceUrl,
                    checkedOn,
                    confidence: 'medium',
                    note: 'auto-added by the price watcher',
                },
                price: price === null ? null : { ...price, model: id },
            });
        }
    }
    return discovered.slice(0, MAX_AUTO_ADDED_MODELS);
};

const draftsOfDiscovered = (discovered: readonly DiscoveredModel[]): readonly ProposalDraft[] =>
    discovered.flatMap((item) => {
        if (item.price === null) return [];
        const draft: ProposalDraft = {
            kind: 'new_model',
            model: item.entry.id,
            tier: 'standard',
            entry: item.price,
            baseline: null,
            note: `新模型：目录有价，自动进菜单后需确认价格`,
        };
        return [draft];
    });

const summaryOf = (result: WatchRunResult): string => {
    if (result.outcome === 'busy') return '巡检进行中，请稍候';
    if (result.outcome === 'disabled') return '巡检未启用';
    if (result.outcome === 'failed') return `巡检失败：${result.errors[0] ?? '见日志'}`;
    const parts: string[] = [];
    if (result.proposals === 0 && result.capabilityProposals === 0) {
        parts.push('未发现价格变更');
    } else {
        if (result.proposals > 0) parts.push(`${result.proposals} 条价格变更待确认`);
        if (result.capabilityProposals > 0) parts.push(`${result.capabilityProposals} 条能力变更待确认`);
    }
    if (result.addedModels.length > 0) parts.push(`新收录模型 ${result.addedModels.join('、')}`);
    if (result.warnings.length > 0) parts.push(`警告 ${result.warnings.length} 条`);
    return parts.join('；');
};

/** One run of the watcher; the daily timer and `/pricing` share it */
export const runPriceWatchNow = async (
    api: Api,
    options: { readonly trigger?: 'scheduled' | 'manual' } = {}
): Promise<WatchRunResult> => {
    if (!watchEnabled()) return DISABLED;
    if (running) return { ...DISABLED, outcome: 'busy' };
    running = true;
    const now = new Date();
    const timeoutMs = envInt('PRICE_WATCH_TIMEOUT_MS', 8000);
    const fetcher = fetcherOverride ?? networkFetcher(timeoutMs);
    const statusBefore = await priceWatchStatus();
    const runId = await startWatchRun();
    const warnings: string[] = [];
    const errors: string[] = [];
    let messageIds: readonly number[] = [];
    let addedModels: readonly string[] = [];
    let proposals = 0;
    let capabilityProposals = 0;
    try {
        const currentLaneFingerprints = liveLaneFingerprints();
        // One refs list for the download and the compile: the models the menu
        // gained since the last release are tracked like the shipped ones
        const refs = catalogModelRefs();
        const catalogs = await fetchPriceCatalogs(fetcher, refs, { includeApiJson: true });
        warnings.push(...catalogs.warnings);
        errors.push(...catalogs.errors);
        const compiled = compilePriceCandidates(catalogs, { now, refs });
        warnings.push(...compiled.warnings);
        const current = allPriceEntries();
        const diff = diffPriceCandidates(compiled.candidates, current, { now });
        warnings.push(...diff.warnings);
        const drafts: ProposalDraft[] = [...diff.drafts];

        // Parse api.json once and feed both discovery and capability compilation
        const apiJsonBody = catalogs.documents.apiJson ?? null;
        const parsedApiRoot = parseModelsDevApiJson(apiJsonBody);
        if (apiJsonBody !== null && parsedApiRoot === null) {
            warnings.push('models.dev api.json 解析失败或格式无效，已忽略');
        }
        if (parsedApiRoot !== null) {
            const discovered = discoveredModelsOf(parsedApiRoot, now);
            const ownerId = getOwnerUserId();
            addedModels = await addCatalogModels(
                discovered.map((item) => item.entry),
                ownerId
            );
            const added = new Set(addedModels);
            drafts.push(...draftsOfDiscovered(discovered.filter((item) => added.has(item.entry.id))));
        }

        // Reference rows (enabled=0) keep non-menu runtime/seed/active models in the catalog (§3.4)
        const activeModels = await listActiveModelIdsFromMetrics(new Date(now.getTime() - 30 * DAY_MS));
        await ensureReferenceCatalogRows({
            activeModels,
            apiJsonRoot: parsedApiRoot,
            now,
        });

        // Capability half: the provider/lab TOMLs and the aggregate body above
        // are exactly what the compiler needs, so the run fetches nothing extra.
        const capabilityCompiled = compileCapabilityObservations(catalogs.documents, {
            now,
            refs,
            apiJsonRoot: parsedApiRoot,
        });
        warnings.push(...capabilityCompiled.warnings);
        const capabilityDiff = diffCapabilityCandidates(capabilityCompiled.candidates, listAllModelCatalog(), {
            now,
            justAddedModels: addedModels,
            currentLaneFingerprints,
        });
        warnings.push(...capabilityDiff.warnings);

        // Scan recent live-traffic capability events for contradictions (§3.3)
        const lastRunMs = statusBefore.lastRunAt === null ? null : Date.parse(statusBefore.lastRunAt);
        const trafficSinceMs =
            lastRunMs !== null && Number.isFinite(lastRunMs)
                ? Math.min(lastRunMs, now.getTime() - DAY_MS)
                : now.getTime() - 7 * DAY_MS;
        const recentEventRows = await listRecentCapabilityEventMetrics(new Date(trafficSinceMs));
        const trafficDiff = compileTrafficContradictions(recentEventRows, listAllModelCatalog(), {
            now,
            currentLaneFingerprints,
        });
        warnings.push(...trafficDiff.warnings);
        const combinedCapabilityDrafts = mergeCapabilityDrafts(capabilityDiff.drafts, trafficDiff.drafts);

        await expireStaleProposals(now);
        await expireStaleCapabilityProposals(now);
        await loadModelPrices();
        const evaluatedPriceModels = new Set(compiled.candidates.map((candidate) => candidate.entry.model));
        proposals = await createOrRefreshProposals(drafts, runId, {
            evaluatedModels: evaluatedPriceModels,
            now,
        });
        const addedSet = new Set(addedModels);
        const evaluatedCapabilityModels = new Set(
            capabilityCompiled.candidates
                .map((candidate) => candidate.model)
                .filter((model) => !addedSet.has(model))
        );
        const capabilityRefresh = await createOrRefreshCapabilityProposals(combinedCapabilityDrafts, runId, {
            evaluatedModels: evaluatedCapabilityModels,
            now,
        });
        capabilityProposals = capabilityRefresh.pending;
        warnings.push(...capabilityRefresh.skipped.map((skip) => skip.reason));
        const uniqueWarnings = [...new Set(warnings)];
        for (const warning of uniqueWarnings) {
            console.warn(`[pricing] warning: ${warning}`);
        }
        console.log(
            `[catalog] capabilities: ${capabilityCompiled.candidates.length} models, ${capabilityProposals} proposals, ${uniqueWarnings.length} warnings`
        );

        if (proposals > 0) {
            const duePrice = (await listPendingProposals()).filter((proposal) =>
                isPriceProposalDueForNotification(proposal, now)
            );
            messageIds = duePrice.length > 0 ? await sendProposalMessage(api, { id: runId }, duePrice) : [];
        } else {
            messageIds = [];
        }
        if (capabilityProposals > 0) {
            const dueCapabilities = (await listPendingCapabilityProposals()).filter((proposal) =>
                isCapabilityProposalDueForNotification(proposal, now)
            );
            if (dueCapabilities.length > 0) {
                const capabilityMessageIds = await sendCapabilityProposalMessage(api, dueCapabilities);
                messageIds = [...messageIds, ...capabilityMessageIds];
            }
        }
        if (addedModels.length > 0) {
            await sendModelCatalogNotice(api, addedModels);
        }
        // Heartbeat: a previously silent watcher is worth the owner's attention
        if (statusBefore.lastRunAt !== null) {
            const silentMs = now.getTime() - new Date(statusBefore.lastRunAt).getTime();
            if (silentMs > 36 * 3600 * 1000) {
                await sendOwnerNotice(
                    api,
                    `价目巡检上次成功运行是 ${new Date(statusBefore.lastRunAt).toISOString()}，已停摆超过 36 小时。`
                );
            }
        }
        const result: WatchRunResult = {
            outcome: 'ok',
            proposals,
            capabilityProposals,
            messageIds,
            addedModels,
            warnings: uniqueWarnings,
            errors,
        };
        await finishWatchRun(runId, {
            outcome: 'ok',
            proposals,
            capabilityProposals,
            warnings: uniqueWarnings,
            notifiedMessageId: messageIds.at(-1) ?? null,
            error: errors.length > 0 ? errors.join('; ').slice(0, 1000) : null,
        });
        console.log(`[pricing] watch run ${runId} (${options.trigger ?? 'manual'}): ${summaryOf(result)}`);
        return result;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(message);
        const uniqueWarnings = [...new Set(warnings)];
        await finishWatchRun(runId, {
            outcome: 'failed',
            proposals: 0,
            capabilityProposals,
            warnings: uniqueWarnings,
            error: message.slice(0, 1000),
        });
        console.error(`[pricing] watch run ${runId} failed:`, error);
        return { outcome: 'failed', proposals, capabilityProposals, messageIds, addedModels, warnings: uniqueWarnings, errors };
    } finally {
        running = false;
    }
};

/** One-line result for the owner's manual `/pricing` reply */
export const watchRunSummary = (result: WatchRunResult): string => summaryOf(result);

const MAX_STATUS_WARNINGS = 10;

/** The `/pricing status` text: table version, freshness, pending work and last warnings */
export const formatPriceStatusText = async (now: Date = new Date()): Promise<string> => {
    const [status, meta, pendingCapabilityProposals] = await Promise.all([
        priceWatchStatus(),
        loadPriceTableMeta(now),
        countPendingCapabilityProposals(),
    ]);
    const lines = [
        `价目版本：${status.version}`,
        `目录版本：${modelCatalogVersion()}`,
        `最近核对：${meta.checkedOn ?? '未知'}（来源 ${meta.sources.map((source) => `${source.kind} ${source.checkedOn}`).join('、') || '无'}）`,
        `上次巡检：${status.lastRunAt ?? '从未'}${status.lastOutcome === null ? '' : `（${status.lastOutcome}）`}${status.lastError === null ? '' : `，最近错误：${status.lastError.slice(0, 120)}`}`,
        `待确认提案：${status.pendingProposals}`,
        `待确认能力提案：${pendingCapabilityProposals}`,
        meta.nextChanges.length === 0
            ? '未来 30 天没有已知调价'
            : `未来 30 天调价：${meta.nextChanges
                  .slice(0, 3)
                  .map((change) => `${change.model} ${change.at.slice(0, 10)} ${change.summary}`)
                  .join('；')}`,
        meta.unpricedModels.length === 0 ? '没有未定价模型' : `未定价模型：${meta.unpricedModels.join('、')}`,
    ];
    if (status.lastWarnings.length > 0) {
        const shown = status.lastWarnings.slice(0, MAX_STATUS_WARNINGS);
        const more = status.lastWarnings.length > shown.length ? `\n…还有 ${status.lastWarnings.length - shown.length} 条` : '';
        lines.push(`上次巡检警告（${status.lastWarnings.length} 条）：\n${shown.map((warning) => `· ${warning}`).join('\n')}${more}`);
    } else if (status.lastRunAt !== null) {
        lines.push('上次巡检警告：无');
    }
    return lines.join('\n');
};

/**
 * Initial scheduler delay from the last run stored in SQLite (`lastRunAt + interval - now`),
 * clamped to `[minDelayMs, intervalMs]`. A process restart never triggers an immediate rerun.
 */
export const initialWatchDelayMs = (
    lastRunAt: Date | null,
    now: Date,
    minDelayMs: number,
    intervalMs: number
): number => {
    const floor = Math.max(0, minDelayMs);
    const ceiling = Math.max(floor, intervalMs);
    if (lastRunAt === null || Number.isNaN(lastRunAt.getTime())) return floor;
    const remaining = lastRunAt.getTime() + ceiling - now.getTime();
    return Math.min(ceiling, Math.max(floor, remaining));
};

const startScheduler = async (api: Api): Promise<void> => {
    if (!watchEnabled()) {
        console.log('[pricing] watcher disabled');
        schedulerActive = false;
        return;
    }
    const initialMinutes = envInt('PRICE_WATCH_INITIAL_DELAY_MIN', 10);
    const intervalHours = envInt('PRICE_WATCH_INTERVAL_HOURS', 24);
    const hourMs = 3600 * 1000;
    const minDelayMs = Math.max(1, initialMinutes) * 60 * 1000;
    const intervalMs = Math.max(1, intervalHours) * hourMs;
    let lastRunAt: Date | null = null;
    try {
        const status = await priceWatchStatus();
        lastRunAt = status.lastRunAt === null ? null : new Date(status.lastRunAt);
    } catch (error: unknown) {
        console.warn('[pricing] reading last watch run failed, using fallback initial delay:', error);
    }
    if (!schedulerActive) return;

    const scheduleNext = (delayMs: number): void => {
        if (!schedulerActive) return;
        timer = setTimeout(() => {
            void runPriceWatchNow(api, { trigger: 'scheduled' }).finally(() => {
                scheduleNext(intervalMs);
            });
        }, delayMs);
        // Do not keep a test process alive for the timer; the bot polls anyway
        timer.unref?.();
    };
    const initialDelayMs = initialWatchDelayMs(lastRunAt, new Date(), minDelayMs, intervalMs);
    scheduleNext(initialDelayMs);
    console.log(
        `[pricing] watcher scheduled: first run in ${Math.round(initialDelayMs / 60_000)} min, every ${intervalHours}h`
    );
};

/** Start the daily watcher; call once from main() after the panel is up */
export const startPriceWatch = (api: Api): void => {
    if (timer !== null || schedulerActive) return;
    schedulerActive = true;
    void startScheduler(api);
};

/** Tests and shutdown: forget the timer so no handle keeps the process alive */
export const stopPriceWatch = (): void => {
    schedulerActive = false;
    if (timer !== null) clearTimeout(timer);
    timer = null;
};

/** The fallback table the registry holds when the database is unavailable */
export const builtInPriceRows = (): readonly PriceEntry[] => seedPriceEntries();

/** Every current row, for diagnostics */
export const currentRows = (): readonly PriceEntry[] => allPriceEntries();

/** The catalog rows the watcher reads (enabled or not) */
export const catalogRows = (): readonly ModelCatalogEntry[] => listAllModelCatalog();
