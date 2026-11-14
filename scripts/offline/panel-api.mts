/**
 * Offline cases for the panel's HTTP layer, driven through hono's
 * `app.request()` with self-signed initData, a fake getChatMember and the
 * scratch database: auth and its age windows, the PATCH settings matrix, the
 * global default, the preview, rate limiting, /api/me, the dashboard, audit,
 * the error envelope, request logs, and the static fallback order. Then the
 * Priority PayGo switch (design §8.5): per chat (owner only, refused where it
 * cannot take effect) and global (a partial update, all keys or none).
 *
 * Run: npx tsx scripts/offline/panel-api.mts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrammyError } from 'grammy';
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';
import { signInitData, type InitDataUserInput } from '../lib/init-data.mts';

const BOT_TOKEN = '123456789:AAFakeOfflineTokenForPanelTests_0123';
const OWNER_ID = 4242;
const ALICE: InitDataUserInput = { id: 5001, first_name: 'Alice', last_name: 'Liddell', username: 'alice' };
const BOB: InitDataUserInput = { id: 5002, first_name: 'Bob' };
const OWNER: InitDataUserInput = { id: OWNER_ID, first_name: 'Owner' };

const GROUP_MAIN = -1001000000001;
const GROUP_LEFT = -1001000000002;
const GROUP_THROTTLED = -1001000000003;
const GROUP_TOOLS = -1001000000004;
/** In TOOL_CHAT_IDS: Priority PayGo may be switched on here with the global switch off */
const GROUP_PRIORITY_LISTED = -1001000000005;
/** Not in TOOL_CHAT_IDS: "on" only takes effect while the global switch is on */
const GROUP_PRIORITY_UNLISTED = -1001000000006;

process.env.OWNER_USER_ID = String(OWNER_ID);
// Read once into the tool config, before src is imported
process.env.TOOL_CHAT_IDS = String(GROUP_PRIORITY_LISTED);
process.env.DEFAULT_MODEL = 'env-default-model';
delete process.env.ALLOWED_CHAT_IDS;

await setupOfflineDb();
const registry = await import('../../src/db/queries/panel-registry.js');
const { HarnessIssue } = await import('../../src/db/harnessIssueDTO.js');
const { SettingsAudit } = await import('../../src/db/settingsAuditDTO.js');
const { GlobalSetting } = await import('../../src/db/globalSettingDTO.js');
const { loadChatSettingsCache } = await import('../../src/services/chat-settings-service.js');
const { loadModelCatalog } = await import('../../src/services/model-catalog-service.js');
const { findModelCatalogEntry, setModelCatalog } = await import('../../src/config/model-catalog.js');
const { ModelCatalogEntryRow } = await import('../../src/db/modelCatalogDTO.js');
const { modelConfigs } = await import('../../src/config/models.js');
const { createPanelApp } = await import('../../src/panel/app.js');
const { INDEX_CONTENT_SECURITY_POLICY } = await import('../../src/panel/static.js');

type MembershipLookup = import('../../src/panel/access/membership.js').MembershipLookup;
type PanelApp = ReturnType<typeof createPanelApp>;

