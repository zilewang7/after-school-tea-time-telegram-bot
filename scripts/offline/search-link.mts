/**
 * Offline cases for the folded GoogleSearch footer (design 2026-1113-1831):
 * a footer that cannot fit one Telegram message leaves the chat as one compact
 * link message to the public search page, and the reply version stores the
 * token that replays it.
 *
 * These cases drive the real `processStream` / `sendFinalResponse` /
 * `handleResponseError` / `refreshToFinalState` / `switchVersion` against the
 * fake Telegram API and a scratch database:
 *
 * - the folded final delivery: last message is the link, the footer text is in
 *   no message, the version stores the token, the buttons land on it;
 * - the live document is cached for Telegram's preview crawler;
 * - a stored version replays the same link message (refresh and version switch);
 * - a footer that fits one message is not folded;
 * - the switch off / no public origin keeps today's inline footer;
 * - the stop path keeps its `[stopped]` line in the body;
 * - the error path shows no folded footer, and its replay keeps the error line
 *   on the last message;
 * - a thinking-only link reply folds the footer after the CoT link;
 * - an image reply keeps the photo last and replays the same layout.
 *
 * Run: npx tsx scripts/offline/search-link.mts
 */
process.env.WEBAPP_PUBLIC_URL = 'https://miniapp.test';
process.env.BOT_TOKEN = '123456:test-bot-token';
process.env.BOT_USER_ID = '7777';
process.env.BOT_USER_NAME = 'AfterSchoolTeatimeBot';
process.env.WEBAPP_BOT_SHORT_NAME = 'panel';
delete process.env.SEARCH_LINK;
delete process.env.THINKING_LINK;

import {
    expect,
    reportResults,
    runCase,
    setupOfflineDb,
    takeMessageId,
    type CaseResult,
} from './harness.mts';
import {
    callbackUpdate,
    contextOf,
    createFakeTelegram,
    endOpenReplies,
    messageUpdate,
    quietly,
    trackReply,
    type FakeTelegram,
} from './fake-telegram.mts';
import type { AIResponse, GroundingData, StreamChunk } from '../../src/ai/types.js';
import type { ResponseVersion } from '../../src/db/botResponseDTO.js';

type BotMessageSession = import('../../src/services/bot-message-service.js').BotMessageSession;
type ChatContext = import('../../src/reply/response-handler.js').ChatContext;

await setupOfflineDb();
const responseHandler = await import('../../src/reply/response-handler.js');
const botMessageService = await import('../../src/services/bot-message-service.js');
const dbIndex = await import('../../src/db/index.js');
const { SEARCH_LINK_LABEL } = await import('../../src/telegram/formatters/google-search-link.js');
const { THINKING_LINK_LABEL } = await import('../../src/telegram/formatters/thinking-link.js');
const { googleSearchFooterPlan } = await import('../../src/telegram/formatters/google-search-document.js');
const { searchPageLinkOf } = await import('../../src/shared/search-page.js');
const { cachedSearchDocument } = await import('../../src/panel/search/search-document-cache.js');
const { markPendingEditWhileProcessing } = await import('../../src/state.js');

const USER_ID = 603421700;
/** The reply's model; the search page shows it, the cases only need it stable */
const MODEL = 'gemini-4-argon';

/** A PNG's first bytes: enough for the mime sniff the image delivery does */
const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlZkAAAAASUVORK5CYII=',
    'base64'
);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One chat per case: the edit coordinator paces calls per chat */
let nextChatId = -1009999000000;
const nextChat = (): number => (nextChatId -= 1);

// ---------------------------------------------------------------------------
// Grounding fixtures
// ---------------------------------------------------------------------------

const BIG_QUERY_COUNT = 131;
const BIG_SOURCE_TITLES = ['来源甲', '来源乙', '来源丙'];
const BIG_STATS_LINE = '共搜索 131 次，引用 3 条来源';

/** One anchor per query, so every query becomes a text_link (the incident shape) */
const queryAnchors = (queries: readonly string[]): string =>
    queries
        .map((query, index) => `<a href="https://www.google.com/search?q=query-${index + 1}">${query}</a>`)
        .join('\n');

const searchFooter = (queries: readonly string[], sourceTitles: readonly string[]): GroundingData => ({
    searchQueries: [...queries],
    searchEntryPoint: { renderedContent: queryAnchors(queries) },
    groundingChunks: sourceTitles.map((title, index) => ({
        web: { uri: `https://example.test/source-${index + 1}`, title },
    })),
});

const bigQueries = (): string[] =>
    Array.from({ length: BIG_QUERY_COUNT }, (_, index) => `事故查询 ${index + 1}`);

/** The incident's footer: 131 linked queries overflow the entity budget */
const bigFooter = (): GroundingData => searchFooter(bigQueries(), BIG_SOURCE_TITLES);

