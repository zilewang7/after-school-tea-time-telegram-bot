/**
 * Offline cases for the Mini App's rich-answer parser (v5.1 design
 * 2026-1115-2355 §三/§五): a rich reply's stored snapshot (`richAnswerMarkdown`)
 * is split into display blocks so its pictures sit where the model put them,
 * and the inline markdown is rendered through telegram-md-entities' own
 * `renderMarkdown`/`styleSegments` (the parser maintains no inline state
 * machine of its own).
 *
 * The fixtures are shaped like a real snapshot: headings, lists with depth,
 * inline bold/code/links, quotes with hard line breaks, a fenced code block, a
 * table, a divider, two inline picture blocks and a repeated picture id.
 *
 * Run: npx tsx scripts/offline/webapp-rich-answer.mts
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import type { MediaAttachment } from '../../webapp/src/api/types.ts';
import {
    inlineRuns,
    isSafeLinkUrl,
    parseRichAnswer,
    referencedMediaIndexes,
    unreferencedMediaIndexes,
    type RichAnswerBlock,
    type RichAnswerRun,
} from '../../webapp/src/rich/rich-answer.ts';

/** One attachment the panel hands the page (signed URL, optional v5.1 facts) */
const mediaItem = (index: number, overrides: Partial<MediaAttachment> = {}): MediaAttachment => ({
    kind: 'image',
    mimeType: 'image/jpeg',
    sizeBytes: 1000 + index,
    fileName: null,
    url: `/m/signed-media-${index}`,
    caption: null,
    placement: 'inline',
    id: null,
    ...overrides,
});

/** A real rich snapshot: the answer markdown with its media blocks in place */
const RICH_SNAPSHOT = [
    '### 图片的解释',
    '',
    '这是**粗体**、`行内代码`、[链接](https://example.com/a) 与 [¹](https://source.example/1)。',
    '',
    '- 第一项',
    '  - 子项 **强调**',
    '- 第二项',
    '',
    '1. 编号一',
    '2. 编号二',
    '',
    '> 引用第一行\\',
    '> 引用第二行',
    '',
    '```ts',
    'const answer = 42;',
    '```',
    '',
    '| 名称 | 值 |',
    '| --- | --- |',
    '| 图片 | 2 |',
    '',
    '---',
    '',
    '图片前的段落。',
    '',
    '![](tg://photo?id=img1 "第一张图注")',
    '',
    '两张图之间的段落。',
    '',
    '![](tg://photo?id=img2 "第二张图注")',
    '',
    '![](tg://photo?id=img1 "重复引用")',
].join('\n');

/** The media list behind RICH_SNAPSHOT: inline pictures first, then a trailing attachment */
const RICH_MEDIA: readonly MediaAttachment[] = [
    mediaItem(0, { id: 'img1', caption: '第一张**图注**' }),
    mediaItem(1, { id: 'img2', caption: '第二张图注' }),
    mediaItem(2, { placement: 'attachment', id: null }),
];

/** An L2 fallback snapshot: no picture blocks; the pictures go out as attachments */
const L2_SNAPSHOT = [
    '这一版正文只走富文本排版，图片作为附件跟在后面。',
    '',
    '（图片已作为附件发送）',
].join('\n');

const L2_MEDIA: readonly MediaAttachment[] = [
    mediaItem(0, { placement: 'attachment', id: null }),
    mediaItem(1, { placement: 'attachment', id: null }),
];

const kindsOf = (blocks: readonly RichAnswerBlock[]): string => blocks.map((block) => block.kind).join(',');

/** Every run text of a block list, nested quotes and lists included */
const runTextsOf = (blocks: readonly RichAnswerBlock[]): string[] =>
    blocks.flatMap((block): string[] => {
        switch (block.kind) {
            case 'paragraph':
            case 'heading':
                return block.runs.map((run) => run.text);
            case 'list':
                return block.items.flatMap((item) => item.runs.map((run) => run.text));
            case 'quote':
                return runTextsOf(block.blocks);
            case 'table':
                return [...(block.header ?? []), ...block.rows.flat()].flatMap((cell) =>
                    cell.map((run) => run.text)
                );
            case 'plain':
                return [block.text];
            default:
                return [];
        }
    });

