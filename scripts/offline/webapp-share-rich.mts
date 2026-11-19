/**
 * Offline cases for the Mini App share page's rich-answer rendering (v5.3
 * design 2026-1116-0310 §三.3/§五.7): the public share JSON carries a rich
 * reply's answer snapshot, so the share page can show the body with its
 * pictures where the model put them, using the same parser/view as the reply
 * detail.
 *
 * The fixtures are shaped like the public JSON: media views with `caption` /
 * `placement` / `id`, bot bubbles whose pictures are the same message with a
 * position, and a reply share whose pictures all belong to `firstMessageId`.
 *
 * Run: npx tsx scripts/offline/webapp-share-rich.mts
 */
import { createRequire } from 'node:module';
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import type {
    MediaAttachment,
    PublicShareBubble,
    PublicShareMedia,
    PublicShareMediaItem,
    PublicShareReply,
} from '../../webapp/src/api/types.ts';
import {
    inlineRuns,
    referencedMediaIndexes,
    unreferencedMediaIndexes,
    type RichAnswerBlock,
} from '../../webapp/src/rich/rich-answer.ts';
import {
    shareRichAnswerBlocksOf,
    shareRichMediaItemsOf,
    shareRichMediaOf,
} from '../../webapp/src/share/share-rich-media.ts';

/**
 * Render a share component the way the browser bundle does, with the webapp's
 * own React packages (the root package does not depend on React). The loaded
 * modules arrive as `unknown` and are narrowed by guards, so no cast is needed.
 */
interface StaticRenderer {
    readonly renderToStaticMarkup: (element: unknown) => string;
}

interface ReactFactory {
    readonly createElement: (type: unknown, props: unknown) => unknown;
}

const isStaticRenderer = (value: unknown): value is StaticRenderer =>
    typeof value === 'object'
    && value !== null
    && 'renderToStaticMarkup' in value
    && typeof value.renderToStaticMarkup === 'function';

const isReactFactory = (value: unknown): value is ReactFactory =>
    typeof value === 'object'
    && value !== null
    && 'createElement' in value
    && typeof value.createElement === 'function';

const webappRequire = createRequire(new URL('../../webapp/package.json', import.meta.url));
const loadedRenderer: unknown = webappRequire('react-dom/server');
const loadedReact: unknown = webappRequire('react');

/**
 * The offline runner compiles the webapp `.tsx` modules with the root
 * tsconfig's classic JSX transform (the webapp's own tsconfig is not used), so
 * they read `React` from the global scope. Install the same React instance the
 * renderer uses; the previous value is put back when the file ends.
 */
const previousReactGlobal = Object.getOwnPropertyDescriptor(globalThis, 'React');
Object.defineProperty(globalThis, 'React', { configurable: true, writable: true, value: loadedReact });
const restoreReactGlobal = (): void => {
    if (previousReactGlobal === undefined) Reflect.deleteProperty(globalThis, 'React');
    else Object.defineProperty(globalThis, 'React', previousReactGlobal);
};
// The runner runs a file's process exit listeners when that file ends: the
// worker process outlives this file, so the global never leaks to the next one
process.once('exit', restoreReactGlobal);

/** One export of a loaded component module, verified to be a component function */
const componentOf = (module: unknown, name: 'ShareBubble' | 'ShareReplyContent'): unknown => {
    if (typeof module !== 'object' || module === null) {
        throw new Error(`the share page module for ${name} is not loadable`);
    }
    const value: unknown = Reflect.get(module, name);
    if (typeof value !== 'function') throw new Error(`the share page module has no ${name} component`);
    return value;
};

/**
 * The components are loaded through a runtime path: the scripts-dom project
 * type-checks this file without the webapp's `jsx` option, so a typed import of
 * a `.tsx` module cannot compile there. The runner still loads it, with the
 * classic JSX transform that reads the `React` global installed above.
 */
const loadShareModule = async (name: 'share-bubble' | 'share-reply-content'): Promise<unknown> =>
    import(`../../webapp/src/pages/share/${name}.tsx`);

const loadedBubble: unknown = await loadShareModule('share-bubble');
const loadedReplyContent: unknown = await loadShareModule('share-reply-content');
const ShareBubbleComponent = componentOf(loadedBubble, 'ShareBubble');
const ShareReplyContentComponent = componentOf(loadedReplyContent, 'ShareReplyContent');

/** One component render to static HTML, through the webapp's React */
const renderToHtml = (type: unknown, props: unknown): string => {
    if (!isStaticRenderer(loadedRenderer) || !isReactFactory(loadedReact)) {
        throw new Error('react-dom/server is not resolvable from the webapp package');
    }
    return loadedRenderer.renderToStaticMarkup(loadedReact.createElement(type, props));
};

