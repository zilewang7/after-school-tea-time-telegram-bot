/**
 * Offline cases for the issue panel (control panel phase 4): the three new
 * harness_issues columns and their migration, the input check the model's
 * tool and POST /api/issues share, the group notice, the HTTP endpoints
 * (visibility and counts, 404 / 403 / 429, the owner's triage and its audit)
 * and what the model's list tool may see of issues people filed.
 *
 * HTTP goes through hono's `app.request()` with self-signed initData, a fake
 * getChatMember and a recording fake Bot API; the database is the scratch one.
 *
 * Run: npx tsx scripts/offline/harness-issue-panel.mts
 */
import { QueryTypes } from '@sequelize/core';
import { GrammyError } from 'grammy';
import { createFakeTelegram, type FakeTelegram, type TelegramCall } from './fake-telegram.mts';
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';
import { signInitData, type InitDataUserInput } from '../lib/init-data.mts';

const BOT_TOKEN = '123456789:AAFakeOfflineTokenForIssuePanel_0123';
const BOT_USER_NAME = 'AfterSchoolTeatimeBot';
const OWNER_ID = 4242;
const ALICE: InitDataUserInput = { id: 5001, first_name: 'Alice', last_name: 'Liddell', username: 'alice' };
const BOB: InitDataUserInput = { id: 5002, first_name: 'Bob' };
/** A member of GROUP_A who has never spoken there */
const CAROL: InitDataUserInput = { id: 5003, first_name: 'Carol' };
/** Neither the owner nor a member of anything */
const STRANGER: InitDataUserInput = { id: 5009, first_name: 'Stranger' };
const OWNER: InitDataUserInput = { id: OWNER_ID, first_name: 'Owner', username: 'the_owner' };

const GROUP_A = -1001000000101;
const GROUP_B = -1001000000102;
const GROUP_PAUSED = -1001000000103;
const BASIC_GROUP = -4101;
const CHANNEL = -1001000000104;
const GROUP_OUTSIDE = -1001000000199;
const UNKNOWN_GROUP = -1001000000777;

// Read once at import by config/instance and config/tool-config
process.env.OWNER_USER_ID = String(OWNER_ID);
process.env.ALLOWED_CHAT_IDS = [
    OWNER_ID, ALICE.id, BOB.id, CAROL.id, STRANGER.id,
    GROUP_A, GROUP_B, GROUP_PAUSED, BASIC_GROUP, CHANNEL, UNKNOWN_GROUP,
].join(',');
process.env.BOT_USER_NAME = BOT_USER_NAME;
delete process.env.WEBAPP_BOT_SHORT_NAME;
// The model's tool switch must not touch the panel path
process.env.HARNESS_ISSUES = '0';

await setupOfflineDb();
const { sequelize } = await import('../../src/db/config.js');
const { runSchemaMigrations } = await import('../../src/db/schema-migrations.js');
const registry = await import('../../src/db/queries/panel-registry.js');
const { ChatMemberSeen } = await import('../../src/db/chatMemberSeenDTO.js');
const { HarnessIssue } = await import('../../src/db/harnessIssueDTO.js');
const { SettingsAudit } = await import('../../src/db/settingsAuditDTO.js');
const { Message } = await import('../../src/db/messageDTO.js');
const { BotResponse } = await import('../../src/db/index.js');
const { isChatPaused, loadChatSettingsCache, updateChatSettings } = await import(
    '../../src/services/chat-settings-service.js'
);
const service = await import('../../src/services/harness-issue-service.js');
const { parseHarnessIssueInput } = await import('../../src/services/harness-issue-input.js');
const { notifyGroupOfUserIssue } = await import('../../src/services/harness-issue-notify.js');
const { createCreateHarnessIssueTool, createListHarnessIssuesTool } = await import(
    '../../src/reply/tools/harness-issue-tool.js'
);
const { createHarnessIssueState } = await import('../../src/reply/tools/harness-issue-state.js');
const { getToolConfig } = await import('../../src/config/tool-config.js');
const { createPanelApp } = await import('../../src/panel/app.js');

type MembershipLookup = import('../../src/panel/access/membership.js').MembershipLookup;
type HarnessIssueRecord = import('../../src/services/harness-issue-service.js').HarnessIssueRecord;
type PanelApp = ReturnType<typeof createPanelApp>;

// ---- fixtures -------------------------------------------------------------

const grammyError = (code: number, description: string): GrammyError =>
    new GrammyError(`(${code}: ${description})`, { ok: false, error_code: code, description }, 'getChatMember', {});

/** chatId:userId → answer; anything unlisted is "user not found" */
const memberships = new Map<string, 'member' | 'left'>([
    [`${GROUP_A}:${ALICE.id}`, 'member'],
    [`${GROUP_A}:${CAROL.id}`, 'member'],
    [`${GROUP_B}:${ALICE.id}`, 'left'],
    [`${GROUP_B}:${BOB.id}`, 'member'],
    [`${GROUP_PAUSED}:${ALICE.id}`, 'member'],
    [`${BASIC_GROUP}:${ALICE.id}`, 'member'],
]);
const fakeLookup: MembershipLookup = async (chatId, userId) => {
    const answer = memberships.get(`${chatId}:${userId}`);
    if (answer === 'member') return { status: 'member' };
    if (answer === 'left') return { status: 'left' };
    throw grammyError(400, 'Bad Request: user not found');
};

let clockMs = Date.now();
const nowSeconds = (): number => Math.floor(clockMs / 1000);

/** One recorder for every notice in the file, so the last cases can look at all of them */
const telegram: FakeTelegram = createFakeTelegram();

const makeApp = (options: { notices?: boolean; issueQuota?: { limit: number; windowMs: number } } = {}): PanelApp =>
    createPanelApp({
        botToken: BOT_TOKEN,
        membershipLookup: fakeLookup,
        staticRoot: '/nonexistent-static-root',
        startedAt: new Date('2026-11-07T00:00:00.000Z'),
        version: 'abc1234',
        now: () => clockMs,
        // Plenty for the cases that are not about the issue quota
        rateLimit: { limit: 10_000, windowMs: 60_000 },
        ...(options.notices === true ? { botApi: telegram.api } : {}),
        ...(options.issueQuota !== undefined ? { issueQuota: options.issueQuota } : {}),
    });