const stylesOfText = (runs: readonly RichAnswerRun[], text: string): readonly string[] =>
    runs.find((run) => run.text === text)?.styles ?? [];

const firstOfKind = <Kind extends RichAnswerBlock['kind']>(
    blocks: readonly RichAnswerBlock[],
    kind: Kind
): Extract<RichAnswerBlock, { kind: Kind }> | undefined =>
    blocks.find((block): block is Extract<RichAnswerBlock, { kind: Kind }> => block.kind === kind);

const results: CaseResult[] = [];

results.push(
    await runCase('a real snapshot splits into blocks in the order the model wrote them', async () => {
        const blocks = parseRichAnswer(RICH_SNAPSHOT, RICH_MEDIA);
        expect(
            kindsOf(blocks) ===
                'heading,paragraph,list,list,quote,pre,table,divider,paragraph,photo,paragraph,photo,photo',
            `the block sequence follows the snapshot (got ${kindsOf(blocks)})`
        );

        const heading = firstOfKind(blocks, 'heading');
        expect(heading?.size === 3, `the heading keeps its level (got ${String(heading?.size)})`);
        expect(
            heading !== undefined && heading.runs.map((run) => run.text).join('') === '图片的解释',
            'the heading text has no markdown markers'
        );
        expect(
            heading !== undefined && stylesOfText(heading.runs, '图片的解释').includes('bold'),
            'a rich heading renders bold, as Telegram does'
        );

        const intro = firstOfKind(blocks, 'paragraph');
        expect(
            intro !== undefined && stylesOfText(intro.runs, '粗体').includes('bold'),
            'inline bold becomes a bold run'
        );
        expect(
            intro !== undefined && stylesOfText(intro.runs, '行内代码').includes('code'),
            'inline code becomes a code run'
        );
        expect(
            intro !== undefined &&
                stylesOfText(intro.runs, '链接').includes('text_link:https://example.com/a'),
            'a link run carries its url'
        );
        expect(
            intro !== undefined &&
                stylesOfText(intro.runs, '¹').includes('text_link:https://source.example/1'),
            'the citation keeps its target'
        );

        const lists = blocks.filter((block) => block.kind === 'list');
        const unordered = lists[0];
        const ordered = lists[1];
        expect(unordered !== undefined && unordered.ordered === false, 'the first list is unordered');
        expect(ordered !== undefined && ordered.ordered === true, 'the second list is ordered');
        expect(
            unordered !== undefined &&
                unordered.items.map((item) => item.depth).join(',') === '0,1,0',
            `indentation becomes depth (got ${unordered?.items.map((item) => item.depth).join(',')})`
        );
        expect(
            unordered !== undefined &&
                unordered.items.some((item) => item.runs.some((run) => run.text === '强调' && run.styles.includes('bold'))),
            'a nested item keeps its inline styles'
        );

        const quote = firstOfKind(blocks, 'quote');
        const quoteParagraph = quote?.blocks[0];
        expect(quoteParagraph?.kind === 'paragraph', 'the quote holds its paragraph as a block');
        expect(
            quoteParagraph?.kind === 'paragraph' &&
                quoteParagraph.runs.map((run) => run.text).join('') === '引用第一行\n引用第二行',
            `a hard line break inside the quote becomes a newline (got ${JSON.stringify(
                quoteParagraph?.kind === 'paragraph' ? quoteParagraph.runs.map((run) => run.text).join('') : ''
            )})`
        );

        const pre = firstOfKind(blocks, 'pre');
        expect(pre?.language === 'ts', `the fence keeps its language (got ${JSON.stringify(pre?.language)})`);
        expect(pre?.text === 'const answer = 42;', `the code block keeps its text (got ${JSON.stringify(pre?.text)})`);

        const table = firstOfKind(blocks, 'table');
        const cellsText = (cells: readonly (readonly { readonly text: string }[])[]): string =>
            cells.map((cell) => cell.map((run) => run.text).join('')).join('|');
        expect(
            table !== undefined && cellsText(table.header ?? []) === '名称|值',
            `the table header cells (got ${table === undefined ? 'none' : cellsText(table.header ?? [])})`
        );
        expect(
            table !== undefined && table.rows.length === 1 && cellsText(table.rows[0] ?? []) === '图片|2',
            `the table row cells (got ${table === undefined ? 'none' : cellsText(table.rows[0] ?? [])})`
        );

        expect(firstOfKind(blocks, 'divider') !== undefined, 'the horizontal rule is a divider block');

        // No raw snapshot syntax may survive into a run
        const runText = runTextsOf(blocks).join('\n');
        expect(!runText.includes('![]('), `no bare image syntax (got ${JSON.stringify(runText)})`);
        expect(!runText.includes('<b>') && !runText.includes('</b>'), 'no HTML tag markup in the runs');
        expect(!runText.includes('```'), 'no fence markup in the runs');
        expect(runText.includes('图片前的段落。') && runText.includes('两张图之间的段落。'), 'the paragraphs around pictures survive');
    })
);

