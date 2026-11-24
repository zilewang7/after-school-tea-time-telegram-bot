/**
 * Offline cases for the clickable `hN` refs of the Tools block (design
 * 2026-1120-1617): the handlers link an hN to its archived message, the record
 * stores the span, one reply's storage is bounded, and the document hands the
 * same spans to the chat block and the public page.
 *
 * The handlers are exercised where their wiring matters (history-tools.mts and
 * fetch-image-batch.mts); this file pins the contract between them.
 *
 * Run: npx tsx scripts/offline/tool-log-links.mts
 */
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';

// Several project modules read the env at import time; keep the scratch DB honest.
for (const key of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'GROK_API_KEY', 'MIMO_API_KEY']) {
    process.env[key] ||= 'offline-placeholder';
}
process.env.BOT_TOKEN ||= '123456789:AAFakeOfflineTokenForToolLogLinksTests_0123';
process.env.WIDGET_RENDER_URL = '';
delete process.env.ALLOWED_CHAT_IDS;
delete process.env.TOOL_LOG_LINK;

await setupOfflineDb();

const { createHistoryState } = await import('../../src/reply/tools/history-state.js');
const { historyRefLinks } = await import('../../src/reply/tools/history-tool-shared.js');
const { describeFetchImageLinks } = await import('../../src/reply/tools/fetch-image-tool.js');
const { TOOL_LOG_MAX_LINKS } = await import('../../src/shared/tool-log.js');
const { buildToolCallRecord } = await import('../../src/ai/tools/tool-call-record.js');
const { createToolUsageTally } = await import('../../src/ai/tools/tool-round.js');
const documents = await import('../../src/telegram/formatters/tool-log-document.js');
const { buildToolRecordParts } = await import('../../src/telegram/formatters/tool-records-formatter.js');

type AgentStats = import('../../src/ai/types.js').AgentStats;
type ToolCallLink = import('../../src/ai/types.js').ToolCallLink;
type ToolResult = import('../../src/ai/tools/tool-types.js').ToolResult;

const CHANNEL = 1415974153;
const OTHER_CHANNEL = 2311128579;

/** One archived message in a fresh history state; h1, h2, … in registration order */
const remembered = (
    state: ReturnType<typeof createHistoryState>,
    channelId: number,
    messageId: number
) =>
    state.remember({
        channelId,
        messageId,
        timestamp: 1_760_000_000,
        fromId: 5001,
        fromName: '张三',
        fromIsBot: false,
        indexedHtml: '被记住的消息',
    });

const results: CaseResult[] = [];

results.push(
    await runCase('historyRefLinks links only known hN refs', async () => {
        const state = createHistoryState();
        remembered(state, CHANNEL, 1123456);
        remembered(state, OTHER_CHANNEL, 2600);

        const links = historyRefLinks(state, [
            'h1',
            'h2',
            '#3',
            'https://t.me/c/1415974153/1123456',
            'h99',
            'h1',
        ]);
        expect(
            JSON.stringify(links) ===
                JSON.stringify([
                    { text: 'h1', url: `https://t.me/c/${CHANNEL}/1123456` },
                    { text: 'h2', url: `https://t.me/c/${OTHER_CHANNEL}/2600` },
                ]),
            `known hN refs, first occurrence each, no other kind (got ${JSON.stringify(links)})`
        );
    })
);

results.push(
    await runCase('fetch_image links its history/histories refs', async () => {
        const state = createHistoryState();
        remembered(state, CHANNEL, 1123456);
        remembered(state, CHANNEL, 1123457);

        const single = describeFetchImageLinks({ history: 'h1' }, state);
        expect(
            JSON.stringify(single) === JSON.stringify([{ text: 'h1', url: `https://t.me/c/${CHANNEL}/1123456` }]),
            `a single history ref (got ${JSON.stringify(single)})`
        );
        const many = describeFetchImageLinks({ histories: ['h1', 'h2', 'https://t.me/c/1415974153/1'] }, state);
        expect(
            JSON.stringify(many) ===
                JSON.stringify([
                    { text: 'h1', url: `https://t.me/c/${CHANNEL}/1123456` },
                    { text: 'h2', url: `https://t.me/c/${CHANNEL}/1123457` },
                ]),
            `plural refs, t.me refs skipped (got ${JSON.stringify(many)})`
        );
        expect(describeFetchImageLinks({ history: 'h1' }, undefined).length === 0, 'no archive lane, no links');
        expect(describeFetchImageLinks({ url: 'https://example.com/a.png' }, state).length === 0, 'other lanes carry none');
    })
);