/** A footer that fits one message with room to spare */
const smallFooter = (): GroundingData => searchFooter(['小查询 1', '小查询 2'], ['小来源']);

// ---------------------------------------------------------------------------
// Stream and delivery helpers
// ---------------------------------------------------------------------------

const textChunk = (content: string): StreamChunk => ({ type: 'text', content });
const thinkingChunk = (content: string): StreamChunk => ({ type: 'thinking', content });
const groundingChunk = (groundingMetadata: GroundingData): StreamChunk => ({
    type: 'grounding',
    groundingMetadata,
});

/** ~4,200 characters: past one message, so the streaming loop activates the CoT link */
const longThinking = (): string =>
    Array.from({ length: 6 }, (_, index) => `**S${index}**\n\n${'推理'.repeat(350)}`).join('\n\n');

const thinkingChunks = (thinking: string, chunkSize = 500): StreamChunk[] => {
    const chunks: StreamChunk[] = [];
    for (let index = 0; index < thinking.length; index += chunkSize) {
        chunks.push(thinkingChunk(thinking.slice(index, index + chunkSize)));
    }
    return chunks;
};

const streamOf = (steps: readonly StreamChunk[]): AsyncIterable<StreamChunk> => ({
    async *[Symbol.asyncIterator]() {
        for (const step of steps) {
            yield step;
            // The editor's non-final updates are fire-and-forget: a breath keeps
            // the stream's shape deterministic without holding the case up
            await sleep(5);
        }
    },
});

interface StartedReply {
    readonly telegram: FakeTelegram;
    readonly chatContext: ChatContext;
    readonly chatId: number;
    readonly userMessageId: number;
    readonly firstMessageId: number;
}

const startReply = async (): Promise<StartedReply> => {
    const telegram = createFakeTelegram();
    const chatId = nextChat();
    const userMessageId = takeMessageId();
    const ctx = contextOf(
        messageUpdate({ chatId, messageId: userMessageId, userId: USER_ID, text: '搜一下' }),
        telegram
    );
    const chatContext = await responseHandler.createChatContext(ctx, { model: MODEL });
    if (chatContext === null) throw new Error('offline: no chat context');
    trackReply(chatContext);
    return {
        telegram,
        chatContext,
        chatId,
        userMessageId,
        firstMessageId: chatContext.session.firstMessageId,
    };
};

const streamInto = async (
    chatContext: ChatContext,
    steps: readonly StreamChunk[]
): Promise<AIResponse> => {
    const response = await quietly(() => responseHandler.processStream(streamOf(steps), chatContext, 0));
    chatContext.typing.stop();
    return response;
};

/** The final delivery with the streaming calls dropped from the recording */
const deliverFinal = async (
    started: { readonly telegram: FakeTelegram; readonly chatContext: ChatContext },
    response: AIResponse
): Promise<void> => {
    started.telegram.reset();
    await quietly(() => responseHandler.sendFinalResponse(started.chatContext, response));
};

const versionOf = async (started: StartedReply, index = -1): Promise<ResponseVersion | undefined> => {
    const stored = await dbIndex.getBotResponse(started.chatId, started.firstMessageId);
    return stored?.getVersions().at(index);
};

const pageLinkOf = (started: StartedReply, versionId: number) =>
    searchPageLinkOf({
        chatId: started.chatId,
        firstMessageId: started.firstMessageId,
        versionId,
    });

// ---------------------------------------------------------------------------
// Payload readers (no casts: the fake API's payloads are untyped)
// ---------------------------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : {};

const payloadText = (payload: Readonly<Record<string, unknown>>): string =>
    typeof payload.text === 'string' ? payload.text : '';

interface EntityView {
    readonly type: string;
    readonly url?: string;
    readonly offset?: number;
    readonly length?: number;
}

const entitiesOf = (payload: Readonly<Record<string, unknown>>): EntityView[] => {
    const entities = Array.isArray(payload.entities) ? payload.entities : [];
    return entities.map((entity) => {
        const fields = asRecord(entity);
        return {
            type: typeof fields.type === 'string' ? fields.type : '',
            ...(typeof fields.url === 'string' ? { url: fields.url } : {}),
            ...(typeof fields.offset === 'number' ? { offset: fields.offset } : {}),
            ...(typeof fields.length === 'number' ? { length: fields.length } : {}),
        };
    });
};

interface PreviewView {
    readonly url?: string;
    readonly showAboveText?: boolean;
    readonly disabled?: boolean;
}

const previewOf = (payload: Readonly<Record<string, unknown>>): PreviewView => {
    const options = asRecord(payload.link_preview_options);
    return {
        ...(typeof options.url === 'string' ? { url: options.url } : {}),
        ...(typeof options.show_above_text === 'boolean'
            ? { showAboveText: options.show_above_text }
            : {}),
        ...(options.is_disabled === true ? { disabled: true } : {}),
    };
};

