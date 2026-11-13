/**
 * Offline cases for the public Google-search fast page (design 2026-1113-1831
 * §3.5/§3.7): the signed token is the only permission, so these cases pin the
 * page the chat's folded footer links to.
 *
 * Covered: the version-backed page (content, OG card, headers), an untruncated
 * OG description at production scale (131 queries), the live delivery cache
 * (the page opens while the reply version is not stored yet), the stored-version
 * fallback after a restart, tampered/foreign/malformed tokens sharing one 404,
 * the switch, the per-address limiter, a version with no search records, and
 * the fact that both read paths render byte-identical HTML.
 *
 * Run: npx tsx scripts/offline/search-view.mts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrammyError } from 'grammy';
import { Hono } from 'hono';
import { expect, reportResults, runCase, setupOfflineDb, takeMessageId, type CaseResult } from './harness.mts';

const BOT_TOKEN = '123456789:AAFakeOfflineTokenForSearchPageTests_01';
const OWNER_ID = 4242;
const GROUP = -1001415974153;
const BOT_USER_ID = 9999;
const MODEL = 'gemini-4-hydrogen';

process.env.WEBAPP_PUBLIC_URL = 'https://miniapp.test';
process.env.BOT_TOKEN = BOT_TOKEN;
process.env.WEBAPP_SHARE_SECRET = 'offline-search-share-secret';
process.env.OWNER_USER_ID = String(OWNER_ID);
process.env.BOT_USER_ID = String(BOT_USER_ID);
process.env.WIDGET_RENDER_URL = '';
process.env.LUOXU_PREVIEW_URL = 'http://luoxu.test';
delete process.env.SEARCH_LINK;
delete process.env.ALLOWED_CHAT_IDS;

await setupOfflineDb();
const db = await import('../../src/db/index.js');
const signer = await import('../../src/shared/search-page.js');
const documents = await import('../../src/telegram/formatters/google-search-document.js');
const cache = await import('../../src/panel/search/search-document-cache.js');
const page = await import('../../src/panel/search/search-page.js');
const routes = await import('../../src/panel/search/search-routes.js');
const { createWidgetSigner } = await import('../../src/panel/share/signed-widget.js');
const { createPanelApp } = await import('../../src/panel/app.js');

type MembershipLookup = import('../../src/panel/access/membership.js').MembershipLookup;
type PanelApp = ReturnType<typeof createPanelApp>;
type PanelEnv = import('../../src/panel/context.js').PanelEnv;
type ResponseVersion = import('../../src/db/index.js').ResponseVersion;
type GroundingData = import('../../src/ai/types.js').GroundingData;
type SearchPageLink = import('../../src/shared/search-page.js').SearchPageLink;
type CachedSearchDocument = import('../../src/panel/search/search-document-cache.js').CachedSearchDocument;

const scratch = mkdtempSync(join(tmpdir(), 'k-on-bot-search-view-'));
process.once('exit', () => rmSync(scratch, { recursive: true, force: true }));
const STATIC_ROOT = join(scratch, 'dist');
mkdirSync(join(STATIC_ROOT, 'assets'), { recursive: true });
writeFileSync(join(STATIC_ROOT, 'index.html'), '<!doctype html><title>panel</title>');

const grammyError = (code: number, description: string): GrammyError =>
    new GrammyError(`(${code}: ${description})`, { ok: false, error_code: code, description }, 'getChatMember', {});

const fakeLookup: MembershipLookup = async () => {
    throw grammyError(400, 'Bad Request: user not found');
};

let clockMs = Date.now();
const baseOptions = {
    botToken: BOT_TOKEN,
    membershipLookup: fakeLookup,
    staticRoot: STATIC_ROOT,
    startedAt: new Date('2026-11-13T00:00:00.000Z'),
    version: 'abc1234',
    now: () => clockMs,
    shareEnabled: false,
    thinkingEnabled: false,
};

/** An app with an explicit switch, or the env's value when the argument is absent */
const makeApp = (searchEnabled?: boolean): PanelApp =>
    createPanelApp({ ...baseOptions, ...(searchEnabled === undefined ? {} : { searchEnabled }) });

