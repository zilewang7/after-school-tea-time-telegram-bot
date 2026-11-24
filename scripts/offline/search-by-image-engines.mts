/**
 * Offline cases for find_image(mode="reverse")'s engines (harness issue #14, design
 * 2026-1124-0608 sections 5 / 6): the SauceNAO JSON API, the Yandex `[同图]`
 * marks, trace.moe, the engine choice and every degrade path.
 *
 * No network: one stub server answers as Yandex, SauceNAO and trace.moe, and
 * every case records the requests it saw. The service takes the three origins,
 * the clock and the config as options, so limits and caching can be tested
 * without waiting or touching the env.
 *
 * Run: npx tsx scripts/offline/search-by-image-engines.mts
 */
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import {
    expect,
    reportResults,
    runCase,
    setupOfflineDb,
    type CaseResult,
} from './harness.mts';
import { createUnusedApi } from './fake-telegram.mts';
import { startStubServer } from './support/stub-server.mts';
import type { ContextIndex, ContextIndexEntry } from '../../src/reply/context-index.js';
import type { ReplyToolContext } from '../../src/reply/tools/reply-tool-context.js';
import type { ReverseSearchConfig } from '../../src/config/reverse-search-config.js';
import type {
    ReverseSearchOptions,
    ReverseSearchService,
} from '../../src/services/image-reverse-search-service.js';
import type { ParsedReverseSearch } from '../../src/services/image-reverse-search-types.js';
import { isJsonObject } from '../../src/shared/json-object.js';

// The platforms build their clients at import time; nothing here sends a request
for (const key of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'GROK_API_KEY', 'MIMO_API_KEY']) {
    process.env[key] ||= 'offline-placeholder';
}
await setupOfflineDb();

const { createFindImageTool } = await import('../../src/reply/tools/find-image-tool.js');
const { createReplyMediaState } = await import('../../src/reply/tools/reply-media-state.js');
const { parseSearchByImageArgs } = await import('../../src/reply/tools/media-tool-args.js');
const { createReverseSearchService } = await import('../../src/services/image-reverse-search-service.js');
const { parseSauceNaoJson } = await import('../../src/services/image-reverse-search-saucenao.js');
const { parseTraceMoeJson } = await import('../../src/services/image-reverse-search-tracemoe.js');
const { readReverseSearchConfig } = await import('../../src/config/reverse-search-config.js');

const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlZkAAAAASUVORK5CYII=',
    'base64'
);

// ---------------------------------------------------------------------------
// The stub server: Yandex upload + result page, SauceNAO JSON, trace.moe JSON
// ---------------------------------------------------------------------------

interface StubRequest {
    readonly method: string;
    readonly pathname: string;
    readonly search: URLSearchParams;
    readonly headers: IncomingHttpHeaders;
    readonly body: Buffer;
}

const recorded: StubRequest[] = [];
const requestsTo = (pathname: string): StubRequest[] => recorded.filter((entry) => entry.pathname === pathname);

interface SiteFixture {
    readonly title: string;
    readonly url: string;
    readonly domain: string;
    readonly thumbUrl?: string;
    readonly thumbMark?: string;
    readonly description?: string;
}

interface SizeFixture {
    readonly url: string;
    readonly width: number;
    readonly height: number;
}

interface SimilarFixture {
    readonly title: string;
    readonly imageUrl: string;
}

interface YandexPageOptions {
    readonly tags?: readonly string[];
    readonly sizes?: readonly SizeFixture[];
    readonly sites?: readonly SiteFixture[];
    readonly similar?: readonly SimilarFixture[];
}

const tagsSection = (tags: readonly string[]): string =>
    tags
        .map(
            (tag) =>
                `<a class="Button Tags-Item" href="/images/search?text=x"><span class="Button-Text">${tag}</span></a>`
        )
        .join('');

const sizesSection = (sizes: readonly SizeFixture[]): string =>
    sizes
        .map(
            (size) =>
                `<a target="_blank" href="${size.url}" aria-label="${size.width} на ${size.height}" class="Button Tags-Item">` +
                `<span class="Button-Text">${size.width}×${size.height}</span></a>`
        )
        .join('');

const similarSection = (similar: readonly SimilarFixture[]): string =>
    similar
        .map(
            (item) =>
                `<div class="CbirSimilarList-Thumb"><a href="/images/search?img_url=${encodeURIComponent(item.imageUrl)}&cbir_id=1%2Fabc" class="Link Thumb">` +
                `<div class="Image Thumb-Image" role="img" aria-label="${item.title}"></div></a></div>`
        )
        .join('');

const sitesSection = (sites: readonly SiteFixture[]): string =>
    sites
        .map((site) => {
            const thumb =
                site.thumbUrl === undefined
                    ? ''
                    : `<a href="${site.thumbUrl}" class="Link Thumb"><img class="Image Thumb-Image" src="//avatars.mds.yandex.net/i?id=1" width="148" height="90" alt="">` +
                      (site.thumbMark === undefined ? '' : `<div class="Thumb-Mark Typo Typo_text_s">${site.thumbMark}</div>`) +
                      '</a>';
            const description = site.description ?? '';
            return (
                '<li class="CbirSites-Item">' +
                `<div class="CbirSites-ItemThumb" aria-hidden="true">${thumb}</div>` +
                '<div class="CbirSites-ItemInfo">' +
                `<div class="CbirSites-ItemTitle"><a href="${site.url}" target="_blank" class="Link">${site.title}</a></div>` +
                `<a class="Link CbirSites-ItemDomain" href="${site.url}" target="_blank">${site.domain}</a>` +
                `<div class="CbirSites-ItemDescription" aria-hidden="true">${description}</div>` +
                '</div></li>'
            );
        })
        .join('');

const yandexHtmlOf = (options: YandexPageOptions): string =>
    '<!doctype html><html><body>' +
    `<section class="CbirSection CbirTags">${tagsSection(options.tags ?? [])}</section>` +
    `<section class="CbirSection CbirOtherSizes">${sizesSection(options.sizes ?? [])}</section>` +
    `<section class="CbirSection CbirSimilarList">${similarSection(options.similar ?? [])}</section>` +
    `<section class="CbirSection CbirSitesList"><ul class="CbirSites-Items">${sitesSection(options.sites ?? [])}</ul></section>` +
    '</body></html>';