/** One picture of a reply share's media list, as the public JSON sends it */
const replyMediaOf = (overrides: Partial<PublicShareMedia> = {}): PublicShareMedia => ({
    kind: 'image',
    mimeType: 'image/jpeg',
    sizeBytes: 1000,
    fileName: null,
    caption: null,
    placement: 'inline',
    id: null,
    ...overrides,
});

/** One picture of a conversation bubble, as the public JSON sends it */
const bubbleMediaOf = (messageId: number, overrides: Partial<PublicShareMediaItem> = {}): PublicShareMediaItem => ({
    ...replyMediaOf(),
    messageId,
    ...overrides,
});

/** A real shape: a heading, paragraphs and two inline pictures between them */
const SHARE_SNAPSHOT = [
    '### 图片的解释',
    '',
    '前半段**说明**。',
    '',
    '![](tg://photo?id=img1 "第一张图注")',
    '',
    '两张图之间。',
    '',
    '![](tg://photo?id=img2 "第二张图注")',
    '',
    '结尾段落。',
].join('\n');

const SHARE_REPLY_MEDIA: readonly PublicShareMedia[] = [
    replyMediaOf({ id: 'img1', caption: '第一张**图注**' }),
    replyMediaOf({ id: 'img2', caption: '第二张图注' }),
    replyMediaOf({ placement: 'attachment', id: null }),
];

/** An L2 share body: no picture blocks, the pictures are trailing attachments */
const L2_SHARE_SNAPSHOT = [
    '这一版正文只走富文本排版，图片作为附件跟在后面。',
    '',
    '<p><i>（另有 2 张图未能内嵌发送）</i></p>',
].join('\n');

const L2_SHARE_MEDIA: readonly PublicShareMedia[] = [
    replyMediaOf({ placement: 'attachment', id: null }),
    replyMediaOf({ placement: 'attachment', id: null }),
];

/** The L2 pictures as public attachments: only one keeps a caption to render */
const L2_CAPTIONED_MEDIA: readonly PublicShareMedia[] = [
    replyMediaOf({ placement: 'attachment', id: null, caption: '带**粗体**的图注' }),
    replyMediaOf({ placement: 'attachment', id: null }),
];

const l2ReplyOf = (media: PublicShareMedia[]): PublicShareReply => ({
    firstMessageId: 42,
    versionId: 1,
    versionNumber: 1,
    createdAt: '2026-11-16T03:00:00.000Z',
    model: 'gemini-4-hydrogen',
    text: '原始文本',
    widget: null,
    media,
    richAnswerMarkdown: L2_SHARE_SNAPSHOT,
});

const l2BubbleOf = (media: PublicShareMediaItem[]): PublicShareBubble => ({
    kind: 'bot',
    messageId: 1121448,
    createdAt: '2026-11-16T03:00:00.000Z',
    deleted: false,
    text: '原始文本',
    mediaHint: null,
    widget: null,
    media,
    previewMedia: [],
    replyTo: null,
    richAnswerMarkdown: L2_SHARE_SNAPSHOT,
});

const captionTextsOf = (html: string): string[] =>
    [...html.matchAll(/<figcaption[^>]*>(.*?)<\/figcaption>/gu)].map((matched) => matched[1] ?? '');

const kindsOf = (blocks: readonly RichAnswerBlock[]): string => blocks.map((block) => block.kind).join(',');

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

const photoIndexesOf = (blocks: readonly RichAnswerBlock[]): string =>
    blocks
        .flatMap((block) => (block.kind === 'photo' ? [String(block.mediaIndex)] : []))
        .join(',');

const results: CaseResult[] = [];

results.push(
    await runCase('a reply share maps its public media to signed picture attachments', async () => {
        const media: MediaAttachment[] = shareRichMediaOf('tok', 1121448, SHARE_REPLY_MEDIA);
        expect(media.length === 3, `every picture is carried over (got ${media.length})`);
        expect(
            media.map((item) => item.url).join('|') ===
                '/s/tok/media/1121448/image|/s/tok/media/1121448/image?i=1|/s/tok/media/1121448/image?i=2',
            `each picture names its own position (got ${JSON.stringify(media.map((item) => item.url))})`
        );
        expect(
            media[0]?.caption === '第一张**图注**' && media[1]?.caption === '第二张图注',
            'captions are passed through for the view to render'
        );
        expect(
            media[0]?.placement === 'inline' && media[2]?.placement === 'attachment',
            'the placement is passed through'
        );
        expect(media[0]?.id === 'img1' && media[1]?.id === 'img2' && media[2]?.id === null, 'the media ids are passed through');
        expect(
            media.every((item) => !Object.hasOwn(item, 'messageId') && !Object.hasOwn(item, 'index')),
            'no share-only field leaks into the attachment'
        );
        expect(
            media.every((item) => item.kind === 'image' && item.mimeType === 'image/jpeg'),
            'the picture facts are kept'
        );
    })
);

