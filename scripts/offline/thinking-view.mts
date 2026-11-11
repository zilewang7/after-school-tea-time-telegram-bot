/**
 * Offline cases for the long-thinking view (design §11.1, panel side): the
 * `thinking_links` row lifecycle, the fast page's fixed OG card (no CoT in the
 * head), escaping and markdown rendering, the incremental public API, the
 * read order (memory stream → stored version → interrupted/unavailable), the
 * per-address limit, the feature switch and the migration's idempotency.
 *
 * Run: npx tsx scripts/offline/thinking-view.mts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { GrammyError } from 'grammy';
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';

const BOT_TOKEN = '123456789:AAFakeOfflineTokenForPanelTests_0123';
const OWNER_ID = 4242;
const GROUP = -1001000000001;
const BOT_USER_ID = 9999;
const MODEL = 'gemini-4-argon';

process.env.OWNER_USER_ID = String(OWNER_ID);
process.env.WEBAPP_PUBLIC_URL = 'https://miniapp.test';
process.env.BOT_USER_NAME = 'k_on_test_bot';
process.env.WEBAPP_BOT_SHORT_NAME = 'panel';
process.env.WIDGET_RENDER_URL = '';
process.env.BOT_USER_ID = String(BOT_USER_ID);
process.env.LUOXU_PREVIEW_URL = 'http://luoxu.test';
delete process.env.THINKING_LINK;
delete process.env.ALLOWED_CHAT_IDS;

await setupOfflineDb();
const db = await import('../../src/db/index.js');
const { sequelize } = await import('../../src/db/config.js');
const migrations = await import('../../src/db/schema-migrations.js');
const config = await import('../../src/panel/thinking/thinking-config.js');
const urls = await import('../../src/panel/thinking/thinking-urls.js');
const service = await import('../../src/panel/thinking/thinking-link-service.js');
const stream = await import('../../src/panel/thinking/thinking-stream.js');
const store = await import('../../src/panel/thinking/thinking-store.js');
const routes = await import('../../src/panel/thinking/thinking-routes.js');
const { createPanelApp } = await import('../../src/panel/app.js');

type MembershipLookup = import('../../src/panel/access/membership.js').MembershipLookup;
type PanelApp = ReturnType<typeof createPanelApp>;
type PanelEnv = import('../../src/panel/context.js').PanelEnv;
type ResponseVersion = import('../../src/db/index.js').ResponseVersion;
type ThinkingLinkRef = import('../../src/panel/thinking/thinking-types.js').ThinkingLinkRef;
type ThinkingLinkRow = import('../../src/panel/thinking/thinking-types.js').ThinkingLinkRow;

const scratch = mkdtempSync(join(tmpdir(), 'k-on-bot-thinking-view-'));
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
const makeApp = (thinkingEnabled: boolean): PanelApp =>
    createPanelApp({
        botToken: BOT_TOKEN,
        membershipLookup: fakeLookup,
        staticRoot: STATIC_ROOT,
        startedAt: new Date('2026-11-11T00:00:00.000Z'),
        version: 'abc1234',
        now: () => clockMs,
        shareEnabled: true,
        thinkingEnabled,
    });

const app = makeApp(true);
const disabledApp = makeApp(false);

const versionOf = (versionId: number, overrides: Partial<ResponseVersion> = {}): ResponseVersion => ({
    versionId,
    createdAt: '2026-11-11T12:00:00.000Z',
    messageIds: [800 + versionId],
    currentMessageId: 800 + versionId,
    text: `第 ${versionId} 版正文`,
    wasStoppedByUser: false,
    ...overrides,
});

const makeReply = async (chatId: number, messageId: number, versions: ResponseVersion[]): Promise<void> => {
    const response = await db.createBotResponse(chatId, messageId, 400, { model: MODEL, hasImage: false });
    response.setVersions(versions);
    response.currentVersionIndex = 0;
    await response.save();
};

let nextMessageId = 9000;
const takeMessageId = (): number => (nextMessageId += 1);

/** One version attempt; message ids are unique so no case shares a live stream key */
interface Attempt {
    chatId: number;
    firstMessageId: number;
    versionId: number;
    key: string;
}