/** Every text the fake API received, whatever the method */
const allTexts = (telegram: FakeTelegram): string[] =>
    telegram.calls.map((call) => payloadText(call.payload));

const textsOfMethod = (telegram: FakeTelegram, method: string): string[] =>
    telegram.callsOf(method).map((call) => payloadText(call.payload));

const lastCallOf = (telegram: FakeTelegram, method: string) => telegram.callsOf(method).at(-1);

const lastEditOf = (telegram: FakeTelegram, messageId: number) =>
    telegram
        .callsOf('editMessageText')
        .filter((call) => call.payload.message_id === messageId)
        .at(-1);

const searchLinkText = (statsLine: string): string => `${SEARCH_LINK_LABEL}\n${statsLine}`;

const isSearchLinkText = (text: string): boolean =>
    text === SEARCH_LINK_LABEL || text.startsWith(`${SEARCH_LINK_LABEL}\n`);

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const results: CaseResult[] = [];

results.push(
    await runCase('an overflowing footer becomes one search link message', async () => {
        const started = await startReply();
        const footer = bigFooter();
        expect(
            googleSearchFooterPlan([footer]) === 'overflows',
            'the footer needs more than one message'
        );

        // A user edit while the reply generates ships the retry buttons
        markPendingEditWhileProcessing(started.chatId, started.userMessageId);
        const response = await streamInto(started.chatContext, [
            textChunk('答案来了。'),
            groundingChunk(footer),
        ]);
        await deliverFinal(started, response);

        const link = pageLinkOf(started, 1);
        expect(link !== null, 'the page pointer derives from the reply identity');
        if (link === null) return;
        const version = await versionOf(started);
        expect(version?.searchLinkToken === link.token, 'the version stores the page token');
        const messageIds = version?.messageIds ?? [];
        expect(messageIds.length === 2, `the reply is two messages (got ${messageIds.length})`);
        const linkMessageId = messageIds.at(-1) ?? 0;
        expect(version?.currentMessageId === linkMessageId, 'the link message is the current one');

        const expectedText = searchLinkText(BIG_STATS_LINE);
        const linkCall = lastCallOf(started.telegram, 'sendMessage');
        expect(
            payloadText(linkCall?.payload ?? {}) === expectedText,
            `the last message is the link and its stats (got ${JSON.stringify(
                payloadText(linkCall?.payload ?? {})
            )})`
        );
        expect(linkCall?.payload.message_id === undefined, 'the link message was sent, not edited');
        const labelEntity = entitiesOf(linkCall?.payload ?? {}).find(
            (entity) => entity.type === 'text_link'
        );
        expect(
            labelEntity?.url === link.url &&
                labelEntity.offset === 0 &&
                labelEntity.length === SEARCH_LINK_LABEL.length,
            `the whole label links to the page (got ${JSON.stringify(labelEntity)})`
        );
        const linkPreview = previewOf(linkCall?.payload ?? {});
        expect(linkPreview.url === link.url, 'the link message forces the page card');
        expect(linkPreview.showAboveText === false, 'the card renders below the text');

        // The footer is gone from the chat: no query and no source survives anywhere
        const bodyEdit = lastEditOf(started.telegram, started.firstMessageId);
        expect(bodyEdit !== undefined, 'the body message was rewritten in place');
        expect(
            payloadText(bodyEdit?.payload ?? {}) === '答案来了。',
            `the body holds the answer only (got ${JSON.stringify(
                payloadText(bodyEdit?.payload ?? {})
            )})`
        );
        expect(previewOf(bodyEdit?.payload ?? {}).disabled === true, 'the body carries no card');
        const texts = allTexts(started.telegram);
        expect(
            texts.every((text) => !text.includes('事故查询') && !text.includes('来源甲')),
            'the footer text is in no message'
        );
        expect(
            texts.every((text) => !text.includes('GoogleSearch')),
            'the inline footer title is gone too'
        );

        // The terminal buttons land on the link message
        const markupCalls = started.telegram.callsOf('editMessageReplyMarkup');
        expect(markupCalls.length >= 1, 'the final delivery adds the buttons');
        expect(
            markupCalls.every((call) => call.payload.message_id === linkMessageId),
            'the buttons land on the search link message'
        );

        // The live document is cached before the send, for the preview crawler
        const cached = cachedSearchDocument(link.token);
        expect(cached !== null, 'the document is cached for the page');
        expect(
            cached?.document.queryCount === BIG_QUERY_COUNT &&
                cached.document.sourceCount === BIG_SOURCE_TITLES.length,
            `the cached document has the footer's numbers (got ${JSON.stringify({
                queries: cached?.document.queryCount,
                sources: cached?.document.sourceCount,
            })})`
        );
        expect(cached?.model === MODEL, 'the cache names the version model');
        expect(started.chatContext.session.searchLink?.token === link.token, 'the session carries the link');
    })
);

