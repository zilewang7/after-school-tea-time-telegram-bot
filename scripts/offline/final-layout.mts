/**
 * Offline cases for the final reply layout decision: when a split reply keeps
 * its chain of thought inline on the first message, when it moves behind the
 * long-CoT link message, and the chunk shapes both produce.
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';

const { LINK_COT_LENGTH, buildFinalChunks, renderedCoTLength, shouldLinkCoT } = await import(
    '../../src/reply/final-layout.js'
);
const { THINKING_LINK_LABEL } = await import('../../src/telegram/formatters/thinking-link.js');

const results: CaseResult[] = [];

/** Four CoT sections: ~2,600 rendered characters, long but under one message */
const mediumThinking = (): string =>
    Array.from({ length: 4 }, (_, index) => `**M${index}**\n\n${'推理'.repeat(325)}`).join('\n\n');

/** A body without paragraph breaks: the splitter would otherwise cut the CoT */
const flatBody = (): string => `正文：${'内容'.repeat(750)}`;

const LINK_REF = {
    token: 'a'.repeat(43),
    miniAppUrl: 'https://t.me/k_on_test_bot/panel?startapp=tabc',
    fastPageUrl: 'https://miniapp.test/t/abc',
};

results.push(
    await runCase('the link threshold is half a streaming message', async () => {
        expect(
            LINK_COT_LENGTH === 1950,
            `half of the 3,900 streaming budget (got ${LINK_COT_LENGTH})`
        );
        expect(
            shouldLinkCoT({ renderedThinking: LINK_COT_LENGTH - 1, chunkCount: 2 }) === false,
            'a CoT just under the threshold stays inline'
        );
        expect(
            shouldLinkCoT({ renderedThinking: LINK_COT_LENGTH, chunkCount: 2 }) === true,
            'a CoT at the threshold moves behind the link'
        );
        expect(
            shouldLinkCoT({ renderedThinking: 5000, chunkCount: 1 }) === false,
            'a single-message layout keeps the CoT inline'
        );
    })
);

results.push(
    await runCase('the rendered CoT length measures the quote the chat shows', async () => {
        expect(renderedCoTLength('') === 0, 'no thinking measures zero');
        const thinking = '**Plan**\n\nthink about it\n\n**Execute**\n\ndo the thing';
        const rendered = 'Plan\n\nthink about it\n\nExecute\n\ndo the thing';
        expect(
            renderedCoTLength(thinking) === rendered.length,
            `markdown markers are not counted (got ${renderedCoTLength(thinking)} vs ${rendered.length})`
        );
    })
);

results.push(
    await runCase('a split inline layout keeps the whole CoT on the first message', async () => {
        const thinking = mediumThinking();
        const chunks = buildFinalChunks({ text: flatBody(), thinking });
        expect(chunks.length > 1, `the reply needs more than one message (got ${chunks.length})`);
        const first = chunks[0];
        const quote = first?.entities.find((entity) => entity.type === 'expandable_blockquote');
        expect(quote !== undefined, 'the first message leads with the CoT quote');
        expect(
            quote !== undefined && quote.offset === 0 && quote.length === renderedCoTLength(thinking),
            `the quote covers the whole CoT (got ${quote?.length} vs ${renderedCoTLength(thinking)})`
        );
        expect(
            chunks.slice(1).every((chunk) => !chunk.text.includes('推理')),
            'later messages carry the body only'
        );
        expect(
            chunks.every((chunk) => chunk.text.length <= 4000),
            'every chunk fits the final message budget'
        );
    })
);

results.push(
    await runCase('the link layout leads with the link message and keeps the body whole', async () => {
        const thinking = mediumThinking();
        const chunks = buildFinalChunks({ text: flatBody(), thinking, thinkingLink: LINK_REF });
        expect(chunks.length === 2, `link message plus one body message (got ${chunks.length})`);
        const link = chunks[0];
        expect(
            link !== undefined && link.text.startsWith(THINKING_LINK_LABEL),
            'the link message leads'
        );
        expect(
            link !== undefined &&
                link.entities.some(
                    (entity) => entity.type === 'text_link' && entity.url === LINK_REF.miniAppUrl
                ),
            'the label links into the Mini App'
        );
        expect(
            link?.linkPreviewOptions !== undefined &&
                link.linkPreviewOptions.url === LINK_REF.fastPageUrl,
            'the link message carries the fast-page card'
        );
        expect(
            chunks.every((chunk) => !chunk.text.includes('推理')),
            'the CoT never appears in the chat text'
        );
        expect(chunks[1]?.text.includes('内容') === true, 'the body message carries the answer');
    })
);

reportResults(results);
