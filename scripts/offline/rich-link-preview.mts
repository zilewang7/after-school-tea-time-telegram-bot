/**
 * A rich message has no web preview: luoxu's /preview answers 'none' for it.
 * Link previews are cached by URL, so asking for one from a rich message
 * would store 'none' for every URL it carries (a button's included), and a
 * text message posting the same URL later would never get its preview. A
 * rich message's OCR run would likewise overwrite the preview's OCR text of
 * such a URL with nothing.
 *
 * luoxu is a local stub that knows which messages have a preview and what
 * their images say. No network.
 */
import type { RichBlock, Update, User } from 'grammy/types';
import { expect, reportResults, runCase, setupOfflineDb, takeMessageId, type CaseResult } from './harness.mts';
import { createFakeBot, groupChat, quietly, waitUntil } from './fake-telegram.mts';
import { startStubServer } from './support/stub-server.mts';

interface OcrItem {
    readonly which: string;
    readonly label: string;
    readonly text: string;
}

/** What luoxu was asked, as "<path> <message id>" */
const asked: string[] = [];
/** The messages luoxu has a web preview for, with its title */
const previewTitles = new Map<number, string>();
/** What luoxu recognizes in a message's images */
const ocrItems = new Map<number, readonly OcrItem[]>();

const luoxu = await startStubServer();
luoxu.handle((request, response) => {
    const url = new URL(request.url ?? '/', 'http://stub');
    const messageId = Number(url.searchParams.get('id'));
    asked.push(`${url.pathname} ${messageId}`);
    const title = previewTitles.get(messageId);
    const body = url.pathname === '/ocr'
        ? { status: 'ok', items: ocrItems.get(messageId) ?? [] }
        : title === undefined
          ? { status: 'none' }
          : { status: 'ready', site_name: 'example.com', title, media: [] };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
});

// Read at import by the preview and OCR services and by autoSave
process.env.LUOXU_PREVIEW_URL = luoxu.url;
process.env.LUOXU_OCR_URL = luoxu.url;
process.env.BOT_USER_NAME = 'AfterSchoolTeatimeBot';
process.env.BOT_USER_ID = '7777';
delete process.env.ALLOWED_CHAT_IDS;

await setupOfflineDb();
const { autoSave, autoUpdate } = await import('../../src/db/autoSave.js');
const { getMessage } = await import('../../src/db/index.js');
const { LinkPreviewCache } = await import('../../src/db/linkPreviewCacheDTO.js');
const { getLinkPreviewParts } = await import('../../src/services/luoxu-preview-service.js');
const { isAsyncFileSavePending, isAsyncOcrPending, isAsyncPreviewPending } = await import('../../src/state.js');

/** A supergroup, so luoxu can address it */
const CHAT_ID = -1007800000003;
const CHAT = groupChat(CHAT_ID);
const FROM: User = { id: 111, is_bot: false, first_name: '测试用户' };

let nextUpdateId = 1;
/** Every message is newer than the one before, as on Telegram */
let sentAt = 1_800_000_000;

const textUpdate = (messageId: number, text: string): Update => ({
    update_id: (nextUpdateId += 1),
    message: { message_id: messageId, date: (sentAt += 10), chat: CHAT, from: FROM, text },
});

const richUpdate = (messageId: number, blocks: RichBlock[]): Update => ({
    update_id: (nextUpdateId += 1),
    message: { message_id: messageId, date: (sentAt += 10), chat: CHAT, from: FROM, rich_message: { blocks } },
});

/** The message edited into a rich message */
const richEditUpdate = (messageId: number, sentDate: number, blocks: RichBlock[]): Update => ({
    update_id: (nextUpdateId += 1),
    edited_message: {
        message_id: messageId,
        date: sentDate,
        edit_date: (sentAt += 10),
        chat: CHAT,
        from: FROM,
        rich_message: { blocks },
    },
});

const buttonRow = (url: string): RichBlock => ({ type: 'buttons', buttons: [{ text: '打开', url }] });

const { bot } = createFakeBot();
autoSave(bot);
autoUpdate(bot);

