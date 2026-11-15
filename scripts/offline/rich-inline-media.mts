/**
 * Offline cases for the inline picture markers of a rich reply: the scan that
 * hides them from everything the user sees and assembles the media-block body,
 * and the media block itself (caption escaping measured on the real API, see
 * tmp/phase0-probe.md).
 *
 * Most cases are pure strings and rendered bodies. Two pin what must not change
 * around them: a fenced code block keeps its bytes when the blank lines next to
 * a removed marker fold, and a picture over the reply's limit keeps its caption
 * as text in the body (that case runs the real delivery on the scratch
 * database, whose pictures are fetched through the reply's media state).
 *
 * The end-to-end delivery cases (L1 → L2 → L3, media payloads, the coordinator)
 * live in rich-replies.mts.
 *
 * Run: pnpm test:offline rich-inline-media
 */
import {
    expect,
    reportResults,
    runCase,
    setupOfflineDb,
    takeMessageId,
    type CaseResult,
} from './harness.mts';

// telegram-md-entities renders documents without any network; the placeholders
// keep the formatter import chain constructing its clients
for (const key of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'GROK_API_KEY', 'MIMO_API_KEY']) {
    process.env[key] ||= 'offline-placeholder';
}
process.env.BOT_USER_ID = '7777';

// The over-limit case delivers a whole reply, which finalizes into the scratch database
await setupOfflineDb();

const { collectRichImages } = await import('../../src/telegram/formatters/rich-inline-media/collect.js');
const { mediaSentinelOf, replaceMediaSentinels, replaceSentinelsWithCaptionText, richMediaBlockOf, richHtmlMediaBlockOf, escapeCaptionTitle } =
    await import('../../src/telegram/formatters/rich-inline-media/media-blocks.js');
const { scanInlineMarkers, stripInlineMarkersForDisplay } = await import(
    '../../src/telegram/formatters/rich-inline-media/scan.js'
);
const { buildRichAnswer, buildRichReplyBody, buildRichReplyBodyFromAnswer, buildRichErrorDisplay, buildRichStreamingFrame } =
    await import('../../src/telegram/formatters/rich-reply-body.js');
const { buildErrorLine } = await import('../../src/telegram/formatters/error-display.js');
const { buildGoogleSearchDocument } = await import('../../src/telegram/formatters/google-search-document.js');
const { createFakeTelegram, contextOf, endOpenReplies, messageUpdate, quietly, trackReply } = await import(
    './fake-telegram.mts'
);
const responseHandler = await import('../../src/reply/response-handler.js');
const { createReplyMediaState } = await import('../../src/reply/tools/reply-media-state.js');

const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlZkAAAAASUVORK5CYII=',
    'base64'
);

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : {};

/** The markdown of the last rich message the fake Telegram received */
const richMarkdownOf = (telegram: {
    readonly callsOf: (method: string) => readonly { readonly payload: Readonly<Record<string, unknown>> }[];
}): string => {
    const edits = telegram.callsOf('editMessageText').filter((call) => call.payload.rich_message !== undefined);
    const richMessage = asRecord(edits.at(-1)?.payload.rich_message);
    return typeof richMessage.markdown === 'string' ? richMessage.markdown : '';
};

/** An empty search footer: no GoogleSearch step in this reply */
const NO_FOOTER = buildGoogleSearchDocument([]);

const media = (id: string, caption: string): { id: string; caption: string } => ({ id, caption });

