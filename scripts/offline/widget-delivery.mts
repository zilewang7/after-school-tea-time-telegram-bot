/**
 * Offline cases for widget delivery: the private-chat / group decision, the
 * Mini App link fallback message, and what the reply stores for each shape.
 *
 * Telegram accepts widgets only in private chats, so a group gets one text
 * message (caption + Mini App link) previewing the reply's share page. The
 * decision and the message are pure functions; the storage cases drive the real
 * reply pipeline against a fake Telegram Api and the scratch database.
 *
 * Run: npx tsx scripts/offline/widget-delivery.mts
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Api, GrammyError, type Transformer } from 'grammy';
import type { Update } from 'grammy/types';
import {
    expect,
    reportResults,
    runCase,
    setupOfflineDb,
    takeMessageId,
    type CaseResult,
} from './harness.mts';
import {
    contextOf,
    createFakeTelegram,
    endOpenReplies,
    messageUpdate,
    quietly,
    trackReply,
} from './fake-telegram.mts';
import type { AIResponse } from '../../src/ai/types.js';
import type { StoredWidget } from '../../src/db/botResponseDTO.js';

// The group link fallback needs both switches on; the renderer and Bot API
// roots are pointed at the local stub below.
process.env.WIDGET_GROUP_FALLBACK = '1';
process.env.WIDGET_ENABLE = '1';
process.env.SHARE_ENABLED = '1';
process.env.BOT_USER_ID = '7777';
for (const key of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'GROK_API_KEY', 'MIMO_API_KEY']) {
    process.env[key] ||= 'offline-placeholder';
}

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : {};

// A local stand-in for two containers at once: the Bot API (refuses sendWidget
// the way a server with the group gate does) and the render sidecar (answers
// /render with a real PNG). Its port becomes both roots before the config is
// read, so the delivery path talks to the real clients.
const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlZkAAAAASUVORK5CYII=',
    'base64'
);
const widgetRequests: string[] = [];
/** Simulates the preview render (600px at 2x) failing while the 600px card render still works */
let failWideRender = false;
const stubServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
        const url = request.url ?? '';
        widgetRequests.push(url);
        if (url.startsWith('/render')) {
            if (failWideRender && url.includes('scale=2')) {
                response.writeHead(500, { 'Content-Type': 'text/plain' });
                response.end('render failed');
                return;
            }
            response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG_BYTES.length });
            response.end(PNG_BYTES);
            return;
        }
        if (url === '/healthz') {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ ok: true, chromium: 'offline-stub', uptimeMs: 1000 }));
            return;
        }
        if (url.includes('/sendWidget')) {
            const body = asRecord(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
            if (body.chat_id === NATIVE_CHAT_ID) {
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(
                    JSON.stringify({
                        ok: true,
                        result: {
                            message_id: 777_001,
                            date: 0,
                            chat: { id: NATIVE_CHAT_ID, type: 'private', first_name: 'Owner' },
                        },
                    })
                );
                return;
            }
        }
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(
            JSON.stringify({
                ok: false,
                error_code: 400,
                description: 'Bad Request: INPUT_MEDIA_WIDGET_NOT_ALLOWED',
            })
        );
    });
});
await new Promise<void>((ready) => stubServer.listen(0, '127.0.0.1', ready));
const stubRoot = `http://127.0.0.1:${(stubServer.address() as AddressInfo).port}`;
process.env.WIDGET_API_ROOT = stubRoot;
process.env.WIDGET_RENDER_URL = stubRoot;

const db = await setupOfflineDb();
const responseHandler = await import('../../src/reply/response-handler.js');
const botMessageService = await import('../../src/services/bot-message-service.js');
const shareService = await import('../../src/panel/share/share-link-service.js');
const dbIndex = await import('../../src/db/index.js');
const { Message } = await import('../../src/db/messageDTO.js');
const { widgetDeliveryOf } = await import('../../src/telegram/widget-precheck.js');
const { readToolConfig } = await import('../../src/config/tool-config.js');
const { resolveToolAvailability } = await import('../../src/reply/tools/tool-availability.js');
const {
    WIDGET_LINK_LABEL,
    buildWidgetLinkMessage,
    isWidgetNotAllowedError,
    miniAppReplyLink,
    resolveWidgetDelivery,
    widgetMiniAppLink,
} = await import('../../src/reply/widget-link-fallback.js');
const { buildImageCaption } = await import('../../src/reply/tools/image-message.js');
const { sendReplyWidgetLinkMessage } = await import('../../src/telegram/reply-widget-send.js');
const { isErr } = await import('../../src/shared/result.js');

