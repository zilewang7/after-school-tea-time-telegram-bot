/**
 * Offline cases for what "继续" does once pressed (design 2026-1112-1123
 * §6.1, §6.5, §6.6; test plan §11 第 3 期 cases 3, 4, 6, 7, 9, 11, 12, 14
 * and 16), end to end: the real chat, retry and continue handlers on the
 * fake Bot API, the real Gemini platform on the fake Vertex endpoint, the
 * real reply tools, a local MCP server (notify_owner stands in for the SMS
 * tool, slow_lookup runs until the reply is stopped, web_lookup returns a
 * source) and the scratch database. See support/resume-bench.mts.
 *
 * Run: npx tsx scripts/offline/reply-resume.mts
 */
import { expect, reportResults, runCase, type CaseResult } from './harness.mts';
import { endOpenReplies, waitUntil } from './fake-telegram.mts';
import { httpErrorReply, sseReply, stalledStreamReply, type RecordedRequest, type ScriptedReply } from './support/fake-vertex.mts';
import {
    answer,
    callPart,
    callsRound,
    event,
    groundingOf,
    roundEvents,
    textPart,
    thoughtPart,
    type ScriptedCall,
} from './support/gemini-loop-fixtures.mts';
import {
    asArray,
    asRecord,
    createResumeBench,
    finalButtonsOf,
    gate,
    imageReply,
    json,
    quietCase,
    takeChatId,
    type AskedReply,
} from './support/resume-bench.mts';

const bench = await createResumeBench();
const { telegram, vertex } = bench;
const { STOPPED_DURING_CALL_NOTE } = await import('../../src/ai/platforms/gemini/gemini-round-contents.js');
const { ONE_ATTACHMENT_PER_REPLY } = await import('../../src/reply/tools/reply-media-state.js');
const { loadThinkingDocument } = await import('../../src/panel/thinking/thinking-view.js');
const { getActiveSession } = await import('../../src/services/bot-message-service.js');

// ---- reading requests ----

interface FunctionAnswer {
    readonly name: string;
    readonly output?: string;
    readonly error?: string;
}

/** Every function response a request sends, in order */
const answersIn = (request: RecordedRequest | undefined): FunctionAnswer[] =>
    asArray(request?.body.contents)
        .flatMap((content) => asArray(asRecord(content).parts))
        .map((part) => asRecord(asRecord(part).functionResponse))
        .filter((functionResponse) => typeof functionResponse.name === 'string')
        .map((functionResponse) => {
            const response = asRecord(functionResponse.response);
            return {
                name: String(functionResponse.name),
                ...(typeof response.output === 'string' ? { output: response.output } : {}),
                ...(typeof response.error === 'string' ? { error: response.error } : {}),
            };
        });

/** A round whose stream starts and then hangs until the reply is stopped */
const stalledRound = (thinking: string, text: string) =>
    stalledStreamReply([event([thoughtPart(thinking)]), event([textPart(text)])]);

const stopReply = async (reply: { readonly chatId: number; readonly firstMessageId: number }): Promise<void> => {
    const thrown = await bench.press(reply, 'resp:stop');
    if (thrown !== null) throw new Error(`the stop click threw: ${String(thrown)}`);
};

/** The reply of a chat's only question, as soon as its session exists */
const runningReplyOf = async (chatId: number): Promise<AskedReply> => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        const response = await bench.dbIndex.BotResponse.findOne({ where: { chatId } });
        if (response) return { chatId, userMessageId: response.userMessageId, firstMessageId: response.messageId };
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('no running reply');
};

const sentDocuments = (): number[] =>
    telegram.callsOf('sendDocument').map((call) => Number(asRecord(call.payload).chat_id));

const deletedMessages = (): number[] =>
    telegram.callsOf('deleteMessage').map((call) => Number(asRecord(call.payload).message_id));

const FILE_ROUND = callsRound('r1', [{ name: 'send_file', args: { file_name: 'notes.md', content: '# 笔记\n第一轮写的文件' } }], {
    text: '先把文件写好。',
});

/**
 * A stopped version with the buffered file delivered: then "继续" deletes the
 * file message of that version and the new version delivers the file once
 */
