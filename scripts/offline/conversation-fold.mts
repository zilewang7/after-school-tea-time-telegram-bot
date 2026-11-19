/**
 * Offline cases for the default fold of deleted / excluded messages: the
 * combinations the feature's own cases leave out. A message that is excluded
 * and deleted at once; an excluded message whose repliers stay in a share; rows
 * stored before `deletedAt` existed; a bot reply known only to bot_responses;
 * the observer's eight-field placeholder; and the SSR / public JSON contract of
 * the two share kinds.
 *
 * Run: npx tsx scripts/offline/conversation-fold.mts
 */
import { GrammyError } from 'grammy';
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';
import { signInitData, type InitDataUserInput } from '../lib/init-data.mts';

const BOT_TOKEN = '123456789:AAFakeOfflineTokenForPanelTests_0123';
const OWNER_ID = 4242;
const BOT_USER_ID = 9999;
const ALICE: InitDataUserInput = { id: 5001, first_name: 'Alice', username: 'alice' };
const OWNER: InitDataUserInput = { id: OWNER_ID, first_name: 'Owner' };
const GROUP = -1001000000201;

process.env.OWNER_USER_ID = String(OWNER_ID);
process.env.BOT_USER_ID = String(BOT_USER_ID);
process.env.WEBAPP_PUBLIC_URL = 'https://miniapp.test';
process.env.BOT_USER_NAME = 'k_on_test_bot';
process.env.WIDGET_RENDER_URL = '';
process.env.WEBAPP_SHARE_SECRET = 'offline-share-secret';
// Captured web previews are read from the cache only; the URL is a placeholder
process.env.LUOXU_PREVIEW_URL = 'http://luoxu.test';
delete process.env.ALLOWED_CHAT_IDS;

const offlineDb = await setupOfflineDb();
const registry = await import('../../src/db/queries/panel-registry.js');
const db = await import('../../src/db/index.js');
const service = await import('../../src/panel/share/share-link-service.js');
const exclusions = await import('../../src/db/queries/context-exclusions.js');
const { loadChatSettingsCache } = await import('../../src/services/chat-settings-service.js');
const { createPanelApp } = await import('../../src/panel/app.js');

type MembershipLookup = import('../../src/panel/access/membership.js').MembershipLookup;
type PanelApp = ReturnType<typeof createPanelApp>;
type ResponseVersion = import('../../src/db/index.js').ResponseVersion;
type ShareLinkRecord = import('../../src/panel/share/share-types.js').ShareLinkRecord;

const grammyError = (code: number, description: string): GrammyError =>
    new GrammyError(`(${code}: ${description})`, { ok: false, error_code: code, description }, 'getChatMember', {});

/** Alice is a member; the owner observes (the redacted view) */
const fakeLookup: MembershipLookup = async (chatId, userId) => {
    if (chatId === GROUP && userId === ALICE.id) return { status: 'member' };
    throw grammyError(400, 'Bad Request: user not found');
};

const app: PanelApp = createPanelApp({
    botToken: BOT_TOKEN,
    membershipLookup: fakeLookup,
    staticRoot: '/nonexistent-panel-static-root',
    startedAt: new Date('2026-11-09T00:00:00.000Z'),
    version: 'test',
    shareEnabled: true,
});

const initDataFor = (user: InitDataUserInput): string =>
    signInitData({ botToken: BOT_TOKEN, user, authDate: Math.floor(Date.now() / 1000) });

const call = async (path: string, user: InitDataUserInput): Promise<Response> =>
    app.request(path, { headers: { 'X-Init-Data': initDataFor(user) } });

const textOf = async (response: Response): Promise<string> => response.text();
const jsonOf = async (response: Response): Promise<any> => JSON.parse(await response.text());

/** The rendered page body: the `<head>` CSS names the same rich classes */
const mainOf = (html: string): string => {
    const start = html.indexOf('<main>');
    const end = html.indexOf('</main>');
    return start < 0 || end < 0 ? html : html.slice(start, end);
};