/** Deliver one rich reply whose answer references the fetched pictures inline */
const deliverInlineAnswer = async (text: string, pictureIds: readonly string[]) => {
    const telegram = createFakeTelegram();
    const chatId = -1006666000101;
    const userMessageId = takeMessageId();
    const ctx = contextOf(messageUpdate({ chatId, messageId: userMessageId, userId: 42, text: '发图' }), telegram);
    const chatContext = await quietly(() =>
        responseHandler.createChatContext(ctx, { model: 'offline-model', richReplies: true })
    );
    if (chatContext === null) throw new Error('offline: no chat context');
    trackReply(chatContext);

    const state = createReplyMediaState();
    for (const id of pictureIds) {
        const data = Buffer.concat([PNG_BYTES, Buffer.from(id)]);
        state.fetched.set(id, {
            id,
            data,
            mimeType: 'image/png',
            still: { data, mimeType: 'image/png' },
            sourcePage: `https://example.test/${id}`,
            title: `图片 ${id}`,
            imageUrl: `https://example.test/${id}.png`,
        });
    }
    chatContext.mediaState = state;
    chatContext.contextIndex = new Map();
    chatContext.session.textBuffer = text;
    await quietly(() =>
        responseHandler.sendFinalResponse(chatContext, {
            text,
            thinkingText: '',
            images: [],
            groundingData: [],
        })
    );
    return { telegram, chatContext };
};

const results: CaseResult[] = [];

results.push(
    await runCase('collect: only a root paragraph that is nothing but the picture is a block', async () => {
        const refs = collectRichImages(
            [
                '前言',
                '',
                '![甲](g1)',
                '',
                '一段话里 ![乙](img2) 的图。',
                '',
                '> ![丙](g3)',
                '',
                '- ![丁](g4)',
                '',
                '| a | b |',
                '|---|---|',
                '| ![戊](g5) | x |',
                '',
                '```md',
                '![己](g6)',
                '```',
                '',
                '行内代码 `![庚](g7)` 不算图。',
                '',
                '![辛](g8 "标题")',
            ].join('\n')
        );
        expect(
            refs.map((ref) => ref.url).join(',') === 'g1,img2,g3,g4,g5,g8',
            `quote, list and table pictures are collected but not as blocks (got ${refs.map((ref) => ref.url).join(',')})`
        );
        expect(refs[0]?.block === true, 'a standalone picture is a block');
        expect(refs[1]?.block === false, 'a picture inside a sentence is not');
        expect(refs[2]?.block === false && refs[3]?.block === false && refs[4]?.block === false, 'nor in a quote, a list or a table');
        // The fenced and the inline-code picture are not image nodes at all
        expect(
            refs.every((ref) => ref.url !== 'g6' && ref.url !== 'g7'),
            'code blocks and inline code hold text, not pictures'
        );
        expect(refs[5]?.block === true && refs[5]?.title === '标题', 'the title is reported');
        const whole = refs[0];
        expect(
            whole !== undefined && '![甲](g1)'.length === whole.end - whole.start,
            'the offsets are the picture syntax'
        );
        expect(refs.every((ref, index) => ref.index === index), 'in source order');
    })
);

results.push(
    await runCase('collect: a details block, a heading and a glued line are no block; a reference-style one is', async () => {
        // The package's own rules, pinned here because the scan trusts them
        const details = collectRichImages('<details><summary>标题</summary>\n\n![图](g1)\n\n正文</details>');
        expect(details.length === 1 && details[0]?.block === false, 'a picture inside <details> is no media block');
        const heading = collectRichImages('## 标题 ![图](g1)');
        expect(heading[0]?.block === false, 'a heading is not a paragraph');
        const glued = collectRichImages('段落\n![图](g1)\n下一段');
        expect(glued[0]?.block === false, 'a line glued to a paragraph is no block');
        const indented = collectRichImages('正文\n\n    ![图](g1)');
        expect(indented.length === 0, 'an indented code block holds text, not a picture');
        const two = collectRichImages('![甲](g1)\n\n![乙](g2)');
        expect(two.length === 2 && two.every((ref) => ref.block === true), 'two blocks in a row are two pictures');
        const referenceSource = '前言。\n\n![甲][fig]\n\n后记。\n\n[fig]: https://example.test/a.png "图注"';
        const reference = collectRichImages(referenceSource);
        expect(
            reference.length === 1 &&
                reference[0]?.block === true &&
                reference[0]?.url === 'https://example.test/a.png' &&
                reference[0]?.title === '图注',
            `a reference-style picture resolves through its definition (got ${JSON.stringify(reference)})`
        );
        expect(
            reference[0] !== undefined && referenceSource.slice(reference[0].start, reference[0].end) === '![甲][fig]',
            'the offsets cover the use, not the definition'
        );
        // What a scan makes of the reference-style use: the marker is replaced,
        // the (now unused) definition line stays for the markdown parser to drop
        const scanned = scanInlineMarkers(referenceSource, { embed: true });
        expect(scanned.placements.length === 1, 'the reference-style picture is embedded');
        expect(scanned.cleanText.includes('![甲][fig]') === false, 'its syntax is gone from the clean text');
        const body = replaceMediaSentinels(scanned.assemblyText, [media('img1', '图注')]);
        expect(
            body.includes('![](tg://photo?id=img1 "图注")') && body.includes('[fig]: https://example.test/a.png'),
            `the block replaces the use and the definition stays (got ${JSON.stringify(body)})`
        );
    })
);