results.push(
    await runCase('picture blocks map to the media list by id and a repeated id reuses its index', async () => {
        const blocks = parseRichAnswer(RICH_SNAPSHOT, RICH_MEDIA);
        const photos = blocks.filter((block) => block.kind === 'photo');
        expect(
            photos.map((block) => (block.kind === 'photo' ? block.mediaIndex : -1)).join(',') === '0,1,0',
            `the pictures follow the snapshot ids (got ${photos.map((block) => (block.kind === 'photo' ? block.mediaIndex : -1)).join(',')})`
        );
        expect(JSON.stringify(referencedMediaIndexes(blocks)) === '[0,1]', 'both inline pictures are referenced');
        expect(
            JSON.stringify(unreferencedMediaIndexes(blocks, RICH_MEDIA.length)) === '[2]',
            'the trailing attachment is left to the end of the body'
        );
    })
);

results.push(
    await runCase('an exact media id beats the fallback order', async () => {
        // The media list order is not always the body order: the ids decide
        const media = [mediaItem(0, { id: 'img2' }), mediaItem(1, { id: 'img1' })];
        const blocks = parseRichAnswer(
            ['![](tg://photo?id=img1 "a")', '', '![](tg://photo?id=img2 "b")'].join('\n'),
            media
        );
        const photos = blocks.filter((block) => block.kind === 'photo');
        expect(
            photos.map((block) => (block.kind === 'photo' ? block.mediaIndex : -1)).join(',') === '1,0',
            `each id keeps its own media entry (got ${photos.map((block) => (block.kind === 'photo' ? block.mediaIndex : -1)).join(',')})`
        );
    })
);

results.push(
    await runCase('media without ids fall back to the distinct snapshot ids in inline order', async () => {
        const media = [mediaItem(0), mediaItem(1), mediaItem(2, { placement: 'attachment' })];
        const blocks = parseRichAnswer(RICH_SNAPSHOT, media);
        const photos = blocks.filter((block) => block.kind === 'photo');
        expect(
            photos.map((block) => (block.kind === 'photo' ? block.mediaIndex : -1)).join(',') === '0,1,0',
            `the distinct ids map to inline entries in order (got ${photos.map((block) => (block.kind === 'photo' ? block.mediaIndex : -1)).join(',')})`
        );
        expect(
            JSON.stringify(unreferencedMediaIndexes(blocks, 3)) === '[2]',
            'the attachment stays unreferenced'
        );
    })
);

results.push(
    await runCase('a picture id no media entry can be found for keeps its caption as plain text', async () => {
        // One inline picture whose id is not the snapshot id: the first distinct
        // id takes it; the second id has nothing left and must not vanish.
        const media = [mediaItem(0, { id: 'other' })];
        const snapshot = [
            '前一段。',
            '',
            '![](tg://photo?id=img1 "第一张图注")',
            '',
            '![](tg://photo?id=unknown "带 &quot;引号&quot; 的图注")',
        ].join('\n');
        const blocks = parseRichAnswer(snapshot, media);
        expect(kindsOf(blocks) === 'paragraph,photo,plain', `the unmatched picture becomes plain text (got ${kindsOf(blocks)})`);
        const plain = firstOfKind(blocks, 'plain');
        expect(
            plain?.text.includes('带 "引号" 的图注') === true,
            `the caption is decoded and kept (got ${JSON.stringify(plain?.text)})`
        );
        expect(!runTextsOf(blocks).join('').includes('![]('), 'no bare image syntax is left behind');
    })
);

