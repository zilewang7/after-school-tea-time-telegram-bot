/**
 * Offline cases for the Mini App clipboard converter (design
 * docs/2026-1110-1555-设计-MiniApp剪贴板Markdown与TG实体双向转换工具.md).
 *
 * Covers both directions as pure functions: markdown -> clipboard HTML ->
 * markdown (round trip per target), and the client HTML dialects -> markdown.
 * The real-client paste behaviour is verified on devices (design §7.2).
 *
 * Run: npx tsx scripts/offline/md-tool.mts
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import {
    clipboardHtmlToMarkdown,
    markdownToRendered,
    renderedToClipboardPayload,
    renderedToPreviewHtml,
} from '../../webapp/src/tools/entity-convert.ts';
import { entitiesToClipboardHtml } from '../../webapp/src/tools/clipboard-html.ts';
import { renderedToIosMarkdown, renderedToTelegramMarkdown } from '../../webapp/src/tools/telegram-markdown.ts';
import { channelPlanOf, resolveClientPlatform, resolveClipboardTarget } from '../../webapp/src/tools/platform-channel.ts';

const markdownSamples: Record<string, string> = {
    inline: '**bold** *italic* __underline__ ~~strike~~ ||spoiler|| `code` [link](https://example.com/a?b=1&c=2)',
    paragraphs: 'first line\nsecond line\n\nnew paragraph',
    quote: '> quoted line one\n> quoted line two\n\nafter the quote',
    code: '```ts\nconst a = 1;\nif (a < 2) return "x & y";\n```\n\ntail',
    mixed:
        '**bold `code` in bold**\n\n> quote with **bold** and [link](https://example.com)\n\n- item one\n- item two',
    cjk: '中文**加粗**与*斜体*，还有 __下划线__ 和 ||剧透||。\n\n> 引用里的 `代码` 与 [链接](https://example.com/中文)',
};

const expectedMarkdownOf = (markdown: string): string => clipboardHtmlToMarkdown(
    renderedToClipboardPayload(markdownToRendered(markdown), 'desktop').html
).markdown;

const cases = [
    {
        name: 'desktop HTML round trip keeps text and markdown exact',
        body: async () => {
            for (const [name, markdown] of Object.entries(markdownSamples)) {
                const rendered = markdownToRendered(markdown);
                const payload = renderedToClipboardPayload(rendered, 'desktop');
                const back = clipboardHtmlToMarkdown(payload.html);
                expect(back.text === rendered.text, `${name}: text is exact`);
                expect(back.markdown === expectedMarkdownOf(markdown), `${name}: markdown is exact`);
                expect(payload.plainText === rendered.text, `${name}: plain text flavor is the rendered text`);
            }
        },
    },
    {
        name: 'the desktop HTML uses the dialect tdesktop writes',
        body: async () => {
            const rendered = markdownToRendered('**b** *i* __u__ ~~s~~ ||sp|| `c` [l](https://e.com)\n\n> q');
            const html = entitiesToClipboardHtml(rendered.text, rendered.entities, 'desktop');
            expect(html.includes('<b>b</b>'), 'bold uses <b>');
            expect(html.includes('<i>i</i>'), 'italic uses <i>');
            expect(html.includes('<u>u</u>'), 'underline uses <u>');
            expect(html.includes('<s>s</s>'), 'strikethrough uses <s>');
            expect(html.includes('<tg-spoiler>sp</tg-spoiler>'), 'spoiler uses tg-spoiler');
            expect(html.includes('<code>c</code>'), 'inline code uses <code>');
            expect(html.includes('<a href="https://e.com">l</a>'), 'link uses a[href]');
            expect(html.includes('<blockquote>q</blockquote>'), 'quote uses blockquote');
        },
    },
    {
        name: 'the android HTML uses android private tags and keeps text exact',
        body: async () => {
            const markdown = '**b** ||sp|| `code`\n\n```ts\nline1\nline2\n```';
            const rendered = markdownToRendered(markdown);
            const html = entitiesToClipboardHtml(rendered.text, rendered.entities, 'android');
            expect(html.includes('<tg-spoiler><spoiler>sp</spoiler></tg-spoiler>'), 'spoiler uses the nested dual tag');
            expect(html.includes('<pre lang="ts" data-language="ts">'), 'pre carries the language attribute');
            expect(html.includes('<br>'), 'pre newlines are <br> for android');
            expect(!html.includes('<code>'), 'android gets no <code> wrapper');
            const back = clipboardHtmlToMarkdown(html);
            expect(back.text === rendered.text, 'text is exact');
            // Inline code cannot be expressed on Android: the text survives without backticks.
            expect(back.markdown.includes('code') && !back.markdown.includes('`code`'), 'inline code degrades to text');
            expect(back.markdown.includes('```ts'), 'the fenced code block survives');
        },
    },
    {
        name: 'the reverse direction parses tdesktop exported HTML',
        body: async () => {
            const html =
                '<html><body><b>bold</b> <i>it</i> <u>u</u> <s>s</s> <code>c</code>' +
                '<pre>line1\nline2</pre><blockquote>quote</blockquote><tg-spoiler>sp</tg-spoiler> ' +
                '<a href="https://e.com/x">link</a></body></html>';
            const back = clipboardHtmlToMarkdown(html);
            expect(back.text === 'bold it u s c\nline1\nline2\nquote\nsp link', 'text matches the client export');
            expect(back.markdown.includes('**bold**'), 'bold');
            expect(back.markdown.includes('*it*'), 'italic');
            expect(back.markdown.includes('__u__'), 'underline');
            expect(back.markdown.includes('~~s~~'), 'strikethrough');
            expect(back.markdown.includes('`c`'), 'inline code');
            expect(back.markdown.includes('```\nline1\nline2\n```'), 'fenced code block');
            expect(back.markdown.includes('> quote'), 'quote');
            expect(back.markdown.includes('||sp||'), 'spoiler');
            expect(back.markdown.includes('[link](https://e.com/x)'), 'text link');
        },
    },
    {
        name: 'the reverse direction parses Android private tags',
        body: async () => {
            const html =
                '<spoiler>sp</spoiler><pre lang="ts">a<br>b</pre>' +
                '<blockquote data-collapsed="1">q</blockquote>' +
                '<animated-emoji data-document-id="123">😀</animated-emoji>';
            const back = clipboardHtmlToMarkdown(html);
            expect(back.text === 'sp\na\nb\nq\n😀', 'text matches');
            expect(back.markdown.includes('||sp||'), 'spoiler element becomes ||spoiler||');
            expect(back.markdown.includes('```ts\na\nb\n```'), 'pre language and <br> newlines');
            expect(back.markdown.includes('> q'), 'collapsed quote renders as a normal quote');
            expect(back.ignoredTags.includes('animated-emoji'), 'custom emoji tag is reported');
        },
    },
    {
        name: 'the WebK data-text-with-entities JSON is used verbatim',
        body: async () => {
            const json = JSON.stringify({
                text: 'hello bold',
                entities: [{ _: 'messageEntityBold', offset: 6, length: 4 }],
                shape: 'hello <strong >bold</>',
            }).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const html = `<span style="white-space: pre-wrap" data-text-with-entities="${json}"><strong>bold</strong></span>`;
            const back = clipboardHtmlToMarkdown(html);
            expect(back.source === 'webk-json', 'the JSON fast path is used');
            expect(back.text === 'hello bold', 'text comes from the JSON');
            expect(back.markdown === 'hello **bold**', 'markdown is exact');
        },
    },
    {
        name: 'the reverse direction parses WebA Bot API HTML',
        body: async () => {
            const html =
                '<strong>bold</strong> <em>it</em> <u>u</u> <del>s</del> <code>c</code> <tg-spoiler>sp</tg-spoiler>' +
                '<pre><code class="language-js">const a = 1;</code></pre><blockquote expandable>q</blockquote>';
            const back = clipboardHtmlToMarkdown(html);
            expect(back.text === 'bold it u s c sp\nconst a = 1;\nq', 'text matches');
            expect(back.markdown.includes('```js\nconst a = 1;\n```'), 'pre language from code.class');
            expect(back.markdown.includes('> q'), 'expandable quote renders as a normal quote');
            expect(back.markdown.includes('||sp||'), 'spoiler');
        },
    },
    {
        name: 'style and class attributes become formatting',
        body: async () => {
            const html =
                '<span style="font-weight:bold">bold</span> <span style="font-style:italic">it</span> ' +
                '<span style="text-decoration: underline">u</span> <span class="tg-spoiler">sp</span>';
            const back = clipboardHtmlToMarkdown(html);
            expect(back.text === 'bold it u sp', 'text matches');
            expect(back.markdown === '**bold** *it* __u__ ||sp||', 'formatting is mapped');
        },
    },
    {
        name: 'hidden elements are dropped and unknown tags keep their text',
        body: async () => {
            const back = clipboardHtmlToMarkdown(
                'safe<script>alert(1)</script><style>.x{}</style>text<img src="x.png" alt="a"><custom>kept</custom>'
            );
            expect(back.text === 'safetextkept', 'script/style content is gone, text survives');
            expect(back.ignoredTags.includes('img'), 'img is reported as ignored');
            expect(back.markdown === 'safetextkept', 'markdown has no html left');
        },
    },
    {
        name: 'whitespace collapses the way the client parsers do',
        body: async () => {
            const back = clipboardHtmlToMarkdown('one\n  two   three<br><br>four<p>para</p>after');
            expect(back.text === 'one two three\n\nfour\npara\nafter', 'text whitespace collapses, br and blocks break lines');
        },
    },
    {
        name: 'self links are dropped like the clients do',
        body: async () => {
            const back = clipboardHtmlToMarkdown('<a href="https://e.com">https://e.com</a>');
            expect(back.entities.length === 0, 'no text_link entity');
            expect(back.markdown === 'https://e.com', 'plain url');
        },
    },
    {
        name: 'unsafe links stay plain text',
        body: async () => {
            const back = clipboardHtmlToMarkdown('<a href="javascript:alert(1)">click</a>');
            expect(back.entities.length === 0, 'no entity for a javascript: link');
            expect(back.markdown === 'click', 'text kept');
        },
    },
    {
        name: 'broken markup does not throw and keeps the text',
        body: async () => {
            const back = clipboardHtmlToMarkdown('<b>unclosed <i>nested');
            expect(back.text === 'unclosed nested', 'text survives');
            expect(back.markdown.includes('unclosed'), 'markdown is produced');
            const empty = clipboardHtmlToMarkdown('');
            expect(empty.text === '' && empty.markdown === '', 'empty input gives empty output');
            expect(entitiesToClipboardHtml('', [], 'desktop') === '', 'empty text gives empty html');
        },
    },
    {
        name: 'markdown channels render the two dialects',
        body: async () => {
            const rendered = markdownToRendered('**bold** *italic* __u__ ~~s~~ ||sp|| `code` [l](https://e.com)\n\n> q\n\n```ts\nconst a = 1;\n```');
            const ios = renderedToIosMarkdown(rendered);
            expect(ios.includes('**bold**'), 'ios: bold markers');
            expect(ios.includes('*italic*'), 'ios: italic is CommonMark');
            expect(ios.includes('<u>u</u>'), 'ios: underline is inline html');
            expect(ios.includes('~~s~~'), 'ios: strikethrough');
            expect(!ios.includes('||sp||'), 'ios: spoiler markers are removed');
            expect(ios.includes('> q'), 'ios: quote prefix');
            expect(ios.includes('```ts\nconst a = 1;\n```'), 'ios: fenced code keeps the language');
            const telegram = renderedToTelegramMarkdown(rendered);
            expect(telegram.includes('__italic__'), 'telegram: italic uses __');
            expect(telegram.includes('||sp||'), 'telegram: spoiler markers kept');
            expect(!telegram.includes('<u>'), 'telegram: underline has no marker');
        },
    },
    {
        name: 'platform channel decisions follow the design matrix',
        body: async () => {
            expect(resolveClientPlatform('tdesktop') === 'tdesktop', 'tdesktop');
            expect(resolveClientPlatform('android') === 'android', 'android');
            expect(resolveClientPlatform('webk') === 'web', 'webk is the web client');
            expect(resolveClientPlatform('iOS') === 'ios', 'case insensitive');
            expect(resolveClientPlatform(undefined) === 'unknown', 'missing platform');
            expect(resolveClipboardTarget('android') === 'android', 'android target');
            expect(resolveClipboardTarget('web') === 'web', 'web target');
            expect(resolveClipboardTarget('tdesktop') === 'desktop', 'desktop target');
            expect(channelPlanOf('tdesktop', true).recommended === 'rich-html', 'desktop prefers rich html');
            expect(channelPlanOf('android', true).recommended === 'rich-html', 'android prefers rich html');
            expect(channelPlanOf('ios', true).recommended === 'markdown', 'ios uses markdown');
            expect(channelPlanOf('ios', true).markdownDialect === 'ios', 'ios dialect');
            expect(channelPlanOf('macos', true).recommended === 'markdown', 'macos falls back to markdown');
            expect(channelPlanOf('tdesktop', false).recommended === 'plain', 'no html support falls back to plain');
            expect(channelPlanOf('unknown', false).recommended === 'markdown', 'unknown without html tries markdown');
            expect(channelPlanOf('android', true).note.length > 0, 'a note is always provided');
        },
    },
    {
        name: 'the preview is a complete styled telegram bubble',
        body: async () => {
            const preview = renderedToPreviewHtml(markdownToRendered('**bold** and `code`'));
            expect(preview.includes('<style>'), 'styles are inlined');
            expect(preview.includes('tg-message'), 'telegram bubble class');
            expect(preview.includes('<b>bold</b>') || preview.includes('<strong>bold</strong>'), 'bold rendered');
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) results.push(await runCase(testCase.name, testCase.body));
reportResults(results);
