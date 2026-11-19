/**
 * Offline cases for the batch exclusion endpoint (design 2026-1119-2016 §4.5):
 * POST /api/chats/:chatId/exclusions. One transaction and one audit row per
 * changed id (the same `exclude` / `include` rows the single-message endpoint
 * writes), idempotent repeats, continuation ids normalized to the reply's first
 * message, deduplicated input, missing messages and album sub-images reported
 * instead of failing, the 100-id boundary, the member gate, and the tree's
 * `excluded` flags and #N after a re-read.
 *
 * Run: npx tsx scripts/offline/panel-exclusion-batch.mts
 */
import { GrammyError } from 'grammy';
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';
import { signInitData, type InitDataUserInput } from '../lib/init-data.mts';

const BOT_TOKEN = '123456789:AAFakeOfflineTokenForPanelTests_0123';
const OWNER_ID = 4242;
const BOT_USER_ID = 7777;
const ALICE: InitDataUserInput = { id: 5001, first_name: 'Alice' };
const BOB: InitDataUserInput = { id: 5002, first_name: 'Bob' };
const OWNER: InitDataUserInput = { id: OWNER_ID, first_name: 'Owner' };
const GROUP = -1001000000302;
/** The biggest batch the endpoint accepts */
const MAX_BATCH = 100;

process.env.OWNER_USER_ID = String(OWNER_ID);
process.env.BOT_USER_ID = String(BOT_USER_ID);
process.env.DEFAULT_MODEL = 'gemini-4-argon';
delete process.env.ALLOWED_CHAT_IDS;

const db = await setupOfflineDb();
const registry = await import('../../src/db/queries/panel-registry.js');
const { BotResponse, ButtonState } = await import('../../src/db/index.js');
const { ContextExclusion } = await import('../../src/db/contextExclusionDTO.js');
const { SettingsAudit } = await import('../../src/db/settingsAuditDTO.js');
const { loadChatSettingsCache } = await import('../../src/services/chat-settings-service.js');
const { createPanelApp } = await import('../../src/panel/app.js');

type MembershipLookup = import('../../src/panel/access/membership.js').MembershipLookup;

const grammyError = (code: number, description: string): GrammyError =>
    new GrammyError(`(${code}: ${description})`, { ok: false, error_code: code, description }, 'getChatMember', {});

/** Alice is in the group; everyone else's lookup fails (the owner is then an observer) */
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
    rateLimit: { limit: 10_000, windowMs: 60_000 },
});

interface TestResponse {
    status: number;
    // The panel's JSON envelope; assertions read it field by field
    body: any;
}

const request = async (
    method: string,
    path: string,
    options: { user?: InitDataUserInput; body?: unknown } = {}
): Promise<TestResponse> => {
    const headers = new Headers({
        'X-Init-Data': signInitData({
            botToken: BOT_TOKEN,
            user: options.user ?? ALICE,
            authDate: Math.floor(Date.now() / 1000),
        }),
    });
    const init: RequestInit = { method, headers };
    if (options.body !== undefined) {
        headers.set('Content-Type', 'application/json');
        init.body = JSON.stringify(options.body);
    }
    const response = await app.request(path, init);
    return { status: response.status, body: JSON.parse(await response.text()) };
};

const exclusionsPath = `/api/chats/${GROUP}/exclusions`;

const batch = async (
    action: 'exclude' | 'restore',
    messageIds: readonly number[],
    user: InitDataUserInput = ALICE
): Promise<TestResponse> => request('POST', exclusionsPath, { body: { action, messageIds }, user });

const sameIds = (actual: unknown, expected: readonly unknown[]): boolean =>
    JSON.stringify(actual) === JSON.stringify(expected);

// ---- fixtures -------------------------------------------------------------

let nextId = 8000;
const takeId = (): number => (nextId += 1);

const seedMessage = async (fields: {
    replyToId?: number | null;
    text: string | null;
    fromBot?: boolean;
    date?: Date;
}): Promise<number> => {
    const messageId = takeId();
    await db.Message.create({
        chatId: GROUP,
        messageId,
        fromBotSelf: fields.fromBot === true,
        userId: fields.fromBot === true ? BOT_USER_ID : ALICE.id,
        date: fields.date ?? new Date(Date.now() - 600_000 + messageId),
        userName: fields.fromBot === true ? 'Bot' : 'Alice',
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
    options: { continuationIds?: number[] } = {}
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
    });
};

