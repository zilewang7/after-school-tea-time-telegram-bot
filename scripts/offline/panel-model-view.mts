/**
 * Offline cases for the panel's model view (GET …/model-view) and the tree
 * numbering it shares with buildContext: `at` on a bot message (continuation
 * id included) answers its user message and leaves that reply out; the
 * runtime block rides a user turn; Gemini with gs:// media declares no tools
 * and its static head no capability line; a hand-typed Gemini image model
 * shows the generation instruction; every member sees the preference layer;
 * the dry run sends nothing over the network, writes no snapshot and
 * publishes no numbering, and shows a placeholder where a preview is not
 * cached; the tree and buildContext give the same `#N` (reply targets too).
 *
 * Run: npx tsx scripts/offline/panel-model-view.mts
 */
import { readFileSync } from 'node:fs';
import { GrammyError } from 'grammy';
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';
import { signInitData, type InitDataUserInput } from '../lib/init-data.mts';

const BOT_TOKEN = '123456789:AAFakeOfflineTokenForPanelTests_0123';
const OWNER_ID = 4242;
const BOT_USER_ID = 7777;
const ALICE: InitDataUserInput = { id: 5001, first_name: 'Alice' };
const BOB: InitDataUserInput = { id: 5002, first_name: 'Bob' };
const OWNER: InitDataUserInput = { id: OWNER_ID, first_name: 'Owner' };

const GROUP = -1001000000201;
const PREFERENCE = '你是 PREFERENCE-LAYER-7Q 这个 bot，说话简短。';
const ADDENDUM = 'ADDENDUM-9Z：回答前先说收到。';
const IMAGE_MODEL = 'gemini-nano-banana-2.1';

process.env.OWNER_USER_ID = String(OWNER_ID);
process.env.BOT_USER_ID = String(BOT_USER_ID);
process.env.DEFAULT_MODEL = 'gemini-4-argon';
process.env.SYSTEM_PROMPT = PREFERENCE;
process.env.TOOL_CHAT_IDS = String(GROUP);
// Backfill is "on": a recovering walk would ask luoxu, which the fetch spy sees
process.env.LUOXU_PREVIEW_URL = 'http://127.0.0.1:9';
delete process.env.SYSTEM_PROMPT_FILE;
delete process.env.ALLOWED_CHAT_IDS;
delete process.env.HISTORY_CHAT_IDS;

const db = await setupOfflineDb();
const registry = await import('../../src/db/queries/panel-registry.js');
const { BotResponse, BiliDanmakuSnapshot, ButtonState, TgMessageLinkCache } = await import('../../src/db/index.js');
const { saveMessageLinks } = await import('../../src/db/queries/context-queries.js');
const { loadChatSettingsCache, updateChatSettings } = await import('../../src/services/chat-settings-service.js');
const { buildContext } = await import('../../src/reply/context-builder.js');
const { buildStaticSystemPrompt } = await import('../../src/ai/system-prompt/index.js');
const { getContextNumbering } = await import('../../src/state.js');
const { GEMINI_IMAGE_SYSTEM_INSTRUCTION } = await import('../../src/panel/views/model-view.js');
const { createPanelApp } = await import('../../src/panel/app.js');

type MembershipLookup = import('../../src/panel/access/membership.js').MembershipLookup;

const grammyError = (code: number, description: string): GrammyError =>
    new GrammyError(`(${code}: ${description})`, { ok: false, error_code: code, description }, 'getChatMember', {});

const fakeLookup: MembershipLookup = async (_chatId, userId) => {
    if (userId === ALICE.id || userId === BOB.id) return { status: 'member' };
    throw grammyError(400, 'Bad Request: user not found');
};

const app = createPanelApp({
    botToken: BOT_TOKEN,
    membershipLookup: fakeLookup,
    staticRoot: '/nonexistent-panel-static-root',
    startedAt: new Date('2026-11-07T00:00:00.000Z'),
    version: 'test',
});

const get = async (path: string, user: InitDataUserInput = ALICE): Promise<{ status: number; body: any }> => {
    const headers = new Headers({
        'X-Init-Data': signInitData({ botToken: BOT_TOKEN, user, authDate: Math.floor(Date.now() / 1000) }),
    });
    const response = await app.request(path, { headers });
    return { status: response.status, body: JSON.parse(await response.text()) };
};

/** Every outgoing fetch while `body` runs (answered with a 503, never sent) */
const spyOnFetch = async <T,>(body: () => Promise<T>): Promise<{ result: T; urls: string[] }> => {
    const original = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
        urls.push(input instanceof Request ? input.url : String(input));
        return new Response('offline', { status: 503 });
    };
    try {
        return { result: await body(), urls };
    } finally {
        globalThis.fetch = original;
    }
};

