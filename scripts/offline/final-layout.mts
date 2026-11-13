/**
 * Offline cases for the final reply layout decision: when a split reply keeps
 * its chain of thought inline on the first message, when it moves behind the
 * long-CoT link message, when an overflowing GoogleSearch footer folds into one
 * compact link message at the end, and the chunk shapes all of them produce.
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';

const { LINK_COT_LENGTH, buildFinalChunks, renderedCoTLength, shouldLinkCoT } = await import(
    '../../src/reply/final-layout.js'
);
const { THINKING_LINK_LABEL } = await import('../../src/telegram/formatters/thinking-link.js');
const { buildFinalMessages } = await import(
    '../../src/telegram/formatters/final-message-builder.js'
);
const {
    buildGoogleSearchDocument,
    googleSearchFooterPlan,
    renderGoogleSearchFooter,
} = await import('../../src/telegram/formatters/google-search-document.js');
const { SEARCH_LINK_LABEL } = await import(
    '../../src/telegram/formatters/google-search-link.js'
);

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

/** The page pointer a folded footer message carries (the real one is signed) */
const SEARCH_REF = {
    token: 'payload.signature',
    url: 'https://miniapp.test/g/payload.signature',
};

/**
 * The 2026-11-13 incident footer: 131 linked queries, 3 sources, ~35 KB of
 * hrefs — it needs several Telegram messages on its own.
 */
const incidentSearchGrounding = () => ({
    provider: 'google' as const,
    searchQueries: Array.from({ length: 131 }, (_, index) => `查询 ${index + 1} 黑猫`),
    searchEntryPoint: {
        renderedContent: Array.from(
            { length: 131 },
            (_, index) =>
                `<a href="https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQ${index}${'x'.repeat(250)}">查询 ${index + 1} 黑猫</a>`
        ).join(''),
    },
    groundingChunks: [
        { web: { uri: 'https://source.example/a', title: 'Source A' } },
        { web: { uri: 'https://source.example/b', title: 'Source B' } },
        { web: { uri: 'https://source.example/c', title: 'Source C' } },
    ],
});

/** A footer that fits one message: two linked queries and numbered sources */
const smallSearchGrounding = (sourceCount = 1) => ({
    provider: 'google' as const,
    searchQueries: ['衣蛾 怎么消灭', '衣蛾 防治'],
    searchEntryPoint: {
        renderedContent:
            '<a href="https://www.google.com/search?q=moth">衣蛾 怎么消灭</a>' +
            '<a href="https://www.google.com/search?q=moth+2">衣蛾 防治</a>',
    },
    groundingChunks: Array.from({ length: sourceCount }, (_, index) => ({
        web: { uri: `https://g.example/guide-${index}`, title: `Garden guide ${index}` },
    })),
});

/** Two search steps: the folded stats line must add both up */
const twoSearchSteps = () => [
    {
        provider: 'google' as const,
        searchQueries: ['甲'],
        searchEntryPoint: {
            renderedContent: '<a href="https://www.google.com/search?q=a">甲</a>',
        },
        groundingChunks: [{ web: { uri: 'https://a.example', title: 'A' } }],
    },
    {
        provider: 'google' as const,
        searchQueries: ['乙', '丙'],
        groundingChunks: [
            { web: { uri: 'https://b.example', title: 'B' } },
            { web: { uri: 'https://c.example', title: 'C' } },
        ],
    },
];

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

