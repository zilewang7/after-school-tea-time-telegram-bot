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

await setupOfflineDb();
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

const callApi = (target: PanelApp, path: string, user: InitDataUserInput, method = 'GET'): Promise<Response> =>
    target.request(path, { method, headers: { 'X-Init-Data': initDataFor(user) } });

const textOf = async (response: Response): Promise<string> => response.text();

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
            expect(html.includes(`src="/s/${created.share.token}/widget/0"`), 'the conversation widget');
            expect(html.includes('2 条消息') || html.includes('对话分享'), 'conversation meta');
            expect(
                (await app.request(`/s/${created.share.token}/media/${rootId}/image`)).status === 200,
                'the user image is served'
            );
            await exclusions.excludeMessage({ chatId: GROUP, messageId: rootId, actorId: ALICE.id });
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
];

const results: CaseResult[] = [];
for (const testCase of cases) results.push(await runCase(testCase.name, testCase.body));
reportResults(results);
