/**
 * Offline cases for the Mini App side of the Priority PayGo switch (design
 * §8.5): the chat page's effective value and its "开" chip agree with the
 * server's rules in every combination; the settings forms send only the keys
 * that changed, and the server takes what they compose; the audit list names
 * every key and value the server writes; the statistics texts.
 *
 * Run: npx tsx scripts/offline/webapp-priority.mts
 */
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';
import type { ChatSettings, GlobalSettingsResponse, PriorityHitCounts } from '../../webapp/src/api/types.ts';

// Before src reads the env: the owner, and the one whitelisted chat
process.env.OWNER_USER_ID = '4242';
process.env.TOOL_CHAT_IDS = '-3101';

await setupOfflineDb();
const service = await import('../../src/services/chat-settings-service.js');
const { geminiPriorityViewOf, currentChatSettings } = await import('../../src/panel/views/chat-view.js');
const { listSettingsAudit } = await import('../../src/db/queries/settings-audit.js');
const {
    chatGeminiPriorityOptionsOf,
    effectiveGeminiPriorityOf,
    GEMINI_PRIORITY_APPLIES_HINT,
    GEMINI_PRIORITY_NOT_ALLOWED_HINT,
} = await import('../../webapp/src/gemini-priority.ts');
const { auditKeyLabel, formatAuditValue } = await import('../../webapp/src/format.ts');
const { pricingNoteOf, priorityHitTextOf, strayPriorityTextOf } = await import('../../webapp/src/format-metrics.ts');
const { changedSettingsOf } = await import('../../webapp/src/pages/chat-settings/chat-settings-patch.ts');
const { changedGlobalSettingsOf } = await import('../../webapp/src/pages/home-settings/global-settings-patch.ts');

const OWNER = { userId: 4242, isOwner: true };
const WHITELISTED_CHAT = -3101;
const OTHER_CHAT = -3102;
const CHOICES: readonly (boolean | null)[] = [null, true, false];

const setGlobal = async (on: boolean): Promise<void> => {
    await service.updateGlobalSettings({ defaultGeminiPriority: on }, OWNER);
};

const setChatChoice = async (chatId: number, choice: boolean | null): Promise<void> => {
    await service.updateChatSettings({ chatId, patch: { geminiPriority: choice }, actor: OWNER });
};

/** The ChatSettingsError of `run` as `code: message`, or 'none' */
const refusalOf = async (run: () => Promise<unknown>): Promise<string> => {
    try {
        await run();
        return 'none';
    } catch (error) {
        if (error instanceof service.ChatSettingsError) return `${error.code}: ${error.message}`;
        throw error;
    }
};

const onChipDisabled = (globalOn: boolean, canEnable: boolean, savedChoice: boolean | null): boolean =>
    chatGeminiPriorityOptionsOf(globalOn, canEnable, savedChoice).find((option) => option.value === true)
        ?.disabled === true;

const describeCell = (chatId: number, choice: boolean | null, globalOn: boolean): string =>
    `${chatId === WHITELISTED_CHAT ? 'whitelisted' : 'other'} chat, choice ${String(choice)}, global ${globalOn ? 'on' : 'off'}`;

const results: CaseResult[] = [];

results.push(
    await runCase("the chat page's effective value matches the server in all 12 cells", async () => {
        for (const chatId of [WHITELISTED_CHAT, OTHER_CHAT]) {
            for (const choice of CHOICES) {
                // "On" can always be stored while the global switch is on
                await setGlobal(true);
                await setChatChoice(chatId, choice);
                for (const globalOn of [true, false]) {
                    await setGlobal(globalOn);
                    const view = geminiPriorityViewOf(chatId);
                    const stored = currentChatSettings(chatId).geminiPriority;
                    const cell = describeCell(chatId, choice, globalOn);
                    expect(stored === choice, `${cell}: the stored value survives the global switch`);
                    expect(view.globalGeminiPriority === globalOn, `${cell}: the view reports the global switch`);
                    expect(
                        effectiveGeminiPriorityOf(stored, view.globalGeminiPriority, view.geminiPriorityCanEnable) ===
                            view.effectiveGeminiPriority,
                        `${cell}: the page's local value equals the server's`
                    );
                }
            }
            await setChatChoice(chatId, null);
        }
        // Spot checks of design §8.2, so a rule both sides got wrong the same way still fails
        expect(effectiveGeminiPriorityOf(null, true, true), 'unset follows a global on');
        expect(!effectiveGeminiPriorityOf(null, false, true), 'unset follows a global off, even when whitelisted');
        expect(!effectiveGeminiPriorityOf(false, true, true), 'off is off under a global on');
        expect(!effectiveGeminiPriorityOf(true, false, false), 'on outside the whitelist is off under a global off');
        expect(effectiveGeminiPriorityOf(true, false, true), 'on inside the whitelist stays on under a global off');
    })
);

