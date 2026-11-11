/**
 * Offline cases for the long-CoT link mode in the streaming state machine.
 *
 * A chain of thought that fills a Telegram message is delivered as one link
 * message (streaming: link + last-two-sections preview; once the answer starts:
 * the pure link with its preview card), while the body streams into a
 * continuation. These cases drive the real `processStream` / `sendFinalResponse`
 * / `handleResponseError` against the fake Telegram API and a scratch database:
 *
 * - activation from the streaming overflow trigger, and the DB row behind it;
 * - the streaming shape (link + bare quote preview, no preview card yet);
 * - the answer-start transition: link finalized, continuation opened, card set,
 *   later thinking no longer shown;
 * - final delivery: the emitted link is not re-sent, the version stores the
 *   token and the full (200k-bounded) thinking;
 * - version replay through refreshToFinalState;
 * - error before the answer (link + error line), thinking-only replies, and a
 *   link reply carrying one image (the link message must survive);
 * - thinking that only grows after the answer starts never activates link mode;
 * - the switch off / no public URL falls back to the legacy split;
 * - the 200k full-thinking buffer decoupled from the 10k display buffer.
 *
 * Run: npx tsx scripts/offline/thinking-link.mts
 */
process.env.WEBAPP_PUBLIC_URL = 'https://miniapp.test';
process.env.BOT_USER_NAME = 'k_on_test_bot';
process.env.WEBAPP_BOT_SHORT_NAME = 'panel';
delete process.env.THINKING_LINK;

import {
    expect,
    reportResults,
    runCase,
    setupOfflineDb,
    takeMessageId,
    type CaseResult,
} from './harness.mts';
import { contextOf, createFakeTelegram, messageUpdate, quietly, waitUntil } from './fake-telegram.mts';
import type { ResponseState, StreamChunk } from '../../src/ai/types.js';

const db = await setupOfflineDb();
const responseHandler = await import('../../src/reply/response-handler.js');
const linkService = await import('../../src/panel/thinking/thinking-link-service.js');
const thinkingStreamModule = await import('../../src/panel/thinking/thinking-stream.js');
const thinkingStore = await import('../../src/panel/thinking/thinking-store.js');
const dbIndex = await import('../../src/db/index.js');

const { THINKING_LINK_LABEL } = await import('../../src/telegram/formatters/thinking-link.js');

const USER_ID = 603421700;
/** The reply's model; the link page shows it, the test only needs it stable */
const MODEL = 'gemini-4-argon';

/** A PNG's first bytes: enough for the mime sniff the delivery does */
const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlZkAAAAASUVORK5CYII=',
    'base64'
);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One chat per case: the edit coordinator paces calls per chat */
let nextChatId = -1009999000000;
const nextChat = (): number => (nextChatId -= 1);

/** One section is ~700 chars, so six sections are just over one message */
const longThinking = (): string =>
    Array.from({ length: 6 }, (_, index) => `**S${index}**\n\n${'推理'.repeat(350)}`).join('\n\n');

const thinkingChunks = (thinking: string, chunkSize = 500): StreamChunk[] => {
    const chunks: StreamChunk[] = [];
    for (let index = 0; index < thinking.length; index += chunkSize) {
        chunks.push({ type: 'thinking', content: thinking.slice(index, index + chunkSize) });
    }
    return chunks;
};

const thinkingSteps = (thinking: string, chunkSize = 500): StreamStep[] =>
    thinkingChunks(thinking, chunkSize).map((chunk): StreamStep => ({ chunk }));

type StreamStep = { chunk: StreamChunk } | { waitMs: number };

const streamOf = (steps: readonly StreamStep[]): AsyncIterable<StreamChunk> => ({
    async *[Symbol.asyncIterator]() {
        for (const step of steps) {
            if ('waitMs' in step) {
                await sleep(step.waitMs);
                continue;
            }
            yield step.chunk;
        }
    },
});

interface StartedReply {
    readonly telegram: ReturnType<typeof createFakeTelegram>;
    readonly chatContext: import('../../src/reply/response-handler.js').ChatContext;
    readonly chatId: number;
    readonly firstMessageId: number;
}

const startReply = async (): Promise<StartedReply> => {
    const telegram = createFakeTelegram();
    const chatId = nextChat();
    const ctx = contextOf(
        messageUpdate({ chatId, messageId: takeMessageId(), userId: USER_ID, text: '想个难题' }),
        telegram
    );
    const chatContext = await responseHandler.createChatContext(ctx, { model: MODEL });
    if (!chatContext) throw new Error('no chat context');
    return {
        telegram,
        chatContext,
        chatId,
        firstMessageId: chatContext.session.firstMessageId,
    };
};

