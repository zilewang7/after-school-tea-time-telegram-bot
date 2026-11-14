/**
 * Offline cases for the Mini App side of the rich replies switch: the chat
 * settings form sends it only when it changed and nothing rides along with
 * it; the page reads what the server's view sends (the view's type must fit
 * the page's); the server takes the patches the form composes from a member;
 * the audit list names the key and spells both values.
 *
 * Run: npx tsx scripts/offline/webapp-rich-replies.mts
 */
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';
import type { ChatSettings } from '../../webapp/src/api/types.ts';

await setupOfflineDb();
const service = await import('../../src/services/chat-settings-service.js');
const { currentChatSettings, toSettingsView } = await import('../../src/panel/views/chat-view.js');
const { listSettingsAudit } = await import('../../src/db/queries/settings-audit.js');
const { auditKeyLabel, formatAuditValue } = await import('../../webapp/src/format.ts');
const { changedSettingsOf } = await import('../../webapp/src/pages/chat-settings/chat-settings-patch.ts');

const MEMBER = { userId: 1111, isOwner: false };
const CHAT_ID = -3201;

/** The settings of a chat that changed nothing else, as the page holds them */
const settingsWith = (richReplies: boolean): ChatSettings => ({
    model: null,
    promptAddendum: null,
    paused: false,
    settingsLocked: false,
    toolOverrides: null,
    geminiPriority: null,
    thinkingEffort: null,
    richReplies,
    updatedAt: null,
    updatedBy: null,
});

/** The form's draft with every other choice untouched */
const draftWith = (richReplies: boolean) => ({
    model: { ok: true as const, value: null },
    addendumValue: null,
    paused: false,
    settingsLocked: false,
    geminiPriority: null,
    thinkingEffort: null,
    richReplies,
});

/** The chat's settings as GET /api/chats/:chatId sends them; typed as the page's, so a missing field fails the typecheck */
const pageSettings = (): ChatSettings => toSettingsView(currentChatSettings(CHAT_ID));

const results: CaseResult[] = [];

results.push(
    await runCase('the form sends the switch only when it changed, and nothing rides along', () => {
        expect(JSON.stringify(changedSettingsOf(settingsWith(false), draftWith(false))) === '{}', 'untouched: an empty patch');
        expect(JSON.stringify(changedSettingsOf(settingsWith(true), draftWith(true))) === '{}', 'untouched while on: empty too');
        const on = changedSettingsOf(settingsWith(false), draftWith(true));
        expect(JSON.stringify(on) === '{"richReplies":true}', `switched on: only the switch (${JSON.stringify(on)})`);
        const off = changedSettingsOf(settingsWith(true), draftWith(false));
        expect(JSON.stringify(off) === '{"richReplies":false}', `switched off: an explicit false (${JSON.stringify(off)})`);
        const otherKey = changedSettingsOf(settingsWith(true), { ...draftWith(true), paused: true });
        expect(
            JSON.stringify(otherKey) === '{"paused":true}',
            `another key changed: the switch stays out (${JSON.stringify(otherKey)})`
        );
    })
);

results.push(
    await runCase('the server takes the patches the form composes, and the page reads back what was saved', async () => {
        await service.loadChatSettingsCache();
        expect(pageSettings().richReplies === false, 'a chat without a row arrives off');

        const on = await service.updateChatSettings({
            chatId: CHAT_ID,
            patch: changedSettingsOf(pageSettings(), draftWith(true)),
            actor: MEMBER,
        });
        expect(
            JSON.stringify(on.changedKeys) === '["richReplies"]',
            `a member's patch switches them on (${on.changedKeys.join(', ')})`
        );
        expect(pageSettings().richReplies === true, 'and the page reads them on');
        expect(
            JSON.stringify(changedSettingsOf(pageSettings(), draftWith(true))) === '{}',
            'the saved value leaves nothing to send'
        );

        const off = await service.updateChatSettings({
            chatId: CHAT_ID,
            patch: changedSettingsOf(pageSettings(), draftWith(false)),
            actor: MEMBER,
        });
        expect(JSON.stringify(off.changedKeys) === '["richReplies"]', 'and switches them off again');
        expect(pageSettings().richReplies === false, 'the page reads them off');
    })
);

results.push(
    await runCase('the audit list names the key and spells both values', async () => {
        const entries = (await listSettingsAudit({ scope: `chat:${CHAT_ID}`, limit: 20 })).filter(
            (entry) => entry.key === 'richReplies'
        );
        expect(entries.length === 2, `the two switches above were audited (got ${entries.length})`);
        for (const entry of entries) {
            for (const value of [entry.oldValue, entry.newValue]) {
                const text = formatAuditValue(entry.key, value);
                expect(text === '开' || text === '关', `${String(value)} reads as ${text}`);
            }
        }
        expect(auditKeyLabel('richReplies') === '富文本回复', 'the key reads 富文本回复');
        expect(formatAuditValue('richReplies', 'true') === '开', "'true' reads 开");
        expect(formatAuditValue('richReplies', 'false') === '关', "'false' reads 关");
        expect(formatAuditValue('paused', 'true') === '开', 'paused reads as before');
    })
);

reportResults(results);
