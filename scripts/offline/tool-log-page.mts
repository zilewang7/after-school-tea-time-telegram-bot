/**
 * Offline cases for the public tool-call log fast page (design 2026-1119-1835
 * §13.1/§13.2): a Tools block that cannot fit one Telegram message folds into a
 * link message whose `/x/<token>` page holds the whole per-call log. The page is
 * rendered once when the reply layout decides to fold, stored in
 * `tool_log_pages`, and served from that row afterwards. Telegram's preview
 * crawler fetches once and never refreshes the card, so the page must be final
 * before the link message goes out — the tests pin that timing, the
 * one-row-per-version rule (never rewritten), the page itself (every call line,
 * failed and slow calls marked, OG card, CSP, escaping), the uniform 404 for
 * every unreadable token, the signed pointer's domain separation from `/g/`,
 * the switch and the per-address limiter.
 *
 * Run: npx tsx scripts/offline/tool-log-page.mts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueryTypes } from '@sequelize/core';
import { GrammyError } from 'grammy';
import { Hono } from 'hono';
import { expect, reportResults, runCase, setupOfflineDb, takeMessageId, type CaseResult } from './harness.mts';

const BOT_TOKEN = '123456789:AAFakeOfflineTokenForToolLogPageTests_01';
const OWNER_ID = 4242;
const GROUP = -1001415974153;
const BOT_USER_ID = 9999;
const MODEL = 'gemini-4-hydrogen';
const CREATED_AT = '2026-11-19T10:11:00.000Z';
const ORIGIN = 'https://miniapp.test';

process.env.WEBAPP_PUBLIC_URL = ORIGIN;
process.env.BOT_TOKEN = BOT_TOKEN;
process.env.WEBAPP_SHARE_SECRET = 'offline-tool-log-share-secret';
process.env.OWNER_USER_ID = String(OWNER_ID);
process.env.BOT_USER_ID = String(BOT_USER_ID);
process.env.WIDGET_RENDER_URL = '';
process.env.LUOXU_PREVIEW_URL = 'http://luoxu.test';
delete process.env.TOOL_LOG_LINK;
delete process.env.ALLOWED_CHAT_IDS;

await setupOfflineDb();
const { sequelize } = await import('../../src/db/config.js');
const migrations = await import('../../src/db/schema-migrations.js');
const signer = await import('../../src/shared/tool-log-page.js');
const searchSigner = await import('../../src/shared/search-page.js');
const documents = await import('../../src/telegram/formatters/tool-log-document.js');
const store = await import('../../src/panel/tool-log/tool-log-store.js');
const page = await import('../../src/panel/tool-log/tool-log-page.js');
const service = await import('../../src/panel/tool-log/tool-log-link-service.js');
const routes = await import('../../src/panel/tool-log/tool-log-routes.js');
const { createPanelApp } = await import('../../src/panel/app.js');

type MembershipLookup = import('../../src/panel/access/membership.js').MembershipLookup;
type PanelEnv = import('../../src/panel/context.js').PanelEnv;
type AgentStats = import('../../src/ai/types.js').AgentStats;
type GroundingData = import('../../src/ai/types.js').GroundingData;
type ToolLogDocument = import('../../src/telegram/formatters/tool-log-document.js').ToolLogDocument;
type ToolLogPageLink = import('../../src/shared/tool-log-page.js').ToolLogPageLink;
type ToolLogPageTarget = import('../../src/shared/tool-log-page.js').ToolLogPageTarget;

const scratch = mkdtempSync(join(tmpdir(), 'k-on-bot-tool-log-page-'));
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
    startedAt: new Date('2026-11-19T00:00:00.000Z'),
    version: 'abc1234',
    now: () => clockMs,
    shareEnabled: false,
    thinkingEnabled: false,
    searchEnabled: false,
};

type PanelApp = ReturnType<typeof createPanelApp>;

/** An app with an explicit switch, or the env's value when the argument is absent */
const makeApp = (toolLogEnabled?: boolean): PanelApp =>
    createPanelApp({ ...baseOptions, ...(toolLogEnabled === undefined ? {} : { toolLogEnabled }) });