results.push(
    await runCase('the "开" chip is disabled exactly where the server refuses on', async () => {
        for (const chatId of [WHITELISTED_CHAT, OTHER_CHAT]) {
            for (const globalOn of [true, false]) {
                await setGlobal(globalOn);
                await setChatChoice(chatId, null);
                const view = geminiPriorityViewOf(chatId);
                const cell = describeCell(chatId, null, globalOn);
                const disabled = onChipDisabled(view.globalGeminiPriority, view.geminiPriorityCanEnable, null);
                const refusal = await refusalOf(() => setChatChoice(chatId, true));
                if (disabled) {
                    expect(
                        refusal === `forbidden: ${GEMINI_PRIORITY_NOT_ALLOWED_HINT}`,
                        `${cell}: disabled, and the server refuses with the hint's wording (${refusal})`
                    );
                } else {
                    expect(refusal === 'none', `${cell}: enabled, and the server accepts (${refusal})`);
                }
                await setChatChoice(chatId, null);
            }
        }
        expect(
            GEMINI_PRIORITY_NOT_ALLOWED_HINT === service.GEMINI_PRIORITY_NOT_ALLOWED_MESSAGE,
            "the page's hint is the server's refusal text"
        );
        const otherOptions = chatGeminiPriorityOptionsOf(false, false, null);
        expect(
            otherOptions.filter((option) => option.disabled).length === 1,
            'only "开" is ever disabled: following the global switch and "关" stay open'
        );
        expect(otherOptions[0]?.label === '跟随全局（当前 关）', 'the first chip names the global value (off)');
        expect(
            chatGeminiPriorityOptionsOf(true, true, null)[0]?.label === '跟随全局（当前 开）',
            'the first chip names the global value (on)'
        );
    })
);

results.push(
    await runCase('the chat page says which replies the switch reaches: Gemini text models on Vertex, not trial turns', async () => {
        expect(
            ['Vertex', 'Gemini', '文字模型', '体验用户'].every((term) => GEMINI_PRIORITY_APPLIES_HINT.includes(term)),
            `the hint names the lane, the models and the trial exception (${GEMINI_PRIORITY_APPLIES_HINT})`
        );
    })
);

results.push(
    await runCase('a stored "开" the global switch no longer allows: shown, not in effect, not resent', async () => {
        await setGlobal(true);
        await setChatChoice(OTHER_CHAT, true);
        await setGlobal(false);
        const view = geminiPriorityViewOf(OTHER_CHAT);
        const saved = currentChatSettings(OTHER_CHAT).geminiPriority;
        expect(saved === true, 'the row keeps "开"');
        expect(!view.effectiveGeminiPriority && !view.geminiPriorityCanEnable, 'the server reports it not in effect');
        expect(
            !onChipDisabled(view.globalGeminiPriority, view.geminiPriorityCanEnable, saved),
            'the saved "开" stays selectable, so the owner can undo moving away from it'
        );
        expect(
            onChipDisabled(view.globalGeminiPriority, view.geminiPriorityCanEnable, false),
            'a chat that saved "关" cannot pick "开" here'
        );

        // Saving another key leaves the switch out of the patch, and the server takes it
        const settings: ChatSettings = {
            model: null,
            promptAddendum: null,
            paused: false,
            settingsLocked: false,
            toolOverrides: null,
            geminiPriority: saved,
            thinkingEffort: null,
            richReplies: false,
            updatedAt: null,
            updatedBy: null,
        };
        const patch = changedSettingsOf(settings, {
            model: { ok: true, value: null },
            addendumValue: null,
            paused: true,
            settingsLocked: false,
            geminiPriority: saved,
            thinkingEffort: null,
            richReplies: false,
        });
        expect(JSON.stringify(patch) === '{"paused":true}', `only the pause is sent (${JSON.stringify(patch)})`);
        const refusal = await refusalOf(() =>
            service.updateChatSettings({ chatId: OTHER_CHAT, patch, actor: { userId: 1111, isOwner: false } })
        );
        expect(refusal === 'none', `a member's save of that patch goes through (${refusal})`);
        expect(currentChatSettings(OTHER_CHAT).geminiPriority === true, 'and "开" is still stored');
        await setGlobal(true);
        expect(geminiPriorityViewOf(OTHER_CHAT).effectiveGeminiPriority, 'it applies again once the global switch is on');
        await setChatChoice(OTHER_CHAT, null);
        await service.updateChatSettings({ chatId: OTHER_CHAT, patch: { paused: false }, actor: OWNER });
    })
);

