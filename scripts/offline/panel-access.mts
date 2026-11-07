/**
 * Offline cases for the panel's access levels: a fake getChatMember stands in
 * for the Bot API, the registry and speaker records live in the scratch
 * database. Covers the membership table (statuses, 4xx, 429, 5xx / network /
 * deadline), the 30-day fallback, the positive-only cache, the candidate set
 * and per-request memo, the instance allow-list, and start_param parsing.
 *
 * Run: npx tsx scripts/offline/panel-access.mts
 */
import { GrammyError, HttpError } from 'grammy';
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';

const OWNER_ID = 4242;
const ALICE_ID = 5001;
const BOB_ID = 5002;
const CAROL_ID = 5003;

const GROUP_MAIN = -1001000000001;
const GROUP_QUIET = -4002;
const GROUP_FLAKY = -1001000000003;
const GROUP_STALE = -1001000000004;
const GROUP_THROTTLED = -1001000000005;
const CHANNEL_ID = -1001000000009;
const BLOCKED_GROUP = -1001000000099;

// Read once at import by config/instance and config/tool-config
process.env.OWNER_USER_ID = String(OWNER_ID);
process.env.ALLOWED_CHAT_IDS = [
    OWNER_ID, ALICE_ID, BOB_ID, CAROL_ID,
    GROUP_MAIN, GROUP_QUIET, GROUP_FLAKY, GROUP_STALE, GROUP_THROTTLED, CHANNEL_ID,
].join(',');

await setupOfflineDb();
const registry = await import('../../src/db/queries/panel-registry.js');
const { ChatMemberSeen } = await import('../../src/db/chatMemberSeenDTO.js');
const { HarnessIssue } = await import('../../src/db/harnessIssueDTO.js');
const access = await import('../../src/panel/access/chat-access.js');
const { createMembershipChecker } = await import('../../src/panel/access/membership.js');
const { parseStartParam, resolveHintChatId } = await import('../../src/panel/auth/start-param.js');
const { findIssueChatId } = await import('../../src/panel/queries/harness-issues.js');

type MembershipLookup = import('../../src/panel/access/membership.js').MembershipLookup;
type MemberStatus = import('../../src/panel/access/membership.js').MemberStatus;
type PanelUser = import('../../src/panel/types.js').PanelUser;

const DAY_MS = 24 * 60 * 60 * 1000;

const userOf = (id: number, firstName: string, isOwner = false): PanelUser => ({
    id,
    firstName,
    lastName: null,
    username: null,
    isOwner,
});
const OWNER = userOf(OWNER_ID, 'Owner', true);
const ALICE = userOf(ALICE_ID, 'Alice');
const BOB = userOf(BOB_ID, 'Bob');
const CAROL = userOf(CAROL_ID, 'Carol');

// ---- fake Bot API ---------------------------------------------------------

type FakeAnswer = { kind: 'status'; member: MemberStatus } | { kind: 'error'; error: unknown } | { kind: 'hang' };

const answers = new Map<string, FakeAnswer>();
const calls = new Map<string, number>();
const keyOf = (chatId: number, userId: number): string => `${chatId}:${userId}`;

const grammyError = (code: number, description: string): GrammyError =>
    new GrammyError(
        `Call to 'getChatMember' failed! (${code}: ${description})`,
        { ok: false, error_code: code, description },
        'getChatMember',
        {}
    );

const answerStatus = (chatId: number, userId: number, member: MemberStatus): void => {
    answers.set(keyOf(chatId, userId), { kind: 'status', member });
};
const answerError = (chatId: number, userId: number, error: unknown): void => {
    answers.set(keyOf(chatId, userId), { kind: 'error', error });
};

const fakeLookup: MembershipLookup = (chatId, userId, signal) => {
    const key = keyOf(chatId, userId);
    calls.set(key, (calls.get(key) ?? 0) + 1);
    const answer = answers.get(key) ?? { kind: 'error', error: grammyError(400, 'Bad Request: user not found') };
    if (answer.kind === 'status') return Promise.resolve(answer.member);
    if (answer.kind === 'error') return Promise.reject(answer.error);
    return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new HttpError('Network request aborted', new Error('aborted'))));
    });
};

