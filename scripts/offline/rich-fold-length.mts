/**
 * Offline cases for the rich-body fold-length counter (`rich-body-length.ts`):
 * it predicts the "显示更多" fold Telegram applies to a rich message before the
 * body is sent, over two budgets measured on Bot API 10.4 — rendered text of
 * 8192 UTF-16 units and a serialized payload of ~16 KiB.
 *
 * The cases pin the rendered-text counting of the block dialect (markers,
 * fences, table pipes, link URLs, media ids and HTML tags are syntax, not
 * text), the exact bot-built `{text, entities}` blocks, the serialized formula
 * with its owner thresholds, the measured boundaries plus the intentional
 * conservative margin, and the failure paths (empty and broken snapshots).
 *
 * Follow-up cases guard the real `toRichMarkdown` dialect with a hand-counted
 * snapshot, measure the L2 media note the delivery appends, and pin the
 * counter's known deviations (inline math, bare media blocks) with comments.
 *
 * Run: npx tsx scripts/offline/rich-fold-length.mts
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import {
    combineRichBodyLengths,
    EMPTY_RICH_BODY_LENGTH,
    estimateAnswerMarkdown,
    estimateRenderedMessage,
    estimateRichBody,
    foldWouldTrigger,
    plainTextOfHtml,
    type RichBodyLength,
} from '../../src/telegram/formatters/rich-body-length.js';
import { RICH_FOLD_MAX_BYTES, RICH_FOLD_MAX_UNITS } from '../../src/telegram/formatters/message-budget.js';
import type { RichAnswerHtmlMedia } from '../../src/telegram/formatters/rich-answer-html.js';
import { toRichMarkdown, type RenderedMessage } from 'telegram-md-entities';

/** Measured 2026-11-16 on Bot API 10.4: rendered text > 8192 units is folded */
const MEASURED_UNIT_LIMIT = 8_192;
/** Measured at the same time: the serialized payload budget is ~16 KiB */
const MEASURED_BYTE_LIMIT = 16_384;

/** A picture block's media object: the id the snapshot references, no caption */
const INLINE_PICTURE: readonly RichAnswerHtmlMedia[] = [{ id: 'img1', placement: 'inline' }];
/** The same picture with a stored caption, which wins over the block title */
const INLINE_PICTURE_WITH_CAPTION: readonly RichAnswerHtmlMedia[] = [
    { id: 'img1', placement: 'inline', caption: 'stored caption' },
];

const utf8BytesOf = (text: string): number => Buffer.byteLength(text, 'utf8');

/** The module's serialized-payload formula, restated so a drift fails a test */
const serializedFormulaOf = (length: RichBodyLength): number =>
    length.utf8Bytes +
    length.linkUrlBytes +
    16 * length.blockCount +
    8 * length.entityCount +
    512 * length.mediaCount;

/** Field-by-field equality: JSON.stringify would depend on the key order */
const sameLength = (left: RichBodyLength, right: RichBodyLength): boolean =>
    left.units === right.units &&
    left.utf8Bytes === right.utf8Bytes &&
    left.blockCount === right.blockCount &&
    left.entityCount === right.entityCount &&
    left.linkUrlBytes === right.linkUrlBytes &&
    left.mediaCount === right.mediaCount &&
    left.serializedBytes === right.serializedBytes &&
    left.degraded === right.degraded;

/** One bot-built block: the `{text, entities}` before `toRichHtml` */
const messageOf = (text: string, entities: RenderedMessage['entities'] = []): RenderedMessage => ({ text, entities });

/** A length with chosen fields, for the fold decision on exact thresholds */
const lengthWith = (overrides: Partial<RichBodyLength>): RichBodyLength => ({
    ...EMPTY_RICH_BODY_LENGTH,
    ...overrides,
});