const expectStoppedThenContinued = async (reply: AskedReply, label: string): Promise<void> => {
    const stopped = await bench.latestVersion(reply);
    expect(stopped.wasStoppedByUser, `${label}: the version is stopped`);
    expect(json(finalButtonsOf(telegram)) === json(['继续', '重试']), `${label}: [继续] [重试] (got ${json(finalButtonsOf(telegram))})`);
    expect(sentDocuments().length === 1, `${label}: the stopped version delivered the buffered file (got ${sentDocuments().length})`);
    const fileMessageId = stopped.messageIds.at(-1);
    expect(fileMessageId !== undefined && fileMessageId !== reply.firstMessageId, `${label}: the file is the version's last message`);
    expect(bench.entryOf(reply)?.loop.completedRounds === 1, `${label}: round 1 is kept`);

    telegram.reset();
    vertex.reset([answer('第二轮重新回答。')]);
    const thrown = await bench.continueReply(reply);
    expect(thrown === null, `${label}: the click went through (got ${String(thrown)})`);
    expect(bench.toasts().includes('继续中...'), `${label}: answered 继续中... (got ${json(bench.toasts())})`);
    expect(deletedMessages().includes(fileMessageId ?? -1), `${label}: the stopped version's file message is deleted (got ${json(deletedMessages())})`);
    expect(sentDocuments().length === 1, `${label}: the new version delivers the file once (got ${sentDocuments().length})`);
    const resumed = await bench.latestVersion(reply);
    expect(
        resumed.versionId === stopped.versionId + 1 && resumed.text.includes('先把文件写好。') && resumed.text.includes('第二轮重新回答。'),
        `${label}: the new version holds the kept round and the new one (got ${json(resumed.text)})`
    );
    expect(resumed.file?.name === 'notes.md' && !resumed.wasStoppedByUser && resumed.errorMessage === undefined, `${label}: with the file`);
    expect(json(finalButtonsOf(telegram)) === json(['<', '重试']), `${label}: no 继续 after a finished resume (got ${json(finalButtonsOf(telegram))})`);
    expect(bench.entryOf(reply) === undefined && bench.markOf(reply) === undefined, `${label}: no entry, no mark`);
};


const BAD_REQUEST = 'Request contains an invalid argument.';
/** A round that fails at once and is not retried: the reply ends in an error */
const failingRound = () => httpErrorReply(400, BAD_REQUEST);

interface RoundScript {
    readonly label: string;
    readonly thinking?: readonly string[];
    readonly text?: readonly string[];
    readonly calls?: readonly ScriptedCall[];
    readonly grounding?: Record<string, unknown>;
}

/** One model round: its thinking chunks, then its text chunks, then its calls in one chunk */
const roundOf = (script: RoundScript, onServe?: () => void) =>
    sseReply(
        roundEvents(
            [
                ...(script.thinking ?? []).map((thinking) => [thoughtPart(thinking)]),
                ...(script.text ?? []).map((text) => [textPart(text)]),
                ...((script.calls ?? []).length > 0
                    ? [
                          (script.calls ?? []).map((call, index) =>
                              callPart(call.name, call.args ?? {}, `${script.label}-${index}`, `call_${script.label}_${index}`)
                          ),
                      ]
                    : []),
            ],
            script.grounding === undefined ? {} : { grounding: script.grounding }
        ),
        onServe
    );

const webLookup = (query: string): ScriptedCall => ({ name: 'web_lookup', args: { query } });

/** Six sections of ~700 characters: over one message, so the thinking link starts */
const longThinking = (label: string): string[] =>
    Array.from({ length: 6 }, (_unused, index) => `**${label}${index}**\n\n${'推理'.repeat(350)}\n\n`);

/** Text long enough that the legacy display needs more than one message */
const longText = (label: string): string[] =>
    Array.from({ length: 20 }, (_unused, index) => `${label} 第 ${index + 1} 段：${'很长的回答内容。'.repeat(60)}\n\n`);

/** The function responses' texts of a request, output or error */
const answerTexts = (request: RecordedRequest | undefined): string[] =>
    answersIn(request).map((item) => item.output ?? item.error ?? '');

/** Every entity the calls of the fake Bot API carried */
const entitiesSent = (): Record<string, unknown>[] =>
    telegram.calls.flatMap((call) => asArray(call.payload.entities).map(asRecord));

const usageRounds = (lines: readonly string[]): string[] =>
    lines
        .filter((line) => line.startsWith('[gemini-usage]') && !line.includes(' summary '))
        .map((line) => /round=(\d+)/.exec(line)?.[1] ?? '?');

const callsNamed = (name: string): number => bench.mcpCalls.filter((call) => call.name === name).length;