const app = makeApp();
const disabledApp = makeApp(false);

const HTML_ESCAPES: Readonly<Record<string, string>> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

/** An independent escaper: the OG assertion must not borrow the page's own code */
const escapeForHtml = (text: string): string =>
    text.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);

const headOf = (html: string): string => {
    const index = html.indexOf('</head>');
    return index === -1 ? html : html.slice(0, index);
};

const metaContentOf = (html: string, property: string): string | null => {
    const pattern = new RegExp(`property="${property}" content="([^"]*)"`);
    return pattern.exec(headOf(html))?.[1] ?? null;
};

/**
 * The production incident's shape (design §2.1), small enough to read: two
 * queries with Google search-page anchors, two web-like source kinds, a second
 * step with sources only.
 */
const GROUNDING: GroundingData[] = [
    {
        provider: 'google',
        searchQueries: ['黑猫 生一推', '黑猫 领养'],
        searchEntryPoint: {
            renderedContent:
                '<style>.chip{}</style><div>' +
                `<a href="https://www.google.com/search?q=${encodeURIComponent('黑猫 生一推')}">黑猫 生一推</a>` +
                `<a href="https://www.google.com/search?q=${encodeURIComponent('黑猫 领养')}">黑猫 领养</a>` +
                '</div>',
        },
        groundingChunks: [
            { web: { uri: 'https://example.com/cat-guide', title: 'Cat guide' } },
            {
                retrievedContext: {
                    uri: 'https://vertex.example/doc',
                    title: 'RAG doc',
                    documentName: 'Doc A',
                },
            },
        ],
        groundingSupports: [{ segment: { text: '黑猫' }, groundingChunkIndices: [0], confidenceScores: [0.5] }],
    },
    { searchQueries: [], groundingChunks: [{ web: { uri: 'https://example.com/second', title: 'Second source' } }] },
];

const EXPECTED = documents.buildGoogleSearchDocument(GROUNDING);

/** 131 queries and 3 sources: the incident's size, where a 170-char excerpt would lose almost everything */
const BIG_QUERY_COUNT = 131;
const BIG_GROUNDING: GroundingData[] = [
    {
        provider: 'google',
        searchQueries: Array.from({ length: BIG_QUERY_COUNT }, (_, index) => `黑猫 查询 ${index + 1}`),
        searchEntryPoint: {
            renderedContent:
                `<a href="https://www.google.com/search?q=${encodeURIComponent('黑猫 查询 1')}">黑猫 查询 1</a>`,
        },
        groundingChunks: Array.from({ length: 3 }, (_, index) => ({
            web: { uri: `https://example.com/source-${index + 1}`, title: `Source ${index + 1}` },
        })),
    },
];
const BIG_EXPECTED = documents.buildGoogleSearchDocument(BIG_GROUNDING);

/** A footer with sources and no query at all (a urlContext-only turn) */
const SOURCES_ONLY_GROUNDING: GroundingData[] = [
    { searchQueries: [], groundingChunks: [{ web: { uri: 'https://example.com/only', title: 'Only source' } }] },
];
const SOURCES_ONLY_EXPECTED = documents.buildGoogleSearchDocument(SOURCES_ONLY_GROUNDING);

/** Several search-grounding steps: one footer block each, own source numbering */
const MULTI_STEP_GROUNDING: GroundingData[] = Array.from(
    { length: 3 },
    (_, index): GroundingData => ({
        provider: 'google',
        searchQueries: [`查询 ${index + 1}`],
        searchEntryPoint: {
            renderedContent: `<a href="https://www.google.com/search?q=${index + 1}">查询 ${index + 1}</a>`,
        },
        groundingChunks: [{ web: { uri: `https://example.com/step-${index + 1}`, title: `来源 ${index + 1}` } }],
    })
);
const MULTI_STEP_EXPECTED = documents.buildGoogleSearchDocument(MULTI_STEP_GROUNDING);

