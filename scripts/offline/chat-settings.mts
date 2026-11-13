/**
 * Offline cases for per-chat settings: the model fallback chain, the update
 * rules (free model ids, addendum normalization, lock and owner checks), the
 * audit trail and its retention; the Priority PayGo switch (the effective
 * value of design §8.2, the TOOL_CHAT_IDS rule, owner only, audit, reload);
 * then the bot side: `/model` and the `mdl:` buttons, the reply and retry
 * settings snapshots, and what a paused chat still answers.
 *
 * Run: npx tsx scripts/offline/chat-settings.mts
 */
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';
import {
    callbackUpdate,
    contextOf,
    createFakeBot,
    createFakeTelegram,
    lastToastOf,
    messageUpdate,
    quietly,
    startChatCompletionStub,
    waitUntil,
    type TelegramCall,
} from './fake-telegram.mts';
import { startStubServer } from './support/stub-server.mts';

// Before anything reads the env: the fallback chain ends here, and the owner
// id is read once into the tool config
process.env.DEFAULT_MODEL = 'env-default-model';
process.env.OWNER_USER_ID = '4242';
// With the global Priority PayGo switch off, only these chats may switch it on
process.env.TOOL_CHAT_IDS = '-2101,-2105';

// The reply and retry cases talk to a MiMo-shaped stub; the platform reads its
// URL once, when the platforms are created
const mimoStubServer = await startStubServer();
process.env.MIMO_API_URL = `${mimoStubServer.url}/v1`;
process.env.MIMO_API_KEY = 'offline-stub';
// checkIfMentioned compares against this
process.env.BOT_USER_NAME = 'AfterSchoolTeatimeBot';

await setupOfflineDb();
const service = await import('../../src/services/chat-settings-service.js');
const { resolveChatModel } = await import('../../src/config/chat-model.js');
const { isOwnerUser } = await import('../../src/config/owner.js');
const { listSettingsAudit } = await import('../../src/db/queries/settings-audit.js');
const { SettingsAudit } = await import('../../src/db/settingsAuditDTO.js');
const { ChatSettingsRecord } = await import('../../src/db/chatSettingsDTO.js');
const { GlobalSetting } = await import('../../src/db/globalSettingDTO.js');
const { clearExpiredData } = await import('../../src/db/autoSave.js');
const dbIndex = await import('../../src/db/index.js');
const { modelConfigs, GEMINI_IMAGE_MODEL, OPENAI_IMAGE_MODEL } = await import('../../src/config/models.js');
const { formatActionTime } = await import('../../src/cmd/model-menu-text.js');
const { registerModelCommand } = await import('../../src/cmd/commands/model.js');
const { registerPicCommands } = await import('../../src/cmd/commands/pic.js');
const { menuLoad } = await import('../../src/cmd/menu.js');
const { registerChatHandler, handleReply } = await import('../../src/reply/chat-handler.js');
const { handleRetryRequest } = await import('../../src/reply/retry-handler.js');

const { ChatSettingsError, updateChatSettings, updateGlobalDefaultModel } = service;
const { resolveChatSettingsPatch } = await import('../../src/services/chat-settings-rules.js');

const OWNER = { userId: 4242, isOwner: true };
const MEMBER = { userId: 1111, isOwner: false };
const DAY_MS = 24 * 60 * 60 * 1000;

/** The ChatSettingsError code `run` throws, or 'none' */
const rejectionOf = async (run: () => Promise<unknown>): Promise<string> => {
    try {
        await run();
        return 'none';
    } catch (error) {
        if (error instanceof ChatSettingsError) return error.code;
        throw error;
    }
};

/** The ChatSettingsError `run` throws as `code: message`, or 'none' */
const refusalOf = async (run: () => Promise<unknown>): Promise<string> => {
    try {
        await run();
        return 'none';
    } catch (error) {
        if (error instanceof ChatSettingsError) return `${error.code}: ${error.message}`;
        throw error;
    }
};

/**
 * The global Priority PayGo switch: null removes the row (off). The panel
 * route owns the global write and its audit; here the row is written directly
 * and read back the way startup reads it.
 */
const setGlobalPriority = async (value: boolean | null): Promise<void> => {
    if (value === null) {
        await GlobalSetting.destroy({ where: { key: service.DEFAULT_GEMINI_PRIORITY_SETTING_KEY } });
    } else {
        await GlobalSetting.upsert({
            key: service.DEFAULT_GEMINI_PRIORITY_SETTING_KEY,
            value: String(value),
            updatedAt: new Date(),
            updatedBy: 4242,
        });
    }
    await service.loadChatSettingsCache();
};

const storedPriorityOf = async (chatId: number): Promise<boolean | null | undefined> =>
    (await ChatSettingsRecord.findByPk(chatId))?.geminiPriority;

const auditOf = (chatId: number) => listSettingsAudit({ scope: `chat:${chatId}`, limit: 100 });

// ---- the bot side: one Bot wired like production, answering offline ----

const { bot, telegram } = createFakeBot();
registerModelCommand(bot);
registerPicCommands(bot);
menuLoad(bot);
registerChatHandler(bot);

let nextBotMessageId = 70_000;
const takeBotMessageId = (): number => (nextBotMessageId += 1);

/** A message from `userId` in `chatId`, through the whole bot */
const sendText = async (chatId: number, userId: number, text: string): Promise<void> => {
    telegram.reset();
    await quietly(() => bot.handleUpdate(messageUpdate({ chatId, messageId: takeBotMessageId(), userId, text })));
};

/** A button press on bot message `messageId` */
const press = async (chatId: number, userId: number, data: string, messageId = takeBotMessageId()): Promise<void> => {
    telegram.reset();
    await quietly(() => bot.handleUpdate(callbackUpdate({ chatId, messageId, userId, data })));
};

/** Let a detached handler (setTimeout / setImmediate) run */
const settleHandlers = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 200));

interface SentText {
    text: string;
    /** The text under each code entity, in order */
    codeSpans: string[];
    hasParseMode: boolean;
    hasKeyboard: boolean;
}

const fieldsOf = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};

const sentTextOf = (call: TelegramCall | undefined): SentText => {
    const text = typeof call?.payload.text === 'string' ? call.payload.text : '';
    const entities = Array.isArray(call?.payload.entities) ? call.payload.entities.map(fieldsOf) : [];
    return {
        text,
        codeSpans: entities
            .filter((entity) => entity.type === 'code')
            .map((entity) => text.slice(Number(entity.offset), Number(entity.offset) + Number(entity.length))),
        hasParseMode: call?.payload.parse_mode !== undefined,
        hasKeyboard: call?.payload.reply_markup !== undefined,
    };
};

const lastReply = (): SentText => sentTextOf(telegram.callsOf('sendMessage').at(-1));
const lastEdit = (): SentText => sentTextOf(telegram.callsOf('editMessageText').at(-1));

/** The callback data of every button the last markup edit showed, row by row */
const lastKeyboardRows = (): string[][] => {
    const markup = fieldsOf(telegram.callsOf('editMessageReplyMarkup').at(-1)?.payload.reply_markup);
    const rows: unknown[] = Array.isArray(markup.inline_keyboard) ? markup.inline_keyboard : [];
    return rows.map((row) => (Array.isArray(row) ? row : []).map((button) => String(fieldsOf(button).callback_data)));
};