/** A user message and the bot reply that answers it */
const seedBotReply = async (
    askText: string,
    text: string,
    options: { continuationIds?: number[] } = {}
): Promise<{ ask: number; bot: number }> => {
    const ask = await seedMessage({ text: askText });
    const bot = await seedMessage({ replyToId: ask, text, fromBot: true });
    await seedBotResponse(bot, ask, text, options);
    return { ask, bot };
};

const auditCount = (): Promise<number> => SettingsAudit.count({ where: { scope: `chat:${GROUP}` } });

const excludedIds = async (): Promise<number[]> => {
    const rows = await ContextExclusion.findAll({ where: { chatId: GROUP }, attributes: ['messageId'] });
    return rows.map((row) => row.messageId);
};

/** Of `messageIds`, the ones that have an exclusion row now */
const storedExclusions = async (messageIds: readonly number[]): Promise<number[]> => {
    const stored = new Set(await excludedIds());
    return messageIds.filter((messageId) => stored.has(messageId));
};

interface AuditTail {
    key: string;
    newValue: string | null;
    oldValue: string | null;
    actorId: number;
}

/** The newest `count` audit rows in write order (oldest of them first) */
const auditTail = async (count: number): Promise<AuditTail[]> => {
    const rows = await SettingsAudit.findAll({
        where: { scope: `chat:${GROUP}` },
        order: [['id', 'DESC']],
        limit: count,
    });
    return rows
        .map((row) => ({
            key: row.key,
            newValue: row.newValue,
            oldValue: row.oldValue,
            actorId: row.actorId,
        }))
        .reverse();
};

await registry.upsertChatNow({ id: GROUP, type: 'supergroup', title: 'Batch Exclusion Lab' });
await loadChatSettingsCache();

