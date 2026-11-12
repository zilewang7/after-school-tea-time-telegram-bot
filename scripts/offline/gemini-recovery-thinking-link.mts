/**
 * Case 14 of the round-recovery test plan (design 2026-1112-1123 §11): a
 * Gemini round whose thinking already filled a message (link mode on) breaks
 * mid-stream and is retried in place. Driven through the real processStream
 * and sendFinalResponse against the fake Telegram API and a scratch database:
 * the thinking of both attempts, with the marker between them, reaches the
 * live thinking page and the stored version.
 *
 * Run: npx tsx scripts/offline/gemini-recovery-thinking-link.mts
 */
process.env.WEBAPP_PUBLIC_URL = 'https://miniapp.test';
process.env.BOT_USER_NAME = 'k_on_test_bot';
process.env.WEBAPP_BOT_SHORT_NAME = 'panel';
delete process.env.THINKING_LINK;
delete process.env.GEMINI_CLIENT_TOOLS;

import { expect, reportResults, runCase, setupOfflineDb, takeMessageId, type CaseResult } from './harness.mts';
import {
    contextOf,
    createFakeTelegram,
    endOpenReplies,
    messageUpdate,
    quietly,
    trackReply,
} from './fake-telegram.mts';
import { createFakeVertex, midStreamErrorReply, sseReply } from './support/fake-vertex.mts';
import type { ToolHandler } from '../../src/ai/tools/index.js';

await setupOfflineDb();
const responseHandler = await import('../../src/reply/response-handler.js');
const linkService = await import('../../src/panel/thinking/thinking-link-service.js');
const thinkingStreamModule = await import('../../src/panel/thinking/thinking-stream.js');
const dbIndex = await import('../../src/db/index.js');
const { GeminiPlatform } = await import('../../src/ai/platforms/gemini-platform.js');
const { createTurnTools } = await import('../../src/ai/tools/index.js');
const { createUsageSink } = await import('../../src/ai/usage/index.js');

const json = (value: unknown): string => JSON.stringify(value);

const USER_ID = 603421700;
const MODEL = 'gemini-3.8-flash';
const CHAT_ID = -1009999100001;

const vertex = createFakeVertex();

/** Waits return at once; the jitter is pinned */
class InstantGeminiPlatform extends GeminiPlatform {
    readonly sleeps: number[] = [];

    protected override sleep(ms: number, signal?: AbortSignal): Promise<void> {
        this.sleeps.push(ms);
        return signal?.aborted ? Promise.reject(new Error('Aborted')) : Promise.resolve();
    }
}
const platform = new InstantGeminiPlatform({ client: vertex.client, random: () => 0.5 });

const lookup: ToolHandler = {
    definition: { name: 'lookup_a', description: 'Look a topic up', inputSchema: { type: 'object', properties: {} } },
    execute: async () => ({ content: 'found', isError: false, images: [], record: null }),
};

const thoughtEvent = (text: string) => ({ candidates: [{ content: { role: 'model', parts: [{ text, thought: true }] } }] });

/** Six sections of ~700 characters: just over one message, so link mode starts */
const longThinking = (label: string): string[] =>
    Array.from({ length: 6 }, (_, index) => `**${label}${index}**\n\n${'推理'.repeat(350)}\n\n`);

const MARKER = '\n\n〔第 1 轮生成中断，已自动重试，以下为重新生成的思考〕\n\n';

const results: CaseResult[] = [];

results.push(
    await runCase('14. link mode: the thinking of both attempts reaches the live page and the stored version', async () => {
        const firstThinking = longThinking('A');
        const secondThinking = longThinking('B');
        vertex.reset([
            midStreamErrorReply(firstThinking.map(thoughtEvent), 429, 'Resource exhausted. Please try again later.'),
            sseReply([
                ...secondThinking.map(thoughtEvent),
                {
                    candidates: [{ content: { role: 'model', parts: [{ text: '重试之后的答案。' }] }, finishReason: 'STOP' }],
                    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
                },
            ]),
        ]);

        const telegram = createFakeTelegram();
        const ctx = contextOf(
            messageUpdate({ chatId: CHAT_ID, messageId: takeMessageId(), userId: USER_ID, text: '想个难题' }),
            telegram
        );
        const chatContext = await responseHandler.createChatContext(ctx, { model: MODEL });
        if (!chatContext) throw new Error('no chat context');
        trackReply(chatContext);
        const { session } = chatContext;
        const usageSink = createUsageSink();

        const response = await quietly(async () => {
            const stream = await platform.sendMessage([{ role: 'user', content: [{ type: 'text', text: '想个难题' }] }], {
                model: MODEL,
                systemPrompt: 'offline system prompt',
                tools: createTurnTools([lookup]),
                signal: session.streamController.signal,
                usageSink,
            });
            return responseHandler.processStream(stream, chatContext, 0);
        });
        chatContext.typing.stop();

        expect(vertex.requests.length === 2 && json(platform.sleeps) === '[15000]', `the round was retried once (got ${vertex.requests.length})`);
        expect(session.thinkingLink !== undefined, 'the first attempt thinking activated link mode');
        expect(response.text.includes('重试之后的答案。'), `the answer of the retry is the body (got ${json(response.text)})`);

        const expectedThinking = `${firstThinking.join('')}${MARKER}${secondThinking.join('')}`;
        const attemptKey = linkService.thinkingAttemptKeyOf({
            chatId: CHAT_ID,
            firstMessageId: session.firstMessageId,
            versionId: 1,
        });
        const live = thinkingStreamModule.thinkingStream.read(attemptKey);
        expect(
            live?.text === expectedThinking,
            `the live page has both attempts, the marker between them (got ${live?.text.length ?? 0} chars, expected ${expectedThinking.length})`
        );

        await quietly(() => responseHandler.sendFinalResponse(chatContext, response));

        const stored = await dbIndex.getBotResponse(CHAT_ID, session.firstMessageId);
        const version = stored?.getVersions().at(-1);
        expect(
            version?.thinkingText === expectedThinking,
            `the stored version keeps both attempts (got ${version?.thinkingText?.length ?? 0} chars)`
        );
        expect(version?.text.includes('重试之后的答案。') === true, 'and the answer');
        expect(usageSink.totals().roundRetries === 1 && usageSink.totals().rounds === 1, 'one retry, one round');
    })
);

endOpenReplies();
reportResults(results);