/** Feed an update and wait until its file, preview and OCR work is done */
const ingest = async (update: Update, messageId: number) => {
    await quietly(async () => {
        await bot.handleUpdate(update);
        await waitUntil(
            `the work on message ${messageId} to end`,
            () =>
                !isAsyncFileSavePending(CHAT_ID, messageId) &&
                !isAsyncPreviewPending(CHAT_ID, messageId) &&
                !isAsyncOcrPending(CHAT_ID, messageId)
        );
    });
    return getMessage(CHAT_ID, messageId);
};

const askedAbout = (messageId: number): string[] => asked.filter((entry) => entry.endsWith(` ${messageId}`));

const previewTextOf = async (text: string | null | undefined): Promise<string> =>
    (await getLinkPreviewParts(text))
        .map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
        .join('\n');

const results: CaseResult[] = [];

results.push(
    await runCase('a button url of a rich message asks for no preview; a text message with that url still gets one', async () => {
        const url = 'https://example.com/release';
        const richId = takeMessageId();
        const rich = await ingest(richUpdate(richId, [{ type: 'paragraph', text: '新版本发布' }, buttonRow(url)]), richId);
        expect((rich?.text ?? '').includes(`[打开](${url})`), `the button url is in the stored text (${rich?.text})`);
        expect(!askedAbout(richId).includes(`/preview ${richId}`), `luoxu is not asked for its preview (asked ${JSON.stringify(askedAbout(richId))})`);
        expect((await LinkPreviewCache.findByPk(url)) === null, 'nothing is cached for the url');

        const textId = takeMessageId();
        previewTitles.set(textId, '发布说明');
        const text = await ingest(textUpdate(textId, `新版本：${url}`), textId);
        expect(askedAbout(textId).includes(`/preview ${textId}`), `the text message's preview is fetched (asked ${JSON.stringify(askedAbout(textId))})`);
        const preview = await previewTextOf(text?.text);
        expect(preview.includes('标题: 发布说明'), `and reaches the model (${JSON.stringify(preview)})`);
    })
);

results.push(
    await runCase('an edit into a rich message with a button url asks for no preview either', async () => {
        const url = 'https://example.com/edited';
        const messageId = takeMessageId();
        const first = textUpdate(messageId, '先发一条纯文本');
        const firstDate = first.message?.date ?? sentAt;
        await ingest(first, messageId);
        const edited = await ingest(richEditUpdate(messageId, firstDate, [{ type: 'paragraph', text: '改成了富文本' }, buttonRow(url)]), messageId);
        expect((edited?.text ?? '').includes(`[打开](${url})`), `the edit is stored with the button url (${edited?.text})`);
        expect(askedAbout(messageId).length === 0, `luoxu is asked nothing (asked ${JSON.stringify(askedAbout(messageId))})`);
        expect((await LinkPreviewCache.findByPk(url)) === null, 'nothing is cached for the url');
    })
);

results.push(
    await runCase('a rich message with a photo keeps the preview ocr text of a url it links', async () => {
        const url = 'https://example.com/screenshot';
        const textId = takeMessageId();
        previewTitles.set(textId, '截图页');
        ocrItems.set(textId, [{ which: 'photo', label: '预览图', text: '预览图里的字' }]);
        await ingest(textUpdate(textId, `看图 ${url}`), textId);
        const before = await LinkPreviewCache.findByPk(url);
        expect(before?.status === 'ready' && before.ocrText === '预览图里的字', `the preview and its ocr text are cached (${before?.status}, ${before?.ocrText})`);

        const richId = takeMessageId();
        ocrItems.set(richId, [{ which: 'rich_photo_0', label: '图片', text: '消息里的图' }]);
        const rich = await ingest(richUpdate(richId, [
            { type: 'photo', photo: [{ file_id: 'FAKE_RICH_PHOTO', file_unique_id: 'FAKE_RICH_PHOTO_U', width: 800, height: 600, file_size: 4096 }] },
            buttonRow(url),
        ]), richId);
        expect(rich?.ocrText === '消息里的图', `the rich message's own photo is still recognized (${rich?.ocrText})`);
        const after = await LinkPreviewCache.findByPk(url);
        expect(after?.ocrText === '预览图里的字', `the preview keeps its ocr text (${after?.ocrText})`);
    })
);

await luoxu.close();
reportResults(results);