results.push(
    await runCase('scan: each standalone marker becomes a sentinel, the clean text loses it', async () => {
        const text = '先说一句。\n\n![第一张](g1)\n\n中间一段。\n\n![第二张](img2 "带标题")\n\n结尾。';
        const scanned = scanInlineMarkers(text, { embed: true });
        expect(
            scanned.assemblyText ===
                '先说一句。\n\n⟦media:img1⟧\n\n中间一段。\n\n⟦media:img2⟧\n\n结尾。',
            `the body source keeps a sentinel per picture (got ${JSON.stringify(scanned.assemblyText)})`
        );
        expect(
            scanned.cleanText === '先说一句。\n\n中间一段。\n\n结尾。',
            `the clean text has no marker (got ${JSON.stringify(scanned.cleanText)})`
        );
        expect(
            JSON.stringify(scanned.placements) ===
                JSON.stringify([
                    { mediaId: 'img1', ref: 'g1', caption: '第一张' },
                    { mediaId: 'img2', ref: 'img2', caption: '带标题' },
                ]),
            `one placement per picture, title first (got ${JSON.stringify(scanned.placements)})`
        );
    })
);

results.push(
    await runCase('scan: the same ref reuses one media id, its first caption', async () => {
        const scanned = scanInlineMarkers('![甲](g1)\n\n中间\n\n![乙](g1)', { embed: true });
        expect(scanned.placements.length === 1, 'one picture to resolve');
        expect(scanned.placements[0]?.mediaId === 'img1', 'one media id');
        expect(
            scanned.assemblyText === '⟦media:img1⟧\n\n中间\n\n⟦media:img1⟧',
            `both places reference it (got ${JSON.stringify(scanned.assemblyText)})`
        );
        expect(scanned.placements[0]?.caption === '甲', 'the first caption is the one the block takes');
    })
);

results.push(
    await runCase('scan: every other use of image syntax is cleaned to its alt text', async () => {
        const text = [
            '看这里 ![示意图](g1) 就够了。',
            '',
            '> ![引用里的图](img2)',
            '',
            '- ![列表里的图](g3)',
            '',
            '![相对路径](photo.png)',
            '',
            '```md',
            '![代码里的图](g4)',
            '```',
        ].join('\n');
        const scanned = scanInlineMarkers(text, { embed: true });
        expect(scanned.placements.length === 0, `nothing to embed (got ${JSON.stringify(scanned.placements)})`);
        expect(scanned.cleanText.includes('看这里 示意图 就够了。'), 'an inline picture leaves its alt text');
        expect(scanned.cleanText.includes('> 引用里的图'), 'a quoted one too');
        expect(scanned.cleanText.includes('- 列表里的图'), 'so does a list item');
        expect(scanned.cleanText.includes('相对路径'), 'and a target we cannot resolve');
        expect(scanned.cleanText.includes('```md\n![代码里的图](g4)\n```'), 'a code block keeps its text');
        expect(
            scanned.cleanText ===
                '看这里 示意图 就够了。\n\n> 引用里的图\n\n- 列表里的图\n\n相对路径\n\n```md\n![代码里的图](g4)\n```',
            `outside the code block no image syntax is left (got ${JSON.stringify(scanned.cleanText)})`
        );
        expect(scanned.cleanText === scanned.assemblyText, 'without a picture the two texts agree');
    })
);

