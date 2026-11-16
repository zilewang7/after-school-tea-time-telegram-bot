/**
 * Offline cases for the SSR share page's rich-answer renderer (v5.3 design
 * 2026-1116-0310 §三.2/§五.6/§八 M2): `src/telegram/formatters/rich-answer-html.ts` is
 * the server port of the Mini App's `parseRichAnswer`, because the public page
 * must stay readable without JavaScript. Both consume the shared fixtures of
 * `fixtures/rich-snapshot-fixtures.mts`, and for every block this test compares
 * the rendered **text, link hrefs and picture captions** — not only the block
 * kinds — so porting drift (the 5e2d3bd line-break/list rules included) fails.
 *
 * Run: npx tsx scripts/offline/share-rich-layout.mts
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import {
    renderRichAnswerHtml,
    unreferencedMediaIndexes,
    type RichAnswerHtmlBlock,
    type RichAnswerHtmlMedia,
} from '../../src/telegram/formatters/rich-answer-html.js';
import {
    inlineRuns,
    parseRichAnswer,
    referencedMediaIndexes as webappReferencedMediaIndexes,
    type RichAnswerBlock as WebappBlock,
    type RichAnswerRun,
} from '../../webapp/src/rich/rich-answer.ts';
import {
    RICH_SNAPSHOT_FIXTURES,
    type RichSnapshotFixture,
    type RichSnapshotFixtureMedia,
} from './fixtures/rich-snapshot-fixtures.mts';

/** A picture as the share content carries it (MediaDescriptor's v5.3 fields) */
interface ShareMediaFixture extends RichAnswerHtmlMedia {
    readonly kind: 'image';
    readonly mimeType: string;
    readonly sizeBytes: number;
    readonly fileName: string | null;
}

const mediaOf = (index: number, overrides: Partial<RichAnswerHtmlMedia> = {}): ShareMediaFixture => ({
    kind: 'image',
    mimeType: 'image/jpeg',
    sizeBytes: 1000 + index,
    fileName: null,
    placement: 'inline',
    id: `img${index + 1}`,
    caption: null,
    ...overrides,
});

const photoUrlOf = (mediaIndex: number): string =>
    `/s/test-token/media/1121436/image${mediaIndex === 0 ? '' : `?i=${mediaIndex}`}`;

/** Inline HTML → the text a reader sees (hard breaks come back as newlines) */
const textOfHtml = (html: string): string =>
    html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');

const hrefsOfHtml = (html: string): string[] =>
    [...html.matchAll(/href="([^"]*)"/g)].map((match) => textOfHtml(match[1] ?? ''));

const textOfRuns = (runs: readonly RichAnswerRun[]): string => runs.map((run) => run.text).join('');

const hrefsOfRuns = (runs: readonly RichAnswerRun[]): string[] =>
    runs.flatMap((run) =>
        run.styles.flatMap((style) => (style.startsWith('text_link:') ? [style.slice('text_link:'.length)] : []))
    );

/**
 * One block as both sides must see it: the structure plus the text and links of
 * every inline segment. The two parsers produce different payloads (HTML vs
 * runs); comparing this projection is what catches a porting drift.
 */
type NormalBlock = { readonly kind: string; readonly [key: string]: unknown };

const inlineOfServer = (html: string): { text: string; hrefs: string[] } => ({
    text: textOfHtml(html),
    hrefs: hrefsOfHtml(html),
});

const inlineOfWebapp = (runs: readonly RichAnswerRun[]): { text: string; hrefs: string[] } => ({
    text: textOfRuns(runs),
    hrefs: hrefsOfRuns(runs),
});

