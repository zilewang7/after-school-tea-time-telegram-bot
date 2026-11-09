/**
 * Offline cases for the share service (design §5.6): system shares of the
 * group fallback, user shares, the reuse rule, version pinning, revocation
 * permissions and the preview-card degraded path.
 *
 * The render sidecar is deliberately off (WIDGET_RENDER_URL=''), so these
 * cases assert the failure paths too: a share without a preview card is still
 * a working link.
 *
 * Run: npx tsx scripts/offline/share-links.mts
 */
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';

process.env.WEBAPP_PUBLIC_URL = 'https://miniapp.test';
process.env.BOT_USER_NAME = 'k_on_test_bot';
process.env.WIDGET_RENDER_URL = '';
process.env.SHARE_ENABLED = '1';
process.env.OWNER_USER_ID = '4242';
process.env.BOT_USER_ID = '9999';
delete process.env.ALLOWED_CHAT_IDS;

await setupOfflineDb();
const db = await import('../../src/db/index.js');
const service = await import('../../src/panel/share/share-link-service.js');
const store = await import('../../src/panel/share/share-store.js');
const content = await import('../../src/panel/share/share-content.js');

const CHAT_ID = -1001000000001;
const OTHER_CHAT_ID = -1001000000002;
const BOT_USER_ID = 9999;
const CREATOR = { userId: 5001, isOwner: false };
const OTHER_MEMBER = { userId: 5002, isOwner: false };
const OWNER = { userId: 4242, isOwner: true };

type ResponseVersion = import('../../src/db/index.js').ResponseVersion;

const versionOf = (versionId: number, overrides: Partial<ResponseVersion> = {}): ResponseVersion => ({
    versionId,
    createdAt: `2026-11-09T12:0${versionId}:00.000Z`,
    messageIds: [700 + versionId],
    currentMessageId: 700 + versionId,
    text: `第 ${versionId} 版正文`,
    wasStoppedByUser: false,
    ...overrides,
});

const makeReply = async (
    chatId: number,
    messageId: number,
    versions: ResponseVersion[],
    userMessageId = 400
): Promise<import('../../src/db/index.js').BotResponse> => {
    const response = await db.createBotResponse(chatId, messageId, userMessageId, {
        model: 'offline-model',
        hasImage: false,
    });
    response.setVersions(versions);
    response.currentVersionIndex = 0;
    await response.save();
    return response;
};

const saveUserMessage = async (
    chatId: number,
    messageId: number,
    userId: number,
    text: string,
    replyToId?: number
): Promise<void> => {
    await db.saveMessage({
        chatId,
        messageId,
        userId,
        date: new Date('2026-11-09T12:00:00.000Z'),
        userName: userId === BOT_USER_ID ? 'k-on-bot' : 'Alice',
        message: text,
        ...(replyToId === undefined ? {} : { replyToId }),
    });
};

