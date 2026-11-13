/**
 * Offline cases for the stored public Google-search fast page (design
 * 2026-1113-1831 §3.5/§3.6): the page is rendered once when the reply layout
 * folds the footer, stored in `search_links`, and served from that row
 * afterwards. Telegram's preview crawler fetches once and never refreshes the
 * card, so the page must be final before the link message goes out — the tests
 * pin that timing, the one-row-per-version rule (never rewritten), the page
 * itself (OG card, CSP, escaping, production-scale content), the uniform 404
 * for every unreadable token, the switch, and the per-address limiter.
 *
 * Run: npx tsx scripts/offline/search-view.mts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueryTypes } from '@sequelize/core';
import { GrammyError } from 'grammy';
import { Hono } from 'hono';
import { expect, reportResults, runCase, setupOfflineDb, takeMessageId, type CaseResult } from './harness.mts';

const BOT_TOKEN = '123456789:AAFakeOfflineTokenForSearchPageTests_01';
const OWNER_ID = 4242;
const GROUP = -1001415974153;
const BOT_USER_ID = 9999;
const MODEL = 'gemini-4-hydrogen';
const CREATED_AT = '2026-11-13T10:11:00.000Z';
const ORIGIN = 'https://miniapp.test';

process.env.WEBAPP_PUBLIC_URL = ORIGIN;
process.env.BOT_TOKEN = BOT_TOKEN;
process.env.WEBAPP_SHARE_SECRET = 'offline-search-share-secret';
process.env.OWNER_USER_ID = String(OWNER_ID);
process.env.BOT_USER_ID = String(BOT_USER_ID);
process.env.WIDGET_RENDER_URL = '';
process.env.LUOXU_PREVIEW_URL = 'http://luoxu.test';
delete process.env.SEARCH_LINK;
delete process.env.ALLOWED_CHAT_IDS;

await setupOfflineDb();
const { sequelize } = await import('../../src/db/config.js');
const migrations = await import('../../src/db/schema-migrations.js');
const signer = await import('../../src/shared/search-page.js');
const documents = await import('../../src/telegram/formatters/google-search-document.js');
const store = await import('../../src/panel/search/search-store.js');
const service = await import('../../src/panel/search/search-link-service.js');
const page = await import('../../src/panel/search/search-page.js');
const routes = await import('../../src/panel/search/search-routes.js');
const { createWidgetSigner } = await import('../../src/panel/share/signed-widget.js');
const { createPanelApp } = await import('../../src/panel/app.js');

type MembershipLookup = import('../../src/panel/access/membership.js').MembershipLookup;
type PanelApp = ReturnType<typeof createPanelApp>;
type PanelEnv = import('../../src/panel/context.js').PanelEnv;
type GroundingData = import('../../src/ai/types.js').GroundingData;
type GoogleSearchDocument = import('../../src/telegram/formatters/google-search-document.js').GoogleSearchDocument;
type SearchPageLink = import('../../src/shared/search-page.js').SearchPageLink;
type SearchPageTarget = import('../../src/panel/search/search-types.js').SearchPageTarget;

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

const app = makeApp(true);
const disabledApp = makeApp(false);

/** The path of a page link, without the configured origin */
const pathOf = (link: SearchPageLink): string => link.url.slice(ORIGIN.length);

const targetOf = (firstMessageId: number, versionId = 1): SearchPageTarget => ({
    chatId: GROUP,
    firstMessageId,
    versionId,
});

const beginPage = async (
    firstMessageId: number,
    document: GoogleSearchDocument,
    versionId = 1
): Promise<SearchPageLink> => {
    const link = await service.beginSearchLink({
        ...targetOf(firstMessageId, versionId),
        model: MODEL,
        createdAt: CREATED_AT,
        document,
    });
    if (link === null) throw new Error('beginSearchLink returned null while the switch is on');
    return link;
};

const selectRows = async (sql: string, replacements: Record<string, unknown> = {}): Promise<unknown[]> =>
    sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