results.push(
    await runCase('an L2 snapshot leaves every picture unreferenced for the end of the body', async () => {
        const blocks = parseRichAnswer(L2_SNAPSHOT, L2_MEDIA);
        expect(kindsOf(blocks) === 'paragraph,paragraph', `the L2 snapshot is text only (got ${kindsOf(blocks)})`);
        expect(referencedMediaIndexes(blocks).length === 0, 'no picture block is referenced');
        expect(
            JSON.stringify(unreferencedMediaIndexes(blocks, L2_MEDIA.length)) === '[0,1]',
            'both attachments render after the text, in order'
        );
        expect(
            runTextsOf(blocks).join('\n').includes('（图片已作为附件发送）'),
            'the explanatory line stays in the body'
        );
    })
);

results.push(
    await runCase('inlineRuns renders a caption through the package, keeping hard breaks', async () => {
        const caption = inlineRuns('第一张**图注**');
        expect(
            caption.map((run) => run.text).join('') === '第一张图注' && stylesOfText(caption, '图注').includes('bold'),
            `the caption keeps its inline styles (got ${JSON.stringify(caption)})`
        );
        const broken = inlineRuns('第一行\\\n第二行');
        expect(
            broken.map((run) => run.text).join('') === '第一行\n第二行',
            `a hard break becomes a newline (got ${JSON.stringify(broken.map((run) => run.text).join(''))})`
        );
        expect(inlineRuns('').length === 0, 'an empty line has no runs');
    })
);

results.push(
    await runCase('unsafe or internal links never become link runs', async () => {
        expect(isSafeLinkUrl('https://example.com/a'), 'https passes');
        expect(isSafeLinkUrl('http://example.com'), 'http passes');
        expect(isSafeLinkUrl('tg://user?id=7'), 'tg passes');
        expect(!isSafeLinkUrl('javascript:alert(1)'), 'javascript does not');
        expect(!isSafeLinkUrl('/relative/path'), 'a relative path does not');
        expect(!isSafeLinkUrl('mailto:a@b.c'), 'mailto does not');

        const unsafe = inlineRuns('[x](javascript:alert(1))');
        expect(
            !unsafe.some((run) => run.styles.some((style) => style.startsWith('text_link:'))),
            'a javascript link stays text'
        );
        const internal = inlineRuns('![p](tg://photo?id=a)');
        expect(
            !internal.some((run) => run.styles.some((style) => style === 'text_link:tg://photo?id=a')),
            'a leftover media reference is not a link'
        );
        const user = inlineRuns('[u](tg://user?id=7)');
        expect(
            user.some((run) => run.styles.includes('text_link:tg://user?id=7')),
            'a tg user link is kept'
        );
    })
);

results.push(
    await runCase('an empty or malformed snapshot never throws and leaves no raw syntax', async () => {
        expect(parseRichAnswer('', []).length === 0, 'an empty snapshot has no blocks');
        const unclosed = parseRichAnswer('```\nconst a = 1;', []);
        expect(kindsOf(unclosed) === 'pre' && firstOfKind(unclosed, 'pre')?.text === 'const a = 1;', 'an unclosed fence is still code');

        const broken = parseRichAnswer('![broken](tg://photo?id=x "unterminated', []);
        const text = runTextsOf(broken).join('\n');
        expect(broken.length > 0, 'the broken picture line still yields a block');
        expect(!text.includes('![]('), `no image opener survives (got ${JSON.stringify(text)})`);
    })
);

results.push(
    await runCase('a hard break inside a paragraph becomes a newline in its runs', async () => {
        const blocks = parseRichAnswer('第一行\\\n第二行', []);
        expect(kindsOf(blocks) === 'paragraph', 'one paragraph');
        expect(
            firstOfKind(blocks, 'paragraph')?.runs.map((run) => run.text).join('') === '第一行\n第二行',
            'the two lines stay two lines inside the paragraph'
        );
    })
);