// ---------------------------------------------------------------------------
// Fixtures and small helpers
// ---------------------------------------------------------------------------

const GROUP_CHAT_ID = -1009999999997;
const PRIVATE_CHAT_ID = 603421700;
/** A private chat the Bot API stub accepts a widget for */
const NATIVE_CHAT_ID = 603421701;
const OWNER_USER_ID = 603421700;

const PNG_BASE64 = PNG_BYTES.toString('base64');

const card = (caption?: string) =>
    widgetDeliveryOf('a2ui', '<div class="tw-root">今日日报</div>', caption, { components: [] });

const entitiesOf = (payload: { readonly entities?: unknown }): Record<string, unknown>[] =>
    Array.isArray(payload.entities) ? payload.entities.map(asRecord) : [];

const rowOf = (chatId: number, messageId: number) => Message.findOne({ where: { chatId, messageId } });

/** A private-chat trigger, which fake-telegram's group helper does not build */
const privateUpdate = (chatId: number, messageId: number, userId: number, text: string): Update => ({
    update_id: messageId,
    message: {
        message_id: messageId,
        date: 0,
        chat: { id: chatId, type: 'private', first_name: 'Owner' },
        from: { id: userId, is_bot: false, first_name: 'Owner' },
        text,
    },
});

const startReply = async (chatId: number) => {
    const telegram = createFakeTelegram();
    const userMessageId = takeMessageId();
    const ctx = contextOf(
        messageUpdate({ chatId, messageId: userMessageId, userId: OWNER_USER_ID, text: '来张卡片' }),
        telegram
    );
    const chatContext = await quietly(() =>
        responseHandler.createChatContext(ctx, { model: 'gemini-4-argon' })
    );
    if (!chatContext) throw new Error('the chat context was not created');
    trackReply(chatContext);
    return { telegram, chatContext, userMessageId };
};

/** A stored reply with the given versions; the last one is current unless told otherwise */
const seedResponse = async (options: {
    chatId: number;
    firstMessageId: number;
    userMessageId: number;
    versions: Array<Record<string, unknown>>;
    currentVersionIndex?: number;
}): Promise<void> => {
    const versions = options.versions.map((version, index) => ({
        versionId: index + 1,
        createdAt: new Date().toISOString(),
        messageIds: [options.firstMessageId],
        currentMessageId: options.firstMessageId,
        text: '',
        wasStoppedByUser: false,
        ...version,
    }));
    await dbIndex.BotResponse.create({
        messageId: options.firstMessageId,
        chatId: options.chatId,
        userMessageId: options.userMessageId,
        versions: JSON.stringify(versions),
        currentVersionIndex: options.currentVersionIndex ?? versions.length - 1,
        buttonState: dbIndex.ButtonState.HAS_VERSIONS,
        metadata: JSON.stringify({ model: 'gemini-4-argon', hasImage: true, hasWidget: true }),
    });
};

const results: CaseResult[] = [];

// ---------------------------------------------------------------------------
// The delivery decision (pure)
// ---------------------------------------------------------------------------

results.push(
    await runCase('a private chat takes the native widget, a group the Mini App link', async () => {
        const privatePlan = resolveWidgetDelivery({
            chatType: 'private',
            groupFallback: true,
            shareEnabled: true,
            renderOk: true,
            shareOk: false,
        });
        expect(privatePlan.kind === 'widget', 'a private chat sends the widget itself');
        expect(privatePlan.keepImage, 'a rendered card image is kept');

        const groupPlan = resolveWidgetDelivery({
            chatType: 'supergroup',
            groupFallback: true,
            shareEnabled: true,
            renderOk: true,
            shareOk: true,
        });
        expect(groupPlan.kind === 'link', 'a group gets the Mini App link fallback');
        expect(groupPlan.withPreview, 'the link previews the share page');
        expect(groupPlan.keepImage, 'the rendered card image is kept for the group too');
    })
);