const PHOTO_PAGE = yandexHtmlOf({
    tags: ['собака', 'сиба-ину'],
    sites: [
        {
            title: '来源一',
            url: 'https://example.com/page-1',
            domain: 'example.com',
            thumbUrl: 'https://cdn.example.com/other.jpg',
        },
    ],
});

const DRAWN_PAGE = yandexHtmlOf({
    tags: ['аниме', 'девушка'],
    sites: [
        {
            title: '转载一',
            url: 'https://example.com/repost-1',
            domain: 'example.com',
            thumbUrl: 'https://cdn.example.com/resized.jpg',
        },
    ],
});

const WEAK_PAGE = yandexHtmlOf({ tags: ['фото'] });

/** One page whose first source holds the very picture (thumb URL in the sizes) */
const SAME_IMAGE_PAGE = yandexHtmlOf({
    tags: ['рисунок'],
    sizes: [{ url: 'https://cdn.example.com/original.jpg?w=1200&h=628', width: 1200, height: 628 }],
    sites: [
        {
            title: '同图来源',
            url: 'https://example.com/exact',
            domain: 'example.com',
            thumbUrl: 'https://cdn.example.com/original.jpg',
            thumbMark: '1200×628',
        },
        {
            title: '近似来源',
            url: 'https://example.com/other',
            domain: 'example.com',
            thumbUrl: 'https://cdn.example.com/another.jpg',
            thumbMark: '800×600',
        },
    ],
    similar: [{ title: '相似图一', imageUrl: 'https://cdn.example.com/similar-1.jpg' }],
});

interface SauceNaoResultFixture {
    readonly similarity: string;
    readonly indexName?: string;
    readonly indexId?: string;
    readonly hidden?: number;
    readonly data: Readonly<Record<string, unknown>>;
}

const EXACT_RESULT: SauceNaoResultFixture = {
    similarity: '92.52',
    indexName: 'Yande.re',
    indexId: '12',
    data: {
        creator: 'nana (luna berry)',
        source: 'https://x.com/nanananaaannaa/status/2062813137326490008',
        ext_urls: ['https://yande.re/post/show/1272832'],
        yandere_id: 1272832,
    },
};

const LIKELY_RESULT: SauceNaoResultFixture = {
    similarity: '76.30',
    indexName: 'Pixiv',
    indexId: '5',
    data: {
        title: '作品标题',
        member_name: '竜',
        pixiv_id: 53520942,
        ext_urls: [],
    },
};

const LOW_RESULT: SauceNaoResultFixture = {
    similarity: '62.10',
    indexName: 'Danbooru',
    indexId: '9',
    data: { danbooru_id: 123, ext_urls: ['https://danbooru.donmai.us/posts/123'] },
};

const HIDDEN_RESULT: SauceNaoResultFixture = {
    similarity: '95.00',
    indexName: 'Danbooru',
    indexId: '9',
    hidden: 1,
    data: { danbooru_id: 456, ext_urls: ['https://danbooru.donmai.us/posts/456'] },
};

const sauceNaoJsonOf = (
    results: readonly SauceNaoResultFixture[],
    header: { readonly status?: number; readonly message?: string } = {}
): string =>
    JSON.stringify({
        header: {
            status: header.status ?? 0,
            message: header.message ?? '',
            long_limit: '100',
            long_remaining: 90,
            short_limit: 4,
            short_remaining: 3,
            results_returned: results.length,
        },
        results: results.map((result) => ({
            header: {
                similarity: result.similarity,
                index_id: result.indexId ?? '12',
                index_name: result.indexName ?? 'Yande.re',
                thumbnail: 'https://img.example/thumb.jpg',
                hidden: result.hidden ?? 0,
            },
            data: result.data,
        })),
    });

const DEFAULT_SAUCENAO = sauceNaoJsonOf([EXACT_RESULT]);

const DEFAULT_TRACEMOE = JSON.stringify({
    frameCount: 745506,
    error: '',
    quota: 100,
    quotaUsed: 1,
    result: [
        {
            anilist: {
                id: 99939,
                idMal: 34658,
                title: { native: 'ネコぱらOVA', romaji: 'Nekopara OVA', english: null },
                isAdult: false,
            },
            filename: 'Nekopara - OVA (BD 1280x720 x264 AAC).mp4',
            episode: 2,
            duration: 3486.4817,
            from: 97.7226,
            to: 98.8905,
            at: 98.2231,
            similarity: 0.9440424588727485,
            image: 'https://api.trace.moe/image/uAWzRPYDwVC2pxTsPyqvLeh',
        },
    ],
});

let yandexUploadStatus = 200;
let yandexPageStatus = 200;
let yandexPageHtml = PHOTO_PAGE;
let sauceNaoStatus = 200;
let sauceNaoContentType = 'application/json';
let sauceNaoBody = DEFAULT_SAUCENAO;
let traceMoeStatus = 200;
let traceMoeBody = DEFAULT_TRACEMOE;

const resetEngineAnswers = (): void => {
    recorded.length = 0;
    yandexUploadStatus = 200;
    yandexPageStatus = 200;
    yandexPageHtml = PHOTO_PAGE;
    sauceNaoStatus = 200;
    sauceNaoContentType = 'application/json';
    sauceNaoBody = DEFAULT_SAUCENAO;
    traceMoeStatus = 200;
    traceMoeBody = DEFAULT_TRACEMOE;
};

const readBody = (request: IncomingMessage): Promise<Buffer> =>
    new Promise((resolve) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => resolve(Buffer.concat(chunks)));
    });

const answer = (response: ServerResponse, status: number, contentType: string, body: string): void => {
    response.writeHead(status, { 'Content-Type': contentType });
    response.end(body);
};