results.push(
    await runCase('the record keeps only openable spans that are still in the line', async () => {
        const call = { id: 'c1', name: 'history', argumentsJson: '{}' };
        const resultOf = (links: readonly ToolCallLink[]): ToolResult => ({
            content: 'ok',
            isError: false,
            images: [],
            record: null,
            trace: { argument: 'around h45 · 10 分钟', result: '39 条消息', links },
        });

        const record = buildToolCallRecord(
            call,
            resultOf([
                { text: 'h45', url: 'https://t.me/c/1415974153/1123456' },
                { text: 'h45', url: 'https://t.me/c/1415974153/1123456' },
                { text: 'h46', url: 'javascript:alert(1)' },
                { text: 'h47', url: 'https://t.me/c/1415974153/1123458' },
            ]),
            10
        );
        expect(
            JSON.stringify(record.links) ===
                JSON.stringify([{ text: 'h45', url: 'https://t.me/c/1415974153/1123456' }]),
            `one deduplicated span survives (got ${JSON.stringify(record.links)})`
        );

        const withoutLinks = buildToolCallRecord(call, resultOf([]), 10);
        expect(!('links' in withoutLinks), 'a call without links keeps its old shape');

        const sixLinks = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((text, index) => ({
            text,
            url: `https://t.me/c/${CHANNEL}/${1123400 + index}`,
        }));
        const many = buildToolCallRecord(
            call,
            {
                ...resultOf([]),
                trace: { argument: 'read · h1、h2、h3、h4、h5、h6', result: '6 条全文', links: sixLinks },
            },
            10
        );
        expect(many.links?.length === 4, `at most four spans per call (got ${JSON.stringify(many.links?.length)})`);
    })
);

results.push(
    await runCase('the per-reply link budget bounds the stored spans', async () => {
        const initialCalls = [
            {
                name: 'history',
                argument: 'read · h1',
                result: '1 条全文',
                // One record with the budget all but spent; the tally only trims new ones
                links: Array.from({ length: TOOL_LOG_MAX_LINKS - 1 }, (_, index) => ({
                    text: `h${index + 1}`,
                    url: `https://t.me/c/${CHANNEL}/${1123400 + index}`,
                })),
            },
        ];
        const tally = createToolUsageTally([], initialCalls);
        tally.record({
            name: 'history',
            argument: 'read · h45、h46',
            result: '2 条全文',
            links: [
                { text: 'h45', url: 'https://t.me/c/1415974153/1' },
                { text: 'h46', url: 'https://t.me/c/1415974153/2' },
            ],
        });
        const calls = tally.calls();
        expect(calls[1]?.links?.length === 1, `only the remaining budget is kept (got ${JSON.stringify(calls[1]?.links)})`);
        expect(calls[1]?.argument === 'read · h45、h46', 'the line itself is untouched');
    })
);

results.push(
    await runCase('the document carries the spans per call line, and only those still shown', async () => {
        const agentStats: AgentStats = {
            toolUsage: [{ name: 'history', count: 2 }],
            toolCalls: [
                {
                    name: 'history',
                    argument: 'around h45 · 10 分钟',
                    result: '39 条消息',
                    links: [{ text: 'h45', url: 'https://t.me/c/1415974153/1123456' }],
                },
                {
                    name: 'history',
                    argument: 'read · h45、h46',
                    result: '2 条全文',
                    links: [
                        { text: 'h45', url: 'https://t.me/c/1415974153/1123456' },
                        { text: 'h46', url: 'https://t.me/c/1415974153/1123457' },
                        // The line is unchanged text, this span was never part of it
                        { text: 'h47', url: 'https://t.me/c/1415974153/1123458' },
                    ],
                },
            ],
        };
        const document = documents.buildToolLogDocument(agentStats, []);
        expect(document.callLinks.length === 2 && document.callLinks[0]?.length === 1, 'one span on the around line');
        expect(document.callLinks[1]?.length === 2, `the absent h47 is dropped (got ${JSON.stringify(document.callLinks[1])})`);

        const entries = documents.toolLogBodyLineEntries(document);
        expect(
            JSON.stringify(entries.map((entry) => entry.text)) === JSON.stringify(documents.toolLogBodyLines(document)),
            'the entries and the plain lines are the same body'
        );
        // usage line first, then the calls
        expect(entries[1]?.text === '1. history: around h45 · 10 分钟 → 39 条消息', 'entries keep display order');
        expect(entries[1]?.links.length === 1, 'the call line carries its span');
        expect(entries[0]?.links.length === 0, 'the usage line carries none');

        const parts = buildToolRecordParts(agentStats, []);
        const text = parts.tools?.text ?? '';
        const entities = (parts.tools?.entities ?? []).filter((entity) => entity.type === 'text_link');
        expect(entities.length === 3, `three link entities in the section (got ${entities.length})`);
        expect(
            text.slice(entities[0]?.offset ?? 0, (entities[0]?.offset ?? 0) + (entities[0]?.length ?? 0)) === 'h45',
            'the first span covers exactly the ref'
        );
        expect(entities[0]?.url === 'https://t.me/c/1415974153/1123456', 'the span opens the archived message');
    })
);

results.push(
    await runCase('a version without spans renders exactly as before', async () => {
        const stats: AgentStats = {
            toolUsage: [{ name: 'read_history', count: 1 }],
            toolCalls: [{ name: 'read_history', argument: 'h45', result: '1 条全文' }],
        };
        const document = documents.buildToolLogDocument(stats, []);
        expect(
            JSON.stringify(document.callLinks) === JSON.stringify([[]]),
            `a stored version without links carries empty span lists (got ${JSON.stringify(document.callLinks)})`
        );
        const parts = buildToolRecordParts(stats, []);
        expect(
            (parts.tools?.entities ?? []).every((entity) => entity.type !== 'text_link'),
            'no link entities appear for an old version'
        );
    })
);

reportResults(results);