const strings = (values: readonly unknown[]): string[] =>
    values.filter((value): value is string => typeof value === 'string');

/** Payload text of one recorded method call */
const payloadText = (payload: Readonly<Record<string, unknown>>): string =>
    typeof payload.text === 'string' ? payload.text : '';

/** A nested object of an untyped payload (faked Telegram calls), or an empty one */
const objectOf = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : {};

/** The link-preview options of an edit, as the fields the cases assert on */
const linkPreviewOf = (payload: Readonly<Record<string, unknown>>): {
    url?: string;
    show_above_text?: boolean;
} => {
    const options = objectOf(payload.link_preview_options);
    return {
        ...(typeof options.url === 'string' ? { url: options.url } : {}),
        ...(typeof options.show_above_text === 'boolean'
            ? { show_above_text: options.show_above_text }
            : {}),
    };
};

/** The entities of an edit, reduced to the two fields the cases assert on */
const entitiesOf = (
    payload: Readonly<Record<string, unknown>>
): { type: string; url?: string }[] => {
    const entities = Array.isArray(payload.entities) ? payload.entities : [];
    return entities.map((entity) => {
        const fields = objectOf(entity);
        return {
            ...(typeof fields.type === 'string' ? { type: fields.type } : { type: '' }),
            ...(typeof fields.url === 'string' ? { url: fields.url } : {}),
        };
    });
};

/** The terminal shape's dimensions line: `共 7,689 词，发出约拆成 16 段` */
const STATS_LINE_PATTERN = /^共 [\d,]+ 词，发出约拆成 \d+ 段$/;

/** The stats line of a link message, if the text starts with the label */
const statsLineOf = (text: string): string | undefined => {
    if (!text.startsWith(`${THINKING_LINK_LABEL}\n`)) return undefined;
    return text.slice(THINKING_LINK_LABEL.length + 1).split('\n', 1)[0];
};

/** Whether a link edit is the terminal shape (label + stats line, nothing else) */
const isFinishedLinkText = (text: string): boolean => {
    const line = statsLineOf(text);
    return (
        line !== undefined &&
        STATS_LINE_PATTERN.test(line) &&
        text.length === THINKING_LINK_LABEL.length + 1 + line.length
    );
};

/** The link-mode flow up to (and including) the body start */
const runLinkReply = async (
    options: { readonly tailThinking?: string } = {}
): Promise<StartedReply & { readonly response: import('../../src/ai/types.js').AIResponse }> => {
    const started = await startReply();
    const steps: StreamStep[] = [
        ...thinkingSteps(longThinking()),
        { waitMs: 1200 },
        { chunk: { type: 'text', content: '答案来了。' } },
    ];
    if (options.tailThinking !== undefined) {
        steps.push({ chunk: { type: 'thinking', content: options.tailThinking } });
    }
    steps.push({ waitMs: 300 });
    const response = await quietly(() =>
        responseHandler.processStream(streamOf(steps), started.chatContext, 0)
    );
    started.chatContext.typing.stop();
    return { ...started, response };
};

const results: CaseResult[] = [];