const stub = await startStubServer();
stub.handle((request, response) => {
    void (async () => {
        const body = await readBody(request);
        const url = new URL(request.url ?? '/', 'http://stub');
        recorded.push({
            method: request.method ?? '',
            pathname: url.pathname,
            search: url.searchParams,
            headers: request.headers,
            body,
        });

        if (url.pathname === '/yandex/images/search') {
            if (url.searchParams.get('format') === 'json') {
                if (yandexUploadStatus !== 200) {
                    answer(response, yandexUploadStatus, 'text/plain', 'stub upload failure');
                    return;
                }
                answer(
                    response,
                    200,
                    'application/json',
                    JSON.stringify({ blocks: [{ params: { cbirId: 'offline/cbir' } }] })
                );
                return;
            }
            if (yandexPageStatus !== 200) {
                answer(response, yandexPageStatus, 'text/plain', 'stub page failure');
                return;
            }
            answer(response, 200, 'text/html; charset=utf-8', yandexPageHtml);
            return;
        }
        if (url.pathname === '/saucenao/search.php') {
            answer(response, sauceNaoStatus, sauceNaoContentType, sauceNaoBody);
            return;
        }
        if (url.pathname === '/tracemoe/search') {
            answer(response, traceMoeStatus, 'application/json', traceMoeBody);
            return;
        }
        answer(response, 404, 'text/plain', 'no such stub');
    })();
});

const ORIGINS = {
    yandexOrigin: `${stub.url}/yandex`,
    sauceNaoOrigin: `${stub.url}/saucenao`,
    traceMoeOrigin: `${stub.url}/tracemoe`,
} as const;

const configOf = (overrides: Partial<ReverseSearchConfig> = {}): ReverseSearchConfig => ({
    sauceNaoEnabled: true,
    sauceNaoApiKey: 'offline-api-key',
    sauceNaoPacing: { minIntervalMs: 0, dailyLimit: 50, circuitMs: 30 * 60 * 1000 },
    ...overrides,
});

interface EngineServiceOptions {
    readonly config?: ReverseSearchConfig;
    readonly now?: () => number;
}

const serviceOf = (options: EngineServiceOptions = {}): ReverseSearchService =>
    createReverseSearchService({
        ...ORIGINS,
        config: options.config ?? configOf(),
        ...(options.now === undefined ? {} : { now: options.now }),
    });

const searchOf = (
    service: ReverseSearchService,
    overrides: Partial<ReverseSearchOptions> = {}
): Promise<Awaited<ReturnType<ReverseSearchService['search']>>> =>
    service.search({ bytes: PNG, mimeType: 'image/png', ...overrides });

/** Distinct bytes for pacing cases: the per-engine cache must not hide a request */
const probeBytes = (label: string): Buffer => Buffer.concat([PNG, Buffer.from(` ${label}`)]);

// ---------------------------------------------------------------------------
// The tool, so the model-facing text and the sN candidates are covered too
// ---------------------------------------------------------------------------

const entryOf = (data: Buffer, number = 1): ContextIndexEntry => ({
    number,
    messageId: 100 + number,
    fromBot: false,
    images: [{ origin: 'attachment', part: { type: 'image', imageData: data.toString('base64') } }],
    imageCount: 1,
});

const contextOf = (contextIndex: ContextIndex): ReplyToolContext => ({
    chatId: -1001,
    chatTitle: '测试群',
    triggerMessageId: 10,
    requester: { userId: 1, name: 'tester' },
    contextIndex,
    signal: new AbortController().signal,
    // find_image(mode="reverse") never calls the Bot API; this client fails any call
    api: createUnusedApi(),
});

interface ToolFixture {
    readonly tool: ReturnType<typeof createFindImageTool>;
    readonly state: ReturnType<typeof createReplyMediaState>;
    readonly searchOptions: ReverseSearchOptions[];
}

const toolOf = (
    service: ReverseSearchService,
    index: ContextIndex = new Map([[1, entryOf(PNG)]]),
    state = createReplyMediaState()
): ToolFixture => {
    const searchOptions: ReverseSearchOptions[] = [];
    return {
        state,
        searchOptions,
        tool: createFindImageTool({
            state,
            webEnabled: false,
            reverseEnabled: true,
            context: contextOf(index),
            reverseDependencies: {
                search: (options) => {
                    searchOptions.push(options);
                    return service.search(options);
                },
                loadMessageImages: async () => [],
                loadAnimationFrame: async () => null,
                fetchImage: async () => ({ ok: false, error: 'offline' }),
            },
        }),
    };
};

/** One named property of a tool schema; null when the schema has no such object */
const schemaPropertyOf = (
    schema: Readonly<Record<string, unknown>>,
    name: string
): Record<string, unknown> | null => {
    const properties = schema.properties;
    if (!isJsonObject(properties)) return null;
    const property = properties[name];
    return isJsonObject(property) ? property : null;
};

const cases: CaseResult[] = [];

// ---------------------------------------------------------------------------
// Parameters and schema
// ---------------------------------------------------------------------------

cases.push(
    await runCase('engine and safe are parsed, and values outside the contract are refused', async () => {
        const plain = parseSearchByImageArgs({ message: 1 });
        expect(plain.ok && plain.args.engine === 'auto' && plain.args.safe === false, 'defaults: auto, safe off');

        for (const engine of ['yandex', 'saucenao', 'tracemoe', 'auto'] as const) {
            const parsed = parseSearchByImageArgs({ message: 1, engine });
            expect(parsed.ok && parsed.args.engine === engine, `engine=${engine} parses`);
        }
        const safe = parseSearchByImageArgs({ message: 1, safe: true });
        expect(safe.ok && safe.args.safe === true, 'safe=true parses');
        const blanks = parseSearchByImageArgs({ message: 1, engine: '', safe: '' });
        expect(
            blanks.ok && blanks.args.engine === 'auto' && blanks.args.safe === false,
            'blank optional fields count as absent'
        );

        const badEngine = parseSearchByImageArgs({ message: 1, engine: 'bing' });
        expect(!badEngine.ok && badEngine.error.includes("engine 只能是 'auto'"), 'an unknown engine is refused');
        const badSafe = parseSearchByImageArgs({ message: 1, safe: 'yes' });
        expect(!badSafe.ok && badSafe.error.includes('safe 只能是 true 或 false'), 'a non-boolean safe is refused');

        const { tool } = toolOf(serviceOf());
        const engineSchema = schemaPropertyOf(tool.definition.inputSchema, 'engine');
        expect(engineSchema?.type === 'string', 'the schema declares engine as a string');
        const engineEnum = engineSchema?.enum;
        expect(
            Array.isArray(engineEnum) && engineEnum.join('|') === 'auto|yandex|saucenao|tracemoe',
            `the schema lists the engines (got ${JSON.stringify(engineEnum)})`
        );
        const safeSchema = schemaPropertyOf(tool.definition.inputSchema, 'safe');
        expect(
            safeSchema?.type === 'boolean',
            'the schema declares safe as a boolean'
        );
        expect(tool.definition.description.includes('SauceNAO'), 'the description names the supplement');
        expect(
            typeof safeSchema?.description === 'string' && safeSchema.description.includes('R-18'),
            'the safe field description names the filter switch'
        );
    })
);