const newAttempt = (versionId = 1): Attempt => {
    const firstMessageId = takeMessageId();
    return {
        chatId: GROUP,
        firstMessageId,
        versionId,
        key: service.thinkingAttemptKeyOf({ chatId: GROUP, firstMessageId, versionId }),
    };
};

const begin = (attempt: Attempt, model = MODEL): Promise<ThinkingLinkRef | null> =>
    service.beginThinkingLink({
        chatId: attempt.chatId,
        firstMessageId: attempt.firstMessageId,
        versionId: attempt.versionId,
        model,
    });

const requireRef = (ref: ThinkingLinkRef | null): ThinkingLinkRef => {
    if (ref === null) throw new Error('expected a thinking link ref, got null');
    return ref;
};

const requireRow = (row: ThinkingLinkRow | null): ThinkingLinkRow => {
    if (row === null) throw new Error('expected a thinking_links row, got null');
    return row;
};

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : {};

const jsonOf = async (response: Response): Promise<Record<string, unknown>> => {
    const parsed: unknown = JSON.parse(await response.text());
    return asRecord(parsed);
};

/** The part of the document before `</head>`: OG and title must live only there */
const headOf = (html: string): string => {
    const index = html.indexOf('</head>');
    return index === -1 ? html : html.slice(0, index);
};

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'a thinking link is created once per reply version',
        body: async () => {
            const firstMessageId = takeMessageId();
            const input = { chatId: GROUP, firstMessageId, versionId: 1, model: MODEL };
            const first = requireRef(await service.beginThinkingLink(input));
            const again = requireRef(await service.beginThinkingLink(input));
            expect(again.token === first.token, 'the same version reuses its token');

            const otherVersion = requireRef(
                await service.beginThinkingLink({ ...input, versionId: 2 })
            );
            expect(otherVersion.token !== first.token, 'another version has its own token');
            const otherReply = requireRef(
                await service.beginThinkingLink({ ...input, firstMessageId: firstMessageId + 1 })
            );
            expect(otherReply.token !== first.token, 'another reply has its own token');

            expect(
                first.token.length === 24 && /^[A-Za-z0-9_-]{24}$/.test(first.token),
                `the token is 24 base64url characters (got ${first.token})`
            );
            expect(
                first.fastPageUrl === `https://miniapp.test/t/${first.token}`,
                `the fast page URL (got ${first.fastPageUrl})`
            );
            expect(
                first.miniAppUrl === `https://t.me/k_on_test_bot/panel?startapp=t${first.token}`,
                `the Mini App deep link (got ${first.miniAppUrl})`
            );
            expect(urls.thinkingFastPagePath(first.token) === `/t/${first.token}`, 'the fast page path');
            expect(urls.thinkingMiniAppPath(first.token) === `/think/${first.token}`, 'the Mini App path');
            expect(urls.thinkingTokenOfUrl(first.fastPageUrl) === first.token, 'the token is recoverable from its URL');
            expect(urls.thinkingTokenOfUrl('https://miniapp.test/t/short') === null, 'a short segment is not a token');
            expect(
                service.thinkingAttemptKeyOf(input) === `${GROUP}:${firstMessageId}:1`,
                'the live-stream key'
            );

            const row = requireRow(await store.findThinkingLinkByToken(first.token));
            expect(
                row.chatId === GROUP && row.firstMessageId === firstMessageId && row.versionId === 1,
                'the row names the reply version'
            );
            expect(row.model === MODEL, 'the row keeps the model');
            expect(row.createdAt.endsWith('Z'), `the row keeps an ISO creation time (got ${row.createdAt})`);
            expect(
                (await store.findThinkingLink({ chatId: GROUP, firstMessageId, versionId: 1 }))?.token === first.token,
                'the target lookup finds it'
            );

            const replay = service.thinkingLinkRefOfVersion({ thinkingLinkToken: first.token });
            expect(replay?.token === first.token, 'a stored version replays its link');
            expect(service.thinkingLinkRefOfVersion({}) === null, 'an old version has no link');
            expect(
                service.thinkingLinkRefOfVersion({ thinkingLinkToken: 'not-a-token' }) === null,
                'a malformed token has no link'
            );

            process.env.WEBAPP_BOT_SHORT_NAME = 'thinkapp';
            const customShortName = service.thinkingLinkRefOfVersion({ thinkingLinkToken: first.token });
            process.env.WEBAPP_BOT_SHORT_NAME = 'panel';
            expect(
                customShortName?.miniAppUrl === `https://t.me/k_on_test_bot/thinkapp?startapp=t${first.token}`,
                'WEBAPP_BOT_SHORT_NAME picks the Mini App short name'
            );

            const botUserName = process.env.BOT_USER_NAME;
            // Typed as always set, so `delete` does not type-check; unset it for real
            Reflect.deleteProperty(process.env, 'BOT_USER_NAME');
            const noBotName = service.thinkingLinkRefOfVersion({ thinkingLinkToken: first.token });
            process.env.BOT_USER_NAME = botUserName;
            expect(
                noBotName !== null && noBotName.miniAppUrl === noBotName.fastPageUrl,
                'without BOT_USER_NAME the text link falls back to the fast page'
            );
        },
    },
    {
        name: 'the fast page carries the fixed OG card and no thinking text in the head',
        body: async () => {
            const attempt = newAttempt();
            // The first thinking chunk arrives before the token exists (design §5.2)
            service.appendLiveThinking(attempt.key, '秘密思考内容：先分析再回答。');
            service.appendLiveThinking(attempt.key, ' 带 <b>标签</b> 的思考');
            const ref = requireRef(await begin(attempt));

            const response = await app.request(`/t/${ref.token}`);
            expect(response.status === 200, `200 (got ${response.status})`);
            expect(response.headers.get('Content-Type')?.startsWith('text/html') === true, 'HTML content type');
            expect(response.headers.get('Cache-Control') === 'no-store', 'Cache-Control no-store');
            expect(response.headers.get('X-Robots-Tag') === 'noindex, nofollow', 'noindex');
            const csp = response.headers.get('Content-Security-Policy') ?? '';
            expect(csp.includes("default-src 'none'"), 'the CSP denies everything by default');
            expect(csp.includes("connect-src 'self'"), 'the CSP allows same-origin polling');
            expect(csp.includes("script-src 'unsafe-inline'"), 'the CSP allows the inline poll');
            expect(csp.includes("style-src 'unsafe-inline'"), 'the CSP allows the inline style');

            const html = await response.text();
            const head = headOf(html);
            expect(head.includes('<title>点击查看思考过程</title>'), 'the fixed page title');
            expect(head.includes('property="og:title" content="点击查看思考过程"'), 'og:title');
            expect(head.includes(`property="og:description" content="${MODEL}"`), 'og:description is the model');
            expect(head.includes('property="og:type" content="article"'), 'og:type article');
            expect(head.includes('property="og:site_name" content="k-on-bot"'), 'og:site_name');
            expect(!head.includes('og:image'), 'no og:image (a text-only card)');
            expect(!head.includes('秘密思考内容'), 'no thinking text in the head');
            expect(html.includes('秘密思考内容：先分析再回答。'), 'the thinking text is in the body');
            expect(html.includes('&lt;b&gt;标签&lt;/b&gt;'), 'the body text is escaped');
            expect(!html.includes('<b>标签</b>'), 'model text never becomes raw HTML');
            expect(html.includes('data-done="0"'), 'the page marks itself generating');
            expect(html.includes('/api/public/thinking/'), 'the page polls the public API');
            expect(html.includes('700'), 'the poll interval');
            expect(html.includes('生成中'), 'the status line');
            expect(
                html.includes(`https://t.me/k_on_test_bot/panel?startapp=t${ref.token}`),
                'the Telegram button opens the Mini App'
            );

            // A later chunk shows up on the next page render, appended to the body
            service.appendLiveThinking(attempt.key, '，补充一句');
            const refreshed = await (await app.request(`/t/${ref.token}`)).text();
            expect(refreshed.includes('补充一句'), 'the page reflects later chunks');
            service.finishLiveThinking(attempt.key);
        },
    },
    {
        name: 'a finished thinking renders as markdown and stops polling',
        body: async () => {
            const attempt = newAttempt();
            const ref = requireRef(await begin(attempt));
            service.appendLiveThinking(attempt.key, '**加粗**与 <script>alert(1)</script> 的思考');
            service.finishLiveThinking(attempt.key);

            const html = await (await app.request(`/t/${ref.token}`)).text();
            expect(html.includes('<strong>加粗</strong>'), 'the finished page renders markdown');
            expect(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'the model text stays escaped');
            expect(!html.includes('<script>alert(1)</script>'), 'no script injection');
            expect(html.includes('data-done="1"'), 'the page marks itself final');
            expect(!html.includes('data-done="0"'), 'no generating marker on the final page');
            expect(!html.includes('location.reload'), 'a final page polls and reloads nothing');
            expect(html.includes('已完成'), 'the status line says done');
            expect(!headOf(html).includes('加粗'), 'the head still carries no thinking text');
        },
    },
    {
        name: 'the API serves the full text and incremental deltas',
        body: async () => {
            const attempt = newAttempt();
            const ref = requireRef(await begin(attempt));
            service.appendLiveThinking(attempt.key, 'hello world');

            const fullResponse = await app.request(`/api/public/thinking/${ref.token}`);
            expect(fullResponse.status === 200, `200 without initData (got ${fullResponse.status})`);
            expect(
                fullResponse.headers.get('Content-Type')?.startsWith('application/json') === true,
                'JSON content type'
            );
            expect(fullResponse.headers.get('Cache-Control') === 'no-store', 'no-store');
            expect(fullResponse.headers.get('X-Robots-Tag') === 'noindex, nofollow', 'noindex');
            const full = await jsonOf(fullResponse);
            expect(full.token === ref.token, 'the token');
            expect(full.model === MODEL, 'the model');
            expect(typeof full.createdAt === 'string', 'the creation time');
            expect(full.done === false, 'not done yet');
            expect(full.status === 'generating', 'status generating');
            expect(full.errorMessage === null, 'no error');
            expect(full.text === 'hello world', 'the full text');
            expect(full.next === 11, 'next is the text length');
            expect(full.delta === undefined && full.reset === undefined, 'no delta or reset on a full read');

            const delta = await jsonOf(await app.request(`/api/public/thinking/${ref.token}?after=6`));
            expect(delta.delta === 'world', `the increment from 6 (got ${JSON.stringify(delta.delta)})`);
            expect(delta.text === '', 'a delta read does not resend the whole text');
            expect(delta.next === 11, 'next after a delta');
            expect(delta.done === false && delta.status === 'generating', 'the state still comes along');

            const atEnd = await jsonOf(await app.request(`/api/public/thinking/${ref.token}?after=11`));
            expect(atEnd.delta === '' && atEnd.next === 11, 'an in-range end position is an empty delta');

            for (const after of ['99', '-1', 'abc', '']) {
                const reset = await jsonOf(await app.request(`/api/public/thinking/${ref.token}?after=${after}`));
                expect(
                    reset.reset === true && reset.text === 'hello world' && reset.next === 11,
                    `after=${after} resets to the full text`
                );
            }
            service.finishLiveThinking(attempt.key);
        },
    },
    {
        name: 'the API reads the stored version after the live stream is gone',
        body: async () => {
            // (a) a just-finished stream: done with the live text
            const liveAttempt = newAttempt();
            const liveRef = requireRef(await begin(liveAttempt));
            service.appendLiveThinking(liveAttempt.key, '实时落定的思考');
            service.finishLiveThinking(liveAttempt.key);
            const live = await jsonOf(await app.request(`/api/public/thinking/${liveRef.token}`));
            expect(live.done === true && live.status === 'done', 'a finished stream is done');
            expect(live.text === '实时落定的思考', 'the finished stream keeps its text');

            // (b) no live entry (the process restarted): the version's thinkingText wins,
            // and the token's version id picks the right version of several
            const restartReply = takeMessageId();
            await makeReply(GROUP, restartReply, [
                versionOf(1, { model: MODEL, thinkingText: '第一版思考' }),
                versionOf(2, { model: 'gpt-6-sol', thinkingText: '第二版的思考' }),
            ]);
            const restartRef = requireRef(
                await service.beginThinkingLink({
                    chatId: GROUP,
                    firstMessageId: restartReply,
                    versionId: 2,
                    model: 'gpt-6-sol',
                })
            );
            const stored = await jsonOf(await app.request(`/api/public/thinking/${restartRef.token}`));
            expect(stored.done === true && stored.status === 'done', 'a stored version reads as done');
            expect(stored.text === '第二版的思考', 'the version named by the row');
            expect(stored.model === 'gpt-6-sol', 'the version model');

            const storedPage = await (await app.request(`/t/${restartRef.token}`)).text();
            expect(storedPage.includes('<strong>') || storedPage.includes('第二版的思考'), 'the stored text is on the page');
            expect(storedPage.includes('data-done="1"'), 'the stored page is final');

            // (c) the row exists but no version was stored: the process died mid-generation
            const lostReply = takeMessageId();
            const lostRef = requireRef(
                await service.beginThinkingLink({ chatId: GROUP, firstMessageId: lostReply, versionId: 1, model: MODEL })
            );
            const lost = await jsonOf(await app.request(`/api/public/thinking/${lostRef.token}`));
            expect(lost.status === 'interrupted' && lost.done === true, 'a missing version is interrupted');
            expect(lost.text === '' && lost.errorMessage === null, 'interrupted carries no text or error');
            const lostPage = await (await app.request(`/t/${lostRef.token}`)).text();
            expect(lostPage.includes('生成过程中被中断'), 'the page explains the interruption');

            // (d) a stored version without thinking data: nothing to show
            const emptyReply = takeMessageId();
            await makeReply(GROUP, emptyReply, [versionOf(1, { model: MODEL, text: '只有正文' })]);
            const emptyRef = requireRef(
                await service.beginThinkingLink({ chatId: GROUP, firstMessageId: emptyReply, versionId: 1, model: MODEL })
            );
            const empty = await jsonOf(await app.request(`/api/public/thinking/${emptyRef.token}`));
            expect(empty.status === 'unavailable' && empty.done === true, 'no stored thinking is unavailable');
            expect(empty.text === '', 'unavailable has no text');
            const emptyPage = await (await app.request(`/t/${emptyRef.token}`)).text();
            expect(emptyPage.includes('没有可查看的思考过程'), 'the page says there is no thinking');

            // (e) the version's error line reaches the page and the API
            const failedReply = takeMessageId();
            await makeReply(GROUP, failedReply, [
                versionOf(1, { model: MODEL, thinkingText: '思考到一半', errorMessage: '请求超时' }),
            ]);
            const failedRef = requireRef(
                await service.beginThinkingLink({ chatId: GROUP, firstMessageId: failedReply, versionId: 1, model: MODEL })
            );
            const failed = await jsonOf(await app.request(`/api/public/thinking/${failedRef.token}`));
            expect(failed.status === 'done' && failed.errorMessage === '请求超时', 'the version error is reported');
            const failedPage = await (await app.request(`/t/${failedRef.token}`)).text();
            expect(failedPage.includes('⚠') && failedPage.includes('请求超时'), 'the page shows the error line');
        },
    },
    {
        name: 'unknown and malformed tokens get the same 404',
        body: async () => {
            const unknownToken = 'A'.repeat(24);
            const unknownPage = await app.request(`/t/${unknownToken}`);
            const malformedPage = await app.request(`/t/not-a-token`);
            expect(unknownPage.status === 404 && malformedPage.status === 404, 'both pages are 404');
            const unknownHtml = await unknownPage.text();
            expect(unknownHtml === (await malformedPage.text()), 'both pages read the same');
            expect(unknownPage.headers.get('Cache-Control') === 'no-store', 'no-store on the 404 page');
            expect(unknownPage.headers.get('X-Robots-Tag') === 'noindex, nofollow', 'noindex on the 404 page');
            expect(unknownHtml.includes('思考过程不存在'), 'the 404 page names the missing thinking');
            expect(!unknownHtml.includes('<title>panel</title>'), '/t never falls through to the SPA');

            const unknownJson = await app.request(`/api/public/thinking/${unknownToken}`);
            const malformedJson = await app.request(`/api/public/thinking/not-a-token`);
            expect(unknownJson.status === 404 && malformedJson.status === 404, 'both JSON reads are 404');
            expect(
                unknownJson.headers.get('Content-Type')?.startsWith('application/json') === true,
                'the 404 is JSON'
            );
            expect((await unknownJson.text()) === (await malformedJson.text()), 'both JSON bodies read the same');
        },
    },
    {
        name: 'THINKING_LINK=0 disables both entries without a 401',
        body: async () => {
            const attempt = newAttempt();
            const ref = requireRef(await begin(attempt));

            process.env.THINKING_LINK = '0';
            const offByEnv = config.thinkingLinkEnabled();
            const blocked = await begin(attempt);
            const blockedOther = await service.beginThinkingLink({
                chatId: GROUP,
                firstMessageId: takeMessageId(),
                versionId: 1,
                model: MODEL,
            });
            delete process.env.THINKING_LINK;
            expect(offByEnv === false, 'the switch reads THINKING_LINK per call');
            expect(blocked === null && blockedOther === null, 'no link is created while the switch is off');
            expect(config.thinkingLinkEnabled() === true, 'on by default with a public URL');

            const publicUrl = process.env.WEBAPP_PUBLIC_URL;
            delete process.env.WEBAPP_PUBLIC_URL;
            const withoutPublicUrl = config.thinkingLinkEnabled();
            process.env.WEBAPP_PUBLIC_URL = publicUrl;
            expect(withoutPublicUrl === false, 'no public URL means no links');

            const disabledPage = await disabledApp.request(`/t/${ref.token}`);
            expect(disabledPage.status === 404, `the disabled page is 404 (got ${disabledPage.status})`);
            expect((await disabledPage.text()) === 'Not Found', 'the disabled page is a plain 404');
            const disabledJson = await disabledApp.request(`/api/public/thinking/${ref.token}`);
            expect(disabledJson.status === 404, `the disabled API is 404, not 401 (got ${disabledJson.status})`);
            const unknownJson = await (await app.request('/api/public/thinking/AAAAAAAAAAAAAAAAAAAAAAAA')).text();
            expect((await disabledJson.text()) === unknownJson, 'the disabled API answers the unknown-token body');
        },
    },
    {
        name: 'the public API rate-limits per address',
        body: async () => {
            const attempt = newAttempt();
            const ref = requireRef(await begin(attempt));
            const limited = new Hono<PanelEnv>();
            routes.registerPublicThinkingApiRoutes(limited, {
                enabled: true,
                now: () => clockMs,
                rateLimit: { limit: 2, windowMs: 60_000 },
            });
            const call = async (address: string): Promise<Response> =>
                limited.request(`/api/public/thinking/${ref.token}`, { headers: { 'x-forwarded-for': address } });
            expect((await call('1.2.3.4')).status === 200, 'the first request passes');
            expect((await call('1.2.3.4')).status === 200, 'the second request passes');
            const refused = await call('1.2.3.4');
            expect(refused.status === 429, `the third is refused (got ${refused.status})`);
            expect(refused.headers.get('Retry-After') === '60', 'Retry-After');
            expect((await call('5.6.7.8')).status === 200, 'another address has its own window');
        },
    },
    {
        name: 'the live stream caps at 200k characters and sweeps finished entries',
        body: async () => {
            let streamClock = 1_000;
            const capped = stream.createThinkingStream({
                now: () => streamClock,
                maxLength: 10,
                truncationMark: '<cut>',
                ttlMs: 5_000,
            });
            capped.append('k', 'abc');
            expect(capped.read('k')?.text === 'abc' && capped.read('k')?.done === false, 'chunks accumulate');
            capped.append('k', 'defghij');
            expect(capped.read('k')?.text === 'abcdefghij', 'chunks fill the cap exactly');
            expect(capped.read('k')?.truncated === false, 'exactly at the cap is not truncated');
            capped.append('k', 'X');
            const cut = capped.read('k');
            expect(cut?.text === 'abcdefghij<cut>' && cut?.truncated === true, 'the first overflow appends the mark');
            capped.append('k', 'more');
            expect(capped.read('k')?.text === 'abcdefghij<cut>', 'later chunks are dropped');
            capped.finish('k');
            expect(capped.read('k')?.done === true && capped.read('k')?.finishedAt === 1_000, 'finish marks done');
            capped.append('k', 'after finish');
            expect(capped.read('k')?.text === 'abcdefghij<cut>', 'chunks after finish are dropped');
            streamClock += 5_000;
            expect(capped.read('k') === null, 'an expired entry reads as missing');
            expect(capped.size() === 0, 'reading an expired entry removes it');

            // The process-wide stream through the contract functions
            const attempt = newAttempt();
            service.appendLiveThinking(attempt.key, 'singleton');
            expect(stream.thinkingStream.read(attempt.key)?.text === 'singleton', 'the contract appends to the shared stream');
            service.finishLiveThinking(attempt.key);
            expect(stream.thinkingStream.read(attempt.key)?.done === true, 'the contract finishes the shared stream');

            // The 200k cap itself, on the process-wide stream
            const bigAttempt = newAttempt();
            service.appendLiveThinking(bigAttempt.key, 'x'.repeat(stream.THINKING_STREAM_MAX_LENGTH + 1));
            const big = stream.thinkingStream.read(bigAttempt.key);
            expect(big !== null && big.truncated === true, 'the shared stream cuts at 200k');
            expect(
                big !== null &&
                    big.text.length ===
                        stream.THINKING_STREAM_MAX_LENGTH + stream.THINKING_TRUNCATION_MARK.length,
                'the mark is appended once over the cap'
            );
            service.appendLiveThinking(bigAttempt.key, 'tail');
            expect(stream.thinkingStream.read(bigAttempt.key)?.text === big?.text, 'nothing more is appended after the cut');
        },
    },
    {
        name: 'the thinking_links migration is idempotent',
        body: async () => {
            await migrations.runSchemaMigrations();
            await migrations.runSchemaMigrations();

            const tables: unknown[] = await sequelize.query(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thinking_links'",
                { type: 'SELECT' }
            );
            expect(tables.length === 1, 'the table exists');
            const indexes: unknown[] = await sequelize.query(
                "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'thinking_links_target'",
                { type: 'SELECT' }
            );
            expect(indexes.length === 1, 'the unique target index exists');
            const applied: unknown[] = await sequelize.query(
                "SELECT name FROM schema_migrations WHERE name = '20261111_thinking_links'",
                { type: 'SELECT' }
            );
            expect(applied.length === 1, 'the migration is recorded once');

            // The unique target index is what makes one token per version true
            const chatId = GROUP;
            const firstMessageId = takeMessageId();
            const first = requireRef(
                await service.beginThinkingLink({ chatId, firstMessageId, versionId: 1, model: MODEL })
            );
            const second = requireRef(
                await service.beginThinkingLink({ chatId, firstMessageId, versionId: 1, model: MODEL })
            );
            expect(first.token === second.token, 'a re-trigger reuses the row after the rerun');
            const count: unknown[] = await sequelize.query(
                'SELECT COUNT(*) AS rows FROM thinking_links WHERE chatId = :chatId AND firstMessageId = :firstMessageId AND versionId = 1',
                { replacements: { chatId, firstMessageId }, type: 'SELECT' }
            );
            expect(asRecord(Array.isArray(count) ? count[0] : null).rows === 1, 'exactly one row per version');
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) results.push(await runCase(testCase.name, testCase.body));
reportResults(results);
