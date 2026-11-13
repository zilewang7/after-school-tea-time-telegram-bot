/**
 * Offline cases for the "继续" click itself (design 2026-1112-1123 §6.4,
 * §7.3; test plan §11 第 3 期 cases 10, 13 and 18, and the access tiers, with
 * whom Priority PayGo is asked for):
 * the order of the checks and what each failed check leaves behind, the
 * claim the click shares with 重试, the ways out that must give the
 * checkpoint and the claim back, and the log line of a missing checkpoint.
 * Same bench as reply-resume.mts: real handlers, the real Gemini platform on
 * the fake Vertex endpoint, the scratch database.
 *
 * Run: npx tsx scripts/offline/reply-resume-click.mts
 */
import { expect, reportResults, runCase, takeMessageId, type CaseResult } from './harness.mts';
import { endOpenReplies, waitUntil } from './fake-telegram.mts';
import { answer, withFakeClock } from './support/gemini-loop-fixtures.mts';
import {
    createResumeBench,
    failingRound,
    finalButtonsOf,
    gate,
    json,
    OWNER_USER_ID,
    quietCase,
    roundOf,
    stalledRound,
    takeChatId,
    TRIAL_USER_ID,
    visibleEditsOf,
    webLookup,
    type AskedReply,
} from './support/resume-bench.mts';

const bench = await createResumeBench();
const { telegram, vertex, registry } = bench;
const { updateChatSettings } = await import('../../src/services/chat-settings-service.js');
const { excludeMessage, includeMessage } = await import('../../src/db/queries/context-exclusions.js');
const { PAUSED_CALLBACK_NOTICE } = await import('../../src/reply/chat-pause.js');
const checks = await import('../../src/reply/resume/continue-checks.js');
const { capabilitySeedOf } = await import('../../src/config/model-capability-seed.js');
const { seedModelCatalogEntries, setModelCatalog } = await import('../../src/config/model-catalog.js');
const { captureResumeFacts } = await import('../../src/reply/resume/resume-facts.js');
const { createReplyToolState } = await import('../../src/reply/tools/reply-tool-state.js');
const { CHECKPOINT_REGISTRY_LIMITS } = await import('../../src/reply/resume/checkpoint-registry.js');
const { Message } = await import('../../src/db/messageDTO.js');
const { setAccessMembershipLookup } = await import('../../src/services/access-membership.js');
const { TRIAL_MODEL } = await import('../../src/config/trial-access.js');

const OWNER = { userId: OWNER_USER_ID, isOwner: true };
/** An access group that is none of the bench's chats */
const ROSTER_GROUP_ID = -1007699999999;
const CLAIMED_NOTICE = '正在处理';
/** The Priority PayGo request header, as fetch saw it (lower-cased) */
const PRIORITY_HEADER = 'x-vertex-ai-llm-shared-request-type';
const BUSY_NOTICE = '正在处理，请稍后再点';

const kept = (reply: AskedReply): boolean => bench.entryOf(reply) !== undefined && bench.markOf(reply) !== undefined;

/** A click that must only answer: the notice, nothing on screen, the checkpoint and the claim as they were */
const expectNoticeOnly = async (reply: AskedReply, notice: string, label: string, userId?: number): Promise<void> => {
    const entryBefore = bench.entryOf(reply);
    telegram.reset();
    const thrown = await bench.press(reply, 'resp:continue', userId);
    expect(thrown === null, `${label}: the click is handled (got ${String(thrown)})`);
    expect(json(bench.toasts()) === json([notice]), `${label}: only the notice (got ${json(bench.toasts())})`);
    expect(visibleEditsOf(telegram).length === 0, `${label}: the buttons stay (got ${json(visibleEditsOf(telegram))})`);
    expect(bench.entryOf(reply) === entryBefore && kept(reply), `${label}: the checkpoint and its mark stay`);
    expect(!bench.state.isReplyRerunClaimed(reply.chatId, reply.firstMessageId), `${label}: the claim is free`);
};

/** The click goes through once the condition is back: the resumed version ends normally */
const expectContinues = async (reply: AskedReply, label: string, userId?: number): Promise<void> => {
    vertex.reset([answer(`${label} 之后接着说完。`)]);
    telegram.reset();
    const thrown = await bench.continueReply(reply, userId);
    expect(thrown === null && bench.toasts().includes('继续中...'), `${label}: then it continues (got ${json(bench.toasts())})`);
    const version = await bench.latestVersion(reply);
    expect(version.text.includes(`${label} 之后接着说完。`) && version.errorMessage === undefined, `${label}: and ends normally`);
    expect(!kept(reply), `${label}: nothing is kept after it`);
};

