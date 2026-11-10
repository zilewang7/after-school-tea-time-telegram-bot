/**
 * Offline cases for chat media in the panel and the share pages (design
 * 2026-1110-1437): the signed `/m/…` URLs the Mini App loads, the sources they
 * resolve (inline cache, legacy message bytes, bot versions, captured link
 * previews), range requests, and the public share's own media route.
 *
 * Run: npx tsx scripts/offline/panel-media.mts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrammyError } from 'grammy';
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';
import type { InitDataUserInput } from '../lib/init-data.mts';

const BOT_TOKEN = '123456789:AAFakeOfflineTokenForPanelMediaTests_01';
const OWNER_ID = 4242;
const ALICE: InitDataUserInput = { id: 5001, first_name: 'Alice' };
const OWNER: InitDataUserInput = { id: OWNER_ID, first_name: 'Owner' };
const GROUP = -1001000000001;
const BOT_USER_ID = 9999;

process.env.OWNER_USER_ID = String(OWNER_ID);
process.env.WEBAPP_PUBLIC_URL = 'https://miniapp.test';
process.env.BOT_USER_ID = String(BOT_USER_ID);
process.env.WIDGET_RENDER_URL = '';
delete process.env.ALLOWED_CHAT_IDS;

await setupOfflineDb();
const registry = await import('../../src/db/queries/panel-registry.js');
const db = await import('../../src/db/index.js');
const service = await import('../../src/panel/share/share-link-service.js');
const { putCachedMedia } = await import('../../src/services/media-cache-service.js');
const { saveMessageLinks } = await import('../../src/db/queries/context-queries.js');
const { createMediaSigner, SIGNED_MEDIA_TTL_SECONDS } = await import('../../src/panel/share/signed-media.js');
const { createPanelApp } = await import('../../src/panel/app.js');
const { signInitData } = await import('../lib/init-data.mts');

type MembershipLookup = import('../../src/panel/access/membership.js').MembershipLookup;
type PanelApp = ReturnType<typeof createPanelApp>;
type ResponseVersion = import('../../src/db/index.js').ResponseVersion;

const scratch = mkdtempSync(join(tmpdir(), 'k-on-bot-panel-media-'));
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
        startedAt: new Date('2026-11-10T00:00:00.000Z'),
        version: 'abc1234',
        now: () => Date.now(),
        shareEnabled: true,
    });

const app = makeApp();

const PNG_1PX =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_1PX, 'base64');
/** EBML header: enough for the webm sniff */
const WEBM_BYTES = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04]);

const call = (path: string, user: InitDataUserInput): Promise<Response> =>
    Promise.resolve(
        app.request(path, {
            headers: {
                'X-Init-Data': signInitData({ botToken: BOT_TOKEN, user, authDate: Math.floor(Date.now() / 1000) }),
            },
        })
    );

const jsonOf = async (response: Response): Promise<any> => {
    const text = await response.text();
    try {
        return JSON.parse(text);
    } catch {
        return { notJson: text };
    }
};

const versionOf = (versionId: number, overrides: Partial<ResponseVersion> = {}): ResponseVersion => ({
    versionId,
    createdAt: '2026-11-10T12:00:00.000Z',
    messageIds: [900 + versionId],
    currentMessageId: 900 + versionId,
    text: `第 ${versionId} 版`,
    wasStoppedByUser: false,
    ...overrides,
});

const saveMessage = (
    chatId: number,
    messageId: number,
    userId: number,
    text: string,
    options: {
        replyToId?: number;
        file?: Buffer;
        fileMime?: string;
        fileUniqueId?: string;
        mediaHint?: string;
    } = {}
): Promise<void> =>
    db.saveMessage({
        chatId,
        messageId,
        userId,
        date: new Date('2026-11-10T12:00:00.000Z'),
        userName: userId === BOT_USER_ID ? 'k-on-bot' : 'Alice',
        message: text,
        ...(options.replyToId === undefined ? {} : { replyToId: options.replyToId }),
        ...(options.file === undefined ? {} : { fileBuffer: options.file }),
        ...(options.fileMime === undefined ? {} : { fileMime: options.fileMime }),
        ...(options.fileUniqueId === undefined ? {} : { fileUniqueId: options.fileUniqueId }),
        ...(options.mediaHint === undefined ? {} : { mediaHint: options.mediaHint }),
    });

