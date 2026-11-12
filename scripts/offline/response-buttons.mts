/**
 * Offline cases for the reply buttons around a retry (design §7.3, §7.4):
 * the claim shared by retry and continue, so two fast clicks start one run
 * and the loser leaves the buttons alone; what stop, version switching and
 * unknown buttons answer while a claim is held; the claim given back on
 * every way out (a retry that throws or returns early, a refused click, a
 * failed answer); and an unknown `resp:` action refreshing the buttons.
 *
 * The bot is a real grammY Bot whose Bot API answers locally. The retry
 * handler is a stand-in the cases hold open, end or make throw: the claim
 * lives in the button handler, around whatever handler runs.
 *
 * Run: npx tsx scripts/offline/response-buttons.mts
 */
import type { Transformer } from 'grammy';
import { expect, reportResults, runCase, setupOfflineDb, takeMessageId, type CaseResult } from './harness.mts';
import { callbackUpdate, createFakeBot, lastToastOf, quietly, waitUntil } from './fake-telegram.mts';

await setupOfflineDb();
const dbIndex = await import('../../src/db/index.js');
const { registerResponseCallbacks, setRetryHandler } = await import('../../src/cmd/menus/response-menu.js');
const { updateChatSettings } = await import('../../src/services/chat-settings-service.js');
const { PAUSED_CALLBACK_NOTICE } = await import('../../src/reply/chat-pause.js');
const state = await import('../../src/state.js');

const { ButtonState } = dbIndex;
const MEMBER = { userId: 1111, isOwner: false };
const CLAIMED_NOTICE = '正在处理';
const STARTING_NOTICE = '正在启动，请稍后再点';
const json = (value: unknown): string => JSON.stringify(value);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---- the bot, with a retry handler the cases steer ----

const { bot, telegram } = createFakeBot();

// Installed last, so it runs before the recorder: lets a case make the
// callback answer fail
let failCallbackAnswers = false;
const failingCallbackAnswers: Transformer = (previous, method, payload, signal) => {
    if (failCallbackAnswers && method === 'answerCallbackQuery') {
        return Promise.reject(new Error('offline: answerCallbackQuery failed'));
    }
    return previous(method, payload, signal);
};
bot.api.config.use(failingCallbackAnswers);

registerResponseCallbacks(bot);

/** What the stand-in retry does once started; replaced per case */
let retryRun: () => Promise<void> = async () => undefined;
const retryStarts: number[] = [];
setRetryHandler(async (_ctx, firstMessageId) => {
    retryStarts.push(firstMessageId);
    await retryRun();
});

const gate = (): { opened: Promise<void>; open: () => void } => {
    let open: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => {
        open = resolve;
    });
    return { opened, open };
};

/** A button press on `messageId`; a failing handler is reported, not thrown */
const pressLoudly = async (chatId: number, messageId: number, data: string): Promise<unknown> => {
    try {
        await bot.handleUpdate(callbackUpdate({ chatId, messageId, userId: MEMBER.userId, data }));
        return null;
    } catch (error) {
        return error;
    }
};

/** One press with the console kept quiet (never nest these: each swaps the console) */
const press = (chatId: number, messageId: number, data: string): Promise<unknown> =>
    quietly(() => pressLoudly(chatId, messageId, data));

/** Let the detached work of a press (setImmediate) run */
const settle = (): Promise<void> => sleep(100);

const toasts = (): unknown[] => telegram.callsOf('answerCallbackQuery').map((call) => call.payload.text);

/** Telegram calls that change what the chat shows */
const editsOf = (): string[] =>
    telegram.calls
        .map((call) => call.method)
        .filter((method) => ['editMessageText', 'editMessageReplyMarkup', 'sendMessage', 'deleteMessage', 'sendPhoto'].includes(method));

/** A stored reply with `versionCount` versions, showing version `currentIndex + 1` */
const seedReply = async (
    chatId: number,
    options: { buttonState?: import('../../src/db/index.js').ButtonState; versionCount?: number; currentIndex?: number } = {}
): Promise<number> => {
    const firstMessageId = takeMessageId();
    const versionCount = options.versionCount ?? 2;
    const versions = Array.from({ length: versionCount }, (_unused, index) => ({
        versionId: index + 1,
        createdAt: new Date().toISOString(),
        messageIds: [firstMessageId],
        currentMessageId: firstMessageId,
        text: `版本 ${index + 1}`,
        wasStoppedByUser: false,
    }));
    await dbIndex.BotResponse.create({
        messageId: firstMessageId,
        chatId,
        userMessageId: firstMessageId - 1,
        currentVersionIndex: options.currentIndex ?? versionCount - 1,
        versions: JSON.stringify(versions),
        buttonState: options.buttonState ?? ButtonState.HAS_VERSIONS,
        metadata: JSON.stringify({ model: 'offline', hasImage: false }),
    });
    return firstMessageId;
};

