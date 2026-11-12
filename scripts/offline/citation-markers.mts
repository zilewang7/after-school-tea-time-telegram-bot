/**
 * Offline cases for the raw PerQueryResult citation cleanup.
 *
 * Gemini's system prompt for `google:search` / `google:browse` requires a
 * `[i.j.k]` marker after every grounded claim. The API normally consumes the
 * markers, but a long tool loop can end on an answer round that carries no
 * grounding metadata at all, and then they reach the group verbatim (measured
 * 2026-11-12: four of thirty-two hydrogen replies). These cases pin the
 * stripper, its code / link protections, and the two wiring points that keep
 * the marker out of the chat and out of the replayed context.
 *
 * Run: npx tsx scripts/offline/citation-markers.mts
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';

// The context builder's import chain builds every platform client; placeholders
// keep them constructible without network or secrets
for (const key of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'GROK_API_KEY', 'MIMO_API_KEY']) {
    process.env[key] ||= 'offline-placeholder';
}

const { stripPerQueryResultCitations } = await import('../../src/shared/citation-markers.js');

const results: CaseResult[] = [];

results.push(
    await runCase('raw PerQueryResult markers are stripped from the body', async () => {
        const strip = stripPerQueryResultCitations;

        expect(strip('氪基米）[1.4.1][1.4.5]。') === '氪基米）。', 'adjacent 3-part markers go');
        expect(
            strip('**Contributor** [1.1.3]；下一个') === '**Contributor**；下一个',
            'the space before a removed marker goes too'
        );
        expect(strip('结论[2.1]成立') === '结论成立', 'a 2-part marker glued to the text goes');
        expect(
            strip('说明 [1.2.3, 3.4.1, 3.4.2] 结束') === '说明 结束',
            'a comma-separated group is one marker'
        );
        expect(strip('一行[1.2]\n二行') === '一行\n二行', 'a marker before a line break goes');
        expect(strip('') === '' && strip('没有引用的普通回复') === '没有引用的普通回复', 'plain text passes through');
    })
);

results.push(
    await runCase('code spans and fenced blocks are content, not markers', async () => {
        const strip = stripPerQueryResultCitations;

        const nodeName = '切到 `🇺🇸 美国极限优化 [2.5]` 就有 160ms';
        expect(strip(nodeName) === nodeName, 'a bracketed number inside inline code is a node name');

        const fenced = '```\n节点 [2.5]\n```\n正文 [1.2.3]';
        expect(
            strip(fenced) === '```\n节点 [2.5]\n```\n正文',
            'a fenced block is protected while the prose after it is not'
        );

        const unclosedFence = '```\n节点 [2.5]\n正文 [1.2.3]';
        expect(strip(unclosedFence) === unclosedFence, 'an unclosed fence protects everything after it');

        const unclosedSpan = '`节点 [2.5] 正文';
        expect(strip(unclosedSpan) === unclosedSpan, 'an unclosed inline span protects the rest of its line');

        expect(
            strip('`a [1.2]` 与 `b [2.3]` 与 [3.4]') === '`a [1.2]` 与 `b [2.3]` 与',
            'every span on a line is protected, the trailing prose marker is not'
        );
    })
);

results.push(
    await runCase('links and non-citation brackets are left alone', async () => {
        const strip = stripPerQueryResultCitations;

        const link = '[1.2](https://example.com/a) 是链接';
        expect(strip(link) === link, 'a link whose label looks like an index keeps its label');

        const image = '![1.2](https://example.com/a.png) 是图片';
        expect(strip(image) === image, 'an image label is left alone too');

        const otherShapes = '[1] 和 [72] 和 [#3] 和 [abc] 和 [1.2.3.4.5] 和版本 1.2.3';
        expect(strip(otherShapes) === otherShapes, 'single numbers, labels and deeper shapes are not markers');
    })
);

results.push(
    await runCase('an ASCII word separator survives the removal', async () => {
        const strip = stripPerQueryResultCitations;

        expect(strip('see [1.2] more') === 'see more', 'two words keep one space');
        expect(strip('see [1.2]more') === 'see more', 'a glued word gets the space back');
        expect(strip('text[1.2]') === 'text', 'no trailing space is invented at the end');
    })
);

results.push(
    await runCase('the final layout renders the body without raw markers', async () => {
        const { buildFinalMessages } = await import(
            '../../src/telegram/formatters/final-message-builder.js'
        );

        const chunks = buildFinalMessages({ text: '氪基米）[1.4.1][1.4.5]。' });
        expect(chunks.length === 1, `one message (got ${chunks.length})`);
        expect(
            chunks[0]?.text === '氪基米）。',
            `the rendered text is clean (got ${JSON.stringify(chunks[0]?.text)})`
        );
    })
);

results.push(
    await runCase('a replayed stored reply loses its raw markers too', async () => {
        const { stripLeakedWireFormat } = await import('../../src/reply/context-builder.js');

        expect(
            stripLeakedWireFormat('[#7]\n正文 [1.2.3] 结尾') === '正文 结尾',
            'both the leading label and the marker are gone'
        );
        expect(
            stripLeakedWireFormat('正文 `节点 [2.5]` 结尾') === '正文 `节点 [2.5]` 结尾',
            'code content survives the replay cleanup'
        );
    })
);

reportResults(results);
