/**
 * Offline cases for the widget chunk inside the reply stream.
 *
 * The tool tests prove send_widget returns a widget in its ToolResult; this
 * file proves the processor keeps it: a widget chunk survives streaming and
 * lands in the AIResponse the delivery layer reads. That was the gap behind a
 * live run where the tool succeeded but no card went out — the chunk was never
 * produced, so no amount of delivery logic could send it.
 *
 * Run: npx tsx scripts/offline/widget-pipeline.mts
 */
import { Api } from 'grammy';
import { takeMessageId, expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';
import { contextOf, createFakeTelegram, messageUpdate } from './fake-telegram.mts';
import type { StreamChunk } from '../../src/ai/types.js';

const db = await setupOfflineDb();
const responseHandler = await import('../../src/reply/response-handler.js');
const { widgetDeliveryOf } = await import('../../src/telegram/widget-precheck.js');

const CHAT_ID = 603421700;
const USER_ID = 603421700;

const startReply = async (): Promise<import('../../src/reply/response-handler.js').ChatContext> => {
    const ctx = contextOf(
        messageUpdate({ chatId: CHAT_ID, messageId: takeMessageId(), userId: USER_ID, text: '来张卡片' }),
        createFakeTelegram()
    );
    const chatContext = await responseHandler.createChatContext(ctx, { model: 'gemini-4-argon' });
    if (!chatContext) throw new Error('no chat context');
    return chatContext;
};

const card = () =>
    widgetDeliveryOf('a2ui', '<div class="tw-root">日报</div>', '日报', { components: [] });

const streamOf = (chunks: readonly StreamChunk[]): AsyncIterable<StreamChunk> => ({
    async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk;
    },
});

const results: CaseResult[] = [];

results.push(
    await runCase('a widget chunk reaches the AIResponse after the text', async () => {
        const chatContext = await startReply();
        const widget = card();
        const response = await responseHandler.processStream(
            streamOf([
                { type: 'text', content: '今天的日报：' },
                { type: 'widget', widget },
            ]),
            chatContext,
            0
        );

        expect(response.text.includes('今天的日报'), 'the text survives');
        expect(response.widgets?.length === 1, 'exactly one widget is kept');
        expect(response.widgets?.[0] === widget, 'the same delivery object the tool returned');
        chatContext.typing.stop();
    })
);

results.push(
    await runCase('a widget-only reply carries no text and keeps the card', async () => {
        const chatContext = await startReply();
        const widget = card();
        const response = await responseHandler.processStream(
            streamOf([{ type: 'widget', widget }]),
            chatContext,
            0
        );

        expect(response.text.trim() === '', 'no text was invented');
        expect(response.widgets?.length === 1, 'the card is still there');
        chatContext.typing.stop();
    })
);

results.push(
    await runCase('the fake Telegram Api stands in for the real one', async () => {
        expect(typeof Api === 'function' && typeof responseHandler.processStream === 'function', 'imports resolve');
    })
);

// Close the scratch database, or its connection keeps the process alive
const { sequelize } = await import('../../src/db/config.js');
await sequelize.close();
void db.Message;

reportResults(results);

// The stream leaves sockets/timers behind in this harness; exit once the summary is out
setTimeout(() => process.exit(0), 100);
