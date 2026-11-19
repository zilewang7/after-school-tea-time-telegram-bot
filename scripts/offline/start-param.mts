/**
 * Offline cases for the `r<chatId>_<firstMessageId>` start_param (design
 * §5.10): its parsing, the chat hint it resolves to, and the reply start
 * target GET /api/me returns — member, none, unavailable, and the fall back to
 * the chat page when the reply is gone. Also the `c<chatId>_<rootId>`
 * conversation start_param (panel conversation deep links): parsing, the chat
 * hint, and the same /api/me matrix with a chat fallback when the root is not a
 * root any more. Also the `t<token>` thinking prefix (design §6.2): token as
 * permission, no chat hint and no membership lookup.
 *
 * Run: npx tsx scripts/offline/start-param.mts
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
const BOB: InitDataUserInput = { id: 5002, first_name: 'Bob' };
const GROUP = -1001000000001;
const GROUP_THROTTLED = -1001000000003;
/** The 24 character base64url token a thinking link carries */
const THINKING_TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWx';

process.env.OWNER_USER_ID = String(OWNER_ID);
process.env.WEBAPP_PUBLIC_URL = 'https://miniapp.test';
process.env.BOT_USER_NAME = 'k_on_test_bot';
process.env.WIDGET_RENDER_URL = '';
delete process.env.ALLOWED_CHAT_IDS;

await setupOfflineDb();
const registry = await import('../../src/db/queries/panel-registry.js');
const db = await import('../../src/db/index.js');
const startParam = await import('../../src/panel/auth/start-param.js');
const { buildStartTarget } = await import('../../src/panel/views/start-target.js');
const { createPanelApp } = await import('../../src/panel/app.js');
const { signInitData } = await import('../lib/init-data.mts');

type MembershipLookup = import('../../src/panel/access/membership.js').MembershipLookup;
type ChatAccessResolver = import('../../src/panel/access/chat-access.js').ChatAccessResolver;
type PanelApp = ReturnType<typeof createPanelApp>;

const scratch = mkdtempSync(join(tmpdir(), 'k-on-bot-start-param-'));
process.once('exit', () => rmSync(scratch, { recursive: true, force: true }));
const STATIC_ROOT = join(scratch, 'dist');
mkdirSync(join(STATIC_ROOT, 'assets'), { recursive: true });
writeFileSync(join(STATIC_ROOT, 'index.html'), '<!doctype html><title>panel</title>');

const grammyError = (code: number, description: string): GrammyError =>
    new GrammyError(`(${code}: ${description})`, { ok: false, error_code: code, description }, 'getChatMember', {});

const memberships = new Map<string, 'member' | 'left' | 'throttled'>([
    [`${GROUP}:${ALICE.id}`, 'member'],
    [`${GROUP}:${BOB.id}`, 'left'],
    [`${GROUP_THROTTLED}:${ALICE.id}`, 'throttled'],
]);
const fakeLookup: MembershipLookup = async (chatId, userId) => {
    const answer = memberships.get(`${chatId}:${userId}`);
    if (answer === 'member') return { status: 'member' };
    if (answer === 'throttled') throw grammyError(429, 'Too Many Requests: retry after 3');
    return { status: 'left' };
};

let clockMs = Date.now();
const makeApp = (): PanelApp =>
    createPanelApp({
        botToken: BOT_TOKEN,
        membershipLookup: fakeLookup,
        staticRoot: STATIC_ROOT,
        startedAt: new Date('2026-11-09T00:00:00.000Z'),
        version: 'abc1234',
        now: () => clockMs,
    });

const initDataFor = (user: InitDataUserInput, startParamValue?: string): string =>
    signInitData({
        botToken: BOT_TOKEN,
        user,
        authDate: Math.floor(clockMs / 1000),
        ...(startParamValue === undefined ? {} : { startParam: startParamValue }),
    });

const call = async (app: PanelApp, path: string, user: InitDataUserInput, startParamValue?: string): Promise<Response> =>
    app.request(path, { headers: { 'X-Init-Data': initDataFor(user, startParamValue) } });

const jsonOf = async (response: Response): Promise<any> => JSON.parse(await response.text());