await registry.upsertChatNow({ id: GROUP_A, type: 'supergroup', title: 'Alpha', username: 'alpha_group' });
await registry.upsertChatNow({ id: GROUP_B, type: 'supergroup', title: 'Beta' });
await registry.upsertChatNow({ id: GROUP_PAUSED, type: 'supergroup', title: 'Paused' });
await registry.upsertChatNow({ id: BASIC_GROUP, type: 'group', title: 'Basic' });
await registry.upsertChatNow({ id: CHANNEL, type: 'channel', title: 'Channel' });
await registry.upsertChatNow({ id: GROUP_OUTSIDE, type: 'supergroup', title: 'Outside' });
const spokeAt = new Date();
for (const [chatId, userId] of [
    [GROUP_A, ALICE.id],
    [GROUP_B, ALICE.id],
    [GROUP_PAUSED, ALICE.id],
    [BASIC_GROUP, ALICE.id],
    [GROUP_B, BOB.id],
] as const) {
    await ChatMemberSeen.create({ chatId, userId, firstSeenAt: spokeAt, lastSeenAt: spokeAt, messageCount: 1 });
}
await loadChatSettingsCache();

// ---- helpers ----------------------------------------------------------------

interface CallOptions {
    method?: string;
    user?: InitDataUserInput;
    startParam?: string;
    body?: unknown;
}