results.push(
    await runCase('the chat form sends the switch only when it changed, null included', async () => {
        const settings: ChatSettings = {
            model: null,
            promptAddendum: null,
            paused: false,
            settingsLocked: false,
            toolOverrides: null,
            geminiPriority: true,
            thinkingEffort: null,
            richReplies: false,
            updatedAt: null,
            updatedBy: null,
        };
        const draftWith = (geminiPriority: boolean | null) => ({
            model: { ok: true as const, value: null },
            addendumValue: null,
            paused: false,
            settingsLocked: false,
            geminiPriority,
            thinkingEffort: null,
            richReplies: false,
        });
        expect(JSON.stringify(changedSettingsOf(settings, draftWith(true))) === '{}', 'unchanged: an empty patch');
        const backToGlobal = changedSettingsOf(settings, draftWith(null));
        expect(
            'geminiPriority' in backToGlobal && backToGlobal.geminiPriority === null,
            'back to following the global switch sends an explicit null'
        );
        expect(changedSettingsOf(settings, draftWith(false)).geminiPriority === false, '"关" sends false');
    })
);

results.push(
    await runCase('the global form composes one patch of the changed keys, and the server takes it', async () => {
        await setGlobal(false);
        const global: GlobalSettingsResponse = {
            defaultModel: service.getGlobalDefaultModel(),
            source: service.getGlobalDefaultModelSource(),
            defaultGeminiPriority: service.getGlobalGeminiPriority(),
        };
        const unchanged = changedGlobalSettingsOf(global, {
            model: { ok: true, value: global.defaultModel },
            geminiPriority: false,
        });
        expect(JSON.stringify(unchanged) === '{}', 'nothing changed: an empty patch');

        const switchOnly = changedGlobalSettingsOf(global, {
            model: { ok: true, value: global.defaultModel },
            geminiPriority: true,
        });
        expect(JSON.stringify(switchOnly) === '{"defaultGeminiPriority":true}', 'the switch alone');

        const invalidModel = changedGlobalSettingsOf(global, {
            model: { ok: false, error: '请填写模型 id' },
            geminiPriority: true,
        });
        expect(
            JSON.stringify(invalidModel) === '{"defaultGeminiPriority":true}',
            'an invalid model is left out (the form refuses to save it anyway)'
        );

        const both = changedGlobalSettingsOf(global, {
            model: { ok: true, value: 'webapp-priority-model' },
            geminiPriority: true,
        });
        expect(
            both.defaultModel === 'webapp-priority-model' && both.defaultGeminiPriority === true,
            'both keys in one patch'
        );
        const result = await service.updateGlobalSettings(both, OWNER);
        expect(result.changedKeys.length === 2, `the server wrote both (${result.changedKeys.join(', ')})`);
        expect(service.getGlobalDefaultModel() === 'webapp-priority-model', 'the model took effect');
        expect(service.getGlobalGeminiPriority(), 'the switch took effect');

        const savedGlobal: GlobalSettingsResponse = {
            defaultModel: service.getGlobalDefaultModel(),
            source: service.getGlobalDefaultModelSource(),
            defaultGeminiPriority: service.getGlobalGeminiPriority(),
        };
        const backToEnv = changedGlobalSettingsOf(savedGlobal, {
            model: { ok: true, value: null },
            geminiPriority: true,
        });
        expect(JSON.stringify(backToEnv) === '{"defaultModel":null}', 'back to the env model sends null alone');
        await service.updateGlobalSettings(backToEnv, OWNER);
        expect(service.getGlobalDefaultModelSource() === 'env', 'the env model applies again');
        await setGlobal(false);
    })
);

