/**
 * search_by_image's orchestrator.
 *
 * Yandex stays the primary channel: any picture gets the general web sources,
 * the other sizes and the similar pictures. SauceNAO is the supplement for
 * anime and illustrations — it knows Pixiv / X / Danbooru source pages where
 * Yandex only finds reposts — and runs when Yandex's result shows a
 * two-dimensional signal, when Yandex found nothing useful, or when the call
 * names it. trace.moe (anime frames) only runs when the call names it. Every
 * engine has its own cache entry, so an auto call reuses both answers and a
 * later explicit call costs nothing.
 *
 * One engine failing never fails the call while another one answered: the
 * failure travels with the result as an engine run and the tool text says which
 * part is missing. `ok:false` means no engine delivered anything.
 */
import { createHash } from 'node:crypto';
import type { SniffedMediaMime } from '../ai/image-generation/image-mime.js';
import { getReverseSearchConfig, type ReverseSearchConfig } from '../config/reverse-search-config.js';
import { failureOf, type ReverseSearchFailureInfo } from './image-reverse-search-http.js';
import {
    DEFAULT_SAUCENAO_ORIGIN,
    createSauceNaoClient,
    type SauceNaoClient,
} from './image-reverse-search-saucenao.js';
import {
    DEFAULT_TRACEMOE_ORIGIN,
    createTraceMoeClient,
    type TraceMoeClient,
} from './image-reverse-search-tracemoe.js';
import type {
    ParsedReverseSearch,
    ReverseSearchEngineChoice,
    ReverseSearchEngineId,
    ReverseSearchEngineRun,
    ReverseSearchErrorKind,
    ReverseSearchResult,
    ReverseSearchSite,
} from './image-reverse-search-types.js';
import { DEFAULT_YANDEX_ORIGIN, createYandexClient, type YandexClient } from './image-reverse-search-yandex.js';

/** Telegram photos are usually below this; the upload endpoint turns flaky above it */
export const MAX_REVERSE_SEARCH_BYTES = 8 * 1024 * 1024;

const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;

const ENGINE_LABELS: Readonly<Record<ReverseSearchEngineId, string>> = {
    yandex: 'Yandex',
    saucenao: 'SauceNAO',
    tracemoe: 'trace.moe',
};

/**
 * Yandex's recognition tags are Russian; these are the ones that mean the
 * picture is drawn rather than photographed.
 */
const TWO_DIMENSIONAL_TAGS = /аниме|манга|мультик|рисун|арт|чиби|илустрац|anime|manga|illustration|cartoon/i;

/** Art galleries: a source page there is a strong signal on its own */
const TWO_DIMENSIONAL_DOMAINS =
    /(?:^|\.)(?:pixiv\.net|danbooru\.donmai\.us|yande\.re|konachan\.(?:com|net)|gelbooru\.com|sankakucomplex\.com|anime-pictures\.net|zerochan\.net|e-shuushuu\.net|booru\.org)$/i;

export interface ReverseSearchOptions {
    readonly bytes: Buffer;
    readonly mimeType: SniffedMediaMime;
    readonly signal?: AbortSignal;
    /** auto (default): Yandex, plus SauceNAO when the result looks drawn or weak */
    readonly engine?: ReverseSearchEngineChoice;
    /** true asks SauceNAO for Known Safe gallery results only (hide=3) */
    readonly safe?: boolean;
}

export type ReverseSearchOutcome =
    | {
          readonly ok: true;
          readonly result: ReverseSearchResult;
          readonly cached: boolean;
      }
    | {
          readonly ok: false;
          readonly kind: ReverseSearchErrorKind;
          readonly error: string;
      };

export interface ReverseSearchServiceOptions {
    /** Defaults to the env settings read once */
    readonly config?: ReverseSearchConfig;
    /** Tests point the clients at a stub server */
    readonly fetchImpl?: typeof fetch;
    readonly yandexOrigin?: string;
    readonly sauceNaoOrigin?: string;
    readonly traceMoeOrigin?: string;
    /** Tests move the clock instead of waiting */
    readonly now?: () => number;
}

export interface ReverseSearchService {
    search(options: ReverseSearchOptions): Promise<ReverseSearchOutcome>;
    /** Only for tests: forget every cached engine answer */
    clearCache(): void;
}