results.push(
    await runCase('an overflowing search footer folds into one compact link message', async () => {
        const grounding = incidentSearchGrounding();
        const plan = googleSearchFooterPlan([grounding]);
        expect(plan === 'overflows', `the incident-sized footer needs several messages (got ${plan})`);

        const document = buildGoogleSearchDocument([grounding]);
        expect(
            document.queryCount === 131 && document.sourceCount === 3,
            `the document counts the incident's footer (got ${document.queryCount} queries / ${document.sourceCount} sources)`
        );

        const body = `正文：${'内容'.repeat(600)}`;
        // The answer on its own: the folded layout must add exactly one message
        const bodyOnly = buildFinalChunks({ text: body, thinking: '' });
        const chunks = buildFinalChunks({
            thinking: '',
            text: body,
            groundingData: [grounding],
            googleSearch: document,
            searchLink: SEARCH_REF,
        });

        // The prebuilt document only saves a second parse: the layout is the
        // same when the builder has to construct it from the grounding steps.
        const withoutDocument = buildFinalChunks({
            thinking: '',
            text: body,
            groundingData: [grounding],
            searchLink: SEARCH_REF,
        });
        expect(
            JSON.stringify(withoutDocument) === JSON.stringify(chunks),
            'the prebuilt document changes no chunk'
        );

        expect(
            chunks.length === bodyOnly.length + 1,
            `the layout is the answer's chunks plus one link message (got ${chunks.length} for ${bodyOnly.length} answer chunks)`
        );
        const link = chunks[chunks.length - 1];
        expect(
            link !== undefined && link.text.startsWith(SEARCH_LINK_LABEL),
            `the reply ends with the link message (got ${JSON.stringify(link?.text.slice(0, 24))})`
        );
        expect(
            link?.text.endsWith('共搜索 131 次，引用 3 条来源') === true,
            `the stats line counts queries and sources (got ${JSON.stringify(link?.text)})`
        );
        expect(
            link?.entities.some(
                (entity) =>
                    entity.type === 'text_link' &&
                    entity.offset === 0 &&
                    entity.url === SEARCH_REF.url
            ) === true,
            'the whole label links to the fast page'
        );
        expect(
            link?.entities.some((entity) => entity.type === 'italic') === true,
            'the stats line is italic'
        );
        expect(
            link?.linkPreviewOptions?.url === SEARCH_REF.url,
            `the link message carries the page card (got ${JSON.stringify(link?.linkPreviewOptions)})`
        );

        const answerChunks = chunks.slice(0, -1);
        expect(
            answerChunks.every((chunk) => chunk.linkPreviewOptions?.is_disabled === true),
            'every answer chunk disables its preview'
        );
        expect(
            answerChunks.every((chunk) => !chunk.text.includes('GoogleSearch')),
            'the footer title never appears in the answer'
        );
        expect(
            answerChunks.every((chunk) => !chunk.text.includes('Source A')),
            'the footer sources never appear in the answer'
        );
        expect(
            answerChunks.some((chunk) => chunk.text.includes('内容')),
            'the answer itself is still there'
        );
    })
);

results.push(
    await runCase('a footer that fits one message stays on the answer message', async () => {
        const grounding = smallSearchGrounding();
        expect(
            googleSearchFooterPlan([grounding]) === 'fits',
            'the small footer fits one message'
        );
        const document = buildGoogleSearchDocument([grounding]);

        const withDocument = buildFinalMessages({
            text: '短正文',
            groundingData: [grounding],
            googleSearch: document,
        });
        expect(withDocument.length === 1, `no extra message (got ${withDocument.length})`);
        expect(withDocument[0]?.text.includes('短正文') === true, 'the answer is there');
        expect(withDocument[0]?.text.includes('GoogleSearch') === true, 'the footer rides on it');
        expect(
            withDocument[0]?.text.includes('[1] Garden guide 0') === true,
            'with its numbered sources'
        );

        // The prebuilt document changes nothing: the fits case rides on the last
        // answer message either way, and no extra message is added.
        const withoutDocument = buildFinalMessages({ text: '短正文', groundingData: [grounding] });
        expect(
            JSON.stringify(withDocument) === JSON.stringify(withoutDocument),
            'the prebuilt document changes no chunk'
        );
        expect(
            withDocument[0]?.text.endsWith(renderGoogleSearchFooter(document).text) === true,
            'the whole footer rides on the answer message'
        );
        expect(
            withDocument[0]?.linkPreviewOptions?.url === document.firstQueryUrl,
            `the card stays on the first linked query (got ${JSON.stringify(withDocument[0]?.linkPreviewOptions)})`
        );
    })
);

results.push(
    await runCase('a footer that does not fit the tail goes out whole as its own message', async () => {
        // Five sources make the footer wider than the 180-character tail leaves
        const grounding = smallSearchGrounding(5);
        const document = buildGoogleSearchDocument([grounding]);
        const footerText = renderGoogleSearchFooter(document).text;

        const chunks = buildFinalMessages({
            text: '正文。'.repeat(100),
            groundingData: [grounding],
            googleSearch: document,
            maxLength: 180,
        });
        expect(chunks.length >= 2, `the answer and the footer need separate messages (got ${chunks.length})`);
        const footerChunk = chunks[chunks.length - 1];
        expect(
            footerChunk?.text === footerText,
            `the footer is never cut (got ${JSON.stringify(footerChunk?.text)})`
        );
        expect(
            chunks.slice(0, -1).every((chunk) => !chunk.text.includes('GoogleSearch')),
            'the answer messages hold no footer'
        );
        expect(
            footerChunk?.linkPreviewOptions?.url === document.firstQueryUrl,
            'the footer message carries the single card'
        );
        expect(
            chunks.slice(0, -1).every((chunk) => chunk.linkPreviewOptions?.is_disabled === true),
            'the answer messages disable their previews'
        );
    })
);

