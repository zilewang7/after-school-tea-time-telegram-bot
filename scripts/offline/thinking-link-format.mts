/**
 * Offline cases for the long-CoT link message (formatter layer only).
 *
 * A chain of thought that already fills a Telegram message is shown as one
 * compact link message: the visible text is a single link into the Mini App
 * thinking page, the preview card opens the faster plain page, and the message
 * body keeps no CoT at all. These cases pin the rendering contract before the
 * streaming state machine consumes it:
 *
 * - terminal / streaming shapes and their preview options;
 * - the last-two-sections preview, still a bare quote (no block entity nested,
 *   so the CoT cannot spill out of the quote as body text);
 * - the overflow trigger boundary (message budgets of the streaming loop);
 * - buildFinalMessages ordering, the link chunk's card surviving the body's
 *   preview policy, and the no-link path staying byte-identical;
 * - buildErrorDisplay putting the link in front of the error line.
 *
 * Run: npx tsx scripts/offline/thinking-link-format.mts
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';

interface ThinkingLinkRef {
    token: string;
    miniAppUrl: string;
    fastPageUrl: string;
}

const LINK_REF: ThinkingLinkRef = {
    token: 'linktoken',
    miniAppUrl: 'https://t.me/k_on_test_bot/panel?startapp=tlinktoken',
    fastPageUrl: 'https://miniapp.test/t/linktoken',
};

/** Streaming loop budgets: one message, less headroom for the status line */
const LINK_TRIGGER_LENGTH = 3900 - 50;
const LINK_TRIGGER_ENTITIES = 85;

const LINE = '字';

const plainThinking = (length: number): string => LINE.repeat(length);

/** `count` heading sections, one bold entity per section */
const sectionThinking = (count: number): string =>
    Array.from({ length: count }, (_, index) => `**P${index}**\n\nbody ${index}`).join('\n\n');

const FIVE_SECTIONS = [
    '**Alpha**\n\nalpha body',
    '**Beta**\n\nbeta body',
    '**Gamma**\n\ngamma body',
    '**Delta**\n\ndelta body',
    '**Epsilon**\n\nepsilon body',
].join('\n\n');

type AnyMessage = {
    text: string;
    entities: readonly { type: string; offset: number; length: number; url?: string }[];
};

const quoteEntity = (
    rendered: AnyMessage
): { type: string; offset: number; length: number } | undefined =>
    rendered.entities.find(
        (entity) => entity.type === 'blockquote' || entity.type === 'expandable_blockquote'
    );

/** Block entities nested inside a quote — Telegram cuts the quote there */
const nestedBlockTypes = (rendered: AnyMessage): string[] => {
    const quote = quoteEntity(rendered);
    if (!quote) return [];
    return rendered.entities
        .filter(
            (entity) =>
                entity !== quote &&
                entity.offset >= quote.offset &&
                entity.offset + entity.length <= quote.offset + quote.length &&
                (entity.type === 'pre' ||
                    entity.type === 'blockquote' ||
                    entity.type === 'expandable_blockquote')
        )
        .map((entity) => entity.type);
};

const results: CaseResult[] = [];