// ---------------------------------------------------------------------------
// SauceNAO: JSON parsing and the request itself
// ---------------------------------------------------------------------------

cases.push(
    await runCase('the SauceNAO JSON becomes scored sources; low and hidden results are dropped', async () => {
        const findings: ParsedReverseSearch = parseSauceNaoJson(
            sauceNaoJsonOf([EXACT_RESULT, LIKELY_RESULT, LOW_RESULT, HIDDEN_RESULT])
        );
        expect(findings.sites.length === 2, `two usable results (got ${findings.sites.length})`);
        expect(findings.sizes.length === 0 && findings.similar.length === 0, 'SauceNAO has no sizes or similar list');

        const exact = findings.sites[0];
        expect(exact?.engine === 'saucenao', 'a SauceNAO site names its engine');
        expect(exact?.match === 'exact', '92.5% is an exact match');
        expect(exact?.similarity === 92.5, `the similarity is a percentage (got ${exact?.similarity})`);
        expect(exact?.url === 'https://x.com/nanananaaannaa/status/2062813137326490008', 'the source page wins over the gallery');
        expect(exact?.domain === 'x.com', 'the domain comes off that URL');
        expect(exact?.title === 'nana (luna berry)', `the creator names the result (got ${exact?.title})`);
        expect(exact?.description.includes('Yande.re'), 'the gallery is kept in the description');

        const likely = findings.sites[1];
        expect(likely?.match === 'likely', '76.3% is a likely match');
        expect(
            likely?.url === 'https://www.pixiv.net/artworks/53520942',
            `a missing ext_urls falls back to the pixiv id (got ${likely?.url})`
        );
        expect(likely?.title === '作品标题（竜）', `the artwork title and member are joined (got ${likely?.title})`);

        const empty = parseSauceNaoJson(sauceNaoJsonOf([]));
        expect(empty.sites.length === 0, 'a status-0 answer with no results is an empty result, not a failure');

        const anonymous = (() => {
            try {
                parseSauceNaoJson(
                    JSON.stringify({
                        header: { status: -1, message: 'The anonymous account type does not permit API usage.' },
                        results: [],
                    })
                );
                return null;
            } catch (error) {
                return error instanceof Error ? error : null;
            }
        })();
        expect(anonymous?.message.includes('SAUCENAO_API_KEY') === true, 'an API refusal names the key');

        const notJson = (() => {
            try {
                parseSauceNaoJson('<html>not json</html>');
                return null;
            } catch (error) {
                return error instanceof Error ? error : null;
            }
        })();
        expect(notJson?.message.includes('不是 JSON') === true, 'a non-JSON answer is a parse failure');
    })
);

cases.push(
    await runCase('the SauceNAO call is a sized multipart upload with the API options in the query', async () => {
        resetEngineAnswers();
        const service = serviceOf();
        const outcome = await searchOf(service, { engine: 'saucenao' });
        expect(outcome.ok, `the stubbed JSON answers (${outcome.ok ? '' : outcome.error})`);
        if (!outcome.ok) return;

        expect(outcome.result.sites.length === 1, 'the exact result is kept');
        expect(outcome.result.sites[0]?.engine === 'saucenao', 'the tool sees a SauceNAO source');
        expect(outcome.cached === false, 'a first call is not cached');

        const [request] = requestsTo('/saucenao/search.php');
        expect(request !== undefined, 'SauceNAO was called once');
        if (request === undefined) return;
        expect(request.method === 'POST', 'the upload is a POST');
        const contentType = String(request.headers['content-type'] ?? '');
        expect(contentType.startsWith('multipart/form-data; boundary='), 'the body declares its own boundary');
        expect(
            Number(request.headers['content-length']) === request.body.length,
            'the body length is explicit, not chunked'
        );
        expect(request.body.includes(PNG), 'the picture rides inside that body');
        expect(request.body.toString('latin1').includes('name="file"'), 'the picture is the multipart form field');
        expect(request.search.get('api_key') === 'offline-api-key', 'the API key is a query option');
        expect(request.search.get('output_type') === '2', 'output_type=2 (JSON)');
        expect(request.search.get('numres') === '5', 'numres=5');
        expect(request.search.get('db') === '999', 'db=999 (all galleries)');
        expect(request.search.get('hide') === '0', 'hide=0: no R-18 filter');
    })
);

cases.push(
    await runCase('safe=true sends hide=3 and the text says the safe tier was used', async () => {
        resetEngineAnswers();
        const service = serviceOf();
        const { tool, state } = toolOf(service);
        const result = await tool.execute({ message: 1, engine: 'saucenao', safe: true }, new AbortController().signal);
        expect(!result.isError, `the call succeeds (${result.content})`);

        const [request] = requestsTo('/saucenao/search.php');
        expect(request?.search.get('hide') === '3', 'the query carries hide=3');
        expect(result.content.includes('安全档'), `the text tells the model the filter was used (${result.content})`);
        expect(result.content.includes('92.5%'), 'the similarity percentage is shown');
        expect(state.candidates.size === 0, 'SauceNAO adds no sN candidates');
    })
);

// ---------------------------------------------------------------------------
// auto: when the supplement runs, and when it does not
// ---------------------------------------------------------------------------

