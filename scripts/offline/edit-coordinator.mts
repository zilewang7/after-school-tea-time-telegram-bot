/**
 * Offline cases for the edit coordinator.
 *
 * The time scale of the Telegram call pacing: the harness runs the pacing a
 * hundred times faster so the suite does not wait out real 500ms gaps. These
 * cases pin the two things that makes safe: a scale really shortens the gap,
 * and a broken value (empty, not a number, zero) falls back to production
 * pacing instead of switching it off.
 *
 * Rich states (rich_message markdown): a different format is a change even
 * with the same string, a refusal goes back to the submitter once and is
 * never degraded to entities, a 429 is retried and "not modified" settles.
 *
 * Run: pnpm test:offline edit-coordinator
 */
import { GrammyError } from 'grammy';
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import { createFakeTelegram, type TelegramCall, type TelegramRefusal } from './fake-telegram.mts';

const { parseTimeScale, primeSentState, runApiCall, submitEdit } = await import('../../src/telegram/edit-coordinator.js');

/** Production gap between two calls in the same chat */
const BURST_INTERVAL_MS = 500;

/** Wall time of two back-to-back calls in a chat nothing else has used */
const timeTwoCalls = async (chatId: number): Promise<number> => {
    const startedAt = performance.now();
    await runApiCall(chatId, async () => undefined);
    await runApiCall(chatId, async () => undefined);
    return performance.now() - startedAt;
};

const withTimeScale = async <T,>(value: string | undefined, body: () => Promise<T>): Promise<T> => {
    const previous = process.env.EDIT_COORDINATOR_TIME_SCALE;
    if (value === undefined) delete process.env.EDIT_COORDINATOR_TIME_SCALE;
    else process.env.EDIT_COORDINATOR_TIME_SCALE = value;
    try {
        return await body();
    } finally {
        if (previous === undefined) delete process.env.EDIT_COORDINATOR_TIME_SCALE;
        else process.env.EDIT_COORDINATOR_TIME_SCALE = previous;
    }
};

const results: CaseResult[] = [];

results.push(
    await runCase('a finite positive scale is used as given', () => {
        expect(parseTimeScale('0.01') === 0.01, 'a fraction');
        expect(parseTimeScale('2') === 2, 'a value above one');
    })
);

results.push(
    await runCase('any other value keeps production pacing', () => {
        for (const raw of [undefined, '', '   ', 'abc', '0', '-1', 'Infinity', 'NaN']) {
            expect(parseTimeScale(raw) === 1, `${JSON.stringify(raw)} means 1`);
        }
    })
);

results.push(
    await runCase('the harness scale shortens the gap between two calls', async () => {
        expect(process.env.EDIT_COORDINATOR_TIME_SCALE === '0.01', 'the harness set the scale on import');
        const elapsedMs = await timeTwoCalls(880001);
        expect(elapsedMs < BURST_INTERVAL_MS / 2, `two calls took ${elapsedMs.toFixed(0)}ms`);
    })
);

results.push(
    await runCase('the scale is read on every call, not once at import', async () => {
        const elapsedMs = await withTimeScale('0.2', () => timeTwoCalls(880002));
        expect(elapsedMs >= 90, `a fifth of the production gap was waited out (${elapsedMs.toFixed(0)}ms)`);
        expect(elapsedMs < BURST_INTERVAL_MS, `and not the whole gap (${elapsedMs.toFixed(0)}ms)`);
    })
);

results.push(
    await runCase('an empty scale leaves the production gap in place', async () => {
        const elapsedMs = await withTimeScale('', () => timeTwoCalls(880003));
        // A few ms of slack: timers may fire slightly early
        expect(elapsedMs >= BURST_INTERVAL_MS - 20, `the full gap was waited out (${elapsedMs.toFixed(0)}ms)`);
    })
);

// ---------------------------------------------------------------------------
// Rich states
// ---------------------------------------------------------------------------

const RICH_MESSAGE_ID = 77;
let nextRichChat = 880100;

/** A fake API that refuses the first calls with the given answers, then takes every call */
const refusingTelegram = (refusals: readonly TelegramRefusal[]) => {
    const queue = [...refusals];
    return createFakeTelegram({ refuse: () => queue.shift() ?? null });
};

const isRichEdit = (call: TelegramCall | undefined): boolean =>
    call?.method === 'editMessageText' && call.payload.text === undefined && call.payload.rich_message !== undefined;

const STOP_BUTTON = { inline_keyboard: [[{ text: '停止', callback_data: 'resp:stop' }]] };

