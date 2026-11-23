/**
 * Offline cases for the generation commands' terminal outcomes (design
 * 2026-1123-1610 §6.3).
 *
 * The text that stays in the chat after a failure, a cancel or a timeout must
 * be recorded as the bot's own row: later contexts quote it, and the inbound
 * reaction path can only resolve message ids that exist in the database. The
 * progress placeholder ("排队中" / "生成中" / "下载中") is never recorded — it
 * is transient and the success path deletes it.
 *
 * comfy-forward is a local stub of its HTTP API and Telegram is the usual fake.
 * Run: `pnpm test:offline generation-outcome-notice`
 */
import type { ServerResponse } from 'node:http';
import { expect, reportResults, runCase, setupOfflineDb, takeMessageId, type CaseResult } from './harness.mts';
import {
    contextOf,
    createFakeTelegram,
    messageUpdate,
    quietly,
    waitUntil,
    type FakeTelegram,
    type TelegramCall,
} from './fake-telegram.mts';
import { startStubServer } from './support/stub-server.mts';

// Read when an outcome is recorded/saved, not at import time
process.env.BOT_USER_NAME = 'AfterSchoolTeatimeBot';
process.env.BOT_NAME = 'K-ON';
process.env.BOT_USER_ID = '7777';

// The comfy client snapshots its base URL at import, so the stub comes first
const comfy = await startStubServer();
process.env.COMFY_FORWARD_URL = comfy.url;
// Poll pacing at test speed; the job timeout stays production-like (15 min)
process.env.COMFY_FAST_POLL_MS = '1';
// The /vid storyboard client reads its base URL when it is first used
process.env.GROK_API_URL = comfy.url;

const db = await setupOfflineDb();
const { Message } = db;
const { runGeneration } = await import('../../src/reply/commands/generation-runner.js');
const { handleVidCommand } = await import('../../src/reply/commands/vid-command.js');
const { cancelJob } = await import('../../src/reply/commands/generation-job-store.js');
type GenerationRun = import('../../src/reply/commands/generation-runner.js').GenerationRun;

const BOT_USER_ID = 7777;
const ALICE = { id: 5001, name: 'Alice' };
const JOB_ID = 'job-1';
/** One transparent pixel: the download step must hand bytes back */
const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
);
const WORKFLOWS = [
    {
        id: 'z-image-turbo',
        name: 'Z-Image Turbo 文生图',
        kind: 'text-to-image',
        input_image_required: false,
        accepted_inputs: [],
    },
    {
        id: 'minimax-h3-turbo',
        name: 'MiniMax H3 Turbo 文生视频',
        kind: 'text-to-video',
        input_image_required: false,
        accepted_inputs: ['input_image'],
    },
];

/** A fresh chat per case, so one case's rows never leak into another's */
let nextChatId = -1009200000000;
const takeChatId = (): number => (nextChatId -= 1);

type PollStatus = 'queued' | 'running' | 'succeeded' | 'failed';

interface ComfyScript {
    /** What /health answers, one per call; the last entry repeats. Default ok */
    health?: ReadonlyArray<'ok' | 'down'>;
    submit?: 'ok' | 'reject';
    /** Statuses answered by successive polls; the last one repeats. Default ['running'] */
    poll?: ReadonlyArray<PollStatus>;
    /** Answer the first poll with this HTTP status instead of a job status */
    pollRejectsWith?: number;
    jobError?: string;
    /** Delay before answering each poll: lets a case observe a run mid-flight */
    pollDelayMs?: number;
    download?: 'ok' | 'reject';
    /** Grok storyboard answer: a 400 (the command degrades) or a real storyboard */
    storyboard?: 'fail' | 'ok';
    /** Runs after a poll is answered — e.g. presses ⏹ while the job runs */
    onPoll?: (pollIndex: number) => void;
}

const answerJson = (response: ServerResponse, status: number, payload: unknown): void => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(payload));
};

