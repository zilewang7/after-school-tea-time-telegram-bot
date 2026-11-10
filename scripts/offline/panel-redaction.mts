/**
 * Offline cases for what an observer (the owner, not a member) may see of a
 * conversation, driven through the panel app with self-signed initData and a
 * fake getChatMember: user nodes of the tree and the list's root summary are
 * the eight-field placeholder (other bots' messages included), bot nodes are
 * complete, reply details never carry triggerUserId, and the member-only
 * operations answer 403. Members get the full nodes for comparison.
 *
 * Run: npx tsx scripts/offline/panel-redaction.mts
 */
import { GrammyError } from 'grammy';
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';
import { signInitData, type InitDataUserInput } from '../lib/init-data.mts';

const BOT_TOKEN = '123456789:AAFakeOfflineTokenForPanelTests_0123';
const OWNER_ID = 4242;
const BOT_USER_ID = 7777;
const ALICE: InitDataUserInput = { id: 5001, first_name: 'Alice', username: 'alice' };
const OWNER: InitDataUserInput = { id: OWNER_ID, first_name: 'Owner' };
const STRANGER: InitDataUserInput = { id: 5099, first_name: 'Stranger' };
const HELPER_BOT_ID = 1005;

const GROUP = -1001000000101;
const OTHER_GROUP = -1001000000102;

process.env.OWNER_USER_ID = String(OWNER_ID);
process.env.BOT_USER_ID = String(BOT_USER_ID);
process.env.DEFAULT_MODEL = 'env-default-model';
delete process.env.ALLOWED_CHAT_IDS;

const db = await setupOfflineDb();
const registry = await import('../../src/db/queries/panel-registry.js');
const { BotResponse, ButtonState } = await import('../../src/db/index.js');
const { upsertTelegramUser } = await import('../../src/db/queries/user-queries.js');
const { loadChatSettingsCache } = await import('../../src/services/chat-settings-service.js');
const { createPanelApp } = await import('../../src/panel/app.js');
const { insertReplyMetric } = await import('../../src/db/queries/reply-metrics.js');

type MembershipLookup = import('../../src/panel/access/membership.js').MembershipLookup;
type PanelApp = ReturnType<typeof createPanelApp>;

const grammyError = (code: number, description: string): GrammyError =>
    new GrammyError(`(${code}: ${description})`, { ok: false, error_code: code, description }, 'getChatMember', {});

/** Alice is in both groups; the owner and the stranger are in neither */
const fakeLookup: MembershipLookup = async (_chatId, userId) => {
    if (userId === ALICE.id) return { status: 'member' };
    throw grammyError(400, 'Bad Request: user not found');
};

const app: PanelApp = createPanelApp({
    botToken: BOT_TOKEN,
    membershipLookup: fakeLookup,
    staticRoot: '/nonexistent-panel-static-root',
    startedAt: new Date('2026-11-07T00:00:00.000Z'),
    version: 'test',
});

const call = (path: string, user: InitDataUserInput, method = 'GET', body?: unknown): Promise<Response> => {
    const headers = new Headers({
        'X-Init-Data': signInitData({ botToken: BOT_TOKEN, user, authDate: Math.floor(Date.now() / 1000) }),
    });
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    return Promise.resolve(
        app.request(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    );
};

const jsonOf = async (response: Response): Promise<any> => JSON.parse(await response.text());

// ---- fixtures -------------------------------------------------------------

let nextId = 3000;
const takeId = (): number => (nextId += 1);

const seedUserMessage = async (fields: {
    chatId?: number;
    replyToId?: number | null;
    userId: number;
    userName: string;
    text: string;
    quoteText?: string | null;
    forwardOrigin?: string | null;
}): Promise<number> => {
    const messageId = takeId();
    await db.Message.create({
        chatId: fields.chatId ?? GROUP,
        messageId,
        fromBotSelf: false,
        userId: fields.userId,
        date: new Date(Date.now() - 60_000 + messageId),
        userName: fields.userName,
        text: fields.text,
        quoteText: fields.quoteText ?? null,
        file: null,
        fileMime: null,
        fileUniqueId: null,
        replyToId: fields.replyToId ?? null,
        chatCommand: null,
        modelParts: null,
        mediaHint: null,
        forwardOrigin: fields.forwardOrigin ?? null,
        forwardFromId: null,
        viaBot: null,
        ocrText: 'OCR-SECRET',
    });
    return messageId;
};

const IMAGE_BASE64 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 7)]).toString('base64');

