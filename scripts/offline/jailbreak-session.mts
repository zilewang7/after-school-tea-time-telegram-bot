/**
 * Offline cases for the jailbreak tree mode (design 2026-1128-0045): the `/jb`
 * command grammar and the session rows that scope a policy to one reply tree.
 *
 * Run: npx tsx scripts/offline/jailbreak-session.mts
 */
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';

process.env.OWNER_USER_ID = '4242';

await setupOfflineDb();
const { parseJbCommand, isJbCommandText } = await import('../../src/reply/commands/jb-command.js');
const {
    JAILBREAK_SESSION_TTL_MS,
    clearJailbreakSession,
    listJailbreakSessions,
    readJailbreakSession,
    registerJailbreakSession,
    sweepExpiredJailbreakSessions,
} = await import('../../src/services/jailbreak-session-service.js');
// The service is imported after the harness created the schema, so the table
// this file needs comes from the migration that ships with it
const { runSchemaMigrations } = await import('../../src/db/schema-migrations.js');
await runSchemaMigrations();

const CHAT = -1002000000001;
const OTHER_CHAT = -1002000000002;

const results: CaseResult[] = [];

results.push(
    await runCase('command grammar', async () => {
        expect(isJbCommandText('/jb hello'), 'plain command matches');
        expect(isJbCommandText('/jb@AfterSchoolTeatimeBot hello'), 'addressed command matches');
        expect(!isJbCommandText('/jbs hello'), 'a longer word is not the command');
        expect(!isJbCommandText('hello /jb'), 'a mention in the middle is not the command');

        expect(parseJbCommand('plain text') === null, 'non-command parses to null');
        expect(JSON.stringify(parseJbCommand('/jb')) === JSON.stringify({ kind: 'help' }), 'bare `/jb` asks for usage');
        expect(parseJbCommand('/jb off')?.kind === 'off', '`off` parses');
        expect(parseJbCommand('/jb list')?.kind === 'list', '`list` parses');

        const start = parseJbCommand('/jb policy:general model:gemini-4-argon write the scene please');
        expect(
            JSON.stringify(start) ===
                JSON.stringify({
                    kind: 'start',
                    prompt: 'write the scene please',
                    policyName: 'general',
                    model: 'gemini-4-argon',
                }),
            'options are stripped from the prompt'
        );

        const noOptions = parseJbCommand('/jb@AfterSchoolTeatimeBot a prompt');
        expect(
            JSON.stringify(noOptions) ===
                JSON.stringify({ kind: 'start', prompt: 'a prompt', policyName: null, model: null }),
            'the addressed form keeps the prompt'
        );

        const optionsOnly = parseJbCommand('/jb policy:general');
        expect(optionsOnly?.kind === 'help', 'options without a prompt ask for usage');
    })
);

results.push(
    await runCase('session lifecycle', async () => {
        const created = await registerJailbreakSession({
            chatId: CHAT,
            rootMessageId: 500,
            profileId: 7,
            model: 'gemini-4-argon',
            createdBy: 4242,
        });
        expect(created.profileId === 7 && created.model === 'gemini-4-argon', 'the row keeps profile and model');
        expect(
            created.expiresAt.getTime() - Date.now() > JAILBREAK_SESSION_TTL_MS - 60_000,
            'the default TTL is applied'
        );

        const read = await readJailbreakSession(CHAT, 500);
        expect(read !== null && read.profileId === 7, 'the tree reads its policy back');

        // Refreshing the same tree replaces the policy instead of adding a second row
        await registerJailbreakSession({ chatId: CHAT, rootMessageId: 500, profileId: 9, createdBy: 4242 });
        const refreshed = await readJailbreakSession(CHAT, 500);
        expect(refreshed !== null && refreshed.profileId === 9 && refreshed.model === null, 'a second `/jb` replaces the row');

        // Expiry is decided on read, so a stale row never applies
        await registerJailbreakSession({ chatId: CHAT, rootMessageId: 501, profileId: 7, createdBy: 4242, ttlMs: -1000 });
        expect((await readJailbreakSession(CHAT, 501)) === null, 'an expired row is ignored');
        const swept = await sweepExpiredJailbreakSessions();
        expect(swept >= 1, 'the sweep removes expired rows');

        // Two trees of one chat stay independent, and chat id scopes the lookup
        await registerJailbreakSession({ chatId: CHAT, rootMessageId: 502, profileId: 7, createdBy: 4242 });
        const active = await listJailbreakSessions(CHAT);
        expect(active.length === 2, 'both active trees are listed');
        expect((await readJailbreakSession(OTHER_CHAT, 500)) === null, 'another chat never sees the row');

        expect(await clearJailbreakSession(CHAT, 500), 'clearing reports the removed row');
        expect((await readJailbreakSession(CHAT, 500)) === null, 'a cleared tree has no policy');
        expect(!(await clearJailbreakSession(CHAT, 500)), 'clearing twice reports nothing removed');
    })
);

reportResults(results);