results.push(
    await runCase('a group without the fallback switches gets nothing', async () => {
        const noFallback = resolveWidgetDelivery({
            chatType: 'group',
            groupFallback: false,
            shareEnabled: true,
            renderOk: true,
            shareOk: true,
        });
        expect(noFallback.kind === 'none', 'WIDGET_GROUP_FALLBACK=0 keeps groups off');

        const noShare = resolveWidgetDelivery({
            chatType: 'group',
            groupFallback: true,
            shareEnabled: false,
            renderOk: true,
            shareOk: true,
        });
        expect(noShare.kind === 'none', 'the fallback needs the share pages');

        const unknownChat = resolveWidgetDelivery({
            chatType: undefined,
            groupFallback: true,
            shareEnabled: true,
            renderOk: true,
            shareOk: true,
        });
        expect(unknownChat.kind === 'none', 'an unknown chat kind sends nothing');
    })
);

results.push(
    await runCase('a renderer failure drops the image, never the card', async () => {
        const plan = resolveWidgetDelivery({
            chatType: 'private',
            groupFallback: false,
            shareEnabled: true,
            renderOk: false,
            shareOk: false,
        });
        expect(plan.kind === 'widget', 'the widget still goes out');
        expect(!plan.keepImage, 'no image is stored when rendering failed');
    })
);

results.push(
    await runCase('a server refusal turns a private chat into the link fallback', async () => {
        const plan = resolveWidgetDelivery({
            chatType: 'private',
            groupFallback: true,
            shareEnabled: true,
            renderOk: true,
            shareOk: true,
            serverRejected: true,
        });
        expect(plan.kind === 'link', 'INPUT_MEDIA_WIDGET_NOT_ALLOWED downgrades to a link');

        const closed = resolveWidgetDelivery({
            chatType: 'private',
            groupFallback: false,
            shareEnabled: true,
            renderOk: true,
            shareOk: true,
            serverRejected: true,
        });
        expect(closed.kind === 'none', 'without the fallback switches the card is dropped');
    })
);

// ---------------------------------------------------------------------------
// The link message (pure)
// ---------------------------------------------------------------------------

results.push(
    await runCase('the Mini App link opens this reply', async () => {
        const link = miniAppReplyLink({
            botUsername: 'AfterSchoolTeatimeBot',
            shortName: 'panel',
            chatId: -1001415974153,
            firstMessageId: 1234,
        });
        expect(
            link === 'https://t.me/AfterSchoolTeatimeBot/panel?startapp=r-1001415974153_1234',
            `the negative chat id and message id are the start parameter (got ${link})`
        );
    })
);

results.push(
    await runCase('a link message prefers the public share and falls back to the reply', async () => {
        const base = {
            botUsername: 'AfterSchoolTeatimeBot',
            shortName: 'panel',
            chatId: -1001415974153,
            firstMessageId: 1234,
        };
        const shared = widgetMiniAppLink({ ...base, shareToken: 'AbCdEfGhIjKlMnOpQrStUvWx' });
        expect(
            shared === 'https://t.me/AfterSchoolTeatimeBot/panel?startapp=sAbCdEfGhIjKlMnOpQrStUvWx',
            `the share page is what non-members can open (got ${shared})`
        );
        const withoutShare = widgetMiniAppLink({ ...base, shareToken: null });
        expect(
            withoutShare === 'https://t.me/AfterSchoolTeatimeBot/panel?startapp=r-1001415974153_1234',
            `without a share page the reply deep link is used (got ${withoutShare})`
        );
    })
);