interface CacheEntry {
    readonly expiresAt: number;
    readonly result: ParsedReverseSearch;
}

type EngineFindings = Partial<Record<ReverseSearchEngineId, ParsedReverseSearch>>;

/** host + pathname, lowercase: the same page linked with a different query is one site */
const urlKeyOf = (rawUrl: string): string => {
    try {
        const url = new URL(rawUrl);
        return `${url.hostname.replace(/^www\./, '').toLowerCase()}${url.pathname.toLowerCase()}`;
    } catch {
        return rawUrl.toLowerCase();
    }
};

const domainOf = (rawUrl: string): string => {
    try {
        return new URL(rawUrl).hostname.replace(/^www\./, '');
    } catch {
        return '';
    }
};

/**
 * One page once. When both engines know a page, the scored one (SauceNAO)
 * wins: its entry carries the similarity and the original link.
 */
const mergeSites = (sites: readonly ReverseSearchSite[]): ReverseSearchSite[] => {
    const order: string[] = [];
    const byKey = new Map<string, ReverseSearchSite>();
    for (const site of sites) {
        const key = urlKeyOf(site.url);
        const known = byKey.get(key);
        if (known === undefined) {
            order.push(key);
            byKey.set(key, site);
            continue;
        }
        if (known.engine === 'yandex' && site.engine !== 'yandex') byKey.set(key, site);
    }
    return order.flatMap((key) => {
        const site = byKey.get(key);
        return site === undefined ? [] : [site];
    });
};

const summaryOf = (findings: ParsedReverseSearch): string => {
    const top = findings.sites.reduce<number | null>(
        (best, site) =>
            site.similarity === undefined ? best : best === null || site.similarity > best ? site.similarity : best,
        null
    );
    const topPart = top === null ? '' : ` top=${top}`;
    return (
        `sites=${findings.sites.length} sizes=${findings.sizes.length} ` +
        `similar=${findings.similar.length} tags=${findings.tags.length}${topPart}`
    );
};

const failureTextOf = (failure: ReverseSearchFailureInfo | undefined): string =>
    failure === undefined ? '未知错误' : failure.error;

const isTwoDimensional = (findings: ParsedReverseSearch): boolean =>
    findings.tags.some((tag) => TWO_DIMENSIONAL_TAGS.test(tag)) ||
    findings.sites.some((site) => TWO_DIMENSIONAL_DOMAINS.test(site.domain)) ||
    findings.sizes.some((size) => TWO_DIMENSIONAL_DOMAINS.test(domainOf(size.url)));

/** What the caller needs when only one engine answered: the other one is missing */
const isWeak = (findings: ParsedReverseSearch): boolean =>
    findings.sites.length === 0 && findings.sizes.length === 0;