/** A click that finds the checkpoint gone: dropped, the notice, the buttons redrawn without 继续 */
const expectGone = async (reply: AskedReply, label: string): Promise<void> => {
    telegram.reset();
    await bench.press(reply, 'resp:continue');
    expect(json(bench.toasts()) === json([checks.CHECKPOINT_GONE_NOTICE]), `${label}: the gone notice (got ${json(bench.toasts())})`);
    const redraw = telegram.callsOf('editMessageReplyMarkup');
    expect(redraw.length === 1 && !json(redraw[0]?.payload.reply_markup).includes('继续'), `${label}: the buttons lose 继续 (got ${json(finalButtonsOf(telegram))})`);
    expect(registry.peek(reply.chatId, reply.firstMessageId) === undefined && bench.markOf(reply) === undefined, `${label}: dropped`);
    expect(!bench.state.isReplyRerunClaimed(reply.chatId, reply.firstMessageId), `${label}: the claim is free`);
};

const failedReply = (chatId?: number): Promise<AskedReply> =>
    bench.failedAfterRound1({ label: 'r1', thinking: ['先查一下'], calls: [webLookup('k-on')] }, chatId === undefined ? {} : { chatId });

/** A synthetic entry of another reply, only there to fill the registry */
const saveFiller = (index: number): void => {
    const facts = captureResumeFacts({
        model: 'gemini-4-carbon',
        systemPrompt: 'filler',
        tools: { definitions: [], execute: async () => ({ content: '', isError: false, images: [], record: null }), statusOf: () => ({ text: '', chatAction: 'typing' }) },
        toolState: createReplyToolState({ chatId: -1009900000000 - index, conversationRootIds: [] }),
        contextIndex: new Map(),
        conversationRootIds: [],
        promptAddendum: null,
        builtAt: Date.now(),
    });
    const prepared = registry.prepare({
        ...facts,
        chatId: -1009900000000 - index,
        firstMessageId: 1,
        userMessageId: 1,
        loop: { platform: 'gemini', completedRounds: 1, toolUsage: [], journal: [], state: {} },
        failedVersionId: 1,
        savedAt: Date.now(),
    });
    if (prepared === null) throw new Error('a filler was not kept');
    registry.save(prepared);
};