results.push(
    await runCase('the link message is the caption itself, or one short line', async () => {
        const miniAppLink = 'https://t.me/bot/panel?startapp=r-100_7';
        const plain = buildWidgetLinkMessage({ miniAppLink, replyToMessageId: 7 });
        expect(plain.text === WIDGET_LINK_LABEL, 'without a caption only the link line goes out');
        const plainLink = entitiesOf(plain).find((entity) => entity.type === 'text_link');
        expect(
            plainLink?.offset === 0 &&
                plainLink.length === WIDGET_LINK_LABEL.length &&
                plainLink.url === miniAppLink,
            'the text_link covers the whole label'
        );
        expect(plain.replyParameters?.message_id === 7, 'the message replies to the trigger');
        expect(plain.linkPreviewOptions === undefined, 'no widget render, no forced preview');

        const captionFields = buildImageCaption('**今日**日报');
        const captioned = buildWidgetLinkMessage({
            caption: captionFields,
            previewUrl: 'https://miniapp.example/s/tok/preview',
            miniAppLink,
        });
        expect(captioned.text === '今日日报', `the caption is the whole message (got ${JSON.stringify(captioned.text)})`);
        const captionEntities = entitiesOf(captioned).filter((entity) => entity.type !== 'text_link');
        expect(
            captionEntities.some(
                (entity) => entity.type === 'bold' && entity.offset === 0 && entity.length === '今日'.length
            ),
            'the caption keeps its own formatting at the same offsets'
        );
        const captionLink = entitiesOf(captioned).find((entity) => entity.type === 'text_link');
        expect(
            captionLink?.offset === 0 &&
                captionLink.length === captioned.text.length &&
                captionLink.url === miniAppLink,
            `the text_link covers the whole caption (got ${JSON.stringify(captionLink)})`
        );
        expect(
            captioned.linkPreviewOptions?.url === 'https://miniapp.example/s/tok/preview' &&
                captioned.linkPreviewOptions.prefer_large_media === true &&
                captioned.linkPreviewOptions.show_above_text === true,
            'the widget render is previewed as a large card above the text'
        );

        const blocky = buildWidgetLinkMessage({
            caption: {
                caption: '引用\n代码',
                caption_entities: [
                    { type: 'blockquote', offset: 0, length: 2 },
                    { type: 'pre', offset: 3, length: 2 },
                    { type: 'italic', offset: 0, length: 2 },
                ],
            },
            miniAppLink,
        });
        const blockyTypes = entitiesOf(blocky)
            .map((entity) => entity.type)
            .sort();
        expect(
            blockyTypes.join(',') === 'italic,text_link',
            `a whole-text link drops the entities it would shadow (got ${blockyTypes.join(',')})`
        );
    })
);

results.push(
    await runCase('only the server chat-type refusal triggers the fallback', async () => {
        const refusal = new GrammyError(
            "Call to 'sendWidget' failed!",
            {
                ok: false,
                error_code: 400,
                description: 'Bad Request: INPUT_MEDIA_WIDGET_NOT_ALLOWED',
            },
            'sendWidget',
            {}
        );
        expect(isWidgetNotAllowedError(refusal), 'the 400 is recognized');
        expect(
            !isWidgetNotAllowedError(new Error('Bad Request: chat not found')),
            'other errors are not treated as a chat-type refusal'
        );
    })
);

// ---------------------------------------------------------------------------
// Delivery and storage through the real reply pipeline
// ---------------------------------------------------------------------------

results.push(
    await runCase('a group reply sends one text message and stores the link delivery', async () => {
        const { telegram, chatContext, userMessageId } = await startReply(GROUP_CHAT_ID);
        const widget = card('今日日报');
        const response: AIResponse = {
            text: '卡片来了',
            thinkingText: '',
            images: [],
            widgets: [widget],
        };
        chatContext.session.textBuffer = response.text;
        await quietly(() => responseHandler.sendFinalResponse(chatContext, response));

        const linkCall = telegram.callsOf('sendMessage').at(-1);
        if (!linkCall) throw new Error('no text message went out');
        const payload = linkCall.payload;
        expect(
            payload.text === '今日日报',
            `the caption is the whole message, no extra link line (got ${JSON.stringify(payload.text)})`
        );
        expect(
            asRecord(payload.reply_parameters).message_id === userMessageId,
            'the link message replies to the trigger'
        );

        expect(
            widgetRequests.some((url) => url.startsWith('/render?width=600&scale=1')),
            'the 600px card was rendered before delivery'
        );
        expect(
            widgetRequests.some((url) => url.startsWith('/render?width=600&scale=2')),
            'the share preview is the same layout at 2x'
        );

        const stored = await dbIndex.getBotResponse(GROUP_CHAT_ID, chatContext.session.firstMessageId);
        const version = stored?.getVersions().at(-1);
        expect(version?.widget?.deliveredAs === 'link', 'the version records the link delivery');
        expect(version?.widget?.imageBase64 === PNG_BASE64, 'the rendered card is stored on the version');
        const shareUrl = version?.widget?.shareUrl;
        expect(shareUrl !== undefined, 'the reply share page was created for the link');
        const shareToken = shareUrl === undefined ? null : shareUrl.split('/').at(-1);
        const linkEntity = entitiesOf(payload).find((entity) => entity.type === 'text_link');
        expect(
            linkEntity?.url === `https://t.me/AfterSchoolTeatimeBot/panel?startapp=s${shareToken}`,
            `the text_link opens the public share in the Mini App (got ${JSON.stringify(linkEntity)})`
        );
        expect(
            linkEntity?.offset === 0 && typeof payload.text === 'string' && linkEntity.length === payload.text.length,
            'the text_link covers the whole caption'
        );
        expect(
            asRecord(payload.link_preview_options).url === `${shareUrl}/preview`,
            `the preview points at the widget render (got ${JSON.stringify(payload.link_preview_options)})`
        );

        const row = await rowOf(GROUP_CHAT_ID, chatContext.session.firstMessageId);
        expect(
            row?.file?.equals(PNG_BYTES) === true && row.fileMime === 'image/png',
            'the bot row carries the rendered card PNG'
        );
        expect(row?.mediaHint === 'a widget', 'the row still says the attachment is a widget');
    })
);