const callsTo = (chatId: number, userId: number): number => calls.get(keyOf(chatId, userId)) ?? 0;
const totalCalls = (): number => [...calls.values()].reduce((sum, count) => sum + count, 0);

let clockMs = Date.now();
const makeChecker = (timeoutMs = 5000) => createMembershipChecker({ lookup: fakeLookup, now: () => clockMs, timeoutMs });

const reset = (): void => {
    answers.clear();
    calls.clear();
    clockMs = Date.now();
};

/** One request's resolver, as the auth middleware creates it */
const resolverFor = (user: PanelUser, checker = makeChecker()) => access.createChatAccessResolver(user, checker);

const levelOf = async (user: PanelUser, chatId: number, checker = makeChecker()): Promise<string> => {
    try {
        return await access.resolveChatAccess(user, chatId, checker);
    } catch (error) {
        if (error instanceof access.MembershipUnavailableError) return 'unavailable';
        throw error;
    }
};

// ---- fixtures -------------------------------------------------------------

const registerGroup = (chatId: number, title: string, type = 'supergroup') =>
    registry.upsertChatNow({ id: chatId, type, title });

const spoke = async (chatId: number, userId: number, daysAgo: number): Promise<void> => {
    const seenAt = new Date(Date.now() - daysAgo * DAY_MS);
    await ChatMemberSeen.upsert({ chatId, userId, firstSeenAt: seenAt, lastSeenAt: seenAt, messageCount: 1 });
};

await registerGroup(GROUP_MAIN, 'Main');
await registerGroup(GROUP_QUIET, 'Quiet', 'group');
await registerGroup(GROUP_FLAKY, 'Flaky');
await registerGroup(GROUP_STALE, 'Stale');
await registerGroup(GROUP_THROTTLED, 'Throttled');
await registerGroup(BLOCKED_GROUP, 'Blocked');
await registry.upsertChatNow({ id: CHANNEL_ID, type: 'channel', title: 'Channel' });
await registry.upsertChatNow({ id: BOB_ID, type: 'private', first_name: 'Bob' });

await spoke(GROUP_MAIN, ALICE_ID, 1);
await spoke(GROUP_FLAKY, ALICE_ID, 3);
await spoke(GROUP_STALE, ALICE_ID, 40);
await spoke(GROUP_THROTTLED, ALICE_ID, 1);