// ---- v5.2 production-shaped fixtures (design-critic review) -----------------
// A real rich snapshot's list items are `- title\\` + indented continuation
// lines (toRichMarkdown's hard breaks), and loose items are separated by blank
// lines while still being one list.
const MULTI_LINE_LIST_SNAPSHOT = [
    '- <b>排位与咖位：0 分战神</b>\\',
    '  在牌桌排位里它确实是铁打的 <b>0 分守门员</b>，连图鉴都给它排在 01 号。',
    '- <b>生态设定：奶狗的终极天敌</b>\\',
    '  第一段说明，结尾还断了一次。\\',
    '  第二段说明。',
    '- <b>商业化含金量</b>\\',
    '  最后一项的说明。',
].join('\n');

const LOOSE_LIST_SNAPSHOT = [
    '- <b>第一项</b>\\',
    '  第一项说明。',
    '',
    '- <b>第二项</b>\\',
    '  第二项说明。',
    '',
    '- <b>第三项</b>',
].join('\n');

const NESTED_LIST_SNAPSHOT = [
    '- <b>项目一</b>\\',
    '  项目一说明',
    '  - 子项甲\\',
    '    子项甲说明',
    '  - 子项乙',
    '- <b>项目二</b>',
].join('\n');

// A real L2 fallback body: the answer markdown plus a block the bot built with
// toRichHtml — a block-level `<p>`, which markdown does not understand.
const L2_HTML_NOTE_SNAPSHOT = [
    '这一版正文只走富文本排版，图片作为附件跟在后面。',
    '',
    '<p><i>（另有 2 张图未能内嵌发送）</i></p>',
].join('\n');

// A fenced example mentioning tg://photo must not join the media mapping.
const FENCE_WITH_MEDIA_TEXT_SNAPSHOT = [
    '```ts',
    "const shot = '![](tg://photo?id=fake)';",
    '```',
    '',
    '![](tg://photo?id=img1 "真实图")',
].join('\n');

const itemTextsOf = (block: Extract<RichAnswerBlock, { kind: 'list' }>): string[] =>
    block.items.map((item) => item.runs.map((run) => run.text).join(''));

const listTextOf = (blocks: readonly RichAnswerBlock[]): string => runTextsOf(blocks).join('\n');

results.push(
    await runCase('a multi-line list item keeps its continuation and loses the hard-break backslash', async () => {
        const blocks = parseRichAnswer(MULTI_LINE_LIST_SNAPSHOT, []);
        expect(kindsOf(blocks) === 'list', `the three loose items form one list (got ${kindsOf(blocks)})`);
        const list = firstOfKind(blocks, 'list');
        expect(list !== undefined && list.items.length === 3, `three items (got ${String(list?.items.length)})`);
        expect(
            list !== undefined && list.items.every((item) => item.depth === 0),
            `all items are top level (got ${list?.items.map((item) => item.depth).join(',')})`
        );
        const texts = list === undefined ? [] : itemTextsOf(list);
        expect(
            texts[0] === '排位与咖位：0 分战神\n在牌桌排位里它确实是铁打的 0 分守门员，连图鉴都给它排在 01 号。',
            `the first item joins its continuation after a newline (got ${JSON.stringify(texts[0])})`
        );
        expect(
            texts[1] === '生态设定：奶狗的终极天敌\n第一段说明，结尾还断了一次。\n第二段说明。',
            `a continuation hard break inside the item stays a newline (got ${JSON.stringify(texts[1])})`
        );
        expect(
            texts[2] === '商业化含金量\n最后一项的说明。',
            `the last item loses the dangling backslash (got ${JSON.stringify(texts[2])})`
        );
        expect(!listTextOf(blocks).includes('\\'), 'no literal backslash is rendered anywhere');
        const first = list?.items[0]?.runs ?? [];
        expect(stylesOfText(first, '排位与咖位：0 分战神').includes('bold'), 'the item title keeps its bold');
    })
);