cases.push(
    await runCase('auto adds SauceNAO for a drawn picture and merges both answers', async () => {
        resetEngineAnswers();
        yandexPageHtml = DRAWN_PAGE;
        const service = serviceOf();
        const outcome = await searchOf(service);
        expect(outcome.ok, `the search succeeds (${outcome.ok ? '' : outcome.error})`);
        if (!outcome.ok) return;

        expect(requestsTo('/yandex/images/search').length === 2, 'Yandex upload + result page');
        expect(requestsTo('/saucenao/search.php').length === 1, 'the anime tags triggered the supplement');
        const engines = outcome.result.engines.map((run) => `${run.engine}:${run.status}`).join(',');
        expect(engines === 'yandex:ok,saucenao:ok', `both engines answered (got ${engines})`);
        expect(
            outcome.result.sites.some((site) => site.engine === 'yandex') &&
                outcome.result.sites.some((site) => site.engine === 'saucenao'),
            'the merged sites carry both engines'
        );
        expect(outcome.result.sites.length === 2, `two distinct pages (got ${outcome.result.sites.length})`);
    })
);

cases.push(
    await runCase('auto does not ask SauceNAO for a photographed subject', async () => {
        resetEngineAnswers();
        yandexPageHtml = PHOTO_PAGE;
        const outcome = await searchOf(serviceOf());
        expect(outcome.ok, 'the search succeeds');
        expect(requestsTo('/saucenao/search.php').length === 0, 'no supplement request');
        expect(outcome.ok && outcome.result.engines.length === 1, 'only the Yandex run is recorded');
    })
);

cases.push(
    await runCase('auto asks SauceNAO when Yandex found nothing useful', async () => {
        resetEngineAnswers();
        yandexPageHtml = WEAK_PAGE;
        const outcome = await searchOf(serviceOf());
        expect(outcome.ok, 'the search succeeds');
        expect(requestsTo('/saucenao/search.php').length === 1, 'a weak Yandex result triggers the supplement');
        expect(outcome.ok && outcome.result.engines.length === 2, 'both runs are recorded');
    })
);

cases.push(
    await runCase('auto falls back to SauceNAO when Yandex is blocked, and only fails when both are', async () => {
        resetEngineAnswers();
        yandexUploadStatus = 403;
        const fallenBack = await searchOf(serviceOf());
        expect(fallenBack.ok, `the SauceNAO answer carries the call (${fallenBack.ok ? '' : fallenBack.error})`);
        if (fallenBack.ok) {
            const engines = fallenBack.result.engines.map((run) => `${run.engine}:${run.status}`).join(',');
            expect(engines === 'yandex:failed,saucenao:ok', `Yandex failed, SauceNAO answered (got ${engines})`);
            expect(fallenBack.result.sites.length === 1, 'the SauceNAO source is returned');
        }

        resetEngineAnswers();
        yandexUploadStatus = 403;
        sauceNaoStatus = 429;
        const bothFailed = await searchOf(serviceOf());
        expect(!bothFailed.ok, 'no engine answered: the call fails');
        if (!bothFailed.ok) {
            expect(bothFailed.kind === 'blocked', `the Yandex failure keeps its kind (got ${bothFailed.kind})`);
            expect(bothFailed.error.includes('Yandex'), 'the error names Yandex');
            expect(bothFailed.error.includes('SauceNAO'), 'and the supplement');
        }
    })
);

cases.push(
    await runCase('a switched-off or keyless SauceNAO never blocks the Yandex answer', async () => {
        resetEngineAnswers();
        yandexPageHtml = DRAWN_PAGE;

        const switchedOff = serviceOf({ config: configOf({ sauceNaoEnabled: false }) });
        const switchedOffOutcome = await searchOf(switchedOff);
        expect(switchedOffOutcome.ok, 'auto still answers');
        expect(requestsTo('/saucenao/search.php').length === 0, 'the switch keeps SauceNAO from running');
        const explicitOff = await searchOf(switchedOff, { engine: 'saucenao' });
        expect(!explicitOff.ok && explicitOff.error.includes('已关闭'), 'naming it explicitly says it is off');

        resetEngineAnswers();
        const keyless = serviceOf({ config: configOf({ sauceNaoApiKey: '' }) });
        const keylessOutcome = await searchOf(keyless);
        expect(keylessOutcome.ok, 'auto still answers without a key');
        expect(requestsTo('/saucenao/search.php').length === 0, 'no request without a key');
        const notConfigured = await searchOf(keyless, { engine: 'saucenao' });
        expect(
            !notConfigured.ok && notConfigured.kind === 'unconfigured' && notConfigured.error.includes('SAUCENAO_API_KEY'),
            `an explicit keyless call is a readable unconfigured error (got ${notConfigured.ok ? 'ok' : notConfigured.error})`
        );

        // The tool text says the supplement was unavailable instead of silently omitting it
        resetEngineAnswers();
        yandexPageHtml = DRAWN_PAGE;
        const { tool } = toolOf(serviceOf({ config: configOf({ sauceNaoApiKey: '' }) }));
        const result = await tool.execute({ message: 1 }, new AbortController().signal);
        expect(!result.isError, `the tool call succeeds (${result.content})`);
        expect(
            result.content.includes('SauceNAO 补充检索本次不可用（未配置 API key）'),
            `the note names the missing key (${result.content})`
        );
    })
);

// ---------------------------------------------------------------------------
// Explicit engines
// ---------------------------------------------------------------------------

cases.push(
    await runCase('engine=yandex never asks SauceNAO, even for a drawn picture', async () => {
        resetEngineAnswers();
        yandexPageHtml = DRAWN_PAGE;
        const outcome = await searchOf(serviceOf(), { engine: 'yandex' });
        expect(outcome.ok, 'the search succeeds');
        expect(requestsTo('/saucenao/search.php').length === 0, 'no supplement');
        expect(outcome.ok && outcome.result.engines.map((run) => run.engine).join(',') === 'yandex', 'one engine run');
    })
);

cases.push(
    await runCase('engine=saucenao never asks Yandex', async () => {
        resetEngineAnswers();
        const outcome = await searchOf(serviceOf(), { engine: 'saucenao' });
        expect(outcome.ok, 'the search succeeds');
        expect(requestsTo('/yandex/images/search').length === 0, 'no Yandex request');
        expect(requestsTo('/saucenao/search.php').length === 1, 'one SauceNAO request');
        expect(outcome.ok && outcome.result.sizes.length === 0 && outcome.result.similar.length === 0, 'no Yandex lists');
    })
);