results.push(
    await runCase('the thinking overflow activates link mode and shows one bounded preview', async () => {
        const started = await startReply();
        const response = await quietly(() =>
            responseHandler.processStream(
                streamOf([...thinkingSteps(longThinking()), { waitMs: 1200 }]),
                started.chatContext,
                0
            )
        );

        const link = started.chatContext.session.thinkingLink;
        expect(link !== undefined, 'the long thinking activated the link mode');
        expect(link?.emitted === false, 'no body yet, so the link is not emitted');
        expect(link?.miniAppUrl.includes('startapp=t') === true, 'the label links into the Mini App');
        expect(link?.fastPageUrl.includes('/t/') === true, 'the card points at the fast page');
        expect(response.text === '', 'a thinking-only stream produced no body text');

        // The version's link row is in the database, with the same token
        const row = await thinkingStore.findThinkingLink({
            chatId: started.chatId,
            firstMessageId: started.firstMessageId,
            versionId: 1,
        });
        expect(row?.token === link?.token, 'the thinking_links row carries the session token');

        const edits = started.telegram.callsOf('editMessageText');
        const texts = strings(edits.map((call) => call.payload.text));
        const streamingEdit = edits.find((call) =>
            payloadText(call.payload).startsWith(THINKING_LINK_LABEL)
        );
        expect(streamingEdit !== undefined, 'the message was edited into the link shape');
        const streamingText = payloadText(streamingEdit?.payload ?? {});
        expect(streamingText !== THINKING_LINK_LABEL, 'the streaming shape carries the preview too');
        expect(
            streamingText.length < 2100,
            `the streaming message stays bounded (got ${streamingText.length} chars)`
        );
        expect(
            !streamingText.includes('S0'),
            'older sections are not in the streaming link message'
        );

        const entityList = entitiesOf(streamingEdit?.payload ?? {});
        expect(
            entityList.some(
                (entity) => entity.type === 'text_link' && entity.url === link?.miniAppUrl
            ),
            'the visible label is a text_link into the Mini App'
        );
        expect(
            entityList.some((entity) => entity.type === 'blockquote'),
            'the preview rides in a plain blockquote'
        );
        expect(
            !entityList.some((entity) => entity.type === 'expandable_blockquote'),
            'the streaming preview never folds away'
        );
        expect(
            !entityList.some((entity) => entity.type === 'pre'),
            'no block entity nests inside the preview quote'
        );
        // The deep link is a text_link; left alone Telegram would draw its own
        // bot-app card above the streaming text. The fast-page card is pinned
        // from the first link edit, so the reader sees where it leads while the
        // CoT is still generating.
        const streamingPreview = objectOf(streamingEdit?.payload.link_preview_options);
        expect(
            streamingPreview.url === link?.fastPageUrl,
            'the streaming link message already carries the fast-page card'
        );
        expect(streamingPreview.show_above_text === false, 'the card sits below the streaming preview');
        expect(streamingPreview.is_disabled !== true, 'the card is not disabled while streaming');

        // The live stream holds the thinking from the first chunk
        const attemptKey = linkService.thinkingAttemptKeyOf({
            chatId: started.chatId,
            firstMessageId: started.firstMessageId,
            versionId: 1,
        });
        const live = thinkingStreamModule.thinkingStream.read(attemptKey);
        expect(live !== null, 'the page can read the live thinking');
        expect(live?.done === false, 'it is still marked as generating');
        expect((live?.text.length ?? 0) > 4000, 'from the very first chunk, not just from the trigger');

        started.chatContext.typing.stop();
        void response;
    })
);

results.push(
    await runCase('the first body chunk finalizes the link and continues the body', async () => {
        const { telegram, chatContext, response } = await runLinkReply({
            tailThinking: '**Late**\n\nlate thinking after the answer started',
        });
        const link = chatContext.session.thinkingLink;
        const firstMessageId = chatContext.session.firstMessageId;

        expect(link?.emitted === true, 'the link message went out');
        expect(chatContext.session.messageIds.length === 2, 'a continuation message was created');
        const continuationId = chatContext.session.messageIds[1];
        expect(
            continuationId !== undefined && continuationId !== firstMessageId,
            'the continuation is a new message'
        );

        const sendMessages = telegram.callsOf('sendMessage');
        expect(
            sendMessages.some((call) => payloadText(call.payload) === 'continued'),
            'the continuation was opened with the processing placeholder'
        );

        const editsOnFirst = telegram
            .callsOf('editMessageText')
            .filter((call) => call.payload.chat_id === chatContext.chatId && call.payload.message_id === firstMessageId);
        const finalLinkEdits = editsOnFirst.filter((call) =>
            isFinishedLinkText(payloadText(call.payload))
        );
        expect(
            finalLinkEdits.length >= 1,
            'the streaming message was finalized as the link plus its stats'
        );
        const cardEdit = finalLinkEdits.find(
            (call) => linkPreviewOf(call.payload).url === link?.fastPageUrl
        );
        expect(cardEdit !== undefined, 'the final link edit forces the fast-page preview card');
        expect(
            linkPreviewOf(cardEdit?.payload ?? {}).show_above_text === false,
            'the card renders below the text'
        );
        expect(cardEdit?.payload.reply_markup === undefined, 'the stop button is gone from the link message');

        expect(
            strings(editsOnFirst.map((call) => call.payload.text)).every(
                (text) => !text.includes('答案来了')
            ),
            'the body never overwrote the link message'
        );
        await waitUntil(
            'the body edit to reach the continuation',
            () =>
                telegram
                    .callsOf('editMessageText')
                    .some(
                        (call) =>
                            call.payload.message_id === continuationId &&
                            payloadText(call.payload).includes('答案来了')
                    ),
            8000
        );
        const continuationEdits = telegram
            .callsOf('editMessageText')
            .filter((call) => call.payload.message_id === continuationId);
        expect(
            strings(continuationEdits.map((call) => call.payload.text)).some((text) =>
                text.includes('答案来了')
            ),
            'the answer streams into the continuation'
        );

        // Thinking that arrives after the answer started belongs to the page only
        expect(response.thinkingText === '', 'the display thinking buffer was cleared at the transition');
        expect(
            response.text.includes('答案来了') && !response.text.includes('late thinking'),
            'the body carries the answer, not the late thinking'
        );
        expect(
            chatContext.session.thinkingBuffer.includes('late thinking'),
            'the full thinking keeps growing for the stored version'
        );
        expect(
            strings(telegram.callsOf('editMessageText').map((call) => call.payload.text)).every(
                (text) => !text.includes('late thinking')
            ),
            'the late thinking never reached a Telegram message'
        );
    })
);