// ---- fixtures -------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), 'k-on-bot-panel-static-'));
process.once('exit', () => rmSync(scratch, { recursive: true, force: true }));
const STATIC_ROOT = join(scratch, 'dist');
const INDEX_HTML = '<!doctype html><title>panel</title><div id="root"></div>';
mkdirSync(join(STATIC_ROOT, 'assets'), { recursive: true });
writeFileSync(join(STATIC_ROOT, 'index.html'), INDEX_HTML);
writeFileSync(join(STATIC_ROOT, 'assets', 'app-1a2b3c.js'), 'console.log("panel");');
writeFileSync(join(STATIC_ROOT, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
writeFileSync(join(scratch, 'secret.txt'), 'outside the static root');

const grammyError = (code: number, description: string): GrammyError =>
    new GrammyError(`(${code}: ${description})`, { ok: false, error_code: code, description }, 'getChatMember', {});

/** chatId:userId → answer; anything unlisted is "user not found" */
const memberships = new Map<string, 'member' | 'left' | 'throttled' | 'slow'>([
    [`${GROUP_MAIN}:${ALICE.id}`, 'member'],
    [`${GROUP_MAIN}:${BOB.id}`, 'left'],
    [`${GROUP_TOOLS}:${ALICE.id}`, 'member'],
    [`${GROUP_PRIORITY_LISTED}:${ALICE.id}`, 'member'],
    [`${GROUP_PRIORITY_UNLISTED}:${ALICE.id}`, 'member'],
    [`${GROUP_LEFT}:${ALICE.id}`, 'left'],
    [`${GROUP_THROTTLED}:${ALICE.id}`, 'throttled'],
    [`${GROUP_LEFT}:${BOB.id}`, 'slow'],
]);
const fakeLookup: MembershipLookup = async (chatId, userId) => {
    const answer = memberships.get(`${chatId}:${userId}`);
    if (answer === 'member') return { status: 'member' };
    if (answer === 'slow') {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { status: 'member' };
    }
    if (answer === 'left') return { status: 'left' };
    if (answer === 'throttled') throw grammyError(429, 'Too Many Requests: retry after 3');
    throw grammyError(400, 'Bad Request: user not found');
};

let clockMs = Date.now();
const nowSeconds = (): number => Math.floor(clockMs / 1000);

const makeApp = (staticRoot = STATIC_ROOT, handlerTimeoutMs?: number): PanelApp =>
    createPanelApp({
        botToken: BOT_TOKEN,
        membershipLookup: fakeLookup,
        staticRoot,
        startedAt: new Date('2026-11-07T00:00:00.000Z'),
        version: 'abc1234',
        now: () => clockMs,
        ...(handlerTimeoutMs !== undefined ? { handlerTimeoutMs } : {}),
    });

await registry.upsertChatNow({ id: GROUP_MAIN, type: 'supergroup', title: 'Main', username: 'main_group' });
await registry.upsertChatNow({ id: GROUP_LEFT, type: 'supergroup', title: 'Left' });
await registry.upsertChatNow({ id: GROUP_THROTTLED, type: 'supergroup', title: 'Throttled' });
await registry.upsertChatNow({ id: GROUP_TOOLS, type: 'supergroup', title: 'Tools' });
await registry.upsertChatNow({ id: GROUP_PRIORITY_LISTED, type: 'supergroup', title: 'Priority listed' });
await registry.upsertChatNow({ id: GROUP_PRIORITY_UNLISTED, type: 'supergroup', title: 'Priority unlisted' });
await loadChatSettingsCache();

// ---- request helpers --------------------------------------------------------

interface CallOptions {
    method?: string;
    user?: InitDataUserInput;
    /** Seconds before now the initData was issued */
    age?: number;
    startParam?: string;
    initData?: string | null;
    body?: unknown;
    rawBody?: string;
}

const initDataFor = (user: InitDataUserInput, age = 0, startParam?: string): string =>
    signInitData({
        botToken: BOT_TOKEN,
        user,
        authDate: nowSeconds() - age,
        ...(startParam !== undefined ? { startParam } : {}),
    });

const call = (app: PanelApp, path: string, options: CallOptions = {}): Promise<Response> => {
    const headers = new Headers();
    const initData =
        options.initData !== undefined
            ? options.initData
            : options.user !== undefined
              ? initDataFor(options.user, options.age, options.startParam)
              : null;
    if (initData !== null) headers.set('X-Init-Data', initData);
    let body: string | undefined;
    if (options.rawBody !== undefined) body = options.rawBody;
    else if (options.body !== undefined) body = JSON.stringify(options.body);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    return Promise.resolve(app.request(path, { method: options.method ?? 'GET', headers, body }));
};

/** A request whose body is a stream and carries no content-length, like a chunked upload or a real body-less DELETE */
const streamRequest = (
    path: string,
    options: { method: string; user: InitDataUserInput; body: string | null }
): Request => {
    const headers = new Headers({ 'X-Init-Data': initDataFor(options.user), 'Content-Type': 'application/json' });
    const text = options.body;
    const body =
        text === null
            ? new ReadableStream<Uint8Array>({ start: (controller) => controller.close() })
            : new ReadableStream<Uint8Array>({
                  start: (controller) => {
                      controller.enqueue(new TextEncoder().encode(text));
                      controller.close();
                  },
              });
    return new Request(`http://localhost${path}`, { method: options.method, headers, body, duplex: 'half' } as RequestInit);
};

/** The response body as JSON, or a marker when it is not JSON */
const jsonOf = async (response: Response): Promise<any> => {
    const text = await response.text();
    try {
        return JSON.parse(text);
    } catch {
        return { notJson: text };
    }
};

const errorCodeOf = async (response: Response): Promise<string> => (await jsonOf(response))?.error?.code ?? '-';

const expectError = async (response: Response, status: number, code: string, label: string): Promise<void> => {
    const actual = await errorCodeOf(response);
    expect(response.status === status && actual === code, `${label} → ${status} ${code} (got ${response.status} ${actual})`);
};

const patchSettings = (app: PanelApp, chatId: number, user: InitDataUserInput, body: unknown) =>
    call(app, `/api/chats/${chatId}/settings`, { method: 'PATCH', user, body });

const auditCount = (chatId: number): Promise<number> => SettingsAudit.count({ where: { scope: `chat:${chatId}` } });
const globalAuditCount = (): Promise<number> => SettingsAudit.count({ where: { scope: 'global' } });

const patchGlobal = (user: InitDataUserInput, body: unknown) => call(app, '/api/global', { method: 'PATCH', user, body });

/** The dashboard's three Priority PayGo facts and the chat's own value */
const priorityFactsOf = async (chatId: number) => {
    const body = await jsonOf(await call(app, `/api/chats/${chatId}`, { user: ALICE }));
    return {
        own: body.settings?.geminiPriority,
        effective: body.effectiveGeminiPriority,
        global: body.globalGeminiPriority,
        canEnable: body.geminiPriorityCanEnable,
    };
};

const PRIORITY_NOT_ALLOWED = '全局关闭时，只有工具白名单里的会话可以单独开启';

/** Collect console.log / console.error lines while `body` runs */
const captureLogs = async (body: () => Promise<void>): Promise<string[]> => {
    const lines: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...parts: unknown[]) => lines.push(parts.map(String).join(' '));
    console.error = (...parts: unknown[]) => lines.push(parts.map(String).join(' '));
    try {
        await body();
    } finally {
        console.log = originalLog;
        console.error = originalError;
    }
    return lines;
};

const app = makeApp();

// ---- cases ----------------------------------------------------------------

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'health needs no auth and touches nothing',
        body: async () => {
            const response = await call(app, '/api/health');
            const body = await jsonOf(response);
            expect(response.status === 200, '200');
            expect(
                body.ok === true &&
                    body.startedAt === '2026-11-07T00:00:00.000Z' &&
                    body.version === 'abc1234' &&
                    body.settingsLoaded === true,
                `shape (got ${JSON.stringify(body)})`
            );
            expect(response.headers.get('X-Content-Type-Options') === 'nosniff', 'nosniff');
            expect(response.headers.get('Referrer-Policy') === 'no-referrer', 'no-referrer');
            expect(response.headers.get('Cache-Control') === 'no-store', '/api is never cached');
            expect(response.headers.get('X-Frame-Options') === null, 'no X-Frame-Options');
        },
    },
    {
        name: 'missing, bad or URL-borne initData is 401, logged by reason only',
        body: async () => {
            const forged = initDataFor(ALICE).replace(/hash=[0-9a-f]+/, `hash=${'0'.repeat(64)}`);
            let responses: Response[] = [];
            const lines = await captureLogs(async () => {
                responses = [
                    await call(app, '/api/me'),
                    await call(app, '/api/me', { initData: forged }),
                    await call(app, `/api/me?initData=${encodeURIComponent(initDataFor(ALICE))}`),
                    await call(app, '/api/me', { user: ALICE, age: 24 * 3600 + 1 }),
                    await call(app, '/api/me', { user: ALICE, age: -301 }),
                ];
            });
            const [missing, badHash, inUrl, expired, future] = responses;
            for (const [label, response] of [
                ['no header', missing],
                ['bad hash', badHash],
                ['initData in the URL is ignored', inUrl],
                ['older than 24h', expired],
                ['from the future', future],
            ] as const) {
                if (response === undefined) throw new Error(`no response for ${label}`);
                await expectError(response, 401, 'unauthorized', label);
            }
            expect(missing?.headers.get('Cache-Control') === 'no-store', 'error responses are not cached either');
            expect(lines.includes('[panel] auth rejected: missing'), 'reason missing logged');
            expect(lines.includes('[panel] auth rejected: bad_hash'), 'reason bad_hash logged');
            expect(lines.includes('[panel] auth rejected: expired'), 'reason expired logged');
            expect(lines.includes('[panel] auth rejected: future'), 'reason future logged');
            expect(
                lines.some((line) => /^\[panel\] GET \/api\/me 401 \d+ms u=-$/.test(line)),
                'the request line names the route template, no user'
            );
            expect(lines.every((line) => !line.includes('hash=') && !line.includes('auth_date')), 'no initData in any log line');
        },
    },
    {
        name: 'writes need initData from the last 5 minutes; reads and the preview 24 hours',
        body: async () => {
            const stale = { user: ALICE, age: 301 };
            await expectError(
                await call(app, `/api/chats/${GROUP_MAIN}/settings`, { ...stale, method: 'PATCH', body: { paused: false } }),
                401,
                'unauthorized',
                'PATCH with 301s-old initData'
            );
            const fresh = await call(app, `/api/chats/${GROUP_MAIN}/settings`, {
                user: ALICE,
                age: 300,
                method: 'PATCH',
                body: { paused: false },
            });
            expect(fresh.status === 200, `PATCH with 300s-old initData passes (got ${fresh.status})`);
            const read = await call(app, `/api/chats/${GROUP_MAIN}`, { user: ALICE, age: 3600 });
            expect(read.status === 200, `GET with hour-old initData passes (got ${read.status})`);
            const preview = await call(app, `/api/chats/${GROUP_MAIN}/settings/preview`, {
                user: ALICE,
                age: 3600,
                method: 'POST',
                body: { promptAddendum: 'hi' },
            });
            expect(preview.status === 200, `the preview keeps the read window (got ${preview.status})`);
            await expectError(
                await call(app, '/api/global', { user: OWNER, age: 301, method: 'PATCH', body: { defaultModel: null } }),
                401,
                'unauthorized',
                'PATCH /api/global with stale initData'
            );
        },
    },
    {
        name: 'PATCH settings: shape and value checks are 400, a free model id is accepted',
        body: async () => {
            const before = await auditCount(GROUP_MAIN);
            const invalidBodies: [string, unknown][] = [
                ['empty model', { model: '' }],
                ['blank model', { model: '   ' }],
                ['model over 64 characters', { model: 'm'.repeat(65) }],
                ['a Gemini image model', { model: 'gemini-nano-banana-2.1' }],
                ['an OpenAI image model', { model: 'gpt-image-2.5-dev' }],
                ['model of the wrong type', { model: 42 }],
                ['unknown key', { colour: 'red' }],
                ['unknown key next to a known one', { model: 'gpt-x', colour: 'red' }],
                ['no known key', {}],
                ['only expectedUpdatedAt', { expectedUpdatedAt: new Date().toISOString() }],
                ['bad expectedUpdatedAt', { paused: true, expectedUpdatedAt: 'yesterday' }],
                ['addendum over 2000 code points', { promptAddendum: '😀'.repeat(2001) }],
                ['addendum of the wrong type', { promptAddendum: ['a'] }],
                ['paused as a string', { paused: 'true' }],
                ['an unknown tool group', { toolOverrides: { nonsense: true } }],
                ['a tool switch of the wrong type', { toolOverrides: { sticker: 'yes' } }],
                ['tool switches as an array', { toolOverrides: [] }],
                ['an unknown thinking level', { thinkingEffort: 'turbo' }],
                ['a thinking level of the wrong type', { thinkingEffort: 42 }],
                ['a thinking level as an array', { thinkingEffort: ['high'] }],
            ];
            for (const [label, body] of invalidBodies) {
                await expectError(await patchSettings(app, GROUP_MAIN, ALICE, body), 400, 'invalid', label);
            }
            for (const [label, rawBody] of [['not JSON', '{model'], ['a JSON array', '[]'], ['JSON null', 'null']] as const) {
                await expectError(
                    await call(app, `/api/chats/${GROUP_MAIN}/settings`, { method: 'PATCH', user: ALICE, rawBody }),
                    400,
                    'invalid',
                    label
                );
            }
            expect((await auditCount(GROUP_MAIN)) === before, 'nothing was written');
            const imageRefusal = await jsonOf(await patchSettings(app, GROUP_MAIN, ALICE, { model: 'gemini-nano-banana-2.1' }));
            expect(
                imageRefusal.error?.message === '生图模型不能设为对话模型。要画图直接让 bot 画，或用 /picbanana、/picgpt。',
                `an image model is refused with its own message (got ${JSON.stringify(imageRefusal)})`
            );

            const accepted = await patchSettings(app, GROUP_MAIN, ALICE, { model: '  my-own-model-v9  ' });
            const body = await jsonOf(accepted);
            expect(accepted.status === 200 && body.settings.model === 'my-own-model-v9', 'a model id outside the menu is stored trimmed');
            const emoji = await patchSettings(app, GROUP_MAIN, ALICE, { promptAddendum: '😀'.repeat(2000) });
            expect(emoji.status === 200, '2000 emoji are 2000 code points: accepted');
            expect((await auditCount(GROUP_MAIN)) === before + 2, 'two audit rows');
        },
    },
    {
        name: 'PATCH settings: unchanged values write nothing, a stale expectedUpdatedAt is 409',
        body: async () => {
            const dashboard = await jsonOf(await call(app, `/api/chats/${GROUP_MAIN}`, { user: ALICE }));
            const seenAt: string = dashboard.settings.updatedAt;
            const before = await auditCount(GROUP_MAIN);

            const same = await patchSettings(app, GROUP_MAIN, ALICE, { model: 'my-own-model-v9', expectedUpdatedAt: seenAt });
            const sameBody = await jsonOf(same);
            expect(same.status === 200 && sameBody.settings.updatedAt === seenAt, 'same value: 200, updatedAt kept');
            expect((await auditCount(GROUP_MAIN)) === before, 'and no audit row');

            const changed = await patchSettings(app, GROUP_MAIN, ALICE, { paused: true, expectedUpdatedAt: seenAt });
            expect(changed.status === 200, 'a matching expectedUpdatedAt passes');
            await expectError(
                await patchSettings(app, GROUP_MAIN, ALICE, { paused: false, expectedUpdatedAt: seenAt }),
                409,
                'conflict',
                'the old timestamp again'
            );
            expect((await auditCount(GROUP_MAIN)) === before + 1, 'only the accepted change was audited');
        },
    },
    {
        name: 'PATCH settings: owner-only lock, and a locked chat refuses members before value checks',
        body: async () => {
            await expectError(
                await patchSettings(app, GROUP_MAIN, ALICE, { settingsLocked: true }),
                403,
                'forbidden',
                'a member touching the lock'
            );
            await expectError(
                await patchSettings(app, GROUP_MAIN, ALICE, { model: 'x', settingsLocked: false }),
                403,
                'forbidden',
                'even with other keys'
            );
            const locked = await patchSettings(app, GROUP_MAIN, OWNER, { settingsLocked: true });
            expect(locked.status === 200 && (await jsonOf(locked)).settings.settingsLocked === true, 'the owner (an observer here) locks');
            await expectError(await patchSettings(app, GROUP_MAIN, ALICE, { model: 42 }), 403, 'locked', 'a bad value on a locked chat');
            await expectError(await patchSettings(app, GROUP_MAIN, ALICE, { paused: false }), 403, 'locked', 'a good value on a locked chat');
            const ownerChange = await patchSettings(app, GROUP_MAIN, OWNER, { paused: false });
            expect(ownerChange.status === 200, 'the owner is not bound by the lock');
            const unlocked = await patchSettings(app, GROUP_MAIN, OWNER, { settingsLocked: false });
            expect(unlocked.status === 200, 'and unlocks');
        },
    },
    {
        name: 'single-chat endpoints: 403 for non-members, 503 when membership cannot be known, 400 for a bad id',
        body: async () => {
            await expectError(await call(app, `/api/chats/${GROUP_MAIN}`, { user: BOB }), 403, 'forbidden', 'Bob left the group');
            await expectError(await patchSettings(app, GROUP_MAIN, BOB, { paused: true }), 403, 'forbidden', 'and cannot patch it');
            await expectError(await call(app, '/api/chats/-1009999999999', { user: ALICE }), 403, 'forbidden', 'an unknown chat looks the same');
            await expectError(await call(app, `/api/chats/${GROUP_LEFT}`, { user: ALICE }), 403, 'forbidden', 'a group Alice left');
            await expectError(await call(app, `/api/chats/${GROUP_THROTTLED}`, { user: ALICE }), 503, 'internal', 'a rate-limited lookup');
            await expectError(await call(app, '/api/chats/abc', { user: ALICE }), 400, 'invalid', 'a non-numeric chat id');
            await expectError(await patchSettings(app, ALICE.id + 1, ALICE, { paused: true }), 403, 'forbidden', "someone else's private chat");
        },
    },
    {
        name: 'the dashboard: settings, tool matrix, no summary yet, recent audit with names',
        body: async () => {
            const response = await call(app, `/api/chats/${GROUP_MAIN}`, { user: ALICE });
            const body = await jsonOf(response);
            expect(response.status === 200, '200');
            expect(
                JSON.stringify(body.chat) ===
                    JSON.stringify({ chatId: GROUP_MAIN, type: 'supergroup', title: 'Main', username: 'main_group', access: 'member' }),
                `chat header (got ${JSON.stringify(body.chat)})`
            );
            expect(
                JSON.stringify(Object.keys(body.settings).sort()) ===
                    JSON.stringify(['geminiPriority', 'model', 'paused', 'promptAddendum', 'settingsLocked', 'thinkingEffort', 'toolOverrides', 'updatedAt', 'updatedBy']),
                'settings keys'
            );
            expect(
                body.settings.geminiPriority === null &&
                    body.effectiveGeminiPriority === false &&
                    body.globalGeminiPriority === false &&
                    body.geminiPriorityCanEnable === false,
                `Priority PayGo: unset, off, global off, cannot be switched on here (got ${JSON.stringify(body)})`
            );
            expect(body.settings.model === 'my-own-model-v9' && body.effectiveModel === 'my-own-model-v9', 'effective model is the chat model');
            expect(
                body.settings.thinkingEffort === null &&
                    JSON.stringify(body.thinkingEffortView) ===
                        JSON.stringify({
                            value: null,
                            source: 'model-default',
                            effectiveDefault: null,
                            enabledDefault: null,
                            options: [],
                            supported: false,
                            toggle: false,
                        }),
                `thinking effort: unset, and a free model id offers nothing (got ${JSON.stringify(body.thinkingEffortView)})`
            );
            expect(body.globalDefaultModel === 'env-default-model', 'global default from the env');
            expect(body.summary === null, 'summary is null until reply_metrics exists');
            expect(Array.isArray(body.tools) && body.tools.length === 11, `11 tool groups (got ${body.tools?.length})`);
            expect(
                body.tools.every(
                    (tool: any) =>
                        typeof tool.key === 'string' &&
                        Array.isArray(tool.tools) &&
                        tool.tools.every((name: unknown) => typeof name === 'string') &&
                        typeof tool.enabled === 'boolean' &&
                        typeof tool.defaultEnabled === 'boolean' &&
                        (tool.override === null || typeof tool.override === 'boolean') &&
                        typeof tool.blocked === 'boolean' &&
                        (tool.enabled ? tool.reason === null : typeof tool.reason === 'string')
                ),
                'each group has its tools, the effective and default state, the override and a reason when off'
            );
            expect(
                JSON.stringify(body.tools.map((tool: any) => tool.key)) ===
                    JSON.stringify(['sms', 'image', 'imageSearch', 'imageFetch', 'imageReverseSearch', 'sticker', 'file', 'history', 'harnessIssues', 'widget', 'workspace']),
                'groups come in the fixed order'
            );
            expect(
                body.tools.every((tool: any) => tool.override === null),
                'nothing is overridden before the panel says so'
            );
            const workspaceGroup = body.tools.find((tool: any) => tool.key === 'workspace');
            expect(
                workspaceGroup?.enabled === false && workspaceGroup?.reason === 'WORKSPACE_ENABLE 为 0',
                `the workspace group is off until WORKSPACE_ENABLE=1 (got ${JSON.stringify(workspaceGroup)})`
            );
            expect(body.recentAudit.length === 5, 'the latest five changes');
            const latest = body.recentAudit[0];
            expect(
                JSON.stringify(Object.keys(latest).sort()) ===
                    JSON.stringify(['actorId', 'actorName', 'createdAt', 'id', 'key', 'newValue', 'oldValue']),
                'audit entry keys'
            );
            expect(latest.actorId === OWNER_ID && latest.key === 'settingsLocked' && latest.newValue === 'false', 'newest first');
            const aliceEntry = body.recentAudit.find((entry: any) => entry.actorId === ALICE.id);
            expect(aliceEntry?.actorName === 'Alice Liddell', `panel users get their name (got ${aliceEntry?.actorName})`);

            await SettingsAudit.create({ actorId: 777, scope: `chat:${GROUP_MAIN}`, key: 'paused', oldValue: 'false', newValue: 'true', createdAt: new Date() });
            const withStranger = await jsonOf(await call(app, `/api/chats/${GROUP_MAIN}`, { user: ALICE }));
            expect(withStranger.recentAudit[0].actorName === '用户 777', 'an unknown actor reads as 用户 <id>');
        },
    },
    {
        name: 'thinking effort: the view follows the effective model, the closed set goes through PATCH, a stale edit is 409',
        body: async () => {
            // Fresh rate-limit window: this case adds a handful of requests to the shared budget
            clockMs += 60_000;
            const before = await jsonOf(await call(app, `/api/chats/${GROUP_MAIN}`, { user: ALICE }));
            const set = await patchSettings(app, GROUP_MAIN, ALICE, {
                thinkingEffort: 'high',
                expectedUpdatedAt: before.settings.updatedAt,
            });
            const setBody = await jsonOf(set);
            expect(set.status === 200 && setBody.settings.thinkingEffort === 'high', 'a member sets the level');
            const after = await jsonOf(await call(app, `/api/chats/${GROUP_MAIN}`, { user: ALICE }));
            expect(
                after.thinkingEffortView.value === 'high' && after.thinkingEffortView.source === 'chat',
                `the view carries the chat value and where it comes from (got ${JSON.stringify(after.thinkingEffortView)})`
            );
            const audit = await jsonOf(await call(app, `/api/audit?chatId=${GROUP_MAIN}&limit=10`, { user: ALICE }));
            const entry = audit.entries.find((row: any) => row.key === 'thinkingEffort');
            expect(entry?.oldValue === null && entry.newValue === 'high', 'the audit keeps the raw values');

            await expectError(
                await patchSettings(app, GROUP_MAIN, ALICE, {
                    thinkingEffort: 'low',
                    expectedUpdatedAt: before.settings.updatedAt,
                }),
                409,
                'conflict',
                'a stale expectedUpdatedAt is still 409'
            );
            const cleared = await patchSettings(app, GROUP_MAIN, ALICE, { thinkingEffort: null });
            expect(
                cleared.status === 200 && (await jsonOf(cleared)).settings.thinkingEffort === null,
                'null goes back to the model default'
            );

            // The effective model decides the options: Gemini 4 Hydrogen has graded efforts
            await patchSettings(app, GROUP_MAIN, ALICE, { model: 'gemini-4-hydrogen' });
            const hydrogen = await jsonOf(await call(app, `/api/chats/${GROUP_MAIN}`, { user: ALICE }));
            expect(
                JSON.stringify(hydrogen.thinkingEffortView) ===
                    JSON.stringify({
                        value: null,
                        source: 'model-default',
                        effectiveDefault: 'high',
                        enabledDefault: null,
                        options: [
                            { value: 'low', label: '低' },
                            { value: 'medium', label: '中' },
                            { value: 'high', label: '高' },
                            { value: 'xhigh', label: '极高' },
                        ],
                        supported: true,
                        toggle: false,
                    }),
                `the catalog model's own efforts, in order (got ${JSON.stringify(hydrogen.thinkingEffortView)})`
            );

            // A graded toggle model: off is offered and the vendor default is named
            await patchSettings(app, GROUP_MAIN, ALICE, { model: 'deepseek-flash' });
            const deepseek = await jsonOf(await call(app, `/api/chats/${GROUP_MAIN}`, { user: ALICE }));
            expect(
                deepseek.thinkingEffortView.toggle === true &&
                    deepseek.thinkingEffortView.enabledDefault === true &&
                    deepseek.thinkingEffortView.effectiveDefault === 'high' &&
                    JSON.stringify(deepseek.thinkingEffortView.options) ===
                        JSON.stringify([
                            { value: 'low', label: '低' },
                            { value: 'high', label: '高' },
                            { value: 'max', label: '最大' },
                        ]),
                `a graded toggle model (got ${JSON.stringify(deepseek.thinkingEffortView)})`
            );

            // A toggle-only model: no graded efforts, the switch remains
            await patchSettings(app, GROUP_MAIN, ALICE, { model: 'mimo-v2.6-flash' });
            const mimo = await jsonOf(await call(app, `/api/chats/${GROUP_MAIN}`, { user: ALICE }));
            expect(
                mimo.thinkingEffortView.supported === false &&
                    mimo.thinkingEffortView.toggle === true &&
                    mimo.thinkingEffortView.enabledDefault === true &&
                    mimo.thinkingEffortView.options.length === 0,
                `a toggle-only model (got ${JSON.stringify(mimo.thinkingEffortView)})`
            );

            // Leave the chat as the later cases expect it
            await patchSettings(app, GROUP_MAIN, ALICE, { model: 'my-own-model-v9' });
        },
    },
    {
        name: 'thinking effort: a seed-only model without a catalog row shows its seed efforts',
        body: async () => {
            clockMs += 60_000;
            // The production catalog holds the database rows only; a seed id that
            // is not a menu model (so its row is never backfilled) must still show
            // what the menu and the request path resolve.
            await loadModelCatalog();
            await ModelCatalogEntryRow.destroy({ where: { id: 'gemini-3.8-flash' } });
            await loadModelCatalog();
            expect(findModelCatalogEntry('gemini-3.8-flash') === null, 'the id has no catalog row');

            await patchSettings(app, GROUP_MAIN, ALICE, { model: 'gemini-3.8-flash' });
            const viewBody = await jsonOf(await call(app, `/api/chats/${GROUP_MAIN}`, { user: ALICE }));
            expect(viewBody.effectiveModel === 'gemini-3.8-flash', 'the view follows the chat model');
            expect(
                JSON.stringify(viewBody.thinkingEffortView) ===
                    JSON.stringify({
                        value: null,
                        source: 'model-default',
                        effectiveDefault: 'medium',
                        enabledDefault: null,
                        options: [
                            { value: 'low', label: '低' },
                            { value: 'medium', label: '中' },
                            { value: 'high', label: '高' },
                        ],
                        supported: true,
                        toggle: false,
                    }),
                `the seed-only model's data reaches the panel (got ${JSON.stringify(viewBody.thinkingEffortView)})`
            );

            // Back to the built-in fallback: the later cases expect the menu order
            // and the fallback is what the panel reads until the DB loads anyway.
            setModelCatalog([]);
            await patchSettings(app, GROUP_MAIN, ALICE, { model: 'my-own-model-v9' });
        },
    },
    {
        name: 'PATCH settings: tool switches — members flip groups, the sms switch is the owner’s',
        body: async () => {
            // Fresh rate-limit windows: this case adds a handful of requests to the shared budget
            clockMs += 60_000;
            const before = await auditCount(GROUP_TOOLS);
            const flipped = await patchSettings(app, GROUP_TOOLS, ALICE, { toolOverrides: { file: true, image: false } });
            const flippedBody = await jsonOf(flipped);
            expect(flipped.status === 200, 'a member may switch tool groups');
            expect(
                JSON.stringify(flippedBody.settings.toolOverrides) === JSON.stringify({ image: false, file: true }),
                `canonical JSON with only the set keys (got ${JSON.stringify(flippedBody.settings.toolOverrides)})`
            );
            expect((await auditCount(GROUP_TOOLS)) === before + 1, 'one audit row');

            const dashboard = await jsonOf(await call(app, `/api/chats/${GROUP_TOOLS}`, { user: ALICE }));
            const byKey = (key: string) => dashboard.tools.find((tool: any) => tool.key === key);
            expect(byKey('file').override === true && byKey('file').enabled === true, 'a panel on switch enables a tool outside the env whitelist');
            expect(byKey('image').override === false && byKey('image').enabled === false, 'a panel off switch disables a group');
            expect(byKey('image').reason === '已由面板关闭', `the off reason names the panel (got ${byKey('image').reason})`);
            expect(byKey('sticker').override === null, 'untouched groups still follow the env');

            await expectError(
                await patchSettings(app, GROUP_TOOLS, ALICE, { toolOverrides: { image: false, file: true, sms: true } }),
                403,
                'forbidden',
                'a member flipping sms'
            );
            expect((await auditCount(GROUP_TOOLS)) === before + 1, 'the refused patch wrote nothing');

            const ownerFlip = await patchSettings(app, GROUP_TOOLS, OWNER, { toolOverrides: { image: false, file: true, sms: true } });
            expect(ownerFlip.status === 200, 'the owner may flip sms');

            const keepSms = await patchSettings(app, GROUP_TOOLS, ALICE, { toolOverrides: { sms: true, history: true } });
            expect(keepSms.status === 200, 'a member keeps the sms value and flips another group');

            const cleared = await patchSettings(app, GROUP_TOOLS, OWNER, { toolOverrides: null });
            const clearedBody = await jsonOf(cleared);
            expect(cleared.status === 200 && clearedBody.settings.toolOverrides === null, 'null clears every override');
            expect((await auditCount(GROUP_TOOLS)) === before + 4, 'one audit row per accepted change');
            clockMs += 60_000;
        },
    },
    {
        name: 'the global default: owner only; null goes back to the env',
        body: async () => {
            await expectError(await call(app, '/api/global', { user: ALICE }), 403, 'forbidden', 'GET by a non-owner');
            await expectError(
                await call(app, '/api/global', { user: ALICE, method: 'PATCH', body: { defaultModel: 'x' } }),
                403,
                'forbidden',
                'PATCH by a non-owner'
            );
            const initial = await jsonOf(await call(app, '/api/global', { user: OWNER }));
            expect(initial.defaultModel === 'env-default-model' && initial.source === 'env', 'starts from the env');
            const set = await jsonOf(await call(app, '/api/global', { user: OWNER, method: 'PATCH', body: { defaultModel: 'panel-model' } }));
            expect(set.defaultModel === 'panel-model' && set.source === 'panel', 'set from the panel');
            const cleared = await jsonOf(await call(app, '/api/global', { user: OWNER, method: 'PATCH', body: { defaultModel: null } }));
            expect(cleared.defaultModel === 'env-default-model' && cleared.source === 'env', 'null returns to the env');
            for (const [label, body] of [
                ['empty id', { defaultModel: '' }],
                ['over 64 characters', { defaultModel: 'g'.repeat(65) }],
                ['an image model', { defaultModel: 'gemini-nano-banana-2.1' }],
                ['wrong type', { defaultModel: 7 }],
                ['missing key', {}],
                ['unknown key', { defaultModel: 'a', extra: 1 }],
            ] as const) {
                await expectError(await call(app, '/api/global', { user: OWNER, method: 'PATCH', body }), 400, 'invalid', label);
            }
            const after = await jsonOf(await call(app, '/api/global', { user: OWNER }));
            expect(after.defaultModel === 'env-default-model' && after.source === 'env', 'none of them was stored');
        },
    },
    {
        name: 'the preview renders the runtime block; private chats say so',
        body: async () => {
            const previewOf = async (chatId: number, user: InitDataUserInput, promptAddendum: unknown) =>
                jsonOf(await call(app, `/api/chats/${chatId}/settings/preview`, { user, method: 'POST', body: { promptAddendum } }));

            const privatePreview = await previewOf(ALICE.id, ALICE, '  群里讨论技术问题时直接给结论。\r\n再给理由。 ');
            const block: string = privatePreview.runtimeBlock;
            expect(block.includes('- 当前对话：私聊') && !block.includes('当前群聊'), 'a private chat renders as 当前对话：私聊');
            expect(block.includes('- Alice Liddell：id 5001，@alice'), 'the requester is the sample roster');
            expect(
                block.endsWith('\n\n# 本聊天的附加提示词\n以下由本聊天成员通过控制面板设置，效力等同系统提示词，回复时须遵循：\n群里讨论技术问题时直接给结论。\n再给理由。'),
                'the normalized addendum closes the block'
            );
            expect(privatePreview.injected === true, 'injected');
            // 15 + newline + 5 code points after normalization
            expect(privatePreview.estimatedTokens === Math.ceil(21 * 1.3), `1.3 tokens per character (got ${privatePreview.estimatedTokens})`);

            const groupPreview = await previewOf(GROUP_MAIN, ALICE, null);
            expect(groupPreview.runtimeBlock.includes('- 当前群聊：Main'), 'a group renders its title');
            expect(!groupPreview.runtimeBlock.includes('# 本聊天的附加提示词') && groupPreview.estimatedTokens === 0, 'null: no section, 0 tokens');
            expect(groupPreview.runtimeBlock.includes('- 当前模型：my-own-model-v9'), "the chat's current model");
            // The cases below expect the group to follow the global default
            await patchSettings(app, GROUP_MAIN, ALICE, { model: null });

            await expectError(
                await call(app, `/api/chats/${GROUP_MAIN}/settings/preview`, { user: ALICE, method: 'POST', body: { promptAddendum: 'x'.repeat(2001) } }),
                400,
                'invalid',
                'an over-long addendum'
            );
            await expectError(
                await call(app, `/api/chats/${GROUP_MAIN}/settings/preview`, { user: ALICE, method: 'POST', body: {} }),
                400,
                'invalid',
                'no promptAddendum'
            );
            await expectError(
                await call(app, `/api/chats/${GROUP_MAIN}/settings/preview`, { user: BOB, method: 'POST', body: { promptAddendum: 'x' } }),
                403,
                'forbidden',
                'a non-member'
            );
        },
    },
    {
        name: '/api/me: user, chat list rows and the start target',
        body: async () => {
            const response = await call(app, '/api/me', { user: ALICE, startParam: `c${GROUP_MAIN}` });
            const body = await jsonOf(response);
            expect(response.status === 200, '200');
            expect(
                JSON.stringify(body.user) === JSON.stringify({ id: 5001, firstName: 'Alice', lastName: 'Liddell', username: 'alice' }),
                'user'
            );
            expect(body.isOwner === false && body.globalDefaultModel === 'env-default-model', 'isOwner and global default');
            expect(JSON.stringify(body.models) === JSON.stringify(modelConfigs.map((model) => model.id)), 'models follow modelConfigs');
            expect(
                JSON.stringify(body.startTarget) === JSON.stringify({ kind: 'chat', chatId: GROUP_MAIN, access: 'member' }),
                `start target (got ${JSON.stringify(body.startTarget)})`
            );
            const ids = body.chats.map((chat: any) => chat.chatId);
            expect(ids.includes(ALICE.id) && ids.includes(GROUP_MAIN), 'own private chat and the hinted group');
            expect(!ids.includes(GROUP_LEFT) && !ids.includes(GROUP_THROTTLED), 'nothing she is not a member of');
            const main = body.chats.find((chat: any) => chat.chatId === GROUP_MAIN);
            expect(
                JSON.stringify(Object.keys(main).sort()) ===
                    JSON.stringify(['access', 'chatId', 'lastActivityAt', 'model', 'modelSource', 'openIssues', 'paused', 'settingsLocked', 'title', 'type', 'username']),
                'chat row keys'
            );
            expect(main.title === 'Main' && main.username === 'main_group', 'the row names the group and its @username');
            expect(main.model === null && main.modelSource === 'global', 'a chat following the global default');

            await patchSettings(app, ALICE.id, ALICE, { model: 'mine' });
            await HarnessIssue.create({ kind: 'bug', title: 'open one', body: 'b', chatId: GROUP_MAIN });
            await HarnessIssue.create({ kind: 'bug', title: 'open two', body: 'b', chatId: GROUP_MAIN });
            const closed = await HarnessIssue.create({ kind: 'bug', title: 'done', body: 'b', chatId: GROUP_MAIN });
            closed.status = 'fixed';
            await closed.save();
            const again = await jsonOf(await call(app, '/api/me', { user: ALICE, startParam: `i${closed.id}` }));
            const own = again.chats.find((chat: any) => chat.chatId === ALICE.id);
            expect(own.model === 'mine' && own.modelSource === 'chat' && own.type === 'private', 'own chat with its own model');
            expect(again.chats.find((chat: any) => chat.chatId === GROUP_MAIN).openIssues === 2, 'open issues counted');
            expect(
                JSON.stringify(again.startTarget) ===
                    JSON.stringify({ kind: 'issue', chatId: GROUP_MAIN, issueId: closed.id, access: 'member' }),
                `an issue target carries its chat (got ${JSON.stringify(again.startTarget)})`
            );

            const bob = await jsonOf(await call(app, '/api/me', { user: BOB, startParam: `c${GROUP_MAIN}` }));
            expect(
                JSON.stringify(bob.startTarget) === JSON.stringify({ kind: 'chat', chatId: GROUP_MAIN, access: 'none' }),
                'a forged / foreign target reads as none'
            );
            expect(!bob.chats.some((chat: any) => chat.chatId === GROUP_MAIN), 'and is not listed');
            // An issue link tells a non-member nothing: existing and missing issues read the same
            const bobIssue = await jsonOf(await call(app, '/api/me', { user: BOB, startParam: `i${closed.id}` }));
            expect(
                JSON.stringify(bobIssue.startTarget) ===
                    JSON.stringify({ kind: 'issue', chatId: null, issueId: closed.id, access: 'none' }),
                `a non-member does not learn the issue's chat (got ${JSON.stringify(bobIssue.startTarget)})`
            );
            const missingIssue = await jsonOf(await call(app, '/api/me', { user: BOB, startParam: 'i987654' }));
            expect(
                JSON.stringify(missingIssue.startTarget) ===
                    JSON.stringify({ kind: 'issue', chatId: null, issueId: 987654, access: 'none' }),
                `a missing issue reads the same (got ${JSON.stringify(missingIssue.startTarget)})`
            );
            const throttled = await jsonOf(await call(app, '/api/me', { user: ALICE, startParam: `c${GROUP_THROTTLED}` }));
            expect(
                JSON.stringify(throttled.startTarget) ===
                    JSON.stringify({ kind: 'chat', chatId: GROUP_THROTTLED, access: 'unavailable' }),
                `a rate-limited lookup is unavailable, not "not a member" (got ${JSON.stringify(throttled.startTarget)})`
            );
            const junk = await jsonOf(await call(app, '/api/me', { user: BOB, startParam: 'hello' }));
            expect(junk.startTarget === null, 'a meaningless start_param is ignored');

            const owner = await jsonOf(await call(app, '/api/me', { user: OWNER }));
            expect(owner.isOwner === true, 'the owner is recognized');
            expect(owner.chats.find((chat: any) => chat.chatId === GROUP_MAIN)?.access === 'observer', 'and observes a group they are not in');
        },
    },
    {
        name: 'audit: a chat for its members, everything for the owner',
        body: async () => {
            const chatAudit = await jsonOf(await call(app, `/api/audit?chatId=${GROUP_MAIN}&limit=3`, { user: ALICE }));
            expect(chatAudit.entries.length === 3, 'limit applies');
            expect(chatAudit.entries.every((entry: any) => entry.scope === `chat:${GROUP_MAIN}`), 'only that chat');
            const nextPage = await jsonOf(
                await call(app, `/api/audit?chatId=${GROUP_MAIN}&limit=3&beforeId=${chatAudit.entries[2].id}`, { user: ALICE })
            );
            expect(nextPage.entries.every((entry: any) => entry.id < chatAudit.entries[2].id), 'beforeId pages backwards');
            await expectError(await call(app, '/api/audit', { user: ALICE }), 403, 'forbidden', 'all scopes by a non-owner');
            await expectError(await call(app, `/api/audit?chatId=${GROUP_MAIN}`, { user: BOB }), 403, 'forbidden', 'a non-member');
            await expectError(await call(app, `/api/audit?chatId=${GROUP_MAIN}&limit=0`, { user: ALICE }), 400, 'invalid', 'limit 0');
            await expectError(await call(app, `/api/audit?chatId=${GROUP_MAIN}&limit=101`, { user: ALICE }), 400, 'invalid', 'limit 101');
            const everything = await jsonOf(await call(app, '/api/audit?limit=100', { user: OWNER }));
            expect(everything.entries.some((entry: any) => entry.scope === 'global'), 'the owner sees the global scope too');
        },
    },
    {
        name: 'unmatched /api is a JSON 404; a body over 32 KB is 413',
        body: async () => {
            const response = await call(app, '/api/x', { user: ALICE });
            await expectError(response, 404, 'not_found', '/api/x');
            await expectError(await call(app, '/api/chats/1/nothing', { user: ALICE, method: 'POST', body: {} }), 404, 'not_found', 'an unknown POST');
            await expectError(
                await patchSettings(app, GROUP_MAIN, ALICE, { promptAddendum: 'x'.repeat(40 * 1024) }),
                413,
                'too_large',
                'a 40 KB body'
            );
        },
    },
    {
        name: 'a handler over its ceiling is 504',
        body: async () => {
            const impatient = makeApp(STATIC_ROOT, 50);
            await expectError(await call(impatient, `/api/chats/${GROUP_LEFT}`, { user: BOB }), 504, 'timeout', 'a 200ms lookup under a 50ms ceiling');
            expect((await call(impatient, '/api/global', { user: OWNER })).status === 200, 'fast handlers are unaffected');
        },
    },
    {
        name: 'the request log names the template, status and user, never the path or initData',
        body: async () => {
            const initData = initDataFor(ALICE);
            const lines = await captureLogs(async () => {
                await call(app, `/api/chats/${GROUP_MAIN}?debug=1`, { initData });
            });
            expect(
                lines.some((line) => /^\[panel\] GET \/api\/chats\/:chatId 200 \d+ms u=5001$/.test(line)),
                `one line per request (got ${JSON.stringify(lines)})`
            );
            expect(lines.every((line) => !line.includes(String(GROUP_MAIN)) && !line.includes('debug')), 'no concrete path or query');
            expect(lines.every((line) => !line.includes(initData.slice(0, 40))), 'no initData');
        },
    },
    {
        name: 'the 61st request in a minute is 429 with Retry-After',
        body: async () => {
            const limitedApp = makeApp();
            const statuses: number[] = [];
            for (let index = 0; index < 60; index += 1) {
                statuses.push((await call(limitedApp, '/api/global', { user: OWNER })).status);
            }
            expect(statuses.every((status) => status === 200), 'sixty pass');
            const sixtyFirst = await call(limitedApp, '/api/global', { user: OWNER });
            await expectError(sixtyFirst, 429, 'rate_limited', 'the 61st');
            const retryAfter = Number(sixtyFirst.headers.get('Retry-After'));
            expect(retryAfter >= 1 && retryAfter <= 60, `Retry-After within the window (got ${retryAfter})`);
            expect((await call(limitedApp, '/api/global', { user: ALICE })).status === 403, 'other users have their own budget');
            clockMs += 60_000;
            expect((await call(limitedApp, '/api/global', { user: OWNER })).status === 200, 'a new window starts after 60s');
            clockMs = Date.now();
        },
    },
    {
        name: 'body limit: a body-less DELETE and a chunked upload are not 500s',
        body: async () => {
            // A real HTTP DELETE reaches the server as an empty stream without a
            // content-length; @hono/node-server's Request subclass could not be
            // cloned by hono's own bodyLimit, so these requests answered 500.
            const previewPath = `/api/chats/${GROUP_MAIN}/settings/preview`;
            const chunkedBody = JSON.stringify({ promptAddendum: 'chunked' });
            const chunked = await app.request(
                streamRequest(previewPath, { method: 'POST', user: ALICE, body: chunkedBody })
            );
            expect(chunked.status === 200, `a chunked upload passes (got ${chunked.status})`);
            expect((await jsonOf(chunked)).injected === true, 'its body arrived at the handler');

            const tooLarge = await app.request(
                streamRequest(previewPath, {
                    method: 'POST',
                    user: ALICE,
                    body: JSON.stringify({ promptAddendum: 'x'.repeat(40_000) }),
                })
            );
            expect(tooLarge.status === 413, `a chunked body over 32 KB is 413 (got ${tooLarge.status})`);

            const bodyless = await app.request(
                streamRequest(`/api/chats/${GROUP_MAIN}/messages/1/exclusion`, { method: 'DELETE', user: ALICE, body: null })
            );
            expect(bodyless.status === 404, `a body-less DELETE reaches its route (got ${bodyless.status})`);
        },
    },
    {
        name: 'static files: assets cached forever, history routes get index.html, no fallback for assets',
        body: async () => {
            const asset = await call(app, '/assets/app-1a2b3c.js');
            expect(asset.status === 200 && (await asset.text()) === 'console.log("panel");', 'an asset is served');
            expect(asset.headers.get('Cache-Control') === 'public, max-age=31536000, immutable', 'immutable');
            expect(asset.headers.get('Content-Type')?.startsWith('text/javascript') === true, 'as JavaScript');
            expect(asset.headers.get('Content-Security-Policy') === null, 'no CSP on assets');

            const missingAsset = await call(app, '/assets/missing.js');
            expect(missingAsset.status === 404 && !(await missingAsset.text()).includes('<div id="root">'), 'a missing asset is 404, not index.html');

            for (const path of ['/', '/c/1', '/c/-1001/audit', '/issues/3', '/global']) {
                const page = await call(app, path);
                expect(page.status === 200 && (await page.text()) === INDEX_HTML, `${path} → index.html`);
                expect(page.headers.get('Cache-Control') === 'no-cache', `${path}: no-cache`);
                expect(page.headers.get('Content-Security-Policy') === INDEX_CONTENT_SECURITY_POLICY, `${path}: CSP`);
                expect(page.headers.get('X-Frame-Options') === null, `${path}: embeddable`);
            }
            const head = await call(app, '/c/1', { method: 'HEAD' });
            expect(head.status === 200 && (await head.text()) === '', 'HEAD follows GET without a body');
            const favicon = await call(app, '/favicon.svg');
            expect(favicon.status === 200 && favicon.headers.get('Content-Type') === 'image/svg+xml', 'a top-level file is served as itself');

            // %2e%2e is normalized away by the URL parser; %2f survives it and is decoded by us
            const escape = await call(app, '/assets/..%2f..%2fsecret.txt');
            const escapeBody = await escape.text();
            expect(escape.status === 404 && !escapeBody.includes('outside'), `no escape from the static root (got ${escape.status})`);
            const normalized = await call(app, '/assets/%2e%2e/%2e%2e/secret.txt');
            expect(!(await normalized.text()).includes('outside'), 'a dot-segment path never reaches the file either');
            const post = await call(app, '/', { method: 'POST' });
            expect(post.status === 405 && post.headers.get('Allow') === 'GET, HEAD', 'POST / is 405');
            expect((await call(app, '/c/1', { method: 'DELETE' })).status === 405, 'DELETE /c/1 is 405');

            const unbuilt = makeApp(join(scratch, 'no-dist'));
            const notBuilt = await call(unbuilt, '/c/1');
            expect(notBuilt.status === 503 && (await notBuilt.text()).includes('面板前端未构建'), 'without a build: 503 page');
            expect((await call(unbuilt, '/assets/app-1a2b3c.js')).status === 503, 'assets too');
            expect((await call(unbuilt, '/api/health')).status === 200, 'the API is unaffected');
        },
    },
];