/** Point the comfy stub at one case's script */
const installComfy = (script: ComfyScript = {}): void => {
    const health = script.health ?? ['ok'];
    const polls = script.poll ?? ['running'];
    let healthCalls = 0;
    let pollCalls = 0;

    comfy.handle((request, response) => {
        request.resume();
        const path = request.url ?? '';

        if (path === '/health') {
            const answer = health[Math.min(healthCalls, health.length - 1)] ?? 'ok';
            healthCalls += 1;
            if (answer === 'down') {
                answerJson(response, 503, { error: 'unavailable', message: 'comfy-forward is down' });
                return;
            }
            answerJson(response, 200, { comfyui: 'available', queue: { running: 0, pending: 0 } });
            return;
        }

        if (path === '/v1/workflows') {
            answerJson(response, 200, { workflows: WORKFLOWS });
            return;
        }

        if (path === '/chat/completions') {
            if (script.storyboard === 'ok') {
                answerJson(response, 200, {
                    id: 'chatcmpl-offline',
                    object: 'chat.completion',
                    created: 0,
                    model: 'grok-4.7',
                    choices: [
                        {
                            index: 0,
                            message: {
                                role: 'assistant',
                                content: '<Picture 1> 雨夜的香港街头，红色电车驶过。',
                            },
                            finish_reason: 'stop',
                        },
                    ],
                });
                return;
            }
            answerJson(response, 400, {
                error: { message: 'grok offline', type: 'invalid_request_error' },
            });
            return;
        }

        if (path === '/v1/generations' && request.method === 'POST') {
            if (script.submit === 'reject') {
                answerJson(response, 400, { error: 'invalid', message: 'prompt 太长了' });
                return;
            }
            answerJson(response, 200, { id: JOB_ID });
            return;
        }

        if (path === `/v1/generations/${JOB_ID}`) {
            const index = pollCalls;
            pollCalls += 1;
            if (script.pollRejectsWith !== undefined && index === 0) {
                answerJson(response, script.pollRejectsWith, { error: 'poll', message: 'poll exploded' });
                return;
            }
            const status = polls[Math.min(index, polls.length - 1)] ?? 'running';
            const answer = (): void => {
                script.onPoll?.(index);
                answerJson(response, 200, {
                    id: JOB_ID,
                    status,
                    ...(script.jobError === undefined ? {} : { error: script.jobError }),
                    images:
                        status === 'succeeded'
                            ? [{ index: 0, filename: 'image-0.png', url: '' }]
                            : [],
                    videos: [],
                });
            };
            if (script.pollDelayMs === undefined || script.pollDelayMs <= 0) answer();
            else setTimeout(answer, script.pollDelayMs);
            return;
        }

        if (path === `/v1/generations/${JOB_ID}/images/0`) {
            if (script.download === 'reject') {
                answerJson(response, 404, { error: 'gone', message: 'result expired' });
                return;
            }
            response.writeHead(200, { 'Content-Type': 'image/png' });
            response.end(PNG_BYTES);
            return;
        }

        answerJson(response, 404, { error: 'no route', message: `no route ${path}` });
    });
};

const runFor = (
    telegram: FakeTelegram,
    chatId: number,
    userMessageId: number
): GenerationRun => ({
    api: telegram.api,
    chatId,
    userMessageId,
    kind: 'image',
    request: { workflow: 'z-image-turbo', prompt: '一只猫' },
    spoiler: false,
    workflowName: 'Z-Image Turbo 文生图',
});

/** The bot's own rows in one chat, in message order */
const botRows = async (chatId: number) =>
    Message.findAll({ where: { chatId, fromBotSelf: true }, order: [['messageId', 'ASC']] });

const textOf = (call: TelegramCall | undefined): string =>
    typeof call?.payload.text === 'string' ? call.payload.text : '';

const messageIdOf = (call: TelegramCall | undefined): number | undefined =>
    typeof call?.payload.message_id === 'number' ? call.payload.message_id : undefined;

/** The first callback data of a reply markup, e.g. `gen:retry:…` */
const buttonDataOf = (call: TelegramCall | undefined): string | undefined => {
    const markup = call?.payload.reply_markup;
    if (typeof markup !== 'object' || markup === null) return undefined;
    const rows = Reflect.get(markup, 'inline_keyboard');
    if (!Array.isArray(rows)) return undefined;
    for (const row of rows) {
        if (!Array.isArray(row)) continue;
        for (const button of row) {
            if (typeof button !== 'object' || button === null) continue;
            const data = Reflect.get(button, 'callback_data');
            if (typeof data === 'string') return data;
        }
    }
    return undefined;
};