results.push(
    await runCase('a link message without a widget render has no forced preview', async () => {
        failWideRender = true;
        try {
            const { telegram, chatContext } = await startReply(GROUP_CHAT_ID);
            // A document no other case rendered, so the renderer cache cannot help
            const widget = widgetDeliveryOf('a2ui', '<div class="tw-root">无法预览的卡片</div>', '无法预览的卡片', {
                components: [],
            });
            const response: AIResponse = {
                text: '卡片来了',
                thinkingText: '',
                images: [],
                widgets: [widget],
            };
            chatContext.session.textBuffer = response.text;
            await quietly(() => responseHandler.sendFinalResponse(chatContext, response));

            const linkCall = telegram.callsOf('sendMessage').at(-1);
            if (!linkCall) throw new Error('no text message went out');
            const payload = linkCall.payload;
            expect(payload.text === '无法预览的卡片', 'the caption still goes out');
            expect(
                payload.link_preview_options === undefined,
                `no share preview, no forced preview (got ${JSON.stringify(payload.link_preview_options)})`
            );
            const stored = await dbIndex.getBotResponse(GROUP_CHAT_ID, chatContext.session.firstMessageId);
            const version = stored?.getVersions().at(-1);
            expect(version?.widget?.shareUrl !== undefined, 'the share page itself still exists');
            const shareToken = version?.widget?.shareUrl?.split('/').at(-1) ?? null;
            const linkEntity = entitiesOf(payload).find((entity) => entity.type === 'text_link');
            expect(
                linkEntity?.url === `https://t.me/AfterSchoolTeatimeBot/panel?startapp=s${shareToken}`,
                'the link still opens the share page'
            );
        } finally {
            failWideRender = false;
        }
    })
);

results.push(
    await runCase('a native widget version stores how it was delivered', async () => {
        const { chatContext } = await startReply(PRIVATE_CHAT_ID);
        const widget = card('私有卡片');
        chatContext.session.widget = widget;
        chatContext.session.widgetMessageId = 424242;
        chatContext.session.widgetImageBase64 = PNG_BASE64;
        chatContext.session.widgetDeliveredAs = 'widget';
        await quietly(() => chatContext.session.finalize());

        const stored = await dbIndex.getBotResponse(PRIVATE_CHAT_ID, chatContext.session.firstMessageId);
        const version = stored?.getVersions().at(-1);
        expect(version?.widget?.deliveredAs === 'widget', 'the version records the native delivery');
        expect(version?.widget?.imageBase64 === PNG_BASE64, 'the card image is stored');
        expect(version?.widget?.messageId === 424242, 'the widget message id is stored');

        const row = await rowOf(PRIVATE_CHAT_ID, chatContext.session.firstMessageId);
        expect(
            row?.file?.equals(PNG_BYTES) === true && row.fileMime === 'image/png' && row.mediaHint === 'a widget',
            'the bot row carries the card image and its widget hint'
        );
    })
);

