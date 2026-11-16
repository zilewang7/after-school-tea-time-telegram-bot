/**
 * The rich-answer snapshot fixtures shared by the two renderers (v5.3 design
 * 2026-1116-0310 §五.6/§八 M2): the SSR port
 * (`src/telegram/formatters/rich-answer-html.ts`) and the Mini App parser
 * (`webapp/src/rich/rich-answer.ts`) must read the same dialect the same way.
 *
 * Both sides' offline tests import this file, so a fixture added here is
 * checked against both parsers. The samples are shaped like production
 * snapshots (block-level markdown, inline HTML tags, media blocks on their own
 * line) with the internal ids already rewritten the way the redaction gate
 * would.
 */

/** The media facts a fixture refers to (the version's `media[]` entries) */
export interface RichSnapshotFixtureMedia {
    /** Inline media id the block references; absent on older rows */
    readonly id?: string | null;
    /** Original caption markdown */
    readonly caption?: string | null;
    readonly placement?: 'inline' | 'attachment';
}

export interface RichSnapshotFixture {
    readonly name: string;
    /** The stored `richAnswerMarkdown` */
    readonly markdown: string;
    /** The version's `media[]`, inline first */
    readonly media: readonly RichSnapshotFixtureMedia[];
    /** The pictures the snapshot must reference, when the fixture pins it */
    readonly expectedReferenced?: readonly number[];
}

const INLINE_PHOTOS: readonly RichSnapshotFixtureMedia[] = [
    { placement: 'inline', id: 'img1', caption: '第一张：**红色**圆形' },
    { placement: 'inline', id: 'img2', caption: '第二张：绿色三角形' },
];

export const RICH_SNAPSHOT_FIXTURES: readonly RichSnapshotFixture[] = [
    {
        // A production-shaped answer: every block the v1 dialect carries
        name: 'real-form answer with placeholders',
        media: INLINE_PHOTOS,
        markdown: [
            '### 图片的解释',
            '',
            '这是**粗体**、`行内代码`、[链接](https://example.com/a) 与用户 [提及](tg://user?id=[data-deletion])。',
            '',
            '- 第一项',
            '  - 子项 **强调**',
            '- 第二项\\',
            '  第二项的续行',
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
            '| 图片 | 两张 |',
            '',
            '---',
            '',
            '![](tg://photo?id=img1 "第一张：红色圆形")',
            '',
            '两张图的解释：第一张是红色圆形。',
            '',
            '![](tg://photo?id=img2 "第二张：绿色三角形")',
            '',
            '结尾一段，重复引用第一张：',
            '',
            '![](tg://photo?id=img1 "重复引用第一张")',
        ].join('\n'),
    },
    {
        // The answer's own text explains an HTML tag: only a whole-line <p> is unwrapped
        name: 'a paragraph that mentions a closing p tag',
        media: [],
        markdown: ['正文里提到 </p> 标签不是块级剥壳，整行 <p>…</p> 才是。', '', '下一段。'].join('\n'),
    },
    {
        // Loose ordered list that does not start at 1, with multi-line items
        name: 'loose ordered list starting at three',
        media: [],
        markdown: ['3. 第三项\\', '   续行一\\', '   续行二', '4. 第四项', '', '   松条目的第二段', '5. 第五项'].join('\n'),
    },
    {
        // A picture inside a quote is a referenced picture, like any other block
        // (design §八 m3): both the server and the Mini App parser strip the
        // quote markers before collecting media ids.
        name: 'a picture inside a quote',
        expectedReferenced: [0],
        media: [{ placement: 'inline', id: 'img1', caption: '引用里的图' }],
        markdown: ['> 引用开头。', '>', '> ![](tg://photo?id=img1 "引用里的图")', '>', '> 引用结尾。'].join('\n'),
    },
    {
        // L2: the bot could not embed the pictures, its note is block-level HTML
        name: 'rich-text fallback note',
        media: [
            { placement: 'attachment', caption: '附件一' },
            { placement: 'attachment', caption: '附件二' },
        ],
        markdown: ['正文第一段。', '', '<p><i>（另有 2 张图未能内嵌发送）</i></p>', '', '正文第二段。'].join('\n'),
    },
    {
        // A fence showing the media syntax is code, not a picture
        name: 'a fenced media block',
        media: INLINE_PHOTOS,
        markdown: ['代码示例：', '', '```', '![](tg://photo?id=img1 "不是图片")', '```', '', '结束。'].join('\n'),
    },
    {
        // Unmatched ids: an entity-escaped title as the only text, and no title at all
        name: 'unmatched picture blocks',
        media: [],
        markdown: ['前文。', '', '![](tg://photo?id=ghost "&quot;引号&quot;与 &amp; 符号")', '', '![](tg://photo?id=none)', '后文。'].join('\n'),
    },
    {
        // A body that is only pictures
        name: 'a body of pictures only',
        media: INLINE_PHOTOS,
        markdown: ['![](tg://photo?id=img1 "一张")', '', '![](tg://photo?id=img2 "两张")'].join('\n'),
    },
    {
        // Older rows carry no media id: the id order assigns the inline entries
        name: 'picture blocks on media without ids',
        media: [{ placement: 'inline', caption: '旧图一' }, { placement: 'inline', caption: '旧图二' }],
        markdown: ['开头。', '', '![](tg://photo?id=imgA "旧图一")', '', '![](tg://photo?id=imgB "旧图二")'].join('\n'),
    },
];
