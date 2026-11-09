/**
 * Offline cases for a share's preview image (design §5.7): the widget render
 * Telegram previews, its 1200px light-theme render, the shares that have no
 * image (no widget), the failure path, and the stored card the page reads back.
 *
 * A local stub stands in for the widget-render sidecar: it answers /render with
 * a PNG whose IHDR carries the requested width and a fixed content height, so
 * the cases can assert the real dimensions without a browser.
 *
 * Run: npx tsx scripts/offline/share-preview.mts
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';

process.env.WEBAPP_PUBLIC_URL = 'https://miniapp.test';
process.env.OWNER_USER_ID = '4242';
process.env.BOT_USER_ID = '9999';
delete process.env.ALLOWED_CHAT_IDS;

/** A 1×1 PNG; the stub patches its IHDR to the size it wants to report */
const PNG_1PX =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const CONTENT_HEIGHT = 428;

const pngOf = (width: number, height: number): Buffer => {
    const png = Buffer.from(PNG_1PX, 'base64');
    png.writeUInt32BE(width, 16);
    png.writeUInt32BE(height, 20);
    return png;
};

const renderRequests: string[] = [];
let failRenders = false;
const stubServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
        const url = request.url ?? '';
        renderRequests.push(url);
        if (!url.startsWith('/render') || failRenders) {
            response.writeHead(500, { 'Content-Type': 'text/plain' });
            response.end('render failed');
            return;
        }
        const width = Number(new URL(url, 'http://127.0.0.1').searchParams.get('width') ?? '600');
        const png = pngOf(width, CONTENT_HEIGHT);
        response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
        response.end(png);
    });
});
await new Promise<void>((ready) => stubServer.listen(0, '127.0.0.1', ready));
process.env.WIDGET_RENDER_URL = `http://127.0.0.1:${(stubServer.address() as AddressInfo).port}`;

await setupOfflineDb();
const db = await import('../../src/db/index.js');
const previewCard = await import('../../src/panel/share/preview-card.js');
const service = await import('../../src/panel/share/share-link-service.js');
const store = await import('../../src/panel/share/share-store.js');
const content = await import('../../src/panel/share/share-content.js');

const CHAT_ID = -1001000000001;
const BOT_USER_ID = 9999;
const CREATOR = { userId: 5001, isOwner: false };

let nextMessageId = 6000;
const newMessageId = (): number => (nextMessageId += 1);

type ResponseVersion = import('../../src/db/index.js').ResponseVersion;
type PreviewSnapshot = import('../../src/panel/share/share-types.js').PreviewSnapshot;

const snapshotOf = (overrides: Partial<PreviewSnapshot> = {}): PreviewSnapshot => ({
    chatTitle: '主群',
    createdAt: '2026-11-09T13:30:00.000Z',
    text: '这是回复正文',
    ...overrides,
});

const widgetOf = (caption?: string) => ({
    mode: 'a2ui' as const,
    html: `<div class="tw-root">${caption ?? '卡片'}</div>`,
    htmlBytes: 40,
    zlibBytes: 20,
    ...(caption === undefined ? {} : { caption }),
});

const versionOf = (versionId: number, overrides: Partial<ResponseVersion> = {}): ResponseVersion => ({
    versionId,
    createdAt: '2026-11-09T12:00:00.000Z',
    messageIds: [800 + versionId],
    currentMessageId: 800 + versionId,
    text: `第 ${versionId} 版正文`,
    wasStoppedByUser: false,
    ...overrides,
});

const makeReply = async (messageId: number, versions: ResponseVersion[]): Promise<void> => {
    const response = await db.createBotResponse(CHAT_ID, messageId, 400, { model: 'offline-model', hasImage: false });
    response.setVersions(versions);
    response.currentVersionIndex = 0;
    await response.save();
};