const call = (app: PanelApp, path: string, options: CallOptions = {}): Promise<Response> => {
    const headers = new Headers();
    if (options.user !== undefined) {
        headers.set(
            'X-Init-Data',
            signInitData({
                botToken: BOT_TOKEN,
                user: options.user,
                authDate: nowSeconds(),
                ...(options.startParam !== undefined ? { startParam: options.startParam } : {}),
            })
        );
    }
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    return Promise.resolve(app.request(path, { method: options.method ?? 'GET', headers, body }));
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

const expectError = async (response: Response, status: number, code: string, label: string): Promise<void> => {
    const actual = (await jsonOf(response))?.error?.code ?? '-';
    expect(response.status === status && actual === code, `${label} → ${status} ${code} (got ${response.status} ${actual})`);
};

const postIssue = (app: PanelApp, user: InitDataUserInput, body: unknown): Promise<Response> =>
    call(app, '/api/issues', { method: 'POST', user, body });

const patchIssue = (app: PanelApp, user: InitDataUserInput, issueId: number, body: unknown): Promise<Response> =>
    call(app, `/api/issues/${issueId}`, { method: 'PATCH', user, body });

const listIssues = async (app: PanelApp, user: InitDataUserInput, query = '', startParam?: string): Promise<any> => {
    const response = await call(app, `/api/issues${query}`, { user, ...(startParam !== undefined ? { startParam } : {}) });
    if (response.status !== 200) throw new Error(`GET /api/issues${query} answered ${response.status}`);
    return jsonOf(response);
};

const idsOf = (list: any): number[] => list.issues.map((issue: any) => issue.id);

const sameIds = (actual: readonly number[], expected: readonly number[]): boolean =>
    JSON.stringify(actual) === JSON.stringify(expected);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const sendsTo = (chatId: number): TelegramCall[] =>
    telegram.callsOf('sendMessage').filter((sent) => sent.payload.chat_id === chatId);

/** Notices are sent in the background after the 201: poll for them */
const waitForSends = async (chatId: number, count: number, timeoutMs = 3000): Promise<TelegramCall[]> => {
    const deadline = Date.now() + timeoutMs;
    while (sendsTo(chatId).length < count && Date.now() < deadline) await sleep(20);
    return sendsTo(chatId);
};

const columnsOf = async (table: string): Promise<Map<string, { notnull: number; dflt_value: unknown }>> => {
    const rows: unknown[] = await sequelize.query(`PRAGMA table_info(${table})`, { type: QueryTypes.SELECT });
    const columns = new Map<string, { notnull: number; dflt_value: unknown }>();
    for (const row of rows) {
        if (typeof row !== 'object' || row === null) continue;
        const fields = Object.fromEntries(Object.entries(row));
        if (typeof fields.name === 'string') {
            columns.set(fields.name, { notnull: Number(fields.notnull), dflt_value: fields.dflt_value });
        }
    }
    return columns;
};

const tableExists = async (table: string): Promise<boolean> => {
    const rows: unknown[] = await sequelize.query(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${table}'`,
        { type: QueryTypes.SELECT }
    );
    return rows.length > 0;
};

const expectPanelColumns = async (label: string): Promise<void> => {
    const columns = await columnsOf('harness_issues');
    expect(columns.has('note') && columns.has('source') && columns.has('createdBy'), `${label}: note, source and createdBy exist`);
    const source = columns.get('source');
    expect(
        source?.notnull === 1 && String(source.dflt_value).includes('model'),
        `${label}: source is NOT NULL DEFAULT 'model' (got ${JSON.stringify(source)})`
    );
};

const userIssue = (chatId: number, userId: number, title: string, extra: { body?: string; severity?: 'low' | 'medium' | 'high' } = {}) =>
    service.createUserHarnessIssue({
        title,
        body: extra.body ?? `${title} 的正文`,
        kind: 'bug',
        severity: extra.severity ?? null,
        chatId,
        userId,
    });

const modelIssue = (chatId: number | null, title: string): Promise<HarnessIssueRecord> =>
    service.createHarnessIssue({ title, body: `${title} 的正文`, kind: 'improvement', chatId });

const app = makeApp({ notices: true, issueQuota: { limit: 1000, windowMs: 3_600_000 } });

/** Fixtures of the visibility cases, set up by the list case */
interface VisibilityFixture {
    a1: HarnessIssueRecord;
    a2: HarnessIssueRecord;
    a3: HarnessIssueRecord;
    b1: HarnessIssueRecord;
    b2: HarnessIssueRecord;
    alicePrivate: HarnessIssueRecord;
    bobPrivate: HarnessIssueRecord;
    noChat: HarnessIssueRecord;
    outside: HarnessIssueRecord;
}
let fixture: VisibilityFixture | undefined;
const visibility = (): VisibilityFixture => {
    if (fixture === undefined) throw new Error('the list case sets up the visibility fixture');
    return fixture;
};

// ---- cases ----------------------------------------------------------------

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'a fresh database gets the three columns from sync; the migration skips a missing table',
        body: async () => {
            await expectPanelColumns('fresh database');
            await sequelize.query('DROP TABLE harness_issues');
            await runSchemaMigrations();
            expect(!(await tableExists('harness_issues')), 'the migration does not create the table itself');
            await sequelize.sync();
            await expectPanelColumns('after sync');
        },
    },
    {
        name: 'an old table without the columns is migrated, and a second start changes nothing',
        body: async () => {
            await sequelize.query('DROP TABLE harness_issues');
            await sequelize.query(`
                CREATE TABLE harness_issues (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    status VARCHAR(255) NOT NULL DEFAULT 'open',
                    kind VARCHAR(255) NOT NULL,
                    severity VARCHAR(255) DEFAULT NULL,
                    title TEXT NOT NULL,
                    body TEXT NOT NULL,
                    toolName VARCHAR(255) DEFAULT NULL,
                    chatId INTEGER DEFAULT NULL,
                    createdAt DATETIME NOT NULL,
                    updatedAt DATETIME NOT NULL
                )`);
            await sequelize.query('CREATE INDEX harness_issues_status_created_at ON harness_issues (status, createdAt)');
            await sequelize.query(
                `INSERT INTO harness_issues (status, kind, title, body, chatId, createdAt, updatedAt)
                 VALUES ('fixed', 'bug', '旧条目', '旧正文', -100123,
                         '2026-11-04 10:00:00.000 +00:00', '2026-11-04 10:00:00.000 +00:00')`
            );
            const before = await columnsOf('harness_issues');
            expect(!before.has('note') && !before.has('source') && !before.has('createdBy'), 'the old table has none of them');

            await runSchemaMigrations();
            await expectPanelColumns('migrated');
            const legacy = await service.listHarnessIssues({ status: 'all' });
            const old = legacy.records.find((record) => record.title === '旧条目');
            expect(
                old?.source === 'model' && old.note === null && old.createdBy === null && old.status === 'fixed',
                `the old row reads as the model's, without note or creator (got ${JSON.stringify(old)})`
            );

            // A restart: migrations, then sync, as dbReady runs them
            await runSchemaMigrations();
            await sequelize.sync();
            expect((await columnsOf('harness_issues')).size === before.size + 3, 'still exactly three more columns');
            const applied: unknown[] = await sequelize.query(
                "SELECT name FROM schema_migrations WHERE name = '20261107_harness_issue_panel_columns'",
                { type: QueryTypes.SELECT }
            );
            expect(applied.length === 1, 'the migration is recorded once');

            const filed = await userIssue(GROUP_A, ALICE.id, '迁移后写入');
            expect(filed.source === 'user' && filed.createdBy === ALICE.id, 'the migrated table takes a person\'s issue');
            await service.clearHarnessIssues();
        },
    },
    {
        name: 'parseHarnessIssueInput: the tool and POST /api/issues accept and refuse the same input',
        body: async () => {
            await service.clearHarnessIssues();
            expect(getToolConfig().harnessIssues === false, 'HARNESS_ISSUES=0 switches the model\'s tools off here');
            const quietApp = makeApp({ issueQuota: { limit: 1000, windowMs: 3_600_000 } });
            const inputs: [string, Record<string, unknown>, string][] = [
                ['minimal', { title: '标题', body: '正文', kind: 'bug' }, 'ok'],
                ['with severity', { title: '标题', body: '正文', kind: 'feature', severity: 'high' }, 'ok'],
                ['padded strings', { title: '  标题  ', body: '\n正文\n', kind: ' improvement ', severity: ' low ' }, 'ok'],
                ['blank severity', { title: '标题', body: '正文', kind: 'bug', severity: '  ' }, 'ok'],
                ['null severity', { title: '标题', body: '正文', kind: 'bug', severity: null }, 'ok'],
                ['title of 200', { title: '题'.repeat(200), body: '正文', kind: 'bug' }, 'ok'],
                ['body of 4000', { title: '标题', body: '文'.repeat(4000), kind: 'bug' }, 'ok'],
                ['no title', { body: '正文', kind: 'bug' }, 'missing'],
                ['blank body', { title: '标题', body: '   ', kind: 'bug' }, 'missing'],
                ['title not a string', { title: 42, body: '正文', kind: 'bug' }, 'missing'],
                ['no kind', { title: '标题', body: '正文' }, 'missing'],
                ['title of 201', { title: '题'.repeat(201), body: '正文', kind: 'bug' }, 'title_too_long'],
                ['body of 4001', { title: '标题', body: '文'.repeat(4001), kind: 'bug' }, 'body_too_long'],
                ['unknown kind', { title: '标题', body: '正文', kind: 'question' }, 'bad_kind'],
                ['unknown severity', { title: '标题', body: '正文', kind: 'bug', severity: 'urgent' }, 'bad_severity'],
                ['severity not a string', { title: '标题', body: '正文', kind: 'bug', severity: 3 }, 'bad_severity'],
            ];
            for (const [label, input, expected] of inputs) {
                const parsed = parseHarnessIssueInput(input);
                const verdict = parsed.ok ? 'ok' : parsed.problem;
                const tool = createCreateHarnessIssueTool({ state: createHarnessIssueState(), chatId: GROUP_A });
                const toolResult = await tool.execute(input, new AbortController().signal);
                const response = await postIssue(quietApp, ALICE, { chatId: GROUP_A, ...input });
                const body = await jsonOf(response);
                const httpVerdict = response.status === 201 ? 'ok' : body?.error?.code;
                expect(
                    verdict === expected &&
                        toolResult.isError === (expected !== 'ok') &&
                        httpVerdict === (expected === 'ok' ? 'ok' : 'invalid'),
                    `${label}: parse ${verdict}, tool ${toolResult.isError ? 'refused' : 'accepted'}, HTTP ${response.status}`
                );
                if (expected !== 'ok' || !parsed.ok) continue;
                const stored = await HarnessIssue.findByPk(body.issue.id);
                expect(
                    stored?.title === parsed.value.title &&
                        stored.body === parsed.value.body &&
                        stored.kind === parsed.value.kind &&
                        (stored.severity ?? null) === parsed.value.severity &&
                        stored.source === 'user',
                    `${label}: HTTP stored the parsed fields`
                );
                const viaTool = await HarnessIssue.findOne({ where: { source: 'model' }, order: [['id', 'DESC']] });
                expect(
                    viaTool?.title === parsed.value.title && viaTool.kind === parsed.value.kind,
                    `${label}: the tool stored the same fields`
                );
            }
            await service.clearHarnessIssues();
        },
    },
    {
        name: "a person's issue on a group: the group gets the notice (text, entities, no reply, not stored)",
        body: async () => {
            const record = await userIssue(GROUP_A, ALICE.id, '/chat 链接拼接后编号错乱');
            const outcome = await notifyGroupOfUserIssue(telegram.api, record, { firstName: 'Mio', lastName: 'Akiyama' });
            expect(outcome === 'sent', `sent (got ${outcome})`);
            const sent = sendsTo(GROUP_A).at(-1);
            const payload = sent?.payload ?? {};
            const idText = `#${record.id}`;
            const expectedText = `📌 Mio Akiyama 通过控制面板提交了 issue ${idText}（bug）：/chat 链接拼接后编号错乱\n在面板中查看`;
            expect(payload.text === expectedText, `the text (got ${JSON.stringify(payload.text)})`);
            const expectedEntities = [
                { type: 'bold', offset: expectedText.indexOf(idText), length: idText.length },
                {
                    type: 'text_link',
                    offset: expectedText.indexOf('在面板中查看'),
                    length: '在面板中查看'.length,
                    url: `https://t.me/${BOT_USER_NAME}/panel?startapp=i${record.id}`,
                },
            ];
            expect(
                JSON.stringify(payload.entities) === JSON.stringify(expectedEntities),
                `bold #id and the Direct Link, in UTF-16 offsets (got ${JSON.stringify(payload.entities)})`
            );
            expect(
                JSON.stringify(payload.link_preview_options) === JSON.stringify({ is_disabled: true }),
                'no link preview'
            );
            expect(
                !('reply_parameters' in payload) && !('reply_to_message_id' in payload) && !('reply_markup' in payload),
                'an independent message: no reply, no buttons'
            );
            expect(!('parse_mode' in payload), 'entities, never a parse mode');
            expect((await Message.count({ where: { chatId: GROUP_A } })) === 0, 'nothing in telegram_messages');
            expect((await BotResponse.count({ where: { chatId: GROUP_A } })) === 0, 'nothing in bot_responses');

            const before = sendsTo(GROUP_A).length;
            const response = await postIssue(app, ALICE, { chatId: GROUP_A, kind: 'feature', title: '想要导出', body: '正文' });
            const created = await jsonOf(response);
            expect(response.status === 201, `POST answers 201 (got ${response.status})`);
            const sends = await waitForSends(GROUP_A, before + 1);
            const notice = String(sends.at(-1)?.payload.text ?? '');
            expect(
                sends.length === before + 1 &&
                    notice === `📌 Alice Liddell 通过控制面板提交了 issue #${created.issue.id}（feature）：想要导出\n在面板中查看`,
                `the HTTP path sends it after the 201, named without @username (got ${JSON.stringify(notice)})`
            );
        },
    },
    {
        name: 'no notice for private chats, the model\'s issues, issues without a chat, chats outside the allow-list or non-groups',
        body: async () => {
            const sendsBefore = telegram.callsOf('sendMessage').length;
            const name = { firstName: 'Alice', lastName: 'Liddell' };
            const orphanRow = await HarnessIssue.create({
                kind: 'bug',
                title: '无聊天',
                body: '正文',
                source: 'user',
                createdBy: ALICE.id,
            });
            const checks: [string, HarnessIssueRecord, string][] = [
                ['a private chat', await userIssue(ALICE.id, ALICE.id, '私聊里提的'), 'private_chat'],
                ["the model's issue on a group", await modelIssue(GROUP_A, '模型提的'), 'not_filed_by_user'],
                ['no chat', service.toHarnessIssueRecord(orphanRow), 'no_chat'],
                ['outside ALLOWED_CHAT_IDS', await userIssue(GROUP_OUTSIDE, ALICE.id, '白名单外'), 'chat_not_allowed'],
                ['a channel', await userIssue(CHANNEL, ALICE.id, '频道'), 'not_a_group'],
                ['a chat missing from the registry', await userIssue(UNKNOWN_GROUP, ALICE.id, '未登记'), 'not_a_group'],
            ];
            for (const [label, record, expected] of checks) {
                const outcome = await notifyGroupOfUserIssue(telegram.api, record, name);
                expect(outcome === expected, `${label}: ${expected} (got ${outcome})`);
            }
            expect(telegram.callsOf('sendMessage').length === sendsBefore, 'not one message was sent');

            const basic = await notifyGroupOfUserIssue(telegram.api, await userIssue(BASIC_GROUP, ALICE.id, '普通群'), name);
            expect(basic === 'sent' && sendsTo(BASIC_GROUP).length === 1, `a basic group is a group too (got ${basic})`);

            const privateFiled = await postIssue(app, ALICE, { chatId: ALICE.id, kind: 'bug', title: '私聊 HTTP', body: '正文' });
            expect(privateFiled.status === 201, `filing on one's own private chat works (got ${privateFiled.status})`);
            await sleep(300);
            expect(sendsTo(ALICE.id).length === 0, 'and sends nothing');
        },
    },
    {
        name: 'a paused group still gets the notice',
        body: async () => {
            await updateChatSettings({
                chatId: GROUP_PAUSED,
                patch: { paused: true },
                actor: { userId: ALICE.id, isOwner: false },
            });
            expect(isChatPaused(GROUP_PAUSED), 'the group is paused');
            const response = await postIssue(app, ALICE, { chatId: GROUP_PAUSED, kind: 'bug', title: '暂停中', body: '正文' });
            expect(response.status === 201, `filed (got ${response.status})`);
            const sends = await waitForSends(GROUP_PAUSED, 1);
            expect(sends.length === 1, 'the notice is not a reply: pausing does not stop it');
        },
    },
    {
        name: 'the owner is never messaged privately',
        body: async () => {
            const own = await postIssue(app, OWNER, { chatId: OWNER_ID, kind: 'bug', title: '机主私聊', body: '正文' });
            expect(own.status === 201, `the owner files on their own private chat (got ${own.status})`);
            const before = sendsTo(GROUP_A).length;
            const observed = await postIssue(app, OWNER, { chatId: GROUP_A, kind: 'bug', title: '机主观察的群', body: '正文' });
            expect(observed.status === 201, `and, as an observer, on a group (got ${observed.status})`);
            const groupSends = await waitForSends(GROUP_A, before + 1);
            expect(groupSends.length === before + 1, 'the group hears about the second');
            await sleep(300);
            const targets = telegram.callsOf('sendMessage').map((sent) => sent.payload.chat_id);
            expect(targets.length > 0 && targets.every((chatId) => typeof chatId === 'number' && chatId < 0), `every notice so far went to a group (got ${JSON.stringify(targets)})`);
            expect(!targets.includes(OWNER_ID), 'none went to the owner');
            expect(
                telegram.calls.every((sent) => !['sendMessage', 'sendPhoto', 'sendDocument'].includes(sent.method) || sent.payload.chat_id !== OWNER_ID),
                'no send of any kind to the owner'
            );
        },
    },
    {
        name: 'the list: a member sees only their chats\' issues and counts only those; the owner sees everything',
        body: async () => {
            await service.clearHarnessIssues();
            const a1 = await userIssue(GROUP_A, ALICE.id, '甲群 用户问题', { severity: 'high' });
            const a2 = await modelIssue(GROUP_A, '甲群 模型问题');
            await HarnessIssue.update({ status: 'fixed' }, { where: { id: a2.id } });
            const a3 = await userIssue(GROUP_A, ALICE.id, '进度 100%_完成 显示不对');
            const b1 = await userIssue(GROUP_B, BOB.id, '乙群 机密标题 secret_word', { body: '乙群正文 机密关键词' });
            const b2 = await modelIssue(GROUP_B, '乙群 模型问题');
            const alicePrivate = await modelIssue(ALICE.id, 'Alice 私聊里模型提的');
            const bobPrivate = await modelIssue(BOB.id, 'Bob 私聊里模型提的');
            const noChat = await modelIssue(null, '无聊天的条目');
            const outside = await userIssue(GROUP_OUTSIDE, ALICE.id, '白名单外的群');
            fixture = { a1, a2: { ...a2, status: 'fixed' }, a3, b1, b2, alicePrivate, bobPrivate, noChat, outside };

            const alice = await listIssues(app, ALICE);
            expect(
                sameIds(idsOf(alice), [alicePrivate.id, a3.id, a1.id, a2.id]),
                `Alice: her private chat and group A, open first then newest (got ${JSON.stringify(idsOf(alice))})`
            );
            expect(
                alice.matched === 4 && alice.nextOffset === null && alice.stats.total === 4 &&
                    alice.stats.byStatus.open === 3 && alice.stats.byStatus.fixed === 1,
                `Alice's counts cover only what she sees (got ${JSON.stringify({ matched: alice.matched, stats: alice.stats })})`
            );
            const row = alice.issues.find((issue: any) => issue.id === a1.id);
            expect(
                JSON.stringify(Object.keys(row).sort()) ===
                    JSON.stringify(['chat', 'createdAt', 'createdBy', 'hasNote', 'id', 'kind', 'severity', 'source', 'status', 'title', 'toolName', 'updatedAt']),
                `list row keys (got ${JSON.stringify(Object.keys(row))})`
            );
            expect(
                JSON.stringify(row.chat) === JSON.stringify({ chatId: GROUP_A, type: 'supergroup', title: 'Alpha', username: 'alpha_group' }) &&
                    JSON.stringify(row.createdBy) === JSON.stringify({ userId: ALICE.id, name: 'Alice Liddell' }) &&
                    row.source === 'user' && row.severity === 'high' && row.hasNote === false,
                `the row names its chat and creator (got ${JSON.stringify(row)})`
            );
            const modelRow = alice.issues.find((issue: any) => issue.id === a2.id);
            expect(modelRow.source === 'model' && modelRow.createdBy === null, "the model's issue has no creator");

            const bob = await listIssues(app, BOB);
            expect(
                sameIds(idsOf(bob), [bobPrivate.id, b2.id, b1.id]) && bob.stats.total === 3,
                `Bob: his private chat and group B (got ${JSON.stringify(idsOf(bob))})`
            );

            const owner = await listIssues(app, OWNER);
            expect(
                owner.stats.total === 9 && owner.matched === 9 && idsOf(owner).includes(noChat.id) && idsOf(owner).includes(outside.id),
                `the owner sees all nine, those without a chat included (got ${JSON.stringify(idsOf(owner))})`
            );
            expect(owner.issues.find((issue: any) => issue.id === noChat.id).chat === null, 'an issue without a chat has chat null');

            const carol = await listIssues(app, CAROL);
            expect(carol.issues.length === 0 && carol.stats.total === 0, 'Carol never spoke in group A: nothing without a hint');
            const viaNotice = await listIssues(app, CAROL, '', `i${a1.id}`);
            expect(
                sameIds(idsOf(viaNotice), [a3.id, a1.id, a2.id]),
                `through a notice link (i<N>) group A's issues appear (got ${JSON.stringify(idsOf(viaNotice))})`
            );
            const viaForeignNotice = await listIssues(app, CAROL, '', `i${b1.id}`);
            expect(viaForeignNotice.issues.length === 0, "a link into a chat she is not in shows nothing");
            const stranger = await listIssues(app, STRANGER, '', `c${GROUP_A}`);
            expect(stranger.issues.length === 0 && stranger.stats.total === 0, 'a stranger with a forged hint sees nothing');
        },
    },
    {
        name: 'the list filters, escapes the keyword, pages, and refuses malformed parameters',
        body: async () => {
            const { a1, a2, a3, alicePrivate } = visibility();
            const open = await listIssues(app, ALICE, '?status=open');
            expect(
                sameIds(idsOf(open), [alicePrivate.id, a3.id, a1.id]) && open.matched === 3 && open.stats.total === 4,
                `status filters the rows, not the counts (got ${JSON.stringify({ ids: idsOf(open), matched: open.matched, total: open.stats.total })})`
            );
            const fromPeople = await listIssues(app, ALICE, '?source=user');
            expect(
                sameIds(idsOf(fromPeople), [a3.id, a1.id]) && fromPeople.stats.total === 2,
                'source filters rows and counts'
            );
            const groupA = await listIssues(app, ALICE, `?chatId=${GROUP_A}`);
            expect(sameIds(idsOf(groupA), [a3.id, a1.id, a2.id]), 'chatId narrows to one chat');
            const foreign = await listIssues(app, ALICE, `?chatId=${GROUP_B}`);
            expect(foreign.issues.length === 0 && foreign.stats.total === 0, 'a chat she cannot see is simply empty');
            const severe = await listIssues(app, ALICE, '?severity=high&kind=bug');
            expect(sameIds(idsOf(severe), [a1.id]), 'severity and kind');
            const keyword = await listIssues(app, ALICE, `?q=${encodeURIComponent('甲群')}`);
            expect(sameIds(idsOf(keyword), [a1.id, a2.id]), 'the keyword matches titles');
            const inBody = await listIssues(app, ALICE, `?q=${encodeURIComponent('私聊里模型提的 的正文')}`);
            expect(sameIds(idsOf(inBody), [alicePrivate.id]), 'and bodies');
            for (const literal of ['%', '_', '0%_']) {
                const hits = await listIssues(app, ALICE, `?q=${encodeURIComponent(literal)}`);
                expect(sameIds(idsOf(hits), [a3.id]), `"${literal}" is matched literally (got ${JSON.stringify(idsOf(hits))})`);
            }
            const secret = await listIssues(app, ALICE, `?q=${encodeURIComponent('机密')}`);
            expect(secret.issues.length === 0 && secret.stats.total === 0, "another chat's keyword finds nothing");

            const first = await listIssues(app, ALICE, '?limit=1');
            const second = await listIssues(app, ALICE, '?limit=1&offset=1');
            const last = await listIssues(app, ALICE, '?limit=2&offset=2');
            expect(
                sameIds(idsOf(first), [alicePrivate.id]) && first.nextOffset === 1 &&
                    sameIds(idsOf(second), [a3.id]) && second.nextOffset === 2 &&
                    sameIds(idsOf(last), [a1.id, a2.id]) && last.nextOffset === null,
                'limit / offset page through, nextOffset null on the last page'
            );
            const beyond = await listIssues(app, ALICE, '?offset=50');
            expect(beyond.issues.length === 0 && beyond.nextOffset === null && beyond.matched === 4, 'past the end: empty page');

            for (const [label, query] of [
                ['a group status', '?status=closed'],
                ['an unknown kind', '?kind=question'],
                ['an unknown source', '?source=bot'],
                ['limit 0', '?limit=0'],
                ['limit 51', '?limit=51'],
                ['a negative offset', '?offset=-1'],
                ['a bad chat id', '?chatId=abc'],
                ['a keyword over 100 characters', `?q=${'k'.repeat(101)}`],
            ] as const) {
                await expectError(await call(app, `/api/issues${query}`, { user: ALICE }), 400, 'invalid', label);
            }
        },
    },
    {
        name: 'detail: an invisible issue is 404 like a missing one; one without a chat is the owner\'s alone',
        body: async () => {
            const { a1, b1, alicePrivate, noChat, outside } = visibility();
            const hidden = await call(app, `/api/issues/${b1.id}`, { user: ALICE });
            const hiddenBody = await jsonOf(hidden);
            const missing = await call(app, '/api/issues/999999', { user: ALICE });
            const missingBody = await jsonOf(missing);
            expect(
                hidden.status === 404 && missing.status === 404 && JSON.stringify(hiddenBody) === JSON.stringify(missingBody) &&
                    hiddenBody.error.code === 'not_found',
                `another chat's issue reads exactly like a missing one (got ${JSON.stringify(hiddenBody)})`
            );
            await expectError(await call(app, `/api/issues/${noChat.id}`, { user: ALICE }), 404, 'not_found', 'an issue without a chat, for a member');
            await expectError(await call(app, `/api/issues/${alicePrivate.id}`, { user: BOB }), 404, 'not_found', "someone else's private chat");
            await expectError(await call(app, `/api/issues/${outside.id}`, { user: ALICE }), 404, 'not_found', 'a chat outside the allow-list');
            await expectError(await call(app, '/api/issues/abc', { user: ALICE }), 400, 'invalid', 'a malformed id');

            const detail = await jsonOf(await call(app, `/api/issues/${a1.id}`, { user: ALICE }));
            const issue = detail.issue;
            expect(
                JSON.stringify(Object.keys(issue).sort()) ===
                    JSON.stringify(['body', 'chat', 'chatAccess', 'createdAt', 'createdBy', 'hasNote', 'id', 'kind', 'note', 'severity', 'source', 'status', 'title', 'toolName', 'updatedAt']),
                `detail keys (got ${JSON.stringify(Object.keys(issue))})`
            );
            expect(
                issue.body === '甲群 用户问题 的正文' && issue.note === null && issue.toolName === null && issue.source === 'user' &&
                    issue.chatAccess === 'member' && issue.chat.title === 'Alpha' && issue.chat.username === 'alpha_group' &&
                    issue.createdBy.name === 'Alice Liddell' && typeof issue.createdAt === 'string',
                `a member gets the full issue (got ${JSON.stringify(issue)})`
            );
            const ownPrivate = await jsonOf(await call(app, `/api/issues/${alicePrivate.id}`, { user: ALICE }));
            expect(ownPrivate.issue?.chatAccess === 'member', "the model's issue in her own private chat is hers");

            const ownerNoChat = await jsonOf(await call(app, `/api/issues/${noChat.id}`, { user: OWNER }));
            expect(ownerNoChat.issue?.chat === null && ownerNoChat.issue.chatAccess === null, 'the owner sees the one without a chat');
            const ownerObserved = await jsonOf(await call(app, `/api/issues/${b1.id}`, { user: OWNER }));
            expect(
                ownerObserved.issue?.chatAccess === 'observer' && ownerObserved.issue.createdBy.userId === BOB.id,
                'the owner observes group B and sees its issue with the creator'
            );
            const ownerOutside = await jsonOf(await call(app, `/api/issues/${outside.id}`, { user: OWNER }));
            expect(ownerOutside.issue?.chatAccess === 'none', 'the owner sees every issue; a blocked chat just does not open');
        },
    },
    {
        name: 'POST on a chat the user cannot see is 403 and files nothing',
        body: async () => {
            const before = await HarnessIssue.count();
            const valid = { kind: 'bug', title: '标题', body: '正文' };
            for (const [label, user, chatId] of [
                ['a group Alice left', ALICE, GROUP_B],
                ['a chat outside the allow-list', ALICE, GROUP_OUTSIDE],
                ['an unknown chat', ALICE, UNKNOWN_GROUP],
                ["someone else's private chat", ALICE, BOB.id],
                ['a stranger on group A', STRANGER, GROUP_A],
            ] as const) {
                await expectError(await postIssue(app, user, { chatId, ...valid }), 403, 'forbidden', label);
            }
            await expectError(
                await postIssue(app, ALICE, { chatId: GROUP_B, title: '', body: '', kind: 'nonsense' }),
                403,
                'forbidden',
                'access is checked before the fields'
            );
            for (const [label, body] of [
                ['no chatId', valid],
                ['a chatId of 0', { chatId: 0, ...valid }],
                ['a chatId that is not a number', { chatId: 'abc', ...valid }],
                ['an unknown key', { chatId: GROUP_A, ...valid, toolName: 'x' }],
            ] as const) {
                await expectError(await postIssue(app, ALICE, body), 400, 'invalid', label);
            }
            expect((await HarnessIssue.count()) === before, 'nothing was filed');
        },
    },
    {
        name: 'the sixth issue within an hour is 429 with Retry-After; refused requests cost nothing',
        body: async () => {
            clockMs = Date.now();
            const limitedApp = makeApp();
            const valid = { chatId: GROUP_A, kind: 'bug', title: '限流', body: '正文' };
            await expectError(await postIssue(limitedApp, ALICE, { ...valid, title: '' }), 400, 'invalid', 'an invalid one first');
            await expectError(await postIssue(limitedApp, ALICE, { ...valid, chatId: GROUP_B }), 403, 'forbidden', 'and a forbidden one');
            const statuses: number[] = [];
            const filedIds: number[] = [];
            const file = async (user: InitDataUserInput, body: Record<string, unknown>): Promise<Response> => {
                const response = await postIssue(limitedApp, user, body);
                if (response.status === 201) filedIds.push((await jsonOf(response.clone())).issue.id);
                return response;
            };
            for (let index = 0; index < 5; index += 1) {
                statuses.push((await file(ALICE, { ...valid, title: `限流 ${index + 1}` })).status);
            }
            expect(statuses.every((status) => status === 201), `five are filed (got ${JSON.stringify(statuses)})`);
            const before = await HarnessIssue.count();
            const sixth = await file(ALICE, { ...valid, title: '限流 6' });
            await expectError(sixth, 429, 'rate_limited', 'the sixth');
            const retryAfter = Number(sixth.headers.get('Retry-After'));
            expect(retryAfter >= 1 && retryAfter <= 3600, `Retry-After within the hour (got ${retryAfter})`);
            expect((await HarnessIssue.count()) === before, 'the sixth filed nothing');
            const bob = await file(BOB, { ...valid, chatId: GROUP_B });
            expect(bob.status === 201, `Bob has his own quota (got ${bob.status})`);

            clockMs += 30 * 60 * 1000;
            await expectError(await file(ALICE, valid), 429, 'rate_limited', 'half an hour later, still full');
            clockMs += 30 * 60 * 1000;
            const later = await file(ALICE, valid);
            expect(later.status === 201, `an hour after the first, there is room again (got ${later.status})`);
            clockMs = Date.now();
            // Leave the visibility fixture as it was for the cases after this one
            await HarnessIssue.destroy({ where: { id: filedIds } });
        },
    },
    {
        name: 'the owner triages: status and note are audited, unchanged values write nothing; others cannot',
        body: async () => {
            const { a1 } = visibility();
            const scope = `issue:${a1.id}`;
            const auditRows = () => SettingsAudit.findAll({ where: { scope }, order: [['id', 'ASC']] });
            const createRow = (await auditRows()).find((row) => row.key === 'create');
            expect(
                createRow?.actorId === ALICE.id &&
                    createRow.oldValue === null &&
                    createRow.newValue === JSON.stringify({ chatId: GROUP_A, kind: 'bug', title: '甲群 用户问题' }),
                `filing wrote the create entry (got ${createRow?.newValue})`
            );

            await expectError(await patchIssue(app, ALICE, a1.id, { status: 'fixed' }), 403, 'forbidden', 'a member');
            await expectError(await patchIssue(app, STRANGER, a1.id, { status: 'fixed' }), 403, 'forbidden', 'a stranger');

            const before = await HarnessIssue.findByPk(a1.id);
            await sleep(5);
            const triaged = await patchIssue(app, OWNER, a1.id, { status: 'triaged' });
            const triagedBody = await jsonOf(triaged);
            expect(triaged.status === 200 && triagedBody.issue.status === 'triaged', `the owner sets triaged (got ${triaged.status})`);
            expect(
                new Date(triagedBody.issue.updatedAt).getTime() > (before?.updatedAt.getTime() ?? Infinity),
                'updatedAt moves forward'
            );
            const noted = await jsonOf(await patchIssue(app, OWNER, a1.id, { note: '  已复现\r\n下个版本修  ' }));
            expect(noted.issue?.note === '已复现\n下个版本修' && noted.issue.hasNote === true, 'the note is stored normalized');

            const afterTwo = await auditRows();
            const statusRow = afterTwo.find((row) => row.key === 'status');
            const noteRow = afterTwo.find((row) => row.key === 'note');
            expect(
                statusRow?.actorId === OWNER_ID && statusRow.oldValue === 'open' && statusRow.newValue === 'triaged',
                'status: old / new status'
            );
            expect(noteRow?.oldValue === null && noteRow.newValue === '已复现\n下个版本修', 'note: the full text');

            const settled = await HarnessIssue.findByPk(a1.id);
            const same = await patchIssue(app, OWNER, a1.id, { status: 'triaged', note: '已复现\n下个版本修' });
            expect(same.status === 200, 'unchanged values: 200');
            expect((await auditRows()).length === afterTwo.length, 'and no audit entry');
            expect(
                (await HarnessIssue.findByPk(a1.id))?.updatedAt.getTime() === settled?.updatedAt.getTime(),
                'and updatedAt stays'
            );

            const cleared = await jsonOf(await patchIssue(app, OWNER, a1.id, { note: null }));
            expect(cleared.issue?.note === null, 'null clears the note');
            const clearRow = (await auditRows()).at(-1);
            expect(clearRow?.key === 'note' && clearRow.oldValue === '已复现\n下个版本修' && clearRow.newValue === null, 'audited as old text / NULL');

            for (const [label, body] of [
                ['a group status', { status: 'closed' }],
                ['a note over 4000', { note: 'n'.repeat(4001) }],
                ['a note of the wrong type', { note: 5 }],
                ['no key', {}],
                ['an unknown key', { status: 'fixed', title: 'x' }],
            ] as const) {
                await expectError(await patchIssue(app, OWNER, a1.id, body), 400, 'invalid', label);
            }
            await expectError(await patchIssue(app, OWNER, 999999, { status: 'fixed' }), 404, 'not_found', 'a missing issue');
            const wontfix = await jsonOf(await patchIssue(app, OWNER, a1.id, { status: 'wontfix' }));
            expect(wontfix.issue?.status === 'wontfix' && wontfix.issue.chatAccess === 'observer', 'any of the five statuses');
        },
    },
    {
        name: "the model sees its own issues and this chat's people's, never another chat's (rows, keyword, counts)",
        body: async () => {
            const { a1, a2, a3, b1, b2, alicePrivate, bobPrivate, noChat, outside } = visibility();
            const fromGroupA = await service.listHarnessIssues({ status: 'all', visibleInChatId: GROUP_A, limit: 50 });
            const visibleIds = fromGroupA.records.map((record) => record.id).sort((left, right) => left - right);
            const expectedIds = [a1.id, a2.id, a3.id, b2.id, alicePrivate.id, bobPrivate.id, noChat.id].sort((left, right) => left - right);
            expect(
                sameIds(visibleIds, expectedIds),
                `group A sees every model issue and its own people's (got ${JSON.stringify(visibleIds)})`
            );
            expect(!visibleIds.includes(b1.id) && !visibleIds.includes(outside.id), "not group B's or the outside group's");
            expect(fromGroupA.stats.total === expectedIds.length, `the counts use the same predicate (got ${fromGroupA.stats.total})`);
            const keyword = await service.listHarnessIssues({ status: 'all', visibleInChatId: GROUP_A, query: '机密' });
            expect(keyword.records.length === 0, "another chat's keyword finds nothing");
            const fromGroupB = await service.listHarnessIssues({ status: 'all', visibleInChatId: GROUP_B, query: '机密' });
            expect(fromGroupB.records.length === 1 && fromGroupB.records[0]?.id === b1.id, 'group B finds its own');

            const signal = new AbortController().signal;
            const tool = createListHarnessIssuesTool({ chatId: GROUP_A });
            const all = await tool.execute({ status: 'all', limit: 50 }, signal);
            expect(!all.isError && !all.content.includes('机密标题') && !all.content.includes('白名单外的群'), 'the tool shows no other chat\'s people\'s titles');
            expect(
                all.content.includes(`#${a3.id} [open][bug][user] 进度 100%_完成 显示不对`),
                `a person's issue is marked [user] (got ${all.content})`
            );
            expect(all.content.includes(`#${b2.id} [open][improvement] 乙群 模型问题`), "the model's issues stay unmarked, from any chat");
            expect(all.content.includes(`全部 ${expectedIds.length} 条`), 'the totals leave other chats\' people\'s issues out');
            const miss = await tool.execute({ status: 'all', query: 'secret_word' }, signal);
            expect(miss.content.includes('没有匹配的 issue'), `the keyword cannot reach them (got ${miss.content})`);
            const own = await createListHarnessIssuesTool({ chatId: GROUP_B }).execute({ status: 'all', query: 'secret_word' }, signal);
            expect(own.content.includes(`#${b1.id} [open][bug][user] 乙群 机密标题 secret_word`), 'replying in group B, it is listed');
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
reportResults(results);
