/**
 * The downloader of the price watcher (pricing design 2026-1113-1150 §5.2):
 * every machine-readable catalog we compile prices from.
 *
 * - models.dev provider TOMLs are the baseline: one tiny file per model, with
 *   service-tier multipliers, scheduled price changes and cache TTL prices;
 * - the Vertex pricing page is the official source for the Gemini family and
 *   the only one with Priority PayGo rows and promotional windows;
 * - ephone's pricing JSON covers ids models.dev has no page for (relay-only
 *   image models) and the price the relay actually charges;
 * - LiteLLM's community map is only cross-checked, never a source of truth.
 *
 * Every GET goes through the caller's `CatalogFetcher`, which owns the timeout:
 * this module never schedules a timer, never throws, and records a dead source
 * as a warning or an error so the rest of the run still happens.
 */
import { parse as parseToml } from 'smol-toml';
import { isJsonObject } from '../shared/json-object.js';
import { listAllModelCatalog } from '../config/model-catalog.js';
import type { CatalogFetchResult, CatalogFetcher, CatalogModelRef } from './price-catalog-types.js';

/** models.dev keeps one TOML per provider model (schema 2, MIT) */
const MODELS_DEV_PROVIDER_DIRECTORY = 'https://raw.githubusercontent.com/sst/models.dev/dev/providers';

/**
 * models.dev keeps the canonical lab document of a model under
 * `models/<vendor>/<id>.toml`; the provider TOML names it in `base_model`.
 */
export const MODELS_DEV_LAB_DIRECTORY = 'https://raw.githubusercontent.com/sst/models.dev/dev/models';

/** Vertex's own pricing page: Priority PayGo rows, promo windows and dates */
export const VERTEX_PRICING_URL = 'https://cloud.google.com/vertex-ai/generative-ai/pricing';

/** ephone's catalog: relay-only ids and the paid-price view */
export const EPHONE_PRICING_URL = 'https://api.ephone.ai/api/pricing';

/** LiteLLM's community price map: cross-check only (no candidate comes from it) */
export const LITELLM_PRICING_URL =
    'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/**
 * Every model our price table knows, and where models.dev keeps its provider
 * price page. The provider is the one matching our route: Gemini goes through
 * our own Vertex global endpoint, so `google-vertex` (the AI Studio page has
 * different prices), and the relayed vendors stay on their canonical provider.
 *
 * `modelFile: ''` means models.dev has no page for that id: `gpt-image-2.5-dev`
 * is an ephone-only image product, so its price can only come from ephone (or
 * stay "unpriced", which is the current state).
 */
export const CATALOG_MODEL_REFS: readonly CatalogModelRef[] = [
    { model: 'gpt-6-luna', provider: 'openai', modelFile: 'gpt-6-luna' },
    { model: 'gpt-6-sol', provider: 'openai', modelFile: 'gpt-6-sol' },
    { model: 'gpt-6-astra', provider: 'openai', modelFile: 'gpt-6-astra' },
    { model: 'claude-sonnet-5', provider: 'anthropic', modelFile: 'claude-sonnet-5' },
    // The menu id since 2026-11-13; prices differ from sonnet-5 in cache hits
    { model: 'claude-sonnet-5-5', provider: 'anthropic', modelFile: 'claude-sonnet-5-5' },
    { model: 'claude-opus-5-5', provider: 'anthropic', modelFile: 'claude-opus-5-5' },
    { model: 'gemini-4-hydrogen', provider: 'google-vertex', modelFile: 'gemini-4-hydrogen' },
    { model: 'gemini-3.8-flash', provider: 'google-vertex', modelFile: 'gemini-3.8-flash' },
    { model: 'gemini-4-argon', provider: 'google-vertex', modelFile: 'gemini-4-argon' },
    { model: 'gemini-4-carbon', provider: 'google-vertex', modelFile: 'gemini-4-carbon' },
    { model: 'gemini-nano-banana-2.1', provider: 'google-vertex', modelFile: 'gemini-nano-banana-2.1' },
    { model: 'deepseek-flash', provider: 'deepseek', modelFile: 'deepseek-flash' },
    { model: 'grok-4.7', provider: 'xai', modelFile: 'grok-4.7' },
    { model: 'grok-4.20-multi-agent-0309', provider: 'xai', modelFile: 'grok-4.20-multi-agent-0309' },
    { model: 'mimo-v2.6-flash', provider: 'xiaomi', modelFile: 'mimo-v2.6-flash' },
    { model: 'mimo-v2.6-pro', provider: 'xiaomi', modelFile: 'mimo-v2.6-pro' },
    // Relay-only id: no models.dev TOML, hence the empty modelFile
    { model: 'gpt-image-2.5-dev', provider: 'openai', modelFile: '' },
];

/**
 * Every model to track in a run: the built-in refs plus the models the watcher
 * added to the menu itself. An auto-added row stores the catalog key it came
 * from (`openai/gpt-6.1-sol`), so it is tracked from the next run on exactly
 * like a shipped model — otherwise its
 * price would stay at the value of the day it entered the menu.
 */
export const catalogModelRefs = (): readonly CatalogModelRef[] => {
    const known = new Set(CATALOG_MODEL_REFS.map((ref) => ref.model));
    const derived: CatalogModelRef[] = [];
    for (const entry of listAllModelCatalog()) {
        if (known.has(entry.id) || entry.catalogKey === undefined) continue;
        const [provider, ...rest] = entry.catalogKey.split('/');
        if (provider === undefined || rest.length === 0) continue;
        derived.push({ model: entry.id, provider, modelFile: rest.join('/') });
    }
    return derived.length === 0 ? CATALOG_MODEL_REFS : [...CATALOG_MODEL_REFS, ...derived];
};

