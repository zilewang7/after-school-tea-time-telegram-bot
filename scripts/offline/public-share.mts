/**
 * Offline cases for the public share JSON (design §5.6/§5.7): the view the
 * Mini App reads behind `?startapp=s<token>` — its shape, the uniform 404, the
 * no-store/noindex headers, the per-IP limit, the `s<token>` start_param and
 * start target, and the share page's Mini App button.
 *
 * The render sidecar is off: this suite is about the public read path, not
 * about preview cards.
 *
 * Run: npx tsx scripts/offline/public-share.mts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { GrammyError } from 'grammy';
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';
import type { InitDataUserInput } from '../lib/init-data.mts';

const BOT_TOKEN = '123456789:AAFakeOfflineTokenForPanelTests_0123';
const OWNER_ID = 4242;
const ALICE: InitDataUserInput = { id: 5001, first_name: 'Alice' };
const BOB: InitDataUserInput = { id: 5002, first_name: 'Bob' };
const GROUP = -1001000000001;
const BOT_USER_ID = 9999;

process.env.OWNER_USER_ID = String(OWNER_ID);
process.env.WEBAPP_PUBLIC_URL = 'https://miniapp.test';
process.env.BOT_USER_NAME = 'k_on_test_bot';
process.env.WIDGET_RENDER_URL = '';
process.env.BOT_USER_ID = String(BOT_USER_ID);
delete process.env.ALLOWED_CHAT_IDS;

await setupOfflineDb();
const registry = await import('../../src/db/queries/panel-registry.js');
const db = await import('../../src/db/index.js');
const service = await import('../../src/panel/share/share-link-service.js');
const store = await import('../../src/panel/share/share-store.js');
const publicApi = await import('../../src/panel/share/public-api.js');
const shareUrls = await import('../../src/panel/share/share-urls.js');
const startParam = await import('../../src/panel/auth/start-param.js');
const { createPanelApp } = await import('../../src/panel/app.js');
const { signInitData } = await import('../lib/init-data.mts');

type MembershipLookup = import('../../src/panel/access/membership.js').MembershipLookup;
type PanelApp = ReturnType<typeof createPanelApp>;
type PanelEnv = import('../../src/panel/context.js').PanelEnv;
type ResponseVersion = import('../../src/db/index.js').ResponseVersion;
type ShareLinkRecord = import('../../src/panel/share/share-types.js').ShareLinkRecord;

const scratch = mkdtempSync(join(tmpdir(), 'k-on-bot-public-share-'));
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
        userName: userId === BOT_USER_ID ? 'k-on-bot' : 'Alice',
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
): Promise<ShareLinkRecord> => {
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

let nextMessageId = 6000;
const takeMessageId = (): number => (nextMessageId += 1);

await registry.upsertChatNow({ id: GROUP, type: 'supergroup', title: '主群' });

const app = makeApp(true);
const disabledApp = makeApp(false);

const initDataFor = (user: InitDataUserInput, startParamValue?: string): string =>
    signInitData({
        botToken: BOT_TOKEN,
        user,
        authDate: Math.floor(clockMs / 1000),
        ...(startParamValue === undefined ? {} : { startParam: startParamValue }),
    });

const jsonOf = async (response: Response): Promise<Record<string, unknown>> =>
    JSON.parse(await response.text()) as Record<string, unknown>;

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : {};

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'the public API answers a reply share without initData',
        body: async () => {
            const messageId = takeMessageId();
            const share = await replyShare(GROUP, messageId, [
                versionOf(1, {
                    model: 'gemini-4-argon',
                    text: '一段**加粗**的正文',
                    imageBase64: PNG_1PX,
                    widget: { mode: 'a2ui', html: '<div>不应外发的 HTML</div>', htmlBytes: 30, zlibBytes: 40, caption: '卡片说明' },
                    file: { name: 'report.md', mimeType: 'text/markdown', sizeBytes: 128 },
                }),
            ]);
            await store.updateSharePreview(share.token, {
                base64: Buffer.from('preview-bytes').toString('base64'),
                width: 1200,
                height: 630,
                source: 'text',
            });

            // No X-Init-Data: the token alone is the permission
            const response = await app.request(`/api/public/shares/${share.token}`);
            expect(response.status === 200, `200 without initData (got ${response.status})`);
            expect(response.headers.get('Cache-Control') === 'no-store', 'Cache-Control no-store');
            expect(response.headers.get('X-Robots-Tag') === 'noindex, nofollow', 'noindex');
            expect(response.headers.get('Content-Type')?.startsWith('application/json') === true, 'JSON content type');

            const raw = await response.text();
            const shareView = asRecord(asRecord(JSON.parse(raw)).share);
            expect(shareView.token === share.token, 'the token');
            expect(shareView.kind === 'reply', 'kind reply');
            expect(shareView.chatId === GROUP && shareView.chatTitle === '主群', 'chat identity');
            expect(shareView.createdAt === share.createdAt, 'the share creation time');
            expect(shareView.conversation === undefined, 'no conversation key on a reply share');

            const reply = asRecord(shareView.reply);
            expect(reply.firstMessageId === messageId, 'firstMessageId');
            expect(reply.versionId === 1 && reply.versionNumber === 1, 'version identity');
            expect(reply.createdAt === '2026-11-09T12:00:00.000Z', 'version time');
            expect(reply.model === 'gemini-4-argon', 'model');
            expect(reply.text === '一段**加粗**的正文', 'the raw markdown text');
            expect(asRecord(reply.widget).caption === '卡片说明', 'the widget caption only');
            expect(reply.hasImage === true, 'hasImage');
            expect(reply.imageMimeType === 'image/png', 'the sniffed image mime');
            expect(asRecord(reply.file).name === 'report.md', 'the file name');
            expect(asRecord(reply.file).mimeType === 'text/markdown', 'the file mime');
            expect(asRecord(reply.file).sizeBytes === 128, 'the file size');

            // Server-side only facts never leave the process
            expect(!raw.includes('不应外发的 HTML'), 'no widget HTML');
            expect(!raw.includes(PNG_1PX), 'no image bytes');
            expect(!raw.includes('preview-bytes'), 'no preview card bytes');
            expect(!raw.includes('"preview"'), 'no preview snapshot');
        },
    },
    {
        name: 'the public API answers a conversation share with bubbles',
        body: async () => {
            const rootId = takeMessageId();
            const botId = takeMessageId();
            await saveMessage(GROUP, rootId, ALICE.id, '用户的问题', {
                file: Buffer.from(PNG_1PX, 'base64'),
                fileMime: 'image/png',
            });
            await saveMessage(GROUP, botId, BOT_USER_ID, '', { replyToId: rootId });
            const response = await db.createBotResponse(GROUP, botId, rootId, {
                model: 'offline-model',
                hasImage: false,
            });
            response.setVersions([
                versionOf(1, {
                    text: 'bot 的回答',
                    widget: { mode: 'a2ui', html: '<div>会话卡片</div>', htmlBytes: 20, zlibBytes: 30, caption: '会话说明' },
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
            if (!created.ok) throw new Error(`could not create the share: ${created.reason}`);

            const body = await jsonOf(await app.request(`/api/public/shares/${created.share.token}`));
            const shareView = asRecord(body.share);
            expect(shareView.kind === 'conversation', 'kind conversation');
            expect(shareView.reply === undefined, 'no reply key on a conversation share');
            const conversation = asRecord(shareView.conversation);
            expect(conversation.rootId === rootId, 'rootId');
            const bubbles = Array.isArray(conversation.bubbles) ? conversation.bubbles.map(asRecord) : [];
            expect(bubbles.length === 2, `two bubbles (got ${bubbles.length})`);

            const userBubble = bubbles[0] ?? {};
            expect(userBubble.kind === 'user' && userBubble.messageId === rootId, 'the user bubble');
            expect(userBubble.authorName === 'Alice', 'the display name');
            expect(userBubble.hasImage === true, 'the user image');
            expect(userBubble.widget === null, 'a user bubble has no widget');

            const botBubble = bubbles[1] ?? {};
            expect(botBubble.kind === 'bot' && botBubble.messageId === botId, 'the bot bubble');
            expect(botBubble.text === 'bot 的回答', 'the bot text');
            expect(botBubble.mediaHint === null, 'a bot bubble has no media hint');
            expect(asRecord(botBubble.widget).caption === '会话说明', 'the bot widget caption');
            expect(botBubble.imageMimeType === null && botBubble.file === null, 'no image/file on this bot bubble');
        },
    },
    {
        name: 'unknown, revoked and malformed tokens get the same 404',
        body: async () => {
            const messageId = takeMessageId();
            const share = await replyShare(GROUP, messageId, [versionOf(1, { text: '撤销后不应泄露' })]);
            const revoked = await service.revokeShare(share.token, { userId: ALICE.id, isOwner: false });
            expect(revoked === 'revoked', 'revoked');

            const revokedResponse = await app.request(`/api/public/shares/${share.token}`);
            const unknownResponse = await app.request('/api/public/shares/AAAAAAAAAAAAAAAAAAAAAAAA');
            const malformedResponse = await app.request('/api/public/shares/not-a-token');
            expect(revokedResponse.status === 404, 'revoked 404');
            expect(unknownResponse.status === 404, 'unknown 404');
            expect(malformedResponse.status === 404, 'malformed 404');
            const revokedBody = await revokedResponse.text();
            expect(revokedBody === (await unknownResponse.text()), 'revoked and unknown read the same');
            expect(revokedBody === (await malformedResponse.text()), 'malformed reads the same too');
            expect(!revokedBody.includes('撤销后不应泄露'), 'no content leaks');
            expect(revokedResponse.headers.get('X-Robots-Tag') === 'noindex, nofollow', 'noindex on 404');
            expect(revokedResponse.headers.get('Cache-Control') === 'no-store', 'no-store on 404');
        },
    },
    {
        name: 'SHARE_ENABLED=0 answers the public API with the same 404 JSON',
        body: async () => {
            const messageId = takeMessageId();
            const share = await replyShare(GROUP, messageId, [versionOf(1)]);
            const enabledBody = await (await app.request('/api/public/shares/AAAAAAAAAAAAAAAAAAAAAAAA')).text();
            // No initData here: a 401 would mean the public route sits behind the auth middleware
            const disabled = await disabledApp.request(`/api/public/shares/${share.token}`);
            expect(disabled.status === 404, `404, not 401 (got ${disabled.status})`);
            expect((await disabled.text()) === enabledBody, 'the same 404 body as an unknown token');
        },
    },
    {
        name: 'the public API rate-limits per address',
        body: async () => {
            const messageId = takeMessageId();
            const share = await replyShare(GROUP, messageId, [versionOf(1)]);
            const limited = new Hono<PanelEnv>();
            publicApi.registerPublicShareApiRoutes(limited, {
                enabled: true,
                now: () => clockMs,
                rateLimit: { limit: 2, windowMs: 60_000 },
            });
            const call = (address: string): Promise<Response> =>
                limited.request(`/api/public/shares/${share.token}`, { headers: { 'x-forwarded-for': address } });
            expect((await call('1.2.3.4')).status === 200, 'the first request passes');
            expect((await call('1.2.3.4')).status === 200, 'the second request passes');
            const refused = await call('1.2.3.4');
            expect(refused.status === 429, `the third is refused (got ${refused.status})`);
            expect(refused.headers.get('Retry-After') === '60', 'Retry-After');
            expect((await call('5.6.7.8')).status === 200, 'another address has its own window');
        },
    },
    {
        name: 's<token> is a share start_param that lands on the share',
        body: async () => {
            const messageId = takeMessageId();
            const share = await replyShare(GROUP, messageId, [versionOf(1)]);
            const target = startParam.parseStartParam(`s${share.token}`);
            expect(
                JSON.stringify(target) === JSON.stringify({ kind: 'share', token: share.token }),
                `the share target (got ${JSON.stringify(target)})`
            );
            for (const raw of [
                's',
                `s${'A'.repeat(15)}`,
                `s${'A'.repeat(65)}`,
                'snot a token at all!',
                `S${share.token}`,
                'share',
            ]) {
                expect(startParam.parseStartParam(raw) === null, `"${raw}" is ignored`);
            }
            expect(startParam.parseStartParam('c-1001000000001')?.kind === 'chat', 'chat links still parse');
            expect(startParam.parseStartParam('i7')?.kind === 'issue', 'issue links still parse');
            expect(startParam.parseStartParam('r5_9')?.kind === 'reply', 'reply links still parse');
            const hint = await startParam.resolveHintChatId({ kind: 'share', token: share.token }, async () => null);
            expect(hint === null, 'a share has no chat hint');

            // /api/me: the Mini App learns to open the public share, member or not
            const memberMe = await jsonOf(
                await app.request('/api/me', { headers: { 'X-Init-Data': initDataFor(ALICE, `s${share.token}`) } })
            );
            expect(
                JSON.stringify(memberMe.startTarget) === JSON.stringify({ kind: 'share', token: share.token }),
                `a member's startTarget (got ${JSON.stringify(memberMe.startTarget)})`
            );
            const strangerMe = await jsonOf(
                await app.request('/api/me', { headers: { 'X-Init-Data': initDataFor(BOB, `s${share.token}`) } })
            );
            expect(
                JSON.stringify(strangerMe.startTarget) === JSON.stringify({ kind: 'share', token: share.token }),
                `a stranger's startTarget is the share too (got ${JSON.stringify(strangerMe.startTarget)})`
            );
        },
    },
    {
        name: 'the share page footer opens the share itself in the Mini App',
        body: async () => {
            const messageId = takeMessageId();
            const share = await replyShare(GROUP, messageId, [versionOf(1)]);
            const html = await (await app.request(`/s/${share.token}`)).text();
            expect(
                html.includes(`href="https://t.me/k_on_test_bot/panel?startapp=s${share.token}"`),
                'the reply share footer button'
            );

            const rootId = takeMessageId();
            await saveMessage(GROUP, rootId, ALICE.id, '会话');
            const conversation = await service.createUserShare({
                kind: 'conversation',
                chatId: GROUP,
                rootId,
                createdBy: ALICE.id,
            });
            if (!conversation.ok) throw new Error('could not create the conversation share');
            const conversationHtml = await (await app.request(`/s/${conversation.share.token}`)).text();
            expect(
                conversationHtml.includes(
                    `href="https://t.me/k_on_test_bot/panel?startapp=s${conversation.share.token}"`
                ),
                'the conversation share footer button'
            );

            // Without BOT_USER_NAME there is no Mini App to open: no button at all
            const botUserName = process.env.BOT_USER_NAME;
            delete process.env.BOT_USER_NAME;
            const noBotHtml = await (await app.request(`/s/${share.token}`)).text();
            process.env.BOT_USER_NAME = botUserName;
            expect(!noBotHtml.includes('在 Telegram 打开 Mini App'), 'no button without a bot username');
        },
    },
    {
        name: 'a share token can be recovered from its stored URL',
        body: async () => {
            const messageId = takeMessageId();
            const share = await replyShare(GROUP, messageId, [versionOf(1)]);
            expect(shareUrls.shareTokenOfUrl(share.url) === share.token, 'the absolute URL');
            expect(shareUrls.shareTokenOfUrl(`/s/${share.token}`) === share.token, 'the relative URL');
            expect(shareUrls.shareTokenOfUrl('https://miniapp.test/s/abc') === null, 'a short segment is not a token');
            expect(shareUrls.shareTokenOfUrl('https://miniapp.test/c/-100') === null, 'another path is not a token');
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) results.push(await runCase(testCase.name, testCase.body));
reportResults(results);