const caseResult = async (
    name: string,
    body: () => Promise<void>
): Promise<CaseResult> => runCase(`[gen] ${name}`, body);

const cases: CaseResult[] = [];

cases.push(
    await caseResult('a failed health check is posted fresh and recorded', async () => {
        const chatId = takeChatId();
        const commandId = takeMessageId();
        installComfy({ health: ['down'] });
        const telegram = createFakeTelegram();

        await quietly(() => runGeneration(runFor(telegram, chatId, commandId)));

        const sent = telegram.callsOf('sendMessage');
        expect(sent.length === 1, `no placeholder before the health failure (got ${sent.length} messages)`);
        expect(textOf(sent[0]) === '生成服务未启动', `the reason is posted (got ${JSON.stringify(textOf(sent[0]))})`);
        expect(buttonDataOf(sent[0])?.startsWith('gen:retry:') === true, 'a retry button is offered');

        const rows = await botRows(chatId);
        expect(rows.length === 1, `the outcome is recorded once (got ${rows.length} rows)`);
        expect(rows[0]?.text === '生成服务未启动', 'with the text the user reads');
        expect(rows[0]?.replyToId === commandId, 'answering the command message');
        expect(rows[0]?.userId === BOT_USER_ID, 'under the bot user id');
        expect((rows[0]?.messageId ?? 0) > 500_000, 'under the id Telegram returned');
    })
);

cases.push(
    await caseResult('a submit failure edits the placeholder and records the outcome', async () => {
        const chatId = takeChatId();
        const commandId = takeMessageId();
        installComfy({ submit: 'reject' });
        const telegram = createFakeTelegram();

        await quietly(() => runGeneration(runFor(telegram, chatId, commandId)));

        const edits = telegram.callsOf('editMessageText');
        expect(edits.length === 1, `the placeholder is edited into the failure (got ${edits.length} edits)`);
        const placeholderId = messageIdOf(edits[0]);
        expect(placeholderId !== undefined, 'the edit targets a message id');
        expect(textOf(edits[0]).startsWith('参数不合法：'), `the comfy reason is shown (got ${textOf(edits[0])})`);
        expect(buttonDataOf(edits[0])?.startsWith('gen:retry:') === true, 'a retry button is offered');

        const rows = await botRows(chatId);
        expect(rows.length === 1, `one outcome row (got ${rows.length})`);
        expect(rows[0]?.messageId === placeholderId, 'recorded under the edited placeholder id');
        expect(rows[0]?.text === textOf(edits[0]), 'with the final text, not a progress label');
        expect(rows[0]?.replyToId === commandId, 'answering the command message');
    })
);

cases.push(
    await caseResult('a terminal outcome posted when the placeholder is gone is recorded too', async () => {
        const chatId = takeChatId();
        const commandId = takeMessageId();
        installComfy({ submit: 'reject' });
        const telegram = createFakeTelegram({
            refuse: (call) =>
                call.method === 'editMessageText'
                    ? { error_code: 400, description: 'Bad Request: message to edit not found' }
                    : null,
        });

        await quietly(() => runGeneration(runFor(telegram, chatId, commandId)));

        const sent = telegram.callsOf('sendMessage');
        expect(sent.length === 2, `the opening message plus the fallback (got ${sent.length})`);
        const placeholderId = messageIdOf(telegram.callsOf('editMessageText')[0]);
        expect(textOf(sent[1]) === textOf(telegram.callsOf('editMessageText')[0]), 'the fallback repeats the outcome');

        const rows = await botRows(chatId);
        expect(rows.length === 1, `the fallback is recorded once (got ${rows.length})`);
        expect(rows[0]?.messageId !== placeholderId, 'under the id of the message it actually sent');
        expect((rows[0]?.messageId ?? 0) > 500_000, 'which is the id Telegram returned');
        expect(rows[0]?.text === textOf(sent[1]), 'with the visible text');
        expect(rows[0]?.replyToId === commandId, 'answering the command message');
    })
);