results.push(
    await runCase('a loose list stays one list across blank lines', async () => {
        const blocks = parseRichAnswer(LOOSE_LIST_SNAPSHOT, []);
        expect(kindsOf(blocks) === 'list', `blank lines do not split the list (got ${kindsOf(blocks)})`);
        const list = firstOfKind(blocks, 'list');
        expect(list !== undefined && list.items.length === 3, `three items in one list (got ${String(list?.items.length)})`);
        expect(
            list !== undefined && itemTextsOf(list).join('|') === '第一项\n第一项说明。|第二项\n第二项说明。|第三项',
            `each item keeps its own continuation (got ${JSON.stringify(list === undefined ? [] : itemTextsOf(list))})`
        );
    })
);

results.push(
    await runCase('consecutive items and a nested list live in one list with depths', async () => {
        const blocks = parseRichAnswer(NESTED_LIST_SNAPSHOT, []);
        expect(kindsOf(blocks) === 'list', `one list block (got ${kindsOf(blocks)})`);
        const list = firstOfKind(blocks, 'list');
        expect(
            list !== undefined && list.items.map((item) => item.depth).join(',') === '0,1,1,0',
            `the nested items carry depth 1 (got ${list?.items.map((item) => item.depth).join(',')})`
        );
        const texts = list === undefined ? [] : itemTextsOf(list);
        expect(
            texts.join('|') === '项目一\n项目一说明|子项甲\n子项甲说明|子项乙|项目二',
            `each item keeps its own text (got ${JSON.stringify(texts)})`
        );
        expect(!listTextOf(blocks).includes('\\'), 'no literal backslash is rendered anywhere');
    })
);

results.push(
    await runCase('an ordered list that does not start at one reports its start', async () => {
        const blocks = parseRichAnswer(['3. 第三项', '4. 第四项'].join('\n'), []);
        const list = firstOfKind(blocks, 'list');
        expect(list !== undefined && list.ordered === true, 'it is an ordered list');
        expect(list !== undefined && list.start === 3, `the list reports its first number (got ${String(list?.start)})`);
        expect(list !== undefined && list.items.length === 2, 'both items are one list');
    })
);

results.push(
    await runCase('a block-level <p> from the L2 note renders as an italic paragraph', async () => {
        const blocks = parseRichAnswer(L2_HTML_NOTE_SNAPSHOT, L2_MEDIA);
        expect(kindsOf(blocks) === 'paragraph,paragraph', `the note is its own paragraph (got ${kindsOf(blocks)})`);
        const note = blocks[1];
        const noteText = note?.kind === 'paragraph' ? note.runs.map((run) => run.text).join('') : '';
        expect(noteText === '（另有 2 张图未能内嵌发送）', `the tag is stripped, the text kept (got ${JSON.stringify(noteText)})`);
        expect(
            note?.kind === 'paragraph' && note.runs.some((run) => run.styles.includes('italic')),
            'the note keeps its italic style'
        );
        expect(!listTextOf(blocks).includes('<p>') && !listTextOf(blocks).includes('</p>'), 'no literal <p> tag is rendered');
        expect(
            JSON.stringify(unreferencedMediaIndexes(blocks, L2_MEDIA.length)) === '[0,1]',
            'the L2 attachments still follow the body'
        );
    })
);

results.push(
    await runCase('a fenced tg://photo example is code, not a picture to map', async () => {
        const blocks = parseRichAnswer(FENCE_WITH_MEDIA_TEXT_SNAPSHOT, [mediaItem(0)]);
        expect(kindsOf(blocks) === 'pre,photo', `fence then picture (got ${kindsOf(blocks)})`);
        const pre = firstOfKind(blocks, 'pre');
        expect(
            pre !== undefined && pre.text.includes('tg://photo?id=fake'),
            'the code keeps its literal example'
        );
        // The only real id is img1: with no media ids it takes the inline entry
        const photo = firstOfKind(blocks, 'photo');
        expect(photo?.mediaIndex === 0, `the real picture maps to the inline entry (got ${String(photo?.mediaIndex)})`);
    })
);

results.push(
    await runCase('a dangling hard break at a paragraph end shows no backslash', async () => {
        const blocks = parseRichAnswer('段落结尾带反斜杠\\', []);
        expect(
            listTextOf(blocks) === '段落结尾带反斜杠',
            `the lone backslash is dropped (got ${JSON.stringify(listTextOf(blocks))})`
        );
    })
);

reportResults(results);