// ---- cases ----------------------------------------------------------------

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'a batch exclude writes one row and one audit row per message',
        body: async () => {
            const first = await seedMessage({ text: 'batch-1 用户第一条' });
            const { bot } = await seedBotReply('batch-1 提问', 'batch-1 机器人回答');
            const third = await seedMessage({ text: 'batch-1 用户第三条' });
            const auditsBefore = await auditCount();

            const response = await batch('exclude', [first, bot, third]);
            expect(response.status === 200, `POST answers 200 (got ${response.status} ${JSON.stringify(response.body)})`);
            expect(response.body.action === 'exclude', 'the answer repeats the action');
            expect(
                sameIds(response.body.changed, [first, bot, third]),
                `changed is the three ids in request order (got ${JSON.stringify(response.body.changed)})`
            );
            expect(
                sameIds(response.body.unchanged, []) &&
                    sameIds(response.body.missing, []) &&
                    sameIds(response.body.albumItems, []),
                'nothing is unchanged, missing or an album item'
            );
            expect(
                sameIds(await storedExclusions([first, bot, third]), [first, bot, third]),
                'all three rows are stored'
            );

            const tail = await auditTail(3);
            expect(
                (await auditCount()) === auditsBefore + 3 &&
                    tail.every((entry) => entry.key === 'exclude' && entry.oldValue === null && entry.actorId === ALICE.id),
                'exactly three audit rows, key exclude, no old value, actor Alice'
            );
            expect(
                sameIds(tail.map((entry) => entry.newValue), [String(first), String(bot), String(third)]),
                `each audit row names its message (got ${JSON.stringify(tail.map((entry) => entry.newValue))})`
            );
        },
    },
    {
        name: 'a repeated batch excludes nothing and audits nothing',
        body: async () => {
            const ids = [
                await seedMessage({ text: 'batch-2 A' }),
                await seedMessage({ text: 'batch-2 B' }),
                await seedMessage({ text: 'batch-2 C' }),
            ];
            const firstWrite = await batch('exclude', ids);
            expect(firstWrite.status === 200 && sameIds(firstWrite.body.changed, ids), 'the first write changes all three');
            const audits = await auditCount();

            const repeat = await batch('exclude', ids);
            expect(
                repeat.status === 200 && sameIds(repeat.body.changed, []) && sameIds(repeat.body.unchanged, ids),
                `the repeat answers unchanged (got ${JSON.stringify(repeat.body)})`
            );
            expect((await auditCount()) === audits, 'and writes no audit row');
            expect(sameIds(await storedExclusions(ids), ids), 'the rows are still there');
        },
    },
    {
        name: 'duplicate requested ids are written once, in request order',
        body: async () => {
            const first = await seedMessage({ text: 'batch-3 A' });
            const { bot } = await seedBotReply('batch-3 提问', 'batch-3 机器人回答');
            const third = await seedMessage({ text: 'batch-3 C' });
            const response = await batch('exclude', [third, first, third, bot]);
            expect(
                response.status === 200 && sameIds(response.body.changed, [third, first, bot]),
                `one change per id, in first-seen order (got ${JSON.stringify(response.body.changed)})`
            );
            expect((await storedExclusions([third, first, bot])).length === 3, 'three rows, not four');
            const tail = await auditTail(3);
            expect(
                sameIds(tail.map((entry) => entry.newValue), [String(third), String(first), String(bot)]),
                'three audit rows, one per message'
            );
        },
    },
    {
        name: "a bot reply's continuation id is normalized to the reply's first message",
        body: async () => {
            const continuationId = 888_101;
            const { bot } = await seedBotReply('batch-4 提问', 'batch-4 分两条发的回答', {
                continuationIds: [continuationId],
            });
            const auditsBefore = await auditCount();
            const response = await batch('exclude', [bot, continuationId]);
            expect(
                response.status === 200 &&
                    sameIds(response.body.changed, [bot]) &&
                    sameIds(response.body.unchanged, []),
                `both ids land on the first message, once (got ${JSON.stringify(response.body)})`
            );
            expect(sameIds(await storedExclusions([bot, continuationId]), [bot]), 'the row is under the first message');
            const tail = await auditTail(1);
            expect(
                (await auditCount()) === auditsBefore + 1 && tail[0]?.newValue === String(bot),
                'one audit row, canonical id'
            );
        },
    },
    {
        name: 'missing messages and album sub-images are reported, the rest is written',
        body: async () => {
            const albumFirst = await seedMessage({ text: 'batch-5 相册第一张' });
            const albumSub = await seedMessage({ replyToId: albumFirst, text: `sub image of [${albumFirst}]` });
            const valid = await seedMessage({ text: 'batch-5 有效消息' });
            const missingId = 424_242;
            const auditsBefore = await auditCount();

            const response = await batch('exclude', [albumSub, missingId, valid]);
            expect(response.status === 200, `the request is not failed by the skipped ids (got ${response.status})`);
            expect(sameIds(response.body.changed, [valid]), `the valid id is changed (got ${JSON.stringify(response.body.changed)})`);
            expect(sameIds(response.body.missing, [missingId]), 'the unknown id comes back missing');
            expect(sameIds(response.body.albumItems, [albumSub]), 'the album sub-image is reported apart');
            expect(
                sameIds(await storedExclusions([albumSub, missingId, valid]), [valid]),
                'only the valid id has a row'
            );
            const tail = await auditTail(1);
            expect(
                (await auditCount()) === auditsBefore + 1 &&
                    tail[0]?.key === 'exclude' &&
                    tail[0]?.newValue === String(valid),
                'one audit row, for the valid id only'
            );
        },
    },
    {
        name: 'a batch restore deletes the rows and audits include; a repeat changes nothing',
        body: async () => {
            const first = await seedMessage({ text: 'batch-6 A' });
            const second = await seedMessage({ text: 'batch-6 B' });
            const untouched = await seedMessage({ text: 'batch-6 C' });
            expect(sameIds((await batch('exclude', [first, second])).body.changed, [first, second]), 'both excluded first');
            const audits = await auditCount();

            const restored = await batch('restore', [first, second, untouched]);
            expect(restored.status === 200, `restore answers 200 (got ${restored.status})`);
            expect(
                sameIds(restored.body.changed, [first, second]) && sameIds(restored.body.unchanged, [untouched]),
                `the excluded ones change, the rest do not (got ${JSON.stringify(restored.body)})`
            );
            expect(sameIds(await storedExclusions([first, second, untouched]), []), 'the rows are gone');

            const tail = await auditTail(2);
            expect(
                (await auditCount()) === audits + 2 &&
                    tail.every((entry) => entry.key === 'include' && entry.oldValue === null) &&
                    sameIds(tail.map((entry) => entry.newValue), [String(first), String(second)]),
                `two include audit rows, in request order (got ${JSON.stringify(tail)})`
            );

            const repeat = await batch('restore', [first]);
            expect(
                sameIds(repeat.body.changed, []) && sameIds(repeat.body.unchanged, [first]) && (await auditCount()) === audits + 2,
                'restoring a row that is gone changes and audits nothing'
            );
        },
    },
    {
        name: 'the tree re-read after a batch write has the excluded flags and the shifted #N',
        body: async () => {
            const treePath = `/api/chats/${GROUP}/conversations`;
            const root = await seedMessage({ text: 'batch-7 根' });
            const middle = await seedMessage({ replyToId: root, text: 'batch-7 中间' });
            const bot = await seedMessage({ replyToId: middle, text: 'batch-7 机器人回答', fromBot: true });
            await seedBotResponse(bot, middle, 'batch-7 机器人回答');
            const tip = await seedMessage({ replyToId: bot, text: 'batch-7 追问' });

            const numbersOf = (response: TestResponse): Record<number, number | null> =>
                Object.fromEntries(response.body.nodes.map((node: any) => [node.messageId, node.number]));
            const expectedNumbers: Record<number, number | null> = {
                [root]: 1,
                [middle]: 2,
                [bot]: 3,
                [tip]: 4,
            };

            const before = await request('GET', `${treePath}/${root}`);
            expect(
                before.status === 200 &&
                    (await sameIds(
                        [before.body.nodes.find((node: any) => node.messageId === middle)?.number],
                        [2]
                    )),
                `before: the middle message is #2 (got ${JSON.stringify(numbersOf(before))})`
            );

            expect(sameIds((await batch('exclude', [middle])).body.changed, [middle]), 'the middle message is excluded');
            const after = await request('GET', `${treePath}/${root}`);
            expect(after.status === 200, `the tree still reads (got ${after.status})`);
            const excludedNode = after.body.nodes.find((node: any) => node.messageId === middle);
            expect(
                excludedNode?.excluded === true && excludedNode.number === null,
                `after: the message is flagged excluded and unnumbered (got ${JSON.stringify(excludedNode)})`
            );
            expect(
                JSON.stringify(numbersOf(after)) ===
                    JSON.stringify({ [root]: 1, [middle]: null, [bot]: 2, [tip]: 3 }),
                `after: the rest is renumbered (got ${JSON.stringify(numbersOf(after))})`
            );

            expect(sameIds((await batch('restore', [middle])).body.changed, [middle]), 'restoring it');
            const restored = await request('GET', `${treePath}/${root}`);
            expect(
                JSON.stringify(numbersOf(restored)) === JSON.stringify(expectedNumbers) &&
                    restored.body.nodes.find((node: any) => node.messageId === middle)?.excluded === false,
                `restored: numbers and flags are back (got ${JSON.stringify(numbersOf(restored))})`
            );
        },
    },
    {
        name: 'non-members and observers are refused, writing nothing',
        body: async () => {
            const target = await seedMessage({ text: 'batch-8 只有成员能动' });
            const audits = await auditCount();

            const outsider = await batch('exclude', [target], BOB);
            expect(
                outsider.status === 403 && outsider.body.error?.code === 'forbidden',
                `a non-member gets 403 (got ${outsider.status} ${JSON.stringify(outsider.body)})`
            );
            const observer = await batch('restore', [target], OWNER);
            expect(
                observer.status === 403 && observer.body.error?.code === 'forbidden',
                `the owner, an observer here, gets 403 too (got ${observer.status})`
            );
            expect(sameIds(await storedExclusions([target]), []), 'neither request wrote an exclusion row');
            expect((await auditCount()) === audits, 'nor an audit row');
        },
    },
    {
        name: 'an invalid body is a 400 invalid',
        body: async () => {
            const messageId = await seedMessage({ text: 'batch-9 合法目标' });
            const tooMany = Array.from({ length: MAX_BATCH + 1 }, (_item, index) => 900_000 + index);
            const badBodies: unknown[] = [
                { action: 'exclude', messageIds: [] },
                { action: 'exclude', messageIds: tooMany },
                { action: 'exclude', messageIds: 'message' },
                { action: 'exclude', messageIds: [messageId, 1.5] },
                { action: 'exclude', messageIds: [0] },
                { action: 'exclude', messageIds: [-1] },
                { action: 'remove', messageIds: [messageId] },
                { action: 'exclude' },
                { messageIds: [messageId] },
                { action: 'exclude', messageIds: [messageId], extra: true },
            ];
            for (const [index, body] of badBodies.entries()) {
                const response = await request('POST', exclusionsPath, { body });
                expect(
                    response.status === 400 && response.body.error?.code === 'invalid',
                    `bad body ${index} is 400 invalid (got ${response.status} ${JSON.stringify(response.body)})`
                );
            }
            expect(sameIds(await storedExclusions([messageId]), []), 'no bad body wrote anything');
        },
    },
    {
        name: 'the 100-id boundary is accepted',
        body: async () => {
            const ids = Array.from({ length: MAX_BATCH }, (_item, index) => 910_000 + index);
            const response = await batch('exclude', ids);
            expect(
                response.status === 200 && sameIds(response.body.missing, ids) && sameIds(response.body.changed, []),
                `100 unknown ids are one accepted request, all missing (got ${response.status})`
            );
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
reportResults(results);