cases.push(
    await caseResult('a polling failure is recorded', async () => {
        const chatId = takeChatId();
        const commandId = takeMessageId();
        installComfy({ pollRejectsWith: 500 });
        const telegram = createFakeTelegram();

        await quietly(() => runGeneration(runFor(telegram, chatId, commandId)));

        const finalEdit = telegram.callsOf('editMessageText').at(-1);
        expect(
            textOf(finalEdit).startsWith('生成失败（多半是显存不够）：poll exploded'),
            `the polling error is shown (got ${textOf(finalEdit)})`
        );

        const rows = await botRows(chatId);
        expect(rows.length === 1, `the polling failure is recorded (got ${rows.length})`);
        expect(rows[0]?.text === textOf(finalEdit), 'with the visible text');
        expect(rows[0]?.messageId === messageIdOf(finalEdit), 'on the edited placeholder');
        expect(buttonDataOf(finalEdit)?.startsWith('gen:retry:') === true, 'a retry button is offered');
    })
);

cases.push(
    await caseResult('a timeout is recorded instead of the last progress text', async () => {
        const chatId = takeChatId();
        const commandId = takeMessageId();
        const realNow = Date.now;
        let offsetMs = 0;
        Date.now = () => realNow() + offsetMs;
        try {
            // Each poll moves the clock past the 15-minute picture budget
            installComfy({ poll: ['running'], onPoll: () => (offsetMs += 20 * 60_000) });
            const telegram = createFakeTelegram();
            await quietly(() => runGeneration(runFor(telegram, chatId, commandId)));

            const finalEdit = telegram.callsOf('editMessageText').at(-1);
            expect(textOf(finalEdit).includes('还没出结果'), `the timeout is shown (got ${textOf(finalEdit)})`);
            expect(textOf(finalEdit).includes('生成中') === false, 'not a leftover progress text');

            const rows = await botRows(chatId);
            expect(rows.length === 1, `the timeout is recorded (got ${rows.length})`);
            expect(rows[0]?.text === textOf(finalEdit), 'with the visible text');
            expect(rows[0]?.replyToId === commandId, 'answering the command message');
        } finally {
            Date.now = realNow;
        }
    })
);

cases.push(
    await caseResult('a cancelled wait is recorded and offers no retry', async () => {
        const chatId = takeChatId();
        const commandId = takeMessageId();
        installComfy({ poll: ['running'], onPoll: () => cancelJob(JOB_ID) });
        const telegram = createFakeTelegram();

        await quietly(() => runGeneration(runFor(telegram, chatId, commandId)));

        const finalEdit = telegram.callsOf('editMessageText').at(-1);
        expect(textOf(finalEdit).startsWith('已取消等待'), `the cancel text is shown (got ${textOf(finalEdit)})`);
        expect(buttonDataOf(finalEdit) === undefined, 'cancelling is not something to one-tap undo');

        const rows = await botRows(chatId);
        expect(rows.length === 1, `the cancel is recorded (got ${rows.length})`);
        expect(rows[0]?.text === textOf(finalEdit), 'with the visible text');
        expect(rows[0]?.messageId === messageIdOf(finalEdit), 'on the edited placeholder');
    })
);

cases.push(
    await caseResult('a download failure is recorded', async () => {
        const chatId = takeChatId();
        const commandId = takeMessageId();
        installComfy({ poll: ['succeeded'], download: 'reject' });
        const telegram = createFakeTelegram();

        await quietly(() => runGeneration(runFor(telegram, chatId, commandId)));

        const finalEdit = telegram.callsOf('editMessageText').at(-1);
        expect(textOf(finalEdit).startsWith('下载生成的图失败：'), `the download error is shown (got ${textOf(finalEdit)})`);
        expect(textOf(finalEdit).includes('下载中') === false, 'not the progress text it replaced');

        const rows = await botRows(chatId);
        expect(rows.length === 1, `the download failure is recorded (got ${rows.length})`);
        expect(rows[0]?.text === textOf(finalEdit), 'with the visible text');
        expect(rows[0]?.messageId === messageIdOf(finalEdit), 'on the edited placeholder');
        expect(buttonDataOf(finalEdit)?.startsWith('gen:retry:') === true, 'a retry button is offered');
    })
);