export const createReverseSearchService = (options: ReverseSearchServiceOptions = {}): ReverseSearchService => {
    const config = options.config ?? getReverseSearchConfig();
    const now = options.now ?? Date.now;
    const yandex: YandexClient = createYandexClient({
        origin: options.yandexOrigin ?? DEFAULT_YANDEX_ORIGIN,
        fetchImpl: options.fetchImpl,
    });
    const sauceNao: SauceNaoClient = createSauceNaoClient({
        apiKey: config.sauceNaoApiKey,
        origin: options.sauceNaoOrigin ?? DEFAULT_SAUCENAO_ORIGIN,
        fetchImpl: options.fetchImpl,
        limits: config.sauceNaoPacing,
        now,
    });
    const traceMoe: TraceMoeClient = createTraceMoeClient({
        origin: options.traceMoeOrigin ?? DEFAULT_TRACEMOE_ORIGIN,
        fetchImpl: options.fetchImpl,
        now,
    });

    const cache = new Map<string, CacheEntry>();

    const cacheGet = (key: string): ParsedReverseSearch | null => {
        const entry = cache.get(key);
        if (!entry) return null;
        if (entry.expiresAt <= now()) {
            cache.delete(key);
            return null;
        }
        // Refresh insertion order for the LRU eviction below
        cache.delete(key);
        cache.set(key, entry);
        return entry.result;
    };

    const cachePut = (key: string, result: ParsedReverseSearch): void => {
        while (cache.size >= CACHE_MAX_ENTRIES) {
            const oldest = cache.keys().next();
            if (oldest.done) break;
            cache.delete(oldest.value);
        }
        cache.set(key, { expiresAt: now() + CACHE_TTL_MS, result });
    };

    const cachedFindings = (
        engine: ReverseSearchEngineId,
        cacheKey: string,
        runs: ReverseSearchEngineRun[]
    ): ParsedReverseSearch | null => {
        const cached = cacheGet(cacheKey);
        if (cached === null) return null;
        runs.push({ engine, status: 'ok', cached: true, elapsedMs: 0 });
        console.log(`[image-reverse] cache-hit engine=${engine} ${summaryOf(cached)}`);
        return cached;
    };

    const search = async (searchOptions: ReverseSearchOptions): Promise<ReverseSearchOutcome> => {
        const { bytes, mimeType, signal } = searchOptions;
        if (bytes.length > MAX_REVERSE_SEARCH_BYTES) {
            const megabytes = (bytes.length / (1024 * 1024)).toFixed(1);
            return {
                ok: false,
                kind: 'too-large',
                error: `图片 ${megabytes}MB，超过以图搜图上限 ${MAX_REVERSE_SEARCH_BYTES / (1024 * 1024)}MB。`,
            };
        }

        const choice: ReverseSearchEngineChoice = searchOptions.engine ?? 'auto';
        const safe = searchOptions.safe === true;
        const hash = createHash('sha256').update(bytes).digest('hex');
        const runs: ReverseSearchEngineRun[] = [];
        const failures = new Map<ReverseSearchEngineId, ReverseSearchFailureInfo>();

        /**
         * One engine, its own cache entry. A failure is recorded as a run and
         * as a reason, and the caller decides whether another engine still
         * makes the answer worth returning.
         */
        const runEngine = async (
            engine: ReverseSearchEngineId,
            cacheKey: string,
            operation: () => Promise<ParsedReverseSearch>
        ): Promise<ParsedReverseSearch | null> => {
            const cached = cachedFindings(engine, cacheKey, runs);
            if (cached !== null) return cached;

            const startedAt = now();
            try {
                const result = await operation();
                const elapsedMs = Math.max(0, now() - startedAt);
                runs.push({ engine, status: 'ok', cached: false, elapsedMs });
                cachePut(cacheKey, result);
                console.log(
                    `[image-reverse] engine=${engine} ok bytes=${bytes.length} elapsed=${elapsedMs} ${summaryOf(result)}`
                );
                return result;
            } catch (error) {
                const elapsedMs = Math.max(0, now() - startedAt);
                const failure = failureOf(error, signal, ENGINE_LABELS[engine]);
                failures.set(engine, failure);
                runs.push({
                    engine,
                    status: 'failed',
                    cached: false,
                    elapsedMs,
                    kind: failure.kind,
                    error: failure.error,
                });
                console.log(
                    `[image-reverse] engine=${engine} failed kind=${failure.kind} elapsed=${elapsedMs} ` +
                        `detail=${failure.error}`
                );
                return null;
            }
        };

        /** Why the SauceNAO engine cannot run at all right now; null when it can */
        const supplementBlockedReason = (): string | null => {
            if (!config.sauceNaoEnabled) return 'switch-off';
            if (config.sauceNaoApiKey === '') return 'no-api-key';
            return null;
        };

        /** SauceNAO as the supplement: a missing key is reported, a switch-off is not */
        const supplement = async (): Promise<ParsedReverseSearch | null> => {
            const blocked = supplementBlockedReason();
            if (blocked === 'switch-off') {
                console.log('[image-reverse] auto supplement skipped reason=switch-off');
                return null;
            }
            if (blocked === 'no-api-key') {
                const failure: ReverseSearchFailureInfo = {
                    kind: 'unconfigured',
                    error: 'SauceNAO 图库检索需要 SAUCENAO_API_KEY，当前没有配置。',
                };
                failures.set('saucenao', failure);
                runs.push({
                    engine: 'saucenao',
                    status: 'failed',
                    cached: false,
                    elapsedMs: 0,
                    kind: failure.kind,
                    error: failure.error,
                });
                console.log('[image-reverse] auto supplement skipped reason=no-api-key');
                return null;
            }
            return runEngine('saucenao', `saucenao:${safe ? 'safe' : 'all'}:${hash}`, () =>
                sauceNao.search({ bytes, mimeType, signal, safe })
            );
        };

        const resultOf = (engineFindings: EngineFindings): ReverseSearchResult => ({
            sites: mergeSites([
                ...(engineFindings.yandex?.sites ?? []),
                ...(engineFindings.saucenao?.sites ?? []),
                ...(engineFindings.tracemoe?.sites ?? []),
            ]),
            sizes: engineFindings.yandex?.sizes ?? [],
            similar: engineFindings.yandex?.similar ?? [],
            tags: engineFindings.yandex?.tags ?? [],
            engines: runs,
        });

        // Cache hit means the tool spends none of its per-reply budget. A
        // supplement skipped for a missing key costs nothing either.
        const successOf = (engineFindings: EngineFindings): ReverseSearchOutcome => ({
            ok: true,
            result: resultOf(engineFindings),
            cached:
                runs.length > 0 &&
                runs.every((run) => (run.status === 'ok' ? run.cached : run.kind === 'unconfigured')),
        });

        const failureOutcomeOf = (engine: ReverseSearchEngineId): ReverseSearchOutcome => {
            const failure = failures.get(engine);
            return {
                ok: false,
                kind: failure?.kind ?? 'network',
                error: failureTextOf(failure),
            };
        };

        const autoFailure = (): ReverseSearchOutcome => {
            const yandexFailure = failures.get('yandex');
            const sauceFailure = failures.get('saucenao');
            if (yandexFailure !== undefined && sauceFailure !== undefined) {
                return {
                    ok: false,
                    kind: yandexFailure.kind,
                    error: `${yandexFailure.error} SauceNAO 补充检索也不可用：${sauceFailure.error}`,
                };
            }
            return failureOutcomeOf(yandexFailure !== undefined ? 'yandex' : 'saucenao');
        };

        if (choice === 'yandex') {
            const result = await runEngine('yandex', `yandex:${hash}`, () =>
                yandex.search({ bytes, mimeType, signal })
            );
            if (result === null) return failureOutcomeOf('yandex');
            return successOf({ yandex: result });
        }

        if (choice === 'saucenao') {
            if (!config.sauceNaoEnabled) {
                return {
                    ok: false,
                    kind: 'unconfigured',
                    error: "SauceNAO 补充引擎已关闭（IMAGE_REVERSE_SEARCH_SAUCENAO=0）；可以改用 engine='yandex' 或 'auto'。",
                };
            }
            const result = await runEngine('saucenao', `saucenao:${safe ? 'safe' : 'all'}:${hash}`, () =>
                sauceNao.search({ bytes, mimeType, signal, safe })
            );
            if (result === null) return failureOutcomeOf('saucenao');
            return successOf({ saucenao: result });
        }

        if (choice === 'tracemoe') {
            const result = await runEngine('tracemoe', `tracemoe:${hash}`, () =>
                traceMoe.search({ bytes, mimeType, signal })
            );
            if (result === null) return failureOutcomeOf('tracemoe');
            return successOf({ tracemoe: result });
        }

        // auto: Yandex first, SauceNAO only when the result asks for it
        const yandexResult = await runEngine('yandex', `yandex:${hash}`, () =>
            yandex.search({ bytes, mimeType, signal })
        );
        if (yandexResult === null) {
            const sauceResult = await supplement();
            if (sauceResult === null) return autoFailure();
            return successOf({ saucenao: sauceResult });
        }

        const weakness = isWeak(yandexResult);
        const twoDimensional = isTwoDimensional(yandexResult);
        if (!weakness && !twoDimensional) return successOf({ yandex: yandexResult });

        console.log(
            `[image-reverse] auto yandex=ok weak=${weakness} twoD=${twoDimensional} → saucenao`
        );
        const sauceResult = await supplement();
        if (sauceResult === null) return successOf({ yandex: yandexResult });
        return successOf({ yandex: yandexResult, saucenao: sauceResult });
    };

    return {
        search,
        clearCache: () => cache.clear(),
    };
};

let defaultService: ReverseSearchService | undefined;

const defaultServiceOf = (): ReverseSearchService => (defaultService ??= createReverseSearchService());

/** One search through the env-configured engines; what the tool calls */
export const searchByImage = (options: ReverseSearchOptions): Promise<ReverseSearchOutcome> =>
    defaultServiceOf().search(options);

/** Only for tests: forget everything the default service cached */
export const clearReverseSearchCache = (): void => {
    defaultServiceOf().clearCache();
};