const app = makeApp(true);
const disabledApp = makeApp(false);

/** The path of a page link, without the configured origin */
const pathOf = (link: ToolLogPageLink): string => link.url.slice(ORIGIN.length);

const targetOf = (firstMessageId: number, versionId = 1): ToolLogPageTarget => ({
    chatId: GROUP,
    firstMessageId,
    versionId,
});

const beginPage = async (firstMessageId: number, document: ToolLogDocument, versionId = 1): Promise<ToolLogPageLink> => {
    const link = await service.beginToolLogLink({
        ...targetOf(firstMessageId, versionId),
        model: MODEL,
        createdAt: CREATED_AT,
        document,
    });
    if (link === null) throw new Error('beginToolLogLink returned null while the switch is on');
    return link;
};

const selectRows = async (sql: string, replacements: Record<string, unknown> = {}): Promise<unknown[]> =>
    sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

const fieldOfRow = (row: unknown, field: string): unknown => {
    if (typeof row !== 'object' || row === null) return undefined;
    return Object.fromEntries(Object.entries(row))[field];
};

/** The single `COUNT(*) AS count` number of one query */
const countOf = async (sql: string, replacements: Record<string, unknown> = {}): Promise<number> => {
    const rows = await selectRows(sql, replacements);
    const value = fieldOfRow(rows[0], 'count');
    return typeof value === 'number' ? value : 0;
};

const rowsForTarget = (target: ToolLogPageTarget): Promise<number> =>
    countOf(
        'SELECT COUNT(*) AS count FROM tool_log_pages WHERE chatId = :chatId AND firstMessageId = :firstMessageId AND versionId = :versionId',
        { chatId: target.chatId, firstMessageId: target.firstMessageId, versionId: target.versionId }
    );

const totalRows = (): Promise<number> => countOf('SELECT COUNT(*) AS count FROM tool_log_pages');

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

/** The shape of a real 4-call Tools block: usage front line, mode, one slow call, one failed call */
const AGENT_STATS: AgentStats = {
    mode: 'AUTO',
    toolUsage: [
        { name: 'search_history', count: 2 },
        { name: 'read_history', count: 1 },
        { name: 'fetch_image', count: 1, failed: 1 },
    ],
    toolCalls: [
        { name: 'search_history', argument: '「灭蛾 方法」', result: '10 条命中' },
        { name: 'search_history', argument: '「黑猫 领养」', result: '无命中' },
        { name: 'read_history', argument: 'h101、h103', result: '2 条全文', ms: 3400 },
        { name: 'fetch_image', argument: 'h101', result: '图片已失效', failed: true },
    ],
};
const DOCUMENT = documents.buildToolLogDocument(AGENT_STATS, []);

/** 30 calls: more than the card's ten-line description, all of them on the page */
const MANY_CALLS_STATS: AgentStats = {
    toolUsage: [{ name: 'search_history', count: 30 }],
    toolCalls: Array.from({ length: 30 }, (_, index) => ({
        name: 'search_history',
        argument: `query-${index + 1}`,
        result: `hit-${index + 1}`,
    })),
};
const MANY_CALLS_DOCUMENT = documents.buildToolLogDocument(MANY_CALLS_STATS, []);

/** Ten lines long enough that the card's 500-character cap cuts them */
const LONG_LINES_STATS: AgentStats = {
    toolUsage: [{ name: 'search_history', count: 10 }],
    toolCalls: Array.from({ length: 10 }, (_, index) => ({
        name: 'search_history',
        argument: `argument-${index + 1}-`.padEnd(56, 'x'),
        result: `result-${index + 1}-`.padEnd(40, 'y'),
    })),
};
const LONG_LINES_DOCUMENT = documents.buildToolLogDocument(LONG_LINES_STATS, []);

/** A log whose model-derived text must be escaped, never interpreted */
const ESCAPE_STATS: AgentStats = {
    toolUsage: [{ name: 'send_file', count: 1 }],
    toolCalls: [{ name: 'send_file', argument: '<script>alert("x")</script>', result: '"><b>done</b>' }],
};
const ESCAPE_DOCUMENT = documents.buildToolLogDocument(ESCAPE_STATS, []);