const cases: Array<{ name: string; body: () => Promise<void> }> = [
    {
        name: 'case 10 (1): an expired checkpoint is gone: dropped, the notice, the buttons lose 继续',
        body: quietCase(async (log) => {
            const reply = await failedReply();
            await withFakeClock(async (jump) => {
                jump(CHECKPOINT_REGISTRY_LIMITS.ttlMs + 60_000);
                await expectGone(reply, 'expired');
            });
            expect(log.has('[resume] checkpoint missing reason=expired'), 'the log names the reason');

            // The answer comes too late for Telegram: the dropped checkpoint still leaves the buttons
            const late = await failedReply();
            await withFakeClock(async (jump) => {
                jump(CHECKPOINT_REGISTRY_LIMITS.ttlMs + 60_000);
                bench.hooks.push({
                    method: 'answerCallbackQuery',
                    when: (payload) => payload.text === checks.CHECKPOINT_GONE_NOTICE,
                    fail: true,
                });
                telegram.reset();
                await bench.press(late, 'resp:continue');
                const redrawn = json(telegram.callsOf('editMessageReplyMarkup').at(-1)?.payload.reply_markup);
                expect(redrawn.includes('重试') && !redrawn.includes('继续'), `a failed answer: the buttons still lose 继续 (got ${redrawn})`);
                expect(!bench.state.isReplyRerunClaimed(late.chatId, late.firstMessageId), 'a failed answer: the claim is free');
            });
        }),
    },
    {
        name: 'case 10 (1b): a checkpoint that expires between the checks and the take is gone too: logged, the buttons lose 继续, the claim is free',
        body: quietCase(async (log) => {
            const reply = await failedReply();
            await withFakeClock(async (jump) => {
                // The checks pass; while the click is answered the entry runs out
                bench.hooks.push({
                    method: 'answerCallbackQuery',
                    when: (payload) => payload.text === '继续中...',
                    onCaught: () => jump(CHECKPOINT_REGISTRY_LIMITS.ttlMs + 1000),
                });
                vertex.reset([]);
                telegram.reset();
                const thrown = await bench.press(reply, 'resp:continue');
                await bench.settled(reply, 'the click to give its claim back');
                expect(thrown === null, `the click is handled (got ${String(thrown)})`);
                expect(json(bench.toasts()) === json(['继续中...']), `the one toast it had sent (got ${json(bench.toasts())})`);
                expect(vertex.requests.length === 0 && telegram.callsOf('editMessageText').length === 0, 'nothing is resumed');
                const redraw = telegram.callsOf('editMessageReplyMarkup');
                const redrawn = json(redraw.at(-1)?.payload.reply_markup);
                expect(
                    redraw.length === 1 && redrawn.includes('重试') && !redrawn.includes('继续'),
                    `the buttons lose 继续 (got ${json(finalButtonsOf(telegram))})`
                );
                expect(registry.peek(reply.chatId, reply.firstMessageId) === undefined && bench.markOf(reply) === undefined, 'dropped');
            });
            expect(log.has(`[resume] checkpoint missing reason=expired chat=${reply.chatId}`), 'the log names the reason');
        }),
    },
    {
        name: 'case 10 (2): a failed version that is no longer the latest one is gone',
        body: quietCase(async (log) => {
            const reply = await failedReply();
            const stored = await bench.stored(reply);
            const latest = stored.getVersions().at(-1);
            if (latest === undefined) throw new Error('no version');
            // A version that came by another way than a finalization, which would have cleared the mark
            stored.addVersion({ ...latest, versionId: latest.versionId + 1, createdAt: new Date().toISOString() });
            await stored.save();
            await expectGone(reply, 'superseded');
            expect(log.has('[resume] checkpoint dropped: a newer version exists'), 'and says why');
        }),
    },
    {
        name: 'case 10 (3): an older version on screen only gets a notice; back on the failed version it continues',
        body: quietCase(async () => {
            // Version 1 answers, the retry fails with a checkpoint as version 2
            const chatId = takeChatId();
            vertex.reset([answer('第一版。')]);
            const reply = await bench.ask(chatId, '@AfterSchoolTeatimeBot 说点什么');
            vertex.reset([roundOf({ label: 'r1', calls: [webLookup('a')] }), failingRound()]);
            await bench.retryReply(reply);
            expect(bench.entryOf(reply)?.failedVersionId === 2, 'version 2 is kept');
            // A switch holds the reply's claim from the click until it has stored the version on screen
            await bench.press(reply, 'resp:prev');
            await bench.settled(reply, 'the switch to version 1');
            expect((await bench.stored(reply)).currentVersionIndex === 0, 'version 1 is on screen');
            await expectNoticeOnly(reply, checks.SWITCH_TO_LATEST_NOTICE, 'older version');
            await bench.press(reply, 'resp:next');
            await bench.settled(reply, 'the switch back to version 2');
            expect((await bench.stored(reply)).currentVersionIndex === 1, 'version 2 is on screen again');
            await expectContinues(reply, 'latest version');
        }),
    },
    {
        name: 'case 10 (4)-(8): paused, another model, other tools, another addendum, an excluded message: notice only, then it continues',
        body: quietCase(async () => {
            const conditions: Array<{ label: string; notice: string; apply: (reply: AskedReply) => Promise<unknown>; restore: (reply: AskedReply) => Promise<unknown> }> = [
                {
                    label: 'paused',
                    notice: PAUSED_CALLBACK_NOTICE,
                    apply: (reply) => updateChatSettings({ chatId: reply.chatId, patch: { paused: true }, actor: OWNER }),
                    restore: (reply) => updateChatSettings({ chatId: reply.chatId, patch: { paused: false }, actor: OWNER }),
                },
                {
                    label: 'model',
                    notice: checks.MODEL_CHANGED_NOTICE,
                    apply: (reply) => updateChatSettings({ chatId: reply.chatId, patch: { model: 'gemini-3.8-flash' }, actor: OWNER }),
                    restore: (reply) => updateChatSettings({ chatId: reply.chatId, patch: { model: null }, actor: OWNER }),
                },
                {
                    label: 'tools',
                    notice: checks.TOOLS_CHANGED_NOTICE,
                    apply: (reply) => updateChatSettings({ chatId: reply.chatId, patch: { toolOverrides: { file: false } }, actor: OWNER }),
                    restore: (reply) => updateChatSettings({ chatId: reply.chatId, patch: { toolOverrides: null }, actor: OWNER }),
                },
                {
                    label: 'addendum',
                    notice: checks.ADDENDUM_CHANGED_NOTICE,
                    apply: (reply) => updateChatSettings({ chatId: reply.chatId, patch: { promptAddendum: '多用表情' }, actor: OWNER }),
                    restore: (reply) => updateChatSettings({ chatId: reply.chatId, patch: { promptAddendum: null }, actor: OWNER }),
                },
                {
                    label: 'excluded',
                    notice: checks.CONTEXT_EXCLUDED_NOTICE,
                    apply: (reply) => excludeMessage({ chatId: reply.chatId, messageId: reply.userMessageId, actorId: OWNER_USER_ID }),
                    restore: (reply) => includeMessage({ chatId: reply.chatId, messageId: reply.userMessageId, actorId: OWNER_USER_ID }),
                },
            ];
            for (const condition of conditions) {
                const reply = await failedReply();
                await condition.apply(reply);
                await expectNoticeOnly(reply, condition.notice, condition.label);
                await condition.restore(reply);
                await expectContinues(reply, condition.label);
            }
        }),
    },
    {
        name: 'case 10 (9): a thinking level changed after the interrupt refuses the continue until restored',
        body: quietCase(async () => {
            const chatId = takeChatId();
            // The interrupted version asked the model for a high level
            await updateChatSettings({ chatId, patch: { thinkingEffort: 'high' }, actor: OWNER });
            const reply = await failedReply(chatId);
            // A different level since the interrupt: the click only answers
            await updateChatSettings({ chatId, patch: { thinkingEffort: 'low' }, actor: OWNER });
            await expectNoticeOnly(reply, checks.THINKING_EFFORT_CHANGED_NOTICE, 'thinking');
            // Restored: the click resumes the interrupted request
            await updateChatSettings({ chatId, patch: { thinkingEffort: 'high' }, actor: OWNER });
            await expectContinues(reply, 'thinking');
            const row = (await bench.rowsOf(reply)).at(-1);
            expect(
                row?.thinkingEffortRequested === 'high' && row.thinkingEffortSent === 'high',
                `the resumed attempt records the level it asked for (got ${json({
                    requested: row?.thinkingEffortRequested,
                    sent: row?.thinkingEffortSent,
                })})`
            );
            await updateChatSettings({ chatId, patch: { thinkingEffort: null }, actor: OWNER });
        }),
    },
    {
        name: 'case 10 (10): model data that resolves the same setting differently asks for a retry, then the restored data continues',
        body: quietCase(async () => {
            const chatId = takeChatId();
            const carbon = capabilitySeedOf('gemini-4-carbon');
            const reasoning = carbon?.reasoning;
            if (carbon === null || reasoning === undefined) throw new Error('no carbon reasoning seed');
            // The interrupted version asked for high while the model accepted it
            await updateChatSettings({ chatId, patch: { thinkingEffort: 'high' }, actor: OWNER });
            const reply = await failedReply(chatId);
            // Same setting, but the catalog data now clamps high to medium: there
            // is nothing to change back, only a retry can start a new version
            setModelCatalog(
                seedModelCatalogEntries().map((entry) =>
                    entry.id === 'gemini-4-carbon'
                        ? {
                              ...entry,
                              capabilities: {
                                  ...entry.capabilities,
                                  reasoning: { ...reasoning, efforts: ['low', 'medium'] },
                              },
                          }
                        : entry
                )
            );
            await expectNoticeOnly(reply, checks.THINKING_EFFORT_DATA_CHANGED_NOTICE, 'thinking data');
            // Restored: the click resumes the interrupted request
            setModelCatalog(seedModelCatalogEntries());
            await expectContinues(reply, 'thinking data');
            const row = (await bench.rowsOf(reply)).at(-1);
            expect(
                row?.thinkingEffortRequested === 'high' && row.thinkingEffortSent === 'high',
                `the resumed attempt records the level it asked for (got ${json({
                    requested: row?.thinkingEffortRequested,
                    sent: row?.thinkingEffortSent,
                })})`
            );
            await updateChatSettings({ chatId, patch: { thinkingEffort: null }, actor: OWNER });
        }),
    },
    {
        name: 'case 10 (D11): edits of a context message and of the trigger block nothing and change nothing in the request',
        body: quietCase(async () => {
            const chatId = takeChatId();
            const earlierId = takeMessageId();
            await bench.dbIndex.saveMessage({
                chatId,
                messageId: earlierId,
                userId: 5150,
                date: new Date(Date.now() - 60_000),
                userName: 'user-5150',
                message: '前一条消息，原文',
            });
            const reply = await bench.failedAfterRound1(
                { label: 'r1', calls: [webLookup('a')] },
                { chatId, question: '@AfterSchoolTeatimeBot 接着上一条说', replyToId: earlierId }
            );
            const failedRequest = vertex.requests[1];
            expect(bench.entryOf(reply)?.context.contextMessageIds.includes(earlierId) === true, 'the earlier message is in the context');

            for (const [messageId, text] of [[earlierId, '前一条消息，改过了'], [reply.userMessageId, '@AfterSchoolTeatimeBot 改过的问题']] as const) {
                telegram.reset();
                await bench.bot.handleUpdate({
                    update_id: 800_000 + messageId,
                    edited_message: {
                        message_id: messageId,
                        date: Math.floor(Date.now() / 1000) - 10,
                        edit_date: Math.floor(Date.now() / 1000),
                        chat: { id: chatId, type: 'supergroup', title: '测试群' },
                        from: { id: 5150, is_bot: false, first_name: 'u' },
                        text,
                    },
                });
            }
            // Both rows now hold the edited texts; a failed reply keeps its buttons
            for (const [messageId, text] of [[earlierId, '前一条消息，改过了'], [reply.userMessageId, '@AfterSchoolTeatimeBot 改过的问题']] as const) {
                const deadline = Date.now() + 5000;
                while ((await bench.dbIndex.getMessage(chatId, messageId))?.text !== text) {
                    if (Date.now() > deadline) throw new Error(`the edit of ${messageId} was not stored`);
                    await new Promise((resolve) => setTimeout(resolve, 20));
                }
            }
            expect(kept(reply), 'the edits leave the checkpoint and its mark alone');

            vertex.reset([answer('照原样接着说。')]);
            telegram.reset();
            await bench.continueReply(reply);
            expect(bench.toasts().includes('继续中...'), `the edits do not block (got ${json(bench.toasts())})`);
            expect(vertex.requests[0]?.rawBody === failedRequest?.rawBody, 'the resumed request is the failed one, byte for byte');
            expect(!(vertex.requests[0]?.rawBody.includes('改过') ?? true), 'the edited texts are not in it');
        }),
    },
    {
        name: 'case 13: two fast clicks start one resume; the loser only hears 正在处理',
        body: quietCase(async (log) => {
            const reply = await failedReply();
            vertex.reset([answer('只续了一次。')]);
            telegram.reset();
            const continuingBefore = log.matching('[resume] continuing').length;
            const thrown = await Promise.all([bench.press(reply, 'resp:continue'), bench.press(reply, 'resp:continue')]);
            await bench.settled(reply);
            expect(thrown.every((error) => error === null), `both are handled (got ${json(thrown.map(String))})`);
            expect(
                json([...bench.toasts()].sort()) === json(['继续中...', CLAIMED_NOTICE].sort()),
                `one continues, one hears it is being handled (got ${json(bench.toasts())})`
            );
            expect(log.matching('[resume] continuing').length === continuingBefore + 1, 'one resume ran');
            expect(vertex.requests.length === 1, `one request (got ${vertex.requests.length})`);
            expect((await bench.stored(reply)).getVersions().length === 2, 'one new version');
        }),
    },
    {
        name: 'case 13: while the resume is starting, 停止, 上一版 and 重试 only answer',
        body: quietCase(async () => {
            const reply = await failedReply();
            const held = gate();
            const caught = gate();
            bench.hooks.push({
                method: 'answerCallbackQuery',
                when: (payload) => payload.text === '继续中...',
                onCaught: () => caught.open(),
                holdUntil: held.opened,
            });
            vertex.reset([answer('启动之后说完。')]);
            telegram.reset();
            const clicked = bench.press(reply, 'resp:continue');
            await caught.opened;
            for (const [data, notice] of [
                ['resp:stop', BUSY_NOTICE],
                ['resp:prev', BUSY_NOTICE],
                ['resp:retry', CLAIMED_NOTICE],
                ['resp:continue', CLAIMED_NOTICE],
            ] as const) {
                telegram.reset();
                await bench.press(reply, data);
                await new Promise((resolve) => setTimeout(resolve, 50));
                expect(
                    json(bench.toasts()) === json([notice]) && visibleEditsOf(telegram).length === 0,
                    `${data} answers ${notice} and changes nothing (got ${json({ toasts: bench.toasts(), edits: visibleEditsOf(telegram) })})`
                );
            }
            expect(kept(reply), 'the checkpoint is not taken before the answer');
            held.open();
            await clicked;
            await bench.settled(reply);
            const version = await bench.latestVersion(reply);
            expect(version.text.includes('启动之后说完。') && !kept(reply), 'then the resume runs as usual');
        }),
    },
    {
        name: 'case 13: a reply still generating refuses 继续 and puts the stop button back',
        body: quietCase(async () => {
            const chatId = takeChatId();
            vertex.reset([stalledRound('还在想', '说到一半')]);
            telegram.reset();
            const asked = bench.askInBackground(chatId, '@AfterSchoolTeatimeBot 慢慢说');
            await waitUntil('the stream', () => vertex.requests.length === 1);
            const running = await bench.runningReplyOf(chatId);
            telegram.reset();
            await bench.press(running, 'resp:continue');
            expect(json(bench.toasts()) === json(['还在生成中']), `refused (got ${json(bench.toasts())})`);
            expect(json(finalButtonsOf(telegram)) === json(['停止']), `the stop button is put back (got ${json(finalButtonsOf(telegram))})`);
            expect(!bench.state.isReplyRerunClaimed(chatId, running.firstMessageId), 'the claim is free');
            await bench.stopReply(running);
            await asked.done;
        }),
    },
    {
        name: 'case 13: a failed answer, startRetry returning null and an unreadable trigger all leave the checkpoint and free the claim',
        body: quietCase(async (log) => {
            const reply = await failedReply();

            // The answer fails: nothing was taken yet
            bench.hooks.push({ method: 'answerCallbackQuery', when: (payload) => payload.text === '继续中...', fail: true });
            telegram.reset();
            const thrown = await bench.press(reply, 'resp:continue');
            // The click works off the update loop: its failure is logged there
            expect(thrown === null && log.has('[response-menu] Continue failed'), `the failed answer is logged (got ${String(thrown)})`);
            expect(bench.entryOf(reply)?.failedVersionId === 1 && bench.markOf(reply)?.versionId === 1, 'answer failed: the checkpoint stays');
            expect(!bench.state.isReplyRerunClaimed(reply.chatId, reply.firstMessageId), 'answer failed: the claim is free');

            // The reply's record vanishes between the answer and startRetry: it returns null
            const stored = await bench.stored(reply);
            const record = stored.get({ plain: true });
            bench.hooks.push({
                method: 'answerCallbackQuery',
                when: (payload) => payload.text === '继续中...',
                onCaught: async () => {
                    await stored.destroy();
                },
            });
            vertex.reset([]);
            telegram.reset();
            await bench.continueReply(reply);
            expect(vertex.requests.length === 0, 'startRetry returned null: nothing was sent');
            expect(bench.entryOf(reply)?.failedVersionId === 1 && bench.markOf(reply)?.versionId === 1, 'null start: the checkpoint is put back');
            expect(!bench.state.isReplyRerunClaimed(reply.chatId, reply.firstMessageId), 'null start: the claim is free');
            await bench.dbIndex.BotResponse.create(record);

            // The trigger cannot be read after startRetry: the new version fails and keeps the same checkpoint
            const original = bench.entryOf(reply);
            await Message.destroy({ where: { chatId: reply.chatId, messageId: reply.userMessageId } });
            telegram.reset();
            await bench.continueReply(reply);
            const failed = await bench.latestVersion(reply);
            expect(failed.versionId === 2 && failed.errorMessage !== undefined, `version 2 failed (got ${json({ id: failed.versionId, error: failed.errorMessage })})`);
            const again = bench.entryOf(reply);
            expect(
                again?.failedVersionId === 2 && again.loop.state === original?.loop.state && bench.markOf(reply)?.versionId === 2,
                'unreadable trigger: the same checkpoint is kept on version 2'
            );
            expect(json(finalButtonsOf(telegram)) === json(['<', '继续', '重试']), `with [<] [继续] [重试] (got ${json(finalButtonsOf(telegram))})`);
            expect(!bench.state.isReplyRerunClaimed(reply.chatId, reply.firstMessageId), 'unreadable trigger: the claim is free');
            const [, failedRow] = await bench.rowsOf(reply);
            expect(
                failedRow?.outcome === 'error' && failedRow.resumedRounds === 1 && failedRow.toolCalls === 0 && failedRow.checkpointRounds === 1,
                `its row counts no call of its own (got ${json({ outcome: failedRow?.outcome, toolCalls: failedRow?.toolCalls })})`
            );

            // With the trigger back, it continues
            await bench.dbIndex.saveMessage({
                chatId: reply.chatId,
                messageId: reply.userMessageId,
                userId: 5150,
                date: new Date(),
                userName: 'user-5150',
                message: '@AfterSchoolTeatimeBot 查一下',
            });
            await expectContinues(reply, 'trigger back');
        }),
    },
    {
        name: 'case 13: a version switch holds the claim: 继续 and 重试 pressed meanwhile only hear 正在处理, and the switch erases nothing',
        body: quietCase(async () => {
            // Version 1 answers; the retry fails with a checkpoint as version 2
            const chatId = takeChatId();
            vertex.reset([answer('第一版。')]);
            const reply = await bench.ask(chatId, '@AfterSchoolTeatimeBot 说点什么');
            vertex.reset([roundOf({ label: 'r1', calls: [webLookup('a')] }), failingRound()]);
            await bench.retryReply(reply);
            expect(bench.entryOf(reply)?.failedVersionId === 2, 'version 2 is kept');

            // The switch back to version 1 hangs on its first edit
            const held = gate();
            const caught = gate();
            bench.hooks.push({ method: 'editMessageText', when: () => true, onCaught: () => caught.open(), holdUntil: held.opened });
            telegram.reset();
            await bench.press(reply, 'resp:prev');
            await caught.opened;
            expect(bench.state.isReplyRerunClaimed(reply.chatId, reply.firstMessageId), 'the switch holds the claim');
            for (const [data, notice] of [
                ['resp:continue', CLAIMED_NOTICE],
                ['resp:retry', CLAIMED_NOTICE],
                ['resp:next', BUSY_NOTICE],
                ['resp:stop', BUSY_NOTICE],
            ] as const) {
                telegram.reset();
                await bench.press(reply, data);
                expect(json(bench.toasts()) === json([notice]), `${data} during the switch answers ${notice} (got ${json(bench.toasts())})`);
            }
            expect(vertex.requests.length === 2 && kept(reply), 'nothing was resumed or retried, the checkpoint stays');

            held.open();
            await bench.settled(reply, 'the switch to end');
            const afterSwitch = await bench.stored(reply);
            expect(
                afterSwitch.getVersions().length === 2 && afterSwitch.currentVersionIndex === 0,
                `the switch saved both versions, version 1 on screen (got ${afterSwitch.getVersions().length} at ${afterSwitch.currentVersionIndex})`
            );

            // Back on the failed version it continues as usual
            await bench.press(reply, 'resp:next');
            await bench.settled(reply, 'the switch back to end');
            await expectContinues(reply, 'after the switches');
            expect((await bench.stored(reply)).getVersions().length === 3, 'the resumed version is the third one');
        }),
    },
    {
        name: 'case 13: the checks of a 继续 click run off the update loop: a slow membership lookup holds up nothing else',
        body: quietCase(async () => {
            process.env.ACCESS_TIERS = '1';
            process.env.ACCESS_GROUP_IDS = String(ROSTER_GROUP_ID);
            const asked = gate();
            const answered = gate();
            setAccessMembershipLookup(async () => {
                asked.open();
                await answered.opened;
                return { status: 'left' };
            });
            try {
                const reply = await failedReply();
                const other = await failedReply();
                telegram.reset();
                // Telegram is slow to say whether the presser is a member
                await bench.deliverPress(reply, 'resp:continue', TRIAL_USER_ID);
                await asked.opened;
                expect(bench.toasts().length === 0, 'the update handler returned before the lookup answered');
                expect(bench.state.isReplyRerunClaimed(reply.chatId, reply.firstMessageId), 'the click holds its claim meanwhile');

                // Other updates are handled in the meantime
                await bench.press(reply, 'resp:stop');
                expect(json(bench.toasts()) === json([BUSY_NOTICE]), `a stop on the same reply is answered (got ${json(bench.toasts())})`);
                await expectContinues(other, 'another reply meanwhile');

                telegram.reset();
                answered.open();
                await bench.settled(reply, 'the click to end');
                expect(json(bench.toasts()) === json([checks.MODEL_CHANGED_NOTICE]), `then the click gets its notice (got ${json(bench.toasts())})`);
                expect(kept(reply), 'and the checkpoint stays');
            } finally {
                answered.open();
                process.env.ACCESS_TIERS = '0';
                delete process.env.ACCESS_GROUP_IDS;
                setAccessMembershipLookup(null);
            }
        }),
    },
    {
        name: 'access tiers: outside the access groups a trial presser gets the model notice; in an access group any member continues',
        body: quietCase(async () => {
            process.env.ACCESS_TIERS = '1';
            // The roster is a group none of the bench's chats is, and nobody is its member
            process.env.ACCESS_GROUP_IDS = String(ROSTER_GROUP_ID);
            setAccessMembershipLookup(async () => ({ status: 'left' }));
            try {
                const reply = await failedReply();
                await expectNoticeOnly(reply, checks.MODEL_CHANGED_NOTICE, 'trial presser', TRIAL_USER_ID);
                await expectContinues(reply, 'full presser');

                // The chat itself is an access group: the click proves membership,
                // so a user nobody listed continues another member's reply
                const groupChatId = takeChatId();
                process.env.ACCESS_GROUP_IDS = String(groupChatId);
                const groupReply = await failedReply(groupChatId);
                await expectContinues(groupReply, 'access group member', TRIAL_USER_ID);
            } finally {
                process.env.ACCESS_TIERS = '0';
                delete process.env.ACCESS_GROUP_IDS;
                setAccessMembershipLookup(null);
            }
        }),
    },
    {
        name: 'Priority PayGo with the chat switch on: a full turn asks for it; a trial turn, and a continue or retry a trial user presses, do not',
        body: quietCase(async () => {
            process.env.ACCESS_TIERS = '1';
            process.env.ACCESS_GROUP_IDS = String(ROSTER_GROUP_ID);
            setAccessMembershipLookup(async () => ({ status: 'left' }));
            const chatId = takeChatId();
            await updateChatSettings({ chatId, patch: { geminiPriority: true }, actor: OWNER });
            const headersSent = (): Array<string | null> => vertex.requests.map((request) => request.headers[PRIORITY_HEADER] ?? null);
            const lastRowTier = async (reply: AskedReply): Promise<string | null | undefined> => (await bench.rowsOf(reply)).at(-1)?.tierRequested;
            try {
                vertex.reset([answer('全员的回答。')]);
                const full = await bench.ask(chatId, '@AfterSchoolTeatimeBot 问一下');
                expect(json(headersSent()) === json(['priority']), `a full turn asks for priority (got ${json(headersSent())})`);
                expect((await lastRowTier(full)) === 'priority', `and its row says so (got ${json(await lastRowTier(full))})`);

                // A trial user's question runs on the cheap model; it fails after round 1 so it can be continued
                const trial = await bench.failedAfterRound1(
                    { label: 't1', calls: [{ name: 'send_file', args: { file_name: 'a.md', content: '# A' } }] },
                    { chatId, userId: TRIAL_USER_ID }
                );
                expect(bench.configs.at(-1)?.model === TRIAL_MODEL, `the trial turn runs ${TRIAL_MODEL} (got ${bench.configs.at(-1)?.model})`);
                expect(json(headersSent()) === json([null, null]), `a trial turn asks for nothing (got ${json(headersSent())})`);
                expect((await lastRowTier(trial)) === null, `its row has no tier (got ${json(await lastRowTier(trial))})`);

                vertex.reset([answer('试用用户接着说完。')]);
                telegram.reset();
                await bench.continueReply(trial, TRIAL_USER_ID);
                expect(
                    bench.toasts().includes('继续中...') && (await bench.latestVersion(trial)).text.includes('试用用户接着说完。'),
                    `the trial user continues their own reply (got ${json(bench.toasts())})`
                );
                expect(json(headersSent()) === json([null]), `the continue asks for nothing (got ${json(headersSent())})`);
                expect((await lastRowTier(trial)) === null, 'nor does its row');

                vertex.reset([answer('试用用户重试。')]);
                await bench.retryReply(trial, TRIAL_USER_ID);
                expect(json(headersSent()) === json([null]), `a retry the trial user presses asks for nothing (got ${json(headersSent())})`);
                expect((await lastRowTier(trial)) === null, 'nor does its row');

                vertex.reset([answer('全员重试。')]);
                await bench.retryReply(trial);
                expect(json(headersSent()) === json(['priority']), `the same retry pressed by a full user asks (got ${json(headersSent())})`);
                expect((await lastRowTier(trial)) === 'priority', 'and its row says so');
            } finally {
                process.env.ACCESS_TIERS = '0';
                delete process.env.ACCESS_GROUP_IDS;
                setAccessMembershipLookup(null);
                await updateChatSettings({ chatId, patch: { geminiPriority: null }, actor: OWNER });
            }
        }),
    },
    {
        name: 'case 18: a missing checkpoint logs why: restart, expired, evicted',
        body: quietCase(async (log) => {
            // Restart: a reply whose version is older than this process
            const chatId = takeChatId();
            const firstMessageId = 910_001;
            await bench.dbIndex.BotResponse.create({
                messageId: firstMessageId,
                chatId,
                userMessageId: 910_000,
                currentVersionIndex: 0,
                versions: JSON.stringify([
                    {
                        versionId: 1,
                        createdAt: new Date(performance.timeOrigin - 60_000).toISOString(),
                        messageIds: [firstMessageId],
                        currentMessageId: firstMessageId,
                        text: '重启前的回复',
                        errorMessage: 'got status: 429',
                        wasStoppedByUser: false,
                    },
                ]),
                buttonState: bench.dbIndex.ButtonState.RETRY_ONLY,
                metadata: JSON.stringify({ model: 'gemini-4-carbon', hasImage: false }),
            });
            const restarted: AskedReply = { chatId, userMessageId: 910_000, firstMessageId };
            await expectGone(restarted, 'restart');
            expect(log.has(`[resume] checkpoint missing reason=restart chat=${chatId}`), 'reason=restart');

            // Expired
            const expired = await failedReply();
            await withFakeClock(async (jump) => {
                jump(CHECKPOINT_REGISTRY_LIMITS.ttlMs + 1000);
                await expectGone(expired, 'expired');
            });
            expect(log.has(`[resume] checkpoint missing reason=expired chat=${expired.chatId}`), 'reason=expired');

            // Evicted: newer entries of other replies push it out
            const evicted = await failedReply();
            for (let index = 0; index < CHECKPOINT_REGISTRY_LIMITS.maxEntries; index += 1) saveFiller(index);
            expect(log.has(`[resume] checkpoint evicted chat=${evicted.chatId}`), 'the registry evicted it');
            await expectGone(evicted, 'evicted');
            expect(log.has(`[resume] checkpoint missing reason=evicted chat=${evicted.chatId}`), 'reason=evicted');
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