/** A reply that ran round 1 (these calls) and failed at round 2: its checkpoint keeps one round */
const failedAfterRound1 = async (round1: RoundScript, question = '@AfterSchoolTeatimeBot 查一下'): Promise<AskedReply> => {
    vertex.reset([roundOf(round1), failingRound()]);
    telegram.reset();
    const reply = await bench.ask(takeChatId(), question);
    const kept = bench.entryOf(reply);
    if (kept?.loop.completedRounds !== 1) {
        throw new Error(`the failed reply kept no round-1 checkpoint (got ${json(kept?.loop.completedRounds)})`);
    }
    return reply;
};

const cases: Array<{ name: string; body: () => Promise<void> }> = [
    {
        name: 'case 3: stopped mid-stream, then 继续: the stopped version loses its file message, the new one sends the file once',
        body: quietCase(async () => {
            const chatId = takeChatId();
            vertex.reset([FILE_ROUND, stalledRound('第二轮的思考', '第二轮说到一半')]);
            telegram.reset();
            const asked = bench.askInBackground(chatId, '@AfterSchoolTeatimeBot 写个文件');
            await waitUntil('round 2 to stream', () => vertex.requests.length === 2);
            const running = await runningReplyOf(chatId);
            await stopReply(running);
            const reply = await asked.done;
            await expectStoppedThenContinued(reply, 'mid-stream');
        }),
    },
    {
        name: 'case 3: stopped while an automatic retry waits, then 继续',
        body: quietCase(async () => {
            const chatId = takeChatId();
            vertex.reset([FILE_ROUND, httpErrorReply(429, 'Resource exhausted. Please try again later.')]);
            telegram.reset();
            bench.gemini.holdWaits = true;
            try {
                const waitsBefore = bench.gemini.waits.length;
                const asked = bench.askInBackground(chatId, '@AfterSchoolTeatimeBot 写个文件');
                await waitUntil('the retry wait', () => bench.gemini.waits.length > waitsBefore);
                const running = await runningReplyOf(chatId);
                await stopReply(running);
                const reply = await asked.done;
                expect(vertex.requests.length === 2, `round 2 was not reopened after the stop (got ${vertex.requests.length})`);
                await expectStoppedThenContinued(reply, 'retry wait');
            } finally {
                bench.gemini.holdWaits = false;
            }
        }),
    },
    {
        name: 'case 3: stopped during a tool call, then 继续',
        body: quietCase(async () => {
            const chatId = takeChatId();
            const callsBefore = bench.mcpCalls.length;
            vertex.reset([FILE_ROUND, callsRound('r2', [{ name: 'slow_lookup', args: { topic: 'slow' } }])]);
            telegram.reset();
            const asked = bench.askInBackground(chatId, '@AfterSchoolTeatimeBot 写个文件再慢慢查');
            await waitUntil('the slow tool to run', () => bench.mcpCalls.length > callsBefore);
            const running = await runningReplyOf(chatId);
            await stopReply(running);
            const reply = await asked.done;
            const kept = bench.entryOf(reply);
            expect(kept?.loop.completedRounds === 2, `the round of the stopped call is kept (got ${kept?.loop.completedRounds})`);
            // The helper expects one kept round; this one keeps two
            const stopped = await bench.latestVersion(reply);
            expect(json(finalButtonsOf(telegram)) === json(['继续', '重试']), `[继续] [重试] (got ${json(finalButtonsOf(telegram))})`);
            expect(sentDocuments().length === 1 && stopped.wasStoppedByUser, 'the stopped version delivered the file');
            const fileMessageId = stopped.messageIds.at(-1);

            telegram.reset();
            vertex.reset([answer('查不到也没关系。')]);
            await bench.continueReply(reply);
            expect(deletedMessages().includes(fileMessageId ?? -1), `the file message is deleted (got ${json(deletedMessages())})`);
            expect(sentDocuments().length === 1, `the new version sends the file once (got ${sentDocuments().length})`);
            const answers = answersIn(vertex.requests[0]);
            expect(
                answers.at(-1)?.name === 'slow_lookup' && answers.at(-1)?.error?.includes(STOPPED_DURING_CALL_NOTE) === true,
                `the stopped call says it may have taken effect (got ${json(answers.at(-1))})`
            );
            expect(bench.mcpCalls.filter((call) => call.name === 'slow_lookup').length === 1, 'the slow tool is not run again');
        }),
    },
    {
        name: 'case 4: round 2 tells the owner, then a slow call is stopped; 继续 tells nobody again and sends both real answers',
        body: quietCase(async () => {
            const chatId = takeChatId();
            vertex.reset([
                roundOf({ label: 'r1', thinking: ['先查一下'], calls: [webLookup('k-on')] }),
                roundOf({
                    label: 'r2',
                    thinking: ['告诉机主，再慢慢查'],
                    calls: [
                        { name: 'notify_owner', args: { content: '有人找你' } },
                        { name: 'slow_lookup', args: { topic: 'slow' } },
                    ],
                }),
            ]);
            telegram.reset();
            const ownerBefore = callsNamed('notify_owner');
            const slowBefore = callsNamed('slow_lookup');
            const asked = bench.askInBackground(chatId, '@AfterSchoolTeatimeBot 告诉机主一声');
            await waitUntil('the slow call', () => callsNamed('slow_lookup') > slowBefore);
            await stopReply(await runningReplyOf(chatId));
            const reply = await asked.done;
            expect(callsNamed('notify_owner') === ownerBefore + 1, 'the owner was told once');
            expect(bench.entryOf(reply)?.loop.completedRounds === 2, `round 2 is kept (got ${json(bench.entryOf(reply)?.loop.completedRounds)})`);

            vertex.reset([answer('已经告诉机主了。')]);
            telegram.reset();
            await bench.continueReply(reply);
            expect(callsNamed('notify_owner') === ownerBefore + 1, 'the stand-in for send_sms_to_owner is not called again');
            expect(callsNamed('slow_lookup') === slowBefore + 1, 'nor is the slow lookup');
            const answers = answersIn(vertex.requests[0]);
            expect(json(answers.map((item) => item.name)) === json(['web_lookup', 'notify_owner', 'slow_lookup']), `three answers (got ${json(answers)})`);
            expect(
                answers[1]?.output?.startsWith('delivered to the owner') === true,
                `notify_owner: its real result (got ${json(answers[1])})`
            );
            expect(
                answers[2]?.error?.includes(STOPPED_DURING_CALL_NOTE) === true,
                `slow_lookup: its error and the "may have taken effect" note (got ${json(answers[2])})`
            );
            const version = await bench.latestVersion(reply);
            expect(version.text.includes('已经告诉机主了。') && !version.wasStoppedByUser, 'the resumed version ends normally');
        }),
    },
    {
        name: 'case 6: the resumed version is whole (text, thinking, tool records, usage, round-1 grounding); page, bot row and #N links agree',
        body: quietCase(async () => {
            const thinking = longThinking('A');
            const reply = await failedAfterRound1({
                label: 'r1',
                thinking,
                text: ['第一轮的话，见 #1。'],
                calls: [webLookup('k-on')],
                grounding: groundingOf(['round one query'], ['https://grounded.test/a']),
            });
            const failed = await bench.latestVersion(reply);
            expect(failed.thinkingLinkToken !== undefined, 'the interrupted version had its thinking link');
            expect(bench.entryOf(reply)?.context.numbering.get(1) === reply.userMessageId, '#1 is the question');
            // Only the resume itself can publish the numbering again
            bench.state.getAppState().contextNumbering.delete(`${reply.chatId}:${reply.userMessageId}`);

            vertex.reset([roundOf({ label: 'r2', thinking: ['第二轮的思考'], text: ['第二轮的话，再看 #1。'] })]);
            telegram.reset();
            await bench.continueReply(reply);

            const version = await bench.latestVersion(reply);
            expect(
                version.text.includes('第一轮的话') && version.text.includes('第二轮的话'),
                `the text of both rounds (got ${json(version.text)})`
            );
            expect(
                version.thinkingText?.startsWith(thinking.join('')) === true && version.thinkingText.includes('第二轮的思考'),
                `the thinking of both rounds (got ${version.thinkingText?.length ?? 0} chars)`
            );
            expect(json(version.agentStats?.toolUsage) === json([{ name: 'web_lookup', count: 1 }]), `the tool usage of round 1 (got ${json(version.agentStats)})`);
            const grounding = version.groundingData ?? [];
            expect(
                grounding.some((step) => asArray(asRecord(step).searchQueries).includes('web_lookup: k-on')),
                `the tool record of round 1 (got ${json(grounding)})`
            );
            expect(grounding.some((step) => json(step).includes('round one query')), 'the search grounding of round 1');
            expect(version.thinkingLinkToken !== undefined && version.thinkingLinkToken !== failed.thinkingLinkToken, 'a link of its own');

            const page = await loadThinkingDocument(version.thinkingLinkToken ?? '');
            expect(page?.text === version.thinkingText, `the thinking page shows the stored thinking (got ${page?.text.length ?? 0} chars)`);
            const botRow = await bench.dbIndex.getMessage(reply.chatId, reply.firstMessageId);
            expect(botRow?.text === version.text, `the bot row holds the version's text (got ${json(botRow?.text)})`);
            expect(bench.state.getContextNumbering(reply.chatId, reply.userMessageId)?.get(1) === reply.userMessageId, 'the numbering is published again');
            const links = entitiesSent().filter(
                (entity) => entity.type === 'text_link' && String(entity.url).endsWith(`/${reply.userMessageId}`)
            );
            expect(links.length >= 2, `both #1 become links to the question (got ${links.length})`);
        }),
    },
    {
        name: 'case 6: in the legacy split mode the replay sends its continuation messages again, before the new round',
        body: quietCase(async (log) => {
            process.env.THINKING_LINK = '0';
            try {
                const reply = await failedAfterRound1({
                    label: 'r1',
                    thinking: ['第一轮想了想'],
                    text: longText('第一轮'),
                    calls: [webLookup('k-on')],
                });
                const failed = await bench.latestVersion(reply);
                expect(failed.thinkingLinkToken === undefined && failed.messageIds.length >= 3, `the failed version took several messages (got ${failed.messageIds.length})`);

                const continuationsSent = (): number =>
                    telegram.callsOf('sendMessage').filter((call) => call.payload.text === 'continued').length;
                let continuationsBeforeRequest = -1;
                vertex.reset([
                    roundOf({ label: 'r2', text: ['第二轮的话。'] }, () => {
                        continuationsBeforeRequest = continuationsSent();
                    }),
                ]);
                telegram.reset();
                await bench.continueReply(reply);
                expect(continuationsBeforeRequest >= 2, `the replay re-created the continuations first (got ${continuationsBeforeRequest})`);
                const version = await bench.latestVersion(reply);
                expect(
                    version.text.startsWith(failed.text.trimEnd()) && version.text.endsWith('第二轮的话。'),
                    'the version is the kept text plus the new one'
                );
                expect(version.messageIds.length >= failed.messageIds.length, 'spread over as many messages');
                expect(log.has('[resume] replay chunks='), 'the replay is logged');
            } finally {
                delete process.env.THINKING_LINK;
            }
        }),
    },
    {
        name: 'case 7: a buffered image, sticker, file and widget each go out exactly once with the resumed version; the attachment flag is back',
        body: quietCase(async () => {
            const variants: Array<{ label: string; before: ScriptedReply[]; sentCount: () => number }> = [
                {
                    label: 'image',
                    before: [
                        roundOf({ label: 'i1', calls: [{ name: 'generate_image', args: { prompt: '一只猫' } }] }),
                        imageReply(),
                        roundOf({ label: 'i2', calls: [{ name: 'send_image', args: { image_id: 'g1' } }] }),
                    ],
                    sentCount: () => telegram.callsOf('sendPhoto').length,
                },
                {
                    label: 'sticker',
                    before: [roundOf({ label: 's1', calls: [{ name: 'send_sticker', args: { sticker: '07' } }] })],
                    sentCount: () => telegram.callsOf('sendSticker').length,
                },
                {
                    label: 'file',
                    before: [roundOf({ label: 'f1', calls: [{ name: 'send_file', args: { file_name: 'a.md', content: '# A' } }] })],
                    sentCount: () => telegram.callsOf('sendDocument').length,
                },
                {
                    label: 'widget',
                    before: [
                        roundOf({
                            label: 'w1',
                            calls: [{ name: 'send_widget', args: { mode: 'html', html: '<div class="card">卡片内容</div>', caption: '卡片' } }],
                        }),
                    ],
                    sentCount: () => telegram.callsOf('sendMessage').filter((call) => call.payload.text === '卡片').length,
                },
            ];
            for (const variant of variants) {
                vertex.reset([...variant.before, failingRound()]);
                telegram.reset();
                const reply = await bench.ask(takeChatId(), `@AfterSchoolTeatimeBot 发个${variant.label}`);
                expect(variant.sentCount() === 0, `${variant.label}: the failed version sent nothing`);
                expect(json(finalButtonsOf(telegram)) === json(['继续', '重试']), `${variant.label}: [继续] [重试] (got ${json(finalButtonsOf(telegram))})`);

                vertex.reset([
                    roundOf({ label: `${variant.label}-again`, calls: [{ name: 'send_sticker', args: { sticker: '12' } }] }),
                    answer('附件在上面。'),
                ]);
                telegram.reset();
                await bench.continueReply(reply);
                expect(variant.sentCount() === 1, `${variant.label}: delivered exactly once (got ${variant.sentCount()})`);
                expect(
                    answerTexts(vertex.requests[1]).at(-1)?.includes(ONE_ATTACHMENT_PER_REPLY) === true,
                    `${variant.label}: a second attachment is refused, the flag came back (got ${json(answerTexts(vertex.requests[1]).at(-1))})`
                );
                if (variant.label !== 'sticker') {
                    expect(telegram.callsOf('sendSticker').length === 0, `${variant.label}: no sticker went out`);
                }
            }
        }),
    },
    {
        name: 'case 9: 继续 goes on counting: 已调用 N 次 includes the kept calls, the round numbers go on, the usage shown is cumulative',
        body: quietCase(async (log) => {
            const reply = await failedAfterRound1({ label: 'r1', thinking: ['查两次'], calls: [webLookup('a'), webLookup('b')] });
            vertex.reset([roundOf({ label: 'r2', calls: [webLookup('c')] }), answer('查完了。')]);
            telegram.reset();
            const linesBefore = log.lines.length;
            await bench.continueReply(reply);
            expect(
                answerTexts(vertex.requests[1]).at(-1)?.includes('[工具轮次] 本次回复已调用工具 3 次。') === true,
                `the count goes on from the kept calls (got ${json(answerTexts(vertex.requests[1]).at(-1))})`
            );
            expect(json(usageRounds(log.lines.slice(linesBefore))) === json(['2', '3']), `rounds 2 and 3 (got ${json(usageRounds(log.lines.slice(linesBefore)))})`);
            const version = await bench.latestVersion(reply);
            expect(json(version.agentStats?.toolUsage) === json([{ name: 'web_lookup', count: 3 }]), `cumulative usage (got ${json(version.agentStats)})`);
        }),
    },
    {
        name: 'case 9 and 11: 重试 starts from nothing (round 1, 已调用 1 次) and the kept checkpoint is gone',
        body: quietCase(async (log) => {
            const reply = await failedAfterRound1({ label: 'r1', calls: [webLookup('a'), webLookup('b')] });
            vertex.reset([roundOf({ label: 'fresh', calls: [webLookup('c')] }), answer('重新查完了。')]);
            telegram.reset();
            const linesBefore = log.lines.length;
            await bench.retryReply(reply);
            expect(answersIn(vertex.requests[0]).length === 0, 'the retry sends a fresh round 1');
            expect(
                answerTexts(vertex.requests[1]).at(-1)?.includes('[工具轮次] 本次回复已调用工具 1 次。') === true,
                `the count starts over (got ${json(answerTexts(vertex.requests[1]).at(-1))})`
            );
            expect(json(usageRounds(log.lines.slice(linesBefore))) === json(['1', '2']), `rounds 1 and 2 (got ${json(usageRounds(log.lines.slice(linesBefore)))})`);
            const version = await bench.latestVersion(reply);
            expect(json(version.agentStats?.toolUsage) === json([{ name: 'web_lookup', count: 1 }]), 'only its own usage');
            expect(bench.entryOf(reply) === undefined && bench.markOf(reply) === undefined, 'the checkpoint is gone');
            expect(!finalButtonsOf(telegram).includes('继续'), `no 继续 (got ${json(finalButtonsOf(telegram))})`);
        }),
    },
    {
        name: 'case 12: a resume that fails or is stopped before a new checkpoint keeps the old one on the new version; after one, the new one',
        body: quietCase(async () => {
            const reply = await failedAfterRound1({ label: 'r1', calls: [webLookup('a')] });
            const original = bench.entryOf(reply);

            // Fails at its first round: nothing new was handed over
            vertex.reset([failingRound()]);
            telegram.reset();
            await bench.continueReply(reply);
            const again = bench.entryOf(reply);
            expect(
                again?.failedVersionId === 2 && again.loop.state === original?.loop.state && again.loop.completedRounds === 1,
                `the same checkpoint is kept on version 2 (got ${json({ version: again?.failedVersionId, rounds: again?.loop.completedRounds })})`
            );
            expect(bench.markOf(reply)?.versionId === 2, 'the mark moved to version 2');
            expect(json(finalButtonsOf(telegram)) === json(['<', '继续', '重试']), `[<] [继续] [重试] (got ${json(finalButtonsOf(telegram))})`);

            // A new round runs, then the next one fails: the new checkpoint is kept
            vertex.reset([roundOf({ label: 'r2', calls: [webLookup('b')] }), failingRound()]);
            telegram.reset();
            await bench.continueReply(reply);
            const newer = bench.entryOf(reply);
            expect(
                newer?.failedVersionId === 3 && newer.loop.completedRounds === 2,
                `version 3 keeps two rounds (got ${json({ version: newer?.failedVersionId, rounds: newer?.loop.completedRounds })})`
            );

            // Stopped before a new checkpoint: version 3's is kept again, on version 4
            const asked = bench.continueReply(reply);
            vertex.reset([stalledRound('第三轮', '说到一半')]);
            await waitUntil('round 3 to stream', () => vertex.requests.length === 1);
            await stopReply(reply);
            await asked;
            const stopped = bench.entryOf(reply);
            expect(
                stopped?.failedVersionId === 4 && stopped.loop.state === newer?.loop.state,
                `version 4 keeps version 3's checkpoint (got ${json({ version: stopped?.failedVersionId })})`
            );
            expect((await bench.latestVersion(reply)).wasStoppedByUser, 'version 4 is the stopped one');

            vertex.reset([answer('终于说完了。')]);
            telegram.reset();
            await bench.continueReply(reply);
            const finished = await bench.latestVersion(reply);
            expect(finished.versionId === 5 && finished.text.includes('终于说完了。'), 'and it can still be continued to the end');
            expect(bench.entryOf(reply) === undefined && bench.markOf(reply) === undefined, 'nothing kept after that');
        }),
    },
    {
        name: 'case 14: the resumed row counts only its own rounds, tokens and tool calls; replayed text and thinking count; the first chunk is a new one',
        body: quietCase(async () => {
            const reply = await failedAfterRound1({
                label: 'r1',
                thinking: ['第一轮想了很久很久'],
                text: ['第一轮的话。'],
                calls: [webLookup('a'), webLookup('b')],
            });
            const [failedRow] = await bench.rowsOf(reply);
            expect(
                failedRow?.outcome === 'error' && failedRow.toolCalls === 2 && failedRow.checkpointRounds === 1 && failedRow.rounds === 1,
                `the failed row carries its tool usage (got ${json({ outcome: failedRow?.outcome, toolCalls: failedRow?.toolCalls, checkpointRounds: failedRow?.checkpointRounds })})`
            );

            vertex.reset([roundOf({ label: 'r2', thinking: ['第二轮'], calls: [webLookup('c')] }), answer('都查完了。')]);
            telegram.reset();
            await bench.continueReply(reply);
            const rows = await bench.rowsOf(reply);
            const resumed = rows[1];
            const version = await bench.latestVersion(reply);
            expect(resumed?.outcome === 'ok' && resumed.resumedRounds === 1 && resumed.checkpointRounds === null, `resumedRounds (got ${json(resumed?.resumedRounds)})`);
            // Every scripted round reports the same usage: two new rounds are twice the failed row's one
            expect(
                resumed?.rounds === 2 &&
                    resumed.promptTokens === 2 * (failedRow?.promptTokens ?? -1) &&
                    resumed.outputTokens === 2 * (failedRow?.outputTokens ?? -1),
                `only the new rounds' usage (got ${json({ rounds: resumed?.rounds, prompt: resumed?.promptTokens, output: resumed?.outputTokens })})`
            );
            expect(
                resumed?.toolCalls === 1 && json(resumed.toolUsage) === json([{ name: 'web_lookup', count: 1, failed: 0 }]),
                `only the new tool call (got ${json(resumed?.toolUsage)})`
            );
            expect(json(version.agentStats?.toolUsage) === json([{ name: 'web_lookup', count: 3 }]), 'while the version shows all three');
            expect(resumed?.textChars === version.text.length && version.text.includes('第一轮的话。'), `textChars is the whole version (got ${json(resumed?.textChars)})`);
            const allThinking = '第一轮想了很久很久'.length + '第二轮'.length + 'thinking before 都查完了。'.length;
            expect(resumed?.thinkingChars === allThinking, `thinkingChars include the replay (got ${json(resumed?.thinkingChars)}, expected ${allThinking})`);
            expect((resumed?.contextMessages ?? 0) > 0, `the context size is recorded (got ${json(resumed?.contextMessages)})`);
            const requestSentAt = vertex.requests[0]?.sentAt ?? Infinity;
            expect(
                resumed?.firstChunkAt !== null && resumed?.firstChunkAt !== undefined && resumed.firstChunkAt.getTime() >= requestSentAt,
                'the first chunk is the first new one, after the request went out'
            );
            expect(resumed?.requestStartedAt !== null, 'the request start is marked');

            // A resume that fails after a new call: its row counts that call only
            const second = await failedAfterRound1({ label: 's1', calls: [webLookup('x'), webLookup('y')] });
            vertex.reset([roundOf({ label: 's2', calls: [webLookup('z')] }), failingRound()]);
            telegram.reset();
            await bench.continueReply(second);
            const failedAgain = (await bench.rowsOf(second))[1];
            expect(
                failedAgain?.outcome === 'error' && failedAgain.toolCalls === 1 && failedAgain.resumedRounds === 1 && failedAgain.checkpointRounds === 2,
                `a resumed row that fails counts its own call (got ${json({ outcome: failedAgain?.outcome, toolCalls: failedAgain?.toolCalls, resumed: failedAgain?.resumedRounds, kept: failedAgain?.checkpointRounds })})`
            );
            const failedVersion = await bench.latestVersion(second);
            expect(json(failedVersion.agentStats?.toolUsage) === json([{ name: 'web_lookup', count: 3 }]), 'and its version shows all three');
        }),
    },
    {
        name: 'case 16: a stop during the replay waits for its end: the version holds the whole replay and its file; nothing new is asked',
        body: quietCase(async (log) => {
            process.env.THINKING_LINK = '0';
            try {
                const reply = await failedAfterRound1({
                    label: 'r1',
                    thinking: ['第一轮想了想'],
                    text: longText('第一轮'),
                    calls: [{ name: 'send_file', args: { file_name: 'notes.md', content: '# 笔记' } }],
                });
                const failed = await bench.latestVersion(reply);
                const held = gate();
                const caught = gate();
                bench.hooks.push({
                    method: 'sendMessage',
                    when: (payload) => payload.text === 'continued',
                    onCaught: () => caught.open(),
                    holdUntil: held.opened,
                });
                vertex.reset([answer('不该被问到。')]);
                telegram.reset();
                const clicked = bench.press(reply, 'resp:continue');
                await caught.opened;
                // The replay is held at its first continuation message: stop now
                await stopReply(reply);
                expect(bench.toasts().includes('停止中...'), `the stop is taken (got ${json(bench.toasts())})`);
                await waitUntil(
                    'the stop to reach the resumed session',
                    () => getActiveSession(reply.chatId, reply.firstMessageId)?.streamController.isAborted() === true
                );
                held.open();
                await clicked;
                await bench.settled(reply);

                expect(vertex.requests.length === 0, `no new round was asked for (got ${vertex.requests.length})`);
                const version = await bench.latestVersion(reply);
                expect(version.wasStoppedByUser, 'the resumed version is stopped');
                expect(version.text === failed.text, `it holds the whole replayed text (got ${version.text.length} of ${failed.text.length})`);
                expect(telegram.callsOf('sendDocument').length === 1 && version.file?.name === 'notes.md', 'and the replayed file goes out once');
                expect(json(finalButtonsOf(telegram)) === json(['<', '继续', '重试']), `[<] [继续] [重试] (got ${json(finalButtonsOf(telegram))})`);
                expect(bench.entryOf(reply)?.failedVersionId === 2, 'the checkpoint is kept on the stopped version');
                expect(json(version.agentStats?.toolUsage) === json([{ name: 'send_file', count: 1 }]), `the stopped version shows the kept tools (got ${json(version.agentStats)})`);
                const stoppedRow = (await bench.rowsOf(reply))[1];
                expect(
                    stoppedRow?.outcome === 'stopped' && stoppedRow.toolCalls === 0 && stoppedRow.resumedRounds === 1 && stoppedRow.checkpointRounds === 1,
                    `the stopped row counts no call of its own (got ${json({ outcome: stoppedRow?.outcome, toolCalls: stoppedRow?.toolCalls })})`
                );
                expect(log.has('[resume] replay chunks='), 'the replay is logged');
            } finally {
                delete process.env.THINKING_LINK;
            }
        }),
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
endOpenReplies();
await bench.close();
reportResults(results);