const storedOf = async (chatId: number, firstMessageId: number) => {
    const stored = await dbIndex.getBotResponse(chatId, firstMessageId);
    if (!stored) throw new Error(`no stored reply ${chatId}:${firstMessageId}`);
    return stored;
};

const markupOf = (index: number): string => json(telegram.callsOf('editMessageReplyMarkup')[index]?.payload.reply_markup);

const cases: Array<{ name: string; body: () => Promise<void> }> = [
    {
        name: 'two fast retry clicks start one retry, and the click that lost leaves the buttons alone',
        body: async () => {
            const chatId = -1007200000001;
            const firstMessageId = await seedReply(chatId);
            const hold = gate();
            retryRun = () => hold.opened;
            retryStarts.length = 0;
            telegram.reset();

            // Both lookups run at the same time, both read the same stored state
            const pressed = await quietly(() =>
                Promise.all([
                    pressLoudly(chatId, firstMessageId, 'resp:retry'),
                    pressLoudly(chatId, firstMessageId, 'resp:retry'),
                ])
            );
            await waitUntil('the retry to start', () => retryStarts.length === 1);
            await settle();
            expect(pressed.every((error) => error === null), `both clicks are answered (got ${json(pressed)})`);
            expect(retryStarts.length === 1, `one retry started (got ${retryStarts.length})`);
            expect(
                json([...toasts()].sort()) === json(['重试中...', CLAIMED_NOTICE].sort()),
                `one click starts it, the other hears it is being handled (got ${json(toasts())})`
            );
            expect(editsOf().length === 0, `nobody touched the buttons (got ${json(editsOf())})`);
            expect(state.isReplyRerunClaimed(chatId, firstMessageId), 'the running retry holds the claim');

            telegram.reset();
            await press(chatId, firstMessageId, 'resp:retry');
            expect(
                lastToastOf(telegram) === CLAIMED_NOTICE && retryStarts.length === 1,
                'a later click while it runs starts nothing either'
            );

            hold.open();
            await waitUntil('the claim to be released', () => !state.isReplyRerunClaimed(chatId, firstMessageId));
            retryRun = async () => undefined;
            await press(chatId, firstMessageId, 'resp:retry');
            await waitUntil('the next retry to start', () => retryStarts.length === 2);
            expect(lastToastOf(telegram) === '重试中...', 'once it ended, retry works again');
            await waitUntil('that claim to be released', () => !state.isReplyRerunClaimed(chatId, firstMessageId));
        },
    },
    {
        name: 'while a retry starts, stop, version switching and an unknown button only answer with a notice',
        body: async () => {
            const chatId = -1007200000002;
            const firstMessageId = await seedReply(chatId, { versionCount: 3, currentIndex: 1 });
            const hold = gate();
            retryRun = () => hold.opened;
            retryStarts.length = 0;
            await press(chatId, firstMessageId, 'resp:retry');
            await waitUntil('the retry to start', () => retryStarts.length === 1);

            // Claimed, PROCESSING not written yet
            for (const data of ['resp:stop', 'resp:prev', 'resp:next', 'resp:continue']) {
                telegram.reset();
                await press(chatId, firstMessageId, data);
                await settle();
                expect(
                    lastToastOf(telegram) === STARTING_NOTICE && editsOf().length === 0,
                    `${data} answers ${STARTING_NOTICE} and changes nothing (got ${json({ toast: lastToastOf(telegram), edits: editsOf() })})`
                );
            }
            const untouched = await storedOf(chatId, firstMessageId);
            expect(
                untouched.currentVersionIndex === 1 && untouched.buttonState === ButtonState.HAS_VERSIONS,
                `the stored reply is as it was (got ${untouched.currentVersionIndex}, ${untouched.buttonState})`
            );

            // The retry wrote PROCESSING: a version switch still waits, and a
            // stop that finds no session does not mark the running retry retryable
            await dbIndex.updateBotResponseButtonState(chatId, firstMessageId, ButtonState.PROCESSING);
            telegram.reset();
            await press(chatId, firstMessageId, 'resp:prev');
            await settle();
            expect(
                lastToastOf(telegram) === '还在生成中' && editsOf().length === 0,
                `a switch during the run only answers (got ${json({ toast: lastToastOf(telegram), edits: editsOf() })})`
            );
            telegram.reset();
            await press(chatId, firstMessageId, 'resp:stop');
            await settle();
            const afterStop = await storedOf(chatId, firstMessageId);
            expect(
                lastToastOf(telegram) === '停止中...' && editsOf().length === 0 && afterStop.buttonState === ButtonState.PROCESSING,
                `the claimed run keeps its state (got ${json({ toast: lastToastOf(telegram), edits: editsOf(), state: afterStop.buttonState })})`
            );

            await dbIndex.updateBotResponseButtonState(chatId, firstMessageId, ButtonState.HAS_VERSIONS);
            hold.open();
            await waitUntil('the claim to be released', () => !state.isReplyRerunClaimed(chatId, firstMessageId));
            telegram.reset();
            await press(chatId, firstMessageId, 'resp:stop');
            await waitUntil('the refresh to the final state', () => telegram.callsOf('editMessageText').length > 0);
            expect(lastToastOf(telegram) === '已结束，刷新到最新状态', 'without a claim, a stale stop refreshes as before');
        },
    },
    {
        name: 'the claim is given back after a retry that throws or returns early, and on every early way out',
        body: async () => {
            const chatId = -1007200000003;
            const firstMessageId = await seedReply(chatId);
            const released = (): boolean => !state.isReplyRerunClaimed(chatId, firstMessageId);

            retryStarts.length = 0;
            retryRun = async () => {
                throw new Error('offline: the retry exploded');
            };
            // The detached retry logs its failure: kept quiet until it is over
            await quietly(async () => {
                await pressLoudly(chatId, firstMessageId, 'resp:retry');
                await waitUntil('the throwing retry to run', () => retryStarts.length === 1);
                await waitUntil('the claim to be released after the throw', released);
            });

            // Like startRetry returning null: the handler ends without a run
            retryRun = async () => undefined;
            await press(chatId, firstMessageId, 'resp:retry');
            await waitUntil('the early-returning retry to run', () => retryStarts.length === 2);
            await waitUntil('the claim to be released after the early return', released);

            // The callback answer fails after the claim: no retry, claim back
            failCallbackAnswers = true;
            let failed: unknown;
            try {
                failed = await press(chatId, firstMessageId, 'resp:retry');
            } finally {
                failCallbackAnswers = false;
            }
            await settle();
            expect(failed instanceof Error && retryStarts.length === 2, `a failed answer starts nothing (got ${String(failed)})`);
            expect(released(), 'and gives the claim back');

            // Still generating: refused with the stop button put back
            await dbIndex.updateBotResponseButtonState(chatId, firstMessageId, ButtonState.PROCESSING);
            telegram.reset();
            await press(chatId, firstMessageId, 'resp:retry');
            expect(
                lastToastOf(telegram) === '还在生成中' && markupOf(0).includes('resp:stop'),
                `a reply still generating refuses the retry (got ${json({ toast: lastToastOf(telegram), markup: markupOf(0) })})`
            );
            expect(released() && retryStarts.length === 2, 'and gives the claim back');
            await dbIndex.updateBotResponseButtonState(chatId, firstMessageId, ButtonState.HAS_VERSIONS);

            // A paused chat: refused
            await updateChatSettings({ chatId, patch: { paused: true }, actor: MEMBER });
            try {
                await press(chatId, firstMessageId, 'resp:retry');
                expect(lastToastOf(telegram) === PAUSED_CALLBACK_NOTICE, 'a paused chat refuses the retry');
                expect(released() && retryStarts.length === 2, 'and gives the claim back');
            } finally {
                await updateChatSettings({ chatId, patch: { paused: false }, actor: MEMBER });
            }

            await press(chatId, firstMessageId, 'resp:retry');
            await waitUntil('a retry after all that', () => retryStarts.length === 3);
            await waitUntil('its claim to be released', released);
        },
    },
    {
        name: 'an unknown resp: action refreshes the buttons to the reply’s current state',
        body: async () => {
            const chatId = -1007200000004;
            const withVersions = await seedReply(chatId, { versionCount: 2, currentIndex: 1 });
            telegram.reset();
            await press(chatId, withVersions, 'resp:continue');
            expect(lastToastOf(telegram) === '按钮已失效，已刷新', `the click is answered (got ${String(lastToastOf(telegram))})`);
            expect(
                telegram.callsOf('editMessageReplyMarkup').length === 1 &&
                    markupOf(0).includes('resp:prev') &&
                    markupOf(0).includes('resp:retry') &&
                    !markupOf(0).includes('resp:continue'),
                `the buttons become [<] [重试] (got ${markupOf(0)})`
            );

            const retryOnly = await seedReply(chatId, { buttonState: ButtonState.RETRY_ONLY, versionCount: 1 });
            telegram.reset();
            await press(chatId, retryOnly, 'resp:some-future-action');
            expect(
                markupOf(0).includes('resp:retry') && !markupOf(0).includes('resp:prev'),
                `a single failed version gets its retry button back (got ${markupOf(0)})`
            );

            telegram.reset();
            await press(chatId, takeMessageId(), 'resp:continue');
            expect(
                lastToastOf(telegram) === '未知操作' && editsOf().length === 0,
                'a message without a stored reply is only answered'
            );
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
const { sequelize } = await import('../../src/db/config.js');
await sequelize.close();
reportResults(results);