results.push(
    await runCase('a rich state is a change even with the string the message already shows as text', async () => {
        const telegram = createFakeTelegram();
        const chatId = (nextRichChat += 1);
        primeSentState(chatId, RICH_MESSAGE_ID, '**x**');
        const delivered = await submitEdit(telegram.api, chatId, RICH_MESSAGE_ID, '**x**', { isFinal: true, rich: {} });
        expect(delivered, 'the rich edit is delivered');
        const [edit] = telegram.calls;
        expect(telegram.calls.length === 1 && isRichEdit(edit), `one rich edit went out (got ${JSON.stringify(telegram.calls)})`);
        expect(JSON.stringify(edit?.payload.rich_message) === JSON.stringify({ markdown: '**x**' }), 'the markdown rides in rich_message');

        // And back: the same string as text after a rich state is a change too
        const plain = await submitEdit(telegram.api, chatId, RICH_MESSAGE_ID, '**x**', { isFinal: true });
        expect(plain && telegram.calls.length === 2, 'the text edit after it is sent as well');
        expect(telegram.calls[1]?.payload.text === '**x**', 'as text');
    })
);

results.push(
    await runCase('a rich edit carries the buttons but no entities and no link preview', async () => {
        const telegram = createFakeTelegram();
        const chatId = (nextRichChat += 1);
        await submitEdit(telegram.api, chatId, RICH_MESSAGE_ID, 'a **b**', {
            entities: [{ type: 'bold', offset: 0, length: 1 }],
            linkPreviewOptions: { is_disabled: true },
            replyMarkup: STOP_BUTTON,
            isFinal: true,
            rich: {},
        });
        const payload = telegram.calls[0]?.payload ?? {};
        expect(
            JSON.stringify(payload) ===
                JSON.stringify({ chat_id: chatId, message_id: RICH_MESSAGE_ID, rich_message: { markdown: 'a **b**' }, reply_markup: STOP_BUTTON }),
            `exactly the markdown and the buttons (got ${JSON.stringify(payload)})`
        );
    })
);

results.push(
    await runCase('a refused rich state is reported once and never degraded to entities', async () => {
        const telegram = refusingTelegram([{ error_code: 400, description: 'Bad Request: can\'t parse rich message' }]);
        const chatId = (nextRichChat += 1);
        const rejections: GrammyError[] = [];
        const delivered = await submitEdit(telegram.api, chatId, RICH_MESSAGE_ID, '| a |', {
            entities: [{ type: 'bold', offset: 0, length: 1 }],
            isFinal: true,
            rich: { onRejected: (error) => rejections.push(error) },
        });
        expect(!delivered, 'the final rich state is not delivered');
        expect(rejections.length === 1, `the submitter hears it once (got ${rejections.length})`);
        expect(
            rejections[0] instanceof GrammyError && rejections[0].error_code === 400 && rejections[0].description.includes('rich message'),
            'with the GrammyError grammY made of the refusal'
        );
        expect(telegram.calls.length === 1, `nothing else is tried (got ${telegram.calls.map((call) => call.method).join(', ')})`);

        // A streaming (non-final) rich state too
        const streaming = refusingTelegram([{ error_code: 400, description: 'Bad Request: too many blocks' }]);
        const streamingRejections: GrammyError[] = [];
        const accepted = await submitEdit(streaming.api, (nextRichChat += 1), RICH_MESSAGE_ID, 'frame', {
            rich: { onRejected: (error) => streamingRejections.push(error) },
        });
        expect(!accepted && streamingRejections.length === 1 && streaming.calls.length === 1, 'a streaming state: reported once, not retried');
    })
);

results.push(
    await runCase('a 429 on a rich state is retried as rich; "message is not modified" settles', async () => {
        const telegram = refusingTelegram([{ error_code: 429, description: 'Too Many Requests' }]);
        const chatId = (nextRichChat += 1);
        const rejections: GrammyError[] = [];
        const delivered = await submitEdit(telegram.api, chatId, RICH_MESSAGE_ID, '## 标题', {
            isFinal: true,
            rich: { onRejected: (error) => rejections.push(error) },
        });
        expect(delivered, 'delivered after the penalty');
        expect(telegram.calls.length === 2 && telegram.calls.every(isRichEdit), `two rich attempts (got ${telegram.calls.length})`);
        expect(rejections.length === 0, 'a 429 is not a refusal');

        const unchanged = refusingTelegram([{ error_code: 400, description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same' }]);
        const unchangedRejections: GrammyError[] = [];
        const settled = await submitEdit(unchanged.api, (nextRichChat += 1), RICH_MESSAGE_ID, '## 标题', {
            isFinal: true,
            rich: { onRejected: (error) => unchangedRejections.push(error) },
        });
        expect(settled && unchanged.calls.length === 1 && unchangedRejections.length === 0, '"not modified" counts as delivered');
    })
);

reportResults(results);
