/**
 * A reply's quote as stored (the quoteText column), through a new message and
 * through an edit. Bot API 10.4: a quote chosen from a rich message may come
 * with empty text and its content in rich_texts, one entry per quoted text (a
 * paragraph, a table cell, a caption...). grammy 1.46 does not declare that
 * field yet, so those quotes are built with JSON.parse.
 */
import type { Message, TextQuote, Update } from 'grammy/types';
import { expect, reportResults, runCase, setupOfflineDb, takeMessageId, type CaseResult } from './harness.mts';
import { createFakeBot, quietly } from './fake-telegram.mts';

// Read per call by autoSave; set before the first src import
process.env.BOT_USER_NAME = 'AfterSchoolTeatimeBot';
process.env.BOT_USER_ID = '7777';
delete process.env.ALLOWED_CHAT_IDS;

await setupOfflineDb();
const { autoSave, autoUpdate } = await import('../../src/db/autoSave.js');
const { getMessage } = await import('../../src/db/index.js');
const { richTextPlainText } = await import('../../src/db/rich-plain-text.js');
const { renderQuoteRichTexts } = await import('../../src/db/rich-message-text.js');

const CHAT_ID = -1007800000002;
const SENT_AT = 1_800_000_000;
const CHAT: Message['chat'] = { id: CHAT_ID, type: 'supergroup', title: '测试群' };
const FROM: Message['from'] = { id: 111, is_bot: false, first_name: '测试用户' };
/** The message the quotes are taken from */
const QUOTED: NonNullable<Message['reply_to_message']> = {
    message_id: takeMessageId(),
    date: SENT_AT - 60,
    chat: CHAT,
    reply_to_message: undefined,
};
let nextUpdateId = 1;

const { bot } = createFakeBot();
autoSave(bot);
autoUpdate(bot);

const replyUpdate = (messageId: number, quote: TextQuote): Update => ({
    update_id: (nextUpdateId += 1),
    message: {
        message_id: messageId,
        date: SENT_AT,
        chat: CHAT,
        from: FROM,
        text: '回复',
        reply_to_message: QUOTED,
        quote,
    },
});

const editedReplyUpdate = (messageId: number, quote: TextQuote): Update => ({
    update_id: (nextUpdateId += 1),
    edited_message: {
        message_id: messageId,
        date: SENT_AT,
        edit_date: SENT_AT + 60,
        chat: CHAT,
        from: FROM,
        text: '改过的回复',
        reply_to_message: QUOTED,
        quote,
    },
});

/** The quoteText stored after the bot handled the update */
const storedQuoteOf = async (incoming: Update, messageId: number): Promise<string | null | undefined> => {
    await quietly(() => bot.handleUpdate(incoming));
    return (await getMessage(CHAT_ID, messageId))?.quoteText;
};

const RICH_TEXTS_JSON = '[["选中的 ",{"type":"bold","text":"加粗"}," 和 ",{"type":"url","text":"链接","url":"https://example.com/a"}]]';
const RICH_QUOTE_MARKDOWN = '选中的 **加粗** 和 [链接](https://example.com/a)';

const results: CaseResult[] = [];

results.push(
    await runCase('a quote with text is stored as before, rich_texts or not', async () => {
        const plainId = takeMessageId();
        const plain = await storedQuoteOf(replyUpdate(plainId, {
            text: '原文的一段',
            entities: [{ type: 'bold', offset: 0, length: 2 }],
            position: 0,
        }), plainId);
        expect(plain === '**原文**的一段', `the text keeps its entities as markdown (${plain})`);

        const bothId = takeMessageId();
        const both = await storedQuoteOf(
            replyUpdate(bothId, JSON.parse(`{"text":"原文的一段","position":0,"rich_texts":${RICH_TEXTS_JSON}}`)),
            bothId
        );
        expect(both === '原文的一段', `the text wins over rich_texts (${both})`);
    })
);