// ---- cases ----------------------------------------------------------------

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'the own private chat is member, and gets a chats row from initData',
        body: async () => {
            reset();
            expect((await registry.findChat(CAROL_ID)) === null, 'Carol has no row yet');
            expect((await levelOf(CAROL, CAROL_ID)) === 'member', 'Carol is a member of her own chat');
            const row = await registry.findChat(CAROL_ID);
            expect(row?.type === 'private' && row.title === 'Carol', 'the row is created with her first name');
            expect(totalCalls() === 0, 'no Bot API call');
        },
    },
    {
        name: "someone else's private chat: the owner observes, anyone else gets none",
        body: async () => {
            reset();
            expect((await levelOf(OWNER, BOB_ID)) === 'observer', 'owner → observer');
            expect((await levelOf(ALICE, BOB_ID)) === 'none', 'Alice → none');
            expect((await levelOf(ALICE, 777_000_001)) === 'none', 'an unregistered chat → none');
            expect(totalCalls() === 0, 'private chats never reach the Bot API');
        },
    },
    {
        name: 'creator, administrator, member and restricted members are members',
        body: async () => {
            const memberStatuses: MemberStatus[] = [
                { status: 'creator' },
                { status: 'administrator' },
                { status: 'member' },
                { status: 'restricted', is_member: true },
            ];
            for (const member of memberStatuses) {
                reset();
                answerStatus(GROUP_QUIET, BOB_ID, member);
                expect((await levelOf(BOB, GROUP_QUIET)) === 'member', `${member.status}${member.is_member ? '+is_member' : ''} → member`);
            }
        },
    },
    {
        name: 'left, kicked and restricted non-members never fall back, even after speaking',
        body: async () => {
            const nonMembers: MemberStatus[] = [
                { status: 'left' },
                { status: 'kicked' },
                { status: 'restricted', is_member: false },
                { status: 'restricted' },
            ];
            for (const member of nonMembers) {
                reset();
                answerStatus(GROUP_MAIN, ALICE_ID, member);
                const label = `${member.status}${member.is_member === false ? ' (is_member false)' : ''}`;
                expect((await levelOf(ALICE, GROUP_MAIN)) === 'none', `${label} → none despite speaking yesterday`);
                answerStatus(GROUP_MAIN, OWNER_ID, member);
                expect((await levelOf(OWNER, GROUP_MAIN)) === 'observer', `${label} → owner observes`);
            }
        },
    },
    {
        name: 'Bot API 4xx answers are final: user not found, bot was kicked',
        body: async () => {
            reset();
            answerError(GROUP_MAIN, ALICE_ID, grammyError(400, 'Bad Request: user not found'));
            expect((await levelOf(ALICE, GROUP_MAIN)) === 'none', '400 user not found → none');
            answerError(GROUP_MAIN, ALICE_ID, grammyError(403, 'Forbidden: bot was kicked from the supergroup chat'));
            expect((await levelOf(ALICE, GROUP_MAIN)) === 'none', '403 bot was kicked, spoke yesterday → still none');
            answerError(GROUP_MAIN, OWNER_ID, grammyError(403, 'Forbidden: bot was kicked from the supergroup chat'));
            expect((await levelOf(OWNER, GROUP_MAIN)) === 'observer', '…and the owner observes');
            answerError(GROUP_MAIN, ALICE_ID, grammyError(400, 'Bad Request: member list is inaccessible'));
            expect((await levelOf(ALICE, GROUP_MAIN)) === 'none', 'member list is inaccessible → none (with a warning)');
        },
    },
    {
        name: 'a 429 never falls back: the chat is unavailable (single-chat 503)',
        body: async () => {
            reset();
            answerError(GROUP_THROTTLED, ALICE_ID, grammyError(429, 'Too Many Requests: retry after 5'));
            expect((await levelOf(ALICE, GROUP_THROTTLED)) === 'unavailable', 'spoke yesterday, still unavailable');
            answerError(GROUP_THROTTLED, OWNER_ID, grammyError(429, 'Too Many Requests: retry after 5'));
            expect((await levelOf(OWNER, GROUP_THROTTLED)) === 'unavailable', 'for the owner too');
        },
    },
    {
        name: '5xx, network errors and the deadline fall back to 30 days of speech, uncached',
        body: async () => {
            reset();
            const checker = makeChecker(50);
            answerError(GROUP_FLAKY, ALICE_ID, grammyError(502, 'Bad Gateway'));
            expect((await levelOf(ALICE, GROUP_FLAKY, checker)) === 'member', '502 + spoke 3 days ago → member');
            expect((await levelOf(ALICE, GROUP_FLAKY, checker)) === 'member', 'again');
            expect(callsTo(GROUP_FLAKY, ALICE_ID) === 2, 'the fallback member is not cached');

            answerError(GROUP_FLAKY, ALICE_ID, new HttpError('Network request failed', new Error('ECONNRESET')));
            expect((await levelOf(ALICE, GROUP_FLAKY, checker)) === 'member', 'network error + recent speech → member');

            answers.set(keyOf(GROUP_FLAKY, ALICE_ID), { kind: 'hang' });
            expect((await levelOf(ALICE, GROUP_FLAKY, checker)) === 'member', 'deadline expired + recent speech → member');

            answerError(GROUP_STALE, ALICE_ID, grammyError(500, 'Internal Server Error'));
            expect((await levelOf(ALICE, GROUP_STALE, checker)) === 'none', '500 + spoke 40 days ago → none');
            answerError(GROUP_STALE, OWNER_ID, grammyError(500, 'Internal Server Error'));
            expect((await levelOf(OWNER, GROUP_STALE, checker)) === 'observer', 'the owner observes instead');
            answerError(GROUP_QUIET, ALICE_ID, new HttpError('Network request failed', new Error('ETIMEDOUT')));
            expect((await levelOf(ALICE, GROUP_QUIET, checker)) === 'none', 'network error, never spoke → none');
        },
    },
    {
        name: 'only a positive API answer is cached, for 5 minutes',
        body: async () => {
            reset();
            const checker = makeChecker();
            answerStatus(GROUP_MAIN, ALICE_ID, { status: 'member' });
            expect((await levelOf(ALICE, GROUP_MAIN, checker)) === 'member', 'first request asks the API');
            answerStatus(GROUP_MAIN, ALICE_ID, { status: 'left' });
            expect((await levelOf(ALICE, GROUP_MAIN, checker)) === 'member', 'a later request within 5 min uses the cache');
            expect(callsTo(GROUP_MAIN, ALICE_ID) === 1, 'one call so far');
            clockMs += 5 * 60 * 1000 + 1;
            expect((await levelOf(ALICE, GROUP_MAIN, checker)) === 'none', 'after 5 min the departure shows');
            expect(callsTo(GROUP_MAIN, ALICE_ID) === 2, 'the API was asked again');
            expect((await levelOf(ALICE, GROUP_MAIN, checker)) === 'none', 'negative answers…');
            expect(callsTo(GROUP_MAIN, ALICE_ID) === 3, '…are never cached');
        },
    },
    {
        name: "a non-owner's list asks only about candidates, once per chat per request",
        body: async () => {
            reset();
            answerStatus(GROUP_MAIN, ALICE_ID, { status: 'member' });
            answerStatus(GROUP_QUIET, ALICE_ID, { status: 'member' });
            answerError(GROUP_THROTTLED, ALICE_ID, grammyError(429, 'Too Many Requests: retry after 5'));
            answerStatus(GROUP_FLAKY, ALICE_ID, { status: 'left' });
            answerStatus(GROUP_STALE, ALICE_ID, { status: 'kicked' });

            const resolver = resolverFor(ALICE);
            const listed = await access.listAccessibleChats(resolver);
            const listedIds = listed.map((entry) => entry.chat.chatId);
            expect(listedIds.includes(ALICE_ID), 'her own private chat is listed (row created)');
            expect(listedIds.includes(GROUP_MAIN), 'a group she spoke in and belongs to is listed');
            expect(!listedIds.includes(GROUP_QUIET), 'a group she never spoke in is not');
            expect(callsTo(GROUP_QUIET, ALICE_ID) === 0, '…and was never looked up');
            expect(callsTo(BLOCKED_GROUP, ALICE_ID) === 0 && callsTo(CHANNEL_ID, ALICE_ID) === 0, 'nor were other chats');
            expect(!listedIds.includes(GROUP_THROTTLED), 'a rate-limited chat is skipped, not fatal');
            expect(!listedIds.includes(GROUP_FLAKY) && !listedIds.includes(GROUP_STALE), 'former members are not listed');
            expect(listed.every((entry) => entry.access === 'member'), 'a non-owner only ever sees member chats');

            await resolver.resolve(GROUP_MAIN);
            await resolver.resolve(GROUP_MAIN);
            expect(callsTo(GROUP_MAIN, ALICE_ID) === 1, 'the same request asks about a chat once');

            const hinted = await access.listAccessibleChats(resolverFor(ALICE), GROUP_QUIET);
            expect(hinted.some((entry) => entry.chat.chatId === GROUP_QUIET), 'the start_param hint adds a candidate');
            expect(callsTo(GROUP_QUIET, ALICE_ID) === 1, 'which is then looked up once');
        },
    },
    {
        name: 'the owner lists every allowed chat as member or observer',
        body: async () => {
            reset();
            answerStatus(GROUP_MAIN, OWNER_ID, { status: 'creator' });
            answerError(GROUP_THROTTLED, OWNER_ID, grammyError(429, 'Too Many Requests: retry after 5'));
            const listed = await access.listAccessibleChats(resolverFor(OWNER));
            const levelIn = (chatId: number) => listed.find((entry) => entry.chat.chatId === chatId)?.access;
            expect(levelIn(OWNER_ID) === 'member', 'own private chat: member');
            expect(levelIn(GROUP_MAIN) === 'member', 'a group the owner is in: member');
            expect(levelIn(GROUP_QUIET) === 'observer', 'a group the owner is not in: observer');
            expect(levelIn(BOB_ID) === 'observer', "Bob's private chat: observer");
            expect(levelIn(CHANNEL_ID) === 'observer', 'a channel: observer, no lookup');
            expect(callsTo(CHANNEL_ID, OWNER_ID) === 0, 'channels are never looked up');
            expect(levelIn(GROUP_THROTTLED) === undefined, 'the rate-limited chat is skipped');
            expect(levelIn(BLOCKED_GROUP) === undefined, 'a chat outside ALLOWED_CHAT_IDS is not listed');
        },
    },
    {
        name: 'ALLOWED_CHAT_IDS blocks the HTTP path before any lookup',
        body: async () => {
            reset();
            answerStatus(BLOCKED_GROUP, OWNER_ID, { status: 'creator' });
            answerStatus(BLOCKED_GROUP, ALICE_ID, { status: 'member' });
            expect((await levelOf(OWNER, BLOCKED_GROUP)) === 'none', 'even the owner gets none');
            expect((await levelOf(ALICE, BLOCKED_GROUP)) === 'none', 'and members too');
            expect(totalCalls() === 0, 'without asking the Bot API');
            const outsider = userOf(6006, 'Outsider');
            expect((await levelOf(outsider, 6006)) === 'none', 'a private chat outside the list is none as well');
            expect((await registry.findChat(6006)) === null, '…and gets no row');
        },
    },
    {
        name: 'start_param: c<chatId> / i<issueId>, anything else ignored; issues point at their chat',
        body: async () => {
            const parsed = (raw: string | null) => JSON.stringify(parseStartParam(raw));
            expect(parsed('c-1001234567890') === JSON.stringify({ kind: 'chat', chatId: -1001234567890 }), 'c-100…');
            expect(parsed('c5001') === JSON.stringify({ kind: 'chat', chatId: 5001 }), 'c<private id>');
            expect(parsed('i42') === JSON.stringify({ kind: 'issue', issueId: 42 }), 'i42');
            for (const ignored of [null, '', 'c', 'c-', 'c0', 'x1', 'c1a', 'C1', 'i-1', 'i', ' c1', 'c1 ', `c${'1'.repeat(21)}`, `i${'1'.repeat(11)}`, 'c99999999999999999999', 's123']) {
                expect(parseStartParam(ignored) === null, `${JSON.stringify(ignored)} → ignored`);
            }

            const issue = await HarnessIssue.create({ kind: 'bug', title: 't', body: 'b', chatId: GROUP_MAIN });
            const orphan = await HarnessIssue.create({ kind: 'bug', title: 't', body: 'b' });
            expect((await resolveHintChatId(parseStartParam('c-4002'), findIssueChatId)) === -4002, 'chat hint = its id');
            expect((await resolveHintChatId(parseStartParam(`i${issue.id}`), findIssueChatId)) === GROUP_MAIN, 'issue hint = its chat');
            expect((await resolveHintChatId(parseStartParam(`i${orphan.id}`), findIssueChatId)) === null, 'an issue without chat → null');
            expect((await resolveHintChatId(parseStartParam('i999999'), findIssueChatId)) === null, 'a missing issue → null');
            expect((await resolveHintChatId(null, findIssueChatId)) === null, 'no target → null');
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
reportResults(results);