// ---- fixtures -------------------------------------------------------------

const MESSAGE_DATE = new Date('2026-11-09T12:00:00.000Z');
const DELETED_AT = new Date('2026-11-18T12:00:00.000Z');

const ROOT_ID = 7001;
const DELETED_BOT_ID = 7002;
const EXCLUDED_DELETED_ID = 7003;
const CHILD_OF_EXCLUDED_ID = 7004;
const SPECIAL_DELETED_ID = 7005;
const ALIVE_BOT_ID = 7006;
const LINKED_ONLY_BOT_ID = 7007;

const BOT_BODY = 'BOT-BODY-IN-FOLD';
const ALIVE_BOT_BODY = 'ALIVE-BOT-BODY';
const LINKED_ONLY_BODY = 'LINKED-ONLY-BOT-BODY';
const EXCLUDED_SECRET = 'EXCLUDED-SECRET-DO-NOT-LEAK';
const SPECIAL_TEXT = 'SPECIAL <script>alert("x")</script> & <b>bold</b>';

const saveUserMessage = async (
    messageId: number,
    text: string,
    replyToId: number | null,
    userName = 'Alice'
): Promise<void> => {
    await offlineDb.Message.create({
        chatId: GROUP,
        messageId,
        fromBotSelf: false,
        userId: ALICE.id,
        date: MESSAGE_DATE,
        userName,
        text,
        quoteText: null,
        file: null,
        fileMime: null,
        fileUniqueId: null,
        replyToId,
        chatCommand: null,
        modelParts: null,
        mediaHint: null,
        forwardOrigin: null,
        forwardFromId: null,
        viaBot: null,
        ocrText: null,
    });
};

const versionOf = (messageId: number, text: string): ResponseVersion => ({
    versionId: 1,
    createdAt: '2026-11-09T12:00:00.000Z',
    messageIds: [messageId],
    currentMessageId: messageId,
    text,
    wasStoppedByUser: false,
});

const saveVersion = async (messageId: number, userMessageId: number, text: string): Promise<void> => {
    const response = await db.createBotResponse(GROUP, messageId, userMessageId, {
        model: 'offline-model',
        hasImage: false,
    });
    response.setVersions([versionOf(messageId, text)]);
    response.currentVersionIndex = 0;
    await response.save();
};

/** A bot reply as production stores it: its own message row plus a bot_responses row */
const saveBotReply = async (messageId: number, userMessageId: number, text: string): Promise<void> => {
    await offlineDb.Message.create({
        chatId: GROUP,
        messageId,
        fromBotSelf: true,
        userId: BOT_USER_ID,
        date: MESSAGE_DATE,
        userName: 'Bot',
        text: '',
        quoteText: null,
        file: null,
        fileMime: null,
        fileUniqueId: null,
        replyToId: userMessageId,
        chatCommand: null,
        modelParts: null,
        mediaHint: null,
        forwardOrigin: null,
        forwardFromId: null,
        viaBot: null,
        ocrText: null,
    });
    await saveVersion(messageId, userMessageId, text);
};

const createShare = async (input: {
    kind: 'conversation';
    rootId: number;
} | { kind: 'reply'; firstMessageId: number }): Promise<ShareLinkRecord> => {
    const created = await service.createUserShare({ ...input, chatId: GROUP, createdBy: ALICE.id });
    if (!created.ok) throw new Error(`could not create the ${input.kind} share: ${created.reason}`);
    return created.share;
};

const OBSERVER_USER_KEYS = ['date', 'edge', 'excluded', 'kind', 'messageId', 'number', 'parentId', 'redacted'];
const TREE_PATH = `/api/chats/${GROUP}/conversations/${ROOT_ID}`;

await registry.upsertChatNow({ id: GROUP, type: 'supergroup', title: 'Fold group' });
await loadChatSettingsCache();

