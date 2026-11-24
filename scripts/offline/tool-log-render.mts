/**
 * Offline cases for the Tools block's per-call log (design 2026-1119-1835):
 * the legacy shape stays byte for byte, the new shape renders numbered lines,
 * and the block is delivered in three tiers — inline, its own message, or the
 * public log page's link message.
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';

const { buildToolRecordParts, buildToolRecordSections, toolLogPlan } = await import(
    '../../src/telegram/formatters/tool-records-formatter.js'
);
const { TOOL_LOG_LINK_LABEL, renderToolLogLinkMessage, toToolLogLinkChunk } = await import(
    '../../src/telegram/formatters/tool-log-link.js'
);
const { buildFinalMessages } = await import(
    '../../src/telegram/formatters/final-message-builder.js'
);
const { buildGoogleSearchDocument } = await import(
    '../../src/telegram/formatters/google-search-document.js'
);
const { buildRichReplyBodyFromAnswer } = await import(
    '../../src/telegram/formatters/rich-reply-body.js'
);
const { buildRichLayoutOfVersion } = await import(
    '../../src/telegram/formatters/rich-layout-of-version.js'
);

const results: CaseResult[] = [];

/** The page pointer a folded Tools block carries (the real one is signed) */
const TOOL_LOG_REF = {
    token: 'payload.signature',
    url: 'https://miniapp.test/x/payload.signature',
};

/** A legacy grounding step: the only source of a detail line before the per-call log */
const legacyStep = () => ({
    provider: 'mcp' as const,
    searchQueries: ['searxng_web_search: 户鞘谷蛾 灭杀'],
    citations: [{ uri: 'https://a.example/moths' }],
});

/** Ten executed calls, each line short enough that the block still fits one message */
const tenCalls = () =>
    Array.from({ length: 10 }, (_, index) => ({
        name: 'history',
        argument: `search · 「灭蛾 方法 ${index + 1}」`,
        result: `${index + 3} 条命中`,
    }));

/** A per-call log too long for one Telegram message */
const overflowingCalls = () =>
    Array.from({ length: 160 }, (_, index) => ({
        name: 'history',
        argument: `read · h${index + 1}、h${index + 2}、h${index + 3}`,
        result: `3 条全文 · 1.2K 字`,
    }));

const versionOf = (overrides: Record<string, unknown>) => ({
    versionId: 1,
    createdAt: '2026-11-19T10:00:00.000Z',
    messageIds: [1],
    currentMessageId: 1,
    text: '正文',
    richAnswerMarkdown: '正文',
    wasStoppedByUser: false,
    ...overrides,
});

results.push(await runCase('the legacy shape stays byte for byte', async () => {
    const sections = buildToolRecordSections(
        { toolUsage: [{ name: 'searxng_web_search', count: 2 }] },
        [legacyStep(), legacyStep()]
    );
    expect(sections.length === 2, 'Tools and Sources blocks');
    expect(
        sections[0]?.text === 'Tools\ntool usage: searxng_web_search x2\nsearxng_web_search: 户鞘谷蛾 灭杀',
        `the legacy merged line, deduplicated (got ${JSON.stringify(sections[0]?.text)})`
    );
    expect(!(sections[0]?.text.includes('1. ') ?? false), 'no numbering on the legacy shape');

    // mode still leads the legacy body, as it always did
    const withMode = buildToolRecordSections(
        { mode: '16 agents', toolUsage: [{ name: 'web_search', count: 1 }] },
        []
    );
    expect(
        withMode[0]?.text === 'Tools\nmode: 16 agents\ntool usage: web_search x1',
        `legacy mode line first (got ${JSON.stringify(withMode[0]?.text)})`
    );
}));

