/**
 * Offline cases for `/jb` on the reply path (design 2026-1128-0045): the
 * command line must never reach the model, a tree started by a reply uses that
 * tree's root, and later turns of the same tree keep the policy.
 *
 * Run: npx tsx scripts/offline/jailbreak-reply.mts
 */
import { expect, reportResults, runCase, setupOfflineDb, type CaseResult } from './harness.mts';
import {
    contextOf,
    createFakeTelegram,
    endOpenReplies,
    messageUpdate,
    quietly,
    startChatCompletionStub,
} from './fake-telegram.mts';
import { startStubServer } from './support/stub-server.mts';

const OWNER_ID = 4242;

process.env.OWNER_USER_ID = String(OWNER_ID);
process.env.ACCESS_TIERS = '0';
process.env.BOT_USER_NAME = 'AfterSchoolTeatimeBot';
delete process.env.ALLOWED_CHAT_IDS;

const stubServer = await startStubServer();
process.env.MIMO_API_URL = `${stubServer.url}/v1`;
process.env.MIMO_API_KEY = 'offline-stub';

await setupOfflineDb();

const dbIndex = await import('../../src/db/index.js');
const { handleReply, handleJbCommand } = await import('../../src/reply/chat-handler.js');
const { parseJbCommand } = await import('../../src/reply/commands/jb-command.js');
const templatesService = await import('../../src/services/prompt-templates-service.js');
const settingsService = await import('../../src/services/chat-settings-service.js');
const { readJailbreakSession } = await import('../../src/services/jailbreak-session-service.js');
const { runSchemaMigrations } = await import('../../src/db/schema-migrations.js');

await runSchemaMigrations();

const OWNER_ACTOR = { userId: OWNER_ID, isOwner: true };
const POLICY_MARKER = 'JB_POLICY_MARKER';
const CHAT = -8101;
const REPLY_CHAT = -8102;

await templatesService.createPromptTemplate(
    { name: 'policy:test', content: POLICY_MARKER, visibility: 'private', enabled: true },
    OWNER_ACTOR
);

const setModel = async (chatId: number): Promise<void> => {
    await settingsService.updateChatSettings({
        chatId,
        patch: { model: 'mimo-v2.6-flash' },
        actor: OWNER_ACTOR,
    });
};
await setModel(CHAT);
await setModel(REPLY_CHAT);

const saveUserMessage = async (
    chatId: number,
    messageId: number,
    text: string,
    replyToId?: number
): Promise<void> => {
    await dbIndex.saveMessage({
        chatId,
        messageId,
        userId: OWNER_ID,
        date: new Date(),
        userName: 'owner',
        message: text,
        ...(replyToId === undefined ? {} : { replyToId }),
    });
};

const replyCtx = (chatId: number, messageId: number, text: string) =>
    contextOf(messageUpdate({ chatId, messageId, userId: OWNER_ID, text }), createFakeTelegram());

const bodyOf = (stub: { requests: Record<string, unknown>[] }, index: number): string =>
    JSON.stringify(stub.requests.at(index) ?? {});

const results: CaseResult[] = [];

results.push(
    await runCase('a fresh /jb tree sends the policy and its prompt, never the command line', async () => {
        const stub = await startChatCompletionStub(stubServer, '好的');
        const messageId = 900;
        const text = '/jb policy:policy:test hello there from the jailbreak tree';
        await saveUserMessage(CHAT, messageId, text);
        const command = parseJbCommand(text);
        if (command === null) throw new Error('the command did not parse');
        await quietly(() => handleJbCommand(replyCtx(CHAT, messageId, text), command, 'full'));

        expect(stub.requests.length === 1, `the tree reply reached the model once (got ${stub.requests.length})`);
        const body = bodyOf(stub, 0);
        expect(body.includes(POLICY_MARKER), 'the policy template rides the system prompt');
        expect(body.includes('hello there from the jailbreak tree'), 'the prompt is the user turn');
        expect(!body.includes('/jb'), 'the command line never reaches the model');
        expect(!body.includes('policy:policy:test'), 'the option tokens never reach the model');

        const stored = await dbIndex.getMessage(CHAT, messageId);
        expect(stored?.text === 'hello there from the jailbreak tree', `the stored message is the prompt (got ${stored?.text})`);
        await stub.close();
    })
);

results.push(
    await runCase('a later turn of the same tree keeps the policy and still has no command line', async () => {
        const stub = await startChatCompletionStub(stubServer, '继续');
        const messageId = 901;
        await saveUserMessage(CHAT, messageId, '继续写下去', 900);
        await quietly(() => handleReply(replyCtx(CHAT, messageId, '继续写下去'), { mention: true }));

        expect(stub.requests.length === 1, 'the follow-up reached the model');
        const body = bodyOf(stub, 0);
        expect(body.includes(POLICY_MARKER), 'the tree policy still applies');
        expect(body.includes('继续写下去'), 'the follow-up text is there');
        expect(!body.includes('/jb'), 'the earlier command line is not in the history');

        // A sibling tree in the same chat stays on the plain prompt
        const siblingId = 902;
        await saveUserMessage(CHAT, siblingId, '普通问题');
        await quietly(() => handleReply(replyCtx(CHAT, siblingId, '普通问题'), { mention: true }));
        expect(stub.requests.length === 2, 'the sibling reply reached the model');
        expect(!bodyOf(stub, 1).includes(POLICY_MARKER), 'a sibling tree gets no policy');
        await stub.close();
    })
);

results.push(
    await runCase('/jb sent as a reply binds the existing tree root', async () => {
        const stub = await startChatCompletionStub(stubServer, '好');
        await saveUserMessage(REPLY_CHAT, 700, '旧话题的开头');
        const text = '/jb policy:policy:test 用这个策略接着写';
        await saveUserMessage(REPLY_CHAT, 701, text, 700);
        const command = parseJbCommand(text);
        if (command === null) throw new Error('the command did not parse');
        await quietly(() => handleJbCommand(replyCtx(REPLY_CHAT, 701, text), command, 'full'));

        expect(stub.requests.length === 1, 'the replied command reached the model');
        const session = await readJailbreakSession(REPLY_CHAT, 700);
        expect(session !== null, 'the session hangs off the original tree root, not the command message');
        expect(bodyOf(stub, 0).includes(POLICY_MARKER), 'the policy applies to that tree');
        expect(!bodyOf(stub, 0).includes('/jb'), 'the command line stays out of the request');

        const stored = await dbIndex.getMessage(REPLY_CHAT, 701);
        expect(stored?.text === '用这个策略接着写', `the command message keeps only its prompt (got ${stored?.text})`);
        await stub.close();
    })
);

await stubServer.close();
endOpenReplies();
reportResults(results);