results.push(
    await runCase('the terminal link message is one Mini App link with a quick-page card', async () => {
        const {
            THINKING_LINK_LABEL,
            renderThinkingLinkMessage,
            toThinkingLinkChunk,
            thinkingLinkPreviewOptions,
        } = await import('../../src/telegram/formatters/thinking-link.js');

        // Without a summary the message is the bare link (an unmeasurable CoT)
        const message = renderThinkingLinkMessage(LINK_REF);
        expect(message.text === THINKING_LINK_LABEL, `the visible text is the label (got ${JSON.stringify(message.text)})`);
        expect(message.entities.length === 1, `exactly one entity (got ${message.entities.length})`);
        const link = message.entities[0];
        expect(link?.type === 'text_link', 'the whole text is a text_link');
        expect(link?.offset === 0 && link.length === THINKING_LINK_LABEL.length, 'the link covers the entire visible text');
        expect(link?.url === LINK_REF.miniAppUrl, 'the text link opens the Mini App page');

        const chunk = toThinkingLinkChunk(LINK_REF);
        expect(chunk.text === THINKING_LINK_LABEL && chunk.entities.length === 1, 'the chunk carries the link message');
        expect(chunk.linkPreviewOptions?.url === LINK_REF.fastPageUrl, 'the preview card opens the fast page');
        expect(chunk.linkPreviewOptions?.show_above_text === false, 'the card sits below the text');
        expect(chunk.linkPreviewOptions?.prefer_large_media === undefined, 'no forced large media (text card)');
        expect(chunk.linkPreviewOptions?.is_disabled === undefined, 'the card is not disabled');
        expect(
            thinkingLinkPreviewOptions(LINK_REF).url === chunk.linkPreviewOptions?.url,
            'the shared preview options are the chunk ones'
        );

        // With the stats of the hidden CoT: link, blank line, italic line
        const summary = { words: 7689, segments: 16 };
        const line = '共 7,689 词，发出约拆成 16 段';
        const withSummary = renderThinkingLinkMessage(LINK_REF, summary);
        expect(
            withSummary.text === `${THINKING_LINK_LABEL}\n${line}`,
            `the stats line sits under the link (got ${JSON.stringify(withSummary.text)})`
        );
        expect(withSummary.entities.length === 2, `the link and the stats line (got ${withSummary.entities.length})`);
        const labelLink = withSummary.entities.find((entity) => entity.type === 'text_link');
        expect(
            labelLink?.url === LINK_REF.miniAppUrl && labelLink.length === THINKING_LINK_LABEL.length,
            'the text link still covers only the label'
        );
        const statsLine = withSummary.entities.find((entity) => entity.type === 'italic');
        expect(
            statsLine !== undefined &&
                statsLine.offset === THINKING_LINK_LABEL.length + 1 &&
                statsLine.length === line.length,
            'the stats are an italic line directly under the link'
        );
        const summarizedChunk = toThinkingLinkChunk(LINK_REF, summary);
        expect(
            summarizedChunk.text === withSummary.text &&
                summarizedChunk.linkPreviewOptions?.url === LINK_REF.fastPageUrl,
            'the chunk keeps the stats line and the card'
        );
    })
);

results.push(
    await runCase('the stats line counts the CoT and the messages it would have taken', async () => {
        const { thinkingLinkSummaryLine, thinkingLinkSummaryOf } =
            await import('../../src/telegram/formatters/thinking-link.js');

        expect(thinkingLinkSummaryOf('') === null, 'an empty CoT has no stats');
        expect(thinkingLinkSummaryOf('  \n\t ') === null, 'nor does a blank one');

        const short = thinkingLinkSummaryOf('one two three four');
        expect(short?.words === 4, `four words are counted (got ${JSON.stringify(short)})`);
        expect(short?.segments === 1, 'a short CoT fits one message');
        expect(
            thinkingLinkSummaryLine({ words: 4, segments: 1 }) === '共 4 词，发出约拆成 1 段',
            'the line states both numbers'
        );

        // A CoT far past one message: the count is of the messages the layout
        // before the link would have split it into (the final split's budgets)
        const long = 'word '.repeat(20000).trim();
        const summary = thinkingLinkSummaryOf(long);
        expect(summary?.words === 20000, `every word counts (got ${summary?.words})`);
        expect(summary?.segments === 25, `100k chars take 25 messages (got ${summary?.segments})`);
        expect(
            thinkingLinkSummaryLine({ words: 20000, segments: 25 }) === '共 20,000 词，发出约拆成 25 段',
            'large counts carry thousands separators'
        );
    })
);