results.push(await runCase('the per-call log renders numbered lines, usage first', async () => {
    const sections = buildToolRecordSections(
        {
            toolUsage: [
                { name: 'history', count: 2, failed: 1 },
                { name: 'fetch_image', count: 1 },
            ],
            toolCalls: [
                { name: 'history', argument: 'search · 「灭蛾 方法」', result: '10 条命中' },
                { name: 'history', argument: 'search · 「户鞘谷蛾」', result: '查询语法有误', failed: true },
                { name: 'fetch_image', argument: 'h101', result: 'img3 640×480', ms: 3_400 },
            ],
        },
        [legacyStep()]
    );
    const tools = sections[0]?.text ?? '';
    const lines = tools.split('\n');
    expect(
        lines[1] === 'tool usage: history x2（1 次失败） | fetch_image x1',
        `the usage line is the first line (got ${JSON.stringify(lines[1])})`
    );
    expect(
        lines[2] === '1. history: search · 「灭蛾 方法」 → 10 条命中',
        `numbered call line (got ${JSON.stringify(lines[2])})`
    );
    expect(
        lines[3] === '2. history: search · 「户鞘谷蛾」 → 失败：查询语法有误',
        `a failed call is marked (got ${JSON.stringify(lines[3])})`
    );
    expect(
        lines[4] === '3. fetch_image: h101 → img3 640×480 · 3.4s',
        `a slow call shows its duration (got ${JSON.stringify(lines[4])})`
    );
    // The legacy grounding-derived line must not be rendered a second time
    expect(
        tools.split('searxng_web_search: 户鞘谷蛾').length - 1 === 0,
        'the old searchQueries lines are suppressed when records exist'
    );
}));

results.push(await runCase('a fast call shows no duration and a fast duration is rounded', async () => {
    const sections = buildToolRecordSections(
        {
            toolUsage: [{ name: 'fetch_image', count: 2 }],
            toolCalls: [
                { name: 'fetch_image', argument: 's3', result: 'img1 800×600', ms: 900 },
                { name: 'fetch_image', argument: 's4', result: 'img2 800×600', ms: 12_340 },
            ],
        },
        []
    );
    const lines = (sections[0]?.text ?? '').split('\n');
    expect(!lines[2]?.includes('0.9s'), `a fast call hides its duration (got ${JSON.stringify(lines[2])})`);
    expect(
        lines[3] === '2. fetch_image: s4 → img2 800×600 · 12.3s',
        `a slow call keeps one decimal (got ${JSON.stringify(lines[3])})`
    );
}));

results.push(await runCase('the record cap says how many calls were dropped', async () => {
    const sections = buildToolRecordSections(
        {
            toolUsage: [{ name: 'history', count: 5 }],
            toolCalls: [{ name: 'history', argument: 'search · 「灭蛾」', result: '3 条命中' }],
            toolCallsTruncated: 4,
        },
        []
    );
    expect(
        sections[0]?.text.includes('…另有 4 次调用未记录'),
        `the truncation note (got ${JSON.stringify(sections[0]?.text)})`
    );
}));

results.push(await runCase('mode moves after the usage line in the new shape', async () => {
    const sections = buildToolRecordSections(
        {
            mode: '16 agents',
            toolUsage: [{ name: 'web_search', count: 1 }],
            toolCalls: [{ name: 'web_search', argument: '「灭蛾」', result: '3 条链接' }],
        },
        []
    );
    const lines = (sections[0]?.text ?? '').split('\n');
    expect(lines[1]?.startsWith('tool usage:'), `usage first (got ${JSON.stringify(lines[1])})`);
    expect(lines[2] === 'mode: 16 agents', `mode after it (got ${JSON.stringify(lines[2])})`);
}));

results.push(await runCase('the plan measures the whole block', async () => {
    expect(toolLogPlan(undefined, []) === 'none', 'no tools, no block');
    expect(toolLogPlan({ toolUsage: [{ name: 'web_search', count: 1 }] }, []) === 'fits', 'a small block fits');
    const overflow = toolLogPlan(
        { toolUsage: [{ name: 'history', count: 160 }], toolCalls: overflowingCalls() },
        []
    );
    expect(overflow === 'overflows', `a long block overflows (got ${overflow})`);

    // The document and its plan agree with the rendered section
    const parts = buildToolRecordParts(
        { toolUsage: [{ name: 'history', count: 160 }], toolCalls: overflowingCalls() },
        []
    );
    expect(parts.tools !== null && parts.document.callLines.length === 160, 'the document keeps every call');
}));