results.push(
    await runCase('final delivery keeps the emitted link and stores token and full thinking', async () => {
        const { telegram, chatContext, response } = await runLinkReply();
        const firstMessageId = chatContext.session.firstMessageId;
        const link = chatContext.session.thinkingLink;
        telegram.reset();

        await quietly(() => responseHandler.sendFinalResponse(chatContext, response));

        const edits = telegram.callsOf('editMessageText');
        expect(
            strings(edits.map((call) => call.payload.text)).every((text) => text !== THINKING_LINK_LABEL),
            'the already-emitted link message is not re-delivered'
        );
        expect(
            strings(edits.map((call) => call.payload.text)).some((text) => text.includes('答案来了')),
            'the body is finalized in the continuation'
        );

        const stored = await dbIndex.getBotResponse(chatContext.chatId, firstMessageId);
        const version = stored?.getVersions().at(-1);
        expect(version?.thinkingLinkToken === link?.token, 'the version stores the link token');
        expect(
            (version?.thinkingText?.length ?? 0) > 4000,
            `the version stores the full thinking, not the display placeholder (got ${version?.thinkingText?.length ?? 0})`
        );
        expect(version?.messageIds.length === 2, 'the version knows the link and the body message');
        expect(version?.text.includes('答案来了') === true, 'the body text is stored as the version text');

        const attemptKey = linkService.thinkingAttemptKeyOf({
            chatId: chatContext.chatId,
            firstMessageId,
            versionId: 1,
        });
        const live = thinkingStreamModule.thinkingStream.read(attemptKey);
        expect(live?.done === true, 'finalize marks the live thinking as finished');
    })
);

results.push(
    await runCase('the terminal buttons and last message belong to the body, not the link', async () => {
        const { telegram, chatContext, response } = await runLinkReply();
        const firstMessageId = chatContext.session.firstMessageId;
        const continuationId = chatContext.session.messageIds[1];
        expect(continuationId !== undefined, 'the body streams into its own message');

        // A user edit while the reply still generates ships the retry buttons
        const { markPendingEditWhileProcessing } = await import('../../src/state.js');
        markPendingEditWhileProcessing(chatContext.chatId, chatContext.userMessageId);
        telegram.reset();
        await quietly(() => responseHandler.sendFinalResponse(chatContext, response));

        const markupEdits = telegram
            .callsOf('editMessageText')
            .filter((call) => call.payload.reply_markup !== undefined);
        expect(markupEdits.length >= 1, 'the final edit carries the retry buttons');
        expect(
            markupEdits.every((call) => call.payload.message_id !== firstMessageId),
            'the link message never carries the terminal buttons'
        );
        expect(
            markupEdits.some((call) => call.payload.message_id === continuationId),
            'the buttons ride on the body message'
        );

        const stored = await dbIndex.getBotResponse(chatContext.chatId, firstMessageId);
        const version = stored?.getVersions().at(-1);
        expect(
            version?.currentMessageId === continuationId,
            `the version points at the body as its last message (got ${version?.currentMessageId})`
        );
        expect(version?.messageIds.length === 2, 'the version keeps the link and the body');
        expect(version?.messageIds[0] === firstMessageId, 'the link message leads the stored layout');
    })
);