results.push(
    await runCase('a conversation bubble maps its own message ids and indexes', async () => {
        const items: readonly PublicShareMediaItem[] = [
            bubbleMediaOf(1121448, { id: 'img1' }),
            bubbleMediaOf(1121448, { id: 'img2', index: 1 }),
            bubbleMediaOf(1121499, { index: undefined }),
        ];
        const media = shareRichMediaItemsOf('tok', items);
        expect(
            media.map((item) => item.url).join('|') ===
                '/s/tok/media/1121448/image|/s/tok/media/1121448/image?i=1|/s/tok/media/1121499/image',
            `a bubble picture addresses the message that owns it (got ${JSON.stringify(media.map((item) => item.url))})`
        );
    })
);

results.push(
    await runCase('a file attachment keeps the file slot, and the token is URL-encoded', async () => {
        const media = shareRichMediaOf('a/b tok', 7, [
            replyMediaOf({ kind: 'file', mimeType: 'text/markdown', fileName: 'report.md' }),
        ]);
        expect(
            media[0]?.url === '/s/a%2Fb%20tok/media/7/file',
            `a document uses the file slot (got ${media[0]?.url ?? ''})`
        );
        expect(media[0]?.kind === 'file' && media[0]?.fileName === 'report.md', 'the file facts are kept');
    })
);

results.push(
    await runCase('a shared rich snapshot puts its pictures back in place', async () => {
        const blocks = shareRichAnswerBlocksOf(SHARE_SNAPSHOT, SHARE_REPLY_MEDIA);
        expect(blocks !== null, 'a snapshot yields blocks');
        if (blocks === null) return;
        expect(
            kindsOf(blocks) === 'heading,paragraph,photo,paragraph,photo,paragraph',
            `the block order follows the snapshot (got ${kindsOf(blocks)})`
        );
        expect(photoIndexesOf(blocks) === '0,1', `the ids map to the two inline media entries (got ${photoIndexesOf(blocks)})`);
        expect(
            JSON.stringify(referencedMediaIndexes(blocks)) === '[0,1]',
            'both inline pictures are referenced'
        );
        expect(
            JSON.stringify(unreferencedMediaIndexes(blocks, SHARE_REPLY_MEDIA.length)) === '[2]',
            'the trailing attachment renders after the body'
        );
        const text = runTextsOf(blocks).join('\n');
        expect(!text.includes('![](') && !text.includes('<b>'), `no raw snapshot markup (got ${JSON.stringify(text)})`);
        expect(
            text.includes('前半段') && text.includes('说明') && text.includes('两张图之间。') && text.includes('结尾段落。'),
            'the paragraphs around the pictures survive'
        );
    })
);

results.push(
    await runCase('no snapshot keeps the old text layout', async () => {
        expect(shareRichAnswerBlocksOf(undefined, SHARE_REPLY_MEDIA) === null, 'a missing snapshot has no blocks');
        expect(shareRichAnswerBlocksOf('', SHARE_REPLY_MEDIA) === null, 'an empty snapshot has no blocks');
        expect(shareRichAnswerBlocksOf('   \n ', SHARE_REPLY_MEDIA) === null, 'a blank snapshot has no blocks');
        // A snapshot that parses to no block at all is the same kind of empty: the
        // page keeps the stored text instead of rendering an empty rich body.
        expect(shareRichAnswerBlocksOf('<p></p>', SHARE_REPLY_MEDIA) === null, 'a block-less snapshot falls back to text');
        const html = renderToHtml(ShareReplyContentComponent, {
            token: 'tok',
            reply: { ...l2ReplyOf([...SHARE_REPLY_MEDIA]), richAnswerMarkdown: '<p></p>' },
        });
        expect(html.includes('原始文本'), 'the stored text still renders');
        expect(!html.includes('rich-answer'), 'no empty rich body is rendered');
    })
);