/** A capped reply: failed and slow calls shown, plus the dropped-record note */
const TRUNCATED_STATS: AgentStats = {
    toolUsage: [
        { name: 'search_history', count: 4 },
        { name: 'fetch_image', count: 1, failed: 1 },
    ],
    toolCalls: [
        { name: 'search_history', argument: '「灭蛾」', result: '3 条命中', ms: 4200 },
        { name: 'fetch_image', argument: 'h101', result: '图片不存在', failed: true },
    ],
    toolCallsTruncated: 3,
};
const TRUNCATED_DOCUMENT = documents.buildToolLogDocument(TRUNCATED_STATS, []);

/** An hN ref: the page renders it as an anchor, the card keeps its plain text */
const LINKED_STATS: AgentStats = {
    toolUsage: [{ name: 'read_history', count: 1 }],
    toolCalls: [
        {
            name: 'read_history',
            argument: 'around h45 · 10 分钟',
            result: '39 条消息',
            links: [
                { text: 'h45', url: 'https://t.me/c/1415974153/1123456' },
                // Never rendered as an anchor, whatever a stored version holds
                { text: 'h46', url: 'javascript:alert(1)' },
            ],
        },
    ],
};
const LINKED_DOCUMENT = documents.buildToolLogDocument(LINKED_STATS, []);