// Root by Alice; a deleted bot reply; a message excluded AND deleted with a
// reply of its own; a deleted message with special characters; a live bot
// reply; and a bot reply known only to bot_responses (pulled in by a link).
await saveUserMessage(ROOT_ID, 'ROOT-TEXT', null);
await saveBotReply(DELETED_BOT_ID, ROOT_ID, BOT_BODY);
await saveUserMessage(EXCLUDED_DELETED_ID, EXCLUDED_SECRET, ROOT_ID);
await saveUserMessage(CHILD_OF_EXCLUDED_ID, 'CHILD-OF-EXCLUDED', EXCLUDED_DELETED_ID);
await saveUserMessage(SPECIAL_DELETED_ID, SPECIAL_TEXT, ROOT_ID, '<Evil & Co>');
await saveBotReply(ALIVE_BOT_ID, ROOT_ID, ALIVE_BOT_BODY);
await saveVersion(LINKED_ONLY_BOT_ID, ROOT_ID, LINKED_ONLY_BODY);
// A `/chat` command on the root pulled the bot_responses-only reply in
await offlineDb.queries.saveMessageLinks(GROUP, ROOT_ID, [LINKED_ONLY_BOT_ID]);

// The deletion watcher's mark, and the panel's exclusion
for (const messageId of [DELETED_BOT_ID, EXCLUDED_DELETED_ID, SPECIAL_DELETED_ID]) {
    await offlineDb.Message.update({ deletedAt: DELETED_AT }, { where: { chatId: GROUP, messageId } });
}
await exclusions.excludeMessage({ chatId: GROUP, messageId: EXCLUDED_DELETED_ID, actorId: ALICE.id });

const conversationShare = await createShare({ kind: 'conversation', rootId: ROOT_ID });
const replyShare = await createShare({ kind: 'reply', firstMessageId: DELETED_BOT_ID });

// The share reads the database per request, so the page/JSON order is the
// stored message order with the excluded message left out
const SHARE_BUBBLE_IDS = [
    ROOT_ID,
    DELETED_BOT_ID,
    CHILD_OF_EXCLUDED_ID,
    SPECIAL_DELETED_ID,
    ALIVE_BOT_ID,
    LINKED_ONLY_BOT_ID,
];

const nodesById = (tree: any): Map<number, any> =>
    new Map<number, any>((Array.isArray(tree.nodes) ? tree.nodes : []).map((node: any) => [node.messageId, node]));