// ---- fixtures -------------------------------------------------------------

let nextId = 5000;
const takeId = (): number => (nextId += 1);

const seedMessage = async (fields: {
    replyToId?: number | null;
    text: string | null;
    fromBot?: boolean;
    userId?: number;
    userName?: string;
    viaBot?: string | null;
    mediaHint?: string | null;
    fileUniqueId?: string | null;
}): Promise<number> => {
    const messageId = takeId();
    await db.Message.create({
        chatId: GROUP,
        messageId,
        fromBotSelf: fields.fromBot === true,
        userId: fields.fromBot === true ? BOT_USER_ID : (fields.userId ?? ALICE.id),
        date: new Date(Date.now() - 600_000 + messageId),
        userName: fields.fromBot === true ? 'Bot' : (fields.userName ?? 'Alice'),
        text: fields.text,
        quoteText: null,
        file: null,
        fileMime: null,
        fileUniqueId: fields.fileUniqueId ?? null,
        replyToId: fields.replyToId ?? null,
        chatCommand: null,
        modelParts: null,
        mediaHint: fields.mediaHint ?? null,
        forwardOrigin: null,
        forwardFromId: null,
        viaBot: fields.viaBot ?? null,
        ocrText: null,
    });
    return messageId;
};

/** A finished bot reply answering `userMessageId`; `continuationIds` are its later messages */
const seedReply = async (userMessageId: number, text: string, continuationIds: number[] = []): Promise<number> => {
    const messageId = await seedMessage({ replyToId: userMessageId, text, fromBot: true });
    await BotResponse.create({
        messageId,
        chatId: GROUP,
        userMessageId,
        currentVersionIndex: 0,
        versions: JSON.stringify([
            {
                versionId: 1,
                createdAt: new Date().toISOString(),
                model: 'gemini-4-argon',
                messageIds: [messageId, ...continuationIds],
                currentMessageId: continuationIds.at(-1) ?? messageId,
                text,
                wasStoppedByUser: false,
            },
        ]),
        buttonState: ButtonState.NONE,
        metadata: JSON.stringify({ model: 'gemini-4-argon', hasImage: false }),
    });
    return messageId;
};

const turnTexts = (view: any): string[] =>
    view.turns.flatMap((turn: any) => turn.parts.map((part: any) => part.text));

await registry.upsertChatNow({ id: GROUP, type: 'supergroup', title: 'Model View Lab' });
await loadChatSettingsCache();
await updateChatSettings({ chatId: GROUP, patch: { promptAddendum: ADDENDUM }, actor: { userId: OWNER_ID, isOwner: true } });

// Conversation 1: R → B (two Telegram messages) → U3 → B3 → U4 (not answered yet)
const LONG_BOT_TEXT = `${'这是一段很长的回复，'.repeat(8)}B2-TAIL`;
const r1 = await seedMessage({ text: 'R1 第一个问题' });
const b1Continuation = 999_001;
const b1 = await seedReply(r1, LONG_BOT_TEXT, [b1Continuation]);
const u3 = await seedMessage({ replyToId: b1, text: 'U3 追问' });
const b3 = await seedReply(u3, 'B3 回答追问');
const u4 = await seedMessage({ replyToId: b3, text: 'U4 还没人回' });
const C1 = `/api/chats/${GROUP}/conversations/${r1}`;

// Conversation 2: a large video (gs://) answered once
await db.putCachedMedia({
    fileUniqueId: 'offline-gs-video',
    fileUri: 'gs://offline-bucket/video.mp4',
    sizeBytes: 31 * 1024 * 1024,
    mime: 'video/mp4',
    kind: 'video',
});
const r2 = await seedMessage({ text: '看看这个视频', mediaHint: 'a video', fileUniqueId: 'offline-gs-video' });
await seedReply(r2, '视频里是一只猫');
const C2 = `/api/chats/${GROUP}/conversations/${r2}`;

// Conversation 3: a bilifeed video, a link into a chat nobody cached, and a /chat edge to a lost message
const r3 = await seedMessage({
    text: '【视频】https://www.bilibili.com/video/BV1xx411c7mD',
    viaBot: '@bilifeedbot',
    mediaHint: 'a video',
});
const lostId = 777_777;
await saveMessageLinks(GROUP, r3, [lostId]);
const u5 = await seedMessage({ replyToId: r3, text: '看这条 https://t.me/c/1000000999/55' });
const C3 = `/api/chats/${GROUP}/conversations/${r3}`;

