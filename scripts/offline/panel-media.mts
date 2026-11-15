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
            expect(
                Array.isArray(node.media) && node.media.length === 1,
                `one attachment on the member node (got ${JSON.stringify(node.media)})`
            );
            const mediaItem = node.media[0] ?? {};
            expect(mediaItem.kind === 'image' && mediaItem.mimeType === 'image/png', 'the member node carries the picture');
            expect(mediaItem.url?.startsWith('/m/') === true, `the URL is a signed /m/ path (got ${mediaItem.url})`);

            const media = await app.request(mediaItem.url);
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
            const first = detail.versions?.[0]?.media ?? [];
            const second = detail.versions?.[1]?.media ?? [];
            expect(
                Array.isArray(first) && first.length === 1 && first[0]?.kind === 'image' && first[0]?.mimeType === 'image/png',
                `the first version is one picture (got ${JSON.stringify(first)})`
            );
            expect(
                Array.isArray(second) && second.length === 1 && second[0]?.kind === 'sticker' && second[0]?.mimeType === 'video/webm',
                `the second version is an animated sticker (got ${JSON.stringify(second)})`
            );

            const picture = await app.request(first[0].url);
            expect(picture.status === 200 && picture.headers.get('Content-Type') === 'image/png', 'the picture bytes');
            const clip = await app.request(second[0].url);
            expect(clip.status === 200 && clip.headers.get('Content-Type') === 'video/webm', 'the sticker clip bytes');
        },
    },
    {
        name: 'a version with several pictures signs one URL per picture, in delivery order',
        body: async () => {
            const { rootId, botId } = await seedConversation();
            const pictures = ['multi-1', 'multi-2', 'multi-3'].map((label) =>
                Buffer.concat([PNG_BYTES, Buffer.from(`-${label}`)])
            );
            const keys = pictures.map((_bytes, index) => `version-media-${botId}-${index + 1}`);
            for (const [index, key] of keys.entries()) {
                await putCachedMedia({
                    fileUniqueId: key,
                    mime: 'image/png',
                    kind: 'photo',
                    data: pictures[index] ?? PNG_BYTES,
                    sizeBytes: pictures[index]?.length ?? PNG_BYTES.length,
                });
            }
            await makeReply(botId, rootId, [
                versionOf(1, {
                    media: pictures.map((bytes, index) => ({
                        placement: index === 0 ? 'inline' : 'attachment',
                        mediaKey: keys[index] ?? '',
                        mimeType: 'image/png',
                        sizeBytes: bytes.length,
                    })),
                }),
            ]);

            const detail = await jsonOf(await call(`/api/chats/${GROUP}/replies/${botId}`, ALICE));
            const media = detail.versions?.[0]?.media ?? [];
            expect(
                Array.isArray(media) && media.length === 3,
                `the version lists all three pictures (got ${JSON.stringify(media)})`
            );
            expect(
                media.every((item: any) => item.kind === 'image' && item.mimeType === 'image/png'),
                'every item is a picture'
            );
            const urls = media.map((item: any) => item.url);
            expect(urls.every((url: unknown) => typeof url === 'string' && url.startsWith('/m/')), 'signed URLs');
            expect(new Set(urls).size === 3, 'each picture has its own signed URL');

            // The first picture keeps the pre-v5 payload (no index); later ones name it
            const payloadOf = (url: string): any =>
                JSON.parse(Buffer.from(url.slice('/m/'.length).split('.')[0] ?? '', 'base64url').toString('utf8'));
            expect(payloadOf(urls[0]).i === undefined, 'the first picture needs no index in its payload');
            expect(payloadOf(urls[1]).i === 1 && payloadOf(urls[2]).i === 2, 'later pictures carry their 0-based index');

            for (const [index, url] of urls.entries()) {
                const served = await app.request(url);
                expect(served.status === 200, `picture ${index + 1} answers 200 (got ${served.status})`);
                expect(
                    (await bytesOf(served)).equals(pictures[index] ?? Buffer.alloc(0)),
                    `picture ${index + 1} serves its own bytes`
                );
            }

            // A validly signed index past the list resolves to nothing: same 404
            const indexSigner = createMediaSigner({ botToken: BOT_TOKEN });
            const past = indexSigner.sign({ chatId: GROUP, messageId: botId, versionId: 1, mediaIndex: 9, kind: 'ver' });
            expect((await app.request(past.path)).status === 404, 'an index past the list is a 404');
            const otherVersion = indexSigner.sign({ chatId: GROUP, messageId: botId, versionId: 99, mediaIndex: 1, kind: 'ver' });
            expect((await app.request(otherVersion.path)).status === 404, 'a missing version is still a 404');
        },
    },
    {
        name: 'a legacy single-image version keeps its old URL and bytes',
        body: async () => {
            const { rootId, botId } = await seedConversation();
            await makeReply(botId, rootId, [versionOf(1, { imageBase64: PNG_BYTES.toString('base64') })]);
            const detail = await jsonOf(await call(`/api/chats/${GROUP}/replies/${botId}`, ALICE));
            const media = detail.versions?.[0]?.media ?? [];
            expect(media.length === 1 && media[0]?.kind === 'image', 'one legacy picture');
            const url: string = media[0]?.url ?? '';
            const encoded = url.slice('/m/'.length).split('.')[0] ?? '';
            const payload: any = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
            expect(payload.i === undefined, 'the legacy payload names no picture index');
            const served = await app.request(url);
            expect(served.status === 200 && (await bytesOf(served)).equals(PNG_BYTES), 'the legacy bytes are served');
        },
    },
    {
        name: 'a version whose cache lost a picture falls back to its legacy first image',
        body: async () => {
            const { rootId, botId } = await seedConversation();
            await makeReply(botId, rootId, [
                versionOf(1, {
                    imageBase64: PNG_BYTES.toString('base64'),
                    media: [
                        { placement: 'inline', mediaKey: `never-cached-${botId}`, mimeType: 'image/png', sizeBytes: PNG_BYTES.length },
                        { placement: 'attachment', mediaKey: `never-cached-b-${botId}`, mimeType: 'image/png', sizeBytes: PNG_BYTES.length },
                    ],
                }),
            ]);
            const detail = await jsonOf(await call(`/api/chats/${GROUP}/replies/${botId}`, ALICE));
            const media = detail.versions?.[0]?.media ?? [];
            expect(media.length === 2, 'the version still lists both pictures');
            const first = await app.request(media[0]?.url ?? '');
            expect(first.status === 200, `the first picture falls back to the version's legacy bytes (got ${first.status})`);
            expect((await bytesOf(first)).equals(PNG_BYTES), 'the fallback serves the legacy bytes');
            expect((await app.request(media[1]?.url ?? '')).status === 404, 'the second picture has no fallback copy');
        },
    },
    {
        name: 'a tree bot node lists every picture of the current version',
        body: async () => {
            const { rootId, botId } = await seedConversation();
            const pictures = ['tree-1', 'tree-2'].map((label) =>
                Buffer.concat([PNG_BYTES, Buffer.from(`-${label}`)])
            );
            const keys = pictures.map((_bytes, index) => `tree-media-${botId}-${index + 1}`);
            for (const [index, key] of keys.entries()) {
                await putCachedMedia({
                    fileUniqueId: key,
                    mime: 'image/png',
                    kind: 'photo',
                    data: pictures[index] ?? PNG_BYTES,
                    sizeBytes: pictures[index]?.length ?? PNG_BYTES.length,
                });
            }
            await makeReply(botId, rootId, [
                versionOf(1, {
                    media: pictures.map((bytes, index) => ({
                        placement: 'inline',
                        mediaKey: keys[index] ?? '',
                        mimeType: 'image/png',
                        sizeBytes: bytes.length,
                    })),
                }),
            ]);

            const tree = await jsonOf(await call(`/api/chats/${GROUP}/conversations/${rootId}`, ALICE));
            const node = findNode(tree, botId);
            const media = node?.reply?.media ?? [];
            expect(
                Array.isArray(media) && media.length === 2,
                `the bot node lists both pictures (got ${JSON.stringify(media)})`
            );
            expect(
                media.every((item: any) => item.kind === 'image' && item.url?.startsWith('/m/')),
                'each picture has its own signed URL'
            );
            for (const [index, url] of media.map((item: any) => item.url).entries()) {
                const served = await app.request(url);
                expect(served.status === 200, `tree picture ${index + 1} answers 200 (got ${served.status})`);
                expect(
                    (await bytesOf(served)).equals(pictures[index] ?? Buffer.alloc(0)),
                    `tree picture ${index + 1} serves its own bytes`
                );
            }
        },
    },
    {
        name: 'a cleared picture of a multi-picture version answers 404 while the others still load',
        body: async () => {
            const { rootId, botId } = await seedConversation();
            const pictures = ['gone-1', 'gone-2'].map((label) =>
                Buffer.concat([PNG_BYTES, Buffer.from(`-${label}`)])
            );
            const keys = pictures.map((_bytes, index) => `cleared-media-${botId}-${index + 1}`);
            // Only the second picture's bytes are still in the cache
            await putCachedMedia({
                fileUniqueId: keys[1] ?? '',
                mime: 'image/png',
                kind: 'photo',
                data: pictures[1] ?? PNG_BYTES,
                sizeBytes: pictures[1]?.length ?? PNG_BYTES.length,
            });
            await makeReply(botId, rootId, [
                versionOf(1, {
                    media: pictures.map((bytes, index) => ({
                        placement: index === 0 ? 'inline' : 'attachment',
                        mediaKey: keys[index] ?? '',
                        mimeType: 'image/png',
                        sizeBytes: bytes.length,
                    })),
                }),
            ]);

            const detail = await jsonOf(await call(`/api/chats/${GROUP}/replies/${botId}`, ALICE));
            const media = detail.versions?.[0]?.media ?? [];
            expect(media.length === 2, 'the version still describes both pictures');
            expect((await app.request(media[0]?.url ?? '')).status === 404, 'the cleared picture is a 404');
            const second = await app.request(media[1]?.url ?? '');
            expect(second.status === 200, `the surviving picture still loads (got ${second.status})`);
            expect(
                (await bytesOf(second)).equals(pictures[1] ?? Buffer.alloc(0)),
                'the surviving picture keeps its own bytes'
            );
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
            const legacyItem = legacyNode.media[0] ?? {};
            expect(legacyItem.kind === 'image', 'the legacy file renders');
            const legacyBytes = await app.request(legacyItem.url);
            expect((await bytesOf(legacyBytes)).equals(PNG_BYTES), 'the legacy bytes are served');

            const missingRoot = takeMessageId();
            await saveMessage(GROUP, missingRoot, ALICE.id, '没有缓存', {
                fileUniqueId: 'photo-never-cached',
                fileMime: 'image/png',
                mediaHint: 'a picture',
            });
            const missingTree = await jsonOf(await call(`/api/chats/${GROUP}/conversations/${missingRoot}`, ALICE));
            const missingNode = findNode(missingTree, missingRoot);
            expect(
                Array.isArray(missingNode.media) && missingNode.media.length === 0,
                `a cache miss leaves the node with an empty list (got ${JSON.stringify(missingNode.media)})`
            );
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
            const rangeNode = findNode(tree, rootId);
            expect(
                Array.isArray(rangeNode.media) && rangeNode.media.length === 1,
                `one attachment for the range request (got ${JSON.stringify(rangeNode.media)})`
            );
            const url = rangeNode.media[0]?.url;

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
            expect(
                Array.isArray(bubble?.media) &&
                    bubble.media.length === 1 &&
                    bubble.media[0]?.kind === 'image' &&
                    bubble.media[0]?.messageId === rootId,
                `the public bubble carries the picture (got ${JSON.stringify(bubble?.media)})`
            );
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
            expect(
                Array.isArray(linked.media) && linked.media.length === 1 && linked.media[0]?.kind === 'image',
                `the bubble carries its picture (got ${JSON.stringify(linked.media)})`
            );
            const served = await app.request(`/s/${token}/media/${linkedId}/image`);
            expect(served.status === 200 && (await bytesOf(served)).equals(PNG_BYTES), 'the linked message media is served');
        },
    },
    {
        // v5.1: the Mini App renders a rich reply the way Telegram does, so the
        // version hands it the rendered answer snapshot and where each picture
        // sits (design 2026-1115-2355 §三.1).
        name: 'a rich version exposes its answer snapshot and where each picture sits',
        body: async () => {
            const { rootId, botId } = await seedConversation();
            const richSnapshot = [
                '### 今天的图形',
                '',
                '![](tg://photo?id=img1 "第一张：红色圆形")',
                '',
                '**第二段**，见图二。',
                '',
                '![](tg://photo?id=img2 "第二张：绿色三角形")',
            ].join('\n');
            await makeReply(botId, rootId, [
                versionOf(1, {
                    delivery: 'rich',
                    richRenderer: 'v1',
                    richAnswerMarkdown: richSnapshot,
                    media: [
                        {
                            placement: 'inline',
                            id: 'img1',
                            mediaKey: 'out:sha256:inline-one',
                            mimeType: 'image/png',
                            sizeBytes: PNG_BYTES.length,
                            caption: '第一张：红色圆形',
                        },
                        {
                            placement: 'inline',
                            id: 'img2',
                            mediaKey: 'out:sha256:inline-two',
                            mimeType: 'image/png',
                            sizeBytes: PNG_BYTES.length,
                            caption: '第二张：绿色三角形',
                        },
                    ],
                }),
                versionOf(2, {
                    imageBase64: PNG_BYTES.toString('base64'),
                    imageCaption: '旧版单图图注',
                    // A stale snapshot on an entities version must stay hidden
                    richAnswerMarkdown: 'entities 版本不该出现快照',
                }),
                versionOf(3, {
                    delivery: 'rich-text',
                    richRenderer: 'v1',
                    richAnswerMarkdown: '只能把图片放在下面了。',
                }),
            ]);

            const detail = await jsonOf(await call(`/api/chats/${GROUP}/replies/${botId}`, ALICE));
            const rich = detail.versions?.[0] ?? {};
            expect(rich.richAnswerMarkdown === richSnapshot, `the rich version carries its answer snapshot (got ${JSON.stringify(rich.richAnswerMarkdown)})`);
            expect(Array.isArray(rich.media) && rich.media.length === 2, `two pictures (got ${JSON.stringify(rich.media)})`);
            const inline = rich.media[0] ?? {};
            expect(
                inline.placement === 'inline' && inline.id === 'img1' && inline.caption === '第一张：红色圆形',
                `an inline picture names its placement, media id and caption (got ${JSON.stringify(inline)})`
            );
            expect(
                rich.media[1]?.id === 'img2' && rich.media[1]?.caption === '第二张：绿色三角形',
                `the second inline picture too (got ${JSON.stringify(rich.media[1])})`
            );
            expect(
                String(inline.url).startsWith('/m/'),
                `and still carries its signed URL (got ${JSON.stringify(inline.url)})`
            );

            // An entities version has no snapshot, and its legacy single picture
            // is a trailing attachment carrying the stored caption
            const entities = detail.versions?.[1] ?? {};
            expect(!('richAnswerMarkdown' in entities), `an entities version has no snapshot (got ${JSON.stringify(entities.richAnswerMarkdown)})`);
            const legacy = entities.media?.[0] ?? {};
            expect(
                legacy.placement === 'attachment' && legacy.caption === '旧版单图图注' && legacy.id === undefined,
                `the legacy single picture is an attachment with its caption and no id (got ${JSON.stringify(legacy)})`
            );

            // A rich-text fallback (L2) has a snapshot but no inline pictures:
            // the detail shows its text snapshot, the media list stays empty
            const fallback = detail.versions?.[2] ?? {};
            expect(
                fallback.richAnswerMarkdown === '只能把图片放在下面了。',
                `a rich-text version still carries its snapshot (got ${JSON.stringify(fallback.richAnswerMarkdown)})`
            );
            expect(
                Array.isArray(fallback.media) && fallback.media.length === 0,
                `and has no picture in the body (got ${JSON.stringify(fallback.media)})`
            );
        },
    },
    {
        // The tree payload only grows for a rich answer that embeds pictures;
        // text-only rich and entities replies keep the payload they had.
        name: 'a tree summary carries the answer snapshot only when the answer embeds pictures',
        body: async () => {
            const inlineSnapshot = '开头。\n\n![](tg://photo?id=img1 "一张")';
            const summaryOfReply = async (versions: ResponseVersion[]): Promise<any> => {
                const { rootId, botId } = await seedConversation();
                await makeReply(botId, rootId, versions);
                const tree = await jsonOf(await call(`/api/chats/${GROUP}/conversations/${rootId}`, ALICE));
                return findNode(tree, botId)?.reply;
            };

            const withPictures = await summaryOfReply([
                versionOf(1, {
                    delivery: 'rich',
                    richRenderer: 'v1',
                    richAnswerMarkdown: inlineSnapshot,
                    media: [
                        {
                            placement: 'inline',
                            id: 'img1',
                            mediaKey: 'out:sha256:summary-inline',
                            mimeType: 'image/png',
                            sizeBytes: PNG_BYTES.length,
                            caption: '一张',
                        },
                    ],
                }),
            ]);
            expect(
                withPictures?.richAnswerMarkdown === inlineSnapshot,
                `the summary carries the snapshot when pictures sit inside it (got ${JSON.stringify(withPictures?.richAnswerMarkdown)})`
            );
            expect(
                withPictures?.media?.[0]?.placement === 'inline' && withPictures?.media?.[0]?.id === 'img1',
                `and its media keeps the inline placement (got ${JSON.stringify(withPictures?.media?.[0])})`
            );

            const textOnly = await summaryOfReply([
                versionOf(1, {
                    delivery: 'rich-text',
                    richRenderer: 'v1',
                    richAnswerMarkdown: '只能把图片放在下面了。\n\n（另有 2 张图未能内嵌发送）',
                }),
            ]);
            expect(
                !('richAnswerMarkdown' in (textOnly ?? {})),
                `a text-only rich answer adds no snapshot to the tree (got ${JSON.stringify(textOnly?.richAnswerMarkdown)})`
            );

            const entities = await summaryOfReply([
                versionOf(1, { imageBase64: PNG_BYTES.toString('base64'), imageCaption: '图注' }),
            ]);
            expect(
                !('richAnswerMarkdown' in (entities ?? {})),
                `an entities reply adds no snapshot either (got ${JSON.stringify(entities?.richAnswerMarkdown)})`
            );
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) results.push(await runCase(testCase.name, testCase.body));
reportResults(results);
