/**
 * Offline cases for a Telegram album (media group) on the display surfaces:
 * the panel conversation tree, the public share JSON and the SSR share page.
 *
 * Telegram stores the first item of an album as an ordinary message and every
 * later item as a `sub image of [<first>]` reply. The model context folds those
 * rows into the parent's media, and the reply tree leaves them out on purpose,
 * so display surfaces read them separately and must show them all inside the
 * parent's bubble, own media first and the rest ascending by message id. A
 * reply share keeps its single attachment object.
 *
 * Run: npx tsx scripts/offline/album-media.mts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrammyError } from 'grammy';
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';
import type { InitDataUserInput } from '../lib/init-data.mts';

const BOT_TOKEN = '123456789:AAFakeOfflineTokenForAlbumMediaTests_01';
const OWNER_ID = 4242;
const ALICE: InitDataUserInput = { id: 5001, first_name: 'Alice' };
const OWNER: InitDataUserInput = { id: OWNER_ID, first_name: 'Owner' };
const GROUP = -1001000000001;
const BOT_USER_ID = 9999;

process.env.OWNER_USER_ID = String(OWNER_ID);
process.env.WEBAPP_PUBLIC_URL = 'https://miniapp.test';
process.env.BOT_USER_NAME = 'k_on_test_bot';
process.env.BOT_USER_ID = String(BOT_USER_ID);
process.env.WIDGET_RENDER_URL = '';
delete process.env.ALLOWED_CHAT_IDS;

await setupOfflineDb();
const registry = await import('../../src/db/queries/panel-registry.js');
const db = await import('../../src/db/index.js');
const service = await import('../../src/panel/share/share-link-service.js');
const { putCachedMedia } = await import('../../src/services/media-cache-service.js');
const { createPanelApp } = await import('../../src/panel/app.js');
const { signInitData } = await import('../lib/init-data.mts');

type MembershipLookup = import('../../src/panel/access/membership.js').MembershipLookup;
type PanelApp = ReturnType<typeof createPanelApp>;
type ResponseVersion = import('../../src/db/index.js').ResponseVersion;
type ShareLinkRecord = import('../../src/panel/share/share-types.js').ShareLinkRecord;

const scratch = mkdtempSync(join(tmpdir(), 'k-on-bot-album-media-'));
process.once('exit', () => rmSync(scratch, { recursive: true, force: true }));
const STATIC_ROOT = join(scratch, 'dist');
mkdirSync(join(STATIC_ROOT, 'assets'), { recursive: true });
writeFileSync(join(STATIC_ROOT, 'index.html'), '<!doctype html><title>panel</title>');

const grammyError = (code: number, description: string): GrammyError =>
    new GrammyError(`(${code}: ${description})`, { ok: false, error_code: code, description }, 'getChatMember', {});

const fakeLookup: MembershipLookup = async (chatId, userId) => {
    if (chatId === GROUP && userId === ALICE.id) return { status: 'member' };
    throw grammyError(400, 'Bad Request: user not found');
};

const makeApp = (): PanelApp =>
    createPanelApp({
        botToken: BOT_TOKEN,
        membershipLookup: fakeLookup,
        staticRoot: STATIC_ROOT,
        startedAt: new Date('2026-11-13T00:00:00.000Z'),
        version: 'abc1234',
        now: () => Date.now(),
        shareEnabled: true,
    });

const app = makeApp();

const PNG_1PX =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_1PX, 'base64');

/** Distinct cache bytes per album item: a route serving the wrong row cannot pass */
const photoBytes = (label: string): Buffer => Buffer.concat([PNG_BYTES, Buffer.from(`-${label}`)]);

const call = (path: string, user: InitDataUserInput): Promise<Response> =>
    Promise.resolve(
        app.request(path, {
            headers: {
                'X-Init-Data': signInitData({ botToken: BOT_TOKEN, user, authDate: Math.floor(Date.now() / 1000) }),
            },
        })
    );