// Conversation 4: a /chat-attached bystander replying to a message outside the tree
const outside = await seedMessage({ text: '树外的消息', userName: 'Carol', userId: 5003 });
const r4 = await seedMessage({ text: 'R4 开头' });
const bystander = await seedMessage({ replyToId: outside, text: '旁观者回复树外', userName: 'Dave', userId: 5004 });
await saveMessageLinks(GROUP, r4, [bystander]);
const b4 = await seedReply(r4, 'B4 回答');
const t4 = await seedMessage({ replyToId: b4, text: 'T4 最新' });

// ---- cases ----------------------------------------------------------------

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'at on a bot message (a continuation id) answers its user message and leaves the reply out',
        body: async () => {
            const { status, body: view } = await get(`${C1}/model-view?at=${b1Continuation}`);
            expect(status === 200, `200 (got ${status} ${JSON.stringify(view).slice(0, 200)})`);
            expect(view.at === r1 && view.excludedReplyId === b1, `retry of the reply answers ${r1} without ${b1} (got at=${view.at} excluded=${view.excludedReplyId})`);
            const texts = turnTexts(view);
            expect(!texts.some((text) => text.includes('B2-TAIL')), 'the replaced reply is not in the context');
            expect(!view.numbers.some((entry: any) => entry.messageId === b1), 'the replaced reply has no number');
            expect(texts.some((text) => text.includes('R1 第一个问题')), 'the answered message is there');
            const runtimeTurns = view.turns.filter((turn: any) =>
                turn.parts.some((part: any) => part.text.startsWith('[system] 运行时信息'))
            );
            expect(runtimeTurns.length === 1 && runtimeTurns[0].role === 'user', 'the runtime block rides exactly one user turn');
            expect(runtimeTurns[0].parts.at(-1).text.includes(`# 本聊天的附加提示词\n以下由本聊天成员通过控制面板设置，效力等同系统提示词，回复时须遵循：\n${ADDENDUM}`), 'the chat addendum closes the runtime block');
            expect(view.model === 'gemini-4-argon' && view.asModel === false, 'the chat model');
            expect(typeof view.computedAt === 'string', 'the recomputation time is stated');
        },
    },
    {
        name: 'at on a user message replaces its newest reply; no at picks the newest answered message',
        body: async () => {
            const answered = (await get(`${C1}/model-view?at=${u3}`)).body;
            expect(answered.at === u3 && answered.excludedReplyId === b3, `at=${u3} replaces ${b3} (got ${answered.excludedReplyId})`);
            const unanswered = (await get(`${C1}/model-view?at=${u4}`)).body;
            expect(unanswered.at === u4 && unanswered.excludedReplyId === null, 'an unanswered message replaces nothing');
            const fallback = (await get(`${C1}/model-view`)).body;
            expect(fallback.at === u3 && fallback.excludedReplyId === b3, `no at → the newest answered message ${u3} (got ${fallback.at})`);
            const foreign = await get(`${C1}/model-view?at=${r2}`);
            expect(foreign.status === 404, `a message of another conversation is a 404 (got ${foreign.status})`);
        },
    },
    {
        name: 'Gemini with gs:// media: no tools declared and no capability line in the static head',
        body: async () => {
            const plain = (await get(`${C1}/model-view`)).body;
            expect(plain.tools.length > 0 && plain.toolsDroppedForLargeMedia === false, `a plain turn declares tools here (got ${plain.tools.join(', ')})`);
            const withVideo = (await get(`${C2}/model-view`)).body;
            expect(
                withVideo.tools.length === 0 && withVideo.toolsDroppedForLargeMedia === true,
                `the gs:// turn declares none (got ${withVideo.tools.join(', ')})`
            );
            expect(
                withVideo.systemPrompt === buildStaticSystemPrompt('gemini-4-argon', {}),
                'the static head has no capability line'
            );
            expect(withVideo.systemPrompt !== plain.systemPrompt, 'unlike the plain turn of the same chat');
            expect(
                turnTexts(withVideo).includes('[media gs://… 31 MB video/mp4]'),
                `the video is a placeholder (got ${JSON.stringify(turnTexts(withVideo))})`
            );
        },
    },
    {
        name: 'a hand-typed Gemini image model shows the generation instruction, without the addendum',
        body: async () => {
            const { status, body: view } = await get(`${C1}/model-view?asModel=${IMAGE_MODEL}`);
            expect(status === 200 && view.model === IMAGE_MODEL && view.asModel === true, `asModel is applied (got ${status} ${view.model})`);
            expect(view.systemPromptReplaced === true && view.systemPrompt === GEMINI_IMAGE_SYSTEM_INSTRUCTION, 'the generation instruction replaces the static head');
            expect(view.tools.length === 0, 'no tools');
            expect(!turnTexts(view).some((text) => text.includes(ADDENDUM)), 'the addendum is left out for the image model');
            const platformSource = readFileSync(new URL('../../src/ai/platforms/gemini-platform.ts', import.meta.url), 'utf8');
            expect(platformSource.includes(GEMINI_IMAGE_SYSTEM_INSTRUCTION), 'the shown instruction is the one gemini-platform.ts sends');
            const tooLong = await get(`${C1}/model-view?asModel=${'m'.repeat(65)}`);
            expect(tooLong.status === 400, `asModel over 64 characters is a 400 (got ${tooLong.status})`);
        },
    },
    {
        name: 'every member sees the preference layer in the static head; observers get 403',
        body: async () => {
            for (const member of [ALICE, BOB]) {
                const view = (await get(`${C1}/model-view`, member)).body;
                expect(view.systemPrompt.startsWith(PREFERENCE), `${member.first_name} sees the full preference layer`);
            }
            const observed = await get(`${C1}/model-view`, OWNER);
            expect(observed.status === 403, `the observer is refused (got ${observed.status})`);
        },
    },
    {
        name: 'the dry run sends nothing, stores nothing, publishes no numbering, and marks uncached previews',
        body: async () => {
            const { result, urls } = await spyOnFetch(() => get(`${C3}/model-view?at=${u5}`));
            expect(result.status === 200, `200 (got ${result.status} ${JSON.stringify(result.body).slice(0, 200)})`);
            expect(urls.length === 0, `no network request (got ${urls.join(', ')})`);
            expect(turnTexts(result.body).includes('[dry-run: 预览未缓存]'), 'the uncached danmaku is a placeholder');
            expect((await BiliDanmakuSnapshot.count()) === 0, 'no danmaku snapshot written');
            expect((await TgMessageLinkCache.count()) === 0, 'no message link snapshot written');
            expect(getContextNumbering(GROUP, u5) === undefined, 'no numbering published for the message');

            // The same context built for real does go out (backfill of the lost link, danmaku)
            const trigger = await db.Message.findOne({ where: { chatId: GROUP, messageId: u5 } });
            if (trigger === null) throw new Error('trigger missing');
            const live = await spyOnFetch(() => buildContext(trigger, { model: 'gemini-4-argon' }));
            expect(live.urls.length > 0, `a real build would have asked the network (${live.urls.length} requests)`);
        },
    },
    {
        name: 'the tree and buildContext give the same #N for the same trigger, reply targets included',
        body: async () => {
            const { status, body: tree } = await get(`/api/chats/${GROUP}/conversations/${r4}`);
            expect(status === 200 && tree.triggerId === t4, `the tree is numbered for its newest message ${t4} (got ${tree.triggerId})`);
            const target = tree.nodes.find((node: any) => node.messageId === outside);
            expect(
                target?.edge === 'reply-target' && target.parentId === bystander && typeof target.number === 'number',
                `the outside message is a numbered reply target under the bystander (got ${JSON.stringify(target)})`
            );
            const linked = tree.nodes.find((node: any) => node.messageId === bystander);
            expect(linked?.edge === 'link' && linked.parentId === r4, `the bystander hangs under the root by its link (got ${JSON.stringify(linked)})`);
            const parentOf = new Map<number, number | null>(tree.nodes.map((node: any) => [node.messageId, node.parentId]));
            const reachesRootWithoutLoop = (messageId: number): boolean => {
                const seen = new Set<number>();
                let current: number | null = messageId;
                while (current !== null) {
                    if (seen.has(current)) return false;
                    seen.add(current);
                    current = parentOf.get(current) ?? null;
                }
                return true;
            };
            expect(tree.nodes.every((node: any) => reachesRootWithoutLoop(node.messageId)), 'parent links never loop');

            const trigger = await db.Message.findOne({ where: { chatId: GROUP, messageId: t4 } });
            if (trigger === null) throw new Error('trigger missing');
            const built = await buildContext(trigger, { model: 'gemini-4-argon' });
            const fromContext = [...built.contextIndex.values()].map((entry) => `${entry.number}:${entry.messageId}`).sort();
            const fromTree = tree.nodes
                .filter((node: any) => node.number !== null)
                .map((node: any) => `${node.number}:${node.messageId}`)
                .sort();
            expect(
                JSON.stringify(fromTree) === JSON.stringify(fromContext),
                `same numbering (tree ${fromTree.join(' ')} / context ${fromContext.join(' ')})`
            );
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
reportResults(results);