await registry.upsertChatNow({ id: GROUP, type: 'supergroup', title: 'Main' });
await registry.upsertChatNow({ id: GROUP_THROTTLED, type: 'supergroup', title: 'Throttled' });

/** A stored bot reply in the group */
const storeReply = async (chatId: number, messageId: number): Promise<void> => {
    await db.createBotResponse(chatId, messageId, 400, { model: 'offline-model', hasImage: false });
};

const REPLY_ID = 3101;
const THROTTLED_REPLY_ID = 3102;
await storeReply(GROUP, REPLY_ID);
// The throttled chat also has a stored reply, so only the lookup can fail the target
await storeReply(GROUP_THROTTLED, THROTTLED_REPLY_ID);

/** A stored conversation: the root and a follow-up that replies to it */
const ROOT_ID = 4101;
const CHILD_ID = 4102;
await db.saveMessage({
    chatId: GROUP,
    messageId: ROOT_ID,
    userId: ALICE.id,
    date: new Date(),
    userName: 'Alice',
    message: '会话的根消息',
});
await db.saveMessage({
    chatId: GROUP,
    messageId: CHILD_ID,
    userId: ALICE.id,
    date: new Date(),
    userName: 'Alice',
    message: '同一会话的追问',
    replyToId: ROOT_ID,
});
// The throttled chat also has a stored conversation root, so only the lookup can fail
const THROTTLED_ROOT_ID = 4103;
await db.saveMessage({
    chatId: GROUP_THROTTLED,
    messageId: THROTTLED_ROOT_ID,
    userId: ALICE.id,
    date: new Date(),
    userName: 'Alice',
    message: '被限流聊天的会话根',
});

