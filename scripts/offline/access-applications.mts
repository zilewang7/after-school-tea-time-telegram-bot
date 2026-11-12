/**
 * Offline cases for the access-application flow (design 2026-1112-1216, §6–§8):
 * the two new tables and their migration record, the service rules (field
 * limits, one pending application, review, revoke, audit), the delivery of the
 * decision / owner notice / revocation through a fake Bot API, the `/apply`
 * command end to end, and the panel API (owner review, applicant submission,
 * `/api/me` fields) through hono's `app.request()` with self-signed initData.
 *
 * Tiering is on (ACCESS_TIERS=1). ALLOWED_CHAT_IDS includes the chats whose
 * notices must go out and excludes one chat, so a delivery outside the
 * allow-list is exercised without a failing Bot API.
 *
 * Run: npx tsx scripts/offline/access-applications.mts
 */
import { QueryTypes } from '@sequelize/core';
import { Api, GrammyError, type Bot, type Transformer } from 'grammy';
import { expect, reportResults, runCase, setupOfflineDb, takeMessageId, type CaseResult } from './harness.mts';
import {
    createFakeBot,
    createFakeTelegram,
    messageUpdate,
    quietly,
    waitUntil,
    type FakeTelegram,
    type TelegramCall,
} from './fake-telegram.mts';
import { signInitData, type InitDataUserInput } from '../lib/init-data.mts';

// Tiering is off in the harness by default; this file is about the tier feature.
process.env.ACCESS_TIERS = '1';

const OWNER_ID = 4242;
/** A positive TOOL_CHAT_IDS entry: full without any application */
const FULL_USER_ID = 5151;
/** The group a command application is filed in; notices to it are allowed */
const APP_CHAT = -1005555000001;
/** Deliberately outside ALLOWED_CHAT_IDS: a decision there cannot be delivered */
const EXCLUDED_CHAT = -1005555000002;
const COMMAND_CHAT = -1005555000003;

// Trial users, one per case so their pending/approved rows never interfere
const ALICE_ID = 6001;
const BOB_ID = 6002;
const CAROL_ID = 6003;
const DAVE_ID = 6004;
const EVE_ID = 6005;
const FRANK_ID = 6006;
const GRACE_ID = 6007;
const IVAN_ID = 6008;
const JUDY_ID = 6009;
const HENRY_ID = 6010;
const KATE_ID = 6020;
const LUCY_ID = 6021;
const NINA_ID = 6022;

// Panel identities (the initData user ids are what the panel authorizes)
const PANEL_TRIAL: InitDataUserInput = { id: 6101, first_name: 'Trial', username: 'trial_user' };
const PANEL_TRIAL_2: InitDataUserInput = { id: 6102, first_name: 'Second' };
const PANEL_FULL: InitDataUserInput = { id: 6103, first_name: 'Full' };
const OWNER: InitDataUserInput = { id: OWNER_ID, first_name: 'Owner', username: 'the_owner' };
const BOT_TOKEN = '123456789:AAFakeOfflineTokenForAccessTests_0123';

process.env.OWNER_USER_ID = String(OWNER_ID);
process.env.TOOL_CHAT_IDS = `${FULL_USER_ID}, ${PANEL_FULL.id}`;
process.env.ALLOWED_CHAT_IDS = [
    OWNER_ID,
    FULL_USER_ID,
    APP_CHAT,
    COMMAND_CHAT,
    ALICE_ID,
    BOB_ID,
    CAROL_ID,
    DAVE_ID,
    EVE_ID,
    FRANK_ID,
    GRACE_ID,
    IVAN_ID,
    JUDY_ID,
    HENRY_ID,
    KATE_ID,
    LUCY_ID,
    NINA_ID,
    PANEL_TRIAL.id,
    PANEL_TRIAL_2.id,
    PANEL_FULL.id,
].join(',');
process.env.BOT_USER_NAME = 'AfterSchoolTeatimeBot';
delete process.env.WEBAPP_BOT_SHORT_NAME;
process.env.BOT_USER_ID = '7777';
process.env.BOT_NAME = 'Bot';
process.env.DEFAULT_MODEL = 'gemini-4-argon';

const db = await setupOfflineDb();
const { Message } = db;

const { sequelize } = await import('../../src/db/config.js');
const { AccessApplication } = await import('../../src/db/accessApplicationDTO.js');
const { UserAccess } = await import('../../src/db/userAccessDTO.js');
const { listSettingsAudit } = await import('../../src/db/queries/settings-audit.js');
const { resolveAccessTier } = await import('../../src/services/access-tier.js');
const {
    isUserAccessCacheLoaded,
    latestApplicationOf,
    loadUserAccessCache,
} = await import('../../src/services/user-access-cache.js');
const service = await import('../../src/services/user-access-service.js');
const {
    notifyApplicantOfDecision,
    notifyApplicantOfRevoke,
    notifyOwnerOfApplication,
} = await import('../../src/services/access-application-notify.js');
const { registerApplyCommand } = await import('../../src/cmd/commands/apply.js');
const { createPanelApp } = await import('../../src/panel/app.js');

type PanelApp = ReturnType<typeof createPanelApp>;
type MembershipLookup = import('../../src/panel/access/membership.js').MembershipLookup;
type AccessApplicationRecord = import('../../src/services/user-access-service.js').AccessApplicationRecord;

const {
    AccessApplicationError,
    countPendingApplications,
    createAccessApplication,
    findAccessApplication,
    listAccessApplications,
    listAccessApplicationsByUser,
    markApplicationDelivery,
    normalizeAccessApplicationFields,
    normalizeReviewComment,
    reviewAccessApplication,
    revokeUserAccess,
    toAccessApplicationRecord,
} = service;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : {};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The code of an AccessApplicationError a call throws, or 'none' */
const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
    try {
        await run();
        return 'none';
    } catch (error) {
        if (error instanceof AccessApplicationError) return error.code;
        throw error;
    }
};

interface ApplicationFields {
    identity?: unknown;
    purpose?: unknown;
    chatId?: number;
    messageId?: number | null;
    source?: 'command' | 'miniapp';
}

