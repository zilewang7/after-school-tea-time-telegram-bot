/**
 * Offline cases for the group-membership roster (design 2026-1112-1216 §14,
 * D1-C): a group's current members hold the full tier automatically, a message
 * posted in that group needs no lookup, and the panel reads the same roster.
 *
 * Tiering is on (ACCESS_TIERS=1); the harness default keeps it off elsewhere.
 * The Bot API is a fake lookup: member / left / kicked / 429 / 5xx per user id.
 *
 * Run: npx tsx scripts/offline/access-roster.mts
 */
import { GrammyError } from 'grammy';
import {
    expect,
    reportResults,
    runCase,
    setupOfflineDb,
    type CaseResult,
} from './harness.mts';
import { signInitData, type InitDataUserInput } from '../lib/init-data.mts';

// Tiering is off in the harness by default; this file is about the roster.
process.env.ACCESS_TIERS = '1';

const OWNER_ID = 4242;
/** A positive TOOL_CHAT_IDS entry: an explicitly listed private user */
const FULL_USER_ID = 5151;
/** The access group: a negative TOOL_CHAT_IDS entry */
const GROUP_CHAT_ID = -1004242424242;
/** Group members (the fake Bot API answers for them) */
const MEMBER_ID = 6161;
const KICKED_ID = 7171;
/** Panel identities */
const PANEL_MEMBER: InitDataUserInput = { id: 8181, first_name: 'Member' };
const PANEL_STRANGER: InitDataUserInput = { id: 8282, first_name: 'Stranger' };
const OWNER: InitDataUserInput = { id: OWNER_ID, first_name: 'Owner' };
const BOT_TOKEN = '123456789:AAFakeOfflineTokenForRosterTests_012';

process.env.OWNER_USER_ID = String(OWNER_ID);
delete process.env.ACCESS_GROUP_IDS;
process.env.TOOL_CHAT_IDS = `${GROUP_CHAT_ID}, ${FULL_USER_ID}`;
process.env.ALLOWED_CHAT_IDS = [
    OWNER_ID,
    FULL_USER_ID,
    MEMBER_ID,
    KICKED_ID,
    PANEL_MEMBER.id,
    PANEL_STRANGER.id,
    GROUP_CHAT_ID,
].join(',');
process.env.DEFAULT_MODEL = 'gemini-4-argon';
process.env.BOT_USER_NAME = 'AfterSchoolTeatimeBot';
process.env.BOT_USER_ID = '7777';

await setupOfflineDb();

const { sequelize } = await import('../../src/db/config.js');
const { ChatRecord } = await import('../../src/db/chatDTO.js');
const { resolveAccessTier } = await import('../../src/services/access-tier.js');
const { setAccessMembershipLookup } = await import('../../src/services/access-membership.js');
const { createPanelApp } = await import('../../src/panel/app.js');

type PanelApp = ReturnType<typeof createPanelApp>;
type MembershipLookup = import('../../src/panel/access/membership.js').MembershipLookup;

// ---------------------------------------------------------------------------
// Fixtures: the group is registered (the panel reads its title), the fake Bot
// API knows two members and answers "left" for everyone else.
// ---------------------------------------------------------------------------

const now = new Date();
await ChatRecord.create({
    chatId: GROUP_CHAT_ID,
    type: 'supergroup',
    title: '测试群',
    username: null,
    firstSeenAt: now,
    lastSeenAt: now,
});

const grammyError = (code: number, description: string): GrammyError =>
    new GrammyError(`(${code}: ${description})`, { ok: false, error_code: code, description }, 'getChatMember', {});

/** The bot side and the panel side share one fake Bot API */
const membershipLookup: MembershipLookup = async (chatId, userId) => {
    if (chatId !== GROUP_CHAT_ID) throw grammyError(400, 'Bad Request: chat not found');
    if (userId === MEMBER_ID || userId === PANEL_MEMBER.id) return { status: 'member' };
    if (userId === KICKED_ID) return { status: 'kicked' };
    return { status: 'left' };
};
setAccessMembershipLookup(membershipLookup);