results.push(
    await runCase('a body that splits while streaming keeps the last message as current', async () => {
        const started = await startReply();
        // 8 paragraphs is ~4,900 rendered characters: the body alone overflows one
        // message, so the streaming loop opens a second continuation for it
        const longBody = Array.from(
            { length: 8 },
            (_, index) => `第${index}段：${'内容'.repeat(300)}`
        ).join('\n\n');
        const response = await quietly(() =>
            responseHandler.processStream(
                streamOf([
                    ...thinkingSteps(longThinking()),
                    { waitMs: 1200 },
                    { chunk: { type: 'text', content: longBody } },
                ]),
                started.chatContext,
                0
            )
        );
        started.chatContext.typing.stop();
        const firstMessageId = started.chatContext.session.firstMessageId;
        expect(
            started.chatContext.session.thinkingLink?.emitted === true,
            'the link message went out before the body'
        );
        expect(
            started.chatContext.session.messageIds.length >= 3,
            `the long body opened another message (got ${started.chatContext.session.messageIds.length})`
        );

        await quietly(() => responseHandler.sendFinalResponse(started.chatContext, response));

        const stored = await dbIndex.getBotResponse(started.chatContext.chatId, firstMessageId);
        const version = stored?.getVersions().at(-1);
        const lastMessageId = version?.messageIds.at(-1);
        expect(
            lastMessageId !== undefined && lastMessageId !== firstMessageId,
            'the stored layout ends with a body message'
        );
        expect(
            version?.currentMessageId === lastMessageId,
            `the version points at its real last message (got ${version?.currentMessageId} vs ${lastMessageId})`
        );
    })
);

results.push(
    await runCase('a stored link version replays the link message first', async () => {
        const { telegram, chatContext, response } = await runLinkReply();
        const firstMessageId = chatContext.session.firstMessageId;
        const link = chatContext.session.thinkingLink;
        await quietly(() => responseHandler.sendFinalResponse(chatContext, response));
        telegram.reset();

        const refreshed = await quietly(() =>
            dbIndex.getBotResponse(chatContext.chatId, firstMessageId).then((stored) =>
                stored === null || stored === undefined
                    ? false
                    : import('../../src/services/bot-message-service.js').then((service) =>
                          service.refreshToFinalState(
                              telegram.api,
                              chatContext.chatId,
                              firstMessageId
                          )
                      )
            )
        );
        expect(refreshed === true, 'the refresh re-delivered the stored layout');

        const edits = telegram.callsOf('editMessageText');
        const firstEdits = edits.filter((call) => call.payload.message_id === firstMessageId);
        const linkEdit = firstEdits.find(
            (call) =>
                isFinishedLinkText(payloadText(call.payload)) &&
                linkPreviewOf(call.payload).url === link?.fastPageUrl
        );
        expect(linkEdit !== undefined, 'the link message is rebuilt first, stats and card included');
        expect(
            edits.some((call) => payloadText(call.payload).includes('答案来了')),
            'the body message follows the link'
        );
    })
);

results.push(
    await runCase('an error before the answer puts the link in front of the error line', async () => {
        const started = await startReply();
        const failingStream: AsyncIterable<StreamChunk> = {
            async *[Symbol.asyncIterator]() {
                for (const chunk of thinkingChunks(longThinking())) {
                    yield chunk;
                }
                await sleep(1200);
                throw new Error('upstream exploded');
            },
        };
        let failure: Error | undefined;
        try {
            await quietly(() => responseHandler.processStream(failingStream, started.chatContext, 0));
        } catch (error) {
            failure = error instanceof Error ? error : new Error(String(error));
        }
        expect(failure !== undefined, 'the stream threw');

        const link = started.chatContext.session.thinkingLink;
        expect(link !== undefined && link.emitted === false, 'the link was activated but never emitted');

        await quietly(() => responseHandler.handleResponseError(started.chatContext, failure ?? new Error('boom')));

        const edits = started.telegram.callsOf('editMessageText');
        const errorEdit = edits
            .map((call) => call.payload)
            .filter((payload) => payloadText(payload).includes('⚠'))
            .at(-1);
        expect(errorEdit !== undefined, 'the error line was edited in');
        const errorText = payloadText(errorEdit ?? {});
        expect(
            errorText.startsWith(THINKING_LINK_LABEL) && errorText.includes('⚠'),
            `the message is the link then the error line (got ${JSON.stringify(errorText.slice(0, 60))})`
        );
        expect(
            STATS_LINE_PATTERN.test(statsLineOf(errorText) ?? ''),
            `the stats line sits between the link and the error (got ${JSON.stringify(statsLineOf(errorText))})`
        );
        expect(
            linkPreviewOf(errorEdit ?? {}).url === link?.fastPageUrl,
            'the link keeps its preview card on the error message'
        );
        expect(errorEdit?.reply_markup !== undefined, 'the retry button rides on the error message');

        const stored = await dbIndex.getBotResponse(started.chatId, started.firstMessageId);
        const version = stored?.getVersions().at(-1);
        expect(version?.errorMessage !== undefined, 'the error is stored on the version');
        expect(version?.thinkingLinkToken === link?.token, 'and so is the link token');

        const attemptKey = linkService.thinkingAttemptKeyOf({
            chatId: started.chatId,
            firstMessageId: started.firstMessageId,
            versionId: 1,
        });
        expect(
            thinkingStreamModule.thinkingStream.read(attemptKey)?.done === true,
            'the page stops saying "generating" after an error'
        );
    })
);