const jsonOf = async (response: Response): Promise<any> => JSON.parse(await response.text());

const bytesOf = async (response: Response): Promise<Buffer> => Buffer.from(await response.arrayBuffer());

const findNode = (tree: any, messageId: number): any =>
    Array.isArray(tree.nodes) ? tree.nodes.find((node: any) => node.messageId === messageId) : undefined;

const versionOf = (versionId: number, overrides: Partial<ResponseVersion> = {}): ResponseVersion => ({
    versionId,
    createdAt: '2026-11-13T12:00:00.000Z',
    messageIds: [900 + versionId],
    currentMessageId: 900 + versionId,
    text: `第 ${versionId} 版`,
    wasStoppedByUser: false,
    ...overrides,
});

let nextMessageId = 7000;
const takeMessageId = (): number => (nextMessageId += 1);

const saveMessage = async (
    messageId: number,
    userId: number,
    text: string,
    options: {
        replyToId?: number;
        fileUniqueId?: string;
        fileMime?: string;
        mediaHint?: string;
    } = {}
): Promise<void> => {
    await db.saveMessage({
        chatId: GROUP,
        messageId,
        userId,
        date: new Date('2026-11-13T12:00:00.000Z'),
        userName: userId === BOT_USER_ID ? 'k-on-bot' : 'Alice',
        message: text,
        ...(options.replyToId === undefined ? {} : { replyToId: options.replyToId }),
        ...(options.fileUniqueId === undefined ? {} : { fileUniqueId: options.fileUniqueId }),
        ...(options.fileMime === undefined ? {} : { fileMime: options.fileMime }),
        ...(options.mediaHint === undefined ? {} : { mediaHint: options.mediaHint }),
    });
};

const makeReply = async (messageId: number, userMessageId: number, versions: ResponseVersion[]): Promise<void> => {
    const response = await db.createBotResponse(GROUP, messageId, userMessageId, {
        model: 'offline-model',
        hasImage: false,
    });
    response.setVersions(versions);
    response.currentVersionIndex = 0;
    await response.save();
};

const cachePhoto = (fileUniqueId: string, bytes: Buffer): Promise<void> =>
    putCachedMedia({ fileUniqueId, mime: 'image/jpeg', kind: 'photo', data: bytes, sizeBytes: bytes.length });

const createConversationShare = async (rootId: number): Promise<ShareLinkRecord> => {
    const created = await service.createUserShare({
        kind: 'conversation',
        chatId: GROUP,
        rootId,
        createdBy: ALICE.id,
    });
    if (!created.ok) throw new Error(`could not create the conversation share: ${created.reason}`);
    return created.share;
};

const createReplyShare = async (firstMessageId: number): Promise<ShareLinkRecord> => {
    const created = await service.createUserShare({
        kind: 'reply',
        chatId: GROUP,
        firstMessageId,
        createdBy: ALICE.id,
    });
    if (!created.ok) throw new Error(`could not create the reply share: ${created.reason}`);
    return created.share;
};

/** One photo of an album: its stored row plus the cache bytes the page loads */
interface SeededPhoto {
    messageId: number;
    fileUniqueId: string;
    bytes: Buffer;
    /** false: the row exists, but the 7-day retention already cleared its cache */
    cached: boolean;
}

interface SeededAlbum {
    parentId: number;
    parent: SeededPhoto;
    children: SeededPhoto[];
}

/**
 * Seed one Telegram album: the first photo is an ordinary message, every later
 * photo a `sub image of [<parent>]` reply. The children are inserted newest
 * first, so the display order has to come from the message ids. `missingTail`
 * children keep their row (and media hint) but lose their cached bytes, like a
 * media item whose retention ran out.
 */