cases.push(
    await caseResult('a send failure is recorded and stores no media row', async () => {
        const chatId = takeChatId();
        const commandId = takeMessageId();
        installComfy({ poll: ['succeeded'] });
        const telegram = createFakeTelegram({
            refuse: (call) =>
                call.method === 'sendPhoto'
                    ? { error_code: 400, description: 'Bad Request: chat not found' }
                    : null,
        });

        await quietly(() => runGeneration(runFor(telegram, chatId, commandId)));

        const finalEdit = telegram.callsOf('editMessageText').at(-1);
        expect(textOf(finalEdit).startsWith('发送失败：'), `the send error is shown (got ${textOf(finalEdit)})`);

        const rows = await botRows(chatId);
        expect(rows.length === 1, `only the outcome row exists — no media row (got ${rows.length})`);
        expect(rows[0]?.text === textOf(finalEdit), 'with the visible text');
        expect(rows[0]?.messageId === messageIdOf(finalEdit), 'on the edited placeholder');
        expect(buttonDataOf(finalEdit)?.startsWith('gen:retry:') === true, 'a retry button is offered');
    })
);

cases.push(
    await caseResult('the success path stores the picture and records no notice', async () => {
        const chatId = takeChatId();
        const commandId = takeMessageId();
        installComfy({ poll: ['succeeded'] });
        const telegram = createFakeTelegram();

        await quietly(() => runGeneration(runFor(telegram, chatId, commandId)));

        const deleted = telegram.callsOf('deleteMessage');
        expect(deleted.length === 1, 'the placeholder is deleted, as before');
        const placeholderId = messageIdOf(deleted[0]);
        expect(placeholderId !== undefined, 'the delete targets the placeholder');

        const rows = await botRows(chatId);
        expect(rows.length === 1, `the result picture is the only bot row (got ${rows.length})`);
        expect(rows[0]?.text === '[生成的图片] 一只猫', 'the stored media row keeps its label');
        expect(rows[0]?.file !== null, 'with the picture bytes');
        expect(rows[0]?.messageId !== placeholderId, 'under the id of the sent photo, not the placeholder');
        expect(rows[0]?.replyToId === commandId, 'answering the command message');

        const placeholder = await Message.findOne({ where: { chatId, messageId: placeholderId } });
        expect(placeholder === null, 'no row for the placeholder: progress and "下载中" were never recorded');
    })
);

cases.push(
    await caseResult('progress text is not recorded while the job runs', async () => {
        const chatId = takeChatId();
        const commandId = takeMessageId();
        installComfy({ poll: ['running', 'running', 'failed'], jobError: 'CUDA out of memory', pollDelayMs: 120 });
        const telegram = createFakeTelegram();

        const running = quietly(() => runGeneration(runFor(telegram, chatId, commandId)));
        await waitUntil('the first progress edit', () => telegram.callsOf('editMessageText').length >= 1);
        const placeholderId = messageIdOf(telegram.callsOf('editMessageText')[0]);
        expect(placeholderId !== undefined, 'the progress edit targets the placeholder');
        const duringProgress = await Message.findOne({ where: { chatId, messageId: placeholderId } });
        expect(duringProgress === null, 'the progress text has no row while it is shown');

        await running;

        const rows = await botRows(chatId);
        expect(rows.length === 1, `only the terminal failure is recorded (got ${rows.length})`);
        expect(rows[0]?.text === '生成失败：CUDA out of memory', 'with the job error');
        expect(rows[0]?.messageId === placeholderId, 'the progress placeholder becomes the terminal row');
    })
);

cases.push(
    await caseResult('/vid help is guidance, not an outcome: not recorded', async () => {
        const chatId = takeChatId();
        const commandId = takeMessageId();
        installComfy();
        const telegram = createFakeTelegram();
        const ctx = contextOf(
            messageUpdate({ chatId, messageId: commandId, userId: ALICE.id, text: '/vid' }),
            telegram
        );

        await quietly(() => handleVidCommand(ctx));

        const sent = telegram.callsOf('sendMessage');
        expect(sent.length === 1, `the help is posted (got ${sent.length} messages)`);
        expect(textOf(sent[0]).includes('生成视频用法'), 'with the usage header');
        expect((await botRows(chatId)).length === 0, 'but it is not recorded as context');
    })
);