results.push(
    await runCase('stopping before the answer keeps the link message', async () => {
        const started = await startReply();
        const abortingStream: AsyncIterable<StreamChunk> = {
            async *[Symbol.asyncIterator]() {
                for (const chunk of thinkingChunks(longThinking())) {
                    yield chunk;
                }
                // Let the link message reach the chat, then the user hits stop
                await sleep(1200);
                started.chatContext.session.streamController.abort();
                yield { type: 'text', content: '不会显示' };
            },
        };
        const response = await quietly(() =>
            responseHandler.processStream(abortingStream, started.chatContext, 0)
        );
        const link = started.chatContext.session.thinkingLink;
        expect(link !== undefined && link.emitted === false, 'the link was activated, the answer never started');
        expect(response.text === '', 'the aborted body is empty');

        started.telegram.reset();
        await quietly(() => responseHandler.sendFinalResponse(started.chatContext, response));

        const edits = started.telegram.callsOf('editMessageText');
        const finalLink = edits
            .map((call) => call.payload)
            .filter((payload) => isFinishedLinkText(payloadText(payload)))
            .at(-1);
        expect(finalLink !== undefined, 'the stopped reply still shows the link message');
        expect(
            linkPreviewOf(finalLink ?? {}).url === link?.fastPageUrl,
            'with its preview card'
        );
        expect(
            !started.telegram.callsOf('sendMessage').some((call) => payloadText(call.payload) === 'continued'),
            'no continuation was opened for an answer that never started'
        );

        const stored = await dbIndex.getBotResponse(started.chatId, started.firstMessageId);
        const version = stored?.getVersions().at(-1);
        expect(version?.wasStoppedByUser === true, 'the version records the stop');
        expect(version?.text === '', 'and no body text');
        expect(version?.thinkingLinkToken === link?.token, 'and the link token');
    })
);

results.push(
    await runCase('a thinking-only reply is just the link message', async () => {
        const started = await startReply();
        const response = await quietly(() =>
            responseHandler.processStream(
                streamOf([...thinkingSteps(longThinking()), { waitMs: 1200 }]),
                started.chatContext,
                0
            )
        );
        const link = started.chatContext.session.thinkingLink;
        expect(link?.emitted === false, 'no answer started, so the link is not emitted');

        started.telegram.reset();
        await quietly(() => responseHandler.sendFinalResponse(started.chatContext, response));

        const edits = started.telegram.callsOf('editMessageText');
        const finalLink = edits
            .map((call) => call.payload)
            .filter((payload) => isFinishedLinkText(payloadText(payload)))
            .at(-1);
        expect(finalLink !== undefined, 'the whole reply is the link message');
        expect(
            linkPreviewOf(finalLink ?? {}).url === link?.fastPageUrl,
            'with its preview card'
        );
        expect(
            !started.telegram.callsOf('sendMessage').some((call) => payloadText(call.payload) === 'continued'),
            'no continuation message was opened'
        );

        const stored = await dbIndex.getBotResponse(started.chatId, started.firstMessageId);
        const version = stored?.getVersions().at(-1);
        expect(version?.text === '', 'a thinking-only reply stores no body text');
        expect(version?.thinkingLinkToken === link?.token, 'the token is stored');
    })
);