const seedAlbum = async (
    prefix: string,
    childCount: number,
    options: { missingTail?: number } = {}
): Promise<SeededAlbum> => {
    const parentId = takeMessageId();
    const firstMissingIndex = childCount - (options.missingTail ?? 0);
    const parent: SeededPhoto = {
        messageId: parentId,
        fileUniqueId: `${prefix}-parent`,
        bytes: photoBytes(`${prefix}-parent`),
        cached: true,
    };
    const children: SeededPhoto[] = Array.from({ length: childCount }, (_unused, index) => ({
        messageId: takeMessageId(),
        fileUniqueId: `${prefix}-child-${index + 1}`,
        bytes: photoBytes(`${prefix}-child-${index + 1}`),
        cached: index < firstMissingIndex,
    }));

    await saveMessage(parentId, ALICE.id, `${prefix} 的相册`, {
        fileUniqueId: parent.fileUniqueId,
        fileMime: 'image/jpeg',
        mediaHint: 'some pictures',
    });
    if (parent.cached) await cachePhoto(parent.fileUniqueId, parent.bytes);
    for (const child of [...children].reverse()) {
        await saveMessage(child.messageId, ALICE.id, `sub image of [${parentId}]`, {
            replyToId: parentId,
            fileUniqueId: child.fileUniqueId,
            fileMime: 'image/jpeg',
            mediaHint: 'some pictures',
        });
        if (child.cached) await cachePhoto(child.fileUniqueId, child.bytes);
    }
    return { parentId, parent, children };
};

await registry.upsertChatNow({ id: GROUP, type: 'supergroup', title: 'Group' });

// ---- fixtures -------------------------------------------------------------

/** Case 1/3: three items, all cached; children inserted newest first */
const threeItemAlbum = await seedAlbum('three-item', 2);

/** A message outside every share below: its media route must stay 404 */
const outsideMessageId = takeMessageId();
await saveMessage(outsideMessageId, ALICE.id, '这段对话之外的消息');

/** Cases 4-7: one album (one cached item, one cleared) plus a bot reply with and without a picture */
const shareAlbum = await seedAlbum('shared', 2, { missingTail: 1 });
const shareParentId = shareAlbum.parentId;
const shareChild = shareAlbum.children[0];
const missingChild = shareAlbum.children[1];
if (shareChild === undefined || missingChild === undefined) throw new Error('the album fixture lost its children');

const botImageId = takeMessageId();
await saveMessage(botImageId, BOT_USER_ID, '', { replyToId: shareParentId });
await makeReply(botImageId, shareParentId, [versionOf(1, { text: '这张图', imageBase64: PNG_1PX })]);

const botTextId = takeMessageId();
await saveMessage(botTextId, BOT_USER_ID, '', { replyToId: shareParentId });
await makeReply(botTextId, shareParentId, [versionOf(1, { text: '只有文字' })]);

const conversationShare = await createConversationShare(shareParentId);