const makeReply = async (
    messageId: number,
    userMessageId: number,
    versions: ResponseVersion[]
): Promise<void> => {
    const response = await db.createBotResponse(GROUP, messageId, userMessageId, {
        model: 'offline-model',
        hasImage: false,
    });
    response.setVersions(versions);
    response.currentVersionIndex = 0;
    await response.save();
};

/** The root user message + one bot reply, the smallest tree the panel renders */
const seedConversation = async (): Promise<{ rootId: number; botId: number }> => {
    const rootId = takeMessageId();
    await saveMessage(GROUP, rootId, ALICE.id, '看这个');
    const botId = takeMessageId();
    await saveMessage(GROUP, botId, BOT_USER_ID, '', { replyToId: rootId });
    return { rootId, botId };
};

let nextMessageId = 5000;
const takeMessageId = (): number => nextMessageId++;

await registry.upsertChatNow({ id: GROUP, type: 'supergroup', title: 'Group', username: 'group_name' });

const findNode = (tree: any, messageId: number): any =>
    Array.isArray(tree.nodes) ? tree.nodes.find((node: any) => node.messageId === messageId) : undefined;

const bytesOf = async (response: Response): Promise<Buffer> => Buffer.from(await response.arrayBuffer());

// ---- cases ----------------------------------------------------------------

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'a member tree signs the media of a user picture, an observer gets none',
        body: async () => {
            const { rootId } = await seedConversation();
            await putCachedMedia({
                fileUniqueId: 'photo-inline-1',
                mime: 'image/png',
                kind: 'photo',
                data: PNG_BYTES,
                sizeBytes: PNG_BYTES.length,
            });
            await saveMessage(GROUP, rootId, ALICE.id, '一张图', {
                fileUniqueId: 'photo-inline-1',
                fileMime: 'image/png',
                mediaHint: 'a picture',
            });

            const tree = await jsonOf(await call(`/api/chats/${GROUP}/conversations/${rootId}`, ALICE));
            const node = findNode(tree, rootId);
            expect(node.media?.kind === 'image' && node.media?.mimeType === 'image/png', 'the member node carries the picture');
            expect(node.media?.url.startsWith('/m/') === true, `the URL is a signed /m/ path (got ${node.media?.url})`);

            const media = await app.request(node.media.url);
            expect(media.status === 200, `the signed URL answers 200 (got ${media.status})`);
            expect(media.headers.get('Content-Type') === 'image/png', 'the stored MIME type');
            expect((await bytesOf(media)).equals(PNG_BYTES), 'the stored bytes');

            const observed = await jsonOf(await call(`/api/chats/${GROUP}/conversations/${rootId}`, OWNER));
            const observedNode = findNode(observed, rootId);
            expect(observedNode.redacted === true && observedNode.media === undefined, 'the observer node has no media field');
        },
    },
    {
        name: 'a signed media URL rejects a forged signature and expires',
        body: async () => {
            let clockMs = 1_700_000_000_000;
            const signer = createMediaSigner({ botToken: BOT_TOKEN, secret: 'offline-media-secret', now: () => clockMs });
            const signed = signer.sign({ chatId: GROUP, messageId: 1, kind: 'msg' });
            expect(signer.verify(signed.path.slice('/m/'.length)) !== null, 'a fresh token verifies');
            expect((await app.request(signed.path)).status === 404, 'the app rejects a token minted with another key');

            const tampered = `${signed.path.slice(0, -1)}${signed.path.endsWith('A') ? 'B' : 'A'}`;
            expect((await app.request(tampered)).status === 404, 'a tampered token is a 404');
            expect(signer.verify(tampered.slice('/m/'.length)) === null, 'the signer rejects the tampered token');

            clockMs += (SIGNED_MEDIA_TTL_SECONDS + 1) * 1000;
            expect(signer.verify(signed.path.slice('/m/'.length)) === null, 'the token expires after its TTL');
        },
    },
    {
        name: 'a bot version serves its picture and its animated sticker as a clip',
        body: async () => {
            const { rootId, botId } = await seedConversation();
            await makeReply(botId, rootId, [
                versionOf(1, { imageBase64: PNG_BYTES.toString('base64') }),
                versionOf(2, {
                    imageBase64: WEBM_BYTES.toString('base64'),
                    sticker: { packIndex: 1, label: '贴纸', emoji: '🌟', fileId: 'f', fileUniqueId: 'u' },
                }),
            ]);

            const detail = await jsonOf(await call(`/api/chats/${GROUP}/replies/${botId}`, ALICE));
            const first = detail.versions?.[0]?.media;
            const second = detail.versions?.[1]?.media;
            expect(first?.kind === 'image' && first?.mimeType === 'image/png', 'the first version is a picture');
            expect(second?.kind === 'sticker' && second?.mimeType === 'video/webm', 'the second version is an animated sticker');

            const picture = await app.request(first.url);
            expect(picture.status === 200 && picture.headers.get('Content-Type') === 'image/png', 'the picture bytes');
            const clip = await app.request(second.url);
            expect(clip.status === 200 && clip.headers.get('Content-Type') === 'video/webm', 'the sticker clip bytes');
        },
    },
    {
        name: 'legacy message bytes still render, a cache miss does not',
        body: async () => {
            const legacyRoot = takeMessageId();
            await saveMessage(GROUP, legacyRoot, ALICE.id, '旧图', {
                file: PNG_BYTES,
                fileMime: 'image/png',
                mediaHint: 'a picture',
            });
            const legacyTree = await jsonOf(await call(`/api/chats/${GROUP}/conversations/${legacyRoot}`, ALICE));
            const legacyNode = findNode(legacyTree, legacyRoot);
            expect(legacyNode.media?.kind === 'image', 'the legacy file renders');
            const legacyBytes = await app.request(legacyNode.media.url);
            expect((await bytesOf(legacyBytes)).equals(PNG_BYTES), 'the legacy bytes are served');

            const missingRoot = takeMessageId();
            await saveMessage(GROUP, missingRoot, ALICE.id, '没有缓存', {
                fileUniqueId: 'photo-never-cached',
                fileMime: 'image/png',
                mediaHint: 'a picture',
            });
            const missingTree = await jsonOf(await call(`/api/chats/${GROUP}/conversations/${missingRoot}`, ALICE));
            expect(findNode(missingTree, missingRoot).media === null, 'a cache miss leaves the node without media');
        },
    },
    {
        name: 'a captured link preview picture is signed and served',
        body: async () => {
            const rootId = takeMessageId();
            const url = 'https://example.com/gallery/post-1';
            await saveMessage(GROUP, rootId, ALICE.id, `看这个 ${url} 很漂亮`);
            await putCachedMedia({
                fileUniqueId: 'luoxu-preview:test:photo',
                mime: 'image/png',
                kind: 'photo',
                data: PNG_BYTES,
                sizeBytes: PNG_BYTES.length,
            });
            await db.LinkPreviewCache.upsert({
                url,
                status: 'ready',
                siteName: 'Example',
                title: 'Post',
                description: null,
                previewType: 'photo',
                author: null,
                embedUrl: null,
                fullText: null,
                mediaItems: JSON.stringify([
                    { which: 'photo', kind: 'photo', mime: 'image/png', mediaKey: 'luoxu-preview:test:photo', sizeBytes: PNG_BYTES.length },
                ]),
                ocrText: null,
                ocrSourceTimestamp: null,
                ocrSourceUpdateId: null,
                lastUsedAt: new Date(),
            });

            const tree = await jsonOf(await call(`/api/chats/${GROUP}/conversations/${rootId}`, ALICE));
            const node = findNode(tree, rootId);
            expect(node.previewMedia?.length === 1, `one preview attachment (got ${JSON.stringify(node.previewMedia)})`);
            const preview = node.previewMedia[0];
            expect(preview.kind === 'image' && preview.mimeType === 'image/png', 'the preview facts');
            const served = await app.request(preview.url);
            expect(served.status === 200 && served.headers.get('Content-Type') === 'image/png', 'the preview bytes');
        },
    },
    {
        name: 'a media range request answers 206 with the requested slice',
        body: async () => {
            const rootId = takeMessageId();
            await putCachedMedia({
                fileUniqueId: 'photo-range-1',
                mime: 'image/png',
                kind: 'photo',
                data: PNG_BYTES,
                sizeBytes: PNG_BYTES.length,
            });
            await saveMessage(GROUP, rootId, ALICE.id, '范围', {
                fileUniqueId: 'photo-range-1',
                fileMime: 'image/png',
                mediaHint: 'a picture',
            });
            const tree = await jsonOf(await call(`/api/chats/${GROUP}/conversations/${rootId}`, ALICE));
            const url = findNode(tree, rootId).media.url;

            const response = await app.request(url, { headers: { Range: 'bytes=0-3' } });
            expect(response.status === 206, `a range request is 206 (got ${response.status})`);
            expect(response.headers.get('Content-Range') === `bytes 0-3/${PNG_BYTES.length}`, 'the content range');
            expect((await bytesOf(response)).equals(PNG_BYTES.subarray(0, 4)), 'the requested bytes');
        },
    },
    {
        name: 'a conversation share exposes the user picture and its link preview',
        body: async () => {
            const rootId = takeMessageId();
            const url = 'https://example.com/shared-post';
            await saveMessage(GROUP, rootId, ALICE.id, `分享 ${url}`, {
                fileUniqueId: 'photo-shared-1',
                fileMime: 'image/png',
                mediaHint: 'a picture',
            });
            await putCachedMedia({
                fileUniqueId: 'photo-shared-1',
                mime: 'image/png',
                kind: 'photo',
                data: PNG_BYTES,
                sizeBytes: PNG_BYTES.length,
            });
            await putCachedMedia({
                fileUniqueId: 'luoxu-preview:shared:photo',
                mime: 'image/png',
                kind: 'photo',
                data: PNG_BYTES,
                sizeBytes: PNG_BYTES.length,
            });
            await db.LinkPreviewCache.upsert({
                url,
                status: 'ready',
                siteName: 'Example',
                title: 'Shared',
                description: null,
                previewType: 'photo',
                author: null,
                embedUrl: null,
                fullText: null,
                mediaItems: JSON.stringify([
                    { which: 'photo', kind: 'photo', mime: 'image/png', mediaKey: 'luoxu-preview:shared:photo', sizeBytes: PNG_BYTES.length },
                ]),
                ocrText: null,
                ocrSourceTimestamp: null,
                ocrSourceUpdateId: null,
                lastUsedAt: new Date(),
            });

            const created = await service.createUserShare({
                kind: 'conversation',
                chatId: GROUP,
                rootId,
                createdBy: ALICE.id,
            });
            if (!created.ok) throw new Error(`could not create the share: ${created.reason}`);
            const token = created.share.token;

            const view = await jsonOf(await app.request(`/api/public/shares/${token}`));
            const bubble = view.share?.conversation?.bubbles?.[0];
            expect(bubble?.media?.kind === 'image', `the public bubble carries the picture (got ${JSON.stringify(bubble?.media)})`);
            expect(bubble?.previewMedia?.length === 1, `the public bubble carries the preview (got ${JSON.stringify(bubble?.previewMedia)})`);

            const picture = await app.request(`/s/${token}/media/${rootId}/image`);
            expect(picture.status === 200 && (await bytesOf(picture)).equals(PNG_BYTES), 'the share media route serves the picture');
            const preview = await app.request(`/s/${token}/media/${rootId}/preview?i=0`);
            expect(preview.status === 200 && (await bytesOf(preview)).equals(PNG_BYTES), 'the share media route serves the preview');
            expect((await app.request(`/s/${token}/media/${rootId}/preview?i=5`)).status === 404, 'an unknown preview index is a 404');
            expect((await app.request(`/s/${token}/media/${rootId}/file`)).status === 404, 'a picture is not served in the file slot');
        },
    },
    {
        name: 'a conversation share serves a message /chat pulled into the tree',
        body: async () => {
            const rootId = takeMessageId();
            await saveMessage(GROUP, rootId, ALICE.id, '这段对话里有一张外链消息');
            const linkedId = takeMessageId();
            await saveMessage(GROUP, linkedId, ALICE.id, '被拉进来的图', {
                fileUniqueId: 'photo-linked-1',
                fileMime: 'image/png',
                mediaHint: 'a picture',
            });
            await putCachedMedia({
                fileUniqueId: 'photo-linked-1',
                mime: 'image/png',
                kind: 'photo',
                data: PNG_BYTES,
                sizeBytes: PNG_BYTES.length,
            });
            await saveMessageLinks(GROUP, rootId, [linkedId]);

            const created = await service.createUserShare({
                kind: 'conversation',
                chatId: GROUP,
                rootId,
                createdBy: ALICE.id,
            });
            if (!created.ok) throw new Error(`could not create the share: ${created.reason}`);
            const token = created.share.token;

            const view = await jsonOf(await app.request(`/api/public/shares/${token}`));
            const bubbles = view.share?.conversation?.bubbles ?? [];
            const linked = bubbles.find((bubble: any) => bubble.messageId === linkedId);
            expect(linked !== undefined, 'the linked message is a bubble of the share');
            expect(linked.media?.kind === 'image', 'the bubble carries its picture');
            const served = await app.request(`/s/${token}/media/${linkedId}/image`);
            expect(served.status === 200 && (await bytesOf(served)).equals(PNG_BYTES), 'the linked message media is served');
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) results.push(await runCase(testCase.name, testCase.body));
reportResults(results);