results.push(
    await runCase('a thinking-only link reply counts the whole CoT past the display cap', async () => {
        const started = await startReply();
        // ~17k chars: past the 10k display cap, so the stream's returned thinking
        // is the omission placeholder; the stats must still count the whole CoT
        const thinking = Array.from(
            { length: 24 },
            (_, index) => `**S${index}**\n\n${'推理'.repeat(350)}`
        ).join('\n\n');
        const response = await quietly(() =>
            responseHandler.processStream(
                streamOf([{ chunk: { type: 'thinking', content: thinking } }, { waitMs: 300 }]),
                started.chatContext,
                0
            )
        );
        const link = started.chatContext.session.thinkingLink;
        expect(link !== undefined && link.emitted === false, 'the long thinking is in link mode');
        expect(
            started.chatContext.currentState?.thinkingBuffer.startsWith('[reasoning truncated') === true,
            'the display buffer degraded to its placeholder'
        );
        expect(
            response.thinkingText.startsWith('[reasoning truncated'),
            'the stream returns the display buffer, not the full thinking'
        );
        expect(
            started.chatContext.session.thinkingBuffer.length === thinking.length,
            'the session keeps the full thinking'
        );

        started.telegram.reset();
        await quietly(() => responseHandler.sendFinalResponse(started.chatContext, response));

        const { thinkingLinkSummaryOf } = await import('../../src/telegram/formatters/thinking-link.js');
        const summary = thinkingLinkSummaryOf(thinking);
        const expected = `共 ${summary?.words.toLocaleString('zh-CN')} 词，发出约拆成 ${summary?.segments} 段`;
        const finalLink = started.telegram
            .callsOf('editMessageText')
            .map((call) => payloadText(call.payload))
            .filter((text) => isFinishedLinkText(text))
            .at(-1) ?? '';
        expect(
            statsLineOf(finalLink) === expected,
            `the stats count the whole CoT (got ${JSON.stringify(statsLineOf(finalLink))} vs ${JSON.stringify(expected)})`
        );
    })
);

results.push(
    await runCase('a link reply with an image keeps the link message', async () => {
        const started = await startReply();
        const response = await quietly(() =>
            responseHandler.processStream(
                streamOf([
                    ...thinkingSteps(longThinking()),
                    { waitMs: 1200 },
                    { chunk: { type: 'image', imageData: PNG_BYTES } },
                ]),
                started.chatContext,
                0
            )
        );
        const link = started.chatContext.session.thinkingLink;
        expect(link?.emitted === false, 'an image does not start the answer');
        expect(response.text === '', 'the reply has no body text');

        started.telegram.reset();
        await quietly(() => responseHandler.sendFinalResponse(started.chatContext, response));

        const deleted = started.telegram
            .callsOf('deleteMessage')
            .map((call) => call.payload.message_id);
        expect(
            !deleted.includes(started.firstMessageId),
            'media-only delivery must not delete the link message'
        );
        const edits = started.telegram.callsOf('editMessageText');
        expect(
            strings(edits.map((call) => call.payload.text)).some((text) => isFinishedLinkText(text)),
            'the processing message stays as the link'
        );
        const imageCalls =
            started.telegram.callsOf('sendPhoto').length +
            started.telegram.callsOf('sendDocument').length;
        expect(imageCalls >= 1, 'the image still goes out after the link');

        const stored = await dbIndex.getBotResponse(started.chatId, started.firstMessageId);
        const version = stored?.getVersions().at(-1);
        expect(version?.imageBase64 !== undefined, 'the image is part of the stored version');
        expect(version?.thinkingLinkToken === link?.token, 'and so is the link token');
    })
);

results.push(
    await runCase('thinking that only grows after the answer started never activates link mode', async () => {
        const started = await startReply();
        const response = await quietly(() =>
            responseHandler.processStream(
                streamOf([
                    { chunk: { type: 'thinking', content: '先想一小段。' } },
                    { chunk: { type: 'text', content: '答案来了。' } },
                    ...thinkingSteps(longThinking()),
                    { waitMs: 300 },
                ]),
                started.chatContext,
                0
            )
        );

        expect(started.chatContext.session.thinkingLink === undefined, 'link mode was not activated');
        expect(response.text.includes('答案来了'), 'the answer streamed normally');
        expect(
            strings(started.telegram.callsOf('editMessageText').map((call) => call.payload.text)).every(
                (text) => !text.startsWith(THINKING_LINK_LABEL)
            ),
            'no link message appeared'
        );
        const row = await thinkingStore.findThinkingLink({
            chatId: started.chatId,
            firstMessageId: started.firstMessageId,
            versionId: 1,
        });
        expect(row === null, 'no thinking_links row was created');
    })
);