results.push(await runCase('classic: a block that does not fit the answer tail moves whole', async () => {
    const text = '正文内容。'.repeat(750); // 3,750 chars: almost no room left in the answer
    const chunks = buildFinalMessages({
        text,
        agentStats: {
            toolUsage: [{ name: 'history', count: 10 }],
            toolCalls: tenCalls(),
        },
    });
    expect(chunks.length === 2, `the block gets its own message (got ${chunks.length} chunks)`);
    expect(!chunks[0]?.text.includes('Tools'), 'the answer message carries no block');
    const tools = chunks[1]?.text ?? '';
    expect(tools.startsWith('Tools\n'), `the second message starts with the block (got ${JSON.stringify(tools.slice(0, 20))})`);
    expect(tools.includes('10. history: search · 「灭蛾 方法 10」 → 12 条命中'), 'the whole block is on it');
    expect(
        (chunks[1]?.entities ?? []).some((entity) => entity.type === 'expandable_blockquote'),
        'and it is still one collapsed blockquote'
    );
}));

results.push(await runCase('classic: an overflowing block folds into the link message', async () => {
    const chunks = buildFinalMessages({
        text: '正文',
        agentStats: {
            toolUsage: [{ name: 'history', count: 160 }],
            toolCalls: overflowingCalls(),
        },
        toolsLink: TOOL_LOG_REF,
    });
    expect(chunks.length === 2, `the answer and one link message (got ${chunks.length})`);
    const body = chunks[0];
    expect(!body?.text.includes('Tools'), 'the inline block is left out');
    expect(
        body?.linkPreviewOptions !== undefined && body.linkPreviewOptions.is_disabled === true,
        'the body carries no preview card'
    );
    const link = chunks[1];
    expect(
        link?.text.startsWith(TOOL_LOG_LINK_LABEL),
        `the last message is the link (got ${JSON.stringify(link?.text.slice(0, 30))})`
    );
    expect(
        link?.text.includes('tool usage: history x160'),
        `the usage front line rides under it (got ${JSON.stringify(link?.text)})`
    );
    expect(link?.linkPreviewOptions?.url === TOOL_LOG_REF.url, 'its card points at the page');
    expect(
        (link?.entities ?? []).some(
            (entity) => entity.type === 'text_link' && entity.url === TOOL_LOG_REF.url
        ),
        'the label links to the page'
    );
}));

results.push(await runCase('the link message renders the usage line verbatim', async () => {
    const parts = buildToolRecordParts(
        {
            toolUsage: [{ name: 'history', count: 2, failed: 1 }],
            toolCalls: [
                { name: 'history', argument: 'search · 「灭蛾」', result: '3 条命中' },
                { name: 'history', argument: 'search · 「衣蛾」', result: '查询语法有误', failed: true },
            ],
        },
        []
    );
    const message = renderToolLogLinkMessage(TOOL_LOG_REF, parts.document);
    expect(
        message.text === `${TOOL_LOG_LINK_LABEL}\ntool usage: history x2（1 次失败）`,
        `label then usage line (got ${JSON.stringify(message.text)})`
    );
    expect(
        JSON.stringify(toToolLogLinkChunk(TOOL_LOG_REF, parts.document).linkPreviewOptions) ===
            JSON.stringify({ url: TOOL_LOG_REF.url, show_above_text: false }),
        'the chunk pins the card to the page'
    );
}));

results.push(await runCase('rich: a folded block leaves the body and returns as the link chunk', async () => {
    const version = versionOf({
        groundingData: [legacyStep()],
        agentStats: {
            toolUsage: [{ name: 'history', count: 160 }],
            toolCalls: overflowingCalls(),
        },
    });
    const replay = buildRichLayoutOfVersion({
        version,
        toolsLink: TOOL_LOG_REF,
        media: [],
    });
    expect(replay.chunks.length === 2, `body and link chunk (got ${replay.chunks.length})`);
    const body = replay.chunks[0];
    const bodyMarkdown = body !== undefined && 'richMarkdown' in body ? body.richMarkdown : null;
    expect(bodyMarkdown !== null, 'the first chunk is the rich body');
    expect(!(bodyMarkdown ?? '').includes('Tools'), 'the folded block is not in the body');
    const link = replay.chunks[1];
    const linkText = link !== undefined && 'text' in link ? link.text : '';
    expect(
        linkText.startsWith(TOOL_LOG_LINK_LABEL),
        `the link chunk follows (got ${JSON.stringify(linkText.slice(0, 20))})`
    );
}));