results.push(
    await runCase('the streaming link message keeps a bare preview quote', async () => {
        const { THINKING_LINK_LABEL, renderThinkingLinkMessage, renderThinkingLinkStreaming } =
            await import('../../src/telegram/formatters/thinking-link.js');
        const { formatThinkingPreviewForLink } =
            await import('../../src/telegram/formatters/thinking-display.js');

        const preview = formatThinkingPreviewForLink(FIVE_SECTIONS);
        const streaming = renderThinkingLinkStreaming(LINK_REF, preview);

        expect(
            streaming.text === `${THINKING_LINK_LABEL}\n${preview.text}`,
            `link, blank line, then the preview (got ${JSON.stringify(streaming.text.slice(0, 40))})`
        );
        const labelLink = streaming.entities.find((entity) => entity.type === 'text_link');
        expect(labelLink?.url === LINK_REF.miniAppUrl, 'the visible label still opens the Mini App');
        expect(
            labelLink !== undefined &&
                labelLink.offset === 0 &&
                labelLink.length === THINKING_LINK_LABEL.length,
            'the label link covers exactly the label'
        );

        const quote = quoteEntity(streaming);
        expect(quote?.type === 'blockquote', 'the preview is a plain (never expandable) blockquote');
        expect(
            quote !== undefined &&
                quote.offset === THINKING_LINK_LABEL.length + 1 &&
                quote.length === preview.text.length,
            'the quote covers exactly the preview under the link'
        );
        expect(nestedBlockTypes(streaming).length === 0, 'no block entity nests inside the preview quote');

        // An empty preview degrades to the bare link message
        const bare = renderThinkingLinkStreaming(LINK_REF, { text: '', entities: [] });
        expect(
            bare.text === THINKING_LINK_LABEL &&
                bare.entities.length === 1 &&
                bare.text === renderThinkingLinkMessage(LINK_REF).text,
            'an empty preview leaves just the link'
        );

        // Gemini's indented sub-points would render as `pre`: still quote-free
        const indentedCoT =
            '**Plan**\n\ndo the thing\n\n    * **Sub point:** nested reasoning\n\n    * **Another sub point:** more of it';
        const indentedPreview = formatThinkingPreviewForLink(indentedCoT);
        expect(nestedBlockTypes(indentedPreview).length === 0, 'an indented CoT preview nests no pre');
        expect(
            nestedBlockTypes(renderThinkingLinkStreaming(LINK_REF, indentedPreview)).length === 0,
            'and the streaming message it builds nests none either'
        );
    })
);

results.push(
    await runCase('the link preview shows only the last two thinking sections, bounded', async () => {
        const { formatThinkingPreviewForLink } =
            await import('../../src/telegram/formatters/thinking-display.js');

        const preview = formatThinkingPreviewForLink(FIVE_SECTIONS);
        expect(preview.text.includes('Delta') && preview.text.includes('Epsilon'), 'the last two sections stay visible');
        expect(
            !preview.text.includes('Alpha') && !preview.text.includes('Beta') && !preview.text.includes('Gamma'),
            `older sections are dropped from the message (got ${JSON.stringify(preview.text.slice(0, 60))})`
        );
        expect(preview.entities.some((entity) => entity.type === 'blockquote'), 'the preview is one quote');
        expect(
            !preview.entities.some((entity) => entity.type === 'expandable_blockquote'),
            'the preview never hides text behind a fold'
        );

        const twoSections = '**Alpha**\n\nalpha body\n\n**Beta**\n\nbeta body';
        expect(
            formatThinkingPreviewForLink(twoSections).text.includes('alpha body') &&
                formatThinkingPreviewForLink(twoSections).text.includes('beta body'),
            'a short thinking shows in full'
        );

        const empty = formatThinkingPreviewForLink('');
        expect(empty.text === '' && empty.entities.length === 0, 'empty thinking renders an empty preview');

        // The message stays bounded however long the CoT grows
        const huge = formatThinkingPreviewForLink(plainThinking(200_000));
        expect(
            huge.text.length < 2000,
            `a 200k-char thinking still previews in about one screen (got ${huge.text.length})`
        );
    })
);

results.push(
    await runCase('a paragraph-free CoT previews only the newest three fifths of it', async () => {
        const { formatThinkingPreviewForLink, segmentThinking } =
            await import('../../src/telegram/formatters/thinking-display.js');

        // One long run with no blank lines: sectionThinking has to chop it
        const run = '推理推理推理推理推理'.repeat(500);
        const choppedSections = segmentThinking(run).slice(-2).join('\n\n');
        const preview = formatThinkingPreviewForLink(run);
        expect(segmentThinking(run).length > 2, 'the run really is a stack of chopped sections');
        const share = preview.text.length / choppedSections.length;
        expect(
            share > 0.55 && share < 0.65,
            `the paragraph-free preview keeps about 3/5 (got ${preview.text.length}/${choppedSections.length})`
        );
        expect(preview.text.endsWith(run.slice(-20)), 'it still shows the newest text');

        // A paragraph CoT keeps its last two natural sections whole
        const paragraphs = `${'甲'.repeat(800)}\n\n${'乙'.repeat(800)}`;
        const naturalSections = segmentThinking(paragraphs).slice(-2).join('\n\n');
        const naturalPreview = formatThinkingPreviewForLink(paragraphs);
        expect(
            naturalPreview.text.length === naturalSections.length,
            `a paragraph CoT is not shortened (got ${naturalPreview.text.length}/${naturalSections.length})`
        );
        expect(naturalPreview.text.includes('乙'.repeat(20)), 'and it still ends at the newest paragraph');
    })
);