const versionOf = (versionId: number, overrides: Partial<ResponseVersion> = {}): ResponseVersion => ({
    versionId,
    createdAt: '2026-11-13T10:11:00.000Z',
    model: MODEL,
    messageIds: [700 + versionId],
    currentMessageId: 700 + versionId,
    text: '正文',
    wasStoppedByUser: false,
    ...overrides,
});

const makeReply = async (messageId: number, versions: ResponseVersion[]): Promise<void> => {
    const response = await db.createBotResponse(GROUP, messageId, 400, { model: MODEL, hasImage: false });
    response.setVersions(versions);
    response.currentVersionIndex = 0;
    await response.save();
};

/** A signed page link for one version; throws when the test forgot WEBAPP_PUBLIC_URL */
const linkOf = (firstMessageId: number, versionId: number): SearchPageLink => {
    const link = signer.searchPageLinkOf({ chatId: GROUP, firstMessageId, versionId });
    if (link === null) throw new Error('the test env must configure WEBAPP_PUBLIC_URL');
    return link;
};

const cacheEntryOf = (document: typeof EXPECTED): CachedSearchDocument => ({
    model: MODEL,
    createdAt: '2026-11-13T10:11:00.000Z',
    document,
});

const htmlOf = async (target: PanelApp, path: string): Promise<string> => (await target.request(path)).text();

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'the fast page renders the version search records',
        body: async () => {
            cache.clearSearchDocumentCache();
            const messageId = takeMessageId();
            await makeReply(messageId, [versionOf(1, { groundingData: GROUNDING })]);
            const link = linkOf(messageId, 1);

            const response = await app.request(link.url.replace('https://miniapp.test', ''));
            expect(response.status === 200, `200 (got ${response.status})`);
            expect(response.headers.get('Content-Type')?.startsWith('text/html') === true, 'HTML content type');
            expect(response.headers.get('Cache-Control') === 'no-store', 'Cache-Control no-store');
            expect(response.headers.get('X-Robots-Tag') === 'noindex, nofollow', 'X-Robots-Tag noindex');
            const csp = response.headers.get('Content-Security-Policy') ?? '';
            expect(csp.includes("default-src 'none'"), 'the CSP denies everything by default');
            expect(csp.includes("style-src 'unsafe-inline'"), 'the CSP allows the inline style');
            expect(!csp.includes('script-src'), 'the page loads no script');

            const html = await response.text();
            const head = headOf(html);
            expect(head.includes(`<title>${page.SEARCH_PAGE_TITLE}</title>`), 'the fixed page title');
            expect(
                metaContentOf(html, 'og:title') === page.SEARCH_PAGE_TITLE,
                `og:title is the fixed title (got ${JSON.stringify(metaContentOf(html, 'og:title'))})`
            );
            expect(
                metaContentOf(html, 'og:description') === escapeForHtml(EXPECTED.bodyText),
                'og:description is the quote block text, escaped'
            );
            expect(metaContentOf(html, 'og:site_name') === 'k-on-bot', 'og:site_name');
            expect(metaContentOf(html, 'og:type') === 'article', 'og:type article');
            expect(!head.includes('og:image'), 'no og:image');
            expect(head.includes('<meta name="robots" content="noindex,nofollow">'), 'the head is noindex');

            expect(html.includes('黑猫 生一推'), 'the first query is shown');
            expect(html.includes('黑猫 领养'), 'the second query is shown');
            expect(html.includes('Cat guide'), 'the web source title is shown');
            expect(html.includes('RAG doc'), 'the retrieved-context source title is shown');
            expect(html.includes('Second source'), 'the sources-only step is shown');
            // Each block numbers its sources from 1, exactly like the chat footer
            expect(html.includes('[2]'), 'the second source of a block is numbered');
            expect(html.includes('href="https://www.google.com/search?q='), 'a matched query links to Google');
            expect(html.includes('href="https://example.com/cat-guide"'), 'a source links to its page');
            expect(html.includes(`共搜索 ${EXPECTED.queryCount.toLocaleString('zh-CN')} 次`), 'the query count');
            expect(html.includes(`引用 ${EXPECTED.sourceCount.toLocaleString('zh-CN')} 条来源`), 'the source count');
            expect(html.includes(MODEL), 'the meta line names the model');
            expect(html.includes('k-on-bot'), 'the footer names the bot');
            expect(!html.includes('<script'), 'no script in the document');
        },
    },
    {
        name: 'the OG description is the whole quote block text, untruncated',
        body: async () => {
            cache.clearSearchDocumentCache();
            const messageId = takeMessageId();
            await makeReply(messageId, [versionOf(1, { groundingData: BIG_GROUNDING })]);
            const link = linkOf(messageId, 1);

            const html = await htmlOf(app, link.url.replace('https://miniapp.test', ''));
            const description = metaContentOf(html, 'og:description');
            expect(description !== null, 'the card has a description');
            expect(description === escapeForHtml(BIG_EXPECTED.bodyText), 'the description is the whole block text');
            expect(BIG_EXPECTED.bodyText.length > 600, 'the fixture is bigger than any excerpt cap');
            expect(BIG_EXPECTED.queryCount === BIG_QUERY_COUNT, 'every query is counted');
            expect(html.includes(`共搜索 ${BIG_QUERY_COUNT} 次`), 'the incident-sized query count is shown');
            expect(html.includes('Source 3'), 'the last source is rendered');
        },
    },
    {
        name: 'a sources-only footer renders without a query line',
        body: async () => {
            cache.clearSearchDocumentCache();
            const messageId = takeMessageId();
            await makeReply(messageId, [versionOf(1, { groundingData: SOURCES_ONLY_GROUNDING })]);
            const link = linkOf(messageId, 1);

            const html = await htmlOf(app, link.url.replace('https://miniapp.test', ''));
            expect(SOURCES_ONLY_EXPECTED.queryCount === 0, 'the fixture has no query');
            expect(SOURCES_ONLY_EXPECTED.sourceCount === 1, 'the fixture has one source');
            expect(
                metaContentOf(html, 'og:description') === escapeForHtml(SOURCES_ONLY_EXPECTED.bodyText),
                'the card text is the source line alone'
            );
            expect(html.includes('Only source'), 'the source is shown');
            expect(html.includes('href="https://example.com/only"'), 'the source links out');
            expect(html.includes('引用 1 条来源'), 'the meta line counts the source');
            expect(!html.includes('共搜索'), 'no query count is claimed');
            expect(!html.includes('<ul class="queries">'), 'no empty query list is rendered');
        },
    },
    {
        name: 'multiple search steps render as separate blocks',
        body: async () => {
            cache.clearSearchDocumentCache();
            const messageId = takeMessageId();
            await makeReply(messageId, [versionOf(1, { groundingData: MULTI_STEP_GROUNDING })]);
            const link = linkOf(messageId, 1);

            const html = await htmlOf(app, link.url.replace('https://miniapp.test', ''));
            expect(MULTI_STEP_EXPECTED.blocks.length === 3, 'the fixture has three blocks');
            expect(MULTI_STEP_EXPECTED.queryCount === 3, 'three queries in total');
            expect(MULTI_STEP_EXPECTED.sourceCount === 3, 'three sources in total');
            expect(
                metaContentOf(html, 'og:description') === escapeForHtml(MULTI_STEP_EXPECTED.bodyText),
                'the card text joins the blocks the way the chat footer does'
            );
            expect(html.split('<section class="block">').length - 1 === 3, 'one section per step');
            for (const index of [1, 2, 3]) {
                expect(html.includes(`查询 ${index}`), `step ${index}'s query is shown`);
                expect(html.includes(`来源 ${index}`), `step ${index}'s source is shown`);
            }
            // Each block numbers its own sources from 1, exactly like the chat footer
            expect(html.split('<span class="num">[1]</span>').length - 1 === 3, 'every block starts at [1]');
            expect(html.includes('共搜索 3 次'), 'the query count sums the blocks');
            expect(html.includes('引用 3 条来源'), 'the source count sums the blocks');
        },
    },
    {
        name: 'a tampered, foreign, malformed or unknown token gets the same 404',
        body: async () => {
            cache.clearSearchDocumentCache();
            const messageId = takeMessageId();
            const link = linkOf(messageId, 1);
            const dot = link.token.indexOf('.');
            const payload = link.token.slice(0, dot);
            const signature = link.token.slice(dot + 1);
            const tampered = `${payload}.${signature.slice(0, 3)}${signature.slice(3, 4) === 'A' ? 'B' : 'A'}${signature.slice(4)}`;
            const foreignSignature = createWidgetSigner({ botToken: BOT_TOKEN, now: () => clockMs })
                .sign({ chatId: GROUP, firstMessageId: messageId, versionId: 1, kind: 'doc' })
                .path.slice(3);

            const unknown = await app.request(`/g/${link.token}`);
            const tamperedPage = await app.request(`/g/${tampered}`);
            const malformed = await app.request('/g/not-a-token');
            const foreign = await app.request(`/g/${foreignSignature}`);
            for (const [name, response] of [
                ['unknown', unknown],
                ['tampered', tamperedPage],
                ['malformed', malformed],
                ['foreign', foreign],
            ] as const) {
                expect(response.status === 404, `${name} is 404 (got ${response.status})`);
            }
            const unknownBody = await unknown.text();
            expect(unknownBody === (await tamperedPage.text()), 'unknown and tampered pages read the same');
            expect(unknownBody === (await malformed.text()), 'malformed reads the same');
            expect(unknownBody === (await foreign.text()), 'another signed family cannot open this page');
            expect(unknownBody.includes('搜索过程不存在'), 'the 404 page names the missing search');
            expect(!unknownBody.includes('<title>panel</title>'), '/g never falls through to the SPA');
            expect(unknown.headers.get('Cache-Control') === 'no-store', 'no-store on the 404 page');
            expect(unknown.headers.get('X-Robots-Tag') === 'noindex, nofollow', 'noindex on the 404 page');
            expect(
                (unknown.headers.get('Content-Security-Policy') ?? '').includes("default-src 'none'"),
                'the 404 page carries the same CSP'
            );
        },
    },
    {
        name: 'the switch turns the page into a plain 404',
        body: async () => {
            cache.clearSearchDocumentCache();
            const messageId = takeMessageId();
            await makeReply(messageId, [versionOf(1, { groundingData: GROUNDING })]);
            const link = linkOf(messageId, 1);
            const path = link.url.replace('https://miniapp.test', '');

            const disabledOption = await disabledApp.request(path);
            expect(disabledOption.status === 404, `the option's off is 404 (got ${disabledOption.status})`);
            expect((await disabledOption.text()) === 'Not Found', 'the option off is a plain 404');

            process.env.SEARCH_LINK = '0';
            try {
                expect(signer.searchLinkEnabled() === false, 'the switch reads SEARCH_LINK');
                const envOffApp = makeApp();
                const envOff = await envOffApp.request(path);
                expect(envOff.status === 404, `SEARCH_LINK=0 is 404 (got ${envOff.status})`);
                expect((await envOff.text()) === 'Not Found', 'SEARCH_LINK=0 is a plain 404');
            } finally {
                delete process.env.SEARCH_LINK;
            }

            const on = await makeApp().request(path);
            expect(on.status === 200, `on by default (got ${on.status})`);
        },
    },
    {
        name: 'the live delivery cache opens the page before the version is stored',
        body: async () => {
            cache.clearSearchDocumentCache();
            // No bot_responses row for this message id: only the delivery cache knows it
            const messageId = takeMessageId();
            const link = linkOf(messageId, 1);
            cache.rememberSearchDocument(link.token, cacheEntryOf(EXPECTED));

            const path = link.url.replace('https://miniapp.test', '');
            const response = await app.request(path);
            expect(response.status === 200, `the crawler window serves 200 (got ${response.status})`);
            const html = await response.text();
            expect(metaContentOf(html, 'og:description') === escapeForHtml(EXPECTED.bodyText), 'the cached content');
            expect(html.includes(MODEL), 'the cached model');
            expect(html.includes(`共搜索 ${EXPECTED.queryCount.toLocaleString('zh-CN')} 次`), 'the cached count');

            cache.clearSearchDocumentCache();
            const gone = await app.request(path);
            expect(gone.status === 404, `without the cache and the version it is 404 (got ${gone.status})`);
        },
    },
    {
        name: 'the stored version renders byte-identically to the live cache',
        body: async () => {
            cache.clearSearchDocumentCache();
            const messageId = takeMessageId();
            const version = versionOf(1, { groundingData: GROUNDING });
            await makeReply(messageId, [version]);
            const link = linkOf(messageId, 1);
            const path = link.url.replace('https://miniapp.test', '');

            cache.rememberSearchDocument(link.token, { ...cacheEntryOf(EXPECTED), createdAt: version.createdAt });
            const fromCache = await htmlOf(app, path);
            cache.clearSearchDocumentCache();
            const fromVersion = await htmlOf(app, path);

            expect(fromCache === fromVersion, 'cache and version render the same page');
            expect(fromVersion.includes('Cat guide'), 'the version fallback has the content');
        },
    },
    {
        name: 'a version without search records is the same 404',
        body: async () => {
            cache.clearSearchDocumentCache();
            const noGrounding = takeMessageId();
            await makeReply(noGrounding, [versionOf(1)]);
            const toolOnly = takeMessageId();
            await makeReply(
                toolOnly,
                [
                    versionOf(1, {
                        groundingData: [
                            {
                                provider: 'mcp',
                                searchQueries: ['searxng_web_search: 黑猫'],
                                citations: [{ uri: 'https://example.com/mcp' }],
                            },
                        ],
                    }),
                ]
            );

            const expectedNotFound = await app.request('/g/not-a-token');
            const notFoundBody = await expectedNotFound.text();
            for (const [name, messageId] of [
                ['no groundingData', noGrounding],
                ['tool-only grounding', toolOnly],
            ] as const) {
                const link = linkOf(messageId, 1);
                const response = await app.request(link.url.replace('https://miniapp.test', ''));
                expect(response.status === 404, `${name} is 404 (got ${response.status})`);
                expect((await response.text()) === notFoundBody, `${name} shows the uniform 404 page`);
            }
        },
    },
    {
        name: 'the page rate-limits per address',
        body: async () => {
            cache.clearSearchDocumentCache();
            const messageId = takeMessageId();
            const link = linkOf(messageId, 1);
            cache.rememberSearchDocument(link.token, cacheEntryOf(EXPECTED));

            const limited = new Hono<PanelEnv>();
            routes.registerSearchPublicRoutes(limited, {
                enabled: true,
                now: () => clockMs,
                rateLimit: { limit: 2, windowMs: 60_000 },
            });
            const path = link.url.replace('https://miniapp.test', '');
            const call = async (address: string): Promise<Response> =>
                limited.request(path, { headers: { 'x-forwarded-for': address } });

            expect((await call('1.2.3.4')).status === 200, 'the first request passes');
            expect((await call('1.2.3.4')).status === 200, 'the second request passes');
            const refused = await call('1.2.3.4');
            expect(refused.status === 429, `the third is refused (got ${refused.status})`);
            expect(refused.headers.get('Retry-After') === '60', 'Retry-After');
            expect((await call('5.6.7.8')).status === 200, 'another address has its own window');
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) results.push(await runCase(testCase.name, testCase.body));
reportResults(results);
