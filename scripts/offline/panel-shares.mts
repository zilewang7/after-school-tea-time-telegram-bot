/**
 * Offline cases for the panel's share API (design §5.6): POST/GET/revoke with
 * initData and the chat access gate — member and observer rules, the reuse
 * rule, revocation permissions, error statuses, the reply detail's signed
 * widget URLs, and SHARE_ENABLED=0.
 *
 * Run: npx tsx scripts/offline/panel-shares.mts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';
import type { InitDataUserInput } from '../lib/init-data.mts';

const BOT_TOKEN = '123456789:AAFakeOfflineTokenForPanelTests_0123';
const OWNER_ID = 4242;
const ALICE: InitDataUserInput = { id: 5001, first_name: 'Alice' };
const BOB: InitDataUserInput = { id: 5002, first_name: 'Bob' };
const OWNER: InitDataUserInput = { id: OWNER_ID, first_name: 'Owner' };
const GROUP = -1001000000001;

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
const { createPanelApp } = await import('../../src/panel/app.js');
const { signInitData } = await import('../lib/init-data.mts');

type MembershipLookup = import('../../src/panel/access/membership.js').MembershipLookup;
type PanelApp = ReturnType<typeof createPanelApp>;
type ResponseVersion = import('../../src/db/index.js').ResponseVersion;

const scratch = mkdtempSync(join(tmpdir(), 'k-on-bot-panel-shares-'));
process.once('exit', () => rmSync(scratch, { recursive: true, force: true }));
const STATIC_ROOT = join(scratch, 'dist');
mkdirSync(join(STATIC_ROOT, 'assets'), { recursive: true });
writeFileSync(join(STATIC_ROOT, 'index.html'), '<!doctype html><title>panel</title>');

const memberships = new Map<string, 'member' | 'left'>([
    [`${GROUP}:${ALICE.id}`, 'member'],
    [`${GROUP}:${BOB.id}`, 'left'],
    [`${GROUP}:${OWNER.id}`, 'left'],
]);
const fakeLookup: MembershipLookup = async (chatId, userId) => {
    const answer = memberships.get(`${chatId}:${userId}`);
    return answer === 'member' ? { status: 'member' } : { status: 'left' };
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

const versionOf = (versionId: number, overrides: Partial<ResponseVersion> = {}): ResponseVersion => ({
    versionId,
    createdAt: `2026-11-09T12:0${versionId}:00.000Z`,
    messageIds: [900 + versionId],
    currentMessageId: 900 + versionId,
    text: `第 ${versionId} 版正文`,
    wasStoppedByUser: false,
    ...overrides,
});

const makeReply = async (
    messageId: number,
    versions: ResponseVersion[],
    currentVersionIndex = 0,
    userMessageId = 400
): Promise<void> => {
    const response = await db.createBotResponse(GROUP, messageId, userMessageId, {
        model: 'offline-model',
        hasImage: false,
    });
    response.setVersions(versions);
    response.currentVersionIndex = currentVersionIndex;
    await response.save();
};

const saveUserMessage = async (messageId: number, text: string): Promise<void> => {
    await db.saveMessage({
        chatId: GROUP,
        messageId,
        userId: ALICE.id,
        date: new Date('2026-11-09T12:00:00.000Z'),
        userName: 'Alice',
        message: text,
    });
};

await registry.upsertChatNow({ id: GROUP, type: 'supergroup', title: '主群' });

let nextMessageId = 7000;
const takeMessageId = (): number => (nextMessageId += 1);

const app = makeApp(true);
const disabledApp = makeApp(false);

const initDataFor = (user: InitDataUserInput): string =>
    signInitData({ botToken: BOT_TOKEN, user, authDate: Math.floor(clockMs / 1000) });

interface ApiOptions {
    method?: string;
    body?: unknown;
    user?: InitDataUserInput;
}

const call = async (target: PanelApp, path: string, options: ApiOptions = {}): Promise<Response> => {
    const headers = new Headers({ 'X-Init-Data': initDataFor(options.user ?? ALICE) });
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    return target.request(path, { method: options.method ?? 'GET', headers, ...(body === undefined ? {} : { body }) });
};

const jsonOf = async (response: Response): Promise<any> => JSON.parse(await response.text());

const errorCodeOf = async (response: Response): Promise<string> => (await jsonOf(response))?.error?.code ?? '-';

const expectError = async (response: Response, status: number, code: string, label: string): Promise<void> => {
    const actual = await errorCodeOf(response);
    expect(
        response.status === status && actual === code,
        `${label} → ${status} ${code} (got ${response.status} ${actual})`
    );
};

const shareOf = async (response: Response): Promise<any> => (await jsonOf(response)).share;

const createShare = (target: PanelApp, body: unknown, user: InitDataUserInput = ALICE): Promise<Response> =>
    call(target, '/api/shares', { method: 'POST', body, user });

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'a member creates a reply share',
        body: async () => {
            const messageId = takeMessageId();
            await makeReply(messageId, [versionOf(1), versionOf(2)]);
            const response = await createShare(app, { kind: 'reply', chatId: GROUP, firstMessageId: messageId });
            expect(response.status === 200, `200 (got ${response.status})`);
            const share = await shareOf(response);
            expect(typeof share.token === 'string' && share.token.length === 24, 'token');
            expect(share.url === `https://miniapp.test/s/${share.token}`, 'absolute url');
            expect(share.kind === 'reply' && share.chatId === GROUP && share.firstMessageId === messageId, 'target');
            expect(share.versionId === 1, 'the current version is pinned by default');
            expect(share.createdBy === ALICE.id && share.source === 'user', 'creator and source');
            expect(share.canRevoke === true, 'the creator may revoke');
            expect(share.previewWidth === null, 'no preview card without a renderer');
        },
    },
    {
        name: 'creating the same target twice returns the same link',
        body: async () => {
            const messageId = takeMessageId();
            await makeReply(messageId, [versionOf(1)]);
            const first = await shareOf(await createShare(app, { kind: 'reply', chatId: GROUP, firstMessageId: messageId }));
            const second = await shareOf(await createShare(app, { kind: 'reply', chatId: GROUP, firstMessageId: messageId }));
            expect(first.token === second.token, 'one link per target');
        },
    },
    {
        name: 'GET reports the active link and revoke clears it',
        body: async () => {
            const messageId = takeMessageId();
            await makeReply(messageId, [versionOf(1)]);
            const created = await shareOf(await createShare(app, { kind: 'reply', chatId: GROUP, firstMessageId: messageId }));
            const query = `/api/shares?kind=reply&chatId=${GROUP}&firstMessageId=${messageId}`;
            const status = await shareOf(await call(app, query));
            expect(status?.token === created.token && status.canRevoke === true, 'the active link');

            const revoked = await call(app, `/api/shares/${created.token}/revoke`, { method: 'POST' });
            expect(revoked.status === 200 && (await jsonOf(revoked)).ok === true, 'revoked');
            expect(await shareOf(await call(app, query)) === null, 'no active link after revoking');
            expect(
                (await call(app, `/api/shares/${created.token}/revoke`, { method: 'POST' })).status === 404,
                'revoking again is 404'
            );
        },
    },
    {
        name: 'only the creator or the owner revokes',
        body: async () => {
            const messageId = takeMessageId();
            await makeReply(messageId, [versionOf(1)]);
            const created = await shareOf(await createShare(app, { kind: 'reply', chatId: GROUP, firstMessageId: messageId }));
            await expectError(
                await call(app, `/api/shares/${created.token}/revoke`, { method: 'POST', user: BOB }),
                403,
                'forbidden',
                'a member who did not create it'
            );
            const byOwner = await call(app, `/api/shares/${created.token}/revoke`, { method: 'POST', user: OWNER });
            expect(byOwner.status === 200, 'the owner revokes');
        },
    },
    {
        name: 'an observer may share one reply but not a conversation',
        body: async () => {
            const messageId = takeMessageId();
            await makeReply(messageId, [versionOf(1)]);
            const replyShare = await createShare(
                app,
                { kind: 'reply', chatId: GROUP, firstMessageId: messageId },
                OWNER
            );
            expect(replyShare.status === 200, 'a reply share is allowed');
            await saveUserMessage(messageId, '一段对话');
            const conversation = await createShare(app, { kind: 'conversation', chatId: GROUP, rootId: messageId }, OWNER);
            const conversationBody = await jsonOf(conversation);
            expect(
                conversation.status === 403 && conversationBody.error?.code === 'forbidden',
                'a conversation share is not allowed'
            );
            expect(conversationBody.error.message === '观察者只能分享单条回复', 'the reason is stated');
        },
    },
    {
        name: 'a non-member cannot share anything',
        body: async () => {
            const messageId = takeMessageId();
            await makeReply(messageId, [versionOf(1)]);
            await expectError(
                await createShare(app, { kind: 'reply', chatId: GROUP, firstMessageId: messageId }, BOB),
                403,
                'forbidden',
                'not a member'
            );
        },
    },
    {
        name: 'invalid bodies are 400',
        body: async () => {
            const messageId = takeMessageId();
            await makeReply(messageId, [versionOf(1)]);
            await expectError(await createShare(app, { kind: 'other', chatId: GROUP }), 400, 'invalid', 'bad kind');
            await expectError(await createShare(app, { kind: 'reply' }), 400, 'invalid', 'missing chatId');
            await expectError(
                await createShare(app, { kind: 'reply', chatId: String(GROUP) }),
                400,
                'invalid',
                'chatId as a string'
            );
            await expectError(
                await createShare(app, { kind: 'reply', chatId: GROUP }),
                400,
                'invalid',
                'missing firstMessageId'
            );
            await expectError(
                await createShare(app, { kind: 'reply', chatId: GROUP, firstMessageId: messageId, extra: true }),
                400,
                'invalid',
                'an unknown body key'
            );
            await expectError(
                await call(app, `/api/shares?kind=other&chatId=${GROUP}`),
                400,
                'invalid',
                'a bad kind in the query'
            );
        },
    },
    {
        name: 'unknown targets are 404',
        body: async () => {
            await expectError(
                await createShare(app, { kind: 'reply', chatId: GROUP, firstMessageId: 989898 }),
                404,
                'not_found',
                'an unknown reply'
            );
            await expectError(
                await createShare(app, { kind: 'conversation', chatId: GROUP, rootId: 989898 }),
                404,
                'not_found',
                'an unknown conversation'
            );
        },
    },
    {
        name: 'a conversation share names its root and is members only',
        body: async () => {
            const rootId = takeMessageId();
            await saveUserMessage(rootId, '开始');
            const response = await createShare(app, { kind: 'conversation', chatId: GROUP, rootId });
            expect(response.status === 200, '200');
            const share = await shareOf(response);
            expect(share.kind === 'conversation' && share.rootId === rootId, 'the root');
            expect(share.firstMessageId === null && share.versionId === null, 'no reply fields');
        },
    },
    {
        name: 'the reply detail carries signed widget URLs and the share status',
        body: async () => {
            const messageId = takeMessageId();
            await makeReply(messageId, [
                versionOf(1, {
                    widget: {
                        mode: 'a2ui',
                        html: '<div>卡片</div>',
                        htmlBytes: 16,
                        zlibBytes: 24,
                        imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
                    },
                }),
            ]);
            const created = await shareOf(await createShare(app, { kind: 'reply', chatId: GROUP, firstMessageId: messageId }));
            const detail = await jsonOf(await call(app, `/api/chats/${GROUP}/replies/${messageId}`));
            const version = detail.versions[0];
            expect(version.widget?.mode === 'a2ui', 'widget mode');
            expect(version.widget?.deliveredAs === 'widget', 'deliveredAs defaults to widget');
            expect(typeof version.widget?.viewUrl === 'string' && version.widget.viewUrl.startsWith('/w/'), 'viewUrl');
            expect(typeof version.widget?.imageUrl === 'string' && version.widget.imageUrl.startsWith('/w/'), 'imageUrl');
            expect(version.widget?.shareUrl === created.url, 'the active share URL');
            expect(typeof version.widget?.expiresAt === 'string', 'expiry');
            const attachment = version.attachments.find((item: any) => item.kind === 'widget');
            expect(attachment?.deliveredAs === 'widget' && attachment?.hasImage === true, 'attachment extras');
            expect(
                (await app.request(version.widget.viewUrl)).status === 200,
                'the signed viewUrl serves the document'
            );
            expect((await app.request(version.widget.imageUrl)).status === 200, 'the signed imageUrl serves the PNG');

            const observerDetail = await jsonOf(
                await call(app, `/api/chats/${GROUP}/replies/${messageId}`, { user: OWNER })
            );
            expect(typeof observerDetail.versions[0].widget?.viewUrl === 'string', 'observers get the URLs too');
        },
    },
    {
        name: 'GET without a version uses the current version',
        body: async () => {
            const messageId = takeMessageId();
            await makeReply(messageId, [versionOf(1), versionOf(2)], 1);
            const current = await shareOf(await createShare(app, { kind: 'reply', chatId: GROUP, firstMessageId: messageId }));
            expect(current.versionId === 2, 'the current version');
            const queried = await shareOf(
                await call(app, `/api/shares?kind=reply&chatId=${GROUP}&firstMessageId=${messageId}`)
            );
            expect(queried?.token === current.token, 'GET resolves the same version');
            const pinned = await shareOf(
                await call(app, `/api/shares?kind=reply&chatId=${GROUP}&firstMessageId=${messageId}&versionId=1`)
            );
            expect(pinned === null, 'the older version has no link');
        },
    },
    {
        name: 'SHARE_ENABLED=0 turns the share API off',
        body: async () => {
            const messageId = takeMessageId();
            await makeReply(messageId, [versionOf(1)]);
            await expectError(
                await createShare(disabledApp, { kind: 'reply', chatId: GROUP, firstMessageId: messageId }),
                404,
                'not_found',
                'POST'
            );
            await expectError(
                await call(disabledApp, `/api/shares?kind=reply&chatId=${GROUP}&firstMessageId=${messageId}`),
                404,
                'not_found',
                'GET'
            );
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) results.push(await runCase(testCase.name, testCase.body));
reportResults(results);