results.push(
    await runCase('link mode triggers once the rendered thinking fills a message', async () => {
        const { formatThinkingForStreaming, thinkingOverflowsMessage } =
            await import('../../src/telegram/formatters/thinking-display.js');

        // The trigger measures the rendered message, not the raw text: find the
        // raw sizes whose render sits exactly on the length boundary
        const renderedLength = (thinking: string): number =>
            formatThinkingForStreaming(thinking, { answerStarted: false }).text.length;
        let under: string | undefined;
        let onBoundary: string | undefined;
        for (let raw = 3700; raw <= 4000; raw += 1) {
            const rendered = renderedLength(plainThinking(raw));
            if (rendered === LINK_TRIGGER_LENGTH - 1) under = plainThinking(raw);
            if (rendered === LINK_TRIGGER_LENGTH) onBoundary = plainThinking(raw);
        }
        expect(under !== undefined && onBoundary !== undefined, 'found raw sizes on both sides of the boundary');
        expect(
            thinkingOverflowsMessage(under ?? '', {
                maxLength: LINK_TRIGGER_LENGTH,
                maxEntities: LINK_TRIGGER_ENTITIES,
            }) === false,
            'one UTF-16 unit short of the budget does not switch to link mode'
        );
        expect(
            thinkingOverflowsMessage(onBoundary ?? '', {
                maxLength: LINK_TRIGGER_LENGTH,
                maxEntities: LINK_TRIGGER_ENTITIES,
            }) === true,
            'reaching the budget switches to link mode'
        );

        // Entity boundary: 84 entities fit, 85 do not
        const underEntities = sectionThinking(82);
        const onEntityBoundary = sectionThinking(83);
        expect(
            formatThinkingForStreaming(underEntities, { answerStarted: false }).entities.length ===
                LINK_TRIGGER_ENTITIES - 1,
            'the smaller thinking stays under the entity budget'
        );
        expect(
            thinkingOverflowsMessage(underEntities, {
                maxLength: 100_000,
                maxEntities: LINK_TRIGGER_ENTITIES,
            }) === false,
            '84 entities do not switch to link mode'
        );
        expect(
            thinkingOverflowsMessage(onEntityBoundary, {
                maxLength: 100_000,
                maxEntities: LINK_TRIGGER_ENTITIES,
            }) === true,
            '85 entities switch to link mode'
        );

        // The context-link resolver counts like the real display does
        const references = '#1 看看 '.repeat(20).trim();
        const resolve = (number: number): string => `https://t.me/c/1000000001/${number}`;
        expect(
            thinkingOverflowsMessage(references, { maxLength: 100_000, maxEntities: 21 }) === false,
            'plain `#N` text stays under a 21-entity budget'
        );
        expect(
            thinkingOverflowsMessage(references, { maxLength: 100_000, maxEntities: 21 }, resolve) === true,
            'linkifying `#N` counts against the same budget'
        );
    })
);