results.push(await runCase('classic: an hN ref becomes a text_link to its archived message', async () => {
    const refUrl = 'https://t.me/c/1415974153/1123456';
    const agentStats = {
        toolUsage: [{ name: 'history', count: 2 }],
        toolCalls: [
            {
                name: 'history',
                argument: 'around h45 · 10 分钟',
                result: '39 条消息',
                links: [{ text: 'h45', url: refUrl }],
            },
            {
                name: 'history',
                argument: 'read · h45、h46',
                result: '2 条全文',
                links: [
                    { text: 'h45', url: refUrl },
                    { text: 'h46', url: 'https://t.me/c/1415974153/1123457' },
                    // Not in the line any more: the document drops it, so it never renders
                    { text: 'h47', url: 'https://t.me/c/1415974153/1123458' },
                ],
            },
        ],
    };
    const parts = buildToolRecordParts(agentStats, []);
    const tools = parts.tools;
    expect(tools !== null, 'the Tools block exists');
    const text = tools?.text ?? '';
    const links = (tools?.entities ?? []).filter((entity) => entity.type === 'text_link');
    expect(
        links.length === 3 && links.every((entity) => text.slice(entity.offset, entity.offset + entity.length) === 'h45' || text.slice(entity.offset, entity.offset + entity.length) === 'h46'),
        `every hN is a link entity (got ${JSON.stringify(links.map((entity) => text.slice(entity.offset, entity.offset + entity.length)))})`
    );
    expect(
        links[0]?.url === refUrl && links[1]?.url === refUrl,
        `the same ref keeps its URL (got ${JSON.stringify(links.map((entity) => entity.url))})`
    );
    expect(
        parts.document.callLinks[1]?.length === 2,
        `a span cut from the line is dropped (got ${JSON.stringify(parts.document.callLinks[1])})`
    );
    // The measurement is the same section the chat sends: adding entities cannot change the plan
    expect(toolLogPlan(agentStats, []) === 'fits', 'a normal block still fits one message with its links');

    // ... and the entity survives into the final chunk the chat sends
    const chunks = buildFinalMessages({ text: '正文', agentStats });
    const sentChunk = chunks.at(-1);
    const sent = sentChunk?.entities.filter((entity) => entity.type === 'text_link') ?? [];
    expect(sent.length === 3, `the sent message carries the links (got ${sent.length})`);
    expect(sent[0]?.url === refUrl, 'the sent link opens the archived message');
    const firstSent = sent[0];
    expect(
        sentChunk !== undefined &&
            firstSent !== undefined &&
            sentChunk.text.slice(firstSent.offset, firstSent.offset + firstSent.length) === 'h45',
        `the entity covers the ref inside the blockquote (got ${JSON.stringify(
            sentChunk === undefined || firstSent === undefined
                ? null
                : sentChunk.text.slice(firstSent.offset, firstSent.offset + firstSent.length)
        )})`
    );
}));

results.push(await runCase('rich: an hN ref becomes an anchor in the rich body', async () => {
    const body = buildRichReplyBodyFromAnswer({
        answerMarkdown: '正文',
        googleSearch: buildGoogleSearchDocument([]),
        agentStats: {
            toolUsage: [{ name: 'fetch_image', count: 1 }],
            toolCalls: [
                {
                    name: 'fetch_image',
                    argument: 'h101',
                    result: 'img3 640×480',
                    links: [{ text: 'h101', url: 'https://t.me/c/1415974153/1123456' }],
                },
            ],
        },
        wasStoppedByUser: false,
        searchFolded: false,
    });
    expect(body !== null && body.includes('<a href="https://t.me/c/1415974153/1123456">h101</a>'), 'the ref is an anchor');
}));

results.push(await runCase('rich: the body keeps the Sources block when Tools folds', async () => {
    const body = buildRichReplyBodyFromAnswer({
        answerMarkdown: '正文',
        googleSearch: buildGoogleSearchDocument([]),
        groundingData: [legacyStep()],
        agentStats: {
            toolUsage: [{ name: 'history', count: 2 }],
            toolCalls: overflowingCalls().slice(0, 2),
        },
        wasStoppedByUser: false,
        searchFolded: false,
        toolsFolded: true,
    });
    expect(body !== null && !body.includes('Tools'), 'the Tools block is left out');
    expect(body !== null && body.includes('Sources'), 'the Sources block stays');
}));

reportResults(results);