/** A version stored before per-call records existed: legacy grounding-derived lines */
const LEGACY_GROUNDING: GroundingData[] = [
    {
        provider: 'xai',
        searchQueries: ['「灭蛾 方法」', '「黑猫 领养」'],
        groundingChunks: [{ web: { uri: 'https://example.com/cat', title: 'Cat guide' } }],
    },
];
const LEGACY_DOCUMENT = documents.buildToolLogDocument({ toolUsage: [{ name: 'search_history', count: 2 }] }, LEGACY_GROUNDING);

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'the tool_log_pages migration is idempotent',
        body: async () => {
            await migrations.runSchemaMigrations();
            await migrations.runSchemaMigrations();

            const tables = await selectRows(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tool_log_pages'"
            );
            expect(tables.length === 1, 'the table exists');
            const indexes = await selectRows(
                "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'tool_log_pages_target'"
            );
            expect(indexes.length === 1, 'the unique target index exists');
            const applied = await selectRows(
                "SELECT name FROM schema_migrations WHERE name = '20261119_tool_log_pages'"
            );
            expect(applied.length === 1, 'the migration is recorded once');
            const names = (await selectRows('SELECT name FROM schema_migrations')).flatMap((row) => {
                const name = fieldOfRow(row, 'name');
                return typeof name === 'string' ? [name] : [];
            });
            expect(names.includes('20261119_tool_log_pages'), 'the migration list of the offline database includes it');
        },
    },
    {
        name: 'the signed pointer round-trips and cannot cross the /g/ family',
        body: async () => {
            const target = targetOf(takeMessageId());
            const link = signer.toolLogPageLinkOf(target);
            expect(link !== null, 'a configured public origin yields a link');
            if (link === null) return;
            expect(link.token === signer.toolLogPageTokenOf(target), 'the token derives from the reply identity');
            expect(link.url === `${ORIGIN}/x/${link.token}`, `the public URL (got ${link.url})`);
            const replayed = signer.toolLogPageLinkOfToken(link.token);
            expect(replayed !== null && replayed.url === link.url, 'a stored token replays the same URL');
            const roundTrip = signer.toolLogPageTargetOfToken(link.token);
            expect(
                roundTrip !== null &&
                    roundTrip.chatId === target.chatId &&
                    roundTrip.firstMessageId === target.firstMessageId &&
                    roundTrip.versionId === target.versionId,
                `round trip (got ${JSON.stringify(roundTrip)})`
            );

            const searchToken = searchSigner.searchPageTokenOf(target);
            expect(searchToken !== link.token, 'the two families mint different tokens for one version');
            expect(signer.toolLogPageTargetOfToken(searchToken) === null, 'a /g/ token is not an /x/ token');
            expect(searchSigner.searchPageTargetOfToken(link.token) === null, 'an /x/ token is not a /g/ token');

            const dot = link.token.indexOf('.');
            const payload = link.token.slice(0, dot);
            const signature = link.token.slice(dot + 1);
            const tampered = `${payload}.${signature.slice(0, 3)}${signature.slice(3, 4) === 'A' ? 'B' : 'A'}${signature.slice(4)}`;
            expect(signer.toolLogPageTargetOfToken(tampered) === null, 'a flipped signature is rejected');
            expect(signer.toolLogPageTargetOfToken('not-a-token') === null, 'junk is rejected');
        },
    },
    {
        name: 'the page is generated once and never rewritten',
        body: async () => {
            const firstMessageId = takeMessageId();
            const target = targetOf(firstMessageId);
            const first = await beginPage(firstMessageId, DOCUMENT);
            expect(first.url === `${ORIGIN}/x/${first.token}`, `the public URL (got ${first.url})`);

            const row = await store.findToolLogPageByToken(first.token);
            expect(row !== null, 'the row was stored before beginToolLogLink returned');
            if (row === null) return;
            expect(
                row.html === page.renderToolLogPage({ model: MODEL, createdAt: CREATED_AT, document: DOCUMENT }),
                'the stored page is the rendered document'
            );
            expect(row.model === MODEL, 'the row keeps the model');
            expect(row.createdAt === CREATED_AT, 'the row keeps the delivery time');
            expect(row.chatId === GROUP && row.firstMessageId === firstMessageId && row.versionId === 1, 'the row keeps the target');

            // A re-render of the same version: same token, no second row, and the
            // stored page must not be replaced — the crawler keeps the card it
            // fetched first, so a rewrite would only make the page drift
            const second = await service.beginToolLogLink({
                ...target,
                model: 'another-model',
                createdAt: '2027-01-01T00:00:00.000Z',
                document: MANY_CALLS_DOCUMENT,
            });
            expect(second !== null && second.token === first.token, 'the same version reuses its token');
            const again = await store.findToolLogPageByToken(first.token);
            expect(again !== null && again.html === row.html, 'the stored page is not rewritten');
            expect(again !== null && again.model === MODEL, 'the row is not rewritten either');
            expect((await rowsForTarget(target)) === 1, 'exactly one row per version');
            expect((await store.findToolLogPage(target))?.token === first.token, 'the target lookup finds it');
            expect((await store.findToolLogPage({ ...target, versionId: 2 })) === null, 'another version has no page yet');
        },
    },
    {
        name: 'the row exists before the link message could be sent',
        body: async () => {
            const firstMessageId = takeMessageId();
            const target = targetOf(firstMessageId);
            const token = signer.toolLogPageTokenOf(target);

            // The folded-block path only asks the service once the layout has
            // decided to fold: before that call there is nothing to serve
            expect((await store.findToolLogPageByToken(token)) === null, 'no page before the layout decides');
            expect((await rowsForTarget(target)) === 0, 'no row before the layout decides');

            const link = await beginPage(firstMessageId, DOCUMENT);
            expect(link.token === token, 'the served token is the version token');
            expect((await store.findToolLogPageByToken(link.token)) !== null, 'the page is stored before it is linked');
            expect((await rowsForTarget(target)) === 1, 'exactly one row when the message can go out');
        },
    },
    {
        name: 'the switch or a missing public origin means no page and no row',
        body: async () => {
            const offMessageId = takeMessageId();
            const offTarget = targetOf(offMessageId);
            process.env.TOOL_LOG_LINK = '0';
            try {
                expect(signer.toolLogLinkEnabled() === false, 'the switch reads TOOL_LOG_LINK');
                const off = await service.beginToolLogLink({
                    ...offTarget,
                    model: MODEL,
                    createdAt: CREATED_AT,
                    document: DOCUMENT,
                });
                expect(off === null, 'TOOL_LOG_LINK=0 creates no link');
                expect((await rowsForTarget(offTarget)) === 0, 'TOOL_LOG_LINK=0 stores no row');
            } finally {
                delete process.env.TOOL_LOG_LINK;
            }
            expect(signer.toolLogLinkEnabled() === true, 'on by default with a public origin');

            const noOriginMessageId = takeMessageId();
            const noOriginTarget = targetOf(noOriginMessageId);
            const originalOrigin = process.env.WEBAPP_PUBLIC_URL;
            delete process.env.WEBAPP_PUBLIC_URL;
            try {
                expect(signer.toolLogLinkEnabled() === false, 'no origin means no feature');
                const noOrigin = await service.beginToolLogLink({
                    ...noOriginTarget,
                    model: MODEL,
                    createdAt: CREATED_AT,
                    document: DOCUMENT,
                });
                expect(noOrigin === null, 'no origin creates no link');
                expect((await rowsForTarget(noOriginTarget)) === 0, 'no origin stores no row');
            } finally {
                process.env.WEBAPP_PUBLIC_URL = originalOrigin;
            }
        },
    },
    {
        name: 'the fast page serves the whole stored log with the fixed OG card',
        body: async () => {
            const firstMessageId = takeMessageId();
            const link = await beginPage(firstMessageId, DOCUMENT);
            const row = await store.findToolLogPageByToken(link.token);
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
            expect(html === page.renderToolLogPage({ model: MODEL, createdAt: CREATED_AT, document: DOCUMENT }), 'the stored page is the renderer output');
            const head = headOf(html);
            expect(head.includes(`<title>${page.TOOL_LOG_PAGE_TITLE}</title>`), 'the fixed page title');
            expect(
                metaContentOf(html, 'og:title') === page.TOOL_LOG_PAGE_TITLE,
                `og:title is the fixed title (got ${JSON.stringify(metaContentOf(html, 'og:title'))})`
            );
            expect(metaContentOf(html, 'og:site_name') === 'k-on-bot', 'og:site_name');
            expect(metaContentOf(html, 'og:type') === 'article', 'og:type article');
            expect(!head.includes('og:image'), 'no og:image');
            expect(head.includes('<meta name="robots" content="noindex,nofollow">'), 'the head is noindex');

            expect(html.includes('工具调用'), 'the header chip names the log');
            expect(html.includes(MODEL), 'the meta line names the model');
            expect(html.includes('共 4 次调用 · 1 次失败'), 'the meta line counts the calls and the failures');
            expect(html.includes('mode: AUTO'), 'the block mode is kept');
            for (const line of documents.toolLogBodyLines(DOCUMENT)) {
                expect(html.includes(escapeForHtml(line)), `the log shows: ${line}`);
            }
            expect(html.includes('class="line failed"'), 'the failed call is marked');
            expect(html.includes('→ 失败：图片已失效'), 'the failure reason is shown');
            expect(html.includes(' · 3.4s'), 'the slow call shows its duration');
            expect(!html.includes('1.0s'), 'a fast call shows no duration');
            expect(html.includes('k-on-bot'), 'the footer names the bot');
            expect(!html.includes('<script'), 'no script in the document');

            // The description is the usage line and the call lines, escaped
            const description = metaContentOf(html, 'og:description');
            expect(description !== null, 'the card has a description');
            const expected = escapeForHtml([DOCUMENT.usageLine, ...DOCUMENT.callLines].join('\n'));
            expect(description === expected, 'og:description is the usage line followed by every call line');
        },
    },
    {
        name: 'an hN ref is an anchor on the page, plain text in the card',
        body: async () => {
            const link = await beginPage(takeMessageId(), LINKED_DOCUMENT);
            const html = await (await app.request(pathOf(link))).text();
            expect(
                html.includes('<a href="https://t.me/c/1415974153/1123456">h45</a>'),
                'the hN ref opens its archived message'
            );
            expect(!html.includes('javascript:'), 'a non-http span never becomes an anchor');
            const description = metaContentOf(html, 'og:description');
            expect(description !== null && description.includes('around h45'), 'the card keeps the plain ref');
            expect(!(description ?? '').includes('<a '), 'the card is text, not HTML');
        },
    },
    {
        name: 'the card lists the first ten calls and caps its description; the page keeps all of them',
        body: async () => {
            const firstMessageId = takeMessageId();
            const link = await beginPage(firstMessageId, MANY_CALLS_DOCUMENT);
            const html = await (await app.request(pathOf(link))).text();
            expect(MANY_CALLS_DOCUMENT.callLines.length === 30, 'the fixture has 30 calls');
            const description = metaContentOf(html, 'og:description');
            expect(description !== null, 'the card has a description');
            const expected = escapeForHtml(
                [MANY_CALLS_DOCUMENT.usageLine, ...MANY_CALLS_DOCUMENT.callLines.slice(0, 10), '…'].join('\n')
            );
            expect(description === expected, `the card is the usage line and the first ten calls (got ${JSON.stringify(description)})`);
            expect(description !== null && !description.includes('query-11'), 'the eleventh call is outside the card');
            expect(html.includes('query-11'), 'the page keeps the eleventh call');
            expect(html.includes('query-30'), 'the page keeps the last call');
            expect(html.includes('共 30 次调用'), 'the meta line counts every call');
            expect(!html.includes('0 次失败'), 'a zero-failure log does not claim failures');

            // Long lines: the description stops at the cap instead of growing
            const longMessageId = takeMessageId();
            const longLink = await beginPage(longMessageId, LONG_LINES_DOCUMENT);
            const longHtml = await (await app.request(pathOf(longLink))).text();
            const longDescription = metaContentOf(longHtml, 'og:description');
            const raw = [LONG_LINES_DOCUMENT.usageLine, ...LONG_LINES_DOCUMENT.callLines.slice(0, 10)].join('\n');
            expect(raw.length > 500, 'the fixture is longer than the card cap');
            const capped = raw.slice(0, 499) + '…';
            expect(longDescription === escapeForHtml(capped), 'the card is cut at 500 characters with an ellipsis');
        },
    },
    {
        name: 'a capped reply shows the dropped-record note, the failed line and the slow duration',
        body: async () => {
            const firstMessageId = takeMessageId();
            const link = await beginPage(firstMessageId, TRUNCATED_DOCUMENT);
            const html = await (await app.request(pathOf(link))).text();
            expect(TRUNCATED_DOCUMENT.truncatedCount === 3, 'the fixture dropped three records');
            expect(html.includes('…另有 3 次调用未记录'), 'the page says how many records were dropped');
            expect(html.includes('class="line note"'), 'the note is visually quieter');
            expect(html.includes('class="line failed"'), 'the failed call is marked');
            expect(html.includes('→ 失败：图片不存在'), 'the failure reason is shown');
            expect(html.includes(' · 4.2s'), 'the slow call shows its duration');
            expect(html.includes('共 5 次调用 · 1 次失败'), 'the usage line still counts every call, dropped records included');
        },
    },
    {
        name: 'model-derived text is escaped, never interpreted as markup',
        body: async () => {
            const firstMessageId = takeMessageId();
            const link = await beginPage(firstMessageId, ESCAPE_DOCUMENT);
            const html = await (await app.request(pathOf(link))).text();
            expect(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'), 'the argument is escaped');
            expect(html.includes('&quot;&gt;&lt;b&gt;done&lt;/b&gt;'), 'the result is escaped');
            expect(!html.includes('<script>alert'), 'no raw tag from the model text');
            const description = metaContentOf(html, 'og:description');
            expect(description !== null && !description.includes('<b>'), 'the card escapes the same text');
        },
    },
    {
        name: 'a legacy version renders its grounding-derived lines without counts it never had',
        body: async () => {
            const firstMessageId = takeMessageId();
            const link = await beginPage(firstMessageId, LEGACY_DOCUMENT);
            const html = await (await app.request(pathOf(link))).text();
            expect(LEGACY_DOCUMENT.callLines.length === 0, 'the legacy document has no per-call records');
            for (const line of documents.toolLogBodyLines(LEGACY_DOCUMENT)) {
                expect(html.includes(escapeForHtml(line)), `the legacy log shows: ${line}`);
            }
            expect(html.includes('「灭蛾 方法」'), 'a legacy call line is shown');
            expect(html.includes('共 2 次调用'), 'the usage the old version did record is counted');
            expect(!html.includes('0 次失败'), 'a zero-failure log does not claim failures');
            expect(!html.includes('另有'), 'a legacy page has no truncation note');
        },
    },
    {
        name: 'a tampered, foreign, malformed or unstored token gets the same 404',
        body: async () => {
            const firstMessageId = takeMessageId();
            const link = await beginPage(firstMessageId, DOCUMENT);
            const dot = link.token.indexOf('.');
            const payload = link.token.slice(0, dot);
            const signature = link.token.slice(dot + 1);
            const tampered = `${payload}.${signature.slice(0, 3)}${signature.slice(3, 4) === 'A' ? 'B' : 'A'}${signature.slice(4)}`;
            // A valid /g/ signature for the same version: the two families are separated
            const searchFamily = searchSigner.searchPageTokenOf(targetOf(firstMessageId));
            // A well-formed signature for a version that never folded
            const unstoredToken = signer.toolLogPageTokenOf(targetOf(takeMessageId()));
            const rowsBefore = await totalRows();

            const responseOf = async (token: string): Promise<Response> => app.request(`/x/${token}`);
            const unstored = await responseOf(unstoredToken);
            const tamperedPage = await responseOf(tampered);
            const malformed = await responseOf('not-a-token');
            const foreign = await responseOf(searchFamily);
            for (const [name, response] of [
                ['unstored', unstored],
                ['tampered', tamperedPage],
                ['malformed', malformed],
                ['foreign /g/', foreign],
            ] as const) {
                expect(response.status === 404, `${name} is 404 (got ${response.status})`);
            }
            const unknownBody = await unstored.text();
            expect(unknownBody === (await tamperedPage.text()), 'unstored and tampered pages read the same');
            expect(unknownBody === (await malformed.text()), 'malformed reads the same');
            expect(unknownBody === (await foreign.text()), 'a /g/ token cannot open this page');
            expect(unknownBody.includes('工具调用不存在'), 'the 404 page names the missing log');
            expect(!unknownBody.includes('<title>panel</title>'), '/x never falls through to the SPA');
            expect(unstored.headers.get('Cache-Control') === 'no-store', 'no-store on the 404 page');
            expect(unstored.headers.get('X-Robots-Tag') === 'noindex, nofollow', 'noindex on the 404 page');
            expect(
                (unstored.headers.get('Content-Security-Policy') ?? '').includes("default-src 'none'"),
                'the 404 page carries the same CSP'
            );
            expect((await totalRows()) === rowsBefore, 'a forged token never reaches the table');
            expect((await app.request(pathOf(link), { method: 'POST' })).status === 405, 'the page route is GET only');
        },
    },
    {
        name: 'the switch turns the page into a plain 404',
        body: async () => {
            const firstMessageId = takeMessageId();
            const link = await beginPage(firstMessageId, DOCUMENT);
            const path = pathOf(link);

            const disabledOption = await disabledApp.request(path);
            expect(disabledOption.status === 404, `toolLogEnabled:false is 404 (got ${disabledOption.status})`);
            expect((await disabledOption.text()) === 'Not Found', 'toolLogEnabled:false is a plain 404');

            process.env.TOOL_LOG_LINK = '0';
            try {
                expect(signer.toolLogLinkEnabled() === false, 'the switch reads TOOL_LOG_LINK');
                const envOff = await makeApp().request(path);
                expect(envOff.status === 404, `TOOL_LOG_LINK=0 is 404 (got ${envOff.status})`);
                expect((await envOff.text()) === 'Not Found', 'TOOL_LOG_LINK=0 is a plain 404');
            } finally {
                delete process.env.TOOL_LOG_LINK;
            }

            const on = await makeApp().request(path);
            expect(on.status === 200, `on by default with the stored page (got ${on.status})`);
        },
    },
    {
        name: 'the page route rate-limits per address',
        body: async () => {
            const firstMessageId = takeMessageId();
            const link = await beginPage(firstMessageId, DOCUMENT);

            const limited = new Hono<PanelEnv>();
            routes.registerToolLogPublicRoutes(limited, {
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
