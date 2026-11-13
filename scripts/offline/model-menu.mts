/**
 * Offline cases for the model list moved into a data-backed registry
 * (pricing design §P6, the display half): the menu and /api/me read
 * `config/model-catalog.ts`'s registry instead of the frozen constants.
 *
 * - Before any catalog loads, the registry is the built-in fallback: exactly
 *   the ids and labels of `config/models.ts`.
 * - An injected catalog drives the `/model` buttons (label as the button text,
 *   id as the callback data) and the models array of /api/me; a disabled entry
 *   stays out of both. A model the owner allowed enters the menu without
 *   touching the constants, and the existing 展开/收起 two-part menu keeps
 *   working above twelve models.
 * - `setModelCatalog([])` restores the fallback (the test reset the loader uses).
 * - The default keyboard offers model selection and the thinking level side by
 *   side (thinking-effort design 2026-1113-1742 §4): the `thk:` keyboard follows
 *   the current model's catalog efforts, the toggle models add 关闭思考,
 *   `thk:` never falls into the `mdl:` otherwise branch, and a stored value the
 *   new model does not offer is shown with the vendor-default note.
 *
 * Run: npx tsx scripts/offline/model-menu.mts
 */
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';
import {
    callbackUpdate,
    createFakeBot,
    lastToastOf,
    messageUpdate,
    quietly,
} from './fake-telegram.mts';
import { signInitData, type InitDataUserInput } from '../lib/init-data.mts';

process.env.OWNER_USER_ID = '5151';
process.env.DEFAULT_MODEL = 'env-default-model';
delete process.env.ALLOWED_CHAT_IDS;

await setupOfflineDb();
const service = await import('../../src/services/chat-settings-service.js');
const { modelConfigs } = await import('../../src/config/models.js');
const { listModelCatalog, setModelCatalog } = await import('../../src/config/model-catalog.js');
const { resolveChatModel } = await import('../../src/config/chat-model.js');
const { registerModelCommand } = await import('../../src/cmd/commands/model.js');
const { menuLoad } = await import('../../src/cmd/menu.js');
const { createPanelApp } = await import('../../src/panel/app.js');
const { TRIAL_CALLBACK_REFUSAL_TEXT } = await import('../../src/reply/commands/trial-refusal.js');
const { listSettingsAudit } = await import('../../src/db/queries/settings-audit.js');

type ModelCatalogEntry = import('../../src/config/model-catalog.js').ModelCatalogEntry;

const BOT_TOKEN = '123456789:AAFakeOfflineTokenForModelMenu_0123';
const OWNER_ID = 5151;
const OWNER: InitDataUserInput = { id: OWNER_ID, first_name: 'Owner' };
const MEMBER: InitDataUserInput = { id: 5152, first_name: 'Member' };
const json = (value: unknown): string => JSON.stringify(value);

// ---- the bot side: one Bot wired like production, answering offline ----

const { bot, telegram } = createFakeBot();
registerModelCommand(bot);
menuLoad(bot);
await service.loadChatSettingsCache();

let nextBotMessageId = 90_000;
const takeBotMessageId = (): number => (nextBotMessageId += 1);

const sendText = async (chatId: number, userId: number, text: string): Promise<void> => {
    telegram.reset();
    await quietly(() => bot.handleUpdate(messageUpdate({ chatId, messageId: takeBotMessageId(), userId, text })));
};

const press = async (chatId: number, userId: number, data: string): Promise<void> => {
    telegram.reset();
    await quietly(() => bot.handleUpdate(callbackUpdate({ chatId, messageId: takeBotMessageId(), userId, data })));
};

const fieldsOf = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};

interface MenuButton {
    text: string;
    data: string;
}

/** One reply_markup value as rows of buttons */
const rowsOfMarkup = (markup: Readonly<Record<string, unknown>>): MenuButton[][] => {
    const rows: unknown[] = Array.isArray(markup.inline_keyboard) ? markup.inline_keyboard : [];
    return rows.map((row) =>
        (Array.isArray(row) ? row : []).map((button) => {
            const fields = fieldsOf(button);
            return { text: String(fields.text), data: String(fields.callback_data) };
        })
    );
};