results.push(
    await runCase('without a page link an overflowing footer keeps the merged split', async () => {
        const grounding = incidentSearchGrounding();
        const document = buildGoogleSearchDocument([grounding]);
        const text = '正文。\n'.repeat(40);

        // The footer cannot fit one message and no page link is passed: the
        // merged fallback inside the two-phase layout is today's split, which
        // cuts the footer rather than dropping it.
        const chunks = buildFinalMessages({ text, groundingData: [grounding] });
        const withDocument = buildFinalMessages({
            text,
            groundingData: [grounding],
            googleSearch: document,
        });

        expect(chunks.length > 1, `the merged split cuts the footer (got ${chunks.length} chunks)`);
        expect(
            JSON.stringify(withDocument) === JSON.stringify(chunks),
            'the prebuilt document changes no chunk of the fallback'
        );
        expect(
            chunks.some((chunk) => chunk.text.includes('GoogleSearch')),
            'the footer stays in the reply'
        );
        expect(
            chunks.every((chunk) => !chunk.text.startsWith(SEARCH_LINK_LABEL)),
            'no link message is appended without a page link'
        );
        expect(
            chunks.filter((chunk) => chunk.linkPreviewOptions?.url !== undefined).length === 1,
            'exactly one chunk keeps the preview'
        );
    })
);

results.push(
    await runCase('an empty footer appends no link message', async () => {
        const withoutFooter = buildFinalChunks({ text: '正文', thinking: '', searchLink: SEARCH_REF });
        expect(
            withoutFooter.length === 1 && !withoutFooter[0]?.text.includes(SEARCH_LINK_LABEL),
            'a reply without a footer gets no link message'
        );
        expect(
            withoutFooter[0]?.linkPreviewOptions === undefined,
            'the answer keeps the normal preview policy'
        );

        const blankQueries = buildFinalChunks({
            thinking: '',
            text: '正文',
            groundingData: [{ provider: 'google' as const, searchQueries: ['   '] }],
            searchLink: SEARCH_REF,
        });
        expect(
            blankQueries.length === 1 && !blankQueries[0]?.text.includes(SEARCH_LINK_LABEL),
            'a footer with nothing to show gets no link message'
        );

        // A document that documents nothing is the same case: the stale page
        // link must not add an empty message.
        const emptyDocument = buildGoogleSearchDocument([]);
        const withDocument = buildFinalChunks({
            thinking: '',
            text: '正文',
            groundingData: [],
            googleSearch: emptyDocument,
            searchLink: SEARCH_REF,
        });
        expect(
            withDocument.length === 1 && !withDocument[0]?.text.includes(SEARCH_LINK_LABEL),
            'an empty footer document adds no message either'
        );
    })
);

results.push(
    await runCase('the stats line states whichever half the footer has', async () => {
        const queriesOnly = buildFinalMessages({
            text: '',
            groundingData: [
                {
                    searchQueries: ['甲', '乙'],
                    searchEntryPoint: {
                        renderedContent: '<a href="https://www.google.com/search?q=a">甲</a>',
                    },
                },
            ],
            searchLink: SEARCH_REF,
        });
        expect(queriesOnly.length === 1, `the link message is the whole reply (got ${queriesOnly.length})`);
        expect(
            queriesOnly[0]?.text.includes('共搜索 2 次') === true,
            `the query count is stated (got ${JSON.stringify(queriesOnly[0]?.text)})`
        );
        expect(
            queriesOnly[0]?.text.includes('条来源') === false,
            'no source count when the footer has no sources'
        );

        const sourcesOnly = buildFinalMessages({
            text: '',
            groundingData: [
                {
                    searchQueries: [],
                    groundingChunks: [{ web: { uri: 'https://a.example', title: 'A' } }],
                },
            ],
            searchLink: SEARCH_REF,
        });
        expect(sourcesOnly.length === 1, 'the sources-only footer folds the same way');
        expect(
            sourcesOnly[0]?.text.includes('引用 1 条来源') === true,
            `the source count is stated (got ${JSON.stringify(sourcesOnly[0]?.text)})`
        );
        expect(
            sourcesOnly[0]?.text.includes('共搜索') === false,
            'no query count when the footer has no queries'
        );
    })
);

results.push(
    await runCase('the folded stats add up every search step', async () => {
        const steps = twoSearchSteps();
        const document = buildGoogleSearchDocument(steps);
        expect(
            document.queryCount === 3 && document.sourceCount === 3,
            `both steps are counted (got ${document.queryCount} queries / ${document.sourceCount} sources)`
        );

        const chunks = buildFinalMessages({
            text: '正文',
            groundingData: steps,
            googleSearch: document,
            searchLink: SEARCH_REF,
        });
        expect(
            chunks[chunks.length - 1]?.text.includes('共搜索 3 次，引用 3 条来源') === true,
            `the stats line adds the steps up (got ${JSON.stringify(chunks[chunks.length - 1]?.text)})`
        );
        expect(
            chunks.slice(0, -1).every((chunk) => !chunk.text.includes('GoogleSearch')),
            'both footer blocks leave the answer'
        );
    })
);

reportResults(results);