cases.push(
    await caseResult('/vid reports a bad flag as a recorded outcome', async () => {
        const chatId = takeChatId();
        const commandId = takeMessageId();
        installComfy();
        const telegram = createFakeTelegram();
        const ctx = contextOf(
            messageUpdate({ chatId, messageId: commandId, userId: ALICE.id, text: '/vid -d=99 雨夜' }),
            telegram
        );

        await quietly(() => handleVidCommand(ctx));

        const sent = telegram.callsOf('sendMessage');
        expect(sent.length === 1, `the error is posted (got ${sent.length} messages)`);
        expect(textOf(sent[0]).includes('参数 `-d=99` 不合法'), `naming the bad flag (got ${textOf(sent[0])})`);

        const rows = await botRows(chatId);
        expect(rows.length === 1, `the usage error is recorded (got ${rows.length})`);
        expect(rows[0]?.text === textOf(sent[0]), 'with the visible text');
        expect(rows[0]?.replyToId === commandId, 'answering the command message');
    })
);

cases.push(
    await caseResult('/vid records a degraded storyboard notice, then its terminal health failure', async () => {
        const chatId = takeChatId();
        const commandId = takeMessageId();
        // The pre-flight health check passes; the one inside runGeneration fails
        installComfy({ health: ['ok', 'down'], storyboard: 'fail' });
        const telegram = createFakeTelegram();
        const ctx = contextOf(
            messageUpdate({
                chatId,
                messageId: commandId,
                userId: ALICE.id,
                text: '/vid -w=minimax-h3-turbo 雨夜的街头',
            }),
            telegram
        );

        await quietly(() => handleVidCommand(ctx));

        const sent = telegram.callsOf('sendMessage');
        expect(textOf(sent[0]) === '🎬 正在写分镜…', 'the storyboard placeholder is sent first');
        expect(textOf(sent[1]) === '生成服务未启动', 'then the health failure is posted');

        const edits = telegram.callsOf('editMessageText');
        expect(edits.length === 1, `the storyboard placeholder is edited into the warning (got ${edits.length})`);
        expect(textOf(edits[0]).startsWith('⚠️ Grok 没响应'), `the degrade reason is shown (got ${textOf(edits[0])})`);

        const rows = await botRows(chatId);
        expect(rows.length === 2, `the degraded warning and the health failure are recorded (got ${rows.length})`);
        const warning = rows.find((row) => row.messageId === messageIdOf(edits[0]));
        expect(warning !== undefined, 'the warning is recorded under the edited notice id');
        expect(warning?.text === textOf(edits[0]), 'with the visible warning text');
        expect(warning?.replyToId === commandId, 'answering the command message');
        expect(rows.some((row) => row.text === '生成服务未启动'), 'and the health failure is recorded too');
    })
);

cases.push(
    await caseResult('/vid does not record the HTML storyboard', async () => {
        const chatId = takeChatId();
        const commandId = takeMessageId();
        installComfy({ health: ['ok', 'down'], storyboard: 'ok' });
        const telegram = createFakeTelegram();
        const ctx = contextOf(
            messageUpdate({
                chatId,
                messageId: commandId,
                userId: ALICE.id,
                text: '/vid -w=minimax-h3-turbo 雨夜的街头',
            }),
            telegram
        );

        await quietly(() => handleVidCommand(ctx));

        const storyboardEdit = telegram
            .callsOf('editMessageText')
            .find((call) => textOf(call).includes('<blockquote expandable>'));
        expect(storyboardEdit !== undefined, 'the storyboard is edited into the notice message');
        const storyboardId = messageIdOf(storyboardEdit);
        expect(storyboardId !== undefined, 'the storyboard edit targets the notice');

        const rows = await botRows(chatId);
        expect(rows.length === 1, `only the health failure is recorded (got ${rows.length})`);
        expect(rows[0]?.text === '生成服务未启动', 'and it is the run outcome');
        expect(rows.every((row) => row.messageId !== storyboardId), 'the HTML storyboard itself has no row');
    })
);

comfy.reset();
await comfy.close();
reportResults(cases);