/** The buttons the last markup edit showed, row by row */
const lastKeyboardRows = (): MenuButton[][] =>
    rowsOfMarkup(fieldsOf(telegram.callsOf('editMessageReplyMarkup').at(-1)?.payload.reply_markup));

/** The buttons of the last message the bot sent (the `/model` overview) */
const sentKeyboardRows = (): MenuButton[][] =>
    rowsOfMarkup(fieldsOf(telegram.callsOf('sendMessage').at(-1)?.payload.reply_markup));

const sentText = (): string => {
    const text = telegram.callsOf('sendMessage').at(-1)?.payload.text;
    return typeof text === 'string' ? text : '';
};

const lastEditText = (): string => {
    const text = telegram.callsOf('editMessageText').at(-1)?.payload.text;
    return typeof text === 'string' ? text : '';
};

const thinkingOf = (chatId: number): string | null =>
    service.getChatSettings(chatId)?.thinkingEffort ?? null;

const setModelFor = async (chatId: number, model: string): Promise<void> => {
    await service.updateChatSettings({
        chatId,
        patch: { model },
        actor: { userId: OWNER_ID, isOwner: true },
    });
};

const setThinkingFor = async (chatId: number, value: string | null): Promise<void> => {
    await service.updateChatSettings({
        chatId,
        patch: { thinkingEffort: value },
        actor: { userId: OWNER_ID, isOwner: true },
    });
};

const chatAuditOf = (chatId: number) => listSettingsAudit({ scope: `chat:${chatId}`, limit: 50 });

// ---- the panel side: /api/me through the real app with a fake membership ----

const app = createPanelApp({
    botToken: BOT_TOKEN,
    membershipLookup: async () => ({ status: 'member' }),
    staticRoot: '/nonexistent/model-menu-static',
    startedAt: new Date(Date.now() - 5_000),
    version: 'abc1234',
    rateLimit: { limit: 10_000, windowMs: 60_000 },
});

const meModels = async (user: InitDataUserInput): Promise<{ status: number; models: readonly string[] }> => {
    const initData = signInitData({ botToken: BOT_TOKEN, user, authDate: Math.floor(Date.now() / 1000) });
    const response = await app.request('/api/me', { headers: { 'X-Init-Data': initData } });
    const body: any = await response.json();
    return { status: response.status, models: Array.isArray(body.models) ? body.models : [] };
};

// ---- fixtures ----

const catalogEntry = (id: string, label: string, enabled = true): ModelCatalogEntry => ({
    id,
    label,
    enabled,
    capabilities: {
        kind: 'chat',
        vision: false,
        imageOutput: false,
        tools: true,
        reasoningEffort: [],
        contextTokens: null,
        outputTokens: null,
    },
    source: 'manual',
    checkedOn: '2026-11-13',
    confidence: 'high',
});