results.push(
    await runCase('a stored folded version replays the same link message', async () => {
        const started = await startReply();
        const response = await streamInto(started.chatContext, [
            textChunk('答案来了。'),
            groundingChunk(bigFooter()),
        ]);
        await deliverFinal(started, response);
        const link = pageLinkOf(started, 1);
        expect(link !== null, 'the folded page pointer exists');
        if (link === null) return;
        const before = await versionOf(started);

        started.telegram.reset();
        const refreshed = await quietly(() =>
            botMessageService.refreshToFinalState(
                started.telegram.api,
                started.chatId,
                started.firstMessageId
            )
        );
        expect(refreshed === true, 'the refresh re-delivered the stored layout');

        const firstEdit = lastEditOf(started.telegram, started.firstMessageId);
        expect(
            payloadText(firstEdit?.payload ?? {}) === '答案来了。',
            `the replay rebuilds the body without the footer (got ${JSON.stringify(
                payloadText(firstEdit?.payload ?? {})
            )})`
        );
        expect(
            previewOf(firstEdit?.payload ?? {}).disabled === true,
            'the replay body carries no card'
        );
        const linkEdit = started.telegram
            .callsOf('editMessageText')
            .find((call) => payloadText(call.payload) === searchLinkText(BIG_STATS_LINE));
        expect(linkEdit !== undefined, 'the replay rebuilds the link message');
        expect(
            previewOf(linkEdit?.payload ?? {}).url === link.url,
            'the replayed link message carries the page card'
        );
        expect(
            started.telegram.callsOf('sendMessage').length === 0,
            'the replay reuses the stored message ids instead of adding messages'
        );

        const after = await versionOf(started);
        expect(
            after?.searchLinkToken === link.token &&
                after.messageIds.length === before?.messageIds.length &&
                after.currentMessageId === before?.currentMessageId,
            'the refresh keeps the stored layout'
        );
    })
);

results.push(
    await runCase('the switch off still replays a message that was folded', async () => {
        const started = await startReply();
        const response = await streamInto(started.chatContext, [
            textChunk('答案来了。'),
            groundingChunk(bigFooter()),
        ]);
        await deliverFinal(started, response);
        const link = pageLinkOf(started, 1);
        expect(link !== null, 'the reply went out folded');
        if (link === null) return;

        // Turning the switch off must not un-fold a message that is already in the
        // chat: the replay keys the fold off the stored token, never the switch
        process.env.SEARCH_LINK = '0';
        try {
            started.telegram.reset();
            const refreshed = await quietly(() =>
                botMessageService.refreshToFinalState(
                    started.telegram.api,
                    started.chatId,
                    started.firstMessageId
                )
            );
            expect(refreshed === true, 'the folded version still replays');
            const replayLink = started.telegram
                .callsOf('editMessageText')
                .find((call) => payloadText(call.payload) === searchLinkText(BIG_STATS_LINE));
            expect(replayLink !== undefined, 'the link message is kept, not replaced by the footer');
            expect(
                previewOf(replayLink?.payload ?? {}).url === link.url,
                'with its page card'
            );
            expect(
                started.telegram.callsOf('deleteMessage').length === 0,
                'nothing is deleted for the switch'
            );
        } finally {
            delete process.env.SEARCH_LINK;
        }
        const after = await versionOf(started);
        expect(after?.searchLinkToken === link.token, 'the stored token is untouched');
    })
);

