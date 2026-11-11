/**
 * Offline cases for the browser login (design §10): the one-time code store,
 * the session table, and the panel routes that trade one for the other.
 *
 * The membership checker is a fake; everything else is the real code — the
 * migration creates `panel_web_sessions` in the offline database, so the SQL
 * store and the auth middleware are exercised as in production.
 *
 * Run: npx tsx scripts/offline/web-login.mts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrammyError } from 'grammy';
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';

const BOT_TOKEN = '123456789:AAOfflineWebLoginTokenForTests_0123';
const OWNER_ID = 4242;
const ALICE_ID = 5001;
const BOB_ID = 5002;
const GROUP = -1001000000001;

process.env.OWNER_USER_ID = String(OWNER_ID);
process.env.BOT_USER_ID = '9999';
process.env.BOT_USER_NAME = 'k_on_test_bot';
process.env.WEBAPP_PUBLIC_URL = 'https://miniapp.test';
process.env.WEBAPP_BOT_SHORT_NAME = 'panel';
process.env.WIDGET_RENDER_URL = '';
process.env.SHARE_ENABLED = '1';
process.env.WEB_LOGIN = '1';
delete process.env.ALLOWED_CHAT_IDS;

await setupOfflineDb();
const { sequelize } = await import('../../src/db/config.js');
const { createPanelApp } = await import('../../src/panel/app.js');
const codes = await import('../../src/panel/auth/web-login-code.js');
const sessions = await import('../../src/panel/auth/web-session.js');
const runtimeModule = await import('../../src/panel/auth/web-auth-runtime.js');
const { QueryTypes } = await import('@sequelize/core');

type MembershipLookup = import('../../src/panel/access/membership.js').MembershipLookup;
type PanelApp = ReturnType<typeof createPanelApp>;
type WebAuthRuntime = import('../../src/panel/auth/web-auth-runtime.js').WebAuthRuntime;

const scratch = mkdtempSync(join(tmpdir(), 'k-on-bot-web-login-'));
process.once('exit', () => rmSync(scratch, { recursive: true, force: true }));
const STATIC_ROOT = join(scratch, 'dist');
mkdirSync(STATIC_ROOT, { recursive: true });
writeFileSync(join(STATIC_ROOT, 'index.html'), '<!doctype html><title>panel</title>');

const grammyError = (code: number, description: string): GrammyError =>
    new GrammyError(`(${code}: ${description})`, { ok: false, error_code: code, description }, 'getChatMember', {});

const fakeLookup: MembershipLookup = async (chatId, userId) => {
    if (chatId === GROUP && userId === ALICE_ID) return { status: 'member' };
    throw grammyError(400, 'Bad Request: user not found');
};

const makeRuntime = (): WebAuthRuntime => runtimeModule.createWebAuthRuntime();
const makeApp = (webAuth: WebAuthRuntime): PanelApp =>
    createPanelApp({
        botToken: BOT_TOKEN,
        membershipLookup: fakeLookup,
        staticRoot: STATIC_ROOT,
        startedAt: new Date('2026-11-09T00:00:00.000Z'),
        version: 'web1234',
        shareEnabled: true,
        webAuth,
    });

const cookieOf = (response: Response): string | null => {
    const header = response.headers.get('set-cookie');
    if (header === null) return null;
    const pair = header.split(';')[0] ?? '';
    return pair.trim() === '' ? null : pair.trim();
};

const login = async (app: PanelApp, code: string): Promise<Response> =>
    app.request('/api/auth/code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
    });

const results: CaseResult[] = [];

results.push(
    await runCase('a code is single-use, expires, and survives normalization', async () => {
        let clock = 1_000_000;
        const store = codes.createWebLoginCodeStore({ now: () => clock });
        const issued = store.issue(ALICE_ID);
        expect(issued.ok, 'a code is issued');
        if (!issued.ok) return;
        expect(/^[0-9A-HJKMNP-TV-Z]{8}$/.test(issued.code), 'the code is 8 Crockford characters');
        expect(codes.formatWebLoginCode(issued.code).includes('-'), 'the display form is grouped');
        expect(codes.normalizeWebLoginCode(issued.code.toLowerCase()) === issued.code, 'lowercase normalizes back');

        expect(store.redeem(issued.code) === ALICE_ID, 'the right code redeems to its user');
        expect(store.redeem(issued.code) === null, 'the same code does not redeem twice');
        expect(store.size() === 0, 'the spent code is gone');

        clock += 31 * 1000;
        const second = store.issue(ALICE_ID);
        expect(second.ok, 'a second code can be issued after the cooldown');
        if (!second.ok) return;
        clock += 5 * 60 * 1000 + 1;
        expect(store.redeem(second.code) === null, 'a code dies after five minutes');
        expect(store.size() === 0, 'the expired code is swept');
    })
);

results.push(
    await runCase('issuing is rate limited and a new code kills the old one', async () => {
        let clock = 2_000_000;
        const store = codes.createWebLoginCodeStore({ now: () => clock });
        const first = store.issue(BOB_ID);
        expect(first.ok, 'the first code is issued');
        if (!first.ok) return;
        const immediate = store.issue(BOB_ID);
        expect(!immediate.ok, 'a second issue inside the cooldown is refused');
        if (!immediate.ok) expect(immediate.retryAfterSeconds > 0, 'the refusal says how long to wait');

        clock += 31 * 1000;
        const second = store.issue(BOB_ID);
        expect(second.ok, 'a new code can be issued after the cooldown');
        if (!second.ok) return;
        expect(store.redeem(first.code) === null, 'the replaced code no longer works');
        expect(store.redeem(second.code) === BOB_ID, 'the new code works');

        clock += 31 * 1000;
        expect(store.issue(BOB_ID).ok, 'a third issue is still fine');
        clock += 31 * 1000;
        expect(store.issue(BOB_ID).ok, 'a fourth issue is still fine');
        clock += 31 * 1000;
        expect(store.issue(BOB_ID).ok, 'a fifth issue is still fine');
        clock += 31 * 1000;
        expect(!store.issue(BOB_ID).ok, 'the sixth issue inside an hour is refused');
    })
);

results.push(
    await runCase('a session row stores only the token hash and expires', async () => {
        let clock = 3_000_000;
        const store = sessions.createSqlWebSessionStore({ now: () => clock });
        const created = await store.create(BOB_ID, 60_000);
        const rows: unknown[] = await sequelize.query(
            'SELECT tokenHash FROM panel_web_sessions WHERE userId = :userId',
            { replacements: { userId: BOB_ID }, type: QueryTypes.SELECT }
        );
        const hashes = rows.map((row) =>
            typeof row === 'object' && row !== null && 'tokenHash' in row ? String(row.tokenHash) : ''
        );
        expect(hashes.includes(sessions.hashWebSessionToken(created.token)), 'the row holds the hash');
        expect(!hashes.includes(created.token), 'the row never holds the cookie value itself');

        const resolved = await store.resolve(created.token);
        expect(resolved?.userId === BOB_ID, 'the session resolves to its user');
        expect(await store.resolve('nope') === null, 'an unknown token resolves to nothing');

        clock += 60_000 + 1;
        expect(await store.resolve(created.token) === null, 'an expired session resolves to nothing');

        const alive = await store.create(ALICE_ID, 60_000);
        await store.remove(alive.token);
        expect(await store.resolve(alive.token) === null, 'logout removes the session');
    })
);

results.push(
    await runCase('the login page config is public and names the Telegram entries', async () => {
        const app = makeApp(makeRuntime());
        const response = await app.request('/api/public/web-config');
        expect(response.status === 200, 'the config answers without initData');
        const body: unknown = await response.json();
        expect(
            typeof body === 'object' && body !== null && 'webLoginEnabled' in body && body.webLoginEnabled === true,
            'web login is reported enabled'
        );
        expect(
            typeof body === 'object' && body !== null && 'miniAppUrl' in body
                && body.miniAppUrl === 'https://t.me/k_on_test_bot/panel',
            'the Telegram entry is a Mini App link'
        );
    })
);

results.push(
    await runCase('a code becomes a cookie session that authenticates /api/me', async () => {
        const runtime = makeRuntime();
        const app = makeApp(runtime);
        const wrong = await login(app, 'WRONGCOD');
        expect(wrong.status === 404 || wrong.status === 401, 'a wrong code is refused');

        const issued = runtime.codes.issue(ALICE_ID);
        expect(issued.ok, 'a code is issued through the shared runtime');
        if (!issued.ok) return;
        const response = await login(app, codes.formatWebLoginCode(issued.code));
        expect(response.status === 200, 'the right code logs in');
        const setCookie = response.headers.get('set-cookie') ?? '';
        expect(setCookie.includes('kob_web='), 'the session cookie is set');
        expect(setCookie.includes('HttpOnly'), 'the cookie is HttpOnly');
        expect(setCookie.includes('SameSite=Lax'), 'the cookie is SameSite=Lax');
        expect(setCookie.includes('Secure'), 'https deployments get a Secure cookie');

        const cookie = cookieOf(response);
        expect(cookie !== null, 'the cookie pair parses');
        if (cookie === null) return;

        const me = await app.request('/api/me', { headers: { cookie } });
        expect(me.status === 200, 'the cookie authenticates /api/me');
        const body: unknown = await responseBody(me);
        expect(
            typeof body === 'object' && body !== null && 'authenticatedBy' in body && body.authenticatedBy === 'web',
            '/api/me reports the web credential'
        );

        const logout = await app.request('/api/auth/logout', {
            method: 'POST',
            headers: { cookie, origin: 'https://miniapp.test', host: 'miniapp.test' },
        });
        expect(logout.status === 200, 'logout succeeds with the cookie');
        const after = await app.request('/api/me', { headers: { cookie } });
        expect(after.status === 401, 'the removed session no longer authenticates');
    })
);

results.push(
    await runCase('cookie writes need a same-origin request and initData still wins', async () => {
        const runtime = makeRuntime();
        const app = makeApp(runtime);
        const issued = runtime.codes.issue(ALICE_ID);
        if (!issued.ok) throw new Error('code issue failed');
        const response = await login(app, issued.code);
        const cookie = cookieOf(response);
        if (cookie === null) throw new Error('no cookie');

        const crossOrigin = await app.request('/api/auth/logout', {
            method: 'POST',
            headers: { cookie, origin: 'https://evil.example' },
        });
        expect(crossOrigin.status === 403, 'a cross-origin write with the cookie is refused');
        const noHeaders = await app.request('/api/auth/logout', { method: 'POST', headers: { cookie } });
        expect(noHeaders.status === 403, 'a write without any origin is refused');

        const second = runtime.codes.issue(BOB_ID);
        if (!second.ok) throw new Error('code issue failed');
        const secondLogin = await login(app, second.code);
        const secondCookie = cookieOf(secondLogin);
        if (secondCookie === null) throw new Error('no cookie');
        const { signInitData } = await import('../lib/init-data.mts');
        const initData = signInitData({
            botToken: BOT_TOKEN,
            user: { id: OWNER_ID, first_name: 'Owner' },
            authDate: Math.floor(Date.now() / 1000),
        });
        const both = await app.request('/api/me', {
            headers: { cookie: secondCookie, 'x-init-data': initData },
        });
        const body = await responseBody(both);
        expect(
            typeof body === 'object' && body !== null && 'authenticatedBy' in body
                && body.authenticatedBy === 'telegram',
            'a present initData header wins over the cookie'
        );
    })
);

results.push(
    await runCase('WEB_LOGIN=0 leaves only the Telegram entry', async () => {
        process.env.WEB_LOGIN = '0';
        try {
            const runtime = makeRuntime();
            expect(!runtime.enabled, 'the runtime is disabled');
            const app = makeApp(runtime);
            const config: unknown = await (await app.request('/api/public/web-config')).json();
            expect(
                typeof config === 'object' && config !== null && 'webLoginEnabled' in config
                    && config.webLoginEnabled === false,
                'the config says web login is off'
            );
            const response = await login(app, 'ANYCODE1');
            expect(response.status === 404, 'the login route answers the uniform 404');
        } finally {
            process.env.WEB_LOGIN = '1';
        }
    })
);

async function responseBody(response: Response): Promise<unknown> {
    try {
        return await response.json();
    } catch {
        return null;
    }
}

reportResults(results);
