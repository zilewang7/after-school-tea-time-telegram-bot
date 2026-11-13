/**
 * The price watcher: one run fetches the catalogs, compiles the table they
 * imply, diffs it against the rows in force, records proposals and asks the
 * owner from a private chat (pricing design 2026-1113-1150).
 *
 * Runs in the bot process because the approval is a Telegram message with
 * inline buttons: the daily timer and the owner's `/pricing` share one path
 * and one lock. Everything here is best-effort: a failed source, a slow CDN
 * or an unreachable Telegram never touches the reply path — errors are logged
 * and recorded on the run row, and the previous price table keeps working.
 */
import type { Api } from 'grammy';
import { isTestInstance } from '../config/instance.js';
import { isJsonObject } from '../shared/json-object.js';
import { getOwnerUserId } from '../config/owner.js';
import {
    allPriceEntries,
    seedPriceEntries,
    type PriceEntry,
} from '../config/model-pricing.js';
import {
    findModelCatalogEntry,
    listAllModelCatalog,
    platformOfModelId,
    type ModelCatalogCapabilities,
    type ModelCatalogEntry,
} from '../config/model-catalog.js';
import {
    createOrRefreshProposals,
    expireStaleProposals,
    finishWatchRun,
    loadPriceTableMeta,
    listPendingProposals,
    loadModelPrices,
    priceWatchStatus,
    startWatchRun,
} from './model-price-service.js';
import { addCatalogModels } from './model-catalog-service.js';
import {
    diffPriceCandidates,
    compilePriceCandidates,
} from './price-catalog-compile.js';
import { fetchPriceCatalogs } from './price-catalog-fetch.js';
import type { CatalogFetcher, ProposalDraft } from './price-catalog-types.js';
import {
    sendModelCatalogNotice,
    sendOwnerNotice,
    sendProposalMessage,
} from './price-proposal-notify.js';

/** How one run ended; `busy`/`disabled` never touched the network */
export interface WatchRunResult {
    readonly outcome: 'ok' | 'failed' | 'busy' | 'disabled';
    /** Pending proposals after the run */
    readonly proposals: number;
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
    messageIds: [],
    addedModels: [],
    warnings: [],
    errors: [],
};

/** The models.dev aggregate, only for new-model discovery */
const MODELS_DEV_API = 'https://models.dev/api.json';

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

const today = (): string => new Date().toISOString().slice(0, 10);

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

const capabilitiesOf = (model: ModelsDevModel): ModelCatalogCapabilities => ({
    kind: 'chat',
    vision: (model.modalities?.input ?? []).includes('image'),
    imageOutput: (model.modalities?.output ?? []).includes('image'),
    tools: model.tool_call === true,
    reasoningEffort: effortsOf(model),
    contextTokens: model.limit?.context ?? null,
    outputTokens: model.limit?.output ?? null,
});

const discoveredPriceOf = (model: ModelsDevModel, sourceUrl: string): PriceEntry | null => {
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
        checkedOn: today(),
        confidence: 'medium',
        note: 'auto-discovered by the price watcher',
    };
};

/** Shallow shape check: a JSON object whose values are provider objects */
const isModelsDevCatalog = (value: unknown): value is Record<string, ModelsDevProvider> =>
    isJsonObject(value) && Object.values(value).every((provider) => isJsonObject(provider));