cases.push(
    {
        name: 'PATCH settings: Priority PayGo is the owner’s, and "on" is refused where it cannot take effect',
        body: async () => {
            clockMs += 60_000;
            const facts = (own: boolean | null, effective: boolean, global: boolean, canEnable: boolean) =>
                JSON.stringify({ own, effective, global, canEnable });
            expect(
                JSON.stringify(await priorityFactsOf(GROUP_PRIORITY_UNLISTED)) === facts(null, false, false, false),
                'global off, outside TOOL_CHAT_IDS: cannot be switched on'
            );
            expect(
                JSON.stringify(await priorityFactsOf(GROUP_PRIORITY_LISTED)) === facts(null, false, false, true),
                'global off, inside TOOL_CHAT_IDS: can be switched on'
            );

            const unlistedBefore = await auditCount(GROUP_PRIORITY_UNLISTED);
            const refused = await patchSettings(app, GROUP_PRIORITY_UNLISTED, OWNER, { geminiPriority: true });
            const refusedBody = await jsonOf(refused);
            expect(
                refused.status === 403 && refusedBody.error?.code === 'forbidden' && refusedBody.error?.message === PRIORITY_NOT_ALLOWED,
                `the owner too is refused "on" outside the whitelist, with the reason (got ${refused.status} ${JSON.stringify(refusedBody)})`
            );
            expect((await auditCount(GROUP_PRIORITY_UNLISTED)) === unlistedBefore, 'the refused patch wrote nothing');
            const off = await patchSettings(app, GROUP_PRIORITY_UNLISTED, OWNER, { geminiPriority: false });
            expect(off.status === 200 && (await jsonOf(off)).settings.geminiPriority === false, '"off" is always allowed');

            const listedBefore = await auditCount(GROUP_PRIORITY_LISTED);
            const on = await patchSettings(app, GROUP_PRIORITY_LISTED, OWNER, { geminiPriority: true });
            expect(on.status === 200 && (await jsonOf(on)).settings.geminiPriority === true, 'inside the whitelist the owner switches it on');
            expect(
                JSON.stringify(await priorityFactsOf(GROUP_PRIORITY_LISTED)) === facts(true, true, false, true),
                'and it takes effect with the global switch off'
            );
            expect((await auditCount(GROUP_PRIORITY_LISTED)) === listedBefore + 1, 'one audit row');
            const [entry] = await SettingsAudit.findAll({
                where: { scope: `chat:${GROUP_PRIORITY_LISTED}` },
                order: [['id', 'DESC']],
                limit: 1,
            });
            expect(
                entry?.key === 'geminiPriority' && entry.oldValue === null && entry.newValue === 'true',
                `audited null → 'true' (got ${JSON.stringify(entry)})`
            );

            await expectError(
                await patchSettings(app, GROUP_PRIORITY_LISTED, ALICE, { geminiPriority: false }),
                403,
                'forbidden',
                'a member switching it'
            );
            await expectError(
                await patchSettings(app, GROUP_PRIORITY_LISTED, ALICE, { geminiPriority: null }),
                403,
                'forbidden',
                'a member clearing it'
            );
            const keep = await patchSettings(app, GROUP_PRIORITY_LISTED, ALICE, { geminiPriority: true, promptAddendum: '保持' });
            expect(keep.status === 200, 'a member may send the unchanged value with another change');
            for (const [label, value] of [
                ['a string', 'true'],
                ['a number', 1],
                ['an object', { on: true }],
            ] as const) {
                await expectError(
                    await patchSettings(app, GROUP_PRIORITY_LISTED, ALICE, { geminiPriority: value }),
                    400,
                    'invalid',
                    `${label}, even from a member`
                );
                await expectError(
                    await patchSettings(app, GROUP_PRIORITY_LISTED, OWNER, { geminiPriority: value }),
                    400,
                    'invalid',
                    `${label} from the owner`
                );
            }
            expect((await auditCount(GROUP_PRIORITY_LISTED)) === listedBefore + 2, 'only the two accepted changes were audited');

            clockMs += 60_000;
            // The global switch on: every chat may switch it on, and an unset chat follows
            expect((await patchGlobal(OWNER, { defaultGeminiPriority: true })).status === 200, 'the global switch goes on');
            const cleared = await patchSettings(app, GROUP_PRIORITY_UNLISTED, OWNER, { geminiPriority: null });
            expect(cleared.status === 200 && (await jsonOf(cleared)).settings.geminiPriority === null, 'null: follow the global switch');
            expect(
                JSON.stringify(await priorityFactsOf(GROUP_PRIORITY_UNLISTED)) === facts(null, true, true, true),
                'global on: an unset chat outside the whitelist is on, and may be switched on'
            );
            const unlistedOn = await patchSettings(app, GROUP_PRIORITY_UNLISTED, OWNER, { geminiPriority: true });
            expect(unlistedOn.status === 200, 'with the global switch on, "on" is accepted outside the whitelist');

            // Global off again: the stored "on" stays but no longer takes effect outside the whitelist
            expect((await patchGlobal(OWNER, { defaultGeminiPriority: false })).status === 200, 'the global switch goes off');
            expect(
                JSON.stringify(await priorityFactsOf(GROUP_PRIORITY_UNLISTED)) === facts(true, false, false, false),
                'outside the whitelist: stored on, effective off'
            );
            expect(
                JSON.stringify(await priorityFactsOf(GROUP_PRIORITY_LISTED)) === facts(true, true, false, true),
                'inside the whitelist: still on'
            );
            const otherKey = await patchSettings(app, GROUP_PRIORITY_UNLISTED, OWNER, { geminiPriority: true, paused: true });
            expect(otherKey.status === 200, 'an unchanged stored "on" does not block another key');
            await patchSettings(app, GROUP_PRIORITY_UNLISTED, OWNER, { geminiPriority: null, paused: false });
            clockMs += 60_000;
        },
    },
    {
        name: 'PATCH /api/global: a partial update of the model and the switch, every key or none, owner only',
        body: async () => {
            clockMs += 60_000;
            const initial = await jsonOf(await call(app, '/api/global', { user: OWNER }));
            expect(
                JSON.stringify(Object.keys(initial).sort()) === JSON.stringify(['defaultGeminiPriority', 'defaultModel', 'source']),
                `response keys (got ${JSON.stringify(initial)})`
            );
            expect(initial.defaultGeminiPriority === false && initial.source === 'env', 'starts off, model from the env');

            const before = await globalAuditCount();
            const switchOnly = await jsonOf(await patchGlobal(OWNER, { defaultGeminiPriority: true }));
            expect(
                switchOnly.defaultGeminiPriority === true && switchOnly.defaultModel === 'env-default-model' && switchOnly.source === 'env',
                `the switch alone leaves the model alone (got ${JSON.stringify(switchOnly)})`
            );
            const modelOnly = await jsonOf(await patchGlobal(OWNER, { defaultModel: 'panel-model-2' }));
            expect(
                modelOnly.defaultModel === 'panel-model-2' && modelOnly.defaultGeminiPriority === true,
                `the model alone leaves the switch alone (got ${JSON.stringify(modelOnly)})`
            );
            expect((await globalAuditCount()) === before + 2, 'one audit row each');

            const both = await jsonOf(await patchGlobal(OWNER, { defaultModel: null, defaultGeminiPriority: false }));
            expect(
                both.defaultModel === 'env-default-model' && both.source === 'env' && both.defaultGeminiPriority === false,
                `both keys in one patch (got ${JSON.stringify(both)})`
            );
            const latest = await SettingsAudit.findAll({ where: { scope: 'global' }, order: [['id', 'DESC']], limit: 2 });
            expect(
                JSON.stringify(latest.reverse().map((entry) => [entry.key, entry.oldValue, entry.newValue])) ===
                    JSON.stringify([
                        ['defaultModel', 'panel-model-2', null],
                        ['defaultGeminiPriority', 'true', 'false'],
                    ]),
                'audited in the fixed key order, the switch as text'
            );
            const unchanged = await patchGlobal(OWNER, { defaultGeminiPriority: false, defaultModel: null });
            expect(unchanged.status === 200 && (await globalAuditCount()) === before + 4, 'the values it already has write nothing');

            const afterValid = await globalAuditCount();
            const invalidBodies: [string, unknown][] = [
                ['a good model next to a string switch', { defaultModel: 'never-written', defaultGeminiPriority: 'true' }],
                ['a good model next to a null switch', { defaultModel: 'never-written', defaultGeminiPriority: null }],
                ['an empty model next to a good switch', { defaultModel: '', defaultGeminiPriority: true }],
                ['a model over 64 characters next to a good switch', { defaultModel: 'g'.repeat(65), defaultGeminiPriority: true }],
                ['a numeric switch', { defaultGeminiPriority: 1 }],
                ['an unknown key next to the switch', { defaultGeminiPriority: true, extra: 1 }],
                ['no key', {}],
            ];
            for (const [label, body] of invalidBodies) {
                await expectError(await patchGlobal(OWNER, body), 400, 'invalid', label);
            }
            const untouched = await jsonOf(await call(app, '/api/global', { user: OWNER }));
            expect(
                untouched.defaultModel === 'env-default-model' && untouched.defaultGeminiPriority === false,
                `one bad key leaves the other unwritten (got ${JSON.stringify(untouched)})`
            );
            expect((await globalAuditCount()) === afterValid, 'and audited nothing');

            clockMs += 60_000;
            await expectError(await call(app, '/api/global', { user: ALICE }), 403, 'forbidden', 'GET by a non-owner');
            await expectError(await patchGlobal(ALICE, { defaultGeminiPriority: true }), 403, 'forbidden', 'the switch by a non-owner');
            expect((await globalAuditCount()) === afterValid, 'the refused patch wrote nothing');

            // A write that fails half-way rolls the other key back with it
            const originalUpsert = GlobalSetting.upsert;
            Reflect.set(GlobalSetting, 'upsert', async (values: { key?: unknown }, options: unknown) => {
                if (values.key === 'defaultGeminiPriority') throw new Error('offline: the second row cannot be written');
                return Reflect.apply(originalUpsert, GlobalSetting, [values, options]);
            });
            let failed: Response | undefined;
            try {
                await captureLogs(async () => {
                    failed = await patchGlobal(OWNER, { defaultModel: 'half-written', defaultGeminiPriority: true });
                });
            } finally {
                Reflect.set(GlobalSetting, 'upsert', originalUpsert);
            }
            expect(failed?.status === 500, `the failed write is a 500 (got ${failed?.status})`);
            expect((await GlobalSetting.findByPk('defaultModel')) === null, 'the model row written first was rolled back');
            const afterFailure = await jsonOf(await call(app, '/api/global', { user: OWNER }));
            expect(
                afterFailure.defaultModel === 'env-default-model' && afterFailure.defaultGeminiPriority === false,
                `the cache never saw either value (got ${JSON.stringify(afterFailure)})`
            );
            expect((await globalAuditCount()) === afterValid, 'and neither audit row stayed');
            clockMs += 60_000;
        },
    }
);

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
reportResults(results);