// ---- cases ----------------------------------------------------------------

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'tree: a message excluded and deleted at once keeps both flags and no number',
        body: async () => {
            const response = await call(TREE_PATH, ALICE);
            const tree = await jsonOf(response);
            expect(
                response.status === 200 && tree.access === 'member',
                `a member reads the tree (got ${response.status} ${tree.access})`
            );
            const nodes: any[] = Array.isArray(tree.nodes) ? tree.nodes : [];
            expect(nodes.length === 7, `every message of the tree is there (got ${nodes.length})`);
            const byId = nodesById(tree);

            const both = byId.get(EXCLUDED_DELETED_ID);
            expect(
                both?.excluded === true && both?.deleted === true,
                `an excluded and deleted message carries both flags (got ${JSON.stringify({
                    excluded: both?.excluded,
                    deleted: both?.deleted,
                })})`
            );
            expect(both?.number === null, `it keeps no #N (got ${JSON.stringify(both?.number)})`);
            expect(
                both?.text === EXCLUDED_SECRET,
                'the member tree still carries its text: the fold is a display decision'
            );

            const root = byId.get(ROOT_ID);
            expect(root?.deleted === false && root?.excluded === false, 'the live root is neither flag');
            expect(root?.number === 1, `the root is #1 (got ${JSON.stringify(root?.number)})`);
            for (const messageId of [DELETED_BOT_ID, SPECIAL_DELETED_ID]) {
                expect(byId.get(messageId)?.deleted === true, `message ${messageId} is flagged deleted`);
            }
            expect(
                byId.get(DELETED_BOT_ID)?.number === 2 && byId.get(SPECIAL_DELETED_ID)?.number === 4,
                'a deleted message stays in the context and keeps its #N (only an excluded one loses it)'
            );
            for (const messageId of [CHILD_OF_EXCLUDED_ID, ALIVE_BOT_ID, LINKED_ONLY_BOT_ID]) {
                expect(byId.get(messageId)?.deleted === false, `message ${messageId} is not flagged deleted`);
            }
            expect(
                nodes.every((node) => typeof node.deleted === 'boolean'),
                'every node a member receives states deleted as a boolean'
            );
        },
    },
    {
        name: 'tree: the observer placeholder keeps exactly eight fields; bot nodes carry deleted',
        body: async () => {
            const tree = await jsonOf(await call(TREE_PATH, OWNER));
            expect(tree.access === 'observer', `the owner observes (got ${tree.access})`);
            const nodes: any[] = Array.isArray(tree.nodes) ? tree.nodes : [];
            const userNodes = nodes.filter((node) => node.kind === 'user');
            expect(userNodes.length === 4, `four user nodes (got ${userNodes.length})`);
            for (const node of userNodes) {
                expect(
                    JSON.stringify(Object.keys(node).sort()) === JSON.stringify(OBSERVER_USER_KEYS),
                    `user node ${node.messageId} has exactly its eight fields (got ${Object.keys(node).sort().join(', ')})`
                );
                expect(!Object.hasOwn(node, 'deleted'), `user node ${node.messageId} carries no deleted field`);
                expect(node.redacted === true, `user node ${node.messageId} stays redacted`);
            }
            const excludedUser = userNodes.find((node) => node.messageId === EXCLUDED_DELETED_ID);
            expect(
                excludedUser?.excluded === true && excludedUser?.number === null,
                'the observer keeps the excluded flag and the missing number'
            );
            const botNodes = nodes.filter((node) => node.kind === 'bot');
            expect(botNodes.length === 3, `three bot nodes (got ${botNodes.length})`);
            const botById = new Map<number, any>(botNodes.map((node) => [node.messageId, node]));
            expect(botById.get(DELETED_BOT_ID)?.deleted === true, 'a deleted bot node is flagged for the observer too');
            expect(
                botById.get(ALIVE_BOT_ID)?.deleted === false && botById.get(LINKED_ONLY_BOT_ID)?.deleted === false,
                'live bot nodes stay unflagged for the observer'
            );
            const raw = JSON.stringify(tree);
            expect(!raw.includes(EXCLUDED_SECRET) && !raw.includes(SPECIAL_TEXT), 'an observer never reads the message text');
        },
    },
    {
        name: 'old rows and bot_responses-only replies are not flagged as deleted',
        body: async () => {
            const stored = await offlineDb.Message.findOne({ where: { chatId: GROUP, messageId: ROOT_ID } });
            expect(
                stored?.deletedAt === null,
                `a row stored before the deletion watcher reads NULL (got ${String(stored?.deletedAt)})`
            );
            const tree = await jsonOf(await call(TREE_PATH, ALICE));
            const byId = nodesById(tree);
            const root = byId.get(ROOT_ID);
            expect(root?.deleted === false, 'an old row without a mark is not deleted');
            const child = byId.get(CHILD_OF_EXCLUDED_ID);
            expect(child?.deleted === false, 'a reply to an excluded message is not deleted itself');
            const linkedOnly = byId.get(LINKED_ONLY_BOT_ID);
            expect(linkedOnly !== undefined, 'a bot reply known only to bot_responses is a node');
            expect(
                linkedOnly?.kind === 'bot' && linkedOnly?.deleted === false,
                `the bot_responses-only reply is unflagged (got ${JSON.stringify(linkedOnly?.deleted)})`
            );
            expect(linkedOnly?.reply?.text === LINKED_ONLY_BODY, 'its version text is the bubble text');
        },
    },
    {
        name: 'public JSON: excluded messages are absent; every conversation bubble states deleted',
        body: async () => {
            const response = await app.request(`/api/public/shares/${conversationShare.token}`);
            const raw = await textOf(response);
            expect(response.status === 200, `200 (got ${response.status})`);
            const body = JSON.parse(raw);
            const bubbles: any[] = Array.isArray(body.share.conversation?.bubbles) ? body.share.conversation.bubbles : [];
            expect(
                bubbles.map((bubble) => bubble.messageId).join(',') === SHARE_BUBBLE_IDS.join(','),
                `bubbles keep the message order with the excluded one left out (got ${bubbles
                    .map((bubble) => bubble.messageId)
                    .join(',')})`
            );
            expect(
                !bubbles.some((bubble) => bubble.messageId === EXCLUDED_DELETED_ID),
                'the excluded message is not in the share at all (not folded: left out)'
            );
            expect(!raw.includes(EXCLUDED_SECRET), 'the excluded text never leaves the server');
            expect(
                bubbles.every((bubble) => typeof bubble.deleted === 'boolean'),
                'every conversation bubble states deleted as a boolean'
            );
            expect(
                raw.split('"deleted":').length - 1 === bubbles.length,
                'the field appears once per bubble and nowhere else'
            );
            const byId = new Map<number, any>(bubbles.map((bubble) => [bubble.messageId, bubble]));
            for (const messageId of [DELETED_BOT_ID, SPECIAL_DELETED_ID]) {
                expect(byId.get(messageId)?.deleted === true, `bubble ${messageId} is flagged deleted`);
            }
            for (const messageId of [ROOT_ID, CHILD_OF_EXCLUDED_ID, ALIVE_BOT_ID, LINKED_ONLY_BOT_ID]) {
                expect(byId.get(messageId)?.deleted === false, `bubble ${messageId} is not flagged deleted`);
            }
            expect(
                byId.get(CHILD_OF_EXCLUDED_ID)?.replyTo === null,
                'a reply to the excluded message names no target in the share'
            );
            expect(
                byId.get(DELETED_BOT_ID)?.replyTo?.messageId === ROOT_ID,
                'the deleted bot bubble still names the message it answers'
            );
        },
    },
    {
        name: 'a reply share is unaffected: no deleted field, no conversation bubbles',
        body: async () => {
            const raw = await textOf(await app.request(`/api/public/shares/${replyShare.token}`));
            const body = JSON.parse(raw);
            expect(body.share.kind === 'reply', `the reply share keeps its kind (got ${body.share.kind})`);
            expect(body.share.conversation === undefined, 'a reply share has no conversation key');
            expect(body.share.reply?.firstMessageId === DELETED_BOT_ID, 'the reply payload is the pinned version');
            expect(!raw.includes('"deleted"'), 'a reply share carries no deleted field at all');
        },
    },
    {
        name: 'SSR: only deleted bubbles fold; head in summary, body still in the document',
        body: async () => {
            const page = await textOf(await app.request(`/s/${conversationShare.token}`));
            const html = mainOf(page);
            const folds = html.split('<details class="bubble-fold">').length - 1;
            expect(folds === 2, `exactly the two deleted bubbles fold (got ${folds})`);
            expect(!html.includes('<details class="bubble-fold" open'), 'a folded bubble never starts open');
            expect(
                html.split('<details class="bubble-fold"><summary class="bubble-head">').length - 1 === 2,
                'the summary is the first child of each details'
            );
            expect(html.split('已删除').length - 1 === 2, 'the deletion flag shows once per folded bubble');
            expect(
                html.includes('<article class="bubble bot"><details class="bubble-fold">'),
                'the deleted bot bubble folds'
            );
            expect(
                html.includes('<article class="bubble user"><details class="bubble-fold">'),
                'the deleted user bubble folds'
            );
            expect(
                html.split('<article class="bubble user"><div class="bubble-head">').length - 1 === 2,
                'the live user bubbles keep their old head markup'
            );
            expect(
                html.split('<article class="bubble bot"><div class="bubble-head">').length - 1 === 2,
                'the live bot bubbles keep their old head markup'
            );

            const botFoldStart = html.indexOf('<article class="bubble bot"><details');
            const botFold = html.slice(botFoldStart, html.indexOf('</details>', botFoldStart));
            expect(botFold.includes(BOT_BODY), 'the deleted bot body is still in the HTML (folded, not hidden)');
            expect(botFold.includes('<span class="deleted-flag">已删除</span>'), 'the deleted bot head names the deletion');
            expect(botFold.includes('<summary class="bubble-head">'), 'the deleted bot head is the summary');

            const userFoldStart = html.indexOf('<article class="bubble user"><details');
            const userFold = html.slice(userFoldStart, html.indexOf('</details>', userFoldStart));
            expect(
                userFold.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'),
                `the deleted body is escaped (got ${userFold.slice(0, 240)})`
            );
            expect(
                userFold.includes('&lt;Evil &amp; Co&gt;'),
                `the author name in the summary is escaped (got ${userFold.slice(0, 240)})`
            );
            expect(!userFold.includes('<Evil'), 'no raw author name reaches the summary');
            expect(userFold.includes('&amp;'), 'the ampersand of the deleted body is escaped');
            expect(!userFold.includes('<script>'), 'no raw script tag reaches a deleted body');

            expect(!page.includes(EXCLUDED_SECRET), 'an excluded message is nowhere on the page');
            expect(!page.includes('EXCLUDED-SECRET'), 'its head does not leak either');

            const summaries = [...html.matchAll(/<summary class="bubble-head">([\s\S]*?)<\/summary>/g)];
            expect(summaries.length === 2, `two bubble summaries (got ${summaries.length})`);
            for (const match of summaries) {
                const inner = match[1] ?? '';
                expect(
                    !/<(?:div|p|section|article|details|ul|ol|h[1-6]|blockquote)\b/.test(inner),
                    `a summary holds phrasing content only (got ${inner})`
                );
            }
        },
    },
    {
        name: 'a share whose root is excluded after creation loses the root, not the rest',
        body: async () => {
            await exclusions.excludeMessage({ chatId: GROUP, messageId: ROOT_ID, actorId: ALICE.id });
            const response = await app.request(`/api/public/shares/${conversationShare.token}`);
            const raw = await textOf(response);
            expect(response.status === 200, `the share still answers (got ${response.status})`);
            const bubbles: any[] = JSON.parse(raw).share.conversation.bubbles;
            expect(
                bubbles.map((bubble) => bubble.messageId).join(',') === SHARE_BUBBLE_IDS.slice(1).join(','),
                `only the excluded root leaves (got ${bubbles.map((bubble) => bubble.messageId).join(',')})`
            );
            expect(!raw.includes('ROOT-TEXT'), 'the excluded root text is gone from the JSON');
            const html = mainOf(await textOf(await app.request(`/s/${conversationShare.token}`)));
            expect(!html.includes('ROOT-TEXT'), 'the excluded root is nowhere on the page');
            expect(html.split('<details class="bubble-fold">').length - 1 === 2, 'the other deleted bubbles still fold');
        },
    },
    {
        name: 'SSR: a reply share folds nothing and shows no deletion flag',
        body: async () => {
            const html = mainOf(await textOf(await app.request(`/s/${replyShare.token}`)));
            expect(!html.includes('bubble-fold'), 'no fold on a reply share');
            expect(!html.includes('deleted-flag'), 'no deletion flag on a reply share');
            expect(html.includes(BOT_BODY), 'the pinned version body is on the page');
            expect(html.includes('<div class="bubble-head">'), 'the bubble head keeps its old markup');
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) results.push(await runCase(testCase.name, testCase.body));
reportResults(results);