results.push(
    await runCase('scan: a marker the answer was still writing is hidden, not shown as text', async () => {
        const partial = [
            '正文到这里。',
            '',
            '![还没写完的图](g',
            '',
            '半截的行内 ![图上](img',
            '',
            '![写到一半',
        ].join('\n');
        const scanned = scanInlineMarkers(partial, { embed: true });
        expect(
            !scanned.cleanText.includes('![') && !scanned.cleanText.includes('(g'),
            `no half marker survives (got ${JSON.stringify(scanned.cleanText)})`
        );
        expect(scanned.cleanText.includes('正文到这里。'), 'and the text before it stays');
        expect(scanned.cleanText.includes('半截的行内'), 'a line with text keeps its text');
        // A code block holding a half marker is the answer's text and stays
        const code = scanInlineMarkers('示例：\n\n```md\n![没写完](g\n```', { embed: true });
        expect(code.cleanText.includes('![没写完](g'), `a code block keeps it (got ${JSON.stringify(code.cleanText)})`);
    })
);

results.push(
    await runCase('scan: a text without markers comes back byte for byte', async () => {
        const plain = '第一段。\n\n\n\n第二段带 `![图](g1)` 的行内代码。\n\n| a | b |\n|---|---|\n| 1 | 2 |';
        const scanned = scanInlineMarkers(plain, { embed: true });
        expect(scanned.cleanText === plain, 'nothing to clean: the text is returned as it is');
        expect(scanned.assemblyText === plain, 'and the body source too');
        expect(scanned.placements.length === 0, 'no picture');
        expect(stripInlineMarkersForDisplay(plain, { embed: true }) === plain, 'a display frame too');
    })
);

results.push(
    await runCase('scan: a reply that cannot embed keeps a public URL but hides internal refs', async () => {
        const text = '![外链图](https://example.test/a.png)\n\n![内部图](g1)\n\n![行内内部](s2) 在图里';
        const scanned = scanInlineMarkers(text, { embed: false });
        expect(
            scanned.assemblyText.includes('![外链图](https://example.test/a.png)'),
            `today's behaviour for a public URL (got ${JSON.stringify(scanned.assemblyText)})`
        );
        expect(!scanned.assemblyText.includes('(g1)') && !scanned.cleanText.includes('(s2)'), 'internal refs are gone');
        expect(scanned.placements.length === 0, 'nothing is resolved');
    })
);

results.push(
    await runCase('media block: caption entities, folded newlines, no backslash escaping', async () => {
        expect(richMediaBlockOf(media('img1', '图注')) === '![](tg://photo?id=img1 "图注")', 'a plain caption');
        expect(richMediaBlockOf(media('img2', '')) === '![](tg://photo?id=img2)', 'no caption, no title');
        expect(
            richMediaBlockOf(media('img3', 'a&b<c>"d"')) ===
                '![](tg://photo?id=img3 "a&amp;b&lt;c&gt;&quot;d&quot;")',
            'the four characters as HTML entities: a backslash-escaped quote drops the picture (probe P16a1)'
        );
        expect(
            richMediaBlockOf(media('img4', '路径 C:\\temp\\图.jpg')) === '![](tg://photo?id=img4 "路径 C:\\temp\\图.jpg")',
            'a backslash is not escaped: one and two both render as one'
        );
        expect(
            richMediaBlockOf(media('img5', '第一行\n第二行')) === '![](tg://photo?id=img5 "第一行 第二行")',
            'a real newline is folded: in a title it silently drops the caption'
        );
        expect(
            richMediaBlockOf(media('img6', '**粗体** 与 `code`')) === '![](tg://photo?id=img6 "**粗体** 与 `code`")',
            'inline markdown stays: a title renders it next to entities'
        );
        const long = '长'.repeat(260);
        const truncated = richMediaBlockOf(media('img7', long));
        expect(
            truncated.includes(`${'长'.repeat(200)}…`) && !truncated.includes('长'.repeat(201)),
            `a long caption is cut at 200 characters (got ${truncated.length} bytes)`
        );
        expect(escapeCaptionTitle('a&b') === 'a&amp;b', 'the ampersand is escaped once');
        // The HTML fallback decodes entities and keeps inline tags
        expect(
            richHtmlMediaBlockOf(media('img8', 'a&b<c>"d"')) ===
                '<figure><img src="tg://photo?id=img8"/><figcaption>a&amp;b&lt;c&gt;"d"</figcaption></figure>',
            'the figure fallback escapes the text-node characters only'
        );
    })
);