cases.push(
    await runCase('engine=tracemoe reports the anime, episode and moment; auto never calls it', async () => {
        resetEngineAnswers();
        const outcome = await searchOf(serviceOf(), { engine: 'tracemoe' });
        expect(outcome.ok, `the search succeeds (${outcome.ok ? '' : outcome.error})`);
        expect(requestsTo('/yandex/images/search').length === 0, 'trace.moe alone: no Yandex');
        expect(requestsTo('/saucenao/search.php').length === 0, 'trace.moe alone: no SauceNAO');
        const [request] = requestsTo('/tracemoe/search');
        expect(request?.search.get('anilistInfo') !== null, 'the request asks for the AniList titles');
        expect(
            String(request?.headers['content-type'] ?? '').startsWith('image/png'),
            'the picture is posted as its own media type'
        );
        expect(Number(request?.headers['content-length']) === PNG.length, 'the body length is explicit');
        if (outcome.ok) {
            const site = outcome.result.sites[0];
            expect(site?.engine === 'tracemoe', 'the source names its engine');
            expect(site?.match === 'exact', '94.4% is an exact match');
            expect(site?.title === 'ネコぱらOVA（Nekopara OVA）', `the title pairs native and romaji (got ${site?.title})`);
            expect(site?.description.includes('第 2 集'), 'the episode is in the description');
            expect(site?.description.includes('1:38'), `the moment is in the description (got ${site?.description})`);
            expect(site?.url === 'https://anilist.co/anime/99939', 'the result links to AniList');
        }

        resetEngineAnswers();
        yandexPageHtml = DRAWN_PAGE;
        await searchOf(serviceOf());
        expect(requestsTo('/tracemoe/search').length === 0, 'auto never spends the trace.moe quota');
    })
);

// ---------------------------------------------------------------------------
// Cache: one entry per engine and per safety tier
// ---------------------------------------------------------------------------

cases.push(
    await runCase('each engine and safety tier has its own cache entry', async () => {
        resetEngineAnswers();
        const service = serviceOf();

        const yandexFirst = await searchOf(service, { engine: 'yandex' });
        expect(yandexFirst.ok && !yandexFirst.cached, 'a first Yandex call hits the network');
        const saucenaoFirst = await searchOf(service, { engine: 'saucenao' });
        expect(saucenaoFirst.ok && !saucenaoFirst.cached, 'the SauceNAO cache key does not collide with Yandex');
        expect(requestsTo('/saucenao/search.php').length === 1, 'SauceNAO really ran');

        const requestsBefore = recorded.length;
        const yandexAgain = await searchOf(service, { engine: 'yandex' });
        const saucenaoAgain = await searchOf(service, { engine: 'saucenao' });
        expect(yandexAgain.ok && yandexAgain.cached, 'the Yandex answer is cached');
        expect(saucenaoAgain.ok && saucenaoAgain.cached, 'the SauceNAO answer is cached');
        expect(recorded.length === requestsBefore, 'cached calls send nothing');

        const safeTier = await searchOf(service, { engine: 'saucenao', safe: true });
        expect(safeTier.ok && !safeTier.cached, 'safe=true has its own cache entry');
        expect(requestsTo('/saucenao/search.php').length === 2, 'and really asked again');

        const autoFirst = await searchOf(service);
        const autoAgain = await searchOf(service);
        expect(autoFirst.ok && autoAgain.ok && autoAgain.cached, 'auto hits the per-engine cache too');
        expect(recorded.length === requestsBefore + 1, 'auto sent nothing new: both engine answers were cached');
    })
);

cases.push(
    await runCase('cached searches do not consume the three-search budget', async () => {
        resetEngineAnswers();
        yandexPageHtml = DRAWN_PAGE;
        const { tool, state } = toolOf(serviceOf());
        const first = await tool.execute({ message: 1 }, new AbortController().signal);
        expect(!first.isError, `the first call succeeds (${first.content})`);
        expect(state.reverseSearchCount === 1, 'a real search counts once');
        for (let call = 0; call < 3; call += 1) {
            const again = await tool.execute({ message: 1 }, new AbortController().signal);
            expect(!again.isError, `cached call ${call + 1} succeeds`);
            expect(again.content.includes('缓存'), 'the text says it came from the cache');
        }
        expect(state.reverseSearchCount === 1, 'cached calls stay out of the budget');
    })
);

// ---------------------------------------------------------------------------
// SauceNAO pacing: interval, daily cap, 429/сaptcha cooldown
// ---------------------------------------------------------------------------

cases.push(
    await runCase('SauceNAO enforces its interval and daily cap without sending a request', async () => {
        resetEngineAnswers();
        let clock = 1_000_000;
        const service = serviceOf({
            config: configOf({
                sauceNaoPacing: { minIntervalMs: 10_000, dailyLimit: 2, circuitMs: 60_000 },
            }),
            now: () => clock,
        });

        const first = await searchOf(service, { engine: 'saucenao', bytes: probeBytes('one') });
        expect(first.ok, `the first request goes out (${first.ok ? '' : first.error})`);
        const tooSoon = await searchOf(service, { engine: 'saucenao', bytes: probeBytes('two') });
        expect(!tooSoon.ok && tooSoon.kind === 'rate-limited', 'a second call inside 10s is refused');
        expect(requestsTo('/saucenao/search.php').length === 1, 'and sends nothing');

        clock += 10_000;
        const second = await searchOf(service, { engine: 'saucenao', bytes: probeBytes('three') });
        expect(second.ok, 'after the interval the second request goes out');
        const atCap = await searchOf(service, { engine: 'saucenao', bytes: probeBytes('four') });
        expect(
            !atCap.ok && atCap.error.includes('今日请求数已达上限'),
            `the daily cap refuses the third (got ${atCap.ok ? 'ok' : atCap.error})`
        );
        expect(requestsTo('/saucenao/search.php').length === 2, 'exactly two requests');
    })
);