const saveMessage = async (messageId: number, userId: number, text: string, replyToId?: number): Promise<void> => {
    await db.saveMessage({
        chatId: CHAT_ID,
        messageId,
        userId,
        date: new Date('2026-11-09T12:00:00.000Z'),
        userName: userId === BOT_USER_ID ? 'k-on-bot' : 'Alice',
        message: text,
        ...(replyToId === undefined ? {} : { replyToId }),
    });
};

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'a widget renders its preview at 1200px in the light theme',
        body: async () => {
            const requestsBefore = renderRequests.length;
            const image = await previewCard.renderPreviewImage(snapshotOf({ widgetHtml: '<div>w</div>' }));
            expect(image !== null, 'rendered');
            if (image === null) return;
            expect(
                image.width === 1200 && image.height === CONTENT_HEIGHT,
                `the rendered size (got ${image.width}x${image.height})`
            );
            expect(image.source === 'widget', 'the source is the widget');
            expect(Buffer.from(image.base64, 'base64').length > 0, 'the PNG is stored as base64');
            const request = renderRequests[requestsBefore] ?? '';
            expect(
                request.includes('width=1200') && request.includes('scale=1') && request.includes('theme=light'),
                `the render request (got ${request})`
            );
        },
    },
    {
        name: 'a share without a widget has no preview image',
        body: async () => {
            const requestsBefore = renderRequests.length;
            expect(await previewCard.renderPreviewImage(snapshotOf()) === null, 'text only, no image');
            expect(
                await previewCard.renderPreviewImage(snapshotOf({ imageBase64: PNG_1PX })) === null,
                'an image attachment is not the widget preview'
            );
            expect(renderRequests.length === requestsBefore, 'nothing was rendered');
        },
    },
    {
        name: 'a failed widget render leaves the share without an image',
        body: async () => {
            failRenders = true;
            try {
                expect(
                    await previewCard.renderPreviewImage(snapshotOf({ widgetHtml: '<div>a different card</div>' })) === null,
                    'no image on failure'
                );
            } finally {
                failRenders = false;
            }
        },
    },
    {
        name: 'a reply share stores the widget render as its preview',
        body: async () => {
            const messageId = newMessageId();
            await makeReply(messageId, [versionOf(1, { text: '一张卡片', widget: widgetOf('说明') })]);
            const created = await service.createUserShare({
                kind: 'reply',
                chatId: CHAT_ID,
                firstMessageId: messageId,
                createdBy: CREATOR.userId,
            });
            expect(created.ok, 'created');
            if (!created.ok) return;
            expect(created.share.previewWidth === 1200, `width stored (got ${created.share.previewWidth})`);
            expect(created.share.previewHeight === CONTENT_HEIGHT, 'the real height is stored');

            const row = await store.findShareRowByToken(created.share.token);
            expect(row?.previewImageBase64 !== null, 'the PNG bytes are stored');
            expect(row?.previewWidth === 1200 && row.previewHeight === CONTENT_HEIGHT, 'row dimensions');
            expect(row?.previewSource === 'widget', 'the source is the widget');
            expect(await service.ensurePreviewImage(created.share.token), 'a stored preview satisfies ensure');
            const active = await service.findActiveShare(created.share.token);
            expect(
                active?.previewWidth === 1200 && active.previewHeight === CONTENT_HEIGHT,
                'the record carries the size'
            );
        },
    },
    {
        name: 'a reply without a widget has no preview',
        body: async () => {
            const messageId = newMessageId();
            await makeReply(messageId, [versionOf(1)]);
            const created = await service.createUserShare({
                kind: 'reply',
                chatId: CHAT_ID,
                firstMessageId: messageId,
                createdBy: CREATOR.userId,
            });
            expect(created.ok, 'created');
            if (!created.ok) return;
            expect(created.share.previewWidth === null, 'no image');
            expect(await service.ensurePreviewImage(created.share.token) === false, 'ensure reports the missing image');
        },
    },
    {
        name: 'a conversation share previews the newest widget in its tree',
        body: async () => {
            const rootId = newMessageId();
            const botId = newMessageId();
            await saveMessage(rootId, CREATOR.userId, '问题');
            await saveMessage(botId, BOT_USER_ID, '', rootId);
            const response = await db.createBotResponse(CHAT_ID, botId, rootId, {
                model: 'offline-model',
                hasImage: false,
            });
            response.setVersions([versionOf(1, { text: '回答', widget: widgetOf('会话卡片') })]);
            response.currentVersionIndex = 0;
            await response.save();

            const created = await service.createUserShare({
                kind: 'conversation',
                chatId: CHAT_ID,
                rootId,
                createdBy: CREATOR.userId,
            });
            expect(created.ok, 'created');
            if (!created.ok) return;
            expect(
                created.share.previewWidth === 1200 && created.share.previewHeight === CONTENT_HEIGHT,
                'the widget render is stored'
            );
            const loaded = await content.loadConversationShareContent(CHAT_ID, rootId);
            expect(loaded?.preview.widgetHtml !== undefined, 'the snapshot carries the widget HTML');
        },
    },
    {
        name: 'a conversation share skips newer bot replies without a widget',
        body: async () => {
            const rootId = newMessageId();
            const widgetBotId = newMessageId();
            const textBotId = newMessageId();
            await saveMessage(rootId, CREATOR.userId, '问题');
            await saveMessage(widgetBotId, BOT_USER_ID, '', rootId);
            const widgetResponse = await db.createBotResponse(CHAT_ID, widgetBotId, rootId, {
                model: 'offline-model',
                hasImage: false,
            });
            widgetResponse.setVersions([versionOf(1, { text: '带卡片的回答', widget: widgetOf('卡片') })]);
            widgetResponse.currentVersionIndex = 0;
            await widgetResponse.save();
            // A newer bot reply with text only: the widget above is still the preview
            await saveMessage(textBotId, BOT_USER_ID, '', widgetBotId);
            const textResponse = await db.createBotResponse(CHAT_ID, textBotId, widgetBotId, {
                model: 'offline-model',
                hasImage: false,
            });
            textResponse.setVersions([versionOf(1, { text: '后来只有文字' })]);
            textResponse.currentVersionIndex = 0;
            await textResponse.save();

            const created = await service.createUserShare({
                kind: 'conversation',
                chatId: CHAT_ID,
                rootId,
                createdBy: CREATOR.userId,
            });
            expect(created.ok, 'created');
            if (!created.ok) return;
            expect(created.share.previewWidth === 1200, 'the older widget render is still the image');
            const loaded = await content.loadConversationShareContent(CHAT_ID, rootId);
            expect(loaded?.preview.widgetHtml !== undefined, 'the widget bubble supplies the snapshot');
        },
    },
    {
        name: 'a stored preview image is read back and not re-rendered',
        body: async () => {
            const messageId = newMessageId();
            await makeReply(messageId, [versionOf(1, { widget: widgetOf() })]);
            const created = await service.createUserShare({
                kind: 'reply',
                chatId: CHAT_ID,
                firstMessageId: messageId,
                createdBy: CREATOR.userId,
            });
            expect(created.ok, 'created');
            if (!created.ok) return;
            const card = Buffer.from('card-bytes');
            await store.updateSharePreview(created.share.token, {
                base64: card.toString('base64'),
                width: 1200,
                height: 630,
                source: 'text',
            });
            expect(await service.ensurePreviewImage(created.share.token), 'the stored card satisfies ensure');
            const row = await store.findShareRowByToken(created.share.token);
            expect(row?.previewWidth === 1200 && row.previewHeight === 630, 'dimensions stored');
            expect(row?.previewSource === 'text', 'source stored');
            const active = await service.findActiveShare(created.share.token);
            expect(active?.previewWidth === 1200 && active.previewHeight === 630, 'the record carries the dimensions');
        },
    },
    {
        name: 'the reply content carries the widget HTML the preview needs',
        body: async () => {
            const messageId = newMessageId();
            await makeReply(messageId, [versionOf(1, { widget: widgetOf('卡片说明') })]);
            const loaded = await content.loadReplyShareContent(CHAT_ID, messageId, null);
            expect(loaded?.widget?.caption === '卡片说明', 'the widget content');
            expect(loaded?.preview.widgetHtml !== undefined, 'the snapshot carries the HTML');
            expect(loaded?.preview.widgetImageBase64 === undefined, 'no stored 600px render needed');
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) results.push(await runCase(testCase.name, testCase.body));
stubServer.close();
reportResults(results);