const normalServer = (blocks: readonly RichAnswerHtmlBlock[]): NormalBlock[] =>
    blocks.map((block) => {
        switch (block.kind) {
            case 'paragraph':
                return { kind: 'paragraph', ...inlineOfServer(block.html) };
            case 'heading':
                return { kind: 'heading', size: block.size, ...inlineOfServer(block.html) };
            case 'pre':
                return { kind: 'pre', text: block.text };
            case 'list':
                return {
                    kind: 'list',
                    ordered: block.ordered,
                    start: block.start ?? 1,
                    items: block.items.map((item) => ({ depth: item.depth, ...inlineOfServer(item.html) })),
                };
            case 'quote':
                return { kind: 'quote', blocks: normalServer(block.blocks) };
            case 'table':
                return {
                    kind: 'table',
                    header: (block.header ?? []).map((cell) => inlineOfServer(cell)),
                    rows: block.rows.map((row) => row.map((cell) => inlineOfServer(cell))),
                };
            case 'divider':
                return { kind: 'divider' };
            case 'photo':
                // The caption is compared separately: the webapp keeps it on the
                // media item, this parser on the block
                return { kind: 'photo', mediaIndex: block.mediaIndex };
            case 'plain':
                return { kind: 'plain', text: block.text };
        }
    });

const normalWebapp = (blocks: readonly WebappBlock[]): NormalBlock[] =>
    blocks.map((block) => {
        switch (block.kind) {
            case 'paragraph':
                return { kind: 'paragraph', ...inlineOfWebapp(block.runs) };
            case 'heading':
                return { kind: 'heading', size: block.size, ...inlineOfWebapp(block.runs) };
            case 'pre':
                return { kind: 'pre', text: block.text };
            case 'list':
                return {
                    kind: 'list',
                    ordered: block.ordered,
                    start: block.start ?? 1,
                    items: block.items.map((item) => ({ depth: item.depth, ...inlineOfWebapp(item.runs) })),
                };
            case 'quote':
                return { kind: 'quote', blocks: normalWebapp(block.blocks) };
            case 'table':
                return {
                    kind: 'table',
                    header: (block.header ?? []).map((cell) => inlineOfWebapp(cell)),
                    rows: block.rows.map((row) => row.map((cell) => inlineOfWebapp(cell))),
                };
            case 'divider':
                return { kind: 'divider' };
            case 'photo':
                return { kind: 'photo', mediaIndex: block.mediaIndex };
            case 'plain':
                return { kind: 'plain', text: block.text };
        }
    });

/**
 * The picture captions as the page must show them: the stored caption markdown
 * rendered (the webapp's `inlineRuns` is the reference), or the media block's
 * entity-escaped title as plain text when the media carries no caption.
 */
const expectedCaptionOf = (
    fixture: RichSnapshotFixture,
    mediaIndex: number,
    title: string | null
): string | null => {
    const stored = fixture.media[mediaIndex]?.caption;
    if (typeof stored === 'string' && stored.trim() !== '') return textOfRuns(inlineRuns(stored));
    if (title === null || title === '') return null;
    return title
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
};

/** The media-block titles of one fixture, in block order (mirrors the parser) */
const blockTitlesOf = (markdown: string): (string | null)[] => {
    const titles: (string | null)[] = [];
    let inFence = false;
    for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
        if (inFence) {
            if (/^\s*```\s*$/.test(line)) inFence = false;
            continue;
        }
        if (/^(\s*)```(.*)$/.test(line)) {
            inFence = true;
            continue;
        }
        const matched = /^!\[\]\(tg:\/\/photo\?id=([A-Za-z0-9_-]+)(?:\s+"([^"]*)")?\)\s*$/.exec(line);
        if (matched !== null) titles.push(matched[2] ?? null);
    }
    return titles;
};

const SHARED_MEDIA = (fixture: RichSnapshotFixture): ShareMediaFixture[] =>
    fixture.media.map((item: RichSnapshotFixtureMedia, index: number) =>
        mediaOf(index, {
            id: item.id ?? null,
            caption: item.caption ?? null,
            placement: item.placement ?? 'inline',
        })
    );