cases.push(
    await runCase('a 429 or a Cloudflare wall opens the SauceNAO circuit for the configured cooldown', async () => {
        resetEngineAnswers();
        let clock = 2_000_000;
        const service = serviceOf({
            config: configOf({ sauceNaoPacing: { minIntervalMs: 0, dailyLimit: 50, circuitMs: 60_000 } }),
            now: () => clock,
        });

        sauceNaoStatus = 429;
        const limited = await searchOf(service, { engine: 'saucenao' });
        expect(!limited.ok && limited.kind === 'rate-limited', '429 is a rate limit');
        const cooled = await searchOf(service, { engine: 'saucenao' });
        expect(
            !cooled.ok && cooled.kind === 'rate-limited' && cooled.error.includes('冷却'),
            'the circuit refuses the next call'
        );
        expect(requestsTo('/saucenao/search.php').length === 1, 'no request during the cooldown');

        clock += 60_001;
        sauceNaoStatus = 200;
        const afterCooldown = await searchOf(service, { engine: 'saucenao' });
        expect(afterCooldown.ok, `after the cooldown the engine is tried again (${afterCooldown.ok ? '' : afterCooldown.error})`);
        expect(requestsTo('/saucenao/search.php').length === 2, 'and really sends');

        resetEngineAnswers();
        const challengeService = serviceOf({
            config: configOf({ sauceNaoPacing: { minIntervalMs: 0, dailyLimit: 50, circuitMs: 60_000 } }),
            now: () => clock,
        });
        sauceNaoStatus = 403;
        sauceNaoContentType = 'text/html';
        sauceNaoBody = '<html><title>Just a moment...</title><body>Just a moment...</body></html>';
        const blocked = await searchOf(challengeService, { engine: 'saucenao' });
        expect(!blocked.ok && blocked.kind === 'blocked', 'a Cloudflare wall is blocked, not an empty result');
        if (!blocked.ok) {
            expect(blocked.error.includes('Cloudflare') || blocked.error.includes('验证'), 'the error names the wall');
        }
    })
);

cases.push(
    await runCase('SauceNAO failures keep their kinds, and only an HTTP failure becomes the call error', async () => {
        resetEngineAnswers();
        const networkService = serviceOf({ config: configOf({ sauceNaoPacing: { minIntervalMs: 0, dailyLimit: 50, circuitMs: 0 } }) });
        sauceNaoStatus = 500;
        const network = await searchOf(networkService, { engine: 'saucenao' });
        expect(!network.ok && network.kind === 'network', `500 is a network failure (got ${network.ok ? 'ok' : network.kind})`);

        resetEngineAnswers();
        sauceNaoStatus = 200;
        sauceNaoBody = '<html>a redesign</html>';
        const parseService = serviceOf();
        const parsed = await searchOf(parseService, { engine: 'saucenao' });
        expect(!parsed.ok && parsed.kind === 'parse', `HTML instead of JSON is a parse failure (got ${parsed.ok ? 'ok' : parsed.kind})`);

        resetEngineAnswers();
        sauceNaoBody = sauceNaoJsonOf([EXACT_RESULT], { status: -1, message: 'Invalid API key' });
        const rejected = await searchOf(serviceOf(), { engine: 'saucenao' });
        expect(
            !rejected.ok && rejected.kind === 'unconfigured',
            `an API refusal is unconfigured (got ${rejected.ok ? 'ok' : rejected.kind})`
        );
    })
);

// ---------------------------------------------------------------------------
// Phase 1.5: Yandex source pages carry [同图] / [未验证]
// ---------------------------------------------------------------------------

cases.push(
    await runCase('Yandex source pages are marked [同图] only when the picture is verified', async () => {
        resetEngineAnswers();
        yandexPageHtml = SAME_IMAGE_PAGE;
        const { tool, state } = toolOf(serviceOf({ config: configOf({ sauceNaoEnabled: false }) }));
        const result = await tool.execute({ message: 1 }, new AbortController().signal);
        expect(!result.isError, `the call succeeds (${result.content})`);
        expect(result.content.includes('[同图] 同图来源'), `the backed page is marked (${result.content})`);
        expect(result.content.includes('[未验证] 近似来源'), 'the page without same-image evidence says so');
        expect(result.content.includes('来源页（Yandex'), 'the section says where the marks come from');
        expect(state.candidates.size === 2, `two sizes/similar candidates are registered (got ${state.candidates.size})`);
    })
);

// ---------------------------------------------------------------------------
// The merged model-facing text
// ---------------------------------------------------------------------------

cases.push(
    await runCase('the merged text separates exact sources, likely sources, source pages, sizes, similar pictures and tags', async () => {
        resetEngineAnswers();
        yandexPageHtml = SAME_IMAGE_PAGE;
        sauceNaoBody = sauceNaoJsonOf([EXACT_RESULT, LIKELY_RESULT]);
        const { tool, state } = toolOf(serviceOf());
        const result = await tool.execute({ message: 1 }, new AbortController().signal);
        const text = result.content;
        expect(!result.isError, `the call succeeds (${text})`);

        expect(text.includes('以图搜图（Yandex ') && text.includes('+ SauceNAO '), `the header names both engines (${text})`);
        expect(text.includes('精确来源（SauceNAO，相似度 ≥85%）：'), 'an exact-source section');
        expect(text.includes('1. 92.5% — nana (luna berry) — x.com — '), 'the exact line carries percentage, name and domain');
        expect(text.includes('可能来源（SauceNAO，相似度 70–84%）：'), 'a likely-source section');
        expect(text.includes('76.3%'), 'the likely match keeps its percentage');
        expect(text.includes('来源页（Yandex 认为包含这张图的网页'), 'a source-page section');
        expect(text.includes('[同图] 同图来源'), 'the verified page keeps its mark');
        expect(text.includes('其他尺寸（列出最大的 1 条）'), 'the sizes section');
        expect(text.includes('相似图（列出 1 条）'), 'the similar-pictures section');
        expect(text.includes('识别标签（Yandex，俄语）：рисунок'), 'the Yandex tags');
        expect(text.indexOf('精确来源') < text.indexOf('来源页（Yandex'), 'exact sources come before unverified pages');

        expect(state.candidates.size === 2, `only Yandex sizes/similar become sN (got ${state.candidates.size})`);
        expect(state.candidates.get('s1')?.width === 1200, 'the size candidate keeps its dimensions');
    })
);