results.push(
    await runCase('a quote chosen from a rich message is stored as its markdown', async () => {
        const emptyTextId = takeMessageId();
        const fromEmptyText = await storedQuoteOf(
            replyUpdate(emptyTextId, JSON.parse(`{"text":"","position":0,"rich_texts":${RICH_TEXTS_JSON}}`)),
            emptyTextId
        );
        expect(fromEmptyText === RICH_QUOTE_MARKDOWN, `empty text: rich_texts become markdown (${fromEmptyText})`);

        const noTextId = takeMessageId();
        const fromNoText = await storedQuoteOf(
            replyUpdate(noTextId, JSON.parse(`{"position":0,"rich_texts":${RICH_TEXTS_JSON}}`)),
            noTextId
        );
        expect(fromNoText === RICH_QUOTE_MARKDOWN, `no text at all: the same (${fromNoText})`);
    })
);

/** A quote across two paragraphs: one RichText per quoted text, then one that holds no text */
const TWO_PARAGRAPHS_JSON = '[["第一段的", {"type":"bold","text":"结尾"}], "第二段的开头", {"type":"anchor","name":"a"}]';

results.push(
    await runCase('every entry of rich_texts is a quoted text of its own, on a line of its own', async () => {
        const messageId = takeMessageId();
        const stored = await storedQuoteOf(
            replyUpdate(messageId, JSON.parse(`{"text":"","position":0,"rich_texts":${TWO_PARAGRAPHS_JSON}}`)),
            messageId
        );
        expect(stored === '第一段的**结尾**\n第二段的开头', `a line per paragraph, none for the empty entry (${JSON.stringify(stored)})`);

        const throwingRenderer = (): string => {
            throw new TypeError("Cannot read properties of undefined (reading 'type')");
        };
        const plain = await quietly(async () =>
            renderQuoteRichTexts(JSON.parse(`{"text":"","position":0,"rich_texts":${TWO_PARAGRAPHS_JSON}}`), `${CHAT_ID}/1`, throwingRenderer)
        );
        expect(plain === '第一段的结尾\n第二段的开头', `the plain text fallback keeps the lines (${JSON.stringify(plain)})`);
    })
);

results.push(
    await runCase('an edit stores a quote chosen from a rich message the same way', async () => {
        const messageId = takeMessageId();
        const before = await storedQuoteOf(replyUpdate(messageId, { text: '旧的引用', position: 0 }), messageId);
        expect(before === '旧的引用', `the reply is stored with its first quote (${before})`);
        const after = await storedQuoteOf(
            editedReplyUpdate(messageId, JSON.parse(`{"text":"","position":0,"rich_texts":${RICH_TEXTS_JSON}}`)),
            messageId
        );
        expect(after === RICH_QUOTE_MARKDOWN, `the edit stores the rich quote as markdown (${after})`);
    })
);

results.push(
    await runCase('an empty quote with no rich text stays empty', async () => {
        const withoutId = takeMessageId();
        const without = await storedQuoteOf(replyUpdate(withoutId, { text: '', position: 0 }), withoutId);
        expect(without === '', `no rich_texts: empty as before (${JSON.stringify(without)})`);

        const textlessId = takeMessageId();
        const textless = await storedQuoteOf(
            replyUpdate(textlessId, JSON.parse('{"text":"","position":0,"rich_texts":[{"type":"anchor","name":"a"}]}')),
            textlessId
        );
        expect(textless === '', `rich_texts without any text: empty too (${JSON.stringify(textless)})`);
    })
);

results.push(
    await runCase('the plain text of one entry of rich_texts keeps every visible string', () => {
        const plain = richTextPlainText(JSON.parse(`[
            ["选中的 ", {"type": "bold", "text": "加粗"}],
            {"type": "custom_emoji", "custom_emoji_id": "emoji-id", "alternative_text": "👍"},
            {"type": "url", "text": " 链接", "url": "https://example.com/a"},
            {"type": "future_inline", "payload": "not text"}
        ]`));
        expect(plain === '选中的 加粗👍 链接', `inline pieces join without separators, ids and urls left out (${plain})`);
    })
);

reportResults(results);