/** The single `COUNT(*) AS count` number of one query */
const countOf = async (sql: string, replacements: Record<string, unknown> = {}): Promise<number> => {
    const rows = await selectRows(sql, replacements);
    const first = rows[0];
    if (typeof first !== 'object' || first === null) return 0;
    const value: unknown = Reflect.get(first, 'count');
    return typeof value === 'number' ? value : 0;
};

const rowsForTarget = (target: SearchPageTarget): Promise<number> =>
    countOf(
        'SELECT COUNT(*) AS count FROM search_links WHERE chatId = :chatId AND firstMessageId = :firstMessageId AND versionId = :versionId',
        { chatId: target.chatId, firstMessageId: target.firstMessageId, versionId: target.versionId }
    );

const totalRows = (): Promise<number> => countOf('SELECT COUNT(*) AS count FROM search_links');

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
 * queries with Google search-page anchors across two source kinds, then a
 * second step with sources only.
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

/** Several search-grounding steps: one page block each, own source numbering */
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

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'the search_links migration is idempotent',
        body: async () => {
            await migrations.runSchemaMigrations();
            await migrations.runSchemaMigrations();

            const tables = await selectRows(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'search_links'"
            );
            expect(tables.length === 1, 'the table exists');
            const indexes = await selectRows(
                "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'search_links_target'"
            );
            expect(indexes.length === 1, 'the unique target index exists');
            const applied = await selectRows(
                "SELECT name FROM schema_migrations WHERE name = '20261113_search_links'"
            );
            expect(applied.length === 1, 'the migration is recorded once');
        },
    },
    {
        name: 'the page is generated once and never rewritten',
        body: async () => {
            const firstMessageId = takeMessageId();
            const target = targetOf(firstMessageId);
            const first = await beginPage(firstMessageId, EXPECTED);
            expect(first.url === `${ORIGIN}/g/${first.token}`, `the public URL (got ${first.url})`);

            const row = await store.findSearchLinkByToken(first.token);
            expect(row !== null, 'the row was stored before beginSearchLink returned');
            if (row === null) return;
            expect(
                row.html === page.renderSearchPage({ model: MODEL, createdAt: CREATED_AT, document: EXPECTED }),
                'the stored page is the rendered document'
            );
            expect(row.model === MODEL, 'the row keeps the model');
            expect(row.createdAt === CREATED_AT, 'the row keeps the delivery time');

            // A re-render of the same version: same token, no second row, and the
            // stored page must not be replaced — the crawler keeps the card it
            // fetched first, so a rewrite would only make the page drift
            const second = await service.beginSearchLink({
                ...target,
                model: 'another-model',
                createdAt: '2027-01-01T00:00:00.000Z',
                document: BIG_EXPECTED,
            });
            expect(second !== null && second.token === first.token, 'the same version reuses its token');
            const again = await store.findSearchLinkByToken(first.token);
            expect(again !== null && again.html === row.html, 'the stored page is not rewritten');
            expect(again !== null && again.model === MODEL, 'the row is not rewritten either');
            expect((await rowsForTarget(target)) === 1, 'exactly one row per version');
            expect((await store.findSearchLink(target))?.token === first.token, 'the target lookup finds it');
        },
    },
    {
        name: 'the switch or a missing public origin means no page and no row',
        body: async () => {
            const offMessageId = takeMessageId();
            const offTarget = targetOf(offMessageId);
            process.env.SEARCH_LINK = '0';
            try {
                expect(signer.searchLinkEnabled() === false, 'the switch reads SEARCH_LINK');
                const off = await service.beginSearchLink({
                    ...offTarget,
                    model: MODEL,
                    createdAt: CREATED_AT,
                    document: EXPECTED,
                });
                expect(off === null, 'SEARCH_LINK=0 creates no link');
                expect((await rowsForTarget(offTarget)) === 0, 'SEARCH_LINK=0 stores no row');
            } finally {
                delete process.env.SEARCH_LINK;
            }
            expect(signer.searchLinkEnabled() === true, 'on by default with a public origin');

            const noOriginMessageId = takeMessageId();
            const noOriginTarget = targetOf(noOriginMessageId);
            const originalOrigin = process.env.WEBAPP_PUBLIC_URL;
            delete process.env.WEBAPP_PUBLIC_URL;
            try {
                expect(signer.searchLinkEnabled() === false, 'no origin means no feature');
                const noOrigin = await service.beginSearchLink({
                    ...noOriginTarget,
                    model: MODEL,
                    createdAt: CREATED_AT,
                    document: EXPECTED,
                });
                expect(noOrigin === null, 'no origin creates no link');
                expect((await rowsForTarget(noOriginTarget)) === 0, 'no origin stores no row');
            } finally {
                process.env.WEBAPP_PUBLIC_URL = originalOrigin;
            }
        },
    },
    {
        name: 'the row exists before the link message could be sent',
        body: async () => {
            const firstMessageId = takeMessageId();
            const target = targetOf(firstMessageId);
            const token = signer.searchPageTokenOf(target);

            // The folded-footer path only asks the service once the layout has
            // decided to fold: before that call there is nothing to serve
            expect((await store.findSearchLinkByToken(token)) === null, 'no page before the layout decides');
            expect((await rowsForTarget(target)) === 0, 'no row before the layout decides');

            const link = await beginPage(firstMessageId, EXPECTED);
            expect(link.token === token, 'the served token is the version token');
            expect((await store.findSearchLinkByToken(link.token)) !== null, 'the page is stored before it is linked');
            expect((await rowsForTarget(target)) === 1, 'exactly one row when the message can go out');
        },
    },
    {
        name: 'the fast page serves the stored html with the fixed OG card',
        body: async () => {
            const firstMessageId = takeMessageId();
            const link = await beginPage(firstMessageId, EXPECTED);
            const row = await store.findSearchLinkByToken(link.token);
            expect(row !== null, 'the row exists');
            if (row === null) return;

            const response = await app.request(pathOf(link));
            expect(response.status === 200, `200 (got ${response.status})`);
            expect(response.headers.get('Content-Type')?.startsWith('text/html') === true, 'HTML content type');
            expect(response.headers.get('Cache-Control') === 'no-store', 'Cache-Control no-store');
            expect(response.headers.get('X-Robots-Tag') === 'noindex, nofollow', 'X-Robots-Tag noindex');
            const csp = response.headers.get('Content-Security-Policy') ?? '';
            expect(csp.includes("default-src 'none'"), 'the CSP denies everything by default');
            expect(csp.includes("style-src 'unsafe-inline'"), 'the CSP allows the inline style');
            expect(!csp.includes('script-src'), 'the page loads no script');

            const html = await response.text();
            expect(html === row.html, 'the route serves the stored html byte for byte');
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
            const firstMessageId = takeMessageId();
            const link = await beginPage(firstMessageId, BIG_EXPECTED);
            const html = await (await app.request(pathOf(link))).text();
            const description = metaContentOf(html, 'og:description');
            expect(description !== null, 'the card has a description');
            expect(description === escapeForHtml(BIG_EXPECTED.bodyText), 'the description is the whole block text');
            expect(BIG_EXPECTED.bodyText.length > 600, 'the fixture is bigger than any excerpt cap');
            expect(description !== null && description.includes('\n'), 'the description keeps the source line breaks');
            expect(BIG_EXPECTED.queryCount === BIG_QUERY_COUNT, 'every query is counted');
            expect(html.includes(`共搜索 ${BIG_QUERY_COUNT} 次`), 'the incident-sized query count is shown');
            expect(html.includes('Source 3'), 'the last source is rendered');
        },
    },
    {
        name: 'a sources-only footer renders without a query line',
        body: async () => {
            const firstMessageId = takeMessageId();
            const link = await beginPage(firstMessageId, SOURCES_ONLY_EXPECTED);
            const html = await (await app.request(pathOf(link))).text();
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
            const firstMessageId = takeMessageId();
            const link = await beginPage(firstMessageId, MULTI_STEP_EXPECTED);
            const html = await (await app.request(pathOf(link))).text();
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
            expect(html.split('<span class="num">[1]</span>').length - 1 === 3, 'every block starts at [1]');
            expect(html.includes('共搜索 3 次'), 'the query count sums the blocks');
            expect(html.includes('引用 3 条来源'), 'the source count sums the blocks');
        },
    },
    {
        name: 'a tampered, foreign, malformed or unstored token gets the same 404',
        body: async () => {
            const firstMessageId = takeMessageId();
            const link = await beginPage(firstMessageId, EXPECTED);
            const dot = link.token.indexOf('.');
            const payload = link.token.slice(0, dot);
            const signature = link.token.slice(dot + 1);
            const tampered = `${payload}.${signature.slice(0, 3)}${signature.slice(3, 4) === 'A' ? 'B' : 'A'}${signature.slice(4)}`;
            const foreignSignature = createWidgetSigner({ botToken: BOT_TOKEN, now: () => clockMs })
                .sign({ chatId: GROUP, firstMessageId, versionId: 1, kind: 'doc' })
                .path.slice(3);
            // A well-formed signature for a version that never folded
            const unstoredToken = signer.searchPageTokenOf(targetOf(takeMessageId()));
            const rowsBefore = await totalRows();

            const responseOf = async (token: string): Promise<Response> => app.request(`/g/${token}`);
            const unstored = await responseOf(unstoredToken);
            const tamperedPage = await responseOf(tampered);
            const malformed = await responseOf('not-a-token');
            const foreign = await responseOf(foreignSignature);
            for (const [name, response] of [
                ['unstored', unstored],
                ['tampered', tamperedPage],
                ['malformed', malformed],
                ['foreign', foreign],
            ] as const) {
                expect(response.status === 404, `${name} is 404 (got ${response.status})`);
            }
            const unknownBody = await unstored.text();
            expect(unknownBody === (await tamperedPage.text()), 'unstored and tampered pages read the same');
            expect(unknownBody === (await malformed.text()), 'malformed reads the same');
            expect(unknownBody === (await foreign.text()), 'another signed family cannot open this page');
            expect(unknownBody.includes('搜索过程不存在'), 'the 404 page names the missing search');
            expect(!unknownBody.includes('<title>panel</title>'), '/g never falls through to the SPA');
            expect(unstored.headers.get('Cache-Control') === 'no-store', 'no-store on the 404 page');
            expect(unstored.headers.get('X-Robots-Tag') === 'noindex, nofollow', 'noindex on the 404 page');
            expect(
                (unstored.headers.get('Content-Security-Policy') ?? '').includes("default-src 'none'"),
                'the 404 page carries the same CSP'
            );
            expect((await totalRows()) === rowsBefore, 'a forged token never reaches the table');
            expect(
                (await app.request(pathOf(link), { method: 'POST' })).status === 405,
                'the page route is GET only'
            );
        },
    },
    {
        name: 'the switch turns the page into a plain 404',
        body: async () => {
            const firstMessageId = takeMessageId();
            const link = await beginPage(firstMessageId, EXPECTED);
            const path = pathOf(link);

            const disabledOption = await disabledApp.request(path);
            expect(disabledOption.status === 404, `searchEnabled:false is 404 (got ${disabledOption.status})`);
            expect((await disabledOption.text()) === 'Not Found', 'searchEnabled:false is a plain 404');

            process.env.SEARCH_LINK = '0';
            try {
                expect(signer.searchLinkEnabled() === false, 'the switch reads SEARCH_LINK');
                const envOff = await makeApp().request(path);
                expect(envOff.status === 404, `SEARCH_LINK=0 is 404 (got ${envOff.status})`);
                expect((await envOff.text()) === 'Not Found', 'SEARCH_LINK=0 is a plain 404');
            } finally {
                delete process.env.SEARCH_LINK;
            }

            const on = await makeApp().request(path);
            expect(on.status === 200, `on by default with the stored page (got ${on.status})`);
        },
    },
    {
        name: 'the page route rate-limits per address',
        body: async () => {
            const firstMessageId = takeMessageId();
            const link = await beginPage(firstMessageId, EXPECTED);

            const limited = new Hono<PanelEnv>();
            routes.registerSearchPublicRoutes(limited, {
                enabled: true,
                now: () => clockMs,
                rateLimit: { limit: 2, windowMs: 60_000 },
            });
            const path = pathOf(link);
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