results.push(
    await runCase('the final message leads with the link chunk and ignores the thinking', async () => {
        const { buildFinalMessages } =
            await import('../../src/telegram/formatters/final-message-builder.js');
        const { THINKING_LINK_LABEL } = await import('../../src/telegram/formatters/thinking-link.js');

        const thinking = '**SecretCoT**\n\nhidden reasoning that must not leak';
        const chunks = buildFinalMessages({ text: '正文在这里', thinking, thinkingLink: LINK_REF });

        expect(chunks.length === 2, `link message + one body message (got ${chunks.length})`);
        const linkChunkText = chunks[0]?.text ?? '';
        expect(
            linkChunkText.startsWith(THINKING_LINK_LABEL) && linkChunkText.includes('词'),
            `the first chunk is the link plus its stats (got ${JSON.stringify(linkChunkText)})`
        );
        expect(
            chunks[0]?.entities.length === 2 &&
                chunks[0]?.entities[0]?.type === 'text_link' &&
                chunks[0]?.entities[1]?.type === 'italic',
            'the link, then the italic stats line'
        );
        expect(
            chunks[0]?.linkPreviewOptions?.url === LINK_REF.fastPageUrl,
            'its preview card opens the fast page'
        );
        expect(chunks[1]?.text.includes('正文在这里'), 'the answer follows in the body chunk');
        expect(
            chunks.every((chunk) => !chunk.text.includes('SecretCoT')),
            'the thinking never appears in any final chunk'
        );

        // Thinking only: the link message is the entire reply
        const thinkingOnly = buildFinalMessages({ text: '', thinking, thinkingLink: LINK_REF });
        expect(
            thinkingOnly.length === 1 &&
                thinkingOnly[0]?.text.startsWith(THINKING_LINK_LABEL) === true &&
                thinkingOnly[0]?.linkPreviewOptions?.url === LINK_REF.fastPageUrl,
            'a thinking-only reply is just the link message (with its card)'
        );

        // Stopping before any body text must not decorate the link message
        const stoppedEarly = buildFinalMessages({
            text: '',
            thinking,
            thinkingLink: LINK_REF,
            wasStoppedByUser: true,
        });
        expect(
            stoppedEarly.length === 1 && stoppedEarly[0]?.text.startsWith(THINKING_LINK_LABEL) === true,
            'a bare stop leaves the link message as the link and its stats'
        );
        const stoppedWithBody = buildFinalMessages({
            text: '正文',
            thinkingLink: LINK_REF,
            wasStoppedByUser: true,
        });
        expect(
            stoppedWithBody[1]?.text.includes('[stopped]') === true,
            'with a body the stop marker rides on the body message'
        );
    })
);

results.push(
    await runCase('the body split never overrides the link card', async () => {
        const { buildFinalMessages } =
            await import('../../src/telegram/formatters/final-message-builder.js');
        const { THINKING_LINK_LABEL } = await import('../../src/telegram/formatters/thinking-link.js');

        // A body long enough to split into several messages
        const chunks = buildFinalMessages({ text: '段落内容。'.repeat(900), thinkingLink: LINK_REF });
        expect(chunks.length >= 3, `the body splits into several messages (got ${chunks.length})`);
        expect(chunks[0]?.text === THINKING_LINK_LABEL, 'the link message still leads');
        expect(
            chunks[0]?.linkPreviewOptions?.url === LINK_REF.fastPageUrl,
            'the body preview policy left the link card alone'
        );
        expect(
            chunks.slice(1, -1).every((chunk) => chunk.linkPreviewOptions?.is_disabled === true),
            'intermediate body chunks have their previews disabled'
        );
        expect(
            chunks[chunks.length - 1]?.linkPreviewOptions === undefined,
            'the last body chunk keeps Telegram\'s default preview'
        );

        // A Gemini search footer keeps its own preview on the body, not on the link
        const googleUrl = 'https://www.google.com/search?q=long+cot+link';
        const grounding = {
            provider: 'google' as const,
            searchQueries: ['long cot link'],
            searchEntryPoint: {
                renderedContent: `<a href="${googleUrl}">long cot link</a>`,
            },
            groundingChunks: [],
        };
        const withSearch = buildFinalMessages({
            text: '正文',
            thinkingLink: LINK_REF,
            groundingData: [grounding],
        });
        expect(withSearch.length === 2, `link + body with the search footer (got ${withSearch.length})`);
        expect(
            withSearch[0]?.linkPreviewOptions?.url === LINK_REF.fastPageUrl,
            'the link card survives a search footer'
        );
        expect(
            withSearch[1]?.linkPreviewOptions?.url === googleUrl,
            `the search footer keeps its own card (got ${JSON.stringify(withSearch[1]?.linkPreviewOptions)})`
        );
    })
);

results.push(
    await runCase('without a link the final message keeps the collapsed thinking quote', async () => {
        const { buildFinalMessages } =
            await import('../../src/telegram/formatters/final-message-builder.js');

        const chunks = buildFinalMessages({ text: '正文', thinking: FIVE_SECTIONS });
        expect(chunks.length === 1, `still one message (got ${chunks.length})`);
        const [chunk] = chunks;
        expect(chunk?.text.includes('alpha body') === true, 'the thinking quote is still in the reply');
        expect(
            chunk?.entities.some((entity) => entity.type === 'expandable_blockquote') === true,
            'and it is still collapsed'
        );
        expect(
            chunk?.entities.every((entity) => entity.type !== 'text_link') === true,
            'no link message appears without a thinkingLink'
        );
        expect(chunk?.linkPreviewOptions === undefined, 'no forced preview either');
    })
);