const clockMs = Date.now();
const nowSeconds = (): number => Math.floor(clockMs / 1000);

const app: PanelApp = createPanelApp({
    botToken: BOT_TOKEN,
    membershipLookup,
    staticRoot: '/nonexistent-static-root',
    startedAt: new Date('2026-11-12T00:00:00.000Z'),
    version: 'abc1234',
    now: () => clockMs,
    rateLimit: { limit: 10_000, windowMs: 60_000 },
});

const call = (path: string, options: { method?: string; user: InitDataUserInput; body?: unknown }): Promise<Response> => {
    const headers = new Headers();
    headers.set('X-Init-Data', signInitData({ botToken: BOT_TOKEN, user: options.user, authDate: nowSeconds() }));
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    return Promise.resolve(app.request(path, { method: options.method ?? 'GET', headers, body }));
};

const jsonOf = async (response: Response): Promise<any> => JSON.parse(await response.text());

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'the bot tier follows current group membership',
        body: async () => {
            expect((await resolveAccessTier(MEMBER_ID)) === 'full', 'a current member is full');
            expect((await resolveAccessTier(KICKED_ID)) === 'trial', 'a kicked member is trial');
            expect((await resolveAccessTier(FULL_USER_ID)) === 'full', 'a positive TOOL_CHAT_IDS entry stays full');
            expect((await resolveAccessTier(9999)) === 'trial', 'a stranger is trial');
            expect((await resolveAccessTier(null)) === 'trial', 'a row without an author id is trial');
        },
    },
    {
        name: 'a message posted in the access group is full without a lookup',
        body: async () => {
            // The fake says 9999 is not a member, but nobody else can post there
            expect((await resolveAccessTier(9999, GROUP_CHAT_ID)) === 'full', 'the trigger chat is proof');
            expect((await resolveAccessTier(9999, -1009999999999)) === 'trial', 'another group is not the roster');
        },
    },
    {
        name: 'the panel reads the tier from the same roster and names the groups to the owner',
        body: async () => {
            const member = await jsonOf(await call('/api/me', { user: PANEL_MEMBER }));
            expect(member.accessTier === 'full', `a member reads as full (got ${JSON.stringify(member.accessTier)})`);
            expect(member.accessGroups === null, 'a non-owner sees no roster groups');

            const stranger = await jsonOf(await call('/api/me', { user: PANEL_STRANGER }));
            expect(
                stranger.accessTier === 'trial',
                `a non-member reads as trial (got ${JSON.stringify(stranger.accessTier)})`
            );

            const owner = await jsonOf(await call('/api/me', { user: OWNER }));
            expect(owner.accessTier === 'owner', 'the owner reads as owner');
            expect(
                JSON.stringify(owner.accessGroups) === JSON.stringify([{ chatId: GROUP_CHAT_ID, title: '测试群' }]),
                `the owner sees the roster groups (got ${JSON.stringify(owner.accessGroups)})`
            );
        },
    },
    {
        name: 'a panel member changes their own chat model; a non-member is refused',
        body: async () => {
            const memberResponse = await call(`/api/chats/${PANEL_MEMBER.id}/settings`, {
                method: 'PATCH',
                user: PANEL_MEMBER,
                body: { model: 'gpt-6-astra' },
            });
            expect(memberResponse.status === 200, `a member may change the model (got ${memberResponse.status})`);

            const strangerResponse = await call(`/api/chats/${PANEL_STRANGER.id}/settings`, {
                method: 'PATCH',
                user: PANEL_STRANGER,
                body: { model: 'gpt-6-astra' },
            });
            const body = await jsonOf(strangerResponse);
            expect(
                strangerResponse.status === 403 && body?.error?.code === 'trial',
                `a non-member is refused with trial (got ${strangerResponse.status} ${JSON.stringify(body?.error?.code)})`
            );
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}

await sequelize.close();
reportResults(results);