const fixtureNamed = (name: string): RichSnapshotFixture => {
    const fixture = RICH_SNAPSHOT_FIXTURES.find((item) => item.name === name);
    if (fixture === undefined) throw new Error(`the fixture "${name}" is missing`);
    return fixture;
};

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'every shared fixture renders the same blocks, text, links and captions as the Mini App',
        body: async () => {
            for (const fixture of RICH_SNAPSHOT_FIXTURES) {
                const media = SHARED_MEDIA(fixture);
                const server = renderRichAnswerHtml(fixture.markdown, media, photoUrlOf);
                if (fixture.expectedReferenced !== undefined) {
                    expect(
                        JSON.stringify(server.referencedMediaIndexes) === JSON.stringify(fixture.expectedReferenced),
                        `[${fixture.name}] the intended referenced pictures (got ${JSON.stringify(server.referencedMediaIndexes)})`
                    );
                }
                const webapp = normalWebapp(parseRichAnswer(fixture.markdown, media));
                const normal = normalServer(server.blocks);
                expect(
                    JSON.stringify(normal) === JSON.stringify(webapp),
                    `[${fixture.name}] same blocks/text/links (server=${JSON.stringify(normal)}, webapp=${JSON.stringify(webapp)})`
                );
                expect(
                    JSON.stringify(server.referencedMediaIndexes) ===
                        JSON.stringify(webappReferencedMediaIndexes(parseRichAnswer(fixture.markdown, media))),
                    `[${fixture.name}] same referenced pictures (got ${JSON.stringify(server.referencedMediaIndexes)})`
                );
                // The pictures' captions: the stored caption renders like the webapp
                const titles = blockTitlesOf(fixture.markdown);
                const photoBlocks = server.blocks.flatMap((block) => (block.kind === 'photo' ? [block] : []));
                photoBlocks.forEach((photo, index) => {
                    const expected = expectedCaptionOf(fixture, photo.mediaIndex, titles[index] ?? null);
                    const actual = photo.captionHtml === null ? null : textOfHtml(photo.captionHtml);
                    expect(
                        actual === expected,
                        `[${fixture.name}] picture ${index} caption (server=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)})`
                    );
                });
                const outsideCode = server.html.replace(/<pre><code>[\s\S]*?<\/code><\/pre>/g, '');
                expect(!outsideCode.includes('![]('), `[${fixture.name}] the media block syntax never leaks outside code`);
            }
        },
    },
    {
        name: 'a real-form answer puts its pictures between the right paragraphs',
        body: async () => {
            const fixture = fixtureNamed('real-form answer with placeholders');
            const server = renderRichAnswerHtml(fixture.markdown, SHARED_MEDIA(fixture), photoUrlOf);
            expect(server.html.includes('<h4 class="rich-heading rich-heading--3">'), 'a level-3 heading');
            expect(server.html.includes('<strong>粗体</strong>'), 'inline bold');
            expect(server.html.includes('<code>行内代码</code>'), 'inline code');
            expect(server.html.includes('<a href="https://example.com/a"'), 'a safe link');
            expect(server.html.includes('<pre><code>const answer = 42;</code></pre>'), 'a fence');
            expect(server.html.includes('<div class="rich-table"><table>'), 'a table');
            expect(server.html.includes('<hr>'), 'a divider');
            const first = server.html.indexOf('<figure class="rich-figure">');
            const second = server.html.indexOf('<figure class="rich-figure">', first + 1);
            const third = server.html.indexOf('<figure class="rich-figure">', second + 1);
            expect(first > 0 && second > first && third > second, 'three picture blocks in order');
            expect(server.html.includes(`<img src="${photoUrlOf(0)}"`), 'the first picture has no ?i=');
            expect(server.html.includes(`<img src="${photoUrlOf(1)}"`), 'the second picture names its index');
            expect(server.html.split(`<img src="${photoUrlOf(0)}"`).length - 1 === 2, 'the repeated id reuses the picture');
            const between = server.html.slice(first, second);
            expect(between.includes('两张图的解释'), 'the paragraph between the pictures stays between them');
            expect(
                server.html.includes('<figcaption>第一张：<strong>红色</strong>圆形</figcaption>'),
                'the caption markdown renders'
            );
        },
    },
    {
        name: 'a picture inside a quote is referenced like any other block',
        body: async () => {
            const fixture = fixtureNamed('a picture inside a quote');
            const server = renderRichAnswerHtml(fixture.markdown, SHARED_MEDIA(fixture), photoUrlOf);
            expect(JSON.stringify(server.referencedMediaIndexes) === JSON.stringify([0]), 'the quoted picture is referenced');
            const quoteStart = server.html.indexOf('<blockquote>');
            const figure = server.html.indexOf('<figure class="rich-figure">');
            expect(quoteStart >= 0 && figure > quoteStart, 'the picture stays inside the quote');
            expect(server.html.includes('<figcaption>引用里的图</figcaption>'), 'its caption');
        },
    },
    {
        name: 'unmatched pictures keep only their decoded caption and never an empty figure',
        body: async () => {
            const fixture = fixtureNamed('unmatched picture blocks');
            const server = renderRichAnswerHtml(fixture.markdown, [], photoUrlOf);
            expect(!server.html.includes('rich-figure'), 'no figure without a picture');
            expect(
                server.html.includes('&quot;引号&quot;与 &amp; 符号'),
                `the entity-escaped title is decoded and re-escaped once (got ${server.html})`
            );
            expect(server.html.includes('<p>&quot;引号&quot;与 &amp; 符号</p>'), 'it shows as text, not as tags');
            expect(
                server.blocks.filter((block) => block.kind === 'plain').length === 1,
                'a title-less block adds no empty text'
            );
        },
    },
    {
        name: 'a rich-text fallback note renders inline and leaves its pictures to the end',
        body: async () => {
            const fixture = fixtureNamed('rich-text fallback note');
            const media = SHARED_MEDIA(fixture);
            const server = renderRichAnswerHtml(fixture.markdown, media, photoUrlOf);
            expect(server.html.includes('<em>（另有 2 张图未能内嵌发送）</em>'), 'the note is inline text');
            expect(!server.html.includes('<p><i>'), 'the block-level <p> wrapper is stripped');
            expect(server.referencedMediaIndexes.length === 0, 'the body references no picture');
            expect(
                JSON.stringify(unreferencedMediaIndexes(server.blocks, media.length)) === JSON.stringify([0, 1]),
                'both attachments are appended at the end'
            );
        },
    },
    {
        name: 'fenced media blocks stay code and a body of pictures only stays figures',
        body: async () => {
            const fenced = fixtureNamed('a fenced media block');
            const pictures = fixtureNamed('a body of pictures only');
            const fencedHtml = renderRichAnswerHtml(fenced.markdown, SHARED_MEDIA(fenced), photoUrlOf).html;
            expect(!fencedHtml.includes('rich-figure'), 'a media block inside a fence is not a picture');
            expect(fencedHtml.includes('![]('), 'the fence keeps the sample text');
            expect(fencedHtml.includes('<pre><code>'), 'it stays a code block');
            const pictureHtml = renderRichAnswerHtml(pictures.markdown, SHARED_MEDIA(pictures), photoUrlOf).html;
            expect(pictureHtml.split('<figure class="rich-figure">').length - 1 === 2, 'two figures');
            expect(!pictureHtml.includes('<p>'), 'no empty paragraph around them');
        },
    },
    {
        name: 'media without ids takes the inline entries in snapshot order',
        body: async () => {
            const fixture = fixtureNamed('picture blocks on media without ids');
            const server = renderRichAnswerHtml(fixture.markdown, SHARED_MEDIA(fixture), photoUrlOf);
            expect(JSON.stringify(server.referencedMediaIndexes) === JSON.stringify([0, 1]), 'both inline entries are used');
            expect(server.html.includes('<figcaption>旧图一</figcaption>'), 'the first stored caption');
        },
    },
    {
        name: 'a dangling hard-break marker is cleaned and a broken snapshot degrades to plain',
        body: async () => {
            const dangling = renderRichAnswerHtml('一句话结尾有一个孤立的硬换行符\\', [], photoUrlOf);
            expect(!dangling.html.includes('\\'), `no literal backslash (got ${dangling.html})`);
            const broken = renderRichAnswerHtml('前文\n\n```\n未闭合的围栏', [], photoUrlOf);
            expect(broken.blocks.length > 0, 'some block is emitted');
            expect(!broken.html.includes('<script'), 'nothing executable is emitted');
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) results.push(await runCase(testCase.name, testCase.body));
reportResults(results);