const FALLBACK_IDS: readonly string[] = modelConfigs.map((model) => model.id);

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'before a catalog loads, the menu and /api/me use the built-in fallback',
        body: async () => {
            expect(
                json(listModelCatalog().map((entry) => entry.id)) === json(FALLBACK_IDS),
                `the fallback is the menu constants (got ${json(listModelCatalog().map((entry) => entry.id))})`
            );
            expect(
                listModelCatalog().every((entry) => entry.enabled),
                'every fallback entry is offered'
            );

            const models = await meModels(MEMBER);
            expect(models.status === 200, `200 from /api/me (got ${models.status})`);
            expect(json(models.models) === json(FALLBACK_IDS), `/api/me lists the fallback (got ${json(models.models)})`);

            const chatId = -7001;
            await sendText(chatId, MEMBER.id, '/model');
            await press(chatId, MEMBER.id, 'mdl:expand');
            const rows = lastKeyboardRows();
            const buttons = rows.flat();
            expect(buttons.length === FALLBACK_IDS.length + 2, `one button per model plus the two controls (got ${buttons.length})`);
            expect(
                json(buttons.slice(0, FALLBACK_IDS.length).map((button) => button.data)) ===
                    json(FALLBACK_IDS.map((id) => `mdl:${id}`)),
                'the buttons follow the catalog order'
            );
            expect(
                json(rows.slice(-2)) === json([[{ text: '跟随全局默认', data: 'mdl:default' }], [{ text: '收起', data: 'mdl:collapse' }]]),
                `跟随全局默认 then 收起 close the menu (got ${json(rows.slice(-2))})`
            );
            expect(
                buttons.some((button) => button.data === 'mdl:gemini-4-carbon'),
                'the carbon model is offered'
            );
        },
    },
    {
        name: 'an injected catalog drives the menu labels, /api/me and the switch; disabled entries stay out',
        body: async () => {
            const entries: ModelCatalogEntry[] = modelConfigs.map((model, index) =>
                // A label that is not the id must be the button text
                catalogEntry(model.id, index === modelConfigs.length - 1 ? 'MiMo 2.6 Pro' : model.name)
            );
            entries.push(catalogEntry('gpt-6-nova', 'GPT-6 Nova'));
            entries.push(catalogEntry('gpt-6-hidden', 'GPT-6 Hidden', false));
            setModelCatalog(entries);

            const enabledIds = entries.filter((entry) => entry.enabled).map((entry) => entry.id);
            expect(
                json(listModelCatalog().map((entry) => entry.id)) === json(enabledIds),
                `only enabled entries are listed (got ${json(listModelCatalog().map((entry) => entry.id))})`
            );
            expect(
                listModelCatalog().find((entry) => entry.id === 'mimo-v2.6-pro')?.label === 'MiMo 2.6 Pro',
                'the registry label is kept'
            );

            const models = await meModels(MEMBER);
            expect(json(models.models) === json(enabledIds), `/api/me follows the registry (got ${json(models.models)})`);
            expect(!models.models.includes('gpt-6-hidden'), 'a disabled entry is not in /api/me either');

            const chatId = -7002;
            await sendText(chatId, MEMBER.id, '/model');
            await press(chatId, MEMBER.id, 'mdl:expand');
            const buttons = lastKeyboardRows().flat();
            expect(
                buttons.length === enabledIds.length + 2,
                `one button per enabled model: the new model entered the menu (got ${buttons.length} of ${enabledIds.length + 2})`
            );
            expect(
                buttons.some((button) => button.data === 'mdl:gpt-6-nova' && button.text === 'GPT-6 Nova'),
                `the allowed model's button carries the catalog label (got ${json(buttons)})`
            );
            expect(
                !buttons.some((button) => button.data === 'mdl:gpt-6-hidden'),
                'the disabled model has no button'
            );
            expect(
                buttons.find((button) => button.data === 'mdl:mimo-v2.6-pro')?.text === 'MiMo 2.6 Pro',
                'an existing model shows its registry label'
            );

            await press(chatId, MEMBER.id, 'mdl:gpt-6-nova');
            expect(resolveChatModel(chatId) === 'gpt-6-nova', 'the button of a model without a constant selects it');
            expect(lastToastOf(telegram) === '已切换到 gpt-6-nova', `toast (got ${String(lastToastOf(telegram))})`);
        },
    },
    {
        name: 'setModelCatalog([]) is the reset: the fallback is back in the menu and /api/me',
        body: async () => {
            setModelCatalog([]);
            expect(
                json(listModelCatalog().map((entry) => entry.id)) === json(FALLBACK_IDS),
                'the fallback returns (the loader/test reset)'
            );
            const models = await meModels(OWNER);
            expect(json(models.models) === json(FALLBACK_IDS), `/api/me is back to the fallback (got ${json(models.models)})`);
        },
    },
    {
        name: 'the default keyboard offers model and thinking in one row, and 收起 returns to it',
        body: async () => {
            const chatId = -7003;
            await sendText(chatId, MEMBER.id, '/model');
            const rows = sentKeyboardRows();
            expect(rows.length === 1 && rows[0]?.length === 2, `one row of two buttons (got ${json(rows)})`);
            expect(
                json(rows[0]) ===
                    json([
                        { text: '🧩 模型选择', data: 'mdl:expand' },
                        { text: '🧠 思考等级', data: 'thk:expand' },
                    ]),
                `model selection left, thinking right (got ${json(rows[0])})`
            );
            expect(
                sentText().includes('思考等级：模型默认（由模型决定）'),
                `the overview states the model default (got ${json(sentText())})`
            );

            await press(chatId, MEMBER.id, 'mdl:expand');
            await press(chatId, MEMBER.id, 'mdl:collapse');
            const collapsed = lastKeyboardRows();
            expect(
                json(collapsed) ===
                    json([
                        [
                            { text: '🧩 模型选择', data: 'mdl:expand' },
                            { text: '🧠 思考等级', data: 'thk:expand' },
                        ],
                    ]),
                `收起 returns to the dual keyboard (got ${json(collapsed)})`
            );
        },
    },
    {
        name: 'the hydrogen thinking keyboard offers its four efforts, the model default and 收起',
        body: async () => {
            const chatId = -7004;
            await setModelFor(chatId, 'gemini-4-hydrogen');
            await sendText(chatId, MEMBER.id, '/model');
            expect(sentText().includes('思考等级：模型默认（高）'), `the catalog default is shown (got ${json(sentText())})`);

            await press(chatId, MEMBER.id, 'thk:expand');
            const rows = lastKeyboardRows();
            const buttons = rows.flat();
            expect(
                json(buttons.map((button) => button.data)) ===
                    json(['thk:low', 'thk:medium', 'thk:high', 'thk:xhigh', 'thk:default', 'thk:back']),
                `the efforts in catalog order (got ${json(buttons.map((button) => button.data))})`
            );
            expect(
                buttons.slice(0, 4).map((button) => button.text).join('/') === '低/中/高/极高',
                `the labels are Chinese (got ${json(buttons.map((button) => button.text))})`
            );
            expect(!buttons.some((button) => button.data === 'thk:off'), 'a model without toggle offers no 关闭思考');
            expect(
                json(rows.at(-1)) === json([{ text: '收起', data: 'thk:back' }]),
                `收起 is the last row (got ${json(rows.at(-1))})`
            );
            expect(
                buttons.find((button) => button.data === 'thk:default')?.text === '✓ 模型默认',
                `the current value is marked (got ${json(buttons.find((button) => button.data === 'thk:default')?.text)})`
            );
        },
    },
    {
        name: 'deepseek adds 关闭思考 before its efforts; mimo offers only the toggle',
        body: async () => {
            const deepseekChat = -7005;
            await setModelFor(deepseekChat, 'deepseek-flash');
            await sendText(deepseekChat, MEMBER.id, '/model');
            await press(deepseekChat, MEMBER.id, 'thk:expand');
            const deepseekButtons = lastKeyboardRows().flat();
            expect(
                json(deepseekButtons.map((button) => button.data)) ===
                    json(['thk:off', 'thk:low', 'thk:high', 'thk:max', 'thk:default', 'thk:back']),
                `关闭思考 comes first, then the efforts (got ${json(deepseekButtons.map((button) => button.data))})`
            );
            expect(
                deepseekButtons.some((button) => button.data === 'thk:off' && button.text === '关闭思考'),
                'the toggle is offered'
            );

            const mimoChat = -7006;
            await setModelFor(mimoChat, 'mimo-v2.6-pro');
            await sendText(mimoChat, MEMBER.id, '/model');
            await press(mimoChat, MEMBER.id, 'thk:expand');
            const mimoButtons = lastKeyboardRows().flat();
            expect(
                json(mimoButtons.map((button) => button.data)) === json(['thk:off', 'thk:default', 'thk:back']),
                `toggle-only: 关闭思考, 模型默认, 收起 (got ${json(mimoButtons.map((button) => button.data))})`
            );
            expect(
                !mimoButtons.some((button) => ['thk:low', 'thk:medium', 'thk:high'].includes(button.data)),
                'a toggle-only model has no graded effort buttons'
            );
            expect(
                mimoButtons.find((button) => button.data === 'thk:default')?.text === '✓ 模型默认（思考开）',
                `a toggle-only model names its vendor default (got ${json(mimoButtons.find((button) => button.data === 'thk:default')?.text)})`
            );
        },
    },
    {
        name: 'a model without thinking data gets a 收起-only keyboard and a toast',
        body: async () => {
            const chatId = -7007;
            await setModelFor(chatId, 'gpt-9-mystery');
            await sendText(chatId, MEMBER.id, '/model');
            expect(
                sentText().includes('思考等级：模型默认（由模型决定）'),
                `the overview says the model decides (got ${json(sentText())})`
            );

            await press(chatId, MEMBER.id, 'thk:expand');
            expect(
                lastToastOf(telegram) === '当前模型不支持思考档位',
                `the toast says the model has no levels (got ${String(lastToastOf(telegram))})`
            );
            expect(
                json(lastKeyboardRows()) === json([[{ text: '收起', data: 'thk:back' }]]),
                `only 收起 is offered (got ${json(lastKeyboardRows())})`
            );
        },
    },
    {
        name: 'picking an effort stores it, audits it and the overview follows; default and off too',
        body: async () => {
            const chatId = -7008;
            await setModelFor(chatId, 'gemini-4-hydrogen');
            await sendText(chatId, OWNER.id, '/model');
            await press(chatId, OWNER.id, 'thk:expand');
            await press(chatId, OWNER.id, 'thk:xhigh');
            expect(thinkingOf(chatId) === 'xhigh', `the effort is stored (got ${String(thinkingOf(chatId))})`);
            expect(resolveChatModel(chatId) === 'gemini-4-hydrogen', 'a thk: press never changes the model');
            expect(
                lastToastOf(telegram) === '思考等级已设为 极高',
                `the toast names the level (got ${String(lastToastOf(telegram))})`
            );
            expect(
                lastEditText().includes('思考等级：极高（本聊天设置）'),
                `the menu text follows the change (got ${json(lastEditText())})`
            );
            const audit = (await chatAuditOf(chatId)).find((entry) => entry.key === 'thinkingEffort');
            expect(audit?.oldValue === null && audit?.newValue === 'xhigh', `the write is audited (got ${json(audit)})`);

            await press(chatId, OWNER.id, 'thk:default');
            expect(thinkingOf(chatId) === null, '模型默认 clears the stored value');
            expect(lastToastOf(telegram) === '已恢复模型默认', `the default toast (got ${String(lastToastOf(telegram))})`);
            expect(
                lastEditText().includes('思考等级：模型默认（高）'),
                `the overview goes back to the vendor default (got ${json(lastEditText())})`
            );

            const deepseekChat = -7009;
            await setModelFor(deepseekChat, 'deepseek-flash');
            await sendText(deepseekChat, OWNER.id, '/model');
            await press(deepseekChat, OWNER.id, 'thk:off');
            expect(thinkingOf(deepseekChat) === 'off', `the off switch is stored (got ${String(thinkingOf(deepseekChat))})`);
            expect(lastToastOf(telegram) === '已关闭思考', `the off toast (got ${String(lastToastOf(telegram))})`);
            expect(
                lastEditText().includes('思考等级：关闭思考（本聊天设置）'),
                `the overview says thinking is off (got ${json(lastEditText())})`
            );
        },
    },
    {
        name: 'a stored level the new model does not offer keeps its value and says so',
        body: async () => {
            const chatId = -7010;
            await setModelFor(chatId, 'gemini-4-hydrogen');
            await setThinkingFor(chatId, 'xhigh');
            await setModelFor(chatId, 'gemini-4-argon');
            await sendText(chatId, MEMBER.id, '/model');
            expect(
                sentText().includes('思考等级：极高（本聊天设置；当前模型不支持该档位，将按最接近的受支持档生效）'),
                `the clamped level is explained (got ${json(sentText())})`
            );
            expect(thinkingOf(chatId) === 'xhigh', 'the stored value is never cleared by a model switch');
        },
    },
    {
        name: 'a stored graded level on a toggle-only model says the vendor default applies',
        body: async () => {
            const chatId = -7014;
            await setModelFor(chatId, 'gemini-4-hydrogen');
            await setThinkingFor(chatId, 'high');
            await setModelFor(chatId, 'mimo-v2.6-pro');
            await sendText(chatId, MEMBER.id, '/model');
            expect(
                sentText().includes('思考等级：高（本聊天设置；当前模型不支持该档位，将按厂商默认生效）'),
                `a toggle-only model cannot clamp to a graded level (got ${json(sentText())})`
            );
            expect(thinkingOf(chatId) === 'high', 'the stored value survives the switch');
        },
    },
    {
        name: 'a trial user is refused, and a locked chat refuses a member',
        body: async () => {
            const trialChat = -7011;
            await setModelFor(trialChat, 'gemini-4-hydrogen');
            process.env.ACCESS_TIERS = '1';
            delete process.env.ACCESS_GROUP_IDS;
            delete process.env.TOOL_CHAT_IDS;
            try {
                await press(trialChat, MEMBER.id, 'thk:high');
                expect(
                    lastToastOf(telegram) === TRIAL_CALLBACK_REFUSAL_TEXT,
                    `a trial user is told no (got ${String(lastToastOf(telegram))})`
                );
                expect(thinkingOf(trialChat) === null, 'nothing was stored for a trial user');
            } finally {
                process.env.ACCESS_TIERS = '0';
            }

            const lockedChat = -7012;
            await setModelFor(lockedChat, 'gemini-4-hydrogen');
            await service.updateChatSettings({
                chatId: lockedChat,
                patch: { settingsLocked: true },
                actor: { userId: OWNER_ID, isOwner: true },
            });
            await press(lockedChat, MEMBER.id, 'thk:high');
            expect(
                lastToastOf(telegram) === '本聊天的设置已被机主锁定',
                `a locked chat refuses a member (got ${String(lastToastOf(telegram))})`
            );
            expect(thinkingOf(lockedChat) === null, 'the locked setting is untouched');
        },
    },
    {
        name: 'thk: never falls into the mdl: otherwise branch',
        body: async () => {
            const chatId = -7013;
            await setModelFor(chatId, 'gemini-4-hydrogen');
            await sendText(chatId, MEMBER.id, '/model');
            await press(chatId, MEMBER.id, 'thk:expand');
            await press(chatId, MEMBER.id, 'thk:low');
            expect(resolveChatModel(chatId) === 'gemini-4-hydrogen', 'a thk: press never selects a model');
            expect(thinkingOf(chatId) === 'low', 'the effort was stored');

            await press(chatId, MEMBER.id, 'thk:back');
            expect(
                json(lastKeyboardRows()) ===
                    json([
                        [
                            { text: '🧩 模型选择', data: 'mdl:expand' },
                            { text: '🧠 思考等级', data: 'thk:expand' },
                        ],
                    ]),
                `thk:back returns to the dual keyboard (got ${json(lastKeyboardRows())})`
            );
            await press(chatId, MEMBER.id, 'thk:unknown');
            expect(resolveChatModel(chatId) === 'gemini-4-hydrogen', 'an unknown thk: action changes no model');
            expect(thinkingOf(chatId) === 'low', 'and stores nothing');
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
reportResults(results);