/** Parse the models.dev aggregate and keep chat models of our families */
export const discoveredModelsOf = (body: string): readonly DiscoveredModel[] => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return [];
    }
    if (!isModelsDevCatalog(parsed)) return [];
    const providers = parsed;
    const discovered: DiscoveredModel[] = [];
    for (const providerId of DISCOVERY_PROVIDERS) {
        const models = providers[providerId]?.models;
        if (models === undefined) continue;
        for (const [modelId, model] of Object.entries(models)) {
            const id = model.id ?? modelId;
            if (NON_CHAT_ID.test(id)) continue;
            if (!CHAT_FAMILY_PREFIXES.some((prefix) => id.toLowerCase().startsWith(prefix))) continue;
            if (findModelCatalogEntry(id) !== null) continue;
            const capabilities = capabilitiesOf(model);
            if (capabilities.imageOutput) continue;
            const label = model.name ?? id;
            const sourceUrl = `https://models.dev/?model=${encodeURIComponent(`${providerId}/${modelId}`)}`;
            const price = discoveredPriceOf(model, sourceUrl);
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
                    checkedOn: today(),
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
    parts.push(result.proposals > 0 ? `${result.proposals} 条价格变更待确认` : '未发现价格变更');
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
    const runId = await startWatchRun();
    const warnings: string[] = [];
    const errors: string[] = [];
    let messageIds: readonly number[] = [];
    let addedModels: readonly string[] = [];
    let proposals = 0;
    try {
        const statusBefore = await priceWatchStatus();
        const catalogs = await fetchPriceCatalogs(fetcher);
        warnings.push(...catalogs.warnings);
        errors.push(...catalogs.errors);
        const compiled = compilePriceCandidates(catalogs, { now });
        warnings.push(...compiled.warnings);
        const current = allPriceEntries();
        const diff = diffPriceCandidates(compiled.candidates, current, { now });
        warnings.push(...diff.warnings);
        const drafts: ProposalDraft[] = [...diff.drafts];

        // New models of a known family enter the menu automatically; their
        // price still needs the owner's approval.
        const aggregateUrl = MODELS_DEV_API;
        const aggregate = await fetcher(aggregateUrl).catch((error: unknown) => {
            warnings.push(`模型发现失败：${error instanceof Error ? error.message : String(error)}`);
            return null;
        });
        if (aggregate !== null && aggregate.status === 200) {
            const discovered = discoveredModelsOf(aggregate.body);
            const ownerId = getOwnerUserId();
            addedModels = await addCatalogModels(
                discovered.map((item) => item.entry),
                ownerId
            );
            const added = new Set(addedModels);
            drafts.push(...draftsOfDiscovered(discovered.filter((item) => added.has(item.entry.id))));
        }

        await expireStaleProposals(now);
        await loadModelPrices();
        proposals = await createOrRefreshProposals(drafts, runId);

        if (proposals > 0) {
            const pending = await listPendingProposals();
            messageIds = await sendProposalMessage(api, { id: runId }, pending);
        } else {
            messageIds = [];
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
            messageIds,
            addedModels,
            warnings,
            errors,
        };
        await finishWatchRun(runId, {
            outcome: 'ok',
            proposals,
            notifiedMessageId: messageIds.at(-1) ?? null,
            error: errors.length > 0 ? errors.join('; ').slice(0, 1000) : null,
        });
        console.log(`[pricing] watch run ${runId} (${options.trigger ?? 'manual'}): ${summaryOf(result)}`);
        return result;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(message);
        await finishWatchRun(runId, { outcome: 'failed', proposals: 0, error: message.slice(0, 1000) });
        console.error(`[pricing] watch run ${runId} failed:`, error);
        return { outcome: 'failed', proposals, messageIds, addedModels, warnings, errors };
    } finally {
        running = false;
    }
};

/** One-line result for the owner's manual `/pricing` reply */
export const watchRunSummary = (result: WatchRunResult): string => summaryOf(result);

/** The `/pricing status` text: table version, freshness and pending work */
export const formatPriceStatusText = async (now: Date = new Date()): Promise<string> => {
    const [status, meta] = await Promise.all([priceWatchStatus(), loadPriceTableMeta(now)]);
    const lines = [
        `价目版本：${status.version}`,
        `最近核对：${meta.checkedOn ?? '未知'}（来源 ${meta.sources.map((source) => `${source.kind} ${source.checkedOn}`).join('、') || '无'}）`,
        `上次巡检：${status.lastRunAt ?? '从未'}${status.lastOutcome === null ? '' : `（${status.lastOutcome}）`}${status.lastError === null ? '' : `，最近错误：${status.lastError.slice(0, 120)}`}`,
        `待确认提案：${status.pendingProposals}`,
        meta.nextChanges.length === 0
            ? '未来 30 天没有已知调价'
            : `未来 30 天调价：${meta.nextChanges
                  .slice(0, 3)
                  .map((change) => `${change.model} ${change.at.slice(0, 10)} ${change.summary}`)
                  .join('；')}`,
        meta.unpricedModels.length === 0 ? '没有未定价模型' : `未定价模型：${meta.unpricedModels.join('、')}`,
    ];
    return lines.join('\n');
};

const startScheduler = (api: Api): void => {
    if (!watchEnabled()) {
        console.log('[pricing] watcher disabled');
        return;
    }
    const initialMinutes = envInt('PRICE_WATCH_INITIAL_DELAY_MIN', 10);
    const intervalHours = envInt('PRICE_WATCH_INTERVAL_HOURS', 24);
    const hourMs = 3600 * 1000;
    const scheduleNext = (delayMs: number): void => {
        timer = setTimeout(() => {
            void runPriceWatchNow(api, { trigger: 'scheduled' }).finally(() => {
                scheduleNext(Math.max(1, intervalHours) * hourMs);
            });
        }, delayMs);
        // Do not keep a test process alive for the timer; the bot polls anyway
        timer.unref?.();
    };
    scheduleNext(Math.max(1, initialMinutes) * 60 * 1000);
    console.log(`[pricing] watcher scheduled: first run in ${initialMinutes} min, every ${intervalHours}h`);
};

/** Start the daily watcher; call once from main() after the panel is up */
export const startPriceWatch = (api: Api): void => {
    if (timer !== null) return;
    startScheduler(api);
};

/** Tests and shutdown: forget the timer so no handle keeps the process alive */
export const stopPriceWatch = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
};

/** The fallback table the registry holds when the database is unavailable */
export const builtInPriceRows = (): readonly PriceEntry[] => seedPriceEntries();

/** Every current row, for diagnostics */
export const currentRows = (): readonly PriceEntry[] => allPriceEntries();

/** The catalog rows the watcher reads (enabled or not) */
export const catalogRows = (): readonly ModelCatalogEntry[] => listAllModelCatalog();