results.push(
    await runCase('assembly: a sentinel becomes its media block, a missing picture leaves nothing', async () => {
        const body = `${mediaSentinelOf('img1')}\n\n中间\n\n${mediaSentinelOf('img2')}`;
        expect(
            replaceMediaSentinels(body, [media('img1', '甲'), media('img2', '乙')]) ===
                '![](tg://photo?id=img1 "甲")\n\n中间\n\n![](tg://photo?id=img2 "乙")',
            'in order, each as its own paragraph'
        );
        expect(
            replaceMediaSentinels(body, [media('img1', '甲')]) === '![](tg://photo?id=img1 "甲")\n\n中间\n\n',
            'a sentinel without media is dropped, its picture failed to resolve'
        );
        expect(replaceMediaSentinels('没有哨兵的正文', []) === '没有哨兵的正文', 'no media: the body is unchanged');
        expect(replaceMediaSentinels('没有哨兵的正文', [media('img1', '甲')]) === '没有哨兵的正文', 'and no sentinel: no picture appears');
    })
);

results.push(
    await runCase('answer: rendering puts the media blocks where the markers were', async () => {
        const scanned = scanInlineMarkers('前言。\n\n![图一](g1)\n\n后记。', { embed: true });
        const answer = buildRichAnswer({
            text: scanned.assemblyText,
            inlineMedia: [media(scanned.placements[0]?.mediaId ?? 'img1', scanned.placements[0]?.caption ?? '')],
        });
        expect(
            answer === '前言。\n\n![](tg://photo?id=img1 "图一")\n\n后记。',
            `the block stands as its own paragraph (got ${JSON.stringify(answer)})`
        );
        const body = buildRichReplyBodyFromAnswer({
            answerMarkdown: answer,
            googleSearch: NO_FOOTER,
            wasStoppedByUser: false,
            searchFolded: false,
        });
        expect(body === answer, 'a body without surrounding blocks is the answer');
        // Without the pictures the same answer renders without a trace of them
        const linkless = buildRichAnswer({ text: scanned.cleanText });
        expect(linkless === '前言。\n\n后记。', `the clean text has no body left over (got ${JSON.stringify(linkless)})`);
    })
);

results.push(
    await runCase('answer: #N links and citations keep working around a media block', async () => {
        const resolveContextLink = (index: number): string | undefined =>
            index === 7 ? 'https://t.me/c/1/7' : undefined;
        const scanned = scanInlineMarkers('看 #7 这条。\n\n![图](g1)\n\n然后 #7 又说。', { embed: true });
        const answer = buildRichAnswer({
            text: scanned.assemblyText,
            inlineMedia: [media('img1', '图')],
            resolveContextLink,
        });
        expect(answer.includes('<a href="https://t.me/c/1/7">#7</a>'), `the reference is a link (got ${JSON.stringify(answer)})`);
        expect(answer.includes('![](tg://photo?id=img1 "图")'), 'the media block is in place');
        expect(answer.indexOf('#7</a>') < answer.indexOf('tg://photo'), 'and where the model put it');
    })
);

