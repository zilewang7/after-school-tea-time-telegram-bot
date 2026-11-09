/**
 * Offline cases for the 1200×630 preview card (design §5.7): which content it
 * picks (widget > image > text), its texts and truncation, the card template's
 * own priority/escaping (the pure builder from src/widget-image), and the
 * degraded path when the render sidecar is off.
 *
 * No docker and no network: the sidecar client is disabled
 * (WIDGET_RENDER_URL=''), so renderShareCard returns null without a fetch.
 *
 * Run: npx tsx scripts/offline/share-preview.mts
 */
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';

process.env.WEBAPP_PUBLIC_URL = 'https://miniapp.test';
process.env.WIDGET_RENDER_URL = '';
process.env.OWNER_USER_ID = '4242';
process.env.BOT_USER_ID = '9999';
delete process.env.ALLOWED_CHAT_IDS;

await setupOfflineDb();
const db = await import('../../src/db/index.js');
const previewCard = await import('../../src/panel/share/preview-card.js');
const service = await import('../../src/panel/share/share-link-service.js');
const store = await import('../../src/panel/share/share-store.js');
const content = await import('../../src/panel/share/share-content.js');
const widgetImage = await import('../../src/widget-image/index.js');

const CHAT_ID = -1001000000001;
const CREATOR = { userId: 5001, isOwner: false };

const PNG_1PX =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

type ResponseVersion = import('../../src/db/index.js').ResponseVersion;
type PreviewSnapshot = import('../../src/panel/share/share-types.js').PreviewSnapshot;

const snapshotOf = (overrides: Partial<PreviewSnapshot> = {}): PreviewSnapshot => ({
    chatTitle: '主群',
    createdAt: '2026-11-09T13:30:00.000Z',
    text: '这是回复正文',
    ...overrides,
});

const makeReply = async (messageId: number, versions: ResponseVersion[]): Promise<void> => {
    const response = await db.createBotResponse(CHAT_ID, messageId, 400, { model: 'offline-model', hasImage: false });
    response.setVersions(versions);
    response.currentVersionIndex = 0;
    await response.save();
};