results.push(
    await runCase('a version switch replays each version footer shape', async () => {
        const started = await startReply();
        const first = await streamInto(started.chatContext, [
            textChunk('第一版答案。'),
            groundingChunk(bigFooter()),
        ]);
        await deliverFinal(started, first);
        const firstLink = pageLinkOf(started, 1);
        expect(firstLink !== null, 'the folded first version has a page');
        if (firstLink === null) return;

        // A retry in the same reply: its small footer stays inline, unfolded
        const retrySession: BotMessageSession | null = await quietly(() =>
            botMessageService.startRetry(started.chatContext.ctx, started.firstMessageId, {
                model: MODEL,
            })
        );
        expect(retrySession !== null, 'the retry session starts');
        if (retrySession === null) return;
        const retryChatContext = trackReply(
            responseHandler.createChatContextForRetry(started.chatContext.ctx, retrySession)
        );
        const second = await streamInto(retryChatContext, [
            textChunk('第二版答案。'),
            groundingChunk(smallFooter()),
        ]);
        await deliverFinal({ telegram: started.telegram, chatContext: retryChatContext }, second);
        const secondVersion = await versionOf(started);
        expect(
            secondVersion?.searchLinkToken === undefined,
            'the fitting footer is not folded'
        );
        const secondLink = pageLinkOf(started, 2);
        expect(
            secondLink !== null && secondLink.token !== firstLink.token,
            'version 2 has a page pointer of its own'
        );

        // Back to the folded version: its link message comes back as the last message
        const switchContext = contextOf(
            callbackUpdate({
                chatId: started.chatId,
                messageId: started.firstMessageId,
                userId: USER_ID,
                data: 'resp:prev',
            }),
            started.telegram
        );
        started.telegram.reset();
        const switchedToFirst = await quietly(() =>
            botMessageService.switchVersion(switchContext, started.firstMessageId, 'prev')
        );
        expect(switchedToFirst === true, 'the older folded version is switchable');
        const switchedLink = lastCallOf(started.telegram, 'sendMessage');
        expect(
            payloadText(switchedLink?.payload ?? {}) === searchLinkText(BIG_STATS_LINE),
            `the switched-to version shows the link message (got ${JSON.stringify(
                payloadText(switchedLink?.payload ?? {})
            )})`
        );
        expect(
            previewOf(switchedLink?.payload ?? {}).url === firstLink.url,
            'the switched-to link message carries its page card'
        );
        expect(
            switchedLink?.payload.reply_markup !== undefined,
            'the last message of the switched-to version carries the buttons'
        );
        const switchedBack = await dbIndex.getBotResponse(started.chatId, started.firstMessageId);
        expect(switchedBack?.currentVersionIndex === 0, 'the reply shows version 1');
        const firstVersion = switchedBack?.getVersions()[0];
        expect(
            firstVersion?.messageIds.length === 2 &&
                firstVersion.currentMessageId === firstVersion.messageIds[1],
            'the switched-to version records the link message as its last message'
        );

        // And forward again: version 2's fitting footer is inline, no link message
        started.telegram.reset();
        const switchedToSecond = await quietly(() =>
            botMessageService.switchVersion(switchContext, started.firstMessageId, 'next')
        );
        expect(switchedToSecond === true, 'and switchable back');
        const inlineEdit = lastEditOf(started.telegram, started.firstMessageId);
        expect(
            payloadText(inlineEdit?.payload ?? {}).includes('第二版答案。') &&
                payloadText(inlineEdit?.payload ?? {}).includes('小查询 1'),
            `the inline footer comes back (got ${JSON.stringify(
                payloadText(inlineEdit?.payload ?? {})
            )})`
        );
        expect(
            !textsOfMethod(started.telegram, 'editMessageText').some(isSearchLinkText) &&
                !textsOfMethod(started.telegram, 'sendMessage').some(isSearchLinkText),
            'no link message accompanies the inline version'
        );
        expect(
            started.telegram
                .callsOf('deleteMessage')
                .some((call) => call.payload.message_id === firstVersion?.messageIds[1]),
            'the folded version message is deleted on the switch away'
        );
        const finalState = await dbIndex.getBotResponse(started.chatId, started.firstMessageId);
        expect(finalState?.currentVersionIndex === 1, 'the reply shows version 2 again');
    })
);

results.push(
    await runCase('a footer that fits one message is not folded', async () => {
        const started = await startReply();
        const footer = smallFooter();
        expect(googleSearchFooterPlan([footer]) === 'fits', 'the footer fits one message');
        const response = await streamInto(started.chatContext, [
            textChunk('答案来了。'),
            groundingChunk(footer),
        ]);
        await deliverFinal(started, response);

        const version = await versionOf(started);
        expect(version?.searchLinkToken === undefined, 'no page token is stored');
        expect(started.chatContext.session.searchLink === undefined, 'no link on the session');
        expect(
            started.telegram.callsOf('sendMessage').length === 0,
            'the whole reply is one message'
        );
        const onlyEdit = lastEditOf(started.telegram, started.firstMessageId);
        const text = payloadText(onlyEdit?.payload ?? {});
        expect(
            text.includes('答案来了。') && text.includes('小查询 1') && text.includes('[1] 小来源'),
            `the footer stays inline (got ${JSON.stringify(text)})`
        );
        expect(isSearchLinkText(text) === false, 'no link label anywhere');
        expect(
            pageLinkOf(started, 1) !== null,
            'a page pointer would exist, but the fold never asked for it'
        );
    })
);