results.push(
    await runCase('the switch off or no public url keeps the legacy split', async () => {
        const runOnce = async (): Promise<void> => {
            const started = await startReply();
            await quietly(() =>
                responseHandler.processStream(
                    streamOf([
                        ...thinkingSteps(longThinking()),
                        { waitMs: 400 },
                        { chunk: { type: 'text', content: '答案来了。' } },
                    ]),
                    started.chatContext,
                    0
                )
            );
            expect(started.chatContext.session.thinkingLink === undefined, 'no link mode without the switch');
            expect(
                strings(started.telegram.callsOf('editMessageText').map((call) => call.payload.text)).every(
                    (text) => !text.startsWith(THINKING_LINK_LABEL)
                ),
                'the message never becomes a link'
            );
            started.chatContext.typing.stop();
        };

        process.env.THINKING_LINK = '0';
        try {
            await runOnce();
        } finally {
            delete process.env.THINKING_LINK;
        }

        const publicUrl = process.env.WEBAPP_PUBLIC_URL;
        process.env.WEBAPP_PUBLIC_URL = '';
        try {
            await runOnce();
        } finally {
            process.env.WEBAPP_PUBLIC_URL = publicUrl;
        }
    })
);

results.push(
    await runCase('the full thinking keeps 200k while the display buffer stays at 10k', async () => {
        const emptyState: ResponseState = {
            textBuffer: '',
            thinkingBuffer: '',
            fullText: '',
            fullThinking: '',
            thinkingTruncatedChars: 0,
            images: [],
            stickers: [],
            files: [],
            widgets: [],
            groundingData: [],
            agentStats: undefined,
            modelParts: undefined,
            rawResponse: undefined,
            isDone: false,
        };
        const keep = (text: string): string => text;

        let state = responseHandler.processChunk(
            { type: 'thinking', content: 'a'.repeat(15000) },
            emptyState,
            keep
        );
        expect(
            state.thinkingBuffer.startsWith('[reasoning truncated'),
            'the display buffer still degrades to the placeholder'
        );
        expect(state.fullThinking.length === 15000, 'the full thinking keeps every character');

        state = responseHandler.processChunk(
            { type: 'thinking', content: 'b'.repeat(200000) },
            state,
            keep
        );
        expect(
            state.fullThinking.length > 200000 && state.fullThinking.length < 200200,
            `the full thinking is cut at 200k once (got ${state.fullThinking.length})`
        );
        expect(state.fullThinking.includes('已截断'), 'with a truncation mark');

        state = responseHandler.processChunk(
            { type: 'thinking', content: 'c'.repeat(10) },
            state,
            keep
        );
        expect(!state.fullThinking.endsWith('c'), 'later chunks are dropped after the cut');
    })
);

results.push(
    await runCase('the streaming preview reads the real tail past the display flood cap', async () => {
        const started = await startReply();
        // One chunk past the 10k display cap: the display buffer degrades to its
        // omission note at once while the full thinking keeps everything, and
        // link mode never splits the message. A second small chunk forces a render.
        const sections = Array.from(
            { length: 20 },
            (_, index) => `**S${index}**\n\n${'推理'.repeat(350)}`
        );
        sections.push('**TailSection**\n\n最后一段真实推理内容');
        const thinking = sections.join('\n\n');
        await quietly(() =>
            responseHandler.processStream(
                streamOf([
                    { chunk: { type: 'thinking', content: thinking } },
                    { chunk: { type: 'thinking', content: '**StillThinking**\n\n补充一段' } },
                ]),
                started.chatContext,
                0
            )
        );
        started.chatContext.typing.stop();

        expect(
            thinking.length > 10000,
            `the sample crosses the display flood cap (got ${thinking.length})`
        );
        expect(
            started.chatContext.currentState?.thinkingBuffer.startsWith('[reasoning truncated') ===
                true,
            'the display buffer did degrade to the placeholder'
        );
        const link = started.chatContext.session.thinkingLink;
        expect(link !== undefined && link.emitted === false, 'the long thinking is in link mode');

        const linkEdits = (): string[] =>
            started.telegram
                .callsOf('editMessageText')
                .map((call) => payloadText(call.payload))
                .filter((text) => text.startsWith(THINKING_LINK_LABEL));
        // The edit coordinator paces the calls, so the last renders land a bit later
        await waitUntil(
            'a link edit to show the newest section',
            () => linkEdits().some((text) => text.includes('TailSection')),
            8000
        );
        const lastEdit = linkEdits().at(-1) ?? '';
        expect(lastEdit.includes('TailSection'), 'the preview shows the newest real section');
        expect(lastEdit.includes('最后一段真实推理内容'), 'and its text');
        expect(
            linkEdits().every((text) => !text.includes('reasoning truncated')),
            'the flood omission note never reaches the link preview'
        );
        expect(lastEdit.length < 2100, `the preview stays bounded (got ${lastEdit.length})`);
    })
);

// Close the scratch database and exit: the streams leave timers behind
const { sequelize } = await import('../../src/db/config.js');
await sequelize.close();
void db;

reportResults(results);

setTimeout(() => process.exit(0), 100);