// ---- cases ----------------------------------------------------------------

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'a member tree lists every item of a Telegram album in message-id order',
        body: async () => {
            const tree = await jsonOf(await call(`/api/chats/${GROUP}/conversations/${threeItemAlbum.parentId}`, ALICE));
            const node = findNode(tree, threeItemAlbum.parentId);
            expect(node !== undefined, 'the album parent is a node of the tree');
            const media = Array.isArray(node.media) ? node.media : [];
            expect(
                media.length === 3,
                `the bubble carries all three photos (got ${JSON.stringify(node.media)})`
            );
            expect(
                media.every((item: any) => item.kind === 'image' && item.mimeType === 'image/jpeg'),
                `every item is a photo (got ${JSON.stringify(media.map((item: any) => item.kind))})`
            );
            const urls = media.map((item: any) => item.url);
            expect(
                urls.every((url: unknown) => typeof url === 'string' && url.startsWith('/m/')),
                `every item has its own signed /m/ URL (got ${JSON.stringify(urls)})`
            );
            expect(new Set(urls).size === 3, 'the three items have three distinct URLs');

            const served: Buffer[] = [];
            for (const url of urls) {
                const response = await app.request(url);
                expect(response.status === 200, `the signed URL answers 200 (got ${response.status})`);
                expect(response.headers.get('Content-Type') === 'image/jpeg', 'the stored MIME type');
                served.push(await bytesOf(response));
            }
            expect(
                served[0]?.equals(threeItemAlbum.parent.bytes) === true,
                "the first item is the message's own photo"
            );
            expect(
                served[1]?.equals(threeItemAlbum.children[0]?.bytes ?? Buffer.alloc(0)) === true,
                'the second item is the lowest child message id'
            );
            expect(
                served[2]?.equals(threeItemAlbum.children[1]?.bytes ?? Buffer.alloc(0)) === true,
                'the third item is the highest child message id'
            );
            expect(node.mediaHint === 'some pictures', "the bubble keeps the parent's own media hint");
        },
    },
    {
        name: 'a plain photo is one attachment, a text message and a cleared photo are an empty list',
        body: async () => {
            const singleId = takeMessageId();
            await cachePhoto('single-photo', photoBytes('single-photo'));
            await saveMessage(singleId, ALICE.id, '单张照片', {
                fileUniqueId: 'single-photo',
                fileMime: 'image/jpeg',
                mediaHint: 'a picture',
            });
            const singleTree = await jsonOf(await call(`/api/chats/${GROUP}/conversations/${singleId}`, ALICE));
            const singleNode = findNode(singleTree, singleId);
            expect(
                Array.isArray(singleNode.media) && singleNode.media.length === 1 && singleNode.media[0]?.kind === 'image',
                `a message without an album owns exactly one attachment (got ${JSON.stringify(singleNode?.media)})`
            );

            const plainId = takeMessageId();
            await saveMessage(plainId, ALICE.id, '只有文字');
            const plainTree = await jsonOf(await call(`/api/chats/${GROUP}/conversations/${plainId}`, ALICE));
            const plainNode = findNode(plainTree, plainId);
            expect(
                Array.isArray(plainNode.media) && plainNode.media.length === 0,
                `a text message has an empty attachment list, not null (got ${JSON.stringify(plainNode?.media)})`
            );

            const clearedId = takeMessageId();
            await saveMessage(clearedId, ALICE.id, '图已经过期', {
                fileUniqueId: 'cleared-photo-never-cached',
                fileMime: 'image/jpeg',
                mediaHint: 'a picture',
            });
            const clearedTree = await jsonOf(await call(`/api/chats/${GROUP}/conversations/${clearedId}`, ALICE));
            expect(
                Array.isArray(findNode(clearedTree, clearedId).media) &&
                    findNode(clearedTree, clearedId).media.length === 0,
                'a photo whose cache expired leaves an empty list'
            );
        },
    },
    {
        name: 'an observer user node still has no media field at all',
        body: async () => {
            const observed = await jsonOf(
                await call(`/api/chats/${GROUP}/conversations/${threeItemAlbum.parentId}`, OWNER)
            );
            const observedNode = findNode(observed, threeItemAlbum.parentId);
            expect(observedNode?.redacted === true, 'the observer sees the redacted user node');
            expect(
                observedNode !== undefined && !Object.hasOwn(observedNode, 'media'),
                `the observer node has no media field (got ${JSON.stringify(observedNode)})`
            );
            expect(!JSON.stringify(observed).includes('/m/'), 'no signed media URL reaches an observer');
        },
    },
    {
        name: 'the public share JSON names the message of every album item',
        body: async () => {
            const body = await jsonOf(await app.request(`/api/public/shares/${conversationShare.token}`));
            const shareView = body.share;
            expect(shareView?.kind === 'conversation', 'a conversation share');
            expect(shareView.reply === undefined, 'no reply key on a conversation share');
            const bubbles: any[] = Array.isArray(shareView.conversation?.bubbles)
                ? shareView.conversation.bubbles
                : [];

            const userBubble = bubbles.find((bubble: any) => bubble.messageId === shareParentId);
            expect(userBubble !== undefined, 'the album parent is a bubble');
            const userMedia = Array.isArray(userBubble.media) ? userBubble.media : [];
            expect(
                userMedia.length === 2,
                `the bubble lists its cached items — own photo then the cached child (got ${JSON.stringify(userBubble.media)})`
            );
            expect(
                userMedia[0]?.messageId === shareParentId && userMedia[1]?.messageId === shareChild.messageId,
                `the items name their own message ids (got ${JSON.stringify(userMedia.map((item: any) => item.messageId))})`
            );
            expect(
                userMedia.every((item: any) => item.kind === 'image' && item.mimeType === 'image/jpeg'),
                'every item is a photo'
            );

            const botImageBubble = bubbles.find((bubble: any) => bubble.messageId === botImageId);
            expect(botImageBubble !== undefined, 'the bot picture is a bubble');
            expect(
                Array.isArray(botImageBubble.media) &&
                    botImageBubble.media.length === 1 &&
                    botImageBubble.media[0]?.messageId === botImageId &&
                    botImageBubble.media[0]?.kind === 'image' &&
                    botImageBubble.media[0]?.mimeType === 'image/png',
                `a bot bubble carries its version's picture (got ${JSON.stringify(botImageBubble.media)})`
            );

            const botTextBubble = bubbles.find((bubble: any) => bubble.messageId === botTextId);
            expect(botTextBubble !== undefined, 'the text reply is a bubble');
            expect(
                Array.isArray(botTextBubble.media) && botTextBubble.media.length === 0,
                `a bot bubble without media carries an empty list (got ${JSON.stringify(botTextBubble.media)})`
            );
        },
    },
    {
        name: 'the share page renders every album item and each media route serves its own bytes',
        body: async () => {
            const page = await (await app.request(`/s/${conversationShare.token}`)).text();
            const imgPrefix = `<img src="/s/${conversationShare.token}/media/`;
            expect(page.includes(`${imgPrefix}${shareParentId}/image"`), 'the page shows the parent photo');
            expect(
                page.includes(`${imgPrefix}${shareChild.messageId}/image"`),
                'the page shows the media-group child photo'
            );
            expect(
                !page.includes(`${imgPrefix}${missingChild.messageId}/image"`),
                'a cleared item renders no figure'
            );
            expect(!page.includes(`${imgPrefix}${botTextId}/image"`), 'a bot bubble without media renders no figure');
            const imageCount = page.split(imgPrefix).length - 1;
            expect(imageCount === 3, `two album items and one bot picture (got ${imageCount} images)`);

            const parentImage = await app.request(`/s/${conversationShare.token}/media/${shareParentId}/image`);
            expect(parentImage.status === 200, `the parent photo route answers 200 (got ${parentImage.status})`);
            expect(parentImage.headers.get('Content-Type') === 'image/jpeg', 'the parent photo MIME type');
            expect(
                (await bytesOf(parentImage)).equals(shareAlbum.parent.bytes),
                'the parent photo route serves the parent bytes'
            );

            const childImage = await app.request(
                `/s/${conversationShare.token}/media/${shareChild.messageId}/image`
            );
            expect(childImage.status === 200, `the child photo route answers 200 (got ${childImage.status})`);
            expect(childImage.headers.get('Content-Type') === 'image/jpeg', 'the child photo MIME type');
            expect(
                (await bytesOf(childImage)).equals(shareChild.bytes),
                'the child photo route serves the child bytes'
            );

            const botImage = await app.request(`/s/${conversationShare.token}/media/${botImageId}/image`);
            expect(botImage.status === 200, `the bot picture route answers 200 (got ${botImage.status})`);
            expect((await bytesOf(botImage)).equals(PNG_BYTES), 'the bot version bytes');

            const cleared = await app.request(
                `/s/${conversationShare.token}/media/${missingChild.messageId}/image`
            );
            expect(cleared.status === 404, `a cleared album item is not served (got ${cleared.status})`);
            const outside = await app.request(`/s/${conversationShare.token}/media/${outsideMessageId}/image`);
            expect(outside.status === 404, `a message outside the share is not served (got ${outside.status})`);
        },
    },
    {
        name: 'a reply share keeps one single attachment object',
        body: async () => {
            const replyShare = await createReplyShare(botImageId);
            const body = await jsonOf(await app.request(`/api/public/shares/${replyShare.token}`));
            const replyMedia = body.share?.reply?.media;
            expect(
                typeof replyMedia === 'object' && replyMedia !== null && !Array.isArray(replyMedia),
                `the reply keeps one attachment object (got ${JSON.stringify(replyMedia)})`
            );
            expect(
                replyMedia.kind === 'image' && replyMedia.mimeType === 'image/png',
                'the pinned version picture facts'
            );
            expect(!Object.hasOwn(replyMedia, 'messageId'), 'a reply attachment names no message of its own');

            const page = await (await app.request(`/s/${replyShare.token}`)).text();
            const imgPrefix = `<img src="/s/${replyShare.token}/media/`;
            expect(
                page.includes(`${imgPrefix}${botImageId}/image"`),
                'the reply page shows the pinned picture'
            );
            expect(page.split(imgPrefix).length - 1 === 1, 'a reply page renders one figure');
            const served = await app.request(`/s/${replyShare.token}/media/${botImageId}/image`);
            expect(served.status === 200 && (await bytesOf(served)).equals(PNG_BYTES), 'the reply media route');
        },
    },
    {
        name: 'a sub-image hint adds no hint, a bubble without media still shows its own',
        body: async () => {
            const panel = await jsonOf(await call(`/api/chats/${GROUP}/conversations/${shareParentId}`, ALICE));
            const panelNode = findNode(panel, shareParentId);
            const panelMedia = Array.isArray(panelNode.media) ? panelNode.media : [];
            expect(panelMedia.length === 2, 'the cleared item is not an attachment of the panel bubble');
            expect(panelNode.mediaHint === 'some pictures', "the bubble carries the parent's own hint");

            const body = await jsonOf(await app.request(`/api/public/shares/${conversationShare.token}`));
            const bubbles: any[] = Array.isArray(body.share?.conversation?.bubbles)
                ? body.share.conversation.bubbles
                : [];
            const userBubble = bubbles.find((bubble: any) => bubble.messageId === shareParentId);
            expect(
                userBubble?.mediaHint === 'some pictures',
                `the public bubble carries the parent's hint, not a sub-image's (got ${userBubble?.mediaHint})`
            );

            const page = await (await app.request(`/s/${conversationShare.token}`)).text();
            expect(
                !page.includes('<span class="media-hint">'),
                'no hint is drawn next to a bubble that has attachments'
            );
            expect(!page.includes('some pictures'), 'a sub-image hint never reaches the page');

            // The hint path still works for a bubble whose media the retention cleared
            const clearedRootId = takeMessageId();
            await saveMessage(clearedRootId, ALICE.id, '图片已被清理', {
                fileUniqueId: 'album-hint-cleared',
                fileMime: 'image/jpeg',
                mediaHint: 'a picture',
            });
            const clearedShare = await createConversationShare(clearedRootId);
            const clearedPage = await (await app.request(`/s/${clearedShare.token}`)).text();
            expect(
                clearedPage.includes('<span class="media-hint">[a picture]</span>'),
                'a bubble without media still shows its own hint'
            );
            const clearedBody = await jsonOf(await app.request(`/api/public/shares/${clearedShare.token}`));
            const clearedBubble = clearedBody.share?.conversation?.bubbles?.[0];
            expect(
                Array.isArray(clearedBubble?.media) && clearedBubble.media.length === 0,
                `a cleared single photo has an empty attachment list (got ${JSON.stringify(clearedBubble?.media)})`
            );
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) results.push(await runCase(testCase.name, testCase.body));
reportResults(results);