/** A finished bot reply: its own message row plus a bot_responses row with two versions */
const seedBotReply = async (chatId: number, userMessageId: number, text: string): Promise<number> => {
    const messageId = takeId();
    await db.Message.create({
        chatId,
        messageId,
        fromBotSelf: true,
        userId: BOT_USER_ID,
        date: new Date(Date.now() - 60_000 + messageId),
        userName: 'Bot',
        text,
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
    const versions = [
        {
            versionId: 1,
            createdAt: new Date(Date.now() - 50_000).toISOString(),
            messageIds: [messageId],
            currentMessageId: messageId,
            text: '',
            errorMessage: '429 Too Many Requests',
            wasStoppedByUser: false,
        },
        {
            versionId: 2,
            createdAt: new Date(Date.now() - 40_000).toISOString(),
            model: 'gemini-4-argon',
            messageIds: [messageId],
            currentMessageId: messageId,
            text,
            thinkingText: '想一想',
            wasStoppedByUser: false,
            imageBase64: IMAGE_BASE64,
            modelParts: [{ thoughtSignature: 'sig' }],
            agentStats: { toolUsage: [{ name: 'search_history', count: 2, failed: 1 }] },
            groundingData: [
                {
                    provider: 'mcp',
                    searchQueries: ['search_history: 吃什么', 'search_history: 吃什么'],
                    citations: [{ uri: 'https://example.com/a' }, { uri: 'https://example.com/a', title: 'A page' }],
                },
                {
                    provider: 'google',
                    searchQueries: ['今天 吃什么'],
                    groundingChunks: [{ web: { uri: 'https://example.com/g', title: 'G' } }],
                },
            ],
        },
    ];
    await BotResponse.create({
        messageId,
        chatId,
        userMessageId,
        currentVersionIndex: 1,
        versions: JSON.stringify(versions),
        buttonState: ButtonState.HAS_VERSIONS,
        metadata: JSON.stringify({ model: 'metadata-model', hasImage: true, commandType: 'chat' }),
    });
    return messageId;
};

await registry.upsertChatNow({ id: GROUP, type: 'supergroup', title: 'Group', username: 'group_name' });
await registry.upsertChatNow({ id: OTHER_GROUP, type: 'supergroup', title: 'Other' });
await upsertTelegramUser({ userId: ALICE.id, isBot: false, firstName: 'Alice', username: 'alice' });
await upsertTelegramUser({ userId: HELPER_BOT_ID, isBot: true, firstName: 'Helper', username: 'helper_bot' });
await loadChatSettingsCache();

// Root by Alice → bot reply → another bot's message → Alice again
const rootId = await seedUserMessage({ userId: ALICE.id, userName: 'Alice', text: 'ROOT-SECRET 今天吃什么', quoteText: 'QUOTE-SECRET', forwardOrigin: 'user Carol' });
const replyId = await seedBotReply(GROUP, rootId, 'BOT-TEXT 吃面');
const helperId = await seedUserMessage({ replyToId: replyId, userId: HELPER_BOT_ID, userName: 'Helper', text: 'HELPER-SECRET 我也要' });
const followUpId = await seedUserMessage({ replyToId: helperId, userId: ALICE.id, userName: 'Alice', text: 'FOLLOW-SECRET 那晚上呢' });

// The same first message id in another chat: never served through GROUP
const otherRootId = await seedUserMessage({ chatId: OTHER_GROUP, userId: ALICE.id, userName: 'Alice', text: 'other chat' });
const otherReplyId = await seedBotReply(OTHER_GROUP, otherRootId, 'other chat reply');

const TREE_PATH = `/api/chats/${GROUP}/conversations/${rootId}`;
const OBSERVER_USER_KEYS = ['date', 'edge', 'excluded', 'kind', 'messageId', 'number', 'parentId', 'redacted'];
const SECRETS = ['ROOT-SECRET', 'QUOTE-SECRET', 'HELPER-SECRET', 'FOLLOW-SECRET', 'OCR-SECRET', 'Carol', 'alice'];

const keysOf = (value: object): string[] => Object.keys(value).sort();

// ---- cases ----------------------------------------------------------------

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'observer tree: user nodes are exactly the eight-field placeholder, bot nodes complete',
        body: async () => {
            const response = await call(TREE_PATH, OWNER);
            const text = await response.clone().text();
            const tree = await jsonOf(response);
            expect(response.status === 200 && tree.access === 'observer', `the owner observes (got ${response.status} ${tree.access})`);
            const userNodes = tree.nodes.filter((node: any) => node.kind === 'user');
            expect(userNodes.length === 3, `three user nodes, the other bot's message among them (got ${userNodes.length})`);
            for (const node of userNodes) {
                expect(
                    JSON.stringify(keysOf(node)) === JSON.stringify(OBSERVER_USER_KEYS) && node.redacted === true,
                    `user node ${node.messageId} has exactly ${OBSERVER_USER_KEYS.join(', ')} (got ${keysOf(node).join(', ')})`
                );
            }
            const helper = userNodes.find((node: any) => node.messageId === helperId);
            expect(helper?.parentId === replyId && helper?.edge === 'reply' && helper?.number === 3, 'the placeholder keeps its tree position and number');
            for (const secret of SECRETS) {
                expect(!text.includes(secret), `the observer's tree never contains ${secret}`);
            }
            const bot = tree.nodes.find((node: any) => node.kind === 'bot');
            expect(
                bot?.reply?.text === 'BOT-TEXT 吃面' &&
                    bot.reply.thinkingText === '想一想' &&
                    bot.reply.model === 'gemini-4-argon' &&
                    bot.reply.versionCount === 2 &&
                    bot.reply.currentVersion === 2 &&
                    bot.reply.toolSummary[0]?.name === 'search_history' &&
                    bot.reply.toolSummary[0]?.failed === 1,
                `the bot node is complete for the observer (got ${JSON.stringify(bot)})`
            );
            expect(keysOf(bot).join(',') === 'date,edge,excluded,kind,messageId,number,parentId,reply', 'the bot node has the documented fields');
        },
    },
    {
        name: 'member tree: full user nodes with author, text, annotations and a jump link',
        body: async () => {
            const tree = await jsonOf(await call(TREE_PATH, ALICE));
            expect(tree.access === 'member', 'Alice is a member');
            const root = tree.nodes.find((node: any) => node.messageId === rootId);
            expect(
                root?.redacted === false &&
                    root.author?.userId === ALICE.id &&
                    root.author?.name === 'Alice' &&
                    root.author?.username === 'alice' &&
                    root.text === 'ROOT-SECRET 今天吃什么' &&
                    root.quote === 'QUOTE-SECRET' &&
                    root.ocrText === 'OCR-SECRET' &&
                    root.number === 1 &&
                    root.parentId === null &&
                    root.edge === null,
                `the member sees the root in full (got ${JSON.stringify(root)})`
            );
            expect(
                root.annotations.includes('[forwarded from user Carol]') &&
                    root.annotations.some((annotation: string) => annotation.startsWith('[quote: ')),
                `the root carries the model's annotations (got ${JSON.stringify(root.annotations)})`
            );
            expect(root.telegramLink === `https://t.me/c/1000000101/${rootId}`, `the supergroup link (got ${root.telegramLink})`);
            const helper = tree.nodes.find((node: any) => node.messageId === helperId);
            expect(
                helper?.annotations?.includes('[replying to your reply #2]'),
                `a reply to the bot reads as the model reads it (got ${JSON.stringify(helper?.annotations)})`
            );
            expect(
                keysOf(root).length === 18 && root.media === null && root.previewMedia.length === 0,
                `a member's user node has 18 fields and no media here (got ${keysOf(root).join(', ')})`
            );
        },
    },
    {
        name: 'conversation list: the observer sees a placeholder root, the member the author and excerpt',
        body: async () => {
            const observed = await jsonOf(await call(`/api/chats/${GROUP}/conversations`, OWNER));
            const item = observed.conversations.find((conversation: any) => conversation.rootId === rootId);
            expect(item !== undefined, `the conversation is listed (got ${JSON.stringify(observed)})`);
            expect(
                keysOf(item.root).join(',') === 'date,excluded,kind,messageId,redacted' && item.root.redacted === true,
                `the observer's root summary is a placeholder (got ${JSON.stringify(item.root)})`
            );
            expect(
                item.messageCount === 4 && item.replyCount === 1 && item.lastModel === 'gemini-4-argon' && item.hasError === true && item.generating === false,
                `counts, model and error flag (got ${JSON.stringify(item)})`
            );
            expect(!JSON.stringify(observed).includes('ROOT-SECRET'), 'no root text for the observer');

            const member = await jsonOf(await call(`/api/chats/${GROUP}/conversations`, ALICE));
            const memberItem = member.conversations.find((conversation: any) => conversation.rootId === rootId);
            expect(
                memberItem?.root?.author?.name === 'Alice' && memberItem.root.excerpt === 'ROOT-SECRET 今天吃什么',
                `the member's root summary (got ${JSON.stringify(memberItem?.root)})`
            );
        },
    },
    {
        name: 'reply details: every version, structured tools, no base64, no triggerUserId for observers',
        body: async () => {
            const observerResponse = await call(`/api/chats/${GROUP}/replies/${replyId}`, OWNER);
            const observerText = await observerResponse.clone().text();
            const observed = await jsonOf(observerResponse);
            expect(observerResponse.status === 200, `observer reads the reply (got ${observerResponse.status})`);
            expect(!('triggerUserId' in observed) && !observerText.includes('triggerUserId'), 'no triggerUserId for the observer');
            expect(!observerText.includes(IMAGE_BASE64.slice(0, 40)), 'no base64 in the response');
            expect(!observerText.includes('thoughtSignature'), 'no modelParts in the response');
            const [first, second] = observed.versions;
            expect(first.model === 'metadata-model' && second.model === 'gemini-4-argon', `per-version model with the metadata fallback (got ${first.model}, ${second.model})`);
            expect(first.errorMessage === '429 Too Many Requests', 'the first version keeps its error');
            expect(
                second.attachments.length === 1 &&
                    second.attachments[0].kind === 'image' &&
                    second.attachments[0].mimeType === 'image/png' &&
                    second.attachments[0].sizeBytes === 308,
                `attachments by kind and size only (got ${JSON.stringify(second.attachments)})`
            );
            expect(second.hasModelParts === true && second.metrics === null && first.metrics === null, 'modelParts as a flag, no metrics without a reply_metrics row');
            expect(
                JSON.stringify(second.tools.calls) === JSON.stringify(['search_history: 吃什么']) &&
                    second.tools.sources.length === 1 &&
                    second.tools.sources[0].title === 'A page' &&
                    second.tools.searches[0]?.queries[0] === '今天 吃什么' &&
                    second.tools.toolUsage[0]?.failed === 1,
                `tool records merged like the Telegram rendering (got ${JSON.stringify(second.tools)})`
            );
            expect(observed.rootId === rootId && observed.userMessageId === rootId, 'the reply knows its conversation');

            const member = await jsonOf(await call(`/api/chats/${GROUP}/replies/${replyId}`, ALICE));
            expect(member.triggerUserId === ALICE.id, `members get triggerUserId (got ${member.triggerUserId})`);

            const crossed = await call(`/api/chats/${GROUP}/replies/${otherReplyId}`, ALICE);
            expect(crossed.status === 404, `another chat's reply is a 404 here (got ${crossed.status})`);
        },
    },
    {
        name: 'reply details carry each version\'s reply_metrics row; observers get it without the trigger user',
        body: async () => {
            const startedAt = new Date(Date.now() - 60_000);
            await insertReplyMetric({
                chatId: GROUP,
                userMessageId: rootId,
                firstMessageId: replyId,
                versionId: 2,
                triggerUserId: ALICE.id,
                model: 'gemini-4-argon',
                platform: 'gemini',
                route: null,
                commandType: 'chat',
                isRetry: true,
                startedAt,
                requestStartedAt: new Date(startedAt.getTime() + 400),
                firstChunkAt: new Date(startedAt.getTime() + 2400),
                finishedAt: new Date(startedAt.getTime() + 9000),
                outcome: 'ok',
                errorKind: null,
                errorSummary: null,
                rounds: 2,
                toolCalls: 1,
                toolFailures: 0,
                toolUsage: [{ name: 'search_history', count: 1, failed: 0 }],
                promptTokens: 1200,
                cachedTokens: 800,
                cacheWriteTokens: null,
                outputTokens: 90,
                thoughtsTokens: 40,
                imageOutputTokens: null,
                contextMessages: 4,
                contextImages: 0,
                textChars: 12,
                thinkingChars: 0,
                hasImage: false,
                imageCount: 0,
                hasSticker: false,
                hasFile: false,
            });

            const observed = await jsonOf(await call(`/api/chats/${GROUP}/replies/${replyId}`, OWNER));
            const [observedFirst, observedSecond] = observed.versions;
            expect(observedFirst.metrics === null, 'a version without a row still has no metrics');
            expect(
                observedSecond.metrics?.versionId === 2 &&
                    observedSecond.metrics.firstChunkMs === 2000 &&
                    observedSecond.metrics.promptTokens === 1200 &&
                    observedSecond.metrics.rounds === 2,
                `the version's row is attached (got ${JSON.stringify(observedSecond.metrics)})`
            );
            expect(
                !('triggerUserId' in observedSecond.metrics) && !JSON.stringify(observed).includes(String(ALICE.id)),
                'the observer gets no trigger user id anywhere'
            );

            const member = await jsonOf(await call(`/api/chats/${GROUP}/replies/${replyId}`, ALICE));
            expect(
                member.versions[1].metrics?.triggerUserId === ALICE.id,
                `members see who triggered the attempt (got ${JSON.stringify(member.versions[1].metrics)})`
            );
        },
    },
    {
        name: 'member-only operations answer 403 to the observer; strangers get nothing',
        body: async () => {
            const operations: Array<[string, string, unknown]> = [
                ['GET', `${TREE_PATH}/model-view`, undefined],
                ['GET', `${TREE_PATH}/export?format=json`, undefined],
                ['POST', `${TREE_PATH}/links`, { links: [`https://t.me/c/1000000101/${followUpId}`] }],
                ['PUT', `/api/chats/${GROUP}/messages/${followUpId}/exclusion`, undefined],
                ['DELETE', `/api/chats/${GROUP}/messages/${followUpId}/exclusion`, undefined],
            ];
            for (const [method, path, body] of operations) {
                const response = await call(path, OWNER, method, body);
                const code = (await jsonOf(response))?.error?.code;
                expect(response.status === 403 && code === 'forbidden', `${method} ${path.replace(/\d{4,}/g, ':id')} → 403 forbidden (got ${response.status} ${code})`);
            }
            for (const path of [TREE_PATH, `/api/chats/${GROUP}/conversations`, `/api/chats/${GROUP}/replies/${replyId}`]) {
                const response = await call(path, STRANGER);
                expect(response.status === 403, `a stranger is refused ${path.replace(/\d{4,}/g, ':id')} (got ${response.status})`);
            }
        },
    },
    {
        name: 'export: members download md and json, with versions and the model view, never base64',
        body: async () => {
            for (const format of ['md', 'json'] as const) {
                const response = await call(`${TREE_PATH}/export?format=${format}`, ALICE);
                const text = await response.text();
                expect(response.status === 200, `${format}: 200 (got ${response.status} ${text.slice(0, 160)})`);
                expect(
                    response.headers.get('Content-Disposition') === `attachment; filename="conversation_${GROUP}_${rootId}.${format}"`,
                    `${format}: an attachment (got ${response.headers.get('Content-Disposition')})`
                );
                expect(
                    text.includes('ROOT-SECRET') && text.includes('BOT-TEXT') && text.includes('429 Too Many Requests') && text.includes('想一想'),
                    `${format}: the member tree and every version with errors and thinking`
                );
                expect(!text.includes(IMAGE_BASE64.slice(0, 40)) && !text.includes('thoughtSignature'), `${format}: no base64, no modelParts`);
            }
            const exported = JSON.parse(await (await call(`${TREE_PATH}/export?format=json`, ALICE)).text());
            expect(
                exported.modelView?.at === rootId &&
                    exported.modelView.excludedReplyId === replyId &&
                    typeof exported.modelView.systemPrompt === 'string' &&
                    typeof exported.modelView.computedAt === 'string' &&
                    exported.replies.length === 1 &&
                    exported.replies[0].versions.length === 2,
                `the json holds the model view and all versions (got ${JSON.stringify(exported).slice(0, 300)})`
            );
            const markdown = await (await call(`${TREE_PATH}/export?format=md`, ALICE)).text();
            expect(markdown.includes('等同于现在点重试，重算于'), 'the md states that the model view is recomputed');
            expect((await call(`${TREE_PATH}/export?format=pdf`, ALICE)).status === 400, 'an unknown format is a 400');
        },
    },
    {
        name: 'a conversation id that is not a root is a 404',
        body: async () => {
            const notRoot = await call(`/api/chats/${GROUP}/conversations/${followUpId}`, ALICE);
            expect(notRoot.status === 404, `a reply's id is not a conversation (got ${notRoot.status})`);
            const missing = await call(`/api/chats/${GROUP}/conversations/999999`, ALICE);
            expect(missing.status === 404, `an unknown id is a 404 (got ${missing.status})`);
            const malformed = await call(`/api/chats/${GROUP}/conversations/abc`, ALICE);
            expect(malformed.status === 400, `a malformed id is a 400 (got ${malformed.status})`);
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
reportResults(results);
