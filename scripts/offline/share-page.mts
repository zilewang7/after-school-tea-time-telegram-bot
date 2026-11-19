/**
 * Offline cases for the public share page and its routes (design §5.7/§5.6):
 * the OG tags Telegram needs, escaping of user/model text, the widget iframe,
 * the media route's allow-list, revoked links, the per-IP limiter, and
 * SHARE_ENABLED=0.
 *
 * The render sidecar is off, so preview cards are seeded directly through the
 * store: this suite is about the page, not about rendering.
 *
 * Run: npx tsx scripts/offline/share-page.mts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrammyError } from 'grammy';
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';
import type { InitDataUserInput } from '../lib/init-data.mts';

const BOT_TOKEN = '123456789:AAFakeOfflineTokenForPanelTests_0123';
const OWNER_ID = 4242;
const ALICE: InitDataUserInput = { id: 5001, first_name: 'Alice' };
const GROUP = -1001000000001;
const OTHER_GROUP = -1001000000002;

process.env.OWNER_USER_ID = String(OWNER_ID);
process.env.WEBAPP_PUBLIC_URL = 'https://miniapp.test';
process.env.BOT_USER_NAME = 'k_on_test_bot';
process.env.WIDGET_RENDER_URL = '';
process.env.WEBAPP_SHARE_SECRET = 'offline-share-secret';
process.env.BOT_USER_ID = '9999';
delete process.env.ALLOWED_CHAT_IDS;

const offlineDb = await setupOfflineDb();
const registry = await import('../../src/db/queries/panel-registry.js');
const db = await import('../../src/db/index.js');
const service = await import('../../src/panel/share/share-link-service.js');
const store = await import('../../src/panel/share/share-store.js');
const publicRoutes = await import('../../src/panel/share/public-routes.js');
const exclusions = await import('../../src/db/queries/context-exclusions.js');
const signedWidget = await import('../../src/panel/share/signed-widget.js');
const { createPanelApp } = await import('../../src/panel/app.js');
const { signInitData } = await import('../lib/init-data.mts');

type MembershipLookup = import('../../src/panel/access/membership.js').MembershipLookup;
type PanelApp = ReturnType<typeof createPanelApp>;
type ResponseVersion = import('../../src/db/index.js').ResponseVersion;

const scratch = mkdtempSync(join(tmpdir(), 'k-on-bot-share-page-'));
process.once('exit', () => rmSync(scratch, { recursive: true, force: true }));
const STATIC_ROOT = join(scratch, 'dist');
mkdirSync(join(STATIC_ROOT, 'assets'), { recursive: true });
writeFileSync(join(STATIC_ROOT, 'index.html'), '<!doctype html><title>panel</title>');

const grammyError = (code: number, description: string): GrammyError =>
    new GrammyError(`(${code}: ${description})`, { ok: false, error_code: code, description }, 'getChatMember', {});

const fakeLookup: MembershipLookup = async (chatId, userId) => {
    if (chatId === GROUP && userId === ALICE.id) return { status: 'member' };
    throw grammyError(400, 'Bad Request: user not found');
};

let clockMs = Date.now();
const makeApp = (shareEnabled: boolean): PanelApp =>
    createPanelApp({
        botToken: BOT_TOKEN,
        membershipLookup: fakeLookup,
        staticRoot: STATIC_ROOT,
        startedAt: new Date('2026-11-09T00:00:00.000Z'),
        version: 'abc1234',
        now: () => clockMs,
        shareEnabled,
    });

const PNG_1PX =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const versionOf = (versionId: number, overrides: Partial<ResponseVersion> = {}): ResponseVersion => ({
    versionId,
    createdAt: '2026-11-09T12:00:00.000Z',
    messageIds: [800 + versionId],
    currentMessageId: 800 + versionId,
    text: `第 ${versionId} 版正文`,
    wasStoppedByUser: false,
    ...overrides,
});

const makeReply = async (
    chatId: number,
    messageId: number,
    versions: ResponseVersion[],
    userMessageId = 400
): Promise<import('../../src/db/index.js').BotResponse> => {
    const response = await db.createBotResponse(chatId, messageId, userMessageId, {
        model: 'offline-model',
        hasImage: false,
    });
    response.setVersions(versions);
    response.currentVersionIndex = 0;
    await response.save();
    return response;
};

const saveMessage = async (
    chatId: number,
    messageId: number,
    userId: number,
    text: string,
    options: { replyToId?: number; file?: Buffer; fileMime?: string } = {}
): Promise<void> => {
    await db.saveMessage({
        chatId,
        messageId,
        userId,
        date: new Date('2026-11-09T12:00:00.000Z'),
        userName: userId === 9999 ? 'k-on-bot' : 'Alice',
        message: text,
        ...(options.replyToId === undefined ? {} : { replyToId: options.replyToId }),
        ...(options.file === undefined ? {} : { fileBuffer: options.file }),
        ...(options.fileMime === undefined ? {} : { fileMime: options.fileMime }),
    });
};

const replyShare = async (
    chatId: number,
    messageId: number,
    versions: ResponseVersion[]
): Promise<import('../../src/panel/share/share-types.js').ShareLinkRecord> => {
    await makeReply(chatId, messageId, versions);
    const created = await service.createUserShare({
        kind: 'reply',
        chatId,
        firstMessageId: messageId,
        createdBy: ALICE.id,
    });
    if (!created.ok) throw new Error(`could not create the share: ${created.reason}`);
    return created.share;
};

const seedPreview = async (token: string, base64: string): Promise<void> => {
    await store.updateSharePreview(token, { base64, width: 1200, height: 630, source: 'text' });
};

await registry.upsertChatNow({ id: GROUP, type: 'supergroup', title: '主群' });
await registry.upsertChatNow({ id: OTHER_GROUP, type: 'supergroup', title: '另一个群' });

let nextMessageId = 4000;
const takeMessageId = (): number => (nextMessageId += 1);

const app = makeApp(true);
const disabledApp = makeApp(false);

const initDataFor = (user: InitDataUserInput): string =>
    signInitData({ botToken: BOT_TOKEN, user, authDate: Math.floor(clockMs / 1000) });

const callApi = async (target: PanelApp, path: string, user: InitDataUserInput, method = 'GET'): Promise<Response> =>
    target.request(path, { method, headers: { 'X-Init-Data': initDataFor(user) } });

const textOf = async (response: Response): Promise<string> => response.text();

/** The rendered page body: the `<head>` CSS names the same rich classes */
const mainOf = (html: string): string => {
    const start = html.indexOf('<main>');
    const end = html.indexOf('</main>');
    return start < 0 || end < 0 ? html : html.slice(start, end);
};

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'the share page carries the OG tags Telegram needs',
        body: async () => {
            const messageId = takeMessageId();
            const share = await replyShare(GROUP, messageId, [versionOf(1, { text: '一段**加粗**的正文' })]);
            await seedPreview(share.token, Buffer.from('preview-card').toString('base64'));
            const response = await app.request(`/s/${share.token}`);
            const html = await textOf(response);
            expect(response.status === 200, '200');
            expect(response.headers.get('X-Robots-Tag') === 'noindex, nofollow', 'noindex header');
            expect(response.headers.get('Content-Security-Policy')?.includes("frame-src 'self'") === true, 'CSP');
            expect(html.includes('<meta name="robots" content="noindex,nofollow">'), 'robots meta');
            expect(html.includes('<meta property="og:type" content="article">'), 'og:type');
            expect(html.includes('<meta property="og:site_name" content="k-on-bot">'), 'og:site_name');
            expect(html.includes(`<meta property="og:url" content="https://miniapp.test/s/${share.token}">`), 'og:url');
            expect(
                html.includes(
                    `<meta property="og:image" content="https://miniapp.test/s/${share.token}/og.png">`
                ),
                'og:image is absolute'
            );
            expect(html.includes('<meta property="og:image:width" content="1200">'), 'og:image:width');
            expect(html.includes('<meta property="og:image:height" content="630">'), 'og:image:height');
            expect(html.includes('<meta name="twitter:card" content="summary_large_image">'), 'twitter:card');
            expect(html.includes('<strong>加粗</strong>'), 'markdown rendered');
            expect(html.includes('主群'), 'the chat title');
            expect(html.includes('在 Telegram 打开 Mini App'), 'the Mini App button');
        },
    },
    {
        name: 'og:image uses the stored widget render size',
        body: async () => {
            const messageId = takeMessageId();
            const share = await replyShare(GROUP, messageId, [versionOf(1)]);
            await store.updateSharePreview(share.token, {
                base64: Buffer.from('widget-render-bytes').toString('base64'),
                width: 1200,
                height: 428,
                source: 'widget',
            });
            const html = await textOf(await app.request(`/s/${share.token}`));
            expect(html.includes('<meta property="og:image:width" content="1200">'), 'the real width');
            expect(html.includes('<meta property="og:image:height" content="428">'), 'the real render height');
            expect(!html.includes('content="630"'), 'no fixed 630');
            expect(html.includes('<meta name="twitter:image"'), 'twitter:image');
            const image = await app.request(`/s/${share.token}/og.png`);
            expect(image.status === 200, 'og.png serves the render');
            expect(
                Buffer.from(await image.arrayBuffer()).equals(Buffer.from('widget-render-bytes')),
                'the stored bytes'
            );
        },
    },
    {
        name: 'the preview URL is the render to Telegram and the page to a browser',
        body: async () => {
            const messageId = takeMessageId();
            const share = await replyShare(GROUP, messageId, [
                versionOf(1, {
                    text: '一段正文',
                    widget: { mode: 'a2ui', html: '<div>卡片</div>', htmlBytes: 12, zlibBytes: 20 },
                }),
            ]);
            await store.updateSharePreview(share.token, {
                base64: Buffer.from('widget-render-bytes').toString('base64'),
                width: 1200,
                height: 428,
                source: 'widget',
            });

            const crawler = await app.request(`/s/${share.token}/preview`, {
                headers: { 'user-agent': 'TelegramBot (like TwitterBot)' },
            });
            expect(crawler.status === 200, 'the crawler gets 200');
            expect(crawler.headers.get('Content-Type') === 'image/png', 'the crawler gets the render, so the preview is the picture');
            expect(
                Buffer.from(await crawler.arrayBuffer()).equals(Buffer.from('widget-render-bytes')),
                'the stored bytes'
            );

            const browser = await app.request(`/s/${share.token}/preview`, {
                headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' },
            });
            const html = await textOf(browser);
            expect(browser.status === 200, 'a browser gets 200');
            expect(browser.headers.get('Content-Type')?.startsWith('text/html') === true, 'a browser gets the page');
            expect(html.includes('const reveal = true;'), 'the page reveals the card');
            expect(html.includes('一段正文'), 'the page renders the content');
            expect(
                html.includes(`<meta property="og:image" content="https://miniapp.test/s/${share.token}/og.png">`),
                'the image tags stay, as the fallback if the UA is ever missed'
            );
            expect(!html.includes('og:title'), 'no text OG to repeat the caption');
            expect(!html.includes('og:site_name'), 'no site line');

            await new Promise((resolve) => setTimeout(resolve, 120));
            const row = await store.findShareRowByToken(share.token);
            expect(row?.viewCount === 0, `neither fetch is a reader view (got ${String(row?.viewCount)})`);

            const canonical = await textOf(await app.request(`/s/${share.token}`));
            expect(canonical.includes('const reveal = false;'), 'the share page itself does not jump');
            expect(canonical.includes('og:title'), 'and keeps its text OG');
        },
    },
    {
        name: 'the preview URL without a render is 404 to the crawler, the page to a browser',
        body: async () => {
            const messageId = takeMessageId();
            const share = await replyShare(GROUP, messageId, [versionOf(1, { text: '纯文本' })]);
            const crawler = await app.request(`/s/${share.token}/preview`, {
                headers: { 'user-agent': 'TelegramBot (like TwitterBot)' },
            });
            expect(crawler.status === 404, 'nothing to preview');
            const browser = await app.request(`/s/${share.token}/preview`);
            expect(browser.status === 200, 'a browser still gets the page');
            const html = await textOf(browser);
            expect(html.includes('纯文本'), 'the content is there');
            expect(!html.includes('og:image'), 'and no image tag');
        },
    },
    {
        name: 'a share without a preview card omits og:image',
        body: async () => {
            const messageId = takeMessageId();
            const share = await replyShare(GROUP, messageId, [versionOf(1)]);
            const html = await textOf(await app.request(`/s/${share.token}`));
            expect(!html.includes('og:image'), 'no og:image');
            expect(!html.includes('twitter:image'), 'no twitter:image');
            expect(html.includes('<meta name="twitter:card" content="summary_large_image">'), 'card type stays');
        },
    },
    {
        name: 'stored markdown maps to whitelisted HTML and everything else is escaped',
        body: async () => {
            const messageId = takeMessageId();
            const share = await replyShare(GROUP, messageId, [
                versionOf(1, {
                    text: '**加粗** <script>alert(1)</script> `code` [link](https://example.com) [bad](javascript:alert(1))',
                }),
            ]);
            const html = await textOf(await app.request(`/s/${share.token}`));
            expect(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'the script tag is escaped');
            expect(!html.includes('<script>alert(1)</script>'), 'no raw script');
            expect(html.includes('<code>code</code>'), 'inline code');
            expect(html.includes('href="https://example.com"'), 'safe link');
            expect(!html.includes('href="javascript:'), 'javascript: is not a link');
            expect(html.includes('rel="noopener noreferrer nofollow"'), 'external links are nofollow');
        },
    },
    {
        name: 'a widget renders in a sandboxed iframe and its document is served',
        body: async () => {
            const messageId = takeMessageId();
            const share = await replyShare(GROUP, messageId, [
                versionOf(1, {
                    text: '一张卡片',
                    widget: {
                        mode: 'a2ui',
                        html: '<div id="card">卡片内容</div>',
                        htmlBytes: 30,
                        zlibBytes: 44,
                        caption: '说明文字',
                    },
                }),
            ]);
            const html = await textOf(await app.request(`/s/${share.token}`));
            expect(html.includes(`src="/s/${share.token}/widget/0"`), 'iframe points at the widget route');
            expect(html.includes('sandbox="allow-scripts"'), 'sandboxed');
            expect(html.includes('说明文字'), 'the caption is shown');

            const widgetResponse = await app.request(`/s/${share.token}/widget/0`);
            const document = await textOf(widgetResponse);
            expect(widgetResponse.status === 200, '200');
            expect(
                widgetResponse.headers.get('Content-Security-Policy')?.includes("frame-ancestors 'self'") === true,
                'frame-ancestors self'
            );
            expect(document.includes('卡片内容'), 'the widget html');
            expect(document.includes('k-on-bot:widget-height'), 'the height report');
            expect((await app.request(`/s/${share.token}/widget/1`)).status === 404, 'a missing widget index is 404');
        },
    },
    {
        name: 'the media route serves only the shared attachment',
        body: async () => {
            const messageId = takeMessageId();
            const share = await replyShare(GROUP, messageId, [versionOf(1, { imageBase64: PNG_1PX })]);
            const image = await app.request(`/s/${share.token}/media/${messageId}/image`);
            expect(image.status === 200, '200');
            expect(image.headers.get('Content-Type') === 'image/png', 'content type');
            const bytes = Buffer.from(await image.arrayBuffer());
            expect(bytes.equals(Buffer.from(PNG_1PX, 'base64')), 'the stored bytes');
            expect((await app.request(`/s/${share.token}/media/${messageId}/file`)).status === 404, 'no file to serve');
            expect((await app.request(`/s/${share.token}/media/999999/image`)).status === 404, 'another message is not exposed');
            expect((await app.request(`/s/${share.token}/media/${messageId}/video`)).status === 404, 'unknown slot');

            const otherMessageId = takeMessageId();
            const otherShare = await replyShare(OTHER_GROUP, otherMessageId, [versionOf(1, { imageBase64: PNG_1PX })]);
            expect(
                (await app.request(`/s/${otherShare.token}/media/${messageId}/image`)).status === 404,
                'a reply of another share is not exposed'
            );
        },
    },
    {
        name: 'a conversation share renders user and bot bubbles',
        body: async () => {
            const rootId = takeMessageId();
            const botId = takeMessageId();
            await saveMessage(GROUP, rootId, ALICE.id, '用户的问题', {
                file: Buffer.from(PNG_1PX, 'base64'),
                fileMime: 'image/png',
            });
            await saveMessage(GROUP, botId, 9999, '', { replyToId: rootId });
            const response = await db.createBotResponse(GROUP, botId, rootId, { model: 'offline-model', hasImage: false });
            response.setVersions([
                versionOf(1, {
                    text: 'bot 的回答',
                    widget: { mode: 'a2ui', html: '<div>会话卡片</div>', htmlBytes: 20, zlibBytes: 30 },
                }),
            ]);
            response.currentVersionIndex = 0;
            await response.save();
            const created = await service.createUserShare({
                kind: 'conversation',
                chatId: GROUP,
                rootId,
                createdBy: ALICE.id,
            });
            expect(created.ok, 'created');
            if (!created.ok) return;
            const html = await textOf(await app.request(`/s/${created.share.token}`));
            expect(html.includes('用户的问题') && html.includes('Alice'), 'the user bubble');
            expect(html.includes('bot 的回答'), 'the bot bubble');
            expect(html.includes('↳ 回复') && html.includes('Alice'), 'the bot bubble names the message it answers');
            expect(html.includes(`src="/s/${created.share.token}/widget/0"`), 'the conversation widget');
            expect(html.includes('2 条消息') || html.includes('对话分享'), 'conversation meta');
            expect(!mainOf(html).includes('bubble-fold'), 'nothing folds while no message is deleted');
            expect(
                (await app.request(`/s/${created.share.token}/media/${rootId}/image`)).status === 200,
                'the user image is served'
            );

            // The page reads the database per request, so marking the row is enough
            await offlineDb.Message.update(
                { deletedAt: new Date('2026-11-18T12:00:00.000Z') },
                { where: { chatId: GROUP, messageId: rootId } }
            );
            const folded = await textOf(await app.request(`/s/${created.share.token}`));
            expect(folded.includes('<details class="bubble-fold">'), 'a deleted bubble folds by default');
            expect(folded.includes('<summary class="bubble-head">'), 'the bubble head is the summary');
            expect(folded.includes('<span class="deleted-flag">已删除</span>'), 'the summary names the deletion');
            expect(folded.includes('用户的问题'), 'the folded text is still in the page (folded, not hidden)');
            expect(folded.split('<details class="bubble-fold">').length - 1 === 1, 'exactly the deleted bubble folds');
            const userBubbleStart = folded.indexOf('<article class="bubble user">');
            const botBubbleStart = folded.indexOf('<article class="bubble bot">');
            expect(
                userBubbleStart > 0 && folded.slice(userBubbleStart, botBubbleStart).includes('<details class="bubble-fold">'),
                'the user bubble is the folded one'
            );
            expect(
                !folded.slice(botBubbleStart, folded.indexOf('</main>')).includes('bubble-fold'),
                'a bubble that is not deleted keeps its markup'
            );

            await exclusions.excludeMessage({ chatId: GROUP, messageId: rootId, actorId: ALICE.id });
            const excludedHtml = await textOf(await app.request(`/s/${created.share.token}`));
            expect(!excludedHtml.includes('用户的问题'), 'an excluded message is not on the page at all');
            expect(
                (await app.request(`/s/${created.share.token}/media/${rootId}/image`)).status === 404,
                'an excluded message is not exposed'
            );
        },
    },
    {
        name: 'a revoked share is 404 everywhere',
        body: async () => {
            const messageId = takeMessageId();
            const share = await replyShare(GROUP, messageId, [versionOf(1, { text: '不应泄露的正文' })]);
            await seedPreview(share.token, Buffer.from('preview-card').toString('base64'));
            const revoked = await service.revokeShare(share.token, { userId: ALICE.id, isOwner: false });
            expect(revoked === 'revoked', 'revoked');
            const page = await app.request(`/s/${share.token}`);
            const html = await textOf(page);
            expect(page.status === 404, 'page 404');
            expect(html.includes('链接无效或已撤销'), 'the 404 page');
            expect(!html.includes('不应泄露的正文'), 'no content leaks');
            expect(page.headers.get('X-Robots-Tag') === 'noindex, nofollow', 'noindex');
            expect((await app.request(`/s/${share.token}/og.png`)).status === 404, 'og.png 404');
            expect((await app.request(`/s/${share.token}/widget/0`)).status === 404, 'widget 404');
            expect((await app.request(`/s/${share.token}/media/${messageId}/image`)).status === 404, 'media 404');
            expect((await app.request('/s/AAAAAAAAAAAAAAAAAAAAAAAA')).status === 404, 'an unknown token is 404');
            expect((await app.request('/s/not-a-token')).status === 404, 'a malformed token is 404');
        },
    },
    {
        name: 'the og.png route serves the stored card',
        body: async () => {
            const messageId = takeMessageId();
            const share = await replyShare(GROUP, messageId, [versionOf(1)]);
            const cardBytes = Buffer.from('fake-og-card-bytes');
            await seedPreview(share.token, cardBytes.toString('base64'));
            const response = await app.request(`/s/${share.token}/og.png`);
            expect(response.status === 200, '200');
            expect(response.headers.get('Content-Type') === 'image/png', 'png content type');
            expect(Buffer.from(await response.arrayBuffer()).equals(cardBytes), 'the stored bytes');
            expect(response.headers.get('Cache-Control') === 'public, max-age=300', 'cached');
        },
    },
    {
        name: 'SHARE_ENABLED=0 turns the public routes and the share API off',
        body: async () => {
            const messageId = takeMessageId();
            const share = await replyShare(GROUP, messageId, [versionOf(1)]);
            expect((await disabledApp.request(`/s/${share.token}`)).status === 404, 'page 404');
            expect((await disabledApp.request(`/s/${share.token}/og.png`)).status === 404, 'og 404');
            const query = `/api/shares?kind=reply&chatId=${GROUP}&firstMessageId=${messageId}`;
            const apiResponse = await callApi(disabledApp, query, ALICE);
            expect(apiResponse.status === 404, 'share API 404');
            const enabledApi = await callApi(app, query, ALICE);
            expect(enabledApi.status === 200, 'the enabled app still answers');
        },
    },
    {
        name: 'the public rate limiter counts per address and resets with the window',
        body: async () => {
            let nowMs = 0;
            const allow = publicRoutes.createPublicRateLimiter({ limit: 2, windowMs: 60_000, now: () => nowMs });
            expect(allow('1.2.3.4') && allow('1.2.3.4'), 'two requests pass');
            expect(!allow('1.2.3.4'), 'the third is refused');
            expect(allow('5.6.7.8'), 'another address has its own window');
            nowMs = 60_001;
            expect(allow('1.2.3.4'), 'the window resets');
        },
    },
    {
        name: 'the signed widget URL expires and rejects a forged signature',
        body: async () => {
            const messageId = takeMessageId();
            await makeReply(GROUP, messageId, [
                versionOf(1, { widget: { mode: 'html', html: '<div>签名</div>', htmlBytes: 12, zlibBytes: 20 } }),
            ]);
            const signer = signedWidget.createWidgetSigner({ botToken: BOT_TOKEN, now: () => clockMs });
            const signed = signer.sign({ chatId: GROUP, firstMessageId: messageId, versionId: 1, kind: 'doc' });
            expect(signer.verify(signed.path.slice(3)) !== null, 'a fresh token verifies');
            const forged = `${signed.path.slice(3).split('.')[0]}.${'A'.repeat(43)}`;
            expect(signer.verify(forged) === null, 'a forged signature is rejected');
            clockMs += 11 * 60 * 1000;
            expect(signer.verify(signed.path.slice(3)) === null, 'the token expires after 10 minutes');
            clockMs -= 11 * 60 * 1000;

            const document = await app.request(signed.path);
            expect(document.status === 200, 'the route serves the document');
            const html = await textOf(document);
            expect(html.includes('签名'), 'the widget html');
            expect(
                document.headers.get('Content-Security-Policy')?.includes("default-src 'none'") === true,
                'the widget CSP'
            );
            const withTheme = await app.request(`${signed.path}?theme=dark`);
            expect(withTheme.status === 200, 'a theme query is accepted');
            const inlineTheme = await app.request(`${signed.path}&theme=dark`);
            expect(inlineTheme.status === 200, 'the early webapp &theme= form is tolerated');
            expect((await app.request('/w/forged.token')).status === 404, 'a malformed token is 404');
        },
    },
    // v5.3: a rich reply's share page lays the body out like the chat did
    // (design 2026-1116-0310 §三.2): pictures in place, captions under them,
    // and only the pictures the snapshot did not place appended at the end.
    {
        name: 'a rich reply share puts its pictures where the model put them',
        body: async () => {
            const messageId = takeMessageId();
            const snapshot = [
                '开头的一段**粗体**正文。',
                '',
                '![](tg://photo?id=img1 "第一张：红色圆形")',
                '',
                '两张图的解释：第一张是红色圆形。',
                '',
                '![](tg://photo?id=img2 "第二张：绿色三角形")',
                '',
                '结尾一段，带一个会被脱敏的链接：[来源](https://t.me/c/-1001234567890/42)。',
            ].join('\n');
            const share = await replyShare(GROUP, messageId, [
                versionOf(1, {
                    text: '原始 **markdown** 正文',
                    delivery: 'rich',
                    richRenderer: 'v1',
                    richAnswerMarkdown: snapshot,
                    media: [
                        {
                            placement: 'inline',
                            id: 'img1',
                            mimeType: 'image/png',
                            sizeBytes: 101,
                            caption: '第一张：红色圆形',
                        },
                        {
                            placement: 'inline',
                            id: 'img2',
                            mimeType: 'image/png',
                            sizeBytes: 102,
                            caption: '第二张：绿色三角形',
                        },
                    ],
                }),
            ]);
            const html = await textOf(await app.request(`/s/${share.token}`));
            expect(html.includes('<div class="md rich">'), 'the rich body container');
            const firstFigure = html.indexOf('<figure class="rich-figure">');
            const secondFigure = html.indexOf('<figure class="rich-figure">', firstFigure + 1);
            expect(firstFigure > 0 && secondFigure > firstFigure, 'both pictures render in the body');
            expect(html.indexOf('<div class="md rich">') < firstFigure, 'the body starts before the first picture');
            const firstSrc = `/s/${share.token}/media/${messageId}/image`;
            expect(html.includes(`<img src="${firstSrc}" alt="图片" loading="lazy">`), 'the first picture URL (index 0 has no ?i=)');
            expect(html.includes(`<img src="${firstSrc}?i=1"`), 'the second picture names its media index');
            expect(html.includes('<figcaption>第一张：红色圆形</figcaption>'), 'the first caption');
            expect(html.includes('<figcaption>第二张：绿色三角形</figcaption>'), 'the second caption');
            const between = html.slice(firstFigure, secondFigure);
            expect(between.includes('两张图的解释'), 'the paragraph between the pictures stays between them');
            expect(html.indexOf('结尾一段') > secondFigure, 'the last paragraph stays after the last picture');
            expect(html.includes('<strong>粗体</strong>'), 'the snapshot inline markup renders');
            expect(!html.includes('![]('), 'no raw media block syntax');
            expect(!html.includes('<b>'), 'no raw inline tags');
            expect(!html.includes('原始 **markdown** 正文'), 'the raw version text is not the body');
            expect(html.includes('[data-deletion]'), 'the snapshot is redacted like every other public string');
            expect(!html.includes('-1001234567890'), 'no internal chat id leaks through the snapshot');
        },
    },
    {
        name: 'a rich-text fallback appends its pictures once, after the body',
        body: async () => {
            const messageId = takeMessageId();
            const share = await replyShare(GROUP, messageId, [
                versionOf(1, {
                    text: '只能把图放在下面了。',
                    delivery: 'rich-text',
                    richRenderer: 'v1',
                    richAnswerMarkdown: '正文第一段。\n\n<p><i>（另有 2 张图未能内嵌发送）</i></p>\n\n正文第二段。',
                    widget: { mode: 'a2ui', html: '<div>卡片</div>', htmlBytes: 12, zlibBytes: 20 },
                    media: [
                        { placement: 'attachment', mimeType: 'image/png', sizeBytes: 201, caption: '附件图注一' },
                        { placement: 'attachment', mimeType: 'image/png', sizeBytes: 202, caption: '附件图注二**加粗**' },
                    ],
                }),
            ]);
            const html = await textOf(await app.request(`/s/${share.token}`));
            expect(html.includes('<em>（另有 2 张图未能内嵌发送）</em>'), 'the L2 note renders as text');
            expect(!html.includes('<p><i>'), 'the block-level <p> wrapper is stripped');
            expect(!mainOf(html).includes('<figure class="rich-figure">'), 'the body has no inline picture');
            const bodyEnd = html.indexOf('</div>', html.indexOf('<div class="md rich">'));
            const widget = html.indexOf(`<iframe class="widget" src="/s/${share.token}/widget/0"`);
            const appended = html.indexOf('<figure class="image">');
            expect(bodyEnd > 0 && widget > bodyEnd, 'the widget still comes after the body');
            expect(appended > widget, 'the pictures the snapshot did not place come after the widget');
            expect(html.split('<figure class="image">').length - 1 === 2, 'both attachment pictures appended once');
            const src = `/s/${share.token}/media/${messageId}/image`;
            expect(html.includes(`src="${src}"`), 'the first attachment (index 0 has no ?i=)');
            expect(html.includes(`src="${src}?i=1"`), 'the second attachment names its index');
            expect(html.includes('<figcaption>附件图注一</figcaption>'), 'the first leftover caption');
            expect(html.includes('<figcaption>附件图注二<strong>加粗</strong></figcaption>'), 'the second leftover caption is markdown');
        },
    },
    {
        name: 'a conversation share renders a rich bot bubble in place, user bubbles unchanged',
        body: async () => {
            const rootId = takeMessageId();
            const botId = takeMessageId();
            await saveMessage(GROUP, rootId, ALICE.id, '用户的问题');
            await saveMessage(GROUP, botId, 9999, '', { replyToId: rootId });
            const response = await db.createBotResponse(GROUP, botId, rootId, { model: 'offline-model', hasImage: false });
            response.setVersions([
                versionOf(1, {
                    text: 'bot 的回答',
                    delivery: 'rich',
                    richRenderer: 'v1',
                    richAnswerMarkdown: '先看图：\n\n![](tg://photo?id=img1 "一张")',
                    media: [
                        {
                            placement: 'inline',
                            id: 'img1',
                            mimeType: 'image/png',
                            sizeBytes: 301,
                            caption: '一张',
                        },
                    ],
                }),
            ]);
            response.currentVersionIndex = 0;
            await response.save();
            const created = await service.createUserShare({
                kind: 'conversation',
                chatId: GROUP,
                rootId,
                createdBy: ALICE.id,
            });
            expect(created.ok, 'created');
            if (!created.ok) return;
            const token = created.share.token;
            const html = await textOf(await app.request(`/s/${token}`));
            const userBubble = html.indexOf('<article class="bubble user">');
            const botBubbleStart = html.indexOf('<article class="bubble bot">');
            expect(userBubble > 0 && botBubbleStart > userBubble, 'user bubble before the bot bubble');
            const figure = html.indexOf('<figure class="rich-figure">', botBubbleStart);
            expect(figure > botBubbleStart, 'the bot bubble renders its picture inside the rich body');
            expect(html.includes(`<img src="/s/${token}/media/${botId}/image"`), 'the bubble message id owns the picture URL');
            expect(html.includes('<figcaption>一张</figcaption>'), 'the caption');
            expect(html.slice(0, botBubbleStart).includes('用户的问题'), 'the user bubble text is unchanged');
            expect(
                !html.slice(userBubble, botBubbleStart).includes('<figure class="rich-figure">'),
                'no picture in the user bubble'
            );
        },
    },
    {
        name: 'an entities version with a stale snapshot keeps the old rendering',
        body: async () => {
            const messageId = takeMessageId();
            const share = await replyShare(GROUP, messageId, [
                versionOf(1, {
                    text: '一段**加粗**的正文',
                    richAnswerMarkdown: '这是 entities 版本不该出现的快照。',
                }),
            ]);
            const html = await textOf(await app.request(`/s/${share.token}`));
            const body = mainOf(html);
            expect(!body.includes('class="md rich"'), 'no rich container without the delivery/rendered claim');
            expect(!body.includes('<figure class="rich-figure">'), 'no rich body');
            // The body is exactly the old path: one text block, no rich layout
            const botBody = mainOf(html);
            expect(botBody.startsWith('<main><article class="bubble bot">'), 'the old bot bubble body starts the page');
            expect(botBody.endsWith('</article>'), 'and ends it');
            expect(
                html.includes('<div class="md">一段<strong>加粗</strong>的正文</div>'),
                'the old text rendering is unchanged'
            );
            expect(botBody.split('<div class="md">').length - 1 === 1, 'one plain text block, no extra body');
            expect(!html.includes('不该出现的快照'), 'the stale snapshot never reaches the page');
        },
    },
    {
        // B1/M3/M4 (design §八): every public string is redacted in the one gate,
        // captions are markdown, and leftover pictures keep their caption
        name: 'rich captions are redacted, rendered, and leftover pictures keep theirs',
        body: async () => {
            const messageId = takeMessageId();
            const leakyCaption =
                '**粗体**图注与<b>标签</b>，来源 [链接](https://t.me/c/-1009876543210/77)，用户 [提及](tg://user?id=123456789)。';
            const share = await replyShare(GROUP, messageId, [
                versionOf(1, {
                    delivery: 'rich',
                    richRenderer: 'v1',
                    richAnswerMarkdown: '正文。\n\n![](tg://photo?id=img1 "第一张图注")',
                    media: [
                        {
                            placement: 'inline',
                            id: 'img1',
                            mimeType: 'image/png',
                            sizeBytes: 101,
                            caption: leakyCaption,
                        },
                        { placement: 'attachment', mimeType: 'image/png', sizeBytes: 102, caption: '附件图注**加粗**' },
                    ],
                }),
            ]);
            const html = await textOf(await app.request(`/s/${share.token}`));
            const body = mainOf(html);
            expect(body.includes('class="md rich"'), 'the rich body');
            // M3: the stored caption is markdown, rendered as the chat showed it
            expect(
                body.includes('<figcaption><strong>粗体</strong>图注与<strong>标签</strong>'),
                `the inline caption markdown (got ${body.slice(0, 600)})`
            );
            expect(body.includes('<figcaption>附件图注<strong>加粗</strong></figcaption>'), 'the leftover caption markdown');
            // B1: both caption strings went through the share redaction gate
            expect(body.includes('[data-deletion]'), 'the captions are redacted');
            expect(!html.includes('-1009876543210'), 'no internal chat id leaks through a caption');
            expect(!html.includes('123456789'), 'no user tg id leaks through a caption');
            // M1: the block tags are emitted without whitespace text nodes
            const richStart = body.indexOf('<div class="md rich">');
            const richEnd = body.indexOf('</div>', richStart);
            const richBody = body.slice(richStart, richEnd);
            expect(!richBody.includes('\n'), 'no whitespace between blocks');
            expect(html.includes('.md.rich { white-space: normal; }'), 'the container does not cascade pre-wrap');
            expect(
                html.includes('.md.rich p { margin: 6px 0; white-space: pre-wrap; }'),
                'paragraphs keep their own whitespace like the Mini App'
            );
            expect(html.includes('@media (hover: none)'), 'spoilers are readable on touch devices');
        },
    },
    {
        // m2 (design §八): a snapshot this renderer cannot produce keeps the old text
        name: 'an empty rich render falls back to the stored text, never a 500',
        body: async () => {
            const messageId = takeMessageId();
            const share = await replyShare(GROUP, messageId, [
                versionOf(1, {
                    text: '旧文本正文**加粗**',
                    delivery: 'rich',
                    richRenderer: 'v1',
                    richAnswerMarkdown: '<p></p>',
                }),
            ]);
            const response = await app.request(`/s/${share.token}`);
            const html = await textOf(response);
            expect(response.status === 200, 'the page never 500s on a snapshot');
            const body = mainOf(html);
            expect(!body.includes('class="md rich"'), 'no empty rich container');
            expect(body.includes('<div class="md">旧文本正文<strong>加粗</strong></div>'), 'the old text block is the fallback');
        },
    },
    {
        // M4 (design §八): a rich reply's file attachment keeps its download slot
        name: 'a rich reply file attachment keeps its download slot',
        body: async () => {
            const messageId = takeMessageId();
            const fileBytes = Buffer.from('attachment-bytes');
            const share = await replyShare(GROUP, messageId, [
                versionOf(1, {
                    delivery: 'rich',
                    richRenderer: 'v1',
                    richAnswerMarkdown: '正文。',
                    file: { name: 'report.md', mimeType: 'text/markdown', sizeBytes: fileBytes.length },
                    fileBase64: fileBytes.toString('base64'),
                }),
            ]);
            const html = await textOf(await app.request(`/s/${share.token}`));
            const body = mainOf(html);
            const href = `/s/${share.token}/media/${messageId}/file`;
            expect(body.includes(`href="${href}"`), `the file chip uses the file slot (got ${body.slice(0, 500)})`);
            expect(body.includes('report.md'), 'the download name');
            const response = await app.request(href);
            expect(response.status === 200, `the file slot serves the bytes (got ${response.status})`);
            expect(Buffer.from(await response.arrayBuffer()).equals(fileBytes), 'the stored file bytes');
        },
    },
    {
        name: 'a rich snapshot cannot inject HTML or unsafe links',
        body: async () => {
            const messageId = takeMessageId();
            const share = await replyShare(GROUP, messageId, [
                versionOf(1, {
                    delivery: 'rich',
                    richRenderer: 'v1',
                    richAnswerMarkdown: [
                        '第一段。',
                        '',
                        '<script>alert(1)</script>',
                        '',
                        '[点我](javascript:alert(2))',
                        '',
                        '[内部图](tg://photo?id=img1)',
                        '',
                        '![](tg://photo?id=ghost "仅有图注")',
                    ].join('\n'),
                }),
            ]);
            const html = await textOf(await app.request(`/s/${share.token}`));
            expect(!html.includes('<script>alert(1)'), 'the injected tag is not live markup');
            expect(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'it is shown as text');
            expect(!/href="javascript:/i.test(html), 'a javascript: link never becomes an anchor');
            expect(!html.includes('href="tg://photo'), 'an internal picture reference never becomes a link');
            expect(!mainOf(html).includes('<figure class="rich-figure">'), 'an unmatched picture has no figure');
            expect(html.includes('仅有图注'), 'its caption stays as text');
            expect(!html.includes('![]('), 'no raw media block syntax');
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) results.push(await runCase(testCase.name, testCase.body));
reportResults(results);