results.push(
    await runCase('the audit list names every key and value the server wrote', async () => {
        const chatEntries = await listSettingsAudit({ scope: `chat:${OTHER_CHAT}`, limit: 200 });
        const globalEntries = await listSettingsAudit({ scope: 'global', limit: 200 });
        const priorityEntries = [...chatEntries, ...globalEntries].filter(
            (entry) => entry.key === 'geminiPriority' || entry.key === 'defaultGeminiPriority'
        );
        expect(
            priorityEntries.some((entry) => entry.key === 'geminiPriority') &&
                priorityEntries.some((entry) => entry.key === 'defaultGeminiPriority'),
            'the cases above audited both keys'
        );
        const knownTexts = new Set(['开', '关', '跟随全局', '关（未设置）']);
        for (const entry of priorityEntries) {
            expect(auditKeyLabel(entry.key) !== entry.key, `${entry.key} has a label`);
            for (const value of [entry.oldValue, entry.newValue]) {
                const text = formatAuditValue(entry.key, value);
                expect(knownTexts.has(text), `${entry.key} ${String(value)} reads as ${text}`);
            }
        }

        expect(auditKeyLabel('geminiPriority') === 'Priority PayGo', 'chat key label');
        expect(auditKeyLabel('defaultGeminiPriority') === '全局 Priority PayGo', 'global key label');
        expect(formatAuditValue('geminiPriority', null) === '跟随全局', 'chat null follows the global switch');
        expect(formatAuditValue('defaultGeminiPriority', null) === '关（未设置）', 'no global row means off');
        expect(formatAuditValue('geminiPriority', 'true') === '开', 'chat true');
        expect(formatAuditValue('defaultGeminiPriority', 'false') === '关', 'global false');
        // The keys that were already there read as before
        expect(formatAuditValue('paused', 'true') === '开', 'paused true is unchanged');
        expect(formatAuditValue('model', null) === '跟随全局默认', 'model null is unchanged');
        expect(formatAuditValue('promptAddendum', null) === '（空）', 'other nulls are unchanged');
    })
);

results.push(
    await runCase('statistics: hit text only where replies asked, stray rounds apart, the price note', () => {
        const counts = (fields: Partial<PriorityHitCounts>): PriorityHitCounts => ({
            priorityReplies: 0,
            priorityRequestedRounds: 0,
            priorityHitRounds: 0,
            priorityHitRate: null,
            strayPriorityRounds: 0,
            ...fields,
        });
        expect(priorityHitTextOf(counts({})) === null, 'no reply asked: no hit line');
        expect(strayPriorityTextOf(counts({})) === null, 'no stray rounds: no stray line');
        const hits = counts({
            priorityReplies: 2,
            priorityRequestedRounds: 6,
            priorityHitRounds: 1,
            priorityHitRate: 1 / 6,
        });
        expect(priorityHitTextOf(hits) === 'Priority 命中 1 / 6 轮（16.7%）', `hits: ${String(priorityHitTextOf(hits))}`);
        const noRounds = counts({ priorityReplies: 1 });
        expect(
            priorityHitTextOf(noRounds) === 'Priority 命中 0 / 0 轮（—）',
            'asked but no round counted: a dash, not 0%'
        );
        const stray = counts({ strayPriorityRounds: 2 });
        expect(priorityHitTextOf(stray) === null, 'stray rounds alone do not make a hit line');
        expect(strayPriorityTextOf(stray) === '未请求 Priority 却按优先档服务 2 轮', 'stray rounds are named plainly');
        expect(pricingNoteOf('priced', false) === '已定价', 'the pricing label alone');
        expect(
            pricingNoteOf('partial', true) === '部分定价 · Priority 轮按标准价估算',
            'priority rounds at the standard price are noted'
        );
    })
);

reportResults(results);