results.push(
    await runCase('switching to a link version re-sends the stored share link', async () => {
        const telegram = createFakeTelegram();
        const firstMessageId = takeMessageId();
        const userMessageId = takeMessageId();
        const linkWidget = (caption: string): StoredWidget => ({
            mode: 'a2ui',
            html: `<div class="tw-root">${caption}</div>`,
            caption,
            htmlBytes: 40,
            zlibBytes: 20,
            imageBase64: PNG_BASE64,
            deliveredAs: 'link',
        });
        await seedResponse({
            chatId: GROUP_CHAT_ID,
            firstMessageId,
            userMessageId,
            versions: [{ widget: linkWidget('第一版') }, { widget: linkWidget('第二版') }],
            currentVersionIndex: 0,
        });

        // The second version already has its share page (and widget render)
        const share = await shareService.ensureSystemReplyShare({
            chatId: GROUP_CHAT_ID,
            firstMessageId,
            versionId: 2,
        });
        if (share === null) throw new Error('the share page was not created');
        const seeded = await dbIndex.getBotResponse(GROUP_CHAT_ID, firstMessageId);
        if (seeded === null) throw new Error('the seeded response is gone');
        const versions = seeded.getVersions();
        const secondVersion = versions[1];
        if (secondVersion === undefined) throw new Error('the second version is gone');
        versions[1] = { ...secondVersion, widget: { ...linkWidget('第二版'), shareUrl: share.url } };
        seeded.setVersions(versions);
        await seeded.save();

        const ctx = contextOf(
            messageUpdate({ chatId: GROUP_CHAT_ID, messageId: userMessageId, userId: OWNER_USER_ID, text: '切换' }),
            telegram
        );
        const switched = await quietly(() =>
            botMessageService.switchVersion(ctx, firstMessageId, 'next')
        );
        expect(switched, 'the version switch succeeded');

        const linkCall = telegram.callsOf('sendMessage').at(-1);
        if (!linkCall) throw new Error('the link message was not sent again');
        expect(
            linkCall.payload.text === '第二版',
            `the new version's caption goes out alone (got ${JSON.stringify(linkCall.payload.text)})`
        );
        expect(
            asRecord(linkCall.payload.link_preview_options).url === `${share.url}/preview`,
            `the stored widget render is previewed as a large image (got ${JSON.stringify(linkCall.payload.link_preview_options)})`
        );
        const linkEntity = entitiesOf(linkCall.payload).find((entity) => entity.type === 'text_link');
        expect(
            linkEntity?.url === `https://t.me/AfterSchoolTeatimeBot/panel?startapp=s${share.token}`,
            'the link opens the stored share page in the Mini App'
        );
        expect(linkCall.payload.reply_markup !== undefined, 'the version buttons ride on the link message');

        const stored = await dbIndex.getBotResponse(GROUP_CHAT_ID, firstMessageId);
        expect(stored?.currentVersionIndex === 1, 'the response now shows the second version');
    })
);

results.push(
    await runCase('switching to a link version makes the share page it is missing', async () => {
        const telegram = createFakeTelegram();
        const firstMessageId = takeMessageId();
        const userMessageId = takeMessageId();
        const linkWidget = (caption: string): StoredWidget => ({
            mode: 'a2ui',
            html: `<div class="tw-root">${caption}</div>`,
            caption,
            htmlBytes: 40,
            zlibBytes: 20,
            imageBase64: PNG_BASE64,
            deliveredAs: 'link',
        });
        await seedResponse({
            chatId: GROUP_CHAT_ID,
            firstMessageId,
            userMessageId,
            versions: [{ widget: linkWidget('第一版') }, { widget: linkWidget('第二版') }],
            currentVersionIndex: 0,
        });

        const ctx = contextOf(
            messageUpdate({ chatId: GROUP_CHAT_ID, messageId: userMessageId, userId: OWNER_USER_ID, text: '切换' }),
            telegram
        );
        expect(await quietly(() => botMessageService.switchVersion(ctx, firstMessageId, 'next')), 'switched');

        const linkCall = telegram.callsOf('sendMessage').at(-1);
        if (!linkCall) throw new Error('the link message was not sent again');
        // No WEBAPP_PUBLIC_URL offline: the created share URL is the relative /s/<token>
        const previewUrl = asRecord(linkCall.payload.link_preview_options).url;
        const createdUrl = typeof previewUrl === 'string' ? previewUrl : '';
        // ".../s/<token>/preview"
        const shareToken = createdUrl.split('/').at(-2) ?? '';
        expect(
            /^[A-Za-z0-9_-]{24}$/.test(shareToken) && createdUrl.endsWith('/preview'),
            `a share page with its widget render was created (got ${JSON.stringify(previewUrl)})`
        );
        const linkEntity = entitiesOf(linkCall.payload).find((entity) => entity.type === 'text_link');
        expect(
            linkEntity?.url === `https://t.me/AfterSchoolTeatimeBot/panel?startapp=s${shareToken}`,
            'the link opens the created share page'
        );
    })
);