results.push(
    await runCase('body: a pure picture reply is a body with only its media block', async () => {
        const scanned = scanInlineMarkers('![只有图](g1)', { embed: true });
        expect(scanned.cleanText === '', 'the clean text is empty');
        const body = buildRichReplyBody({
            text: scanned.assemblyText,
            googleSearch: NO_FOOTER,
            wasStoppedByUser: false,
            searchFolded: false,
            inlineMedia: [media('img1', '只有图')],
        });
        expect(body === '![](tg://photo?id=img1 "只有图")', `the body is the block alone (got ${JSON.stringify(body)})`);
        // A body that is empty both ways stays null: the entities path owns it
        expect(
            buildRichReplyBody({ text: '', googleSearch: NO_FOOTER, wasStoppedByUser: false, searchFolded: false }) === null,
            'no text and no picture is no rich body'
        );
        expect(
            buildRichReplyBodyFromAnswer({ answerMarkdown: '', googleSearch: NO_FOOTER, wasStoppedByUser: false, searchFolded: false }) ===
                null,
            'and so is an empty answer section'
        );
    })
);

results.push(
    await runCase('body: without a picture the output is the one the legacy input produced', async () => {
        const input = {
            text: '## 结论\n\n见 #3。\n\n| a | b |\n|---|---|\n| 1 | 2 |',
            thinking: '**想**\n\n先想一想。',
            googleSearch: NO_FOOTER,
            agentStats: { toolUsage: [{ name: 'web_search', count: 1 }] },
            wasStoppedByUser: true,
            searchFolded: false,
        };
        const legacy = buildRichReplyBody(input);
        const viaAnswer = buildRichReplyBodyFromAnswer({
            answerMarkdown: buildRichAnswer({ text: input.text }),
            thinking: input.thinking,
            googleSearch: input.googleSearch,
            agentStats: input.agentStats,
            wasStoppedByUser: true,
            searchFolded: false,
        });
        expect(legacy !== null && legacy === viaAnswer, 'the wrapper and the answer-based builder agree byte for byte');
        expect(legacy?.startsWith('<blockquote expandable>'), 'the thinking quote leads');
        expect(
            legacy?.includes('| 1 | 2 |') === true && legacy.indexOf('<p>[stopped]</p>') > legacy.indexOf('| 1 | 2 |'),
            `the stop marker follows the answer (got ${JSON.stringify(legacy?.slice(-120))})`
        );
        expect(legacy?.includes('Tools'), 'the tool record is there');
    })
);

results.push(
    await runCase('display hooks: a frame, an error display and a demoted text never show a marker', async () => {
        const streaming = buildRichStreamingFrame({
            thinking: '',
            text: '第一段。\n\n![图一](g1)\n\n第二段 ![行内](img2) 收尾。\n\n![半截',
            answerStarted: true,
            inlineImagesEnabled: true,
        });
        expect(!streaming.includes('g1') && !streaming.includes('img2'), `the frame hides the markers (got ${JSON.stringify(streaming)})`);
        expect(streaming.includes('第一段。') && streaming.includes('第二段 行内 收尾。'), 'and keeps the text');

        const errorDisplay = buildRichErrorDisplay({
            text: '写到这里失败了。\n\n![图](g1)',
            errorLines: buildErrorLine('模型连接中断'),
            maxLength: 30_000,
            inlineImagesEnabled: true,
        });
        expect(!errorDisplay.includes('![图](g1)') && errorDisplay.includes('写到这里失败了。'), 'the error display hides it too');

        // The same frame with the feature off still hides an internal id
        const noFeature = buildRichStreamingFrame({
            thinking: '',
            text: '正文 ![图](g1)',
            answerStarted: true,
        });
        expect(!noFeature.includes('(g1)'), `a rich reply without the feature hides internal refs (got ${JSON.stringify(noFeature)})`);
    })
);

