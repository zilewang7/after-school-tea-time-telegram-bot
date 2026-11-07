/**
 * Offline cases for excluding messages from the model's context (design §6.2):
 * an excluded message leaves the context while its replies stay; it is not
 * pulled back as a missing reply target, and a reply to it reads
 * `[replying to a message you cannot see]`; continuation ids are normalized;
 * unknown ids are 404, album sub-images 400; repeated writes answer 200 and
 * audit nothing; excluding the trigger changes nothing for its own reply;
 * `includeExcluded` keeps them flagged; and the hourly cleanup drops an
 * exclusion only together with its message.
 *
 * Run: npx tsx scripts/offline/context-exclusions.mts
 */
import { GrammyError } from 'grammy';
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';
import { signInitData, type InitDataUserInput } from '../lib/init-data.mts';

const BOT_TOKEN = '123456789:AAFakeOfflineTokenForPanelTests_0123';
const OWNER_ID = 4242;
const BOT_USER_ID = 7777;
const ALICE: InitDataUserInput = { id: 5001, first_name: 'Alice' };
const GROUP = -1001000000301;
const DAY_MS = 24 * 60 * 60 * 1000;

process.env.OWNER_USER_ID = String(OWNER_ID);
process.env.BOT_USER_ID = String(BOT_USER_ID);
process.env.DEFAULT_MODEL = 'gemini-4-argon';
delete process.env.ALLOWED_CHAT_IDS;
delete process.env.LUOXU_PREVIEW_URL;

const db = await setupOfflineDb();
const registry = await import('../../src/db/queries/panel-registry.js');
const { BotResponse, ButtonState } = await import('../../src/db/index.js');
const { ContextExclusion } = await import('../../src/db/contextExclusionDTO.js');
const { SettingsAudit } = await import('../../src/db/settingsAuditDTO.js');
const { getRepliesHistory, saveMessageLinks } = await import('../../src/db/queries/context-queries.js');
const { clearExpiredData } = await import('../../src/db/autoSave.js');
const { loadChatSettingsCache } = await import('../../src/services/chat-settings-service.js');
const { buildContext } = await import('../../src/reply/context-builder.js');
const { createPanelApp } = await import('../../src/panel/app.js');

type MembershipLookup = import('../../src/panel/access/membership.js').MembershipLookup;

const grammyError = (code: number, description: string): GrammyError =>
    new GrammyError(`(${code}: ${description})`, { ok: false, error_code: code, description }, 'getChatMember', {});

const fakeLookup: MembershipLookup = async (_chatId, userId) => {
    if (userId === ALICE.id) return { status: 'member' };
    throw grammyError(400, 'Bad Request: user not found');
};

const app = createPanelApp({
    botToken: BOT_TOKEN,
    membershipLookup: fakeLookup,
    staticRoot: '/nonexistent-panel-static-root',
    startedAt: new Date('2026-11-07T00:00:00.000Z'),
    version: 'test',
});

const request = async (method: string, path: string, user: InitDataUserInput = ALICE): Promise<{ status: number; body: any }> => {
    const headers = new Headers({
        'X-Init-Data': signInitData({ botToken: BOT_TOKEN, user, authDate: Math.floor(Date.now() / 1000) }),
    });
    const response = await app.request(path, { method, headers });
    return { status: response.status, body: JSON.parse(await response.text()) };
};

const exclusionPath = (messageId: number): string => `/api/chats/${GROUP}/messages/${messageId}/exclusion`;
const exclude = (messageId: number) => request('PUT', exclusionPath(messageId));
const include = (messageId: number) => request('DELETE', exclusionPath(messageId));
const auditCount = (): Promise<number> => SettingsAudit.count({ where: { scope: `chat:${GROUP}` } });

// ---- fixtures -------------------------------------------------------------

let nextId = 7000;
const takeId = (): number => (nextId += 1);

