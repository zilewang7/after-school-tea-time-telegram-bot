/**
 * Offline cases for per-chat settings: the model fallback chain, the update
 * rules (free model ids, addendum normalization, lock and owner checks), the
 * audit trail and its retention.
 *
 * Run: npx tsx scripts/offline/chat-settings.mts
 */
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';

// Before anything reads the env: the fallback chain ends here, and the owner
// id is read once into the tool config
process.env.DEFAULT_MODEL = 'env-default-model';
process.env.OWNER_USER_ID = '4242';

await setupOfflineDb();
const service = await import('../../src/services/chat-settings-service.js');
const { resolveChatModel } = await import('../../src/config/chat-model.js');
const { isOwnerUser } = await import('../../src/config/owner.js');
const { listSettingsAudit } = await import('../../src/db/queries/settings-audit.js');
const { SettingsAudit } = await import('../../src/db/settingsAuditDTO.js');
const { ChatSettingsRecord } = await import('../../src/db/chatSettingsDTO.js');
const { clearExpiredData } = await import('../../src/db/autoSave.js');

const { ChatSettingsError, updateChatSettings, updateGlobalDefaultModel } = service;

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

const auditOf = (chatId: number) => listSettingsAudit({ scope: `chat:${chatId}`, limit: 100 });

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
        name: 'a reload reads back what was written',
        body: async () => {
            await updateGlobalDefaultModel('reloaded-default', OWNER);
            await service.loadChatSettingsCache();
            expect(service.getGlobalDefaultModel() === 'reloaded-default', 'the global default survives a reload');
            expect(resolveChatModel(-2008) === 'concurrent-model', 'chat settings survive a reload');
            expect(service.isChatSettingsLocked(-2005) && service.isChatPaused(-2005), 'flags survive a reload');
            expect(
                JSON.stringify(service.snapshotReplySettings(-2008)) ===
                    JSON.stringify({ model: 'concurrent-model', promptAddendum: '并发' }),
                'the snapshot is model + addendum'
            );
            expect(
                JSON.stringify(service.snapshotReplySettings(-2999)) ===
                    JSON.stringify({ model: 'reloaded-default', promptAddendum: null }),
                'a chat without settings snapshots the global default'
            );
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
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
reportResults(results);