results.push(
    await runCase('the switch off or no public origin keeps the inline footer', async () => {
        const runInline = async (label: string): Promise<void> => {
            const started = await startReply();
            const response = await streamInto(started.chatContext, [
                textChunk('答案来了。'),
                groundingChunk(bigFooter()),
            ]);
            await deliverFinal(started, response);

            const version = await versionOf(started);
            expect(version?.searchLinkToken === undefined, `${label}: no page token is stored`);
            expect(
                started.chatContext.session.searchLink === undefined,
                `${label}: no link on the session`
            );
            expect(
                !textsOfMethod(started.telegram, 'editMessageText').some(isSearchLinkText) &&
                    !textsOfMethod(started.telegram, 'sendMessage').some(isSearchLinkText),
                `${label}: no link message appears`
            );
            const joined = allTexts(started.telegram).join('\n');
            expect(
                joined.includes('事故查询 1') && joined.includes('来源甲'),
                `${label}: the footer stays inline, split as before`
            );
        };

        process.env.SEARCH_LINK = '0';
        try {
            await runInline('switch off');
        } finally {
            delete process.env.SEARCH_LINK;
        }

        const publicUrl = process.env.WEBAPP_PUBLIC_URL;
        process.env.WEBAPP_PUBLIC_URL = '';
        try {
            await runInline('no public origin');
        } finally {
            process.env.WEBAPP_PUBLIC_URL = publicUrl;
        }
    })
);

results.push(
    await runCase('a stopped reply folds its footer and keeps the stop line', async () => {
        const started = await startReply();
        const response = await streamInto(started.chatContext, [
            textChunk('答案来了。'),
            groundingChunk(bigFooter()),
        ]);
        started.chatContext.session.streamController.abort();
        await deliverFinal(started, response);

        const link = pageLinkOf(started, 1);
        expect(link !== null, 'the stopped reply still gets its page');
        if (link === null) return;
        const version = await versionOf(started);
        expect(version?.wasStoppedByUser === true, 'the version records the stop');
        expect(version?.searchLinkToken === link.token, 'and the page token');
        const linkMessageId = version?.messageIds.at(-1) ?? 0;

        const bodyEdit = lastEditOf(started.telegram, started.firstMessageId);
        expect(
            payloadText(bodyEdit?.payload ?? {}).includes('[stopped]'),
            `the stop line stays in the body (got ${JSON.stringify(
                payloadText(bodyEdit?.payload ?? {})
            )})`
        );
        expect(
            payloadText(bodyEdit?.payload ?? {}).includes('事故查询') === false,
            'the footer is not in the stop line'
        );
        expect(
            payloadText(lastCallOf(started.telegram, 'sendMessage')?.payload ?? {}) ===
                searchLinkText(BIG_STATS_LINE),
            'the link message is the last message'
        );
        expect(
            started.telegram
                .callsOf('editMessageReplyMarkup')
                .every((call) => call.payload.message_id === linkMessageId) &&
                started.telegram.callsOf('editMessageReplyMarkup').length >= 1,
            'the retry button lands on the link message'
        );
    })
);

results.push(
    await runCase('an error reply shows no folded footer and its replay keeps the error line', async () => {
        const started = await startReply();
        // The grounding arrives, then the upstream fails: the reply is stored as
        // an errored version with its partial text
        const failingStream: AsyncIterable<StreamChunk> = {
            async *[Symbol.asyncIterator]() {
                yield textChunk('答案来了。');
                yield groundingChunk(bigFooter());
                await sleep(20);
                throw new Error('upstream exploded');
            },
        };
        let failure: Error | undefined;
        try {
            await quietly(() =>
                responseHandler.processStream(failingStream, started.chatContext, 0)
            );
        } catch (error) {
            failure = error instanceof Error ? error : new Error(String(error));
        }
        expect(failure !== undefined, 'the stream threw');
        if (failure === undefined) return;

        started.telegram.reset();
        await quietly(() => responseHandler.handleResponseError(started.chatContext, failure));
        const errorEdit = lastEditOf(started.telegram, started.firstMessageId);
        const errorText = payloadText(errorEdit?.payload ?? {});
        expect(
            errorText.includes('⚠'),
            `the live error line is shown (got ${JSON.stringify(errorText)})`
        );
        expect(errorText.includes('事故查询') === false, 'the live error shows no footer');
        expect(isSearchLinkText(errorText) === false, 'the live error is no folded link');

        const erroredVersion = await versionOf(started);
        expect(erroredVersion?.errorMessage !== undefined, 'the version stores the error');
        expect(
            erroredVersion?.searchLinkToken === undefined,
            'the error path never folded a footer, so it stores no token'
        );

        // The replay puts the error line on the last message it shows
        started.telegram.reset();
        const refreshed = await quietly(() =>
            botMessageService.refreshToFinalState(
                started.telegram.api,
                started.chatId,
                started.firstMessageId
            )
        );
        expect(refreshed === true, 'the errored version replays');
        const replayTexts = [
            ...textsOfMethod(started.telegram, 'editMessageText'),
            ...textsOfMethod(started.telegram, 'sendMessage'),
        ];
        expect(replayTexts.length >= 1, 'the replay delivered messages');
        expect(
            replayTexts.at(-1)?.includes('⚠') === true,
            `the error line lands on the last message (got ${JSON.stringify(replayTexts.at(-1))})`
        );
    })
);