let nextMessageId = 6000;
const takeMessageId = (): number => (nextMessageId += 1);

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'the card picks widget over image over text',
        body: async () => {
            expect(previewCard.previewSourceOf(snapshotOf({ widgetHtml: '<div>w</div>' })) === 'widget', 'widget html');
            expect(
                previewCard.previewSourceOf(snapshotOf({ widgetImageBase64: PNG_1PX })) === 'widget',
                'stored widget render'
            );
            expect(previewCard.previewSourceOf(snapshotOf({ imageBase64: PNG_1PX })) === 'image', 'image attachment');
            expect(previewCard.previewSourceOf(snapshotOf()) === 'text', 'text only');
            expect(previewCard.previewSourceOf(snapshotOf({ text: '' })) === null, 'nothing to draw');
        },
    },
    {
        name: 'the card texts name the chat, the time and an excerpt',
        body: async () => {
            const input = previewCard.buildShareCardInput(snapshotOf({ text: '第一行\n第二行' }));
            expect(input.title === '来自「主群」的分享', `title (got ${input.title})`);
            expect(input.subtitle === '第一行 第二行', 'subtitle collapses whitespace');
            expect(input.footer === '主群 · 2026-11-09 21:30', `footer (got ${input.footer})`);
            expect(input.textExcerpt === '第一行 第二行', 'excerpt');
            const untitled = previewCard.buildShareCardInput(snapshotOf({ chatTitle: null }));
            expect(untitled.title === '来自 k-on-bot 的分享', 'a share without a chat title');
            expect(untitled.footer === '2026-11-09 21:30', 'footer without a title');
        },
    },
    {
        name: 'the excerpt is cut at 180 characters',
        body: async () => {
            const longText = '字'.repeat(400);
            const input = previewCard.buildShareCardInput(snapshotOf({ text: longText }));
            expect(input.textExcerpt !== undefined && Array.from(input.textExcerpt).length === 180, '180 chars');
            expect(input.textExcerpt?.endsWith('…') === true, 'an ellipsis marks the cut');
            expect(input.subtitle !== undefined && Array.from(input.subtitle).length <= 60, 'subtitle cut at 60');
        },
    },
    {
        name: 'a widget caption becomes the subtitle when there is no text',
        body: async () => {
            const input = previewCard.buildShareCardInput(snapshotOf({ text: '', caption: '卡片说明' }));
            expect(input.subtitle === '卡片说明', 'caption subtitle');
        },
    },
    {
        name: 'the card template inlines the widget snapshot and escapes its texts',
        body: async () => {
            const html = widgetImage.buildShareCardHtml({
                title: '<script>alert(1)</script>',
                subtitle: '副标题',
                footer: '主群 · 2026-11-09 21:30',
                widgetPng: Buffer.from(PNG_1PX, 'base64'),
                textExcerpt: '不应出现的正文',
            });
            expect(html.includes('width:1200px') && html.includes('height:630px'), 'the card is 1200×630');
            expect(html.includes('data:image/png;base64,'), 'the widget snapshot is inlined');
            expect(!html.includes('不应出现的正文'), 'the widget wins over the excerpt');
            expect(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'the title is escaped');
            expect(!html.includes('<script>alert(1)</script>'), 'no raw script');
        },
    },
    {
        name: 'the card template falls back to the image, then the text',
        body: async () => {
            const withImage = widgetImage.buildShareCardHtml({
                title: 't',
                imagePng: Buffer.from(PNG_1PX, 'base64'),
                textExcerpt: '正文摘录',
            });
            expect(withImage.includes('data:image/png;base64,'), 'the image is inlined');
            expect(!withImage.includes('正文摘录'), 'the excerpt loses to the image');
            const textOnly = widgetImage.buildShareCardHtml({ title: 't', textExcerpt: '正文摘录' });
            expect(textOnly.includes('正文摘录'), 'the excerpt shows when nothing else does');
        },
    },
    {
        name: 'renderShareCard and renderPreviewImage are null without the renderer',
        body: async () => {
            const rendered = await widgetImage.renderShareCard({ title: 't', textExcerpt: 'x' });
            expect(rendered === null, 'no renderer, no card');
            expect(await previewCard.renderPreviewImage(snapshotOf()) === null, 'no preview image');
        },
    },
    {
        name: 'a stored preview card is read back and not re-rendered',
        body: async () => {
            const messageId = takeMessageId();
            await makeReply(messageId, [
                { versionId: 1, createdAt: '2026-11-09T12:00:00.000Z', messageIds: [1], currentMessageId: 1, text: 'x', wasStoppedByUser: false },
            ]);
            const created = await service.createUserShare({
                kind: 'reply',
                chatId: CHAT_ID,
                firstMessageId: messageId,
                createdBy: CREATOR.userId,
            });
            expect(created.ok, 'created');
            if (!created.ok) return;
            expect(created.share.previewWidth === null, 'no card yet');
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
        name: 'the system share degrades to no card when rendering is off',
        body: async () => {
            const messageId = takeMessageId();
            await makeReply(messageId, [
                { versionId: 1, createdAt: '2026-11-09T12:00:00.000Z', messageIds: [1], currentMessageId: 1, text: 'x', wasStoppedByUser: false },
            ]);
            const share = await service.ensureSystemReplyShare({
                chatId: CHAT_ID,
                firstMessageId: messageId,
                versionId: 1,
                preview: { widgetHtml: '<div>w</div>', widgetImageBase64: PNG_1PX, chatTitle: '主群' },
            });
            expect(share !== null, 'the link still exists');
            expect(share?.previewWidth === null, 'no preview card');
            expect(await service.ensurePreviewImage(share?.token ?? '') === false, 'ensure reports the failure');
        },
    },
    {
        name: 'the reply content carries the snapshot the card needs',
        body: async () => {
            const messageId = takeMessageId();
            await makeReply(messageId, [
                {
                    versionId: 1,
                    createdAt: '2026-11-09T12:00:00.000Z',
                    messageIds: [1],
                    currentMessageId: 1,
                    text: '带图的回复',
                    wasStoppedByUser: false,
                    imageBase64: PNG_1PX,
                },
            ]);
            const loaded = await content.loadReplyShareContent(CHAT_ID, messageId, null);
            expect(loaded?.preview.imageBase64 === PNG_1PX, 'the image bytes reach the snapshot');
            expect(previewCard.previewSourceOf(loaded?.preview ?? snapshotOf()) === 'image', 'source image');
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) results.push(await runCase(testCase.name, testCase.body));
reportResults(results);