const FOOTER = '\n\n只对本聊天生效。点击下方按钮选择模型或思考等级，也可用 /model +模型名 手动指定';
const LOCKED_NOTICE = '本聊天的设置已被机主锁定';
const PAUSED_NOTICE = '本聊天已暂停';

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'before the cache loads, everything reads as defaults and the env model',
        body: async () => {
            expect(!service.isChatSettingsCacheLoaded(), 'nothing loaded yet');
            expect(service.getGlobalDefaultModel() === 'env-default-model', 'the env model applies');
            expect(service.getGlobalDefaultModelSource() === 'env', 'and is reported as env');
            expect(resolveChatModel(-1) === 'env-default-model', 'a chat follows it');
            expect(service.getChatSettings(-1) === undefined && !service.isChatPaused(-1), 'no settings, not paused');
            await service.loadChatSettingsCache();
            expect(service.isChatSettingsCacheLoaded(), 'loaded');
        },
    },
    {
        name: 'the model resolves chat → global setting → env, and null steps back down',
        body: async () => {
            const chatId = -2001;
            const global = await updateGlobalDefaultModel('panel-default-model', OWNER);
            expect(global === 'panel-default-model', `the global update returns the effective model (got ${global})`);
            expect(service.getGlobalDefaultModelSource() === 'panel', 'the source is now the panel');
            expect(resolveChatModel(chatId) === 'panel-default-model', 'a chat without its own model follows the global one');

            await updateChatSettings({ chatId, patch: { model: 'chat-own-model' }, actor: MEMBER });
            expect(resolveChatModel(chatId) === 'chat-own-model', 'the chat model wins');
            expect(resolveChatModel(-2002) === 'panel-default-model', 'other chats are untouched');

            const { settings } = await updateChatSettings({ chatId, patch: { model: null }, actor: MEMBER });
            expect(settings.model === null, 'null clears the chat model');
            expect(resolveChatModel(chatId) === 'panel-default-model', 'and the chat follows global again');

            const back = await updateGlobalDefaultModel(null, OWNER);
            expect(back === 'env-default-model', `removing the global value returns to env (got ${back})`);
            expect(service.getGlobalDefaultModelSource() === 'env', 'the source is env again');
            expect(resolveChatModel(chatId) === 'env-default-model', 'the chat follows env');

            const savedEnv = process.env.DEFAULT_MODEL;
            process.env.DEFAULT_MODEL = '';
            try {
                expect(service.getGlobalDefaultModel() === 'gpt-5', 'an empty DEFAULT_MODEL counts as unset');
            } finally {
                process.env.DEFAULT_MODEL = savedEnv;
            }
        },
    },
    {
        name: 'model ids are free: unknown ids are stored as-is, only shape is checked',
        body: async () => {
            const chatId = -2003;
            const { settings } = await updateChatSettings({
                chatId,
                patch: { model: '  not-in-any-menu-model  ' },
                actor: MEMBER,
            });
            expect(settings.model === 'not-in-any-menu-model', 'an id outside modelConfigs is accepted, trimmed');
            const row = await ChatSettingsRecord.findByPk(chatId);
            expect(row?.model === 'not-in-any-menu-model', 'and stored as-is');

            const sixtyFour = 'm'.repeat(64);
            await updateChatSettings({ chatId, patch: { model: sixtyFour }, actor: MEMBER });
            expect(resolveChatModel(chatId) === sixtyFour, '64 characters are allowed');
            const tooLong = await rejectionOf(() =>
                updateChatSettings({ chatId, patch: { model: 'm'.repeat(65) }, actor: MEMBER })
            );
            expect(tooLong === 'invalid', `65 characters are rejected (got ${tooLong})`);
            const blank = await rejectionOf(() => updateChatSettings({ chatId, patch: { model: '   ' }, actor: MEMBER }));
            expect(blank === 'invalid', `a blank id is rejected (got ${blank})`);
            expect(resolveChatModel(chatId) === sixtyFour, 'a rejected patch changes nothing');

            const globalTooLong = await rejectionOf(() => updateGlobalDefaultModel('g'.repeat(65), OWNER));
            expect(globalTooLong === 'invalid', 'the global default follows the same rule');
        },
    },
    {
        name: 'the addendum is normalized, blank means none, and over 2000 code points is refused',
        body: async () => {
            const chatId = -2004;
            const { settings } = await updateChatSettings({
                chatId,
                patch: { promptAddendum: '  第一行\r\n第二行\r\n  ' },
                actor: MEMBER,
            });
            expect(settings.promptAddendum === '第一行\n第二行', `CRLF becomes LF and the edges are trimmed (got ${JSON.stringify(settings.promptAddendum)})`);
            expect(
                service.snapshotReplySettings(chatId).promptAddendum === '第一行\n第二行',
                'the reply snapshot carries it'
            );

            const blank = await updateChatSettings({ chatId, patch: { promptAddendum: ' \n\t ' }, actor: MEMBER });
            expect(blank.settings.promptAddendum === null, 'a blank addendum is stored as NULL');

            const full = '字'.repeat(2000);
            await updateChatSettings({ chatId, patch: { promptAddendum: full }, actor: MEMBER });
            expect(service.getChatSettings(chatId)?.promptAddendum === full, '2000 characters fit');
            const astral = '😀'.repeat(2000);
            await updateChatSettings({ chatId, patch: { promptAddendum: astral }, actor: MEMBER });
            expect(service.getChatSettings(chatId)?.promptAddendum === astral, 'the limit counts code points, not UTF-16 units');

            const over = await rejectionOf(() =>
                updateChatSettings({ chatId, patch: { promptAddendum: '字'.repeat(2001) }, actor: MEMBER })
            );
            expect(over === 'invalid', `2001 characters are refused (got ${over})`);
            expect(service.getChatSettings(chatId)?.promptAddendum === astral, 'nothing is truncated or saved');
        },
    },
    {
        name: 'a locked chat refuses members before looking at the values; the owner is not bound',
        body: async () => {
            const chatId = -2005;
            const locked = await updateChatSettings({ chatId, patch: { settingsLocked: true }, actor: OWNER });
            expect(locked.settings.settingsLocked && service.isChatSettingsLocked(chatId), 'the owner locks the chat');

            const valid = await rejectionOf(() => updateChatSettings({ chatId, patch: { paused: true }, actor: MEMBER }));
            expect(valid === 'locked', `a member's valid patch is refused as locked (got ${valid})`);
            const invalid = await rejectionOf(() =>
                updateChatSettings({ chatId, patch: { model: 'x'.repeat(65) }, actor: MEMBER })
            );
            expect(invalid === 'locked', `a member's invalid patch is still locked, not invalid (got ${invalid})`);

            const ownerPatch = await updateChatSettings({ chatId, patch: { paused: true }, actor: OWNER });
            expect(ownerPatch.settings.paused && service.isChatPaused(chatId), 'the owner still changes settings');
            const ownerInvalid = await rejectionOf(() =>
                updateChatSettings({ chatId, patch: { model: 'x'.repeat(65) }, actor: OWNER })
            );
            expect(ownerInvalid === 'invalid', 'the owner gets the value check');
        },
    },
    {
        name: 'only the owner touches the lock or the global default',
        body: async () => {
            const chatId = -2006;
            const lock = await rejectionOf(() =>
                updateChatSettings({ chatId, patch: { settingsLocked: true }, actor: MEMBER })
            );
            expect(lock === 'forbidden', `a member cannot lock (got ${lock})`);
            const unlockNoop = await rejectionOf(() =>
                updateChatSettings({ chatId, patch: { settingsLocked: false, paused: true }, actor: MEMBER })
            );
            expect(unlockNoop === 'forbidden', 'not even with an unchanged value, and the rest is not applied');
            expect(!service.isChatPaused(chatId), 'the paused flag in the refused patch was not saved');
            const global = await rejectionOf(() => updateGlobalDefaultModel('anything', MEMBER));
            expect(global === 'forbidden', `a member cannot set the global default (got ${global})`);

            expect(isOwnerUser(4242) && !isOwnerUser(4243), 'the owner helper compares OWNER_USER_ID as a number');
        },
    },
    {
        name: 'unchanged values write nothing; each changed key is one audit row in the documented format',
        body: async () => {
            const chatId = -2007;
            const first = await updateChatSettings({
                chatId,
                patch: { model: 'audit-model', promptAddendum: '多行\n附加', paused: true },
                actor: MEMBER,
            });
            expect(
                JSON.stringify(first.changedKeys) === JSON.stringify(['model', 'promptAddendum', 'paused']),
                `three keys changed (got ${JSON.stringify(first.changedKeys)})`
            );
            expect(first.settings.updatedBy === MEMBER.userId, 'updatedBy is the actor');

            const repeat = await updateChatSettings({
                chatId,
                patch: { model: ' audit-model ', promptAddendum: '多行\r\n附加 ', paused: true },
                actor: MEMBER,
            });
            expect(repeat.changedKeys.length === 0, 'equal values (after normalization) change nothing');
            expect(repeat.settings.updatedAt.getTime() === first.settings.updatedAt.getTime(), 'the row is not rewritten');

            await updateChatSettings({ chatId, patch: { model: null, promptAddendum: null, paused: false }, actor: OWNER });

            const rows = await auditOf(chatId);
            expect(rows.length === 6, `one row per changed key, none for the no-op (got ${rows.length})`);
            const byKey = (key: string) => rows.filter((row) => row.key === key);
            const [modelCleared, modelSet] = byKey('model');
            expect(
                modelSet?.oldValue === null && modelSet.newValue === 'audit-model' && modelSet.actorId === MEMBER.userId,
                'model: NULL → id, by the member'
            );
            expect(
                modelCleared?.oldValue === 'audit-model' && modelCleared.newValue === null && modelCleared.actorId === OWNER.userId,
                'model: id → NULL, by the owner'
            );
            const [addendumCleared, addendumSet] = byKey('promptAddendum');
            expect(addendumSet?.newValue === '多行\n附加', 'the addendum is audited in full');
            expect(addendumCleared?.oldValue === '多行\n附加' && addendumCleared.newValue === null, 'and its removal as NULL');
            const [pausedOff, pausedOn] = byKey('paused');
            expect(pausedOn?.oldValue === 'false' && pausedOn.newValue === 'true', "booleans are 'false' → 'true'");
            expect(pausedOff?.oldValue === 'true' && pausedOff.newValue === 'false', "and 'true' → 'false'");
            expect(rows.every((row) => row.scope === `chat:${chatId}`), 'the scope is chat:<chatId>');
            expect(
                rows.every((row, index) => index === 0 || rows[index - 1]!.id > row.id),
                'newest first'
            );

            const page = await listSettingsAudit({ scope: `chat:${chatId}`, limit: 2, beforeId: rows[1]!.id });
            expect(
                page.length === 2 && page[0]!.id === rows[2]!.id && page[1]!.id === rows[3]!.id,
                'beforeId pages back from a cursor'
            );

            const globalRows = await listSettingsAudit({ scope: 'global', limit: 10 });
            expect(
                globalRows.length === 2 &&
                    globalRows[0]!.key === 'defaultModel' &&
                    globalRows[0]!.oldValue === 'panel-default-model' &&
                    globalRows[0]!.newValue === null &&
                    globalRows[1]!.oldValue === null &&
                    globalRows[1]!.newValue === 'panel-default-model',
                `the global default is audited under scope global (got ${JSON.stringify(globalRows)})`
            );
            const allScopes = new Set((await listSettingsAudit({ limit: 1000 })).map((row) => row.scope));
            expect(
                allScopes.has('global') && allScopes.has(`chat:${chatId}`) && allScopes.has('chat:-2001'),
                `without a scope every scope is listed (got ${JSON.stringify([...allScopes])})`
            );
        },
    },
    {
        name: 'tool switches: members flip every group but sms; the row and the audit keep canonical JSON',
        body: async () => {
            const { normalizeToolOverrides, parseStoredToolOverrides } = await import('../../src/services/tool-overrides.js');
            const chatId = -2012;

            const flipped = await updateChatSettings({
                chatId,
                patch: { toolOverrides: { history: true, sticker: false } },
                actor: MEMBER,
            });
            expect(JSON.stringify(flipped.changedKeys) === JSON.stringify(['toolOverrides']), 'one key changed');
            expect(
                JSON.stringify(flipped.settings.toolOverrides) === JSON.stringify({ sticker: false, history: true }),
                `canonical order, only the set keys (got ${JSON.stringify(flipped.settings.toolOverrides)})`
            );
            const row = await ChatSettingsRecord.findByPk(chatId);
            expect(
                row?.toolOverrides === '{"sticker":false,"history":true}',
                `stored as canonical JSON (got ${row?.toolOverrides})`
            );

            const smsRefused = await rejectionOf(() =>
                updateChatSettings({
                    chatId,
                    patch: { toolOverrides: { sticker: false, history: true, sms: true } },
                    actor: MEMBER,
                })
            );
            expect(smsRefused === 'forbidden', `a member cannot flip sms (got ${smsRefused})`);
            expect(
                JSON.stringify(service.getChatSettings(chatId)?.toolOverrides) === JSON.stringify({ sticker: false, history: true }),
                'the refused patch changed nothing'
            );

            const smsByOwner = await updateChatSettings({
                chatId,
                patch: { toolOverrides: { sticker: false, history: true, sms: true } },
                actor: OWNER,
            });
            expect(smsByOwner.settings.toolOverrides?.sms === true, 'the owner flips sms');

            const repeat = await updateChatSettings({
                chatId,
                patch: { toolOverrides: { sms: true, history: true, sticker: false } },
                actor: OWNER,
            });
            expect(repeat.changedKeys.length === 0, 'the same switches in another key order change nothing');

            const keepsSms = await updateChatSettings({
                chatId,
                patch: { toolOverrides: { sms: true, sticker: true } },
                actor: MEMBER,
            });
            expect(
                keepsSms.settings.toolOverrides?.sms === true && keepsSms.settings.toolOverrides?.history === undefined,
                'a member keeps sms while another group drops back to the env'
            );

            const cleared = await updateChatSettings({ chatId, patch: { toolOverrides: null }, actor: OWNER });
            expect(cleared.settings.toolOverrides === null, 'null clears every override');
            const empty = await updateChatSettings({ chatId, patch: { toolOverrides: {} }, actor: MEMBER });
            expect(empty.changedKeys.length === 0 && empty.settings.toolOverrides === null, '{} is the same as null');

            const rows = await auditOf(chatId);
            const overridesRows = rows.filter((entry) => entry.key === 'toolOverrides');
            expect(overridesRows.length === 4, `one audit row per accepted change (got ${overridesRows.length})`);
            expect(
                overridesRows[0]?.oldValue === '{"sms":true,"sticker":true}' && overridesRows[0].newValue === null,
                `the newest audit is the clear (got ${overridesRows[0]?.oldValue} → ${overridesRows[0]?.newValue})`
            );
            expect(
                overridesRows[3]?.oldValue === null && overridesRows[3].newValue === '{"sticker":false,"history":true}',
                "the oldest one is the member's first flip"
            );

            // Shape checks live in the pure normalizer (the panel's 400s use the same function)
            expect(normalizeToolOverrides({ nonsense: true }).ok === false, 'unknown group keys are refused');
            expect(normalizeToolOverrides({ sticker: 'yes' }).ok === false, 'non-boolean values are refused');
            expect(normalizeToolOverrides([]).ok === false, 'arrays are refused');
            const emptyOverrides = normalizeToolOverrides({});
            expect(emptyOverrides.ok === true, 'an empty object is accepted');
            expect(
                emptyOverrides.ok === true && JSON.stringify(emptyOverrides.value) === 'null',
                'and means "follow the env"'
            );
            expect(parseStoredToolOverrides('{"file":true}')?.file === true, 'stored JSON reads back');
            const unreadable = await quietly(async () => parseStoredToolOverrides('not json'));
            expect(unreadable === null, 'a hand-edited value reads as no overrides');
        },
    },
    {
        name: 'concurrent patches of one chat both land',
        body: async () => {
            const chatId = -2008;
            await Promise.all([
                updateChatSettings({ chatId, patch: { model: 'concurrent-model' }, actor: MEMBER }),
                updateChatSettings({ chatId, patch: { paused: true }, actor: MEMBER }),
                updateChatSettings({ chatId, patch: { promptAddendum: '并发' }, actor: MEMBER }),
            ]);
            const cached = service.getChatSettings(chatId);
            const row = await ChatSettingsRecord.findByPk(chatId);
            expect(
                cached?.model === 'concurrent-model' && cached.paused && cached.promptAddendum === '并发',
                'the cache holds all three changes'
            );
            expect(
                row?.model === 'concurrent-model' && row.paused === true && row.promptAddendum === '并发',
                'and so does the row'
            );
        },
    },
    {
        name: 'two editors of the same version: the second gets a conflict, decided inside the write queue',
        body: async () => {
            const chatId = -2015;
            // Never saved: both editors loaded the epoch version
            const seen = service.defaultChatSettings(chatId).updatedAt;
            const outcomes = await Promise.all([
                rejectionOf(() =>
                    updateChatSettings({ chatId, patch: { promptAddendum: '甲' }, actor: MEMBER, expectedUpdatedAt: seen })
                ),
                rejectionOf(() =>
                    updateChatSettings({ chatId, patch: { promptAddendum: '乙' }, actor: MEMBER, expectedUpdatedAt: seen })
                ),
            ]);
            expect(
                outcomes[0] === 'none' && outcomes[1] === 'conflict',
                `the first wins, the second is refused (got ${outcomes.join(', ')})`
            );
            expect(service.getChatSettings(chatId)?.promptAddendum === '甲', 'the first edit is kept');
            const current = service.getChatSettings(chatId)?.updatedAt ?? null;
            expect(
                (await rejectionOf(() =>
                    updateChatSettings({ chatId, patch: { promptAddendum: '丙' }, actor: MEMBER, expectedUpdatedAt: current })
                )) === 'none',
                'an editor of the current version saves'
            );
            expect(
                (await rejectionOf(() =>
                    updateChatSettings({ chatId, patch: { paused: true }, actor: MEMBER, expectedUpdatedAt: null })
                )) === 'none',
                'without an expected version there is no check'
            );
            expect((await auditOf(chatId)).length === 3, 'the refused edit wrote no audit row');
        },
    },
    {
        name: 'a reload reads back what was written',
        body: async () => {
            await updateGlobalDefaultModel('reloaded-default', OWNER);
            await service.loadChatSettingsCache();
            expect(service.getGlobalDefaultModel() === 'reloaded-default', 'the global default survives a reload');
            expect(resolveChatModel(-2008) === 'concurrent-model', 'chat settings survive a reload');
            expect(service.isChatSettingsLocked(-2005) && service.isChatPaused(-2005), 'flags survive a reload');
            expect(
                JSON.stringify(service.snapshotReplySettings(-2008)) ===
                    JSON.stringify({
                        model: 'concurrent-model',
                        promptAddendum: '并发',
                        toolOverrides: null,
                        geminiPriority: false,
                        thinkingEffort: null,
                    }),
                'the snapshot is model + addendum + tool switches + the effective Priority PayGo switch + the thinking level'
            );
            expect(
                JSON.stringify(service.snapshotReplySettings(-2999)) ===
                    JSON.stringify({
                        model: 'reloaded-default',
                        promptAddendum: null,
                        toolOverrides: null,
                        geminiPriority: false,
                        thinkingEffort: null,
                    }),
                'a chat without settings snapshots the global default'
            );
        },
    },
    {
        name: 'Priority PayGo: the effective value follows the table of design §8.2',
        body: async () => {
            const WHITELISTED = -2101;
            const OUTSIDE = -2102;
            const OFF_CHAT = -2103;
            const UNSET = -2104;
            const effective = (chatId: number): boolean => service.resolveGeminiPriority(chatId);

            await setGlobalPriority(null);
            expect(!service.getGlobalGeminiPriority(), 'no global row reads as off');
            expect(
                service.canEnableGeminiPriority(WHITELISTED) && !service.canEnableGeminiPriority(OUTSIDE),
                'global off: only a TOOL_CHAT_IDS chat can be switched on'
            );
            expect(!effective(UNSET), 'unset, global off → off');

            const whitelistedOn = await updateChatSettings({ chatId: WHITELISTED, patch: { geminiPriority: true }, actor: OWNER });
            expect(whitelistedOn.settings.geminiPriority === true, 'the owner switches a whitelisted chat on');
            expect(effective(WHITELISTED), 'on, global off, in TOOL_CHAT_IDS → on');

            const refused = await refusalOf(() =>
                updateChatSettings({ chatId: OUTSIDE, patch: { geminiPriority: true }, actor: OWNER })
            );
            expect(
                refused === `forbidden: ${service.GEMINI_PRIORITY_NOT_ALLOWED_MESSAGE}` &&
                    service.GEMINI_PRIORITY_NOT_ALLOWED_MESSAGE === '全局关闭时，只有工具白名单里的会话可以单独开启',
                `on, global off, outside the whitelist → refused with the panel's text (got ${refused})`
            );
            expect(
                service.getChatSettings(OUTSIDE) === undefined && (await storedPriorityOf(OUTSIDE)) === undefined,
                'the refused write left no row'
            );

            await updateChatSettings({ chatId: OFF_CHAT, patch: { geminiPriority: false }, actor: OWNER });
            expect(!effective(OFF_CHAT), 'off, global off → off');

            await setGlobalPriority(true);
            expect(service.getGlobalGeminiPriority(), "a 'true' row reads as on");
            expect(service.canEnableGeminiPriority(OUTSIDE), 'global on: every chat can be switched on');
            expect(effective(UNSET), 'unset, global on → on');
            expect(!effective(OFF_CHAT), 'off, global on → off');
            const outsideOn = await updateChatSettings({ chatId: OUTSIDE, patch: { geminiPriority: true }, actor: OWNER });
            expect(outsideOn.settings.geminiPriority === true && effective(OUTSIDE), 'on, global on → on, whitelist or not');
            expect(effective(WHITELISTED), 'and for a whitelisted chat');
            expect(
                service.snapshotReplySettings(UNSET).geminiPriority && !service.snapshotReplySettings(OFF_CHAT).geminiPriority,
                'the reply snapshot carries the resolved value'
            );
        },
    },
    {
        name: 'Priority PayGo: turning the global switch off keeps a stored "on", which applies again when it is back on',
        body: async () => {
            const WHITELISTED = -2101;
            const OUTSIDE = -2102;
            const UNSET = -2104;
            expect(service.getChatSettings(OUTSIDE)?.geminiPriority === true, 'the previous case left OUTSIDE on');

            await setGlobalPriority(false);
            expect(!service.getGlobalGeminiPriority(), "a 'false' row reads as off");
            expect(!service.resolveGeminiPriority(OUTSIDE), 'the stored "on" outside the whitelist no longer applies');
            expect(
                service.getChatSettings(OUTSIDE)?.geminiPriority === true && (await storedPriorityOf(OUTSIDE)) === true,
                'and the stored value is left alone'
            );
            expect(service.resolveGeminiPriority(WHITELISTED), 'a whitelisted chat stays on');
            expect(!service.resolveGeminiPriority(UNSET), 'an unset chat follows the global switch off');
            expect(!service.snapshotReplySettings(OUTSIDE).geminiPriority, 'the reply snapshot follows');

            const otherKey = await updateChatSettings({ chatId: OUTSIDE, patch: { paused: true }, actor: MEMBER });
            expect(
                JSON.stringify(otherKey.changedKeys) === JSON.stringify(['paused']) && otherKey.settings.geminiPriority === true,
                'the stored "on" does not block a patch of another key'
            );
            const sameValue = await updateChatSettings({
                chatId: OUTSIDE,
                patch: { geminiPriority: true, paused: false },
                actor: OWNER,
            });
            expect(
                JSON.stringify(sameValue.changedKeys) === JSON.stringify(['paused']),
                `resending the stored "on" is not a change, so it is not refused (got ${JSON.stringify(sameValue.changedKeys)})`
            );

            await setGlobalPriority(true);
            expect(service.resolveGeminiPriority(OUTSIDE), 'the global switch back on restores it');
        },
    },
    {
        name: 'Priority PayGo: null steps back to the global switch; the audit keeps true / false / NULL',
        body: async () => {
            const AUDITED = -2105;
            await setGlobalPriority(true);
            await updateChatSettings({ chatId: AUDITED, patch: { geminiPriority: false }, actor: OWNER });
            expect(!service.resolveGeminiPriority(AUDITED), 'off wins over the global on');
            const cleared = await updateChatSettings({ chatId: AUDITED, patch: { geminiPriority: null }, actor: OWNER });
            expect(
                cleared.settings.geminiPriority === null &&
                    JSON.stringify(cleared.changedKeys) === JSON.stringify(['geminiPriority']),
                'null clears the chat value'
            );
            expect(service.resolveGeminiPriority(AUDITED), 'and the chat follows the global switch (on)');
            await setGlobalPriority(null);
            expect(!service.resolveGeminiPriority(AUDITED), 'and follows it off again');
            expect((await storedPriorityOf(AUDITED)) === null, 'NULL in the row');

            await updateChatSettings({ chatId: AUDITED, patch: { geminiPriority: true }, actor: OWNER });
            const repeat = await updateChatSettings({ chatId: AUDITED, patch: { geminiPriority: true }, actor: OWNER });
            expect(repeat.changedKeys.length === 0, 'the same value again changes nothing');

            const rows = (await auditOf(AUDITED)).filter((row) => row.key === 'geminiPriority');
            const transitions = rows.map((row) => [row.oldValue, row.newValue]);
            expect(
                JSON.stringify(transitions) ===
                    JSON.stringify([
                        [null, 'true'],
                        ['false', null],
                        [null, 'false'],
                    ]),
                `newest first: NULL → 'true', 'false' → NULL, NULL → 'false', never the text 'null' (got ${JSON.stringify(transitions)})`
            );
            expect(rows.every((row) => row.actorId === OWNER.userId), 'all by the owner');
        },
    },
    {
        name: 'Priority PayGo: only the owner changes it; a member keeps it while editing other keys',
        body: async () => {
            const chatId = -2101;
            await setGlobalPriority(true);
            const memberOn = await refusalOf(() =>
                updateChatSettings({ chatId: -2106, patch: { geminiPriority: true }, actor: MEMBER })
            );
            expect(
                memberOn === 'forbidden: 只有机主可以开关本聊天的 Priority PayGo',
                `a member cannot switch it on, even where it is allowed (got ${memberOn})`
            );
            const memberOff = await rejectionOf(() =>
                updateChatSettings({ chatId, patch: { geminiPriority: false }, actor: MEMBER })
            );
            expect(memberOff === 'forbidden', `nor off (got ${memberOff})`);
            const memberClear = await rejectionOf(() =>
                updateChatSettings({ chatId, patch: { geminiPriority: null }, actor: MEMBER })
            );
            expect(memberClear === 'forbidden', `nor back to the global switch (got ${memberClear})`);
            expect(service.getChatSettings(chatId)?.geminiPriority === true, 'the refused patches changed nothing');

            const unchanged = await updateChatSettings({
                chatId,
                patch: { geminiPriority: true, promptAddendum: '成员改的' },
                actor: MEMBER,
            });
            expect(
                JSON.stringify(unchanged.changedKeys) === JSON.stringify(['promptAddendum']) &&
                    unchanged.settings.geminiPriority === true,
                'a member sending the current value back is not a change'
            );
            const unsetByMember = await updateChatSettings({
                chatId: -2107,
                patch: { geminiPriority: null, paused: true },
                actor: MEMBER,
            });
            expect(
                JSON.stringify(unsetByMember.changedKeys) === JSON.stringify(['paused']) &&
                    unsetByMember.settings.geminiPriority === null,
                'nor is null for a chat that never set it'
            );

            await updateChatSettings({ chatId: -2108, patch: { settingsLocked: true }, actor: OWNER });
            const locked = await rejectionOf(() =>
                updateChatSettings({ chatId: -2108, patch: { geminiPriority: true }, actor: MEMBER })
            );
            expect(locked === 'locked', `a locked chat says locked first (got ${locked})`);
            const ownerLocked = await updateChatSettings({ chatId: -2108, patch: { geminiPriority: true }, actor: OWNER });
            expect(ownerLocked.settings.geminiPriority === true, 'the owner is not bound by the lock');

            expect(service.normalizeNullableFlag('yes', 'geminiPriority').ok === false, 'a string is not a switch value');
            expect(service.normalizeNullableFlag(0, 'geminiPriority').ok === false, 'nor is a number');
            const nullValue = service.normalizeNullableFlag(null, 'geminiPriority');
            expect(nullValue.ok && nullValue.value === null, 'null is accepted');
            await setGlobalPriority(null);
        },
    },
    {
        name: 'Priority PayGo: the stored switches survive a reload from the database',
        body: async () => {
            await setGlobalPriority(true);
            // The cache is replaced by what the rows hold
            await service.loadChatSettingsCache();
            const stored = [-2101, -2102, -2103, -2104, -2105].map((chatId) => service.getChatSettings(chatId)?.geminiPriority);
            expect(
                JSON.stringify(stored) === JSON.stringify([true, true, false, undefined, true]),
                `on, on, off, no row, on (got ${JSON.stringify(stored)})`
            );
            expect(service.getChatSettings(-2107)?.geminiPriority === null, 'a row that never set it reads as null, not false');
            expect(service.getGlobalGeminiPriority(), 'the global switch reloads too');
            const rows = await Promise.all([-2101, -2103, -2107].map(storedPriorityOf));
            expect(JSON.stringify(rows) === JSON.stringify([true, false, null]), `the rows (got ${JSON.stringify(rows)})`);

            await setGlobalPriority(null);
            expect(
                service.resolveGeminiPriority(-2101) && !service.resolveGeminiPriority(-2102),
                'after a reload with the global switch off: the whitelisted chat on, the other off'
            );
        },
    },
    {
        name: 'thinking effort: the closed set, one audit row per change, a reload and a hand-edited value',
        body: async () => {
            const chatId = -2201;
            const values = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'off', null] as const;
            for (const value of values) {
                const result = await updateChatSettings({ chatId, patch: { thinkingEffort: value }, actor: MEMBER });
                expect(result.settings.thinkingEffort === value, `${String(value)} is stored`);
                expect(
                    JSON.stringify(result.changedKeys) === JSON.stringify(['thinkingEffort']),
                    `${String(value)}: only the effort changed (got ${JSON.stringify(result.changedKeys)})`
                );
            }
            await service.loadChatSettingsCache();
            expect(service.getChatSettings(chatId)?.thinkingEffort === null, 'the last value (the model default) survives a reload');

            const unknown = await rejectionOf(() =>
                updateChatSettings({ chatId, patch: { thinkingEffort: 'turbo' }, actor: MEMBER })
            );
            expect(unknown === 'invalid', `a value outside the closed set is refused (got ${unknown})`);
            expect(service.getChatSettings(chatId)?.thinkingEffort === null, 'and nothing is written for it');

            // One audit row per actual change, newest first; an unchanged value writes none
            const audited = -2202;
            await updateChatSettings({ chatId: audited, patch: { thinkingEffort: 'high' }, actor: MEMBER });
            await updateChatSettings({ chatId: audited, patch: { thinkingEffort: 'off' }, actor: MEMBER });
            await updateChatSettings({ chatId: audited, patch: { thinkingEffort: null }, actor: MEMBER });
            await updateChatSettings({ chatId: audited, patch: { thinkingEffort: null }, actor: MEMBER });
            const rows = (await auditOf(audited)).filter((entry) => entry.key === 'thinkingEffort');
            expect(rows.length === 3, `one row per change (got ${rows.length})`);
            const [newest, middle, oldest] = rows;
            expect(
                newest?.oldValue === 'off' && newest.newValue === null,
                `off → model default in the audit (got ${String(newest?.oldValue)} → ${String(newest?.newValue)})`
            );
            expect(middle?.oldValue === 'high' && middle.newValue === 'off', 'high → off in the audit');
            expect(oldest?.oldValue === null && oldest.newValue === 'high', 'model default → high in the audit');

            // A hand-edited value outside the closed set reads as the model default
            await ChatSettingsRecord.create({ chatId: -2203, thinkingEffort: 'turbo', updatedAt: new Date() });
            await service.loadChatSettingsCache();
            expect(
                service.getChatSettings(-2203)?.thinkingEffort === null,
                'an unknown stored value reads as the model default'
            );
            await ChatSettingsRecord.destroy({ where: { chatId: -2203 } });
            await service.loadChatSettingsCache();
        },
    },
    {
        name: 'thinking effort: members may change it; a trial user and a locked chat are refused',
        body: async () => {
            const current = {
                model: 'gemini-4-hydrogen',
                promptAddendum: null,
                paused: false,
                settingsLocked: false,
                toolOverrides: null,
                geminiPriority: null,
                thinkingEffort: null,
            };
            const member = resolveChatSettingsPatch(current, { thinkingEffort: 'high' }, {
                actorIsOwner: false,
                geminiPriorityCanEnable: false,
                actorIsTrial: false,
            });
            expect(
                member.kind === 'resolved' &&
                    JSON.stringify(member.changes) ===
                        JSON.stringify([{ key: 'thinkingEffort', oldValue: null, newValue: 'high' }]),
                `a member resolves, one change in the documented audit format (got ${JSON.stringify(member)})`
            );
            const trial = resolveChatSettingsPatch(current, { thinkingEffort: 'high' }, {
                actorIsOwner: false,
                geminiPriorityCanEnable: false,
                actorIsTrial: true,
            });
            expect(
                trial.kind === 'rejected' && trial.code === 'trial' && trial.message.includes('思考等级'),
                `a trial user is refused with a message about the level (got ${JSON.stringify(trial)})`
            );
            const trialPause = resolveChatSettingsPatch(current, { paused: true }, {
                actorIsOwner: false,
                geminiPriorityCanEnable: false,
                actorIsTrial: true,
            });
            expect(trialPause.kind === 'resolved', 'a trial user can still change other keys');
            const locked = resolveChatSettingsPatch({ ...current, settingsLocked: true }, { thinkingEffort: 'high' }, {
                actorIsOwner: false,
                geminiPriorityCanEnable: false,
            });
            expect(locked.kind === 'rejected' && locked.code === 'locked', 'a locked chat refuses a member first');
            const owner = resolveChatSettingsPatch(current, { thinkingEffort: 'high' }, {
                actorIsOwner: true,
                geminiPriorityCanEnable: false,
            });
            expect(owner.kind === 'resolved', 'the owner is not bound by the trial rule');
            const invalid = resolveChatSettingsPatch(current, { thinkingEffort: 'turbo' }, {
                actorIsOwner: true,
                geminiPriorityCanEnable: false,
            });
            expect(invalid.kind === 'rejected' && invalid.code === 'invalid', 'an unknown value is invalid');
            await service.loadChatSettingsCache();
        },
    },
    {
        name: 'the hourly cleanup drops audit rows older than 365 days and keeps the rest',
        body: async () => {
            const old = await SettingsAudit.create({
                actorId: 1,
                scope: 'chat:-2010',
                key: 'paused',
                oldValue: 'false',
                newValue: 'true',
                createdAt: new Date(Date.now() - 366 * DAY_MS),
            });
            const kept = await SettingsAudit.create({
                actorId: 1,
                scope: 'chat:-2010',
                key: 'paused',
                oldValue: 'true',
                newValue: 'false',
                createdAt: new Date(Date.now() - 300 * DAY_MS),
            });
            const before = await SettingsAudit.count();
            await clearExpiredData();
            expect((await SettingsAudit.findByPk(old.id)) === null, 'a 366-day-old row is gone');
            expect((await SettingsAudit.findByPk(kept.id)) !== null, 'a 300-day-old row stays');
            expect((await SettingsAudit.count()) === before - 1, 'nothing else is touched');
        },
    },
    {
        name: 'the menu holds the 13 chat models, no image model, then 跟随全局默认 and 收起',
        body: async () => {
            expect(modelConfigs.length === 13, `13 entries (got ${modelConfigs.length})`);
            const sonnet = modelConfigs.find((model) => model.id === 'claude-sonnet-5-5');
            expect(
                sonnet !== undefined && !modelConfigs.some((model) => model.id === 'claude-sonnet-5'),
                `sonnet 5.5 replaces sonnet 5 in the menu (got ${JSON.stringify(modelConfigs.map((model) => model.id))})`
            );
            expect(
                modelConfigs.some((model) => model.id === 'gemini-4-carbon'),
                'gemini-4-carbon is offered'
            );
            expect(
                !modelConfigs.some((model) => model.id === GEMINI_IMAGE_MODEL || model.id === OPENAI_IMAGE_MODEL),
                'neither image model is in the menu'
            );
            expect(
                GEMINI_IMAGE_MODEL === 'gemini-nano-banana-2.1' && OPENAI_IMAGE_MODEL === 'gpt-image-2.5-dev',
                'the image constants /picbanana, /picgpt and generate_image use are unchanged'
            );

            await press(-3000, MEMBER.userId, 'mdl:expand');
            const rows = lastKeyboardRows();
            const buttons = rows.flat();
            expect(
                buttons.filter((data) => data !== 'mdl:default' && data !== 'mdl:collapse').length === modelConfigs.length,
                `one button per menu model (got ${JSON.stringify(buttons)})`
            );
            expect(
                JSON.stringify(rows.slice(-2)) === JSON.stringify([['mdl:default'], ['mdl:collapse']]),
                `跟随全局默认 closes the models, 收起 comes last (got ${JSON.stringify(rows.slice(-2))})`
            );
            expect(!buttons.includes(`mdl:${GEMINI_IMAGE_MODEL}`), 'no image model button');
        },
    },
    {
        name: '/model and mdl: take any id from anyone, refuse an overlong one without echoing it, default follows global',
        body: async () => {
            const chatId = -3001;
            const globalModel = service.getGlobalDefaultModel();

            await sendText(chatId, MEMBER.userId, '/model not-in-menu-free-id');
            expect(resolveChatModel(chatId) === 'not-in-menu-free-id', 'a member sets an id outside the menu');
            const switched = lastReply();
            expect(
                switched.text.startsWith('切换为：not-in-menu-free-id\n思考等级：') &&
                    switched.text.includes(`\n上一个模型：${globalModel}\n操作时间：`) &&
                    switched.text.endsWith(FOOTER),
                `the switch text names both models and the level (got ${JSON.stringify(switched.text)})`
            );
            expect(!switched.hasParseMode && switched.hasKeyboard, 'entities instead of parse_mode, keyboard kept');

            await sendText(chatId, OWNER.userId, '/model owner-free-id');
            expect(resolveChatModel(chatId) === 'owner-free-id', 'the owner follows the same rule');

            await press(chatId, MEMBER.userId, 'mdl:button-free-id');
            expect(resolveChatModel(chatId) === 'button-free-id', 'a button press sets an unknown id too');
            expect(
                lastEdit().text.startsWith('切换为：button-free-id\n思考等级：') &&
                    lastEdit().text.includes('\n上一个模型：owner-free-id\n操作时间：'),
                'the menu is edited in place'
            );
            expect(lastToastOf(telegram) === '已切换到 button-free-id', `toast (got ${String(lastToastOf(telegram))})`);

            const overlong = 'x'.repeat(65);
            await sendText(chatId, MEMBER.userId, `/model ${overlong}`);
            const refused = lastReply();
            expect(
                telegram.callsOf('sendMessage').length === 1 && refused.text === '模型 id 过长',
                `an overlong id is refused (got ${JSON.stringify(refused.text)})`
            );
            expect(!refused.hasParseMode && !refused.text.includes(overlong), 'no parse_mode, the id is not echoed');
            expect(resolveChatModel(chatId) === 'button-free-id', 'and nothing is saved');
            await press(chatId, MEMBER.userId, `mdl:${'y'.repeat(65)}`);
            expect(
                lastToastOf(telegram) === '模型 id 过长' && telegram.callsOf('editMessageText').length === 0,
                'a button with an overlong id only toasts'
            );
            await sendText(chatId, MEMBER.userId, `/model ${'z'.repeat(64)}`);
            expect(resolveChatModel(chatId) === 'z'.repeat(64), '64 characters are accepted');

            await sendText(chatId, MEMBER.userId, '/model default');
            expect(service.getChatSettings(chatId)?.model === null, '/model default clears the chat model');
            expect(
                lastReply().text.startsWith(`切换为：${globalModel}（跟随全局默认）\n思考等级：`) &&
                    lastReply().text.includes(`\n上一个模型：${'z'.repeat(64)}\n操作时间：`),
                `the switch text marks the global default (got ${JSON.stringify(lastReply().text)})`
            );

            await sendText(chatId, MEMBER.userId, '/model temporary-model');
            await press(chatId, MEMBER.userId, 'mdl:default');
            expect(service.getChatSettings(chatId)?.model === null, 'mdl:default clears it as well');
            expect(
                lastToastOf(telegram) === `已改为跟随全局默认（当前 ${globalModel}）`,
                `the follow-global toast names the model (got ${String(lastToastOf(telegram))})`
            );
            expect(lastEdit().text.startsWith(`切换为：${globalModel}（跟随全局默认）`), 'and the menu says so');
        },
    },
    {
        name: 'the menu text is built from entities: a backtick id goes through and the e2e substrings stay',
        body: async () => {
            const chatId = -3002;
            const odd = 'odd`id*_[x]';
            const globalModel = service.getGlobalDefaultModel();

            await sendText(chatId, MEMBER.userId, `/model ${odd}`);
            const switched = lastReply();
            expect(!switched.hasParseMode, 'no legacy Markdown');
            expect(switched.text.includes('切换为'), 'the e2e substring 切换为 is there');
            expect(
                switched.codeSpans.length === 4 &&
                    switched.codeSpans[0] === odd &&
                    switched.codeSpans[1] === globalModel &&
                    /^\d{2}:\d{2}:\d{2} \S+$/.test(switched.codeSpans[2] ?? '') &&
                    switched.codeSpans[3] === '/model ',
                `code entities wrap the new id, the old id, the time and /model (got ${JSON.stringify(switched.codeSpans)})`
            );

            await sendText(chatId, MEMBER.userId, '/model');
            const own = lastReply();
            expect(
                own.text === `当前模型：${odd}（本聊天单独设置）\n思考等级：模型默认（由模型决定）${FOOTER}`,
                `the overview marks a chat's own model (got ${JSON.stringify(own.text)})`
            );
            expect(
                JSON.stringify(own.codeSpans) === JSON.stringify([odd, '/model ']) && own.hasKeyboard,
                `code entities and the collapsed keyboard (got ${JSON.stringify(own.codeSpans)})`
            );

            await sendText(chatId, MEMBER.userId, '/model default');
            await sendText(chatId, MEMBER.userId, '/model');
            expect(
                lastReply().text === `当前模型：${globalModel}（跟随全局默认）\n思考等级：模型默认（由模型决定）${FOOTER}`,
                `the overview marks the global default (got ${JSON.stringify(lastReply().text)})`
            );

            const savedTimeZone = process.env.TZ;
            delete process.env.TZ;
            try {
                const label = formatActionTime(new Date('2026-11-06T11:05:12Z'));
                expect(label === '19:05:12 Asia/Shanghai', `the time is computed in Asia/Shanghai (got ${label})`);
            } finally {
                if (savedTimeZone !== undefined) process.env.TZ = savedTimeZone;
            }
        },
    },
    {
        name: 'a locked chat refuses members on /model and the buttons; the owner still changes it',
        body: async () => {
            const chatId = -3003;
            await updateChatSettings({ chatId, patch: { model: 'before-lock', settingsLocked: true }, actor: OWNER });

            await sendText(chatId, MEMBER.userId, '/model member-try');
            expect(lastReply().text === LOCKED_NOTICE, `a member is refused (got ${JSON.stringify(lastReply().text)})`);
            await sendText(chatId, MEMBER.userId, '/model default');
            expect(lastReply().text === LOCKED_NOTICE, '/model default too');
            await sendText(chatId, MEMBER.userId, `/model ${'x'.repeat(65)}`);
            expect(lastReply().text === LOCKED_NOTICE, 'the lock is checked before the length');
            await press(chatId, MEMBER.userId, 'mdl:member-button');
            expect(
                lastToastOf(telegram) === LOCKED_NOTICE && telegram.callsOf('editMessageText').length === 0,
                'a button press only toasts the lock'
            );
            expect(resolveChatModel(chatId) === 'before-lock', 'nothing changed');

            await sendText(chatId, MEMBER.userId, '/model');
            expect(lastReply().text.startsWith('当前模型：before-lock（本聊天单独设置）'), 'members can still look');

            await sendText(chatId, OWNER.userId, '/model owner-after-lock');
            expect(resolveChatModel(chatId) === 'owner-after-lock', 'the owner changes a locked chat');
            await press(chatId, OWNER.userId, 'mdl:default');
            expect(service.getChatSettings(chatId)?.model === null, 'by button as well');
        },
    },
    {
        name: 'a reply keeps the settings it started with; a retry takes the chat settings at the press, never the old model',
        body: async () => {
            const chatId = -3004;
            const stub = await startChatCompletionStub(mimoStubServer, '回复内容');
            try {
                await updateChatSettings({
                    chatId,
                    patch: { model: 'mimo-v2.6-flash', promptAddendum: '附加提示词甲' },
                    actor: MEMBER,
                });
                const userMessageId = takeBotMessageId();
                const text = '@AfterSchoolTeatimeBot 你好';
                await dbIndex.saveMessage({
                    chatId,
                    messageId: userMessageId,
                    userId: MEMBER.userId,
                    date: new Date(),
                    userName: 'member',
                    message: text,
                });
                const replyTelegram = createFakeTelegram();
                const replyContext = contextOf(
                    messageUpdate({ chatId, messageId: userMessageId, userId: MEMBER.userId, text }),
                    replyTelegram
                );

                const release = stub.hold();
                const replying = quietly(() => handleReply(replyContext, { mention: true }));
                await waitUntil('the reply request to reach the model', () => stub.requests.length === 1, 15000);
                // Changed while the reply is being generated
                await updateChatSettings({
                    chatId,
                    patch: { model: 'mimo-v2.6-pro', promptAddendum: '附加提示词乙' },
                    actor: MEMBER,
                });
                release();
                await replying;

                const firstRequest = stub.requests[0] ?? {};
                const firstContents = JSON.stringify(firstRequest.messages);
                expect(
                    firstRequest.model === 'mimo-v2.6-flash',
                    `the reply used the model it started with (got ${String(firstRequest.model)})`
                );
                expect(
                    firstContents.includes('附加提示词甲') && !firstContents.includes('附加提示词乙'),
                    'and the addendum it started with'
                );
                const response = await dbIndex.BotResponse.findOne({ where: { chatId, userMessageId } });
                if (!response) throw new Error('the reply was not recorded');
                const firstVersions = response.getVersions();
                expect(
                    firstVersions.length === 1 && firstVersions[0]?.model === 'mimo-v2.6-flash',
                    `version 1 records the snapshot model (got ${JSON.stringify(firstVersions.map((version) => version.model))})`
                );
                expect(response.getMetadata().model === 'mimo-v2.6-flash', 'so does the metadata');

                // Retry pressed after the change: the chat's model now, not version 1's
                const retryTelegram = createFakeTelegram();
                const retryContext = contextOf(
                    callbackUpdate({ chatId, messageId: response.messageId, userId: MEMBER.userId, data: 'resp:retry' }),
                    retryTelegram
                );
                await quietly(() => handleRetryRequest(retryContext, response.messageId));

                const retryRequest = stub.requests[1] ?? {};
                expect(
                    retryRequest.model === 'mimo-v2.6-pro',
                    `the retry asked the chat's current model (got ${String(retryRequest.model)})`
                );
                expect(JSON.stringify(retryRequest.messages).includes('附加提示词乙'), "with the chat's current addendum");
                const retried = await dbIndex.getBotResponse(chatId, response.messageId);
                const versionModels = (retried?.getVersions() ?? []).map((version) => version.model);
                expect(
                    JSON.stringify(versionModels) === JSON.stringify(['mimo-v2.6-flash', 'mimo-v2.6-pro']),
                    `each version records its own model (got ${JSON.stringify(versionModels)})`
                );
                expect(retried?.getMetadata().model === 'mimo-v2.6-pro', 'the metadata names the latest version');
            } finally {
                await stub.close();
            }
        },
    },
    {
        name: 'a paused chat: no reply, no /picgrok, no regenerate buttons; /model and version switching still work',
        body: async () => {
            const chatId = -3005;
            await updateChatSettings({ chatId, patch: { paused: true }, actor: MEMBER });

            await sendText(chatId, MEMBER.userId, '@AfterSchoolTeatimeBot 在吗');
            await waitUntil('the paused reaction', () => telegram.callsOf('setMessageReaction').length === 1);
            const reaction = JSON.stringify(telegram.callsOf('setMessageReaction')[0]?.payload.reaction);
            expect(reaction === JSON.stringify([{ type: 'emoji', emoji: '😴' }]), `the trigger gets 😴 (got ${reaction})`);
            await settleHandlers();
            expect(
                telegram.callsOf('sendMessage').length === 0 && telegram.callsOf('sendChatAction').length === 0,
                'and no reply is started'
            );

            await sendText(chatId, MEMBER.userId, '/picgrok 一只猫');
            expect(telegram.callsOf('setMessageReaction').length === 1, '/picgrok gets 😴 as well');
            expect(
                telegram.callsOf('sendMessage').length === 0 && telegram.callsOf('sendChatAction').length === 0,
                'and generates nothing'
            );

            for (const data of ['gen:reroll:job-1', 'gen:retry:action-1', 'gen:rewrite:action-2']) {
                await press(chatId, MEMBER.userId, data);
                expect(
                    lastToastOf(telegram) === PAUSED_NOTICE && telegram.callsOf('editMessageReplyMarkup').length === 0,
                    `${data} answers 本聊天已暂停 and keeps its button`
                );
            }
            await press(chatId, MEMBER.userId, 'gen:cancel:job-1');
            expect(
                typeof lastToastOf(telegram) === 'string' && lastToastOf(telegram) !== PAUSED_NOTICE,
                `cancel is answered as usual (got ${String(lastToastOf(telegram))})`
            );

            const firstMessageId = takeBotMessageId();
            const versionOf = (versionId: number) => ({
                versionId,
                createdAt: new Date().toISOString(),
                messageIds: [firstMessageId],
                currentMessageId: firstMessageId,
                text: `版本 ${versionId}`,
                wasStoppedByUser: false,
            });
            await dbIndex.BotResponse.create({
                messageId: firstMessageId,
                chatId,
                userMessageId: firstMessageId - 1,
                currentVersionIndex: 1,
                versions: JSON.stringify([versionOf(1), versionOf(2)]),
                buttonState: dbIndex.ButtonState.HAS_VERSIONS,
                metadata: JSON.stringify({ model: 'offline', hasImage: false }),
            });
            await press(chatId, MEMBER.userId, 'resp:retry', firstMessageId);
            await settleHandlers();
            expect(
                lastToastOf(telegram) === PAUSED_NOTICE,
                `the reply retry answers 本聊天已暂停 (got ${String(lastToastOf(telegram))})`
            );
            expect(telegram.callsOf('editMessageText').length === 0, 'and regenerates nothing');

            await press(chatId, MEMBER.userId, 'resp:prev', firstMessageId);
            expect(
                lastToastOf(telegram) === '切换到版本 1/2',
                `switching versions is not blocked (got ${String(lastToastOf(telegram))})`
            );
            await waitUntil('the version switch edit', () => telegram.callsOf('editMessageText').length > 0);

            await sendText(chatId, MEMBER.userId, '/model');
            expect(lastReply().text.startsWith('当前模型：'), '/model still answers');

            await updateChatSettings({ chatId, patch: { paused: false }, actor: MEMBER });
            await press(chatId, MEMBER.userId, 'gen:reroll:job-1');
            expect(lastToastOf(telegram) !== PAUSED_NOTICE, 'unpaused, the button is handled again');
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
await mimoStubServer.close();
reportResults(results);