results.push(
    await runCase('a thinking-only CoT link reply folds the footer after the link', async () => {
        const started = await startReply();
        const response = await streamInto(started.chatContext, [
            ...thinkingChunks(longThinking()),
            groundingChunk(bigFooter()),
        ]);
        started.chatContext.typing.stop();
        const sessionLink = started.chatContext.session.thinkingLink;
        expect(sessionLink !== undefined, 'the long CoT activated the link mode');
        expect(sessionLink?.emitted === false, 'no answer started, so the CoT link was never emitted');

        await deliverFinal(started, response);
        const link = pageLinkOf(started, 1);
        expect(link !== null, 'the folded footer has a page');
        if (link === null) return;
        const version = await versionOf(started);
        expect(version?.thinkingLinkToken === sessionLink?.token, 'the version keeps the CoT token');
        expect(version?.searchLinkToken === link.token, 'and the folded page token');
        expect(version?.text === '', 'a thinking-only reply stores no body text');
        expect(
            version?.messageIds.length === 2,
            `the layout is the CoT link plus the search link (got ${version?.messageIds.length})`
        );

        const firstEdit = lastEditOf(started.telegram, started.firstMessageId);
        expect(
            payloadText(firstEdit?.payload ?? {}).startsWith(`${SEARCH_LINK_LABEL}`) === false &&
                entitiesOf(firstEdit?.payload ?? {}).some(
                    (entity) =>
                        entity.type === 'text_link' && entity.url === sessionLink?.miniAppUrl
                ),
            'the first message stays the CoT link message'
        );
        const searchMessage = lastCallOf(started.telegram, 'sendMessage');
        expect(
            payloadText(searchMessage?.payload ?? {}) === searchLinkText(BIG_STATS_LINE),
            'the search link message follows the CoT link'
        );
        expect(
            previewOf(searchMessage?.payload ?? {}).url === link.url,
            'the search link message carries the page card'
        );

        // The replay rebuilds the same two messages: no drift on refresh
        started.telegram.reset();
        const refreshed = await quietly(() =>
            botMessageService.refreshToFinalState(
                started.telegram.api,
                started.chatId,
                started.firstMessageId
            )
        );
        expect(refreshed === true, 'the stored layout replays');
        const replaySearch = started.telegram
            .callsOf('editMessageText')
            .find((call) => payloadText(call.payload) === searchLinkText(BIG_STATS_LINE));
        expect(replaySearch !== undefined, 'the replay rebuilds the search link message');
        const replayCoT = lastEditOf(started.telegram, started.firstMessageId);
        expect(
            entitiesOf(replayCoT?.payload ?? {}).some(
                (entity) =>
                    entity.type === 'text_link' && entity.url === sessionLink?.miniAppUrl
            ),
            'the replayed first message keeps the CoT link'
        );
        expect(
            started.telegram.callsOf('sendMessage').length === 0,
            'the replay adds no message'
        );
    })
);