results.push(
    await runCase('an L2 share body leaves its pictures to the end of the bubble', async () => {
        const blocks = shareRichAnswerBlocksOf(L2_SHARE_SNAPSHOT, L2_SHARE_MEDIA);
        expect(blocks !== null && kindsOf(blocks) === 'paragraph,paragraph', 'the note is its own paragraph');
        if (blocks === null) return;
        expect(
            JSON.stringify(unreferencedMediaIndexes(blocks, L2_SHARE_MEDIA.length)) === '[0,1]',
            'both fallback pictures render after the text, in order'
        );
        expect(!runTextsOf(blocks).join('').includes('<p>'), 'the block-level <p> tags are stripped');
    })
);

results.push(
    await runCase('public media without ids falls back to the distinct snapshot ids in order', async () => {
        const media: readonly PublicShareMedia[] = [replyMediaOf(), replyMediaOf(), replyMediaOf({ placement: 'attachment' })];
        const blocks = shareRichAnswerBlocksOf(SHARE_SNAPSHOT, media);
        expect(blocks !== null && photoIndexesOf(blocks) === '0,1', 'old payloads without ids still map by order');
    })
);

results.push(
    await runCase('an L2 share body shows its leftover pictures with captions', async () => {
        const blocks = shareRichAnswerBlocksOf(L2_SHARE_SNAPSHOT, L2_CAPTIONED_MEDIA);
        expect(blocks !== null && !blocks.some((block) => block.kind === 'photo'), 'the L2 snapshot has no picture block');
        if (blocks === null) return;
        expect(
            JSON.stringify(unreferencedMediaIndexes(blocks, L2_CAPTIONED_MEDIA.length)) === '[0,1]',
            'both attachments are left for the end of the body'
        );

        // The caption reaches the view as raw markdown and renders through the package
        const media = shareRichMediaOf('tok', 42, L2_CAPTIONED_MEDIA);
        expect(media[0]?.caption === '带**粗体**的图注', 'the caption is passed through untouched');
        const runs = inlineRuns(media[0]?.caption ?? '');
        expect(
            runs.map((run) => run.text).join('') === '带粗体的图注' && runs.some((run) => run.styles.includes('bold')),
            `the caption markdown renders bold (got ${JSON.stringify(runs)})`
        );

        const html = renderToHtml(ShareReplyContentComponent, {
            token: 'tok',
            reply: l2ReplyOf([...L2_CAPTIONED_MEDIA]),
        });
        expect((html.match(/<img/gu) ?? []).length === 2, 'both leftover pictures render after the text');
        expect(html.includes('/s/tok/media/42/image?i=1"'), 'the second leftover names its index');
        const captions = captionTextsOf(html);
        expect(captions.length === 1, `only the captioned picture gets a figcaption (got ${JSON.stringify(captions)})`);
        expect(
            captions[0]?.includes('带') === true && captions[0].includes('<strong>粗体</strong>'),
            `the figcaption shows the rendered caption (got ${JSON.stringify(captions[0])})`
        );
    })
);

results.push(
    await runCase('a conversation bot bubble shows the same leftover captions', async () => {
        const items: PublicShareMediaItem[] = [
            bubbleMediaOf(1121448, { placement: 'attachment', id: null, caption: '相册**图注**' }),
            bubbleMediaOf(1121499, { placement: 'attachment', id: null }),
        ];
        const html = renderToHtml(ShareBubbleComponent, {
            token: 'tok',
            bubble: l2BubbleOf(items),
            widgetIndex: null,
        });
        const captions = captionTextsOf(html);
        expect(captions.length === 1, `the captioned attachment gets a figcaption (got ${JSON.stringify(captions)})`);
        expect(captions[0]?.includes('<strong>图注</strong>') === true, 'the caption renders inline styles');
        expect(html.includes('/s/tok/media/1121499/image"'), 'the second picture uses its own message id');
    })
);

results.push(
    await runCase('a rich leftover document keeps the file slot and renders no picture', async () => {
        const media: PublicShareMedia[] = [
            replyMediaOf({
                kind: 'file',
                mimeType: 'text/markdown',
                fileName: 'report.md',
                placement: 'attachment',
                id: null,
            }),
        ];
        const rich = shareRichMediaOf('tok', 42, media);
        expect(rich[0]?.url === '/s/tok/media/42/file', `a document uses the file slot (got ${rich[0]?.url ?? ''})`);

        const html = renderToHtml(ShareReplyContentComponent, { token: 'tok', reply: l2ReplyOf(media) });
        expect(html.includes('/s/tok/media/42/file"'), 'the leftover document is served from the file slot');
        expect(!html.includes('<img'), 'a document is not rendered as a picture');
        expect(captionTextsOf(html).length === 0, 'an uncaptioned leftover renders no empty figcaption');
    })
);

restoreReactGlobal();
reportResults(results);