/** The raw URL of one model's models.dev TOML; '' when models.dev has none */
export const modelsDevTomlUrl = (ref: CatalogModelRef): string =>
    ref.modelFile === ''
        ? ''
        : `${MODELS_DEV_PROVIDER_DIRECTORY}/${ref.provider}/models/${ref.modelFile}.toml`;

/** The canonical lab document of a `base_model` value such as `google/gemini-4-hydrogen` */
export const modelsDevLabTomlUrl = (baseModel: string): string =>
    `${MODELS_DEV_LAB_DIRECTORY}/${baseModel}.toml`;

/**
 * The `base_model` a provider TOML points at (the canonical lab document), or
 * null when it names none or the body is not a TOML object.
 */
export const baseModelOfToml = (body: string): string | null => {
    let parsed: unknown;
    try {
        parsed = parseToml(body);
    } catch {
        return null;
    }
    if (!isJsonObject(parsed)) return null;
    const baseModel = parsed.base_model;
    return typeof baseModel === 'string' && baseModel.trim() !== '' ? baseModel.trim() : null;
};

/** One GET result: a body or the reason there is none (never a thrown error) */
interface FetchOutcome {
    readonly body: string | null;
    readonly error: string | null;
}

const fetchText = async (fetcher: CatalogFetcher, url: string): Promise<FetchOutcome> => {
    try {
        const response = await fetcher(url);
        if (response.status !== 200) return { body: null, error: `HTTP ${response.status}` };
        if (response.body.trim() === '') return { body: null, error: '响应为空' };
        return { body: response.body, error: null };
    } catch (error) {
        return { body: null, error: error instanceof Error ? error.message : String(error) };
    }
};

/**
 * Downloads every catalog in one concurrent batch. A failing TOML is a warning
 * (the other 15 models still compile); a failing whole source is an error (its
 * candidates are simply absent, LiteLLM/ephone may still fill a gap).
 *
 * The canonical lab documents are a second wave of the same batch because their
 * URL comes from the downloaded provider TOML's `base_model`. A model without
 * one (`claude-sonnet-5`, `grok-4.20-multi-agent-0309`) has no lab document:
 * its limits stay absent and `api.json` fills them at compile time.
 */
export const fetchPriceCatalogs = async (
    fetcher: CatalogFetcher,
    refs: readonly CatalogModelRef[] = catalogModelRefs()
): Promise<CatalogFetchResult> => {
    const tomlRefs = refs.filter((ref) => ref.modelFile !== '');
    // One promise per model, in ref order: the result order stays deterministic
    const tomlRequests = tomlRefs.map(async (ref) => ({
        model: ref.model,
        outcome: await fetchText(fetcher, modelsDevTomlUrl(ref)),
    }));
    const [tomlResults, vertex, ephone, litellm] = await Promise.all([
        Promise.all(tomlRequests),
        fetchText(fetcher, VERTEX_PRICING_URL),
        fetchText(fetcher, EPHONE_PRICING_URL),
        fetchText(fetcher, LITELLM_PRICING_URL),
    ]);

    const warnings: string[] = [];
    const errors: string[] = [];
    const tomlByModel = new Map<string, string>();
    const labTargets: { readonly model: string; readonly url: string }[] = [];
    for (const result of tomlResults) {
        if (result.outcome.body === null) {
            warnings.push(`models.dev TOML 抓取失败（${result.model}）：${result.outcome.error ?? '未知原因'}`);
            continue;
        }
        tomlByModel.set(result.model, result.outcome.body);
        const baseModel = baseModelOfToml(result.outcome.body);
        if (baseModel !== null) labTargets.push({ model: result.model, url: modelsDevLabTomlUrl(baseModel) });
    }
    if (tomlByModel.size === 0) errors.push('models.dev 的 TOML 全部抓取失败，本次没有基价来源');

    const labResults = await Promise.all(
        labTargets.map(async (target) => ({
            model: target.model,
            outcome: await fetchText(fetcher, target.url),
        }))
    );
    const labTomlByModel = new Map<string, string>();
    for (const result of labResults) {
        if (result.outcome.body === null) {
            warnings.push(`models.dev canonical lab TOML 抓取失败（${result.model}）：${result.outcome.error ?? '未知原因'}`);
            continue;
        }
        labTomlByModel.set(result.model, result.outcome.body);
    }

    const sourceBody = (label: string, url: string, outcome: FetchOutcome, problems: string[]): string | null => {
        if (outcome.body === null) problems.push(`${label} 抓取失败：${outcome.error ?? '未知原因'}（${url}）`);
        return outcome.body;
    };

    return {
        documents: {
            tomlByModel,
            labTomlByModel,
            // The official page is the main source of Priority PayGo and promo
            // windows: its absence is a run-level error, while ephone and
            // LiteLLM are optional (a gap filler and a cross-check) and only warn.
            vertexPricingHtml: sourceBody('官方 Vertex 定价页', VERTEX_PRICING_URL, vertex, errors),
            ephonePricingJson: sourceBody('ephone 定价接口', EPHONE_PRICING_URL, ephone, warnings),
            litellmJson: sourceBody('LiteLLM 价目表', LITELLM_PRICING_URL, litellm, warnings),
        },
        warnings,
        errors,
    };
};