let nextMessageId = 2000;
const takeMessageId = (): number => (nextMessageId += 1);

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'a system share is created once and reused',
        body: async () => {
            const messageId = takeMessageId();
            await makeReply(CHAT_ID, messageId, [versionOf(1)]);
            const first = await service.ensureSystemReplyShare({ chatId: CHAT_ID, firstMessageId: messageId, versionId: 1 });
            expect(first !== null, 'created');
            if (first === null) return;
            expect(first.createdBy === 0 && first.source === 'system', 'createdBy 0 / source system');
            expect(first.kind === 'reply' && first.chatId === CHAT_ID && first.firstMessageId === messageId, 'target');
            expect(first.versionId === 1, 'pinned version');
            expect(/^[A-Za-z0-9_-]{24}$/.test(first.token), '24-char base64url token');
            expect(first.url === `https://miniapp.test/s/${first.token}`, `absolute url (got ${first.url})`);
            expect(first.previewWidth === null && first.previewHeight === null, 'no preview card without a renderer');

            const second = await service.ensureSystemReplyShare({ chatId: CHAT_ID, firstMessageId: messageId, versionId: 1 });
            expect(second?.token === first.token, 'the same target reuses the token');
            expect(await service.findActiveShare(first.token) !== null, 'the link is active');
        },
    },
    {
        name: 'a system share accepts the version finalize is about to write',
        body: async () => {
            const messageId = takeMessageId();
            await makeReply(CHAT_ID, messageId, [versionOf(1)]);
            const pending = await service.ensureSystemReplyShare({
                chatId: CHAT_ID,
                firstMessageId: messageId,
                versionId: 2,
                preview: { widgetHtml: '<div>pending</div>', widgetImageBase64: Buffer.from('fake-png').toString('base64'), chatTitle: '主群' },
            });
            expect(pending !== null && pending.versionId === 2, 'the pending version is accepted');
            const unknown = await service.ensureSystemReplyShare({ chatId: CHAT_ID, firstMessageId: messageId, versionId: 7 });
            expect(unknown === null, 'a version that is neither stored nor pending is refused');
            const missingReply = await service.ensureSystemReplyShare({ chatId: CHAT_ID, firstMessageId: 999999, versionId: 1 });
            expect(missingReply === null, 'an unknown reply is refused');
        },
    },
    {
        name: 'a user share reuses an existing active link and only its creator revokes it',
        body: async () => {
            const messageId = takeMessageId();
            await makeReply(CHAT_ID, messageId, [versionOf(1)]);
            const created = await service.createUserShare({
                kind: 'reply',
                chatId: CHAT_ID,
                firstMessageId: messageId,
                createdBy: CREATOR.userId,
            });
            expect(created.ok, 'created');
            if (!created.ok) return;
            expect(created.share.source === 'user' && created.share.createdBy === CREATOR.userId, 'source user / creator');
            expect(created.share.versionId === 1, 'the current version is pinned by default');

            const again = await service.createUserShare({
                kind: 'reply',
                chatId: CHAT_ID,
                firstMessageId: messageId,
                createdBy: OTHER_MEMBER.userId,
            });
            expect(again.ok && again.share.token === created.share.token, 'another member gets the same URL');

            const byOther = await service.revokeShare(created.share.token, OTHER_MEMBER);
            expect(byOther === 'forbidden', 'a member who did not create it cannot revoke');
            const byCreator = await service.revokeShare(created.share.token, CREATOR);
            expect(byCreator === 'revoked', 'the creator revokes');
            expect(await service.findActiveShare(created.share.token) === null, 'a revoked link is not active');
            const unknown = await service.revokeShare('A'.repeat(24), CREATOR);
            expect(unknown === 'not_found', 'an unknown token is not found');
            const badToken = await service.revokeShare('short', CREATOR);
            expect(badToken === 'not_found', 'a malformed token is not found');
        },
    },
    {
        name: 'only the owner revokes a system share',
        body: async () => {
            const messageId = takeMessageId();
            await makeReply(CHAT_ID, messageId, [versionOf(1)]);
            const share = await service.ensureSystemReplyShare({ chatId: CHAT_ID, firstMessageId: messageId, versionId: 1 });
            expect(share !== null, 'created');
            if (share === null) return;
            expect(await service.revokeShare(share.token, OTHER_MEMBER) === 'forbidden', 'a member cannot revoke it');
            expect(await service.revokeShare(share.token, OWNER) === 'revoked', 'the owner revokes it');
        },
    },
    {
        name: 'a reply share pins its version',
        body: async () => {
            const messageId = takeMessageId();
            await makeReply(CHAT_ID, messageId, [versionOf(1), versionOf(2, { text: '第二版正文' })]);
            const first = await service.createUserShare({
                kind: 'reply',
                chatId: CHAT_ID,
                firstMessageId: messageId,
                versionId: 1,
                createdBy: CREATOR.userId,
            });
            const second = await service.createUserShare({
                kind: 'reply',
                chatId: CHAT_ID,
                firstMessageId: messageId,
                versionId: 2,
                createdBy: CREATOR.userId,
            });
            expect(first.ok && second.ok, 'both versions shared');
            if (!first.ok || !second.ok) return;
            expect(first.share.token !== second.share.token, 'different versions get different links');
            const firstContent = await content.loadReplyShareContent(CHAT_ID, messageId, first.share.versionId);
            expect(firstContent?.text === '第 1 版正文', 'the page shows the pinned version');
            const badVersion = await service.createUserShare({
                kind: 'reply',
                chatId: CHAT_ID,
                firstMessageId: messageId,
                versionId: 9,
                createdBy: CREATOR.userId,
            });
            expect(!badVersion.ok && badVersion.reason === 'version_not_found', 'an unknown version is refused');
        },
    },
    {
        name: 'a share cannot be created for an unknown reply or another chat',
        body: async () => {
            const messageId = takeMessageId();
            await makeReply(CHAT_ID, messageId, [versionOf(1)]);
            const missing = await service.createUserShare({
                kind: 'reply',
                chatId: CHAT_ID,
                firstMessageId: 987654,
                createdBy: CREATOR.userId,
            });
            expect(!missing.ok && missing.reason === 'reply_not_found', 'unknown reply');
            const otherChat = await service.createUserShare({
                kind: 'reply',
                chatId: OTHER_CHAT_ID,
                firstMessageId: messageId,
                createdBy: CREATOR.userId,
            });
            expect(!otherChat.ok && otherChat.reason === 'reply_not_found', 'a reply of another chat is not shared');
            const noTarget = await service.createUserShare({ kind: 'reply', chatId: CHAT_ID, createdBy: CREATOR.userId });
            expect(!noTarget.ok && noTarget.reason === 'invalid_target', 'missing firstMessageId');
        },
    },
    {
        name: 'a conversation share needs a stored conversation root',
        body: async () => {
            const rootId = takeMessageId();
            await saveUserMessage(CHAT_ID, rootId, 5001, '开始聊天');
            const created = await service.createUserShare({
                kind: 'conversation',
                chatId: CHAT_ID,
                rootId,
                createdBy: CREATOR.userId,
            });
            expect(created.ok, 'created');
            if (!created.ok) return;
            expect(created.share.kind === 'conversation' && created.share.rootId === rootId, 'target');
            expect(created.share.firstMessageId === null && created.share.versionId === null, 'no reply fields');
            const loaded = await content.loadConversationShareContent(CHAT_ID, rootId);
            expect(loaded?.bubbles.length === 1, 'the page renders the root message');
            const missing = await service.createUserShare({
                kind: 'conversation',
                chatId: CHAT_ID,
                rootId: 989898,
                createdBy: CREATOR.userId,
            });
            expect(!missing.ok && missing.reason === 'conversation_not_found', 'an unknown root is refused');
        },
    },
    {
        name: 'a reply and a conversation are different share targets',
        body: async () => {
            const messageId = takeMessageId();
            await makeReply(CHAT_ID, messageId, [versionOf(1)]);
            await saveUserMessage(CHAT_ID, messageId, 5001, '触发回复');
            const replyShare = await service.createUserShare({
                kind: 'reply',
                chatId: CHAT_ID,
                firstMessageId: messageId,
                createdBy: CREATOR.userId,
            });
            const conversationShare = await service.createUserShare({
                kind: 'conversation',
                chatId: CHAT_ID,
                rootId: messageId,
                createdBy: CREATOR.userId,
            });
            expect(replyShare.ok && conversationShare.ok, 'both created');
            if (!replyShare.ok || !conversationShare.ok) return;
            expect(replyShare.share.token !== conversationShare.share.token, 'different tokens');
            const status = await service.findShareStatus(
                { kind: 'reply', chatId: CHAT_ID, firstMessageId: messageId },
                CREATOR
            );
            expect(status?.token === replyShare.share.token, 'the status finds the reply share');
        },
    },
    {
        name: 'tokens are unique across many shares',
        body: async () => {
            const tokens = new Set<string>();
            for (let index = 0; index < 8; index += 1) {
                const messageId = takeMessageId();
                await makeReply(CHAT_ID, messageId, [versionOf(1)]);
                const created = await service.createUserShare({
                    kind: 'reply',
                    chatId: CHAT_ID,
                    firstMessageId: messageId,
                    createdBy: CREATOR.userId,
                });
                expect(created.ok, `share ${index} created`);
                if (created.ok) tokens.add(created.share.token);
            }
            expect(tokens.size === 8, 'eight distinct tokens');
            const row = await store.findShareRowByToken([...tokens][0] ?? '');
            expect(row !== null && row.revokedAt === null, 'stored row readable by token');
        },
    },
    {
        name: 'the content loader exposes what the preview card needs',
        body: async () => {
            const messageId = takeMessageId();
            const widgetImage = Buffer.from('widget-png-bytes').toString('base64');
            await makeReply(CHAT_ID, messageId, [
                versionOf(1, {
                    text: '这是一张卡片',
                    widget: {
                        mode: 'a2ui',
                        html: '<div class="card">hi</div>',
                        htmlBytes: 28,
                        zlibBytes: 40,
                        imageBase64: widgetImage,
                        caption: '卡片说明',
                    },
                }),
            ]);
            const loaded = await content.loadReplyShareContent(CHAT_ID, messageId, null);
            expect(loaded !== null, 'loaded');
            if (loaded === null) return;
            expect(loaded.widget?.html === '<div class="card">hi</div>', 'widget html');
            expect(loaded.preview.widgetHtml === '<div class="card">hi</div>', 'preview snapshot has the widget html');
            expect(loaded.preview.widgetImageBase64 === widgetImage, 'preview snapshot has the 600px render');
            expect(loaded.preview.caption === '卡片说明', 'preview caption');
            expect(loaded.preview.chatTitle === null, 'no chat row → no title');
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) results.push(await runCase(testCase.name, testCase.body));
reportResults(results);