const cases: { name: string; body: () => void }[] = [
    {
        name: 'heading: the marker is syntax, the text is one block',
        body: () => {
            const length = estimateAnswerMarkdown('# Title');
            expect(length.units === 5, `rendered text is "Title" (got ${length.units})`);
            expect(length.utf8Bytes === 5, 'ASCII text is one UTF-8 byte per unit');
            expect(length.blockCount === 1, 'the heading is one block');
            expect(length.entityCount === 0, 'the marker alone adds no entity');
            expect(length.serializedBytes === 21, `5 text bytes plus the 16-byte block overhead (got ${length.serializedBytes})`);
        },
    },
    {
        name: 'heading: CJK text counts three UTF-8 bytes per character',
        body: () => {
            const length = estimateAnswerMarkdown('## Section 标题');
            expect(length.units === 10, `"Section 标题" is 10 UTF-16 units (got ${length.units})`);
            expect(length.utf8Bytes === 14, `8 ASCII + 2 CJK * 3 bytes = 14 (got ${length.utf8Bytes})`);
            expect(length.blockCount === 1, 'still one block');
        },
    },
    {
        name: 'paragraph: plain text counts its characters as one block',
        body: () => {
            const length = estimateAnswerMarkdown('hello world');
            expect(length.units === 11, `eleven characters (got ${length.units})`);
            expect(length.utf8Bytes === 11, 'ASCII one byte per unit');
            expect(length.blockCount === 1, 'one paragraph, one block');
            expect(length.serializedBytes === 27, `11 + 16 (got ${length.serializedBytes})`);
        },
    },
    {
        name: 'list: bullets are syntax and every item is a block',
        body: () => {
            const length = estimateAnswerMarkdown('- one\n- two\n- three');
            expect(length.units === 11, `"one" + "two" + "three" = 11 (got ${length.units})`);
            expect(length.blockCount === 4, `the list plus three items (got ${length.blockCount})`);
            expect(length.entityCount === 0, 'bullets add no entity');
        },
    },
    {
        name: 'list: nesting depth costs no text',
        body: () => {
            const nested = estimateAnswerMarkdown('- parent\n  - child');
            const flat = estimateAnswerMarkdown('- parent\n- child');
            expect(nested.units === flat.units, `the indentation is not text (${nested.units} vs ${flat.units})`);
            expect(nested.units === 11, `"parent" + "child" = 11 (got ${nested.units})`);
            expect(nested.blockCount === 3, `one list plus two items (got ${nested.blockCount})`);
        },
    },
    {
        name: 'list: a task checkbox is a flag, not text',
        body: () => {
            const length = estimateAnswerMarkdown('- [x] done\n- [ ] todo');
            expect(length.units === 8, `only "done" + "todo" = 8 (got ${length.units})`);
            expect(length.blockCount === 3, `one list plus two items (got ${length.blockCount})`);
        },
    },
    {
        name: 'list: ordered markers are syntax like bullets',
        body: () => {
            const length = estimateAnswerMarkdown('1. one\n2. two');
            expect(length.units === 6, `"one" + "two" = 6 (got ${length.units})`);
            expect(length.blockCount === 3, `one list plus two items (got ${length.blockCount})`);
        },
    },
    {
        name: 'table: only the cells count, the separator row is syntax',
        body: () => {
            const length = estimateAnswerMarkdown('| a | b |\n|---|---|\n| 1 | 2 |');
            expect(length.units === 4, `four one-character cells (got ${length.units})`);
            expect(length.blockCount === 3, `the table plus the header row and one body row (got ${length.blockCount})`);
            expect(length.serializedBytes === 52, `4 + 3 * 16 (got ${length.serializedBytes})`);
        },
    },
    {
        name: 'fence: the info string and the fence lines are syntax',
        body: () => {
            const length = estimateAnswerMarkdown('```ts\nconst x = 1;\n```');
            expect(length.units === 'const x = 1;'.length, `only the code content counts (got ${length.units})`);
            expect(length.utf8Bytes === 12, 'the content bytes');
            expect(length.blockCount === 1, 'one code block');
            expect(length.entityCount === 0, 'the language name adds no entity');
        },
    },
    {
        name: 'quote: the prefix is syntax and the inner blocks recurse',
        body: () => {
            const length = estimateAnswerMarkdown('> quote text\n>\n> - item a\n> - item b');
            expect(length.units === 22, `10 + 6 + 6 rendered characters (got ${length.units})`);
            // the quote, its paragraph, its list and the list's two items
            expect(length.blockCount === 5, `the quote and its four inner blocks (got ${length.blockCount})`);
        },
    },
    {
        name: 'divider: no text, but it is still a block',
        body: () => {
            const length = estimateAnswerMarkdown('---');
            expect(length.units === 0, 'nothing is rendered as text');
            expect(length.utf8Bytes === 0, 'no text bytes either');
            expect(length.blockCount === 1, `the divider is one block (got ${length.blockCount})`);
            expect(length.serializedBytes === 16, `the block overhead alone (got ${length.serializedBytes})`);
        },
    },
    {
        name: 'inline markup: tags and code spans count only their content',
        body: () => {
            const length = estimateAnswerMarkdown('<b>bold</b> <tg-spoiler>hush</tg-spoiler> <u>under</u> `code`');
            expect(length.units === 20, `"bold hush under code" = 20 (got ${length.units})`);
            expect(length.blockCount === 1, 'one paragraph');
            // three HTML open tags plus one code span: the tags are markup, not text
            expect(length.entityCount === 4, `three tags and one code span (got ${length.entityCount})`);
        },
    },
    {
        name: 'marked delimiters: == is syntax, the wrapped text counts',
        body: () => {
            expect(estimateAnswerMarkdown('==marked==').units === 6, 'the delimiters are not rendered');
            expect(estimateAnswerMarkdown('==two words==').units === 9, 'the wrapped words are');
        },
    },
    {
        name: 'plain text helper: tags, breaks, entities and astral characters',
        body: () => {
            expect(
                plainTextOfHtml('<strong>bold</strong><br>line &amp; more') === 'bold\nline & more',
                'tags are structure, <br> is a newline, &amp; is one character'
            );
            expect(plainTextOfHtml('==marked==') === 'marked', 'the == delimiters are stripped');
            expect(plainTextOfHtml('😀').length === 2, 'an astral character is two UTF-16 units');
            expect(plainTextOfHtml('<b>open') === 'open', 'an unterminated tag is dropped, not thrown');
        },
    },
    {
        name: 'link: the label counts, the URL only as link payload',
        body: () => {
            const url = 'https://example.com/path';
            const length = estimateAnswerMarkdown(`[label](${url})`);
            expect(length.units === 5, `the label alone is rendered text (got ${length.units})`);
            expect(length.entityCount === 1, 'one link entity');
            expect(length.linkUrlBytes === utf8BytesOf(url), `the URL is payload, not text (got ${length.linkUrlBytes})`);
            expect(length.serializedBytes === 53, `5 text + 24 URL + 16 block + 8 entity (got ${length.serializedBytes})`);
        },
    },
    {
        name: '#N anchor: three text units, its URL bytes in the link payload',
        body: () => {
            // toRichMarkdown writes a context reference as a display-only <a href>
            const url = 'https://t.me/c/1415974153/1100123';
            const length = estimateAnswerMarkdown(`<a href="${url}">#12</a>`);
            expect(length.units === 3, `"#12" is three units (got ${length.units})`);
            expect(length.entityCount === 1, 'one link entity');
            expect(length.linkUrlBytes === 33, `the URL bytes go to the payload (got ${length.linkUrlBytes})`);
            expect(length.serializedBytes === 60, `3 + 33 + 16 + 8 (got ${length.serializedBytes})`);
        },
    },
    {
        name: 'media block: caption text counts and the picture is one media object',
        body: () => {
            const length = estimateAnswerMarkdown('![](tg://photo?id=img1 "cap")', INLINE_PICTURE);
            expect(length.units === 3, `the block title is the caption (got ${length.units})`);
            expect(length.utf8Bytes === 3, 'the caption bytes');
            expect(length.blockCount === 1, 'the picture is one block');
            expect(length.mediaCount === 1, 'one serialized media object');
            expect(length.serializedBytes === serializedFormulaOf(length), 'the serialized formula holds');
        },
    },
    {
        name: 'media block: without the media list only its caption text remains',
        body: () => {
            const length = estimateAnswerMarkdown('![](tg://photo?id=img1 "cap")');
            expect(length.units === 3, `the caption-only fallback keeps the text (got ${length.units})`);
            expect(length.blockCount === 1, 'one plain block');
            expect(length.mediaCount === 0, 'no picture was attached, so no media object');
            // a caption-only fallback is one plain block, which the module reports as degraded
            expect(length.degraded === true, 'reported degraded (the estimate stays an upper bound)');
        },
    },
    {
        name: 'media block: a stored caption replaces the block title',
        body: () => {
            const length = estimateAnswerMarkdown('![](tg://photo?id=img1 "cap")', INLINE_PICTURE_WITH_CAPTION);
            expect(length.units === 14, `"stored caption" = 14, not the block title (got ${length.units})`);
            expect(length.blockCount === 1, 'the picture is one block');
            expect(length.mediaCount === 1, 'one serialized media object');
        },
    },
    {
        name: 'media block: an unresolved picture without a caption renders nothing',
        body: () => {
            const length = estimateAnswerMarkdown('![](tg://photo?id=missing)');
            expect(length.units === 0, 'no blocks, no text');
            expect(length.blockCount === 0, 'the caption-less fallback is dropped entirely');
            expect(length.mediaCount === 0, 'and no media object is sent');
            expect(length.degraded === false, 'a successfully parsed body is not degraded');
        },
    },
    {
        name: 'real dialect: a toRichMarkdown snapshot counts the text a reader sees',
        body: () => {
            // The stored answer section is a toRichMarkdown output, not the model's
            // markdown: the package's own HTML tags, its table form and a literal
            // ==mark== reach the counter. The hand count is of the rendered text:
            // heading 2 + paragraph 29 + items 6 + cells 10 = 47 units.
            const modelMarkdown = [
                '## 概览',
                '',
                '**要点**：先看 [文档](https://example.com/doc)，再跑 `pnpm test`，并留意 ==高亮==。',
                '',
                '- 第一项',
                '- 第二项',
                '',
                '| 名称 | 数值 |',
                '|---|---|',
                '| alpha | 1 |',
            ].join('\n');
            const length = estimateAnswerMarkdown(toRichMarkdown(modelMarkdown));
            expect(length.units === 47, `the rendered text is 47 units (got ${length.units})`);
            expect(length.degraded === false, 'a real snapshot parses block by block, not as one literal block');
            expect(
                length.blockCount === 8,
                `heading, paragraph, list plus 2 items, table plus 2 rows (got ${length.blockCount})`
            );
            // The entity scan sees the bold tag, the markdown link and the code span
            expect(length.entityCount === 3, `three inline entities (got ${length.entityCount})`);
            expect(length.linkUrlBytes === utf8BytesOf('https://example.com/doc'), 'the link URL rides in the payload');
        },
    },
    {
        name: 'L2 media note: the bot-built <p><i> block counts its rendered text',
        body: () => {
            // The L2 fallback body ends with mediaNoteBlock(),
            // toRichHtml(italicText(...)): a bot-built HTML block inside the answer
            // snapshot. Blocks are joined by a blank line, so the block-level <p>
            // is unwrapped and <i> parses as markup: the tag characters do not count
            // as text, the units are exactly answer plus note.
            const note = '（另有 2 张图未能内嵌发送）';
            const length = estimateAnswerMarkdown(`答案\n\n<p><i>${note}</i></p>`);
            expect(length.units === '答案'.length + note.length, `the two texts only (got ${length.units})`);
            expect(length.units === 17, `2 + 15 units (got ${length.units})`);
            expect(length.blockCount === 2, `the answer and the note are blocks of their own (got ${length.blockCount})`);
            expect(length.degraded === false, 'the parser reads it as blocks, not as a fallback');
            // The markdown-level entity scan still charges the <i> open tag as one
            // formatting entity: this block's small conservative overcount (+8 B).
            expect(length.entityCount === 1, `the scan charges the <i> tag (got ${length.entityCount})`);
            expect(length.serializedBytes === 45 + 16 * 2 + 8, `payload with the 8-byte overcount (got ${length.serializedBytes})`);
            // Only when the note is not a block of its own (no blank line before it)
            // does the <p> wrapper stay in the line and the <i> tags count as text:
            // 2 + 15 + 7 = 24 units. joinRichBlocks always gives it its own block.
            const notUnwrapped = estimateAnswerMarkdown(`答案<p><i>${note}</i></p>`);
            expect(notUnwrapped.units === 24, `tag characters as text in that variant (got ${notUnwrapped.units})`);
        },
    },
    {
        name: 'bot block: text is exact in UTF-16 units and UTF-8 bytes',
        body: () => {
            const length = estimateRenderedMessage(messageOf('你好, world'));
            expect(length.units === 9, `2 CJK + 7 ASCII units (got ${length.units})`);
            expect(length.utf8Bytes === 13, `6 + 7 bytes (got ${length.utf8Bytes})`);
            expect(length.blockCount === 1, 'one paragraph');
            expect(length.serializedBytes === 29, `13 + 16 (got ${length.serializedBytes})`);
        },
    },
    {
        name: 'bot block: a block entity adds one block',
        body: () => {
            const length = estimateRenderedMessage(
                messageOf('quote block', [{ type: 'blockquote', offset: 0, length: 11 }])
            );
            expect(length.units === 11, 'the text has no blank line, so the entity is what makes it a block');
            expect(length.blockCount === 2, `one block entity plus one paragraph (got ${length.blockCount})`);
            expect(length.entityCount === 1, 'the blockquote entity rides in the payload');
            expect(length.serializedBytes === 51, `11 + 16 * 2 + 8 (got ${length.serializedBytes})`);
        },
    },
    {
        name: 'bot block: text_link URL bytes ride in the payload',
        body: () => {
            const url = 'https://example.com/x';
            const length = estimateRenderedMessage(
                messageOf('click here', [{ type: 'text_link', offset: 0, length: 5, url }])
            );
            expect(length.units === 10, `the whole text is rendered (got ${length.units})`);
            expect(length.entityCount === 1, 'one link entity');
            expect(length.linkUrlBytes === utf8BytesOf(url), `the URL bytes are payload (got ${length.linkUrlBytes})`);
            expect(length.serializedBytes === 55, `10 + 21 + 16 + 8 (got ${length.serializedBytes})`);
        },
    },
    {
        name: 'bot block: blank lines separate paragraphs',
        body: () => {
            const twoParagraphs = estimateRenderedMessage(messageOf('a\n\nb'));
            expect(twoParagraphs.blockCount === 2, `the blank line makes two blocks (got ${twoParagraphs.blockCount})`);
            expect(twoParagraphs.units === 4, 'the line break itself counts as a unit');
            expect(estimateRenderedMessage(messageOf('a\nb')).blockCount === 1, 'a single newline stays one block');
            const threeParagraphs = estimateRenderedMessage(messageOf('a\n\nb\n\nc'));
            expect(threeParagraphs.blockCount === 3, `two blank lines make three blocks (got ${threeParagraphs.blockCount})`);
        },
    },
    {
        name: 'combine: two blocks add the blank line between them',
        body: () => {
            const combined = combineRichBodyLengths([estimateAnswerMarkdown('alpha'), estimateAnswerMarkdown('beta')]);
            expect(combined.units === 5 + 4 + 2, `the texts plus the two-unit blank line (got ${combined.units})`);
            expect(combined.utf8Bytes === 5 + 4 + 2, 'the blank line is text bytes too');
            expect(combined.blockCount === 2, 'both blocks are kept');
            expect(combined.serializedBytes === 11 + 2 * 16, `11 text bytes plus both blocks (got ${combined.serializedBytes})`);
            const three = combineRichBodyLengths([
                estimateAnswerMarkdown('alpha'),
                estimateAnswerMarkdown('beta'),
                estimateAnswerMarkdown('gamma'),
            ]);
            expect(three.units === 5 + 4 + 5 + 2 * 2, `two boundaries add four units (got ${three.units})`);
        },
    },
    {
        name: 'combine: one part is unchanged and no parts is the empty body',
        body: () => {
            const part = estimateAnswerMarkdown('alpha');
            expect(sameLength(combineRichBodyLengths([part]), part), 'a single part adds no separator');
            expect(sameLength(combineRichBodyLengths([]), EMPTY_RICH_BODY_LENGTH), 'nothing is the empty body');
        },
    },
    {
        name: 'estimateRichBody: sections and messages add up like the joined body',
        body: () => {
            const sections = ['hello', '# Heading'];
            const messages = [messageOf('world')];
            const body = estimateRichBody({ markdownSections: sections, messages });
            const expected = combineRichBodyLengths([
                estimateAnswerMarkdown('hello'),
                estimateAnswerMarkdown('# Heading'),
                estimateRenderedMessage(messageOf('world')),
            ]);
            expect(sameLength(body, expected), 'the body length is the combine of its sources');
            expect(body.units === 5 + 7 + 5 + 2 * 2, `the texts plus two blank lines (got ${body.units})`);
            expect(body.blockCount === 3, 'three blocks');
            expect(body.serializedBytes === 69, `21 text bytes plus three blocks (got ${body.serializedBytes})`);
            const withPicture = estimateRichBody({
                markdownSections: ['![](tg://photo?id=img1 "cap")'],
                media: INLINE_PICTURE,
                messages: [undefined],
            });
            expect(withPicture.mediaCount === 1, 'the section maps its picture onto a media object');
            expect(withPicture.blockCount === 1, 'an undefined source is left out');
        },
    },
    {
        name: 'serialized bytes: text plus link URLs, blocks, entities and media',
        body: () => {
            const length = estimateAnswerMarkdown(
                '[label](https://example.com/path)\n\n![](tg://photo?id=img1 "cap")',
                INLINE_PICTURE
            );
            expect(length.units === 8, `5 label units plus the 3-unit caption (got ${length.units})`);
            expect(length.blockCount === 2, 'a paragraph and a picture block');
            expect(length.entityCount === 1, 'one link entity');
            expect(length.linkUrlBytes === 24, 'the URL bytes');
            expect(length.mediaCount === 1, 'one media object');
            expect(
                length.serializedBytes === 8 + 24 + 2 * 16 + 1 * 8 + 1 * 512,
                `every component of the formula (got ${length.serializedBytes})`
            );
        },
    },
    {
        name: 'fold: rendered text over the units budget folds',
        body: () => {
            const atLimit = estimateAnswerMarkdown('x'.repeat(RICH_FOLD_MAX_UNITS));
            const overLimit = estimateAnswerMarkdown('x'.repeat(RICH_FOLD_MAX_UNITS + 1));
            expect(atLimit.units === RICH_FOLD_MAX_UNITS, `the limit itself (got ${atLimit.units})`);
            expect(atLimit.serializedBytes <= RICH_FOLD_MAX_BYTES, 'the bytes budget is not what decides here');
            expect(!foldWouldTrigger(atLimit), 'exactly at the units budget does not fold (strict >)');
            expect(overLimit.units === RICH_FOLD_MAX_UNITS + 1, 'one unit over the budget');
            expect(foldWouldTrigger(overLimit), 'the text trigger folds it');
        },
    },
    {
        name: 'fold: a serialized payload over the bytes budget folds',
        body: () => {
            // 3 UTF-8 bytes per CJK character, 16 bytes of block overhead
            const below = estimateAnswerMarkdown('字'.repeat(4_994));
            const over = estimateAnswerMarkdown('字'.repeat(4_995));
            expect(below.units <= RICH_FOLD_MAX_UNITS, 'the text stays under the units budget');
            expect(below.serializedBytes === 14_998, `under the bytes budget (got ${below.serializedBytes})`);
            expect(!foldWouldTrigger(below), 'so it does not fold');
            expect(over.units <= RICH_FOLD_MAX_UNITS, 'the text is still under the units budget');
            expect(over.serializedBytes === 15_001, `one byte over the bytes budget (got ${over.serializedBytes})`);
            expect(foldWouldTrigger(over), 'the payload trigger folds it');
        },
    },
    {
        name: 'fold: below both budgets does not fold',
        body: () => {
            const length = estimateAnswerMarkdown('x'.repeat(100));
            expect(length.units === 100, 'the text units are small');
            expect(length.serializedBytes === 116, 'so is the payload');
            expect(!foldWouldTrigger(length), 'nothing folds');
        },
    },
    {
        name: 'fold limits: strict thresholds with margin under the measured limits',
        body: () => {
            expect(RICH_FOLD_MAX_UNITS === 7_680, `the owner units threshold (got ${RICH_FOLD_MAX_UNITS})`);
            expect(RICH_FOLD_MAX_BYTES === 15_000, `the owner bytes threshold (got ${RICH_FOLD_MAX_BYTES})`);
            expect(!foldWouldTrigger(lengthWith({ units: RICH_FOLD_MAX_UNITS })), 'units exactly at the limit do not fold');
            expect(foldWouldTrigger(lengthWith({ units: RICH_FOLD_MAX_UNITS + 1 })), 'one unit over folds');
            expect(
                !foldWouldTrigger(lengthWith({ serializedBytes: RICH_FOLD_MAX_BYTES })),
                'bytes exactly at the limit do not fold'
            );
            expect(foldWouldTrigger(lengthWith({ serializedBytes: RICH_FOLD_MAX_BYTES + 1 })), 'one byte over folds');
            // ~6% and ~8.5% headroom: over-predicting only costs the thinking link,
            // under-predicting leaves body text below the fold
            expect(
                MEASURED_UNIT_LIMIT > RICH_FOLD_MAX_UNITS && MEASURED_BYTE_LIMIT > RICH_FOLD_MAX_BYTES,
                'the decision limits sit below the measured server limits'
            );
        },
    },
    {
        name: 'measured boundary: 8192 rendered units, 8193 folds on the server',
        body: () => {
            const atLimit = estimateAnswerMarkdown('x'.repeat(MEASURED_UNIT_LIMIT));
            expect(atLimit.units === MEASURED_UNIT_LIMIT, `the measured unit count (got ${atLimit.units})`);
            expect(atLimit.utf8Bytes === MEASURED_UNIT_LIMIT, 'one UTF-8 byte per ASCII unit');
            expect(atLimit.serializedBytes === MEASURED_UNIT_LIMIT + 16, 'the block overhead on top');
            const overLimit = estimateAnswerMarkdown('x'.repeat(MEASURED_UNIT_LIMIT + 1));
            expect(overLimit.units === MEASURED_UNIT_LIMIT + 1, 'one unit more, and the server folds it');
        },
    },
    {
        name: 'measured boundary: 5,455 CJK characters are 16,365 UTF-8 bytes',
        body: () => {
            const atLimit = estimateAnswerMarkdown('字'.repeat(5_455));
            expect(atLimit.units === 5_455, `one UTF-16 unit each (got ${atLimit.units})`);
            expect(atLimit.utf8Bytes === 16_365, `3 bytes each (got ${atLimit.utf8Bytes})`);
            expect(atLimit.serializedBytes === 16_381, `plus the block overhead (got ${atLimit.serializedBytes})`);
            const overLimit = estimateAnswerMarkdown('字'.repeat(5_456));
            expect(overLimit.utf8Bytes === 16_368, `one more character crosses 16 KiB of text (got ${overLimit.utf8Bytes})`);
            expect(overLimit.serializedBytes === 16_384, `at the measured payload budget (got ${overLimit.serializedBytes})`);
        },
    },
    {
        name: 'conservative margin folds before the measured server boundaries',
        body: () => {
            // Measured: the server still delivered 8,000 units and 16,365 bytes unfolded.
            const measuredSafe = estimateAnswerMarkdown('x'.repeat(8_000));
            expect(measuredSafe.units === 8_000, 'the measured-safe text');
            expect(8_000 < MEASURED_UNIT_LIMIT, 'below the measured server boundary');
            expect(foldWouldTrigger(measuredSafe), 'the decision margin already folds it');
            const atBudget = estimateAnswerMarkdown('x'.repeat(RICH_FOLD_MAX_UNITS));
            const overBudget = estimateAnswerMarkdown('x'.repeat(RICH_FOLD_MAX_UNITS + 1));
            expect(!foldWouldTrigger(atBudget), '7,680 units do not fold');
            expect(foldWouldTrigger(overBudget), '7,681 do');
        },
    },
    {
        name: 'known deviation: inline math counts its $ delimiters as text',
        body: () => {
            // telegram-md-entities has no math node, so the inline renderer keeps the
            // $ delimiters as text: the counter reports 5 units where Telegram renders
            // a 3-unit formula (x^2). Pinned, not corrected: 2 units are negligible
            // against the fold margin.
            const length = estimateAnswerMarkdown('$x^2$');
            expect(length.units === 5, `the source, delimiters included (got ${length.units})`);
            expect(length.blockCount === 1, 'still one paragraph');
            expect(length.degraded === false, 'the paragraph parser read it fine');
        },
    },
    {
        name: 'known deviation: a bare media block adds no link entity',
        body: () => {
            // The media URL is a tg://photo reference, not a text_link: the scanner
            // skips it, so a caption-less, unresolved picture block costs nothing at
            // all (it renders no block either).
            const bare = estimateAnswerMarkdown('![](tg://photo?id=img1)');
            expect(sameLength(bare, EMPTY_RICH_BODY_LENGTH), 'the whole length is the empty body');
            expect(bare.linkUrlBytes === 0, `no URL payload (got ${bare.linkUrlBytes})`);
            expect(bare.entityCount === 0, `no link entity (got ${bare.entityCount})`);
            // With a media object it is one block plus the 512-byte media overhead,
            // still no link entity.
            const attached = estimateAnswerMarkdown('![](tg://photo?id=img1)', INLINE_PICTURE);
            expect(attached.mediaCount === 1 && attached.blockCount === 1, 'the picture is a block and a media object');
            expect(attached.entityCount === 0 && attached.linkUrlBytes === 0, 'and still no link entity');
            expect(attached.serializedBytes === 16 + 512, `block plus media overhead (got ${attached.serializedBytes})`);
        },
    },
    {
        name: 'empty snapshots are the empty body',
        body: () => {
            expect(sameLength(estimateAnswerMarkdown(''), EMPTY_RICH_BODY_LENGTH), 'the empty snapshot');
            expect(sameLength(estimateAnswerMarkdown('   \n\t'), EMPTY_RICH_BODY_LENGTH), 'a whitespace-only snapshot');
            expect(EMPTY_RICH_BODY_LENGTH.serializedBytes === 0, 'nothing costs nothing');
            expect(!foldWouldTrigger(EMPTY_RICH_BODY_LENGTH), 'and it never folds');
        },
    },
    {
        name: 'a broken snapshot never throws and still yields a block',
        body: () => {
            const unclosedFence = estimateAnswerMarkdown('前文\n\n```\n未闭合的围栏');
            expect(unclosedFence.blockCount === 2, `the paragraph and the open code block (got ${unclosedFence.blockCount})`);
            expect(unclosedFence.units === 8, `both texts are counted (got ${unclosedFence.units})`);
            expect(unclosedFence.degraded === false, 'the parser produced blocks, so the estimate is not degraded');
            const loneFence = estimateAnswerMarkdown('```');
            expect(loneFence.blockCount === 1, 'a lone fence opener is one empty code block');
            expect(loneFence.units === 0, 'with no content');
        },
    },
    {
        name: 'estimateRichBody({}) is the empty body',
        body: () => {
            expect(sameLength(estimateRichBody({}), EMPTY_RICH_BODY_LENGTH), 'no sources, no length');
            expect(sameLength(estimateRichBody({ messages: [undefined] }), EMPTY_RICH_BODY_LENGTH), 'an undefined source is skipped');
            expect(
                sameLength(estimateRichBody({ markdownSections: [''] }), EMPTY_RICH_BODY_LENGTH),
                'an empty section adds nothing'
            );
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) results.push(await runCase(testCase.name, testCase.body));
reportResults(results);