/** File one application for a trial user, with the usual fixture text */
const fileApplication = (userId: number, fields: ApplicationFields = {}): Promise<AccessApplicationRecord> =>
    createAccessApplication({
        userId,
        chatId: fields.chatId ?? APP_CHAT,
        messageId: fields.messageId === undefined ? 900_000 + userId : fields.messageId,
        identity: fields.identity === undefined ? '我是黑猫的朋友' : fields.identity,
        purpose: fields.purpose === undefined ? '想用 gpt 生图和更强的模型' : fields.purpose,
        source: fields.source ?? 'command',
    });

const auditOf = (scope: string) => listSettingsAudit({ scope, limit: 100 });

const sendsTo = (telegram: FakeTelegram, chatId: number): TelegramCall[] =>
    telegram.callsOf('sendMessage').filter((call) => call.payload.chat_id === chatId);

const lastSentTextTo = (telegram: FakeTelegram, chatId: number): string => {
    const call = sendsTo(telegram, chatId).at(-1);
    return typeof call?.payload.text === 'string' ? call.payload.text : '';
};

/** The reply_parameters.message_id of the last send to a chat, or undefined */
const replyToOf = (telegram: FakeTelegram, chatId: number): unknown =>
    asRecord(sendsTo(telegram, chatId).at(-1)?.payload.reply_parameters).message_id;

/**
 * Poll until the delivery outcome is written: the panel routes answer before
 * the send runs, so the row's deliveryStatus appears a moment after the message.
 */
