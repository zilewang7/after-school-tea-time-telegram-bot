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

/** The buttons the last markup edit showed, row by row */
const lastKeyboardRows = (): MenuButton[][] => {
    const markup = fieldsOf(telegram.callsOf('editMessageReplyMarkup').at(-1)?.payload.reply_markup);
    const rows: unknown[] = Array.isArray(markup.inline_keyboard) ? markup.inline_keyboard : [];
    return rows.map((row) =>
        (Array.isArray(row) ? row : []).map((button) => {
            const fields = fieldsOf(button);
            return { text: String(fields.text), data: String(fields.callback_data) };
        })
    );
};

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
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
reportResults(results);