results.push(
    await runCase('a long CoT link and a folded footer live in one reply', async () => {
        const started = await startReply();
        const response = await streamInto(started.chatContext, [
            ...thinkingChunks(longThinking()),
            textChunk('答案来了。'),
            groundingChunk(bigFooter()),
        ]);
        const cotLink = started.chatContext.session.thinkingLink;
        expect(cotLink !== undefined && cotLink.emitted === true, 'the CoT link message went out');
        expect(
            started.chatContext.session.messageIds.length === 2,
            `the body streams after the CoT link (got ${started.chatContext.session.messageIds.length} messages)`
        );

        await deliverFinal(started, response);
        const link = pageLinkOf(started, 1);
        expect(link !== null, 'the folded footer has a page');
        if (link === null) return;
        const version = await versionOf(started);
        expect(version?.thinkingLinkToken === cotLink?.token, 'the version keeps the CoT token');
        expect(version?.searchLinkToken === link.token, 'and the folded page token');
        const messageIds = version?.messageIds ?? [];
        expect(
            messageIds.length === 3,
            `the reply is CoT link, body and search link (got ${messageIds.length})`
        );
        expect(messageIds[0] === started.firstMessageId, 'the CoT link leads the layout');
        expect(version?.currentMessageId === messageIds.at(-1), 'the search link is the current one');

        const edits = started.telegram.callsOf('editMessageText');
        expect(
            edits.every((call) => call.payload.message_id !== started.firstMessageId),
            'the delivered CoT link message is never rewritten'
        );
        const bodyEdit = lastEditOf(started.telegram, messageIds[1] ?? 0);
        expect(
            payloadText(bodyEdit?.payload ?? {}) === '答案来了。',
            `the body message holds the answer only (got ${JSON.stringify(
                payloadText(bodyEdit?.payload ?? {})
            )})`
        );
        const searchMessage = lastCallOf(started.telegram, 'sendMessage');
        expect(
            payloadText(searchMessage?.payload ?? {}) === searchLinkText(BIG_STATS_LINE),
            'the search link message ends the reply'
        );
        expect(
            previewOf(searchMessage?.payload ?? {}).url === link.url,
            'the search link message carries its page card'
        );

        // The replay rebuilds all three messages, each with its own card
        started.telegram.reset();
        const refreshed = await quietly(() =>
            botMessageService.refreshToFinalState(
                started.telegram.api,
                started.chatId,
                started.firstMessageId
            )
        );
        expect(refreshed === true, 'the stored layout replays');
        const replayCoT = lastEditOf(started.telegram, started.firstMessageId);
        expect(
            payloadText(replayCoT?.payload ?? {}).startsWith(THINKING_LINK_LABEL),
            `the replayed first message is the CoT link (got ${JSON.stringify(
                payloadText(replayCoT?.payload ?? {})
            )})`
        );
        expect(
            previewOf(replayCoT?.payload ?? {}).url === cotLink?.fastPageUrl,
            'the replayed CoT link keeps its fast-page card'
        );
        const replaySearch = started.telegram
            .callsOf('editMessageText')
            .find((call) => payloadText(call.payload) === searchLinkText(BIG_STATS_LINE));
        expect(replaySearch !== undefined, 'the replayed search link message is rebuilt');
        expect(
            previewOf(replaySearch?.payload ?? {}).url === link.url,
            'the replayed search link keeps its page card'
        );
        expect(
            started.telegram.callsOf('sendMessage').length === 0,
            'the replay adds no message'
        );
    })
);

results.push(
    await runCase('an image reply keeps the photo last and replays the same layout', async () => {
        const started = await startReply();
        const response = await streamInto(started.chatContext, [
            textChunk('答案来了。'),
            groundingChunk(bigFooter()),
            { type: 'image', imageData: PNG_BYTES },
        ]);
        await deliverFinal(started, response);

        const link = pageLinkOf(started, 1);
        expect(link !== null, 'the folded footer has a page');
        if (link === null) return;
        const version = await versionOf(started);
        expect(version?.searchLinkToken === link.token, 'the version stores the page token');
        expect(version?.imageBase64 !== undefined, 'the image is part of the version');
        const messageIds = version?.messageIds ?? [];
        expect(messageIds.length === 3, `body, link and photo are three messages (got ${messageIds.length})`);
        const imageMessageId = messageIds.at(-1) ?? 0;
        expect(version?.currentMessageId === imageMessageId, 'the photo is the current message');

        // The text layout (the link message included) goes out before the photo
        const methods = started.telegram.calls.map((call) => call.method);
        const linkIndex = methods.lastIndexOf('sendMessage');
        const photoIndex = methods.findIndex(
            (method) => method === 'sendPhoto' || method === 'sendDocument'
        );
        expect(linkIndex >= 0 && photoIndex > linkIndex, 'the photo goes out after the text layout');
        expect(
            payloadText(started.telegram.calls[linkIndex]?.payload ?? {}) ===
                searchLinkText(BIG_STATS_LINE),
            'the link message precedes the photo'
        );

        // The replay excludes the photo from the text layout and keeps it last
        started.telegram.reset();
        const refreshed = await quietly(() =>
            botMessageService.refreshToFinalState(
                started.telegram.api,
                started.chatId,
                started.firstMessageId
            )
        );
        expect(refreshed === true, 'the stored layout replays');
        const replayEdits = started.telegram.callsOf('editMessageText');
        expect(
            replayEdits.some((call) => payloadText(call.payload) === searchLinkText(BIG_STATS_LINE)),
            'the replay rebuilds the link message'
        );
        expect(
            replayEdits.some(
                (call) => call.payload.message_id === started.firstMessageId && previewOf(call.payload).disabled === true
            ),
            'the replayed body carries no card'
        );
        expect(
            replayEdits.every((call) => call.payload.message_id !== imageMessageId),
            'the photo message is never edited as text'
        );
        const after = await versionOf(started);
        expect(
            after?.messageIds.length === 3 && after.currentMessageId === imageMessageId,
            'the replay keeps the photo as the last message'
        );
    })
);

const { sequelize } = await import('../../src/db/config.js');
await sequelize.close();

// The replies' spinner and typing timers still run: without this the file would not end on its own and fail
endOpenReplies();
reportResults(results);