const app = makeApp();

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'the reply start_param parses negative chat ids',
        body: async () => {
            expect(
                JSON.stringify(startParam.parseStartParam('r-1001000000001_3101')) ===
                    JSON.stringify({ kind: 'reply', chatId: GROUP, firstMessageId: REPLY_ID }),
                'a group reply link'
            );
            expect(
                JSON.stringify(startParam.parseStartParam('r5001_9')) ===
                    JSON.stringify({ kind: 'reply', chatId: 5001, firstMessageId: 9 }),
                'a private chat reply link'
            );
            expect(startParam.parseStartParam('c-1001000000001')?.kind === 'chat', 'chat links still parse');
            expect(startParam.parseStartParam('i7')?.kind === 'issue', 'issue links still parse');
        },
    },
    {
        name: 'malformed reply start_params are ignored',
        body: async () => {
            for (const raw of ['r5_0', 'r0_5', 'r_5', 'r5_', 'r5_5x', 'r5_5_5', 'hello', '', 'r', 'R5_5']) {
                expect(startParam.parseStartParam(raw) === null, `"${raw}" is ignored`);
            }
            expect(startParam.parseStartParam(null) === null, 'null is ignored');
            expect(startParam.parseStartParam('r5_9999999999999999999999') === null, 'an overflowing id is ignored');
        },
    },
    {
        name: 'the hint chat of a reply target is its chat',
        body: async () => {
            const hint = await startParam.resolveHintChatId(
                { kind: 'reply', chatId: GROUP, firstMessageId: REPLY_ID },
                async () => null
            );
            expect(hint === GROUP, 'the reply chat');
        },
    },
    {
        name: 'the conversation start_param parses a chat and a root id',
        body: async () => {
            expect(
                JSON.stringify(startParam.parseStartParam(`c${GROUP}_${ROOT_ID}`)) ===
                    JSON.stringify({ kind: 'conversation', chatId: GROUP, rootId: ROOT_ID }),
                'a group conversation link'
            );
            expect(
                JSON.stringify(startParam.parseStartParam('c5001_9')) ===
                    JSON.stringify({ kind: 'conversation', chatId: 5001, rootId: 9 }),
                'a private chat conversation link'
            );
            expect(
                JSON.stringify(startParam.parseStartParam(`c${GROUP}`)) ===
                    JSON.stringify({ kind: 'chat', chatId: GROUP }),
                'the old chat link still parses as a chat'
            );
        },
    },
    {
        name: 'malformed conversation start_params are ignored',
        body: async () => {
            for (const raw of [
                'c1_',
                'c1_0',
                'c1_x',
                'c0_5',
                'c_5',
                'c1_5_5',
                'c1_-5',
                'C1_5',
                'c1_9999999999999',
                `c${'9'.repeat(20)}_5`,
            ]) {
                expect(startParam.parseStartParam(raw) === null, `"${raw}" is ignored`);
            }
        },
    },
    {
        name: 'the hint chat of a conversation target is its chat',
        body: async () => {
            const hint = await startParam.resolveHintChatId(
                { kind: 'conversation', chatId: GROUP, rootId: ROOT_ID },
                async () => null
            );
            expect(hint === GROUP, 'the conversation chat');
        },
    },
    {
        name: '/api/me lands a member on the conversation',
        body: async () => {
            const body = await jsonOf(await call(app, '/api/me', ALICE, `c${GROUP}_${ROOT_ID}`));
            expect(
                JSON.stringify(body.startTarget) ===
                    JSON.stringify({ kind: 'conversation', chatId: GROUP, rootId: ROOT_ID, access: 'member' }),
                `conversation target (got ${JSON.stringify(body.startTarget)})`
            );
        },
    },
    {
        name: '/api/me returns a conversation target with access none for a non-member',
        body: async () => {
            const body = await jsonOf(await call(app, '/api/me', BOB, `c${GROUP}_${ROOT_ID}`));
            expect(
                JSON.stringify(body.startTarget) ===
                    JSON.stringify({ kind: 'conversation', chatId: GROUP, rootId: ROOT_ID, access: 'none' }),
                `none is returned, not hidden (got ${JSON.stringify(body.startTarget)})`
            );
            expect(!body.chats.some((chat: any) => chat.chatId === GROUP), 'the chat is not listed');
        },
    },
    {
        name: '/api/me falls back to the chat when the conversation link is not a root',
        body: async () => {
            for (const rootId of [CHILD_ID, 999999]) {
                const body = await jsonOf(await call(app, '/api/me', ALICE, `c${GROUP}_${rootId}`));
                expect(
                    JSON.stringify(body.startTarget) ===
                        JSON.stringify({ kind: 'chat', chatId: GROUP, access: 'member' }),
                    `chat fallback for root ${rootId} (got ${JSON.stringify(body.startTarget)})`
                );
            }
        },
    },
    {
        name: '/api/me reports a rate-limited membership lookup on a conversation as unavailable',
        body: async () => {
            const body = await jsonOf(await call(app, '/api/me', ALICE, `c${GROUP_THROTTLED}_${THROTTLED_ROOT_ID}`));
            expect(
                JSON.stringify(body.startTarget) ===
                    JSON.stringify({
                        kind: 'conversation',
                        chatId: GROUP_THROTTLED,
                        rootId: THROTTLED_ROOT_ID,
                        access: 'unavailable',
                    }),
                `unavailable (got ${JSON.stringify(body.startTarget)})`
            );
        },
    },
    {
        name: '/api/me lands a member on the reply',
        body: async () => {
            const body = await jsonOf(await call(app, '/api/me', ALICE, `r${GROUP}_${REPLY_ID}`));
            expect(
                JSON.stringify(body.startTarget) ===
                    JSON.stringify({ kind: 'reply', chatId: GROUP, firstMessageId: REPLY_ID, access: 'member' }),
                `reply target (got ${JSON.stringify(body.startTarget)})`
            );
        },
    },
    {
        name: '/api/me returns a reply target with access none for a non-member',
        body: async () => {
            const body = await jsonOf(await call(app, '/api/me', BOB, `r${GROUP}_${REPLY_ID}`));
            expect(
                JSON.stringify(body.startTarget) ===
                    JSON.stringify({ kind: 'reply', chatId: GROUP, firstMessageId: REPLY_ID, access: 'none' }),
                `none is returned, not hidden (got ${JSON.stringify(body.startTarget)})`
            );
            expect(!body.chats.some((chat: any) => chat.chatId === GROUP), 'the chat is not listed');
        },
    },
    {
        name: '/api/me falls back to the chat when the reply is gone',
        body: async () => {
            const body = await jsonOf(await call(app, '/api/me', ALICE, `r${GROUP}_999999`));
            expect(
                JSON.stringify(body.startTarget) === JSON.stringify({ kind: 'chat', chatId: GROUP, access: 'member' }),
                `chat fallback (got ${JSON.stringify(body.startTarget)})`
            );
        },
    },
    {
        name: '/api/me reports a rate-limited membership lookup as unavailable',
        body: async () => {
            const body = await jsonOf(await call(app, '/api/me', ALICE, `r${GROUP_THROTTLED}_${THROTTLED_REPLY_ID}`));
            expect(
                JSON.stringify(body.startTarget) ===
                    JSON.stringify({
                        kind: 'reply',
                        chatId: GROUP_THROTTLED,
                        firstMessageId: THROTTLED_REPLY_ID,
                        access: 'unavailable',
                    }),
                `unavailable (got ${JSON.stringify(body.startTarget)})`
            );
        },
    },
    {
        name: '/api/me ignores a meaningless start_param',
        body: async () => {
            const body = await jsonOf(await call(app, '/api/me', ALICE, 'hello'));
            expect(body.startTarget === null, 'null target');
        },
    },
    {
        name: 'the thinking start_param parses public CoT tokens',
        body: async () => {
            expect(
                JSON.stringify(startParam.parseStartParam(`t${THINKING_TOKEN}`)) ===
                    JSON.stringify({ kind: 'thinking', token: THINKING_TOKEN }),
                'a 24 character token'
            );
            expect(
                JSON.stringify(startParam.parseStartParam('tabcdefghijklmnop')) ===
                    JSON.stringify({ kind: 'thinking', token: 'abcdefghijklmnop' }),
                'a 16 character token'
            );
            expect(
                JSON.stringify(startParam.parseStartParam('tAbC_d-efGh1234567890')) ===
                    JSON.stringify({ kind: 'thinking', token: 'AbC_d-efGh1234567890' }),
                'base64url punctuation is kept'
            );
            expect(startParam.parseStartParam(`s${THINKING_TOKEN}`)?.kind === 'share', 'share links still parse');
            expect(startParam.parseStartParam(`c${GROUP}`)?.kind === 'chat', 'chat links still parse');
        },
    },
    {
        name: 'malformed thinking start_params are ignored',
        body: async () => {
            const tooShort = `t${'a'.repeat(15)}`;
            const tooLong = `t${'a'.repeat(65)}`;
            for (const raw of [
                't',
                'tabc',
                tooShort,
                tooLong,
                'tAbCdEfGhIjKlMnOp!',
                'TAbCdEfGhIjKlMnOp',
                'tabcdefghijklmnop=',
                'thinking',
            ]) {
                expect(startParam.parseStartParam(raw) === null, `"${raw}" is ignored`);
            }
        },
    },
    {
        name: 'a thinking target carries no chat hint',
        body: async () => {
            const hint = await startParam.resolveHintChatId(
                { kind: 'thinking', token: THINKING_TOKEN },
                async () => null
            );
            expect(hint === null, 'no hint chat');
        },
    },
    {
        name: 'a thinking target resolves without any membership lookup',
        body: async () => {
            const resolver: ChatAccessResolver = {
                user: { id: ALICE.id, firstName: 'Alice', lastName: null, username: null, isOwner: false },
                resolve: async () => {
                    throw new Error('a thinking target must not look up chat access');
                },
            };
            const target = await buildStartTarget({ kind: 'thinking', token: THINKING_TOKEN }, null, resolver);
            expect(
                JSON.stringify(target) === JSON.stringify({ kind: 'thinking', token: THINKING_TOKEN }),
                `thinking view (got ${JSON.stringify(target)})`
            );
        },
    },
    {
        name: '/api/me returns a thinking start target for anyone holding the token',
        body: async () => {
            for (const user of [ALICE, BOB]) {
                const body = await jsonOf(await call(app, '/api/me', user, `t${THINKING_TOKEN}`));
                expect(
                    JSON.stringify(body.startTarget) === JSON.stringify({ kind: 'thinking', token: THINKING_TOKEN }),
                    `${user.first_name} gets the thinking view (got ${JSON.stringify(body.startTarget)})`
                );
            }
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) results.push(await runCase(testCase.name, testCase.body));
reportResults(results);