const seedMessage = async (fields: {
    replyToId?: number | null;
    text: string | null;
    fromBot?: boolean;
    userName?: string;
    date?: Date;
}): Promise<number> => {
    const messageId = takeId();
    await db.Message.create({
        chatId: GROUP,
        messageId,
        fromBotSelf: fields.fromBot === true,
        userId: fields.fromBot === true ? BOT_USER_ID : ALICE.id,
        date: fields.date ?? new Date(Date.now() - 600_000 + messageId),
        userName: fields.fromBot === true ? 'Bot' : (fields.userName ?? 'Alice'),
        text: fields.text,
        quoteText: null,
        file: null,
        fileMime: null,
        fileUniqueId: null,
        replyToId: fields.replyToId ?? null,
        chatCommand: null,
        modelParts: null,
        mediaHint: null,
        forwardOrigin: null,
        forwardFromId: null,
        viaBot: null,
        ocrText: null,
    });
    return messageId;
};

const seedBotResponse = async (
    messageId: number,
    userMessageId: number,
    text: string,
    options: { continuationIds?: number[]; createdAt?: Date } = {}
): Promise<void> => {
    await BotResponse.create({
        messageId,
        chatId: GROUP,
        userMessageId,
        currentVersionIndex: 0,
        versions: JSON.stringify([
            {
                versionId: 1,
                createdAt: new Date().toISOString(),
                messageIds: [messageId, ...(options.continuationIds ?? [])],
                currentMessageId: messageId,
                text,
                wasStoppedByUser: false,
            },
        ]),
        buttonState: ButtonState.NONE,
        metadata: JSON.stringify({ model: 'gemini-4-argon', hasImage: false }),
        ...(options.createdAt !== undefined ? { createdAt: options.createdAt, updatedAt: options.createdAt } : {}),
    });
};

const rowOf = async (messageId: number) => {
    const row = await db.Message.findOne({ where: { chatId: GROUP, messageId } });
    if (row === null) throw new Error(`message ${messageId} missing`);
    return row;
};

const contextTextOf = async (messageId: number): Promise<string> => {
    const { messages } = await buildContext(await rowOf(messageId), { model: 'gemini-4-argon' });
    return messages.map((turn) => turn.content.map((part) => part.text ?? '').join('\n')).join('\n');
};

await registry.upsertChatNow({ id: GROUP, type: 'supergroup', title: 'Exclusion Lab' });
await loadChatSettingsCache();

// R ← A ← B (bot) ← C
const rootR = await seedMessage({ text: 'R-TEXT 开头' });
const messageA = await seedMessage({ replyToId: rootR, text: 'A-TEXT 捣乱的消息' });
const replyB = await seedMessage({ replyToId: messageA, text: 'B-TEXT 机器人回答', fromBot: true });
await seedBotResponse(replyB, messageA, 'B-TEXT 机器人回答');
const triggerC = await seedMessage({ replyToId: replyB, text: 'C-TEXT 追问' });

// X outside; R2 links L in; L replies to X; T2 replies to R2
const outsideX = await seedMessage({ text: 'X-TEXT 树外', userName: 'Xavier' });
const rootR2 = await seedMessage({ text: 'R2-TEXT' });
const bystanderL = await seedMessage({ replyToId: outsideX, text: 'L-TEXT 旁观', userName: 'Lily' });
await saveMessageLinks(GROUP, rootR2, [bystanderL]);
const triggerT2 = await seedMessage({ replyToId: rootR2, text: 'T2-TEXT' });

// A bot reply sent as two messages; someone answers its second message
const ask3 = await seedMessage({ text: 'Q3-TEXT' });
const reply3 = await seedMessage({ replyToId: ask3, text: 'B3-TEXT 分两条发的回复', fromBot: true });
const reply3Continuation = 888_001;
await seedBotResponse(reply3, ask3, 'B3-TEXT 分两条发的回复', { continuationIds: [reply3Continuation] });
const answerToContinuation = await seedMessage({ replyToId: reply3Continuation, text: 'U3-TEXT 回复第二条' });

// An album: the sub-image row carries no content of its own
const albumFirst = await seedMessage({ text: '相册第一张' });
const albumSub = await seedMessage({ replyToId: albumFirst, text: `sub image of [${albumFirst}]` });