results.push(
    await runCase('the error display puts the link in front of the error line', async () => {
        const { buildErrorDisplay } = await import('../../src/telegram/formatters/error-display.js');
        const { THINKING_LINK_LABEL } = await import('../../src/telegram/formatters/thinking-link.js');

        const linkOnly = buildErrorDisplay({ thinkingLink: LINK_REF, errorMessage: 'boom' });
        expect(
            linkOnly.text === `${THINKING_LINK_LABEL}\n\n⚠ boom`,
            `link then the error line (got ${JSON.stringify(linkOnly.text)})`
        );
        expect(linkOnly.entities[0]?.type === 'text_link', 'the link stays clickable');
        expect(linkOnly.entities[0]?.url === LINK_REF.miniAppUrl, 'and points at the Mini App');
        expect(
            linkOnly.entities.every(
                (entity) => entity.type === 'text_link' || entity.type === 'italic'
            ),
            'no thinking quote is rendered in link mode'
        );
        const errorLine = linkOnly.entities.find((entity) => entity.type === 'italic');
        expect(
            errorLine !== undefined &&
                errorLine.offset === THINKING_LINK_LABEL.length + 2 &&
                errorLine.length === '⚠ boom'.length,
            'the error line is the italic tail'
        );

        // With the CoT's stats the line sits between the link and the error
        const withStats = buildErrorDisplay({
            thinkingLink: LINK_REF,
            thinkingLinkSummary: { words: 1234, segments: 3 },
            errorMessage: 'boom',
        });
        expect(
            withStats.text === `${THINKING_LINK_LABEL}\n共 1,234 词，发出约拆成 3 段\n\n⚠ boom`,
            `link, stats, then the error (got ${JSON.stringify(withStats.text)})`
        );
        expect(
            withStats.entities.filter((entity) => entity.type === 'italic').length === 2,
            'the stats and the error line are both italic'
        );
        expect(
            withStats.entities.every(
                (entity) => entity.type === 'text_link' || entity.type === 'italic'
            ),
            'no thinking quote appears in link mode'
        );

        // Thinking passed alongside the link is ignored: it lives behind the link
        const withThinking = buildErrorDisplay({
            thinking: '**SecretCoT**\n\nhidden',
            thinkingLink: LINK_REF,
            errorMessage: 'boom',
        });
        expect(!withThinking.text.includes('SecretCoT'), 'the thinking text is not rendered again');

        // A partial answer is kept between the link and the error line
        const withText = buildErrorDisplay({
            thinkingLink: LINK_REF,
            text: '#1 部分正文',
            errorMessage: 'boom',
            resolveContextLink: (number) => `https://t.me/c/1000000001/${number}`,
        });
        expect(
            withText.text === `${THINKING_LINK_LABEL}\n\n#1 部分正文\n\n⚠ boom`,
            `link, partial text, then the error (got ${JSON.stringify(withText.text)})`
        );
        expect(
            withText.entities.some(
                (entity) => entity.type === 'text_link' && entity.url?.endsWith('/1') === true
            ),
            'context numbers in the partial stay linkified'
        );

        // Without a link the legacy shape (collapsed quote) is unchanged
        const legacy = buildErrorDisplay({
            thinking: FIVE_SECTIONS,
            text: '部分正文',
            errorMessage: 'boom',
        });
        expect(
            legacy.entities.some((entity) => entity.type === 'expandable_blockquote'),
            'the legacy error display still collapses the thinking quote'
        );
        expect(legacy.text.includes('⚠ boom'), 'and still appends the error line');

        // Long partials are clamped: the error line always survives
        const long = buildErrorDisplay({
            thinkingLink: LINK_REF,
            text: '长正文'.repeat(2000),
            errorMessage: 'boom',
        });
        expect(long.text.length < 4096, `the clipped partial fits one message (got ${long.text.length})`);
        expect(long.text.includes('⚠ boom'), 'the error line is still there');
        expect(long.entities[0]?.type === 'text_link', 'and the link survived the clip');
    })
);

reportResults(results);