results.push(
    await runCase('a private chat sends the native widget and stores its image', async () => {
        const telegram = createFakeTelegram();
        const userMessageId = takeMessageId();
        const ctx = contextOf(
            privateUpdate(NATIVE_CHAT_ID, userMessageId, OWNER_USER_ID, '来张卡片'),
            telegram
        );
        const chatContext = await quietly(() =>
            responseHandler.createChatContext(ctx, { model: 'gemini-4-argon' })
        );
        if (!chatContext) throw new Error('the chat context was not created');
        trackReply(chatContext);
        const widget = card('私有卡片');
        const response: AIResponse = {
            text: '卡片来了',
            thinkingText: '',
            images: [],
            widgets: [widget],
        };
        chatContext.session.textBuffer = response.text;
        await quietly(() => responseHandler.sendFinalResponse(chatContext, response));

        const stored = await dbIndex.getBotResponse(NATIVE_CHAT_ID, chatContext.session.firstMessageId);
        const version = stored?.getVersions().at(-1);
        expect(version?.widget?.deliveredAs === 'widget', 'the version records the native delivery');
        expect(version?.widget?.messageId === 777_001, 'the widget message id is stored');
        expect(version?.widget?.imageBase64 === PNG_BASE64, 'the rendered card is stored');
        expect(
            !telegram.callsOf('sendMessage').some((call) => String(call.payload.text).includes(WIDGET_LINK_LABEL)),
            'no link message goes out when the widget itself was accepted'
        );
        const row = await rowOf(NATIVE_CHAT_ID, chatContext.session.firstMessageId);
        expect(
            row?.file?.equals(PNG_BYTES) === true && row.fileMime === 'image/png' && row.mediaHint === 'a widget',
            'the bot row carries the rendered card'
        );
    })
);

results.push(
    await runCase('a link message Telegram refuses with the preview goes out without it', async () => {
        const calls: Record<string, unknown>[] = [];
        const api = new Api('0:offline-token');
        const transformer = (_previous: unknown, method: string, payload: unknown) => {
            const fields = asRecord(payload);
            calls.push({ method, ...fields });
            if (method === 'sendMessage' && 'link_preview_options' in fields) {
                return Promise.reject(
                    new GrammyError(
                        "Call to 'sendMessage' failed!",
                        { ok: false, error_code: 400, description: 'Bad Request: wrong preview' },
                        'sendMessage',
                        fields
                    )
                );
            }
            return Promise.resolve({
                ok: true,
                result: { message_id: 9001, date: 0, chat: { id: 1, type: 'private', first_name: 'x' } },
            });
        };
        // The transformer is generic over every method: one cast at this boundary
        api.config.use(transformer as Transformer);

        const message = buildWidgetLinkMessage({
            previewUrl: 'https://miniapp.example/s/tok/preview',
            miniAppLink: 'https://t.me/bot/panel?startapp=r1_2',
        });
        const sent = await quietly(() => sendReplyWidgetLinkMessage({ chatId: 1, api, message }));
        expect(!isErr(sent) && sent[1] === 9001, 'the retry without the preview went out');
        expect(calls.length === 2, `exactly two attempts (got ${calls.length})`);
        const retry = calls[1];
        expect(retry !== undefined && !('link_preview_options' in retry), 'the retry carries no preview');
    })
);