// ---- cases ----------------------------------------------------------------

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'an excluded message leaves the context; its replies stay; the write is audited once',
        body: async () => {
            expect((await contextTextOf(triggerC)).includes('A-TEXT'), 'before: A is in the context');
            const before = await auditCount();
            const excluded = await exclude(messageA);
            expect(
                excluded.status === 200 &&
                    excluded.body.messageId === messageA &&
                    excluded.body.excluded === true &&
                    excluded.body.createdBy === ALICE.id &&
                    typeof excluded.body.createdAt === 'string',
                `PUT answers the row (got ${excluded.status} ${JSON.stringify(excluded.body)})`
            );
            const text = await contextTextOf(triggerC);
            expect(!text.includes('A-TEXT'), 'after: A is gone');
            expect(text.includes('B-TEXT') && text.includes('C-TEXT') && text.includes('R-TEXT'), 'its reply and the rest stay');
            const audit = await SettingsAudit.findOne({ where: { scope: `chat:${GROUP}` }, order: [['id', 'DESC']] });
            expect((await auditCount()) === before + 1 && audit?.key === 'exclude' && audit.newValue === String(messageA), 'audit: exclude with the canonical id');

            const history = await getRepliesHistory(GROUP, triggerC, { excludeSelf: false });
            expect(!history.some((message) => message.messageId === messageA), 'getRepliesHistory (also /context and the media wait) leaves it out');
            const flagged = await getRepliesHistory(GROUP, triggerC, { includeExcluded: true });
            expect(flagged.find((message) => message.messageId === messageA)?.excludedFromContext === true, 'includeExcluded keeps it, flagged');
        },
    },
    {
        name: 'the tree keeps an excluded message, flagged and unnumbered, for members and observers',
        body: async () => {
            const tree = (await request('GET', `/api/chats/${GROUP}/conversations/${rootR}`)).body;
            const nodeA = tree.nodes.find((node: any) => node.messageId === messageA);
            expect(nodeA?.excluded === true && nodeA.number === null, `A is shown excluded without a number (got ${JSON.stringify(nodeA)})`);
            const numbers = tree.nodes.filter((node: any) => node.number !== null).map((node: any) => node.number);
            expect(JSON.stringify(numbers) === JSON.stringify([1, 2, 3]), `the others are renumbered 1..3 (got ${numbers.join(',')})`);
            const observed = (await request('GET', `/api/chats/${GROUP}/conversations/${rootR}`, { id: OWNER_ID, first_name: 'Owner' })).body;
            expect(observed.nodes.find((node: any) => node.messageId === messageA)?.excluded === true, 'the observer sees the excluded flag');
        },
    },
    {
        name: 'an excluded reply target is not pulled back, and the reply to it cannot see it',
        body: async () => {
            const before = await contextTextOf(triggerT2);
            expect(before.includes('X-TEXT') && before.includes('[replying to #1 Xavier]'), `before: X is pulled in and numbered (got ${JSON.stringify(before)})`);
            expect((await exclude(outsideX)).status === 200, 'X excluded');
            const after = await contextTextOf(triggerT2);
            expect(!after.includes('X-TEXT') && !after.includes('Xavier'), 'after: X is not pulled back, not even quoted');
            expect(after.includes('L-TEXT') && after.includes('[replying to a message you cannot see]'), 'L stays and cannot see what it answers');
        },
    },
    {
        name: 'a continuation id is normalized to the reply; a reply to it cannot see it either',
        body: async () => {
            const excluded = await exclude(reply3Continuation);
            expect(excluded.status === 200 && excluded.body.messageId === reply3, `stored under the first message (got ${JSON.stringify(excluded.body)})`);
            expect((await ContextExclusion.count({ where: { chatId: GROUP, messageId: reply3 } })) === 1, 'one row, canonical id');
            const text = await contextTextOf(answerToContinuation);
            expect(!text.includes('B3-TEXT'), 'the reply is not in the context');
            expect(text.includes('U3-TEXT') && text.includes('[replying to a message you cannot see]'), 'the answer to its second message cannot see it');
        },
    },
    {
        name: 'unknown ids are 404, album sub-images 400',
        body: async () => {
            const missing = await exclude(424242);
            expect(missing.status === 404 && missing.body.error?.code === 'not_found', `unknown → 404 (got ${missing.status})`);
            const sub = await exclude(albumSub);
            expect(sub.status === 400 && sub.body.error?.code === 'invalid', `sub-image → 400 (got ${sub.status})`);
            expect((await exclude(albumFirst)).status === 200, 'the album itself can be excluded');
            expect((await include(albumFirst)).status === 200, 'and put back');
        },
    },
    {
        name: 'repeated writes answer 200 and audit nothing',
        body: async () => {
            const first = await exclude(messageA);
            const audits = await auditCount();
            const again = await exclude(messageA);
            expect(again.status === 200 && again.body.createdAt === first.body.createdAt, 'a second PUT answers the original row');
            expect((await auditCount()) === audits, 'and writes no audit');

            const restored = await include(messageA);
            expect(restored.status === 200 && restored.body.excluded === false && restored.body.messageId === messageA, 'DELETE restores');
            const audit = await SettingsAudit.findOne({ where: { scope: `chat:${GROUP}` }, order: [['id', 'DESC']] });
            expect((await auditCount()) === audits + 1 && audit?.key === 'include' && audit.newValue === String(messageA), 'audit: include');
            const repeated = await include(messageA);
            expect(repeated.status === 200 && repeated.body.excluded === false, 'DELETE without a row answers 200');
            expect((await auditCount()) === audits + 1, 'and writes no audit');
            expect((await contextTextOf(triggerC)).includes('A-TEXT'), 'A is back in the context');
        },
    },
    {
        name: 'excluding the trigger does not take it out of its own reply',
        body: async () => {
            expect((await exclude(triggerC)).status === 200, 'C excluded');
            const { messages } = await buildContext(await rowOf(triggerC), { model: 'gemini-4-argon' });
            const last = messages.at(-1);
            const texts = (last?.content ?? []).map((part) => part.text ?? '');
            expect(texts.some((text) => text.includes('C-TEXT')), 'the trigger is still the last turn');
            expect(texts.some((text) => text.startsWith('[system] 运行时信息')), 'and carries the runtime block');
            expect((await include(triggerC)).status === 200, 'C restored');
        },
    },
    {
        name: 'the cleanup drops an exclusion only together with its message',
        body: async () => {
            const eightDaysAgo = new Date(Date.now() - 8 * DAY_MS);
            // 1. bot row date reset by a version switch: the message lives on
            const ask = await seedMessage({ text: 'cleanup ask' });
            const resetReply = await seedMessage({ replyToId: ask, text: 'reset reply', fromBot: true, date: new Date() });
            await seedBotResponse(resetReply, ask, 'reset reply', { createdAt: eightDaysAgo });
            // 2. message gone from both tables
            const goneId = 990_001;
            // 3. message row gone, bot_responses row still there
            const responseOnly = 990_002;
            await seedBotResponse(responseOnly, ask, 'response only');
            // 4. recent exclusion of a gone message
            const recentGone = 990_003;
            for (const [messageId, createdAt] of [
                [resetReply, eightDaysAgo],
                [goneId, eightDaysAgo],
                [responseOnly, eightDaysAgo],
                [recentGone, new Date(Date.now() - DAY_MS)],
            ] as const) {
                await ContextExclusion.create({ chatId: GROUP, messageId, createdAt, createdBy: ALICE.id });
            }

            await clearExpiredData();
            const kept = async (messageId: number): Promise<boolean> =>
                (await ContextExclusion.count({ where: { chatId: GROUP, messageId } })) === 1;
            expect(await kept(resetReply), 'kept: the bot row (date reset) still exists');
            expect(!(await kept(goneId)), 'dropped: older than 7 days and the message is gone');
            expect(await kept(responseOnly), 'kept: the bot_responses row still exists');
            expect(await kept(recentGone), 'kept: younger than 7 days');
            expect(await kept(outsideX), 'kept: a live exclusion');
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
reportResults(results);