results.push(
    await runCase('scan: two fenced code blocks keep their bytes when a removed marker folds the blank lines', async () => {
        const text = [
            '前言。',
            '',
            '```ts',
            'const a = 1;',
            '',
            '',
            '',
            'const b = 2;',
            '```',
            '',
            '![图注](g1)',
            '',
            '```py',
            'x = 1',
            '',
            '',
            '',
            'y = 2',
            '```',
        ].join('\n');
        const scanned = scanInlineMarkers(text, { embed: true });
        expect(scanned.placements.length === 1, 'the marker between the blocks is the picture');
        expect(
            scanned.cleanText ===
                [
                    '前言。',
                    '',
                    '```ts',
                    'const a = 1;',
                    '',
                    '',
                    '',
                    'const b = 2;',
                    '```',
                    '',
                    '```py',
                    'x = 1',
                    '',
                    '',
                    '',
                    'y = 2',
                    '```',
                ].join('\n'),
            `the code bytes are untouched, only the marker paragraph goes (got ${JSON.stringify(scanned.cleanText)})`
        );
        expect(
            scanned.assemblyText ===
                [
                    '前言。',
                    '',
                    '```ts',
                    'const a = 1;',
                    '',
                    '',
                    '',
                    'const b = 2;',
                    '```',
                    '',
                    mediaSentinelOf('img1'),
                    '',
                    '```py',
                    'x = 1',
                    '',
                    '',
                    '',
                    'y = 2',
                    '```',
                ].join('\n'),
            `the body source keeps the code bytes and the sentinel (got ${JSON.stringify(scanned.assemblyText)})`
        );
        // Outside a fence the rule still applies: the marker's blank run folds
        expect(scanned.cleanText.includes('```\n\n```py'), 'the blank run the removed marker left folds to one line');
        // A frame the user sees while streaming obeys the same rule
        const display = stripInlineMarkersForDisplay(text, { embed: true });
        expect(display.includes('const a = 1;\n\n\n\nconst b = 2;'), 'the display text keeps the code bytes too');
    })
);

results.push(
    await runCase('delivery: ten pictures inline, the over-limit captions kept as body text', async () => {
        const ids = Array.from({ length: 12 }, (_, index) => `img${index + 1}`);
        const captions = ids.map((_, index) => `内嵌图注${index + 1}`);
        const text = `开头。\n\n${ids
            .map((id, index) => `![${captions[index]}](${id})`)
            .join('\n\n')}\n\n结尾。`;
        const { telegram, chatContext } = await deliverInlineAnswer(text, ids);
        const markdown = richMarkdownOf(telegram);
        const pictureIds = [...markdown.matchAll(/tg:\/\/photo\?id=([A-Za-z0-9_-]+)/g)].map((match) => match[1]);
        expect(
            JSON.stringify(pictureIds) === JSON.stringify(ids.slice(0, 10)),
            `the body carries the first ten pictures (got ${JSON.stringify(pictureIds)})`
        );
        expect(!markdown.includes('⟦media:'), 'no sentinel reaches the body');
        const keptCaptions = [...markdown.matchAll(/（图片：([^）]*)）/g)].map((match) => match[1]);
        expect(
            JSON.stringify(keptCaptions) === JSON.stringify([captions[10], captions[11]]),
            `the two over-limit captions stay as body text (got ${JSON.stringify(keptCaptions)})`
        );
        expect(!markdown.includes('![内嵌图注'), 'no raw image marker is left');
        expect(
            chatContext.inlineImages?.length === 10,
            `ten pictures are resolved for the body (got ${chatContext.inlineImages?.length})`
        );
        expect(
            chatContext.session.inlineMedia?.length === 10,
            `ten pictures are stored as inline media (got ${chatContext.session.inlineMedia?.length})`
        );
        expect(!chatContext.session.textBuffer.includes('!['), 'the stored clean text carries no marker');
        // A dropped picture without a caption leaves nothing behind
        expect(
            replaceSentinelsWithCaptionText(mediaSentinelOf('img1'), new Map([['img1', '']])) === '',
            'an empty caption disappears with its sentinel'
        );
    })
);

endOpenReplies();
reportResults(results);