cases.push(
    await runCase('a call that cannot search at all fails before the network', async () => {
        resetEngineAnswers();
        const service = serviceOf();
        const tooLarge = Buffer.alloc(9 * 1024 * 1024, 1);
        PNG.copy(tooLarge, 0);
        const outcome = await service.search({ bytes: tooLarge, mimeType: 'image/png' });
        expect(!outcome.ok && outcome.kind === 'too-large', 'over 8MB is refused');
        expect(requestsTo('/yandex/images/search').length === 0, 'nothing was uploaded');

        const controller = new AbortController();
        controller.abort();
        const aborted = await searchOf(service, { signal: controller.signal });
        expect(!aborted.ok && aborted.kind === 'aborted', `an aborted call says so (got ${aborted.ok ? 'ok' : aborted.kind})`);
    })
);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

cases.push(
    await runCase('the engine config reads its env names with sane defaults', async () => {
        const defaults = readReverseSearchConfig({});
        expect(defaults.sauceNaoEnabled && defaults.sauceNaoApiKey === '', 'SauceNAO is on but keyless by default');
        expect(defaults.sauceNaoPacing.minIntervalMs === 10_000, '10s between sauce requests');
        expect(defaults.sauceNaoPacing.dailyLimit === 50, '50 sauce requests a day');
        expect(defaults.sauceNaoPacing.circuitMs === 30 * 60 * 1000, 'a 30 minute cooldown');

        const configured = readReverseSearchConfig({
            SAUCENAO_API_KEY: '  secret-key  ',
            SAUCENAO_MIN_INTERVAL_MS: '15000',
            SAUCENAO_DAILY_LIMIT: '20',
            SAUCENAO_CIRCUIT_MS: '60000',
        });
        expect(configured.sauceNaoApiKey === 'secret-key', 'the key is trimmed');
        expect(configured.sauceNaoPacing.minIntervalMs === 15_000, 'the interval is configurable');
        expect(configured.sauceNaoPacing.dailyLimit === 20, 'the cap is configurable');
        expect(configured.sauceNaoPacing.circuitMs === 60_000, 'the cooldown is configurable');

        const off = readReverseSearchConfig({ IMAGE_REVERSE_SEARCH_SAUCENAO: '0' });
        expect(!off.sauceNaoEnabled, 'the switch turns the supplement off');
    })
);

// ---------------------------------------------------------------------------
// trace.moe parsing and limits without HTTP
// ---------------------------------------------------------------------------

cases.push(
    await runCase('the trace.moe parser keeps titles, episodes and adult flags', async () => {
        const findings = parseTraceMoeJson(
            JSON.stringify({
                error: '',
                result: [
                    {
                        anilist: { id: 1, title: { native: 'カウボーイビバップ', romaji: 'Cowboy Bebop', english: 'Cowboy Bebop' }, isAdult: false },
                        filename: 'Cowboy Bebop - 01.mp4',
                        episode: 1,
                        at: 62.4,
                        similarity: 0.877,
                    },
                    {
                        anilist: { id: 2, title: { native: null, romaji: 'Adult Show', english: null }, isAdult: true },
                        filename: 'adult.mp4',
                        episode: null,
                        episode_start: 3,
                        at: 3600.5,
                        similarity: 0.95,
                    },
                ],
            })
        );
        expect(findings.sites.length === 2, `two matches (got ${findings.sites.length})`);
        expect(findings.sites[0]?.title === 'カウボーイビバップ（Cowboy Bebop）', 'native and romaji are paired');
        expect(findings.sites[0]?.match === 'likely', '87.7% is not a confident match');
        expect(findings.sites[1]?.match === 'exact', '95% is a confident match');
        expect(findings.sites[1]?.description.includes('R-18 动画'), 'the adult flag is reported');
        expect(findings.sites[1]?.description.includes('第 3 集'), 'the episode range is the episode fallback');
        expect(findings.sites[1]?.description.includes('1:00:01'), 'an hour-long moment keeps its hours');

        const quota = (() => {
            try {
                parseTraceMoeJson(JSON.stringify({ error: 'Search quota depleted (quota per 24 hours: 100)' }));
                return null;
            } catch (error) {
                return error instanceof Error ? error : null;
            }
        })();
        expect(quota?.message.includes('暂时不可用') === true, 'a quota error is a rate limit');
    })
);

cases.push(
    await runCase('trace.moe reports a depleted quota and cools down instead of retrying', async () => {
        resetEngineAnswers();
        let clock = 3_000_000;
        const service = serviceOf({ now: () => clock });
        traceMoeStatus = 402;
        traceMoeBody = JSON.stringify({ quota: 100, quotaUsed: 100, error: 'Search quota depleted (quota per 24 hours: 100, used: 100)' });
        const depleted = await searchOf(service, { engine: 'tracemoe', bytes: probeBytes('tm-one') });
        expect(!depleted.ok && depleted.kind === 'rate-limited', '402 is a rate limit, not a parse failure');
        expect(requestsTo('/tracemoe/search').length === 1, 'one request');

        const cooled = await searchOf(service, { engine: 'tracemoe', bytes: probeBytes('tm-two') });
        expect(!cooled.ok && cooled.error.includes('冷却'), 'the cooldown refuses the next call');

        clock += 30 * 60 * 1000 + 1;
        traceMoeStatus = 200;
        traceMoeBody = DEFAULT_TRACEMOE;
        const afterCooldown = await searchOf(service, { engine: 'tracemoe', bytes: probeBytes('tm-three') });
        expect(afterCooldown.ok, `after the cooldown trace.moe is tried again (${afterCooldown.ok ? '' : afterCooldown.error})`);

        resetEngineAnswers();
        traceMoeStatus = 500;
        const failing = await searchOf(serviceOf(), { engine: 'tracemoe' });
        expect(!failing.ok && failing.kind === 'network', `a 500 is a network failure (got ${failing.ok ? 'ok' : failing.kind})`);
    })
);

await stub.close();
reportResults(cases);