results.push(
    await runCase('a server that refuses widgets makes a private chat take the link', async () => {
        const telegram = createFakeTelegram();
        const userMessageId = takeMessageId();
        const ctx = contextOf(
            privateUpdate(PRIVATE_CHAT_ID, userMessageId, OWNER_USER_ID, '来张卡片'),
            telegram
        );
        const chatContext = await quietly(() =>
            responseHandler.createChatContext(ctx, { model: 'gemini-4-argon' })
        );
        if (!chatContext) throw new Error('the chat context was not created');
        trackReply(chatContext);
        const widget = card('私聊卡片');
        const response: AIResponse = {
            text: '卡片来了',
            thinkingText: '',
            images: [],
            widgets: [widget],
        };
        chatContext.session.textBuffer = response.text;
        await quietly(() => responseHandler.sendFinalResponse(chatContext, response));

        expect(
            widgetRequests.some((url) => url.includes('/sendWidget')),
            'the native widget was tried first'
        );
        const linkCall = telegram.callsOf('sendMessage').at(-1);
        expect(
            linkCall?.payload.text === '私聊卡片',
            `the refusal downgraded to the caption itself (got ${JSON.stringify(linkCall?.payload.text)})`
        );
        const stored = await dbIndex.getBotResponse(PRIVATE_CHAT_ID, chatContext.session.firstMessageId);
        const version = stored?.getVersions().at(-1);
        expect(version?.widget?.deliveredAs === 'link', 'the version records the downgraded delivery');
        const shareUrl = version?.widget?.shareUrl;
        expect(shareUrl !== undefined, 'the share page was created for the link');
        const shareToken = shareUrl === undefined ? null : shareUrl.split('/').at(-1);
        expect(
            asRecord(linkCall?.payload.link_preview_options).url === `${shareUrl}/preview`,
            'the widget render previews the link'
        );
        const linkEntity = entitiesOf(linkCall?.payload ?? {}).find(
            (entity) => entity.type === 'text_link'
        );
        expect(
            linkEntity?.url === `https://t.me/AfterSchoolTeatimeBot/panel?startapp=s${shareToken}`,
            `the link opens the public share in the Mini App (got ${JSON.stringify(linkEntity)})`
        );
        expect(
            linkEntity?.offset === 0 && linkEntity.length === '私聊卡片'.length,
            'the text_link covers the whole caption'
        );
    })
);

// ---------------------------------------------------------------------------
// Tool availability
// ---------------------------------------------------------------------------

results.push(
    await runCase('a group gets send_widget only with both fallback switches on', async () => {
        const enabled = readToolConfig({
            WIDGET_ENABLE: '1',
            WIDGET_GROUP_FALLBACK: '1',
            SHARE_ENABLED: '1',
            WIDGET_CHAT_IDS: String(GROUP_CHAT_ID),
            TOOL_CHAT_IDS: String(GROUP_CHAT_ID),
            OWNER_USER_ID: String(OWNER_USER_ID),
        });
        const group = resolveToolAvailability('gemini-4-argon', GROUP_CHAT_ID, enabled);
        expect(group.widget && group.widgetGuide, 'the whitelisted group gets both widget tools');

        const noFallback = readToolConfig({
            WIDGET_ENABLE: '1',
            WIDGET_GROUP_FALLBACK: '0',
            SHARE_ENABLED: '1',
            WIDGET_CHAT_IDS: String(GROUP_CHAT_ID),
            TOOL_CHAT_IDS: String(GROUP_CHAT_ID),
            OWNER_USER_ID: String(OWNER_USER_ID),
        });
        expect(
            !resolveToolAvailability('gemini-4-argon', GROUP_CHAT_ID, noFallback).widget,
            'WIDGET_GROUP_FALLBACK=0 keeps groups off'
        );

        const noShare = readToolConfig({
            WIDGET_ENABLE: '1',
            WIDGET_GROUP_FALLBACK: '1',
            SHARE_ENABLED: '0',
            WIDGET_CHAT_IDS: String(GROUP_CHAT_ID),
            TOOL_CHAT_IDS: String(GROUP_CHAT_ID),
            OWNER_USER_ID: String(OWNER_USER_ID),
        });
        expect(
            !resolveToolAvailability('gemini-4-argon', GROUP_CHAT_ID, noShare).widget,
            'SHARE_ENABLED=0 keeps groups off (no preview landing spot)'
        );

        const privateChat = readToolConfig({
            WIDGET_ENABLE: '1',
            WIDGET_GROUP_FALLBACK: '0',
            SHARE_ENABLED: '1',
            WIDGET_CHAT_IDS: String(PRIVATE_CHAT_ID),
            TOOL_CHAT_IDS: String(PRIVATE_CHAT_ID),
            OWNER_USER_ID: String(PRIVATE_CHAT_ID),
        });
        expect(
            resolveToolAvailability('gemini-4-argon', PRIVATE_CHAT_ID, privateChat).widget,
            'a private chat is unchanged by the group switches'
        );
    })
);

stubServer.closeAllConnections();
await new Promise<void>((closed) => stubServer.close(() => closed()));

// Close the scratch database, or its connection keeps the process alive
const { sequelize } = await import('../../src/db/config.js');
await sequelize.close();
void db.Message;

// The stream leaves sockets/timers behind in this harness; reportResults ends the process regardless
endOpenReplies();
reportResults(results);