const waitForDelivery = async (applicationId: number): Promise<AccessApplicationRecord | null> => {
    const deadline = Date.now() + 5000;
    for (;;) {
        const record = await findAccessApplication(applicationId);
        if (record?.deliveryStatus !== null && record?.deliveryStatus !== undefined) return record;
        if (Date.now() >= deadline) return record;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
};

/** A message from `userId` through a bot, keeping the console quiet */
const sendText = async (bot: Bot, chatId: number, userId: number, text: string): Promise<void> => {
    await quietly(() =>
        bot.handleUpdate(messageUpdate({ chatId, messageId: takeMessageId(), userId, text }))
    );
};

// ---------------------------------------------------------------------------
// The panel app: self-signed initData, a membership lookup that never matches
// ---------------------------------------------------------------------------

const clockMs = Date.now();
const nowSeconds = (): number => Math.floor(clockMs / 1000);

const grammyError = (code: number, description: string): GrammyError =>
    new GrammyError(`(${code}: ${description})`, { ok: false, error_code: code, description }, 'getChatMember', {});

/** No group is registered in these cases; anything asked is "not a member" */
const fakeLookup: MembershipLookup = async () => {
    throw grammyError(400, 'Bad Request: user not found');
};

const telegram: FakeTelegram = createFakeTelegram();

const makeApp = (): PanelApp =>
    createPanelApp({
        botToken: BOT_TOKEN,
        membershipLookup: fakeLookup,
        staticRoot: '/nonexistent-static-root',
        startedAt: new Date('2026-11-12T00:00:00.000Z'),
        version: 'abc1234',
        now: () => clockMs,
        // Plenty for the handful of requests this file makes
        rateLimit: { limit: 10_000, windowMs: 60_000 },
        botApi: telegram.api,
    });

interface CallOptions {
    method?: string;
    user?: InitDataUserInput;
    body?: unknown;
}

const call = (app: PanelApp, path: string, options: CallOptions = {}): Promise<Response> => {
    const headers = new Headers();
    if (options.user !== undefined) {
        headers.set(
            'X-Init-Data',
            signInitData({ botToken: BOT_TOKEN, user: options.user, authDate: nowSeconds() })
        );
    }
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    return Promise.resolve(app.request(path, { method: options.method ?? 'GET', headers, body }));
};

const jsonOf = async (response: Response): Promise<any> => {
    const text = await response.text();
    try {
        return JSON.parse(text);
    } catch {
        return { notJson: text };
    }
};

const expectError = async (response: Response, status: number, code: string, label: string): Promise<void> => {
    const body = await jsonOf(response);
    const actual = body?.error?.code ?? '-';
    expect(response.status === status && actual === code, `${label} → ${status} ${code} (got ${response.status} ${actual})`);
};

const waitForSend = (chatId: number, timeoutMs = 5000): Promise<void> =>
    waitUntil(`a notice to chat ${chatId}`, () => sendsTo(telegram, chatId).length > 0, timeoutMs);

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

await loadUserAccessCache();
expect(isUserAccessCacheLoaded(), 'the tier cache is loaded, like the bot startup does');

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'a fresh database gets both tables from sync and the migration record',
        body: async () => {
            const tableExists = async (table: string): Promise<boolean> => {
                const rows: unknown[] = await sequelize.query(
                    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${table}'`,
                    { type: QueryTypes.SELECT }
                );
                return rows.length > 0;
            };
            const columnsOf = async (table: string): Promise<Map<string, { notnull: number; dflt_value: unknown; pk: number }>> => {
                const rows: unknown[] = await sequelize.query(`PRAGMA table_info(${table})`, { type: QueryTypes.SELECT });
                const columns = new Map<string, { notnull: number; dflt_value: unknown; pk: number }>();
                for (const row of rows) {
                    const fields = asRecord(row);
                    if (typeof fields.name !== 'string') continue;
                    columns.set(fields.name, {
                        notnull: Number(fields.notnull),
                        dflt_value: fields.dflt_value,
                        pk: Number(fields.pk),
                    });
                }
                return columns;
            };

            expect(await tableExists('access_applications'), 'access_applications exists');
            expect(await tableExists('user_access'), 'user_access exists');

            const applications = await columnsOf('access_applications');
            const expectedApplicationColumns = [
                'id',
                'userId',
                'chatId',
                'messageId',
                'identity',
                'purpose',
                'source',
                'status',
                'comment',
                'reviewedBy',
                'reviewedAt',
                'deliveryStatus',
                'deliveryError',
                'createdAt',
                'updatedAt',
            ];
            expect(
                JSON.stringify([...applications.keys()]) === JSON.stringify(expectedApplicationColumns),
                `the columns match the DTO (got ${JSON.stringify([...applications.keys()])})`
            );
            expect(applications.get('id')?.pk === 1, 'id is the primary key column');
            for (const required of ['userId', 'chatId', 'identity', 'purpose', 'createdAt', 'updatedAt']) {
                expect(applications.get(required)?.notnull === 1, `${required} is NOT NULL`);
            }
            for (const nullable of ['messageId', 'comment', 'reviewedBy', 'reviewedAt', 'deliveryStatus', 'deliveryError']) {
                expect(applications.get(nullable)?.notnull === 0, `${nullable} is nullable`);
            }
            expect(String(applications.get('source')?.dflt_value).includes('command'), "source defaults to 'command'");
            expect(String(applications.get('status')?.dflt_value).includes('pending'), "status defaults to 'pending'");

            const grants = await columnsOf('user_access');
            expect(
                JSON.stringify([...grants.keys()]) === JSON.stringify([
                    'userId',
                    'source',
                    'applicationId',
                    'grantedBy',
                    'grantedAt',
                    'updatedAt',
                ]),
                `user_access columns match the DTO (got ${JSON.stringify([...grants.keys()])})`
            );
            expect(grants.get('userId')?.pk === 1, 'userId is the primary key column');
            expect(String(grants.get('source')?.dflt_value).includes('application'), "source defaults to 'application'");
            for (const required of ['grantedAt', 'updatedAt']) {
                expect(grants.get(required)?.notnull === 1, `${required} is NOT NULL`);
            }

            const applied: unknown[] = await sequelize.query(
                "SELECT name FROM schema_migrations WHERE name = '20261112_user_access'",
                { type: QueryTypes.SELECT }
            );
            expect(applied.length === 1, 'schema_migrations records 20261112_user_access once');
        },
    },
    {
        name: 'an application is stored trimmed, with its source, and remembered in the cache',
        body: async () => {
            const record = await fileApplication(ALICE_ID, {
                messageId: 555,
                identity: '  我是黑猫的朋友  ',
                purpose: ' 想用 gpt 生图  ',
                source: 'command',
            });
            expect(record.identity === '我是黑猫的朋友', `identity is trimmed (got ${JSON.stringify(record.identity)})`);
            expect(record.purpose === '想用 gpt 生图', `purpose is trimmed (got ${JSON.stringify(record.purpose)})`);
            expect(record.source === 'command' && record.status === 'pending', 'source and status are stored');
            expect(record.chatId === APP_CHAT && record.messageId === 555, 'chat and message ids are stored');
            expect(record.reviewedBy === null && record.comment === null && record.reviewedAt === null, 'nothing reviewed yet');
            expect(record.deliveryStatus === null && record.deliveryError === null, 'nothing delivered yet');
            expect((await resolveAccessTier(ALICE_ID)) === 'trial', 'filing does not grant the full tier');
            expect(latestApplicationOf(ALICE_ID)?.id === record.id, 'the cache remembers the application');

            const audits = await auditOf(`access:${record.id}`);
            const created = audits.find((entry) => entry.key === 'create');
            expect(created?.actorId === ALICE_ID, 'an audit row records who filed it');
            expect(
                created?.newValue !== null && created?.newValue !== undefined && created.newValue.includes('command'),
                `and the source (got ${JSON.stringify(created?.newValue)})`
            );
        },
    },
    {
        name: 'a second pending application is refused; a full user needs none',
        body: async () => {
            expect((await codeOf(() => fileApplication(ALICE_ID))) === 'pending', 'the second pending application is refused');
            const pendingRows = await AccessApplication.count({ where: { userId: ALICE_ID, status: 'pending' } });
            expect(pendingRows === 1, `only one pending row exists (got ${pendingRows})`);
            expect((await codeOf(() => fileApplication(FULL_USER_ID))) === 'already_full', 'a full user is refused with already_full');
        },
    },
    {
        name: 'invalid application fields and review comments are refused with invalid',
        body: async () => {
            expect((await codeOf(() => fileApplication(BOB_ID, { identity: '' }))) === 'invalid', 'an empty identity is invalid');
            expect((await codeOf(() => fileApplication(BOB_ID, { identity: '   ' }))) === 'invalid', 'whitespace is invalid');
            expect(
                (await codeOf(() => fileApplication(BOB_ID, { identity: 'x'.repeat(501) }))) === 'invalid',
                'an identity over 500 code points is invalid'
            );
            expect(
                (await codeOf(() => fileApplication(BOB_ID, { purpose: 'y'.repeat(1001) }))) === 'invalid',
                'a purpose over 1000 code points is invalid'
            );
            expect((await codeOf(() => fileApplication(BOB_ID, { purpose: 42 }))) === 'invalid', 'a non-string field is invalid');

            // The pure normalizers carry the same rules for both entry points
            const normalized = normalizeAccessApplicationFields({ identity: ' 我 ', purpose: ' 画画 ' });
            expect(normalized.identity === '我' && normalized.purpose === '画画', 'fields normalize');
            expect(normalizeReviewComment(undefined) === null, 'a missing comment is none');
            expect(normalizeReviewComment('   ') === null, 'a blank comment is none');
            expect(normalizeReviewComment('  好的  ') === '好的', 'a comment is trimmed');
            let commentCode = 'none';
            try {
                normalizeReviewComment('z'.repeat(501));
            } catch (error) {
                if (error instanceof AccessApplicationError) commentCode = error.code;
                else throw error;
            }
            expect(commentCode === 'invalid', 'an over-long comment is invalid');
        },
    },
    {
        name: 'approving writes the grant in the same transaction, audits it and makes the user full',
        body: async () => {
            const pending = latestApplicationOf(ALICE_ID);
            if (pending === null) throw new Error('the first case left no application');
            const approved = await reviewAccessApplication({
                applicationId: pending.id,
                action: 'approve',
                comment: '  欢迎使用  ',
                actorId: OWNER_ID,
            });
            expect(approved.status === 'approved', 'the status is approved');
            expect(approved.comment === '欢迎使用', 'the comment is trimmed and stored');
            expect(approved.reviewedBy === OWNER_ID && approved.reviewedAt instanceof Date, 'the reviewer and time are stored');

            const grant = await UserAccess.findByPk(ALICE_ID);
            expect(grant !== null, 'a user_access row is written');
            expect(grant?.source === 'application' && grant.applicationId === approved.id, 'pointing at the application');
            expect(grant?.grantedBy === OWNER_ID, 'by the owner');
            expect((await resolveAccessTier(ALICE_ID)) === 'full', 'the cache makes the user full right away');
            expect(latestApplicationOf(ALICE_ID)?.status === 'approved', 'the cache latest application is approved');

            const audits = await auditOf(`access:${approved.id}`);
            expect(audits.some((entry) => entry.key === 'approve' && entry.newValue === 'approved'), 'the decision is audited');
            expect(audits.some((entry) => entry.key === 'comment' && entry.newValue === '欢迎使用'), 'the comment is audited');
        },
    },
    {
        name: 'a rejection keeps the user trial and can be followed by a new application',
        body: async () => {
            const first = await fileApplication(BOB_ID);
            const rejected = await reviewAccessApplication({
                applicationId: first.id,
                action: 'reject',
                comment: '请补充身份',
                actorId: OWNER_ID,
            });
            expect(rejected.status === 'rejected' && rejected.comment === '请补充身份', 'the rejection and comment are stored');
            expect((await UserAccess.findByPk(BOB_ID)) === null, 'no grant is written');
            expect((await resolveAccessTier(BOB_ID)) === 'trial', 'the user stays trial');
            expect(latestApplicationOf(BOB_ID)?.status === 'rejected', 'the cache shows the rejection');
            expect(latestApplicationOf(BOB_ID)?.comment === '请补充身份', 'with the owner comment');
            const audits = await auditOf(`access:${first.id}`);
            expect(audits.some((entry) => entry.key === 'reject' && entry.newValue === 'rejected'), 'the rejection is audited');

            // A decided application does not block a new one (design D9)
            const second = await fileApplication(BOB_ID, { purpose: '补充：用来做海报' });
            expect(second.id > first.id, 'a new row is filed');
            expect(latestApplicationOf(BOB_ID)?.id === second.id, 'and becomes the latest');
            expect(latestApplicationOf(BOB_ID)?.status === 'pending', 'pending again');
        },
    },
    {
        name: 'reviewing twice, or a missing application, is refused with the right code',
        body: async () => {
            const approved = latestApplicationOf(ALICE_ID);
            if (approved === null) throw new Error('the approve case left no application');
            expect(
                (await codeOf(() =>
                    reviewAccessApplication({ applicationId: approved.id, action: 'reject', comment: null, actorId: OWNER_ID })
                )) === 'decided',
                'a decided application cannot be reviewed again'
            );
            expect(
                (await codeOf(() =>
                    reviewAccessApplication({ applicationId: 999_999, action: 'approve', comment: null, actorId: OWNER_ID })
                )) === 'not_found',
                'an unknown id is not_found'
            );
            expect(
                (await codeOf(() =>
                    reviewAccessApplication({
                        applicationId: approved.id,
                        action: 'approve',
                        comment: 'q'.repeat(501),
                        actorId: OWNER_ID,
                    })
                )) === 'invalid',
                'an over-long comment is invalid'
            );
        },
    },
    {
        name: 'revoking removes the grant, audits it and returns the user to trial',
        body: async () => {
            const result = await revokeUserAccess({ userId: ALICE_ID, actorId: OWNER_ID });
            expect(result.userId === ALICE_ID, 'the revoked user is returned');
            expect(result.lastApproved?.status === 'approved', 'with the last approved application for the notice target');
            expect((await UserAccess.findByPk(ALICE_ID)) === null, 'the grant row is gone');
            expect((await resolveAccessTier(ALICE_ID)) === 'trial', 'the user is trial again');
            const audits = await auditOf(`user-access:${ALICE_ID}`);
            expect(
                audits.some((entry) => entry.key === 'revoke' && entry.newValue === 'revoked'),
                'the revocation is audited'
            );
            expect((await codeOf(() => revokeUserAccess({ userId: ALICE_ID, actorId: OWNER_ID }))) === 'not_admitted', 'a second revoke is not_admitted');
            expect((await codeOf(() => revokeUserAccess({ userId: EVE_ID, actorId: OWNER_ID }))) === 'not_admitted', 'a never-admitted user is not_admitted');
        },
    },
    {
        name: 'counts and lists follow the pending state and a user history',
        body: async () => {
            const before = await countPendingApplications();
            const carol = await fileApplication(CAROL_ID);
            expect((await countPendingApplications()) === before + 1, 'a new pending application raises the count');

            const pendingPage = await listAccessApplications({ status: 'pending', limit: 100 });
            expect(pendingPage.records.some((record) => record.id === carol.id), 'the default list shows it');
            expect(pendingPage.pending === before + 1, 'the stats pending count matches');
            const allPage = await listAccessApplications({ status: 'all', limit: 100 });
            expect(allPage.matched > pendingPage.matched, 'the all list is larger than the pending one');

            const history = await listAccessApplicationsByUser(BOB_ID);
            const [newest, oldest] = history;
            expect(
                history.length === 2 && newest !== undefined && oldest !== undefined && newest.id > oldest.id,
                'a user history is newest first'
            );
            expect((await findAccessApplication(carol.id))?.identity === '我是黑猫的朋友', 'a record can be found by id');
            expect((await findAccessApplication(999_999)) === null, 'and an unknown id is null');
            const carolRow = await AccessApplication.findByPk(carol.id);
            if (carolRow === null) throw new Error('the carol application disappeared');
            const mapped = toAccessApplicationRecord(carolRow);
            expect(mapped.id === carol.id && mapped.source === 'command', 'the DTO maps to the record shape');
        },
    },
    {
        name: 'the decision notice goes to the application chat, replies to its message and is recorded as sent',
        body: async () => {
            const carol = latestApplicationOf(CAROL_ID);
            if (carol === null) throw new Error('the counts case left no application');
            const carolRecord = await findAccessApplication(carol.id);
            if (carolRecord === null) throw new Error('the carol application disappeared');
            const approved = await reviewAccessApplication({
                applicationId: carol.id,
                action: 'approve',
                comment: '好的',
                actorId: OWNER_ID,
            });
            telegram.reset();
            await notifyApplicantOfDecision(telegram.api, approved);

            expect(sendsTo(telegram, APP_CHAT).length === 1, 'one message went to the application chat');
            const text = lastSentTextTo(telegram, APP_CHAT);
            expect(text.includes('已通过') && text.includes('机主留言：') && text.includes('好的'), `it says approved with the comment (got ${JSON.stringify(text)})`);
            expect(
                replyToOf(telegram, APP_CHAT) === carolRecord.messageId,
                'it replies to the message that filed the application'
            );

            const botRows = await Message.findAll({ where: { chatId: APP_CHAT, fromBotSelf: true } });
            expect(botRows.length > 0, 'the notice is stored as a bot message row');
            const stored = botRows.at(-1);
            expect(stored?.replyToId === carolRecord.messageId, 'answering the application message');
            expect(stored?.text === text, 'with the text it sent');

            const delivered = await findAccessApplication(approved.id);
            expect(delivered?.deliveryStatus === 'sent' && delivered.deliveryError === null, 'the delivery outcome is written back');
        },
    },
    {
        name: 'a rejected decision tells the user why, with the re-apply path',
        body: async () => {
            const nina = await fileApplication(NINA_ID);
            const rejected = await reviewAccessApplication({
                applicationId: nina.id,
                action: 'reject',
                comment: '请说明身份',
                actorId: OWNER_ID,
            });
            telegram.reset();
            await notifyApplicantOfDecision(telegram.api, rejected);
            expect(sendsTo(telegram, APP_CHAT).length === 1, 'one message went to the application chat');
            const text = lastSentTextTo(telegram, APP_CHAT);
            expect(text.includes('未通过'), `it says the application failed (got ${JSON.stringify(text)})`);
            expect(text.includes('机主留言：请说明身份'), 'it carries the owner comment');
            expect(text.includes('/apply') && text.includes('Mini App'), 'and both ways to apply again');
            expect(replyToOf(telegram, APP_CHAT) === nina.messageId, 'replying to the application message');
            expect((await findAccessApplication(nina.id))?.deliveryStatus === 'sent', 'the delivery is marked sent');
        },
    },
    {
        name: 'a Bot API failure while delivering a decision is recorded, never thrown',
        body: async () => {
            const bob = (await listAccessApplicationsByUser(BOB_ID)).find((record) => record.status === 'rejected');
            if (bob === undefined) throw new Error('the rejection case left no rejected application');
            const failing = new Api('0:offline-token');
            const failingTransformer: Transformer = () => {
                throw new GrammyError(
                    'Call to sendMessage failed with 403: Forbidden: bot was blocked by the user',
                    { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
                    'sendMessage',
                    {}
                );
            };
            failing.config.use(failingTransformer);
            await notifyApplicantOfDecision(failing, bob);
            const failed = await findAccessApplication(bob.id);
            expect(failed?.deliveryStatus === 'failed', 'the delivery is marked failed');
            const errorText = failed?.deliveryError ?? '';
            expect(errorText.includes('403'), `with the Bot API error (got ${JSON.stringify(errorText)})`);
        },
    },
    {
        name: 'a decision for a chat outside the allow-list is recorded as failed and never thrown',
        body: async () => {
            const dave = await fileApplication(DAVE_ID, { chatId: EXCLUDED_CHAT });
            const approved = await reviewAccessApplication({
                applicationId: dave.id,
                action: 'approve',
                comment: null,
                actorId: OWNER_ID,
            });
            telegram.reset();
            await notifyApplicantOfDecision(telegram.api, approved);
            expect(sendsTo(telegram, EXCLUDED_CHAT).length === 0, 'nothing is sent to the excluded chat');
            const failed = await findAccessApplication(dave.id);
            expect(failed?.deliveryStatus === 'failed', 'the delivery is marked failed');
            expect(
                failed?.deliveryError !== null && failed?.deliveryError.includes('允许列表'),
                `with the reason (got ${JSON.stringify(failed?.deliveryError)})`
            );
        },
    },
    {
        name: 'markApplicationDelivery records a resend outcome',
        body: async () => {
            const henry = await fileApplication(HENRY_ID);
            await markApplicationDelivery({ applicationId: henry.id, status: 'failed', error: '403 Forbidden' });
            const failed = await findAccessApplication(henry.id);
            expect(failed?.deliveryStatus === 'failed' && failed.deliveryError === '403 Forbidden', 'a failure is recorded');
            await markApplicationDelivery({ applicationId: henry.id, status: 'sent', error: null });
            const sent = await findAccessApplication(henry.id);
            expect(sent?.deliveryStatus === 'sent' && sent.deliveryError === null, 'a later success clears the error');
        },
    },
    {
        name: 'the owner is told about a new application, with who filed it and why',
        body: async () => {
            const ivan = await fileApplication(IVAN_ID, {
                identity: '我是测试群里的 Ivan',
                purpose: '想用更强的模型',
            });
            telegram.reset();
            await notifyOwnerOfApplication(telegram.api, ivan);
            expect(sendsTo(telegram, OWNER_ID).length === 1, 'one message went to the owner');
            const text = lastSentTextTo(telegram, OWNER_ID);
            expect(text.includes('新准入申请') && text.includes(`#${ivan.id}`), 'it names the application');
            expect(text.includes(`id ${IVAN_ID}`), 'and the applicant id');
            expect(text.includes('我是测试群里的 Ivan') && text.includes('想用更强的模型'), 'and both answers');
            expect(text.includes('来源：'), 'and where it came from');

            const call = sendsTo(telegram, OWNER_ID).at(-1);
            const link = asArray(call?.payload.entities)
                .map(asRecord)
                .find((entity) => entity.type === 'text_link');
            expect(
                link?.url === 'https://t.me/AfterSchoolTeatimeBot/panel',
                `the Mini App link rides along (got ${JSON.stringify(link?.url)})`
            );
            const stored = await Message.findOne({ where: { chatId: OWNER_ID, fromBotSelf: true } });
            expect(stored?.text === text, 'the notice is stored as a bot row in the owner chat');
        },
    },
    {
        name: 'a revocation tells the user, in the last approved application chat',
        body: async () => {
            const ivan = latestApplicationOf(IVAN_ID);
            if (ivan === null) throw new Error('the owner notice case left no application');
            const approved = await reviewAccessApplication({
                applicationId: ivan.id,
                action: 'approve',
                comment: null,
                actorId: OWNER_ID,
            });
            const result = await revokeUserAccess({ userId: IVAN_ID, actorId: OWNER_ID });
            telegram.reset();
            await notifyApplicantOfRevoke(telegram.api, IVAN_ID, result.lastApproved);
            expect(sendsTo(telegram, APP_CHAT).length === 1, 'the message goes to the application chat');
            expect(replyToOf(telegram, APP_CHAT) === approved.messageId, 'replying to the application message');
            const text = lastSentTextTo(telegram, APP_CHAT);
            expect(text.includes('取消') && text.includes('重新提交申请'), `it says the grant is gone (got ${JSON.stringify(text)})`);

            // Without a known application the user's private chat is the target
            telegram.reset();
            await notifyApplicantOfRevoke(telegram.api, EVE_ID, null);
            expect(sendsTo(telegram, EVE_ID).length === 1, 'a user without an approved application gets a private message');
        },
    },
    {
        name: '/apply without an argument shows the state; submitting files a command application',
        body: async () => {
            const { bot, telegram: commandTelegram } = createFakeBot();
            registerApplyCommand(bot);

            await sendText(bot, COMMAND_CHAT, FRANK_ID, '/apply');
            const status = lastSentTextTo(commandTelegram, COMMAND_CHAT);
            expect(status.includes('你是体验用户'), 'a fresh trial user sees the header');
            expect(status.includes('用法：/apply 你是谁 | 你要做什么'), 'and the usage');

            const commandId = takeMessageId();
            await quietly(() =>
                bot.handleUpdate(
                    messageUpdate({ chatId: COMMAND_CHAT, messageId: commandId, userId: FRANK_ID, text: '/apply 我是 Frank | 想做海报' })
                )
            );
            const submitted = lastSentTextTo(commandTelegram, COMMAND_CHAT);
            expect(/已提交准入申请 #\d+/.test(submitted), `the reply names the application id (got ${JSON.stringify(submitted)})`);
            const row = await AccessApplication.findOne({ where: { userId: FRANK_ID } });
            expect(row !== null, 'a row was filed');
            expect(row?.chatId === COMMAND_CHAT && row.messageId === commandId, 'with the command chat and message');
            expect(row?.identity === '我是 Frank' && row.purpose === '想做海报', 'with both trimmed answers');
            expect(row?.source === 'command', "with source 'command'");

            // The owner notice is fire-and-forget after the reply
            await waitUntil(
                'the owner notice',
                () => sendsTo(commandTelegram, OWNER_ID).length > 0
            );
            expect(lastSentTextTo(commandTelegram, OWNER_ID).includes('新准入申请'), 'the owner is told');

            await sendText(bot, COMMAND_CHAT, FRANK_ID, '/apply');
            expect(lastSentTextTo(commandTelegram, COMMAND_CHAT).includes('待审核'), 'a second /apply reports the pending state');
        },
    },
    {
        name: '/apply reports a malformed argument, a full user and a rejected application',
        body: async () => {
            const { bot, telegram: botTelegram } = createFakeBot();
            registerApplyCommand(bot);

            await sendText(bot, COMMAND_CHAT, GRACE_ID, '/apply 没有分隔符');
            const malformed = lastSentTextTo(botTelegram, COMMAND_CHAT);
            expect(malformed.includes('格式不对') && malformed.includes('用法：/apply'), `no pipe is a usage error (got ${JSON.stringify(malformed)})`);
            expect((await AccessApplication.count({ where: { userId: GRACE_ID } })) === 0, 'and files nothing');

            await sendText(bot, COMMAND_CHAT, FULL_USER_ID, '/apply 我是完整用户 | 想申请');
            expect(lastSentTextTo(botTelegram, COMMAND_CHAT).includes('无需申请'), 'a full user needs no application');

            const judy = await fileApplication(JUDY_ID);
            await reviewAccessApplication({ applicationId: judy.id, action: 'reject', comment: '请说明身份', actorId: OWNER_ID });
            await sendText(bot, COMMAND_CHAT, JUDY_ID, '/apply');
            const rejected = lastSentTextTo(botTelegram, COMMAND_CHAT);
            expect(rejected.includes('未通过'), 'a rejected application says so');
            expect(rejected.includes('机主留言：请说明身份'), 'with the owner comment');
            expect(rejected.includes('重新申请'), 'and how to apply again');

            // An approved application that was revoked: the user is trial again
            await sendText(bot, COMMAND_CHAT, ALICE_ID, '/apply');
            const revoked = lastSentTextTo(botTelegram, COMMAND_CHAT);
            expect(revoked.includes('准入可能已被取消'), `a revoked user can re-apply (got ${JSON.stringify(revoked)})`);
            expect(revoked.includes('用法：/apply'), 'and is shown the usage');
        },
    },
    {
        name: 'the panel refuses a non-owner on every review route',
        body: async () => {
            const app = makeApp();
            const application = await fileApplication(LUCY_ID, { chatId: APP_CHAT });
            const paths: [string, string, unknown?][] = [
                ['GET', '/api/access-applications'],
                ['GET', `/api/access-applications/${application.id}`],
                ['PATCH', `/api/access-applications/${application.id}`, { action: 'approve' }],
                ['POST', `/api/access-applications/${application.id}/resend`],
                ['DELETE', `/api/user-access/${LUCY_ID}`],
            ];
            for (const [method, path, body] of paths) {
                const response = await call(app, path, { method, user: PANEL_TRIAL_2, ...(body === undefined ? {} : { body }) });
                await expectError(response, 403, 'forbidden', `${method} ${path} as a non-owner`);
            }
        },
    },
    {
        name: 'the panel files a Mini App application for a trial user and refuses a second one',
        body: async () => {
            const app = makeApp();
            telegram.reset();
            const response = await call(app, '/api/access-applications', {
                method: 'POST',
                user: PANEL_TRIAL,
                body: { identity: '我是 Mini App 用户', purpose: '想用完整功能' },
            });
            expect(response.status === 201, `a trial user files an application (got ${response.status})`);
            const created = (await jsonOf(response)).application;
            expect(created?.userId === PANEL_TRIAL.id && created.status === 'pending', 'it is pending');
            expect(created?.source === 'miniapp', "with source 'miniapp'");
            expect(created?.chatId === PANEL_TRIAL.id, 'the private chat is the delivery target');
            expect(created?.identity === '我是 Mini App 用户', 'with the answers');

            await waitForSend(OWNER_ID);
            expect(lastSentTextTo(telegram, OWNER_ID).includes('新准入申请'), 'the owner is notified');

            const second = await call(app, '/api/access-applications', {
                method: 'POST',
                user: PANEL_TRIAL,
                body: { identity: '再来一次', purpose: '重复申请' },
            });
            await expectError(second, 409, 'conflict', 'a second pending application');

            const full = await call(app, '/api/access-applications', {
                method: 'POST',
                user: PANEL_FULL,
                body: { identity: '完整用户', purpose: '无需申请' },
            });
            await expectError(full, 409, 'conflict', 'a full user');
        },
    },
    {
        name: 'the panel validates the create body before the service sees it',
        body: async () => {
            const app = makeApp();
            const casesToTry: [unknown, string][] = [
                [{ identity: '只有身份' }, 'a missing purpose'],
                [{ purpose: '只有用途' }, 'a missing identity'],
                [{ identity: '身份', purpose: '用途', extra: true }, 'an unknown key'],
                [{}, 'an empty body'],
                [{ identity: '', purpose: '用途' }, 'a blank identity'],
                [{ identity: '身份', purpose: 'z'.repeat(1001) }, 'an over-long purpose'],
            ];
            for (const [body, label] of casesToTry) {
                const response = await call(app, '/api/access-applications', { method: 'POST', user: PANEL_TRIAL_2, body });
                await expectError(response, 400, 'invalid', label);
            }
            // The same user can still file a valid one afterwards
            const response = await call(app, '/api/access-applications', {
                method: 'POST',
                user: PANEL_TRIAL_2,
                body: { identity: '第二个体验用户', purpose: '做海报' },
            });
            expect(response.status === 201, `a valid body after the refusals is accepted (got ${response.status})`);
        },
    },
    {
        name: 'the owner lists applications and sees the pending badge count',
        body: async () => {
            const app = makeApp();
            const pending = await jsonOf(await call(app, '/api/access-applications?status=pending&limit=100', { user: OWNER }));
            const all = await jsonOf(await call(app, '/api/access-applications?status=all&limit=100', { user: OWNER }));
            expect(Array.isArray(pending.applications), 'the pending list has applications');
            expect(pending.stats.pending === (await countPendingApplications()), `the badge count matches the service (got ${pending.stats.pending})`);
            expect(pending.matched === pending.applications.length, 'every pending row fits on one page');
            expect(pending.nextOffset === null, 'and there is no next page');
            expect(all.matched > pending.matched, 'the all list includes the decided rows');
            expect(
                all.applications.every((entry: any) => typeof entry.createdAt === 'string' && typeof entry.userName === 'string'),
                'rows are rendered with ISO times and display names'
            );
            const invalid = await call(app, '/api/access-applications?status=weird', { user: OWNER });
            await expectError(invalid, 400, 'invalid', 'an unknown status filter');
        },
    },
    {
        name: 'the owner detail returns one application with the same user history',
        body: async () => {
            const app = makeApp();
            const first = await fileApplication(KATE_ID, { identity: '第一次申请' });
            await reviewAccessApplication({ applicationId: first.id, action: 'reject', comment: '第一次没通过', actorId: OWNER_ID });
            const second = await fileApplication(KATE_ID, { identity: '第二次申请' });
            const body = await jsonOf(await call(app, `/api/access-applications/${second.id}`, { user: OWNER }));
            expect(body.application?.id === second.id, 'the detail is the requested application');
            expect(body.application?.identity === '第二次申请', 'with its fields');
            expect(Array.isArray(body.history) && body.history.length === 1, 'and the history of that user');
            expect(body.history[0]?.id === first.id && body.history[0]?.status === 'rejected', 'the earlier decision');
            await expectError(
                await call(app, '/api/access-applications/999999', { user: OWNER }),
                404,
                'not_found',
                'an unknown application id'
            );
        },
    },
    {
        name: 'the owner approves from the panel and the decision is delivered and audited',
        body: async () => {
            const app = makeApp();
            const pending = latestApplicationOf(PANEL_TRIAL.id);
            if (pending === null) throw new Error('the panel create case left no application');
            telegram.reset();
            const response = await call(app, `/api/access-applications/${pending.id}`, {
                method: 'PATCH',
                user: OWNER,
                body: { action: 'approve', comment: '欢迎' },
            });
            expect(response.status === 200, `the approve answers 200 (got ${response.status})`);
            const body = await jsonOf(response);
            expect(body.application?.status === 'approved' && body.application?.comment === '欢迎', 'the application is approved');

            // Delivery runs after the response
            await waitUntil('the decision notice', () => sendsTo(telegram, PANEL_TRIAL.id).length > 0);
            const delivered = await waitForDelivery(pending.id);
            expect(delivered?.deliveryStatus === 'sent', 'the delivery is recorded as sent');
            expect(lastSentTextTo(telegram, PANEL_TRIAL.id).includes('已通过'), 'the applicant is told');
            expect((await resolveAccessTier(PANEL_TRIAL.id)) === 'full', 'the cache makes the applicant full');

            const audits = await auditOf(`access:${pending.id}`);
            expect(audits.some((entry) => entry.key === 'approve' && entry.actorId === OWNER_ID), 'the panel decision is audited');
        },
    },
    {
        name: '/api/me reports the tier, the trial model, the application and the owner badge',
        body: async () => {
            const app = makeApp();
            const owner = await jsonOf(await call(app, '/api/me', { user: OWNER }));
            expect(owner.accessTier === 'owner', `the owner reads as owner (got ${JSON.stringify(owner.accessTier)})`);
            expect(owner.trialModel === 'gemini-4-hydrogen', 'the trial model is reported');
            expect(owner.accessTieringEnabled === true, 'tiering is on');
            expect(owner.accessApplication === null, 'the owner has no application');
            expect(
                owner.pendingAccessApplications === (await countPendingApplications()),
                `the owner sees the pending count (got ${JSON.stringify(owner.pendingAccessApplications)})`
            );

            const trial = await jsonOf(await call(app, '/api/me', { user: PANEL_TRIAL_2 }));
            expect(trial.accessTier === 'trial', `a trial user reads as trial (got ${JSON.stringify(trial.accessTier)})`);
            expect(trial.accessApplication?.status === 'pending', 'with their latest application');
            expect(trial.accessApplication?.identity === undefined, 'without the internal review fields');
            expect(trial.pendingAccessApplications === null, 'and no review badge');

            const full = await jsonOf(await call(app, '/api/me', { user: PANEL_FULL }));
            expect(full.accessTier === 'full', `a listed user reads as full (got ${JSON.stringify(full.accessTier)})`);
            expect(full.pendingAccessApplications === null, 'and no review badge either');
        },
    },
    {
        name: 'the owner can resend a decision but not before one exists',
        body: async () => {
            const app = makeApp();
            const approved = latestApplicationOf(PANEL_TRIAL.id);
            const pending = latestApplicationOf(PANEL_TRIAL_2.id);
            if (approved === null || pending === null) throw new Error('the panel cases left no applications');
            telegram.reset();
            const response = await call(app, `/api/access-applications/${approved.id}/resend`, {
                method: 'POST',
                user: OWNER,
            });
            expect(response.status === 200, `a resend answers 200 (got ${response.status})`);
            const body = await jsonOf(response);
            expect(body.application?.deliveryStatus === 'sent', 'the resent delivery is recorded as sent');
            expect(sendsTo(telegram, PANEL_TRIAL.id).length === 1, 'the applicant gets the message again');

            const tooEarly = await call(app, `/api/access-applications/${pending.id}/resend`, {
                method: 'POST',
                user: OWNER,
            });
            await expectError(tooEarly, 409, 'conflict', 'resending a pending application');
            await expectError(
                await call(app, '/api/access-applications/999999/resend', { method: 'POST', user: OWNER }),
                404,
                'not_found',
                'resending an unknown application'
            );
        },
    },
    {
        name: 'the owner can revoke a grant, and an unknown grant is a 404',
        body: async () => {
            const app = makeApp();
            expect((await resolveAccessTier(PANEL_TRIAL.id)) === 'full', 'the user is full before the revoke');
            const response = await call(app, `/api/user-access/${PANEL_TRIAL.id}`, { method: 'DELETE', user: OWNER });
            expect(response.status === 200, `the revoke answers 200 (got ${response.status})`);
            const body = await jsonOf(response);
            expect(body.userId === PANEL_TRIAL.id && body.revoked === true, 'it reports the revoked user');
            expect((await resolveAccessTier(PANEL_TRIAL.id)) === 'trial', 'the user is trial again');
            await expectError(
                await call(app, `/api/user-access/${PANEL_TRIAL.id}`, { method: 'DELETE', user: OWNER }),
                404,
                'not_found',
                'revoking a user without a grant'
            );
            await expectError(
                await call(app, '/api/user-access/999999', { method: 'DELETE', user: OWNER }),
                404,
                'not_found',
                'revoking an unknown user'
            );
        },
    },
    {
        name: 'the review route maps service refusals to 400 / 404 / 409',
        body: async () => {
            const app = makeApp();
            const approved = latestApplicationOf(PANEL_TRIAL.id);
            const pending = latestApplicationOf(PANEL_TRIAL_2.id);
            if (approved === null || pending === null) throw new Error('the panel cases left no applications');

            await expectError(
                await call(app, `/api/access-applications/${approved.id}`, {
                    method: 'PATCH',
                    user: OWNER,
                    body: { action: 'approve' },
                }),
                409,
                'conflict',
                'reviewing a decided application'
            );
            await expectError(
                await call(app, '/api/access-applications/999999', {
                    method: 'PATCH',
                    user: OWNER,
                    body: { action: 'approve' },
                }),
                404,
                'not_found',
                'reviewing an unknown application'
            );
            await expectError(
                await call(app, `/api/access-applications/${pending.id}`, {
                    method: 'PATCH',
                    user: OWNER,
                    body: { action: 'maybe' },
                }),
                400,
                'invalid',
                'an unknown action'
            );
            await expectError(
                await call(app, `/api/access-applications/${pending.id}`, {
                    method: 'PATCH',
                    user: OWNER,
                    body: { action: 'reject', comment: 'q'.repeat(501) },
                }),
                400,
                'invalid',
                'an over-long comment'
            );
            await expectError(
                await call(app, '/api/access-applications/not-a-number', { user: OWNER }),
                400,
                'invalid',
                'a non-numeric id'
            );
            expect((await findAccessApplication(pending.id))?.status === 'pending', 'the refused reviews changed nothing');
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}

await sequelize.close();
reportResults(results);
