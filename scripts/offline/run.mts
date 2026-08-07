/**
 * Offline regression cases (no containers, no network).
 *
 * Run: pnpm test:offline
 *
 * Covers the invariants that the e2e suite cannot pin down deterministically:
 * `/chat` parsing, reply-tree assembly (which used to lose messages to a write
 * race) and how the assembled context is rendered for the model.
 */
import {
    OFFLINE_CHAT_ID,
    expect,
    reportResults,
    runCase,
    setupOfflineDb,
    takeMessageId,
    type CaseResult,
    type OfflineDb,
} from './harness.mts';
import type { User } from 'grammy/types';
import type { ResponseState } from '../../src/ai/types.js';

// Set before importing the gate: it snapshots the env at module load
process.env.IGNORED_SENDER_IDS = '424242';

// Same deal for the backfill service, which snapshots its base URL. The stub
// server below plays luoxu's /messages endpoint.
const BACKFILL_PORT = 9137;

/** The comfy-forward stub the /pic cases run against */
const COMFY_PORT = 9138;

// The /chat and /pic parsers decide whether `/cmd@Name` is addressed to us
process.env.BOT_USER_NAME = 'AfterSchoolTeatimeBot';
process.env.LUOXU_PREVIEW_URL = `http://127.0.0.1:${BACKFILL_PORT}`;
process.env.COMFY_FORWARD_URL = `http://127.0.0.1:${COMFY_PORT}`;
const { shouldIgnoreSender } = await import('../../src/config/sender-gate.js');

const db: OfflineDb = await setupOfflineDb();
const { Message, queries } = db;

interface SeedOptions {
    messageId?: number;
    replyToId?: number | null;
    /** Messages this one pulled into the context with /chat (message_links rows) */
    links?: number[];
    /** Serialized /chat spec, i.e. "this message is a /chat summon" */
    chatCommand?: string | null;
    text?: string | null;
    userName?: string;
    fileUniqueId?: string | null;
    fromBotSelf?: boolean;
    ocrText?: string | null;
}

/** Insert one message row directly, bypassing the Telegram-facing save path */
const seedMessage = async (options: SeedOptions = {}): Promise<number> => {
    const messageId = options.messageId ?? takeMessageId();
    await Message.create({
        chatId: OFFLINE_CHAT_ID,
        messageId,
        fromBotSelf: options.fromBotSelf ?? false,
        date: new Date(messageId * 1000),
        userName: options.userName ?? 'tester',
        // `text: null` must stay null — a /chat summon with no words of its own
        text: 'text' in options ? options.text ?? null : `message ${messageId}`,
        quoteText: null,
        file: null,
        fileMime: null,
        fileUniqueId: options.fileUniqueId ?? null,
        replyToId: options.replyToId ?? null,
        chatCommand: options.chatCommand ?? null,
        modelParts: null,
        mediaHint: null,
        forwardOrigin: null,
        ocrText: options.ocrText ?? null,
    });
    if (options.links?.length) {
        await queries.saveMessageLinks(OFFLINE_CHAT_ID, messageId, options.links);
    }
    return messageId;
};

/** A /chat summon: replies to `target`, pulls `links` in, optional own words */
const seedChatCommand = async (options: {
    target: number;
    links?: number[];
    text?: string | null;
    userName?: string;
}): Promise<number> =>
    seedMessage({
        replyToId: options.target,
        links: options.links,
        chatCommand: JSON.stringify({ messageCount: 'a', userScope: { type: 'anyone', limit: 'a' } }),
        text: options.text ?? null,
        userName: options.userName,
    });

const idsOf = (messages: Array<{ messageId: number }>): number[] =>
    messages.map((message) => message.messageId);

const asUser = (fields: { id: number; is_bot: boolean; username?: string }): User => ({
    first_name: fields.username ?? `user-${fields.id}`,
    ...fields,
});

const cases: Array<{ name: string; body: () => Promise<void> }> = [
    {
        name: 'sender gate silences bots but not people',
        body: async () => {
            expect(
                !shouldIgnoreSender(asUser({ id: 111, is_bot: false })),
                'a normal user is answered'
            );
            expect(
                shouldIgnoreSender(asUser({ id: 987598712, is_bot: true, username: 'butanediol_bot' })),
                'another bot is ignored'
            );
            expect(
                !shouldIgnoreSender(asUser({ id: 1087968824, is_bot: true, username: 'GroupAnonymousBot' })),
                'an anonymous admin is still answered'
            );
            expect(
                shouldIgnoreSender(asUser({ id: 424242, is_bot: false })),
                'IGNORED_SENDER_IDS covers userbots that report is_bot: false'
            );
            expect(!shouldIgnoreSender(undefined), 'an update without a sender is left alone');
        },
    },
    {
        // One parser for all three call sites (autoSave, the handler, the reply
        // gate). Every case below used to be mis-parsed by at least one of them.
        name: '/chat parameters are parsed by the documented syntax',
        body: async () => {
            const { parseChatCommand } = await import(
                '../../src/reply/commands/chat-command-parser.js'
            );
            const parse = (text: string) => parseChatCommand(text, '张三');

            expect(parse('随便一句话').type === 'none', 'ordinary text is not a command');
            expect(parse('/chatting about this').type === 'none', 'a longer word is not /chat');
            expect(parse('/chat').type === 'invalid', 'bare /chat asks for the help');
            expect(parse('/chat@AfterSchoolTeatimeBot').type === 'invalid', '…and so does the @form');
            expect(parse('/chat 5a 问题').type === 'invalid', 'a malformed count asks for the help');
            expect(parse('/chat 0 问题').type === 'invalid', 'zero messages asks for the help');

            const plain = parse('/chat 5 他们在说什么');
            expect(
                plain.type === 'valid' &&
                    plain.spec.messageCount === 5 &&
                    plain.spec.prompt === '他们在说什么' &&
                    plain.spec.userScope.type === 'anyone' &&
                    plain.spec.userScope.limit === Infinity,
                'count + prompt, everybody included'
            );

            expect(
                parse('/chat@SomeOtherBot 5 问题').type === 'none',
                'a command addressed to another bot is not ours to answer'
            );

            // Telegram inserts @BotName in groups; this form used to hit the help
            const mentioned = parse('/chat@AfterSchoolTeatimeBot a');
            expect(
                mentioned.type === 'valid' &&
                    mentioned.spec.messageCount === Infinity &&
                    mentioned.spec.prompt === null,
                'the @BotName form parses, with no prompt of its own'
            );

            const single = parse('/chat 3 -s 解答一下');
            expect(
                single.type === 'valid' &&
                    single.spec.userScope.type === 'named' &&
                    JSON.stringify(single.spec.userScope.names) === '["张三"]' &&
                    single.spec.prompt === '解答一下',
                '-s scopes to the replied-to person, not the sender'
            );

            const counted = parse('/chat 8 -3 他们三个人是什么关系');
            expect(
                counted.type === 'valid' &&
                    counted.spec.userScope.type === 'anyone' &&
                    counted.spec.userScope.limit === 3,
                '-3 is a people limit'
            );

            const named = parse('/chat 5 -李四/王五 张三是不是大哥');
            expect(
                named.type === 'valid' &&
                    named.spec.userScope.type === 'named' &&
                    JSON.stringify(named.spec.userScope.names) === '["李四","王五","张三"]',
                'a name list always includes the replied-to person'
            );

            const spelledOut = parse('/chat all 总结一下');
            expect(
                spelledOut.type === 'valid' &&
                    spelledOut.spec.messageCount === Infinity &&
                    spelledOut.spec.prompt === '总结一下',
                '`all` is spelled-out `a`'
            );
            expect(
                (() => {
                    const upper = parse('/chat ALL');
                    return upper.type === 'valid' && upper.spec.messageCount === Infinity;
                })(),
                'and case does not matter for it'
            );

            const summon = parse('/chat 1');
            expect(
                summon.type === 'valid' && summon.spec.messageCount === 1 && summon.spec.prompt === null,
                '/chat 1 is a valid pure summon'
            );
        },
    },
    {
        // Regression: a `replies` column on the parent used to be appended to by
        // an unawaited read-modify-write, which dropped the child entirely when
        // the parent row did not exist yet (a reply arriving mid-stream).
        name: 'a reply is in the tree even when the parent records nothing',
        body: async () => {
            const parent = await seedMessage({ text: 'question' });
            const child = await seedMessage({ replyToId: parent, text: 'answer' });
            // nothing is recorded on the parent side, on purpose

            const history = await queries.getRepliesHistory(OFFLINE_CHAT_ID, child, {
                excludeSelf: false,
            });
            expect(
                JSON.stringify(idsOf(history)) === JSON.stringify([parent, child]),
                `tree is [parent, child] (got ${JSON.stringify(idsOf(history))})`
            );
        },
    },
    {
        // The bystanders /chat pulls in have no reply relation to derive from, so
        // they come from message_links — owned by the /chat message itself, which
        // is what makes the write independent of the target row existing.
        name: 'reply children and /chat links are merged chronologically',
        body: async () => {
            const target = await seedMessage({ text: 'target' });
            const bystanderA = await seedMessage({ text: 'bystander with a picture' });
            const bystanderB = await seedMessage({ text: 'another bystander' });
            const command = await seedChatCommand({
                target,
                links: [bystanderA, bystanderB],
            });

            expect(
                JSON.stringify(await queries.getChildMessageIds(OFFLINE_CHAT_ID, target)) ===
                    JSON.stringify([command]),
                'the target only owns the reply, not the bystanders'
            );
            expect(
                JSON.stringify(await queries.getChildMessageIds(OFFLINE_CHAT_ID, command)) ===
                    JSON.stringify([bystanderA, bystanderB]),
                'the /chat message owns the messages it pulled in'
            );

            const history = await queries.getRepliesHistory(OFFLINE_CHAT_ID, command, {
                excludeSelf: false,
            });
            expect(
                JSON.stringify(idsOf(history)) ===
                    JSON.stringify([target, bystanderA, bystanderB, command]),
                `full tree keeps everything (got ${JSON.stringify(idsOf(history))})`
            );
        },
    },
    {
        // Writing links is a plain insert, so it needs neither a lock nor the
        // target row — a /chat aimed at a reply the bot is still streaming used
        // to lose every message it pulled in.
        name: '/chat links survive a target row that does not exist yet',
        body: async () => {
            const missingTarget = takeMessageId();
            const bystander = await seedMessage({ text: 'bystander' });
            const command = await seedChatCommand({ target: missingTarget, links: [bystander] });

            // Written twice: a re-triggered command must not double the rows
            await queries.saveMessageLinks(OFFLINE_CHAT_ID, command, [bystander]);

            const linked = await queries.getLinkedMessageIds(OFFLINE_CHAT_ID, [command]);
            expect(
                JSON.stringify(linked.get(command)) === JSON.stringify([bystander]),
                `the link is recorded exactly once (got ${JSON.stringify(linked.get(command))})`
            );

            const history = await queries.getRepliesHistory(OFFLINE_CHAT_ID, command, {
                excludeSelf: false,
            });
            expect(
                JSON.stringify(idsOf(history)) === JSON.stringify([bystander, command]),
                `the bystander is in the tree anyway (got ${JSON.stringify(idsOf(history))})`
            );
        },
    },
    {
        // /chat can link an ancestor onto its own descendant; without a visited
        // set the walk would loop forever.
        name: 'a cycle introduced by /chat does not hang the tree walk',
        body: async () => {
            const root = await seedMessage({ text: 'root' });
            const child = await seedChatCommand({ target: root, links: [root] });

            const history = await queries.getRepliesHistory(OFFLINE_CHAT_ID, child, {
                excludeSelf: false,
            });
            expect(
                JSON.stringify(idsOf(history)) === JSON.stringify([root, child]),
                `walk terminates with each message once (got ${JSON.stringify(idsOf(history))})`
            );
        },
    },
    {
        // Media-group sub-images are filtered out of the tree, but their media
        // must still be attached to the group's first message.
        name: 'media-group sub-images are found through the reverse reply lookup',
        body: async () => {
            const firstUniqueId = `offline-first-${takeMessageId()}`;
            const subUniqueId = `offline-sub-${takeMessageId()}`;
            await db.putCachedMedia({
                fileUniqueId: firstUniqueId,
                data: Buffer.from('first-image-bytes'),
                sizeBytes: 17,
                mime: 'image/jpeg',
                kind: 'photo',
            });
            await db.putCachedMedia({
                fileUniqueId: subUniqueId,
                data: Buffer.from('sub-image-bytes'),
                sizeBytes: 15,
                mime: 'image/jpeg',
                kind: 'photo',
            });

            const first = await seedMessage({ text: 'group caption', fileUniqueId: firstUniqueId });
            await seedMessage({
                replyToId: first,
                text: `sub image of [${first}]`,
                fileUniqueId: subUniqueId,
            });

            const parts = await queries.getFileContentsOfMessage(OFFLINE_CHAT_ID, first);
            expect(parts.length === 2, `both images are attached (got ${parts.length})`);
            expect(
                parts.every((part) => part.type === 'image'),
                'both parts are images'
            );

            const history = await queries.getRepliesHistory(OFFLINE_CHAT_ID, first, {
                excludeSelf: false,
            });
            expect(
                JSON.stringify(idsOf(history)) === JSON.stringify([first]),
                `the sub-image stays out of the tree (got ${JSON.stringify(idsOf(history))})`
            );
        },
    },
    {
        // The model sometimes copies the `[#N]` label its own history carries,
        // despite the system prompt. It must never reach the group or the DB.
        name: 'a leaked [#N] label is stripped from the reply',
        body: async () => {
            const { createContextLabelStripper, stripContextLabel } = await import(
                '../../src/reply/context-label.js'
            );

            /** Feed one reply through a fresh stripper, chunk by chunk */
            const streamed = (chunks: string[]): string => {
                const strip = createContextLabelStripper();
                return chunks.map((chunk) => strip(chunk)).join('');
            };

            expect(streamed(['[#2]\n你好呀']) === '你好呀', 'label in one chunk is removed');
            expect(
                streamed(['[', '#12]', '\n你好呀']) === '你好呀',
                'label split across chunks is removed'
            );
            expect(
                streamed(['[#2]\n\n  你好呀']) === '你好呀',
                'the blank lines after the label go too'
            );
            expect(
                streamed(['[#3] 说得对', '，我同意']) === '[#3] 说得对，我同意',
                'a label used mid-sentence is a real reference and stays'
            );
            expect(
                streamed(['你', '好', '呀']) === '你好呀',
                'an ordinary reply passes through untouched'
            );
            expect(
                streamed(['[笑] 哈哈']) === '[笑] 哈哈',
                'other bracketed openings are left alone'
            );
            expect(
                streamed(['#2 说得对']) === '#2 说得对',
                'a bare context reference is not a label'
            );
            expect(
                stripContextLabel('[#7]\n完整文本') === '完整文本',
                'the non-streaming path strips it as well'
            );
        },
    },
    {
        // Guards the wiring, not just the stripper: both buffers are fed from
        // processChunk, and the one that ends up in the DB is fullText.
        name: 'the stream processor applies the label stripping',
        body: async () => {
            const { processChunk } = await import('../../src/reply/response-handler.js');
            const { createContextLabelStripper } = await import('../../src/reply/context-label.js');

            const strip = createContextLabelStripper();
            let state: ResponseState = {
                textBuffer: '',
                thinkingBuffer: '',
                fullText: '',
                fullThinking: '',
                thinkingTruncatedChars: 0,
                images: [],
                groundingData: [],
                agentStats: undefined,
                modelParts: undefined,
                rawResponse: undefined,
                isDone: false,
            };
            for (const content of ['[#4]', '\n梓喵的回答', '就是这样']) {
                state = processChunk({ type: 'text', content }, state, strip);
            }
            expect(state.fullText === '梓喵的回答就是这样', `fullText is clean (got ${JSON.stringify(state.fullText)})`);
            expect(state.textBuffer === '梓喵的回答就是这样', 'the display buffer is clean too');

            // Platforms that report a final text replace the buffers wholesale,
            // bypassing the streaming stripper
            const finished = processChunk(
                { type: 'done', rawResponse: { output_text: '[#4]\n梓喵的回答就是这样' } },
                state,
                strip
            );
            expect(
                finished.fullText === '梓喵的回答就是这样',
                `a replacement final text is cleaned as well (got ${JSON.stringify(finished.fullText)})`
            );
        },
    },
    {
        // Every rule the help text promises, on the pure selector. Each one used
        // to be broken by the inline version this replaced.
        name: '/chat attaches the messages the help text promises',
        body: async () => {
            const { selectAttachedMessageIds } = await import(
                '../../src/reply/commands/chat-command-selection.js'
            );
            const { parseChatCommand } = await import(
                '../../src/reply/commands/chat-command-parser.js'
            );
            const specOf = (text: string) => {
                const parsed = parseChatCommand(text, 'ZHANG');
                if (parsed.type !== 'valid') throw new Error(`not a valid command: ${text}`);
                return parsed.spec;
            };

            const rows = [
                { messageId: 11, userName: 'ZHANG', text: 'one' },
                { messageId: 12, userName: 'LI', text: 'two' },
                { messageId: 13, userName: 'ZHANG', text: 'sub image of [11]' },
                { messageId: 14, userName: 'WANG', text: 'three' },
                { messageId: 15, userName: 'ZHAO', text: 'four' },
                { messageId: 16, userName: 'LI', text: 'five' },
                { messageId: 99, userName: 'ZHANG', text: null }, // the /chat message itself
            ];

            expect(
                JSON.stringify(selectAttachedMessageIds(rows, specOf('/chat 3 what'), 99)) ===
                    JSON.stringify([11, 12]),
                'the count includes the reply target, so 3 attaches 2 more'
            );
            expect(
                JSON.stringify(selectAttachedMessageIds(rows, specOf('/chat 2 what'), 99)) ===
                    JSON.stringify([11]),
                'a count of 2 stops at the first message after the target'
            );
            expect(
                JSON.stringify(selectAttachedMessageIds(rows, specOf('/chat 4 what'), 99)) ===
                    JSON.stringify([11, 12, 14]),
                'the sub-image and the command itself never spend a slot'
            );
            expect(
                JSON.stringify(selectAttachedMessageIds(rows, specOf('/chat a'), 99)) ===
                    JSON.stringify([11, 12, 14, 15, 16]),
                'a takes everything that carries content'
            );
            expect(
                JSON.stringify(selectAttachedMessageIds(rows, specOf('/chat 4 -2 who'), 99)) ===
                    JSON.stringify([11, 12, 16]),
                '-2 admits exactly two people, and the count applies after filtering'
            );
            expect(
                JSON.stringify(selectAttachedMessageIds(rows, specOf('/chat 1 hi'), 99)) ===
                    JSON.stringify([]),
                'a count of 1 is a pure summon that attaches nothing'
            );
        },
    },
    {
        // The point of the rendering: a summon that carries no words of its own
        // must never reach the model as an empty user turn it has to guess at.
        name: 'a /chat summon renders as what the user did, never as a blank message',
        body: async () => {
            const { buildContext } = await import('../../src/reply/context-builder.js');

            const contextOf = async (messageId: number) => {
                const row = await Message.findOne({
                    where: { chatId: OFFLINE_CHAT_ID, messageId },
                });
                if (!row) throw new Error(`seeded message ${messageId} not found`);
                const turns = await buildContext(row);
                const textOfTurn = (turn: (typeof turns)[number]): string =>
                    turn.content.map((part) => part.text ?? '').join('\n');
                return {
                    whole: turns.map(textOfTurn).join('\n'),
                    /** Just the trigger's own turn, which closes the context */
                    last: textOfTurn(turns[turns.length - 1]!),
                };
            };

            // The target starts the context (#1): "after #1" would describe the
            // whole context, so a wordless summon is just a summon
            const root = await seedMessage({ text: 'the starting point', userName: 'Kuro' });
            const bystander = await seedMessage({ text: 'a bystander line', userName: 'Enren' });
            const atRoot = await seedChatCommand({
                target: root,
                links: [bystander],
                userName: 'Kuro',
            });
            const atRootContext = await contextOf(atRoot);
            expect(
                atRootContext.last.includes('[summons you to reply based on the current context]'),
                `a summon on #1 says just that (got ${JSON.stringify(atRootContext.last)})`
            );
            expect(!atRootContext.last.includes('[replying to'), 'and is not rendered as a reply');
            expect(
                !atRootContext.whole.includes(': \n<<EOF'),
                'no message in the context trails off after an empty colon'
            );
            expect(
                atRootContext.whole.includes('a bystander line'),
                'the pulled-in bystander is in the context'
            );

            // The target sits mid-context: #N tells the model which stretch of
            // the context the user pulled in by hand
            await seedMessage({
                replyToId: root,
                text: 'the answer',
                userName: 'K-ON',
                fromBotSelf: true,
            });
            const answer = await Message.findOne({
                where: { chatId: OFFLINE_CHAT_ID, replyToId: root, fromBotSelf: true },
            });
            if (!answer) throw new Error('seeded bot answer not found');
            const later = await seedMessage({ text: 'later chatter', userName: 'Enren' });
            const midChain = await seedChatCommand({
                target: answer.messageId,
                links: [later],
                userName: 'Kuro',
            });
            const midContext = await contextOf(midChain);
            expect(
                /\[added the messages after #\d+ to the context, and summons you to reply\]/.test(
                    midContext.last
                ),
                `a summon mid-chain points at its target (got ${JSON.stringify(midContext.last)})`
            );
            expect(!midContext.last.includes('[replying to'), 'still never rendered as a reply');

            // With words of its own, a summon on #1 is an ordinary message
            const withWords = await seedChatCommand({
                target: root,
                links: [bystander],
                text: 'what are they talking about',
                userName: 'Kuro',
            });
            const withWordsContext = await contextOf(withWords);
            expect(
                withWordsContext.last.includes('Kuro: what are they talking about'),
                `it reads like any other message (got ${JSON.stringify(withWordsContext.last)})`
            );
            expect(
                !withWordsContext.last.includes('['),
                'and carries no annotation it does not need'
            );
        },
    },
    {
        // The same prompt file is mounted into the production and the test
        // instance, which are different bots; a hardcoded handle made the test
        // bot introduce itself as the production one.
        name: 'the system prompt takes the bot identity from the env',
        body: async () => {
            const { writeFileSync, rmSync } = await import('node:fs');
            const promptPath = '/tmp/offline-system-prompt.md';
            writeFileSync(
                promptPath,
                '你的 id 是 @{{BOT_USER_NAME}}，你的用户名是 {{BOT_NAME}}。{{UNKNOWN_VAR}}'
            );
            process.env.SYSTEM_PROMPT_FILE = promptPath;
            // Restored below: the command parsers read this to decide whether
            // `/cmd@Name` is addressed to us, so leaking it breaks later cases
            const ownUserName = process.env.BOT_USER_NAME;
            process.env.BOT_USER_NAME = 'WatchFirstBot';
            process.env.BOT_NAME = 'Test-KON';

            const { getSystemPrompt } = await import('../../src/ai/platform-factory.js');
            const prompt = getSystemPrompt();
            rmSync(promptPath, { force: true });
            process.env.BOT_USER_NAME = ownUserName;

            expect(
                prompt.includes('@WatchFirstBot') && prompt.includes('你的用户名是 Test-KON'),
                `the running bot's own identity is substituted (got ${JSON.stringify(prompt)})`
            );
            expect(
                !prompt.includes('{{BOT_USER_NAME}}') && !prompt.includes('{{BOT_NAME}}'),
                'no placeholder is left behind'
            );
            expect(
                prompt.includes('{{UNKNOWN_VAR}}'),
                'a variable outside the allowlist is left verbatim rather than silently dropped'
            );
        },
    },
    {
        // A model that cannot see images gets the OCR text instead; one that can
        // must not get it, or it would pay for the same content twice.
        name: 'OCR text is offered only to models that cannot see images',
        body: async () => {
            const { buildContext } = await import('../../src/reply/context-builder.js');

            const uniqueId = `offline-ocr-${takeMessageId()}`;
            await db.putCachedMedia({
                fileUniqueId: uniqueId,
                data: Buffer.from('screenshot-bytes'),
                sizeBytes: 16,
                mime: 'image/png',
                kind: 'photo',
            });
            const messageId = await seedMessage({
                text: '这图里写了什么',
                fileUniqueId: uniqueId,
                ocrText: 'OCR-TEST-XYZ789',
            });
            const row = await Message.findOne({
                where: { chatId: OFFLINE_CHAT_ID, messageId },
            });
            if (!row) throw new Error('seeded message not found');

            const capabilities = {
                supportsImageInput: false,
                supportsImageOutput: false,
                supportsSystemPrompt: true,
                requiresMessageMerge: false,
                supportsThinking: false,
                supportsGrounding: false,
                supportsMediaInput: false,
            };

            const blind = await buildContext(row, capabilities);
            const blindTexts = blind.flatMap((message) =>
                message.content.filter((part) => part.type === 'text').map((part) => part.text ?? '')
            );
            expect(
                blind.every((message) => message.content.every((part) => part.type === 'text')),
                'the image itself is filtered out for a text-only model'
            );
            expect(
                blindTexts.some((text) => text.includes('OCR-TEST-XYZ789')),
                'the recognized text reaches the model'
            );
            expect(
                blindTexts.some((text) => text.includes('可能有错字')),
                'it is labelled as machine-recognized'
            );

            const seeing = await buildContext(row, {
                ...capabilities,
                supportsImageInput: true,
            });
            const seeingParts = seeing.flatMap((message) => message.content);
            expect(
                seeingParts.some((part) => part.type === 'image'),
                'a vision model still gets the image'
            );
            expect(
                !seeingParts.some((part) => (part.text ?? '').includes('OCR-TEST-XYZ789')),
                'and is not sent the OCR text on top of it'
            );
        },
    },
    {
        // A dropped ingest write is unrecoverable — the row is the only record
        // that the message ever existed — so the write is retried on a lock.
        name: 'a write that lost the lock race is retried instead of dropped',
        body: async () => {
            const { withBusyRetry } = await import('../../src/db/busy-retry.js');

            let attempts = 0;
            const outcome = await withBusyRetry(async () => {
                attempts += 1;
                if (attempts < 3) throw new Error('SQLITE_BUSY: database is locked');
                return 'stored';
            }, 'offline probe');
            expect(
                outcome === 'stored' && attempts === 3,
                `a busy write is retried until it lands (attempts: ${attempts})`
            );

            // What sequelize actually throws: a TimeoutError wrapping the cause
            let wrappedAttempts = 0;
            await withBusyRetry(async () => {
                wrappedAttempts += 1;
                if (wrappedAttempts < 2) {
                    throw new Error('SequelizeTimeoutError', {
                        cause: new Error('SQLITE_BUSY: database is locked'),
                    });
                }
                return null;
            }, 'offline probe');
            expect(wrappedAttempts === 2, 'SQLITE_BUSY wrapped as a cause is recognized too');

            let unrelatedAttempts = 0;
            const threw = await withBusyRetry(async () => {
                unrelatedAttempts += 1;
                throw new Error('NOT NULL constraint failed');
            }, 'offline probe').then(() => false, () => true);
            expect(
                threw && unrelatedAttempts === 1,
                'an unrelated error is thrown straight through, not retried'
            );
        },
    },
    {
        // The hole this repairs is exactly the one that made a reply to 1074051
        // arrive with no context at all.
        name: 'a reply target that was never stored is recovered from history',
        body: async () => {
            const { createServer } = await import('node:http');

            const requestedIds: string[] = [];
            const lostMessageId = takeMessageId();
            const server = createServer((request, response) => {
                const query = new URL(request.url ?? '', 'http://localhost').searchParams;
                const ids = query.get('ids') ?? '';
                requestedIds.push(ids);
                const messages = ids.split(',').includes(String(lostMessageId))
                    ? [{
                        id: lostMessageId,
                        sender_id: 777,
                        sender_name: 'ghost writer',
                        sender_is_bot: false,
                        text: 'the message that fell out of the database',
                        entities: [{ type: 'bold', offset: 4, length: 7 }],
                        reply_to: null,
                        date: lostMessageId,
                        media: { type: 'photo', mime: 'image/jpeg' },
                    }]
                    : [];
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ messages }));
            });
            await new Promise<void>((ready) => server.listen(BACKFILL_PORT, '127.0.0.1', ready));

            try {
                // A reply whose target has no row — the pre-backfill dead end
                const replyId = await seedMessage({ replyToId: lostMessageId, text: 'what is this' });

                const history = await queries.getRepliesHistory(OFFLINE_CHAT_ID, replyId);
                const historyIds = history.map((message) => message.messageId);
                expect(
                    historyIds.includes(lostMessageId),
                    `the lost message is back in the context (got ${JSON.stringify(historyIds)})`
                );

                const recovered = await Message.findOne({
                    where: { chatId: OFFLINE_CHAT_ID, messageId: lostMessageId },
                });
                expect(recovered !== null, 'and it is stored, not just returned once');
                expect(
                    recovered?.text === 'the **message** that fell out of the database',
                    `its formatting entities became markdown (got ${JSON.stringify(recovered?.text)})`
                );
                expect(
                    (recovered?.mediaHint ?? '').includes('no longer available'),
                    `the model is told the picture itself is gone (got ${JSON.stringify(recovered?.mediaHint)})`
                );
                expect(recovered?.userName === 'ghost writer', 'the original sender is preserved');

                const callsAfterRecovery = requestedIds.length;
                await queries.getRepliesHistory(OFFLINE_CHAT_ID, replyId);
                expect(
                    requestedIds.length === callsAfterRecovery,
                    'a second context build does not ask again for a message it now has'
                );

                // A permanently deleted target: asked once, then negative-cached
                const deletedId = takeMessageId();
                const orphanId = await seedMessage({ replyToId: deletedId });
                await queries.getRepliesHistory(OFFLINE_CHAT_ID, orphanId);
                const callsAfterFirstMiss = requestedIds.length;
                await queries.getRepliesHistory(OFFLINE_CHAT_ID, orphanId);
                expect(
                    requestedIds.length === callsAfterFirstMiss,
                    'an id that history no longer has is not asked for twice'
                );
            } finally {
                await new Promise<void>((closed) => server.close(() => closed()));
            }
        },
    },
    {
        name: '/pic parameters are parsed by the documented syntax',
        body: async () => {
            const { parsePicCommand } = await import(
                '../../src/reply/commands/pic-command-parser.js'
            );
            const parse = parsePicCommand;
            /** The spec, or a marker so a failed parse reads clearly in the message */
            const specOf = (text: string) => {
                const result = parse(text);
                return result.type === 'valid' ? result.spec : null;
            };

            expect(parse('随便一句话').type === 'none', 'ordinary text is not a pic command');
            expect(parse('/picture of a cat').type === 'none', 'a longer word is not /pic');
            expect(
                parse('/picbanana 一只猫').type === 'none' && parse('/picgpt 一只猫').type === 'none',
                'the LLM image commands are not swallowed by /pic'
            );
            expect(
                parse('/pic@AfterSchoolTeatimeBot 猫').type === 'valid',
                'the @form addressed to us is ours'
            );
            expect(
                parse('/pic@SomeOtherBot 猫').type === 'none',
                'a command addressed to another bot is left alone'
            );

            expect(specOf('/pic 一只猫')?.spoiler === true, '/pic masks the result');
            expect(specOf('/picunsafe 一只猫')?.spoiler === false, '/picunsafe does not');
            expect(
                specOf('/picunsafe 一只猫')?.prompt === '一只猫',
                'and both read the same prompt'
            );
            expect(specOf('/pic')?.prompt === '', 'a bare /pic parses with an empty prompt');

            const withFlags = specOf('/pic -steps=20 -seed=42 -size=1344x768 屋顶上的猫');
            expect(
                withFlags?.options.steps === 20 && withFlags.options.seed === 42,
                `leading flags become options (got ${JSON.stringify(withFlags?.options)})`
            );
            expect(
                withFlags?.options.width === 1344 && withFlags.options.height === 768,
                '-size= splits into width and height'
            );
            expect(withFlags?.prompt === '屋顶上的猫', 'and the rest is the prompt');

            expect(specOf('/pic -w=flux2 猫')?.workflowQuery === 'flux2', '-w= is kept aside');
            expect(
                specOf('/pic -w=flux2 猫')?.options.w === undefined,
                'and does not leak into the options'
            );

            // A prompt is free text: hyphens in it must not be read as flags
            expect(
                specOf('/pic 一只 anime-style 的猫')?.prompt === '一只 anime-style 的猫',
                'a hyphen inside the prompt is left alone'
            );
            expect(
                specOf('/pic -这不是参数 猫')?.prompt === '-这不是参数 猫',
                'parsing stops at the first token that is not -key=value'
            );

            const negative = specOf('/pic 一只猫 -: 模糊, 多手指');
            expect(
                negative?.prompt === '一只猫' && negative.negativePrompt === '模糊, 多手指',
                `-: splits off the negative prompt (got ${JSON.stringify(negative)})`
            );
            expect(negative?.negativePromptOverride === false, 'and -: does not override');
            expect(
                specOf('/pic 一只猫 -!: 模糊')?.negativePromptOverride === true,
                'while -!: does'
            );

            for (const bad of ['/pic -steps=abc 猫', '/pic -n=9 猫', '/pic -size=10x10 猫', '/pic -ar=tall 猫', '/pic -zzz=1 猫']) {
                const result = parse(bad);
                expect(result.type === 'invalid', `\`${bad}\` is rejected with a reason`);
            }
        },
    },
    {
        name: 'the pic workflow follows the reference image',
        body: async () => {
            const { buildGenerationRequest } = await import(
                '../../src/reply/commands/pic-request-builder.js'
            );
            const { parsePicCommand } = await import(
                '../../src/reply/commands/pic-command-parser.js'
            );

            const workflows = [
                {
                    id: 'z-image-turbo',
                    name: 'Z-Image Turbo 文生图',
                    kind: 'text-to-image',
                    input_image_required: false,
                    default_options: {},
                },
                {
                    id: 'flux2-klein-9b-base-edit',
                    name: 'FLUX.2 Klein 9B',
                    kind: 'image-edit',
                    input_image_required: true,
                    default_options: {},
                },
            ];

            const build = (text: string, referenceImages: string[] = []) => {
                const parsed = parsePicCommand(text);
                if (parsed.type !== 'valid') throw new Error(`\`${text}\` did not parse`);
                return buildGenerationRequest({ spec: parsed.spec, workflows, referenceImages });
            };

            const plain = build('/pic 一只猫');
            expect(
                plain.ok && plain.request.workflow === 'z-image-turbo',
                'no reference image → the text-to-image workflow'
            );
            expect(
                plain.ok && plain.request.input_image === undefined,
                'and nothing is sent as input_image'
            );
            expect(
                plain.ok && typeof plain.request.options?.seed === 'number',
                'a seed is always sent, so the caption is reproducible'
            );

            const edited = build('/pic 改成夜景', ['QUJD']);
            expect(
                edited.ok && edited.request.workflow === 'flux2-klein-9b-base-edit',
                'a reference image → the image-edit workflow, no command change needed'
            );
            expect(
                edited.ok && edited.request.input_image?.data === 'QUJD',
                'and it rides along as input_image'
            );

            const twoImages = build('/pic 改成夜景', ['QUJD', 'RUZH']);
            expect(
                twoImages.ok && twoImages.extraReferenceImages === 1,
                'the caller is told when extra images were ignored (the API takes one)'
            );

            const forced = build('/pic -w=z-image 一只猫', ['QUJD']);
            expect(
                forced.ok && forced.request.workflow === 'z-image-turbo',
                '-w= overrides the automatic choice, by unique id prefix'
            );

            const missingImage = build('/pic -w=flux2 一只猫');
            expect(
                !missingImage.ok && missingImage.reason.includes('参考图'),
                'an image-edit workflow without an image is refused before any request'
            );

            const unknown = build('/pic -w=nope 一只猫');
            expect(
                !unknown.ok && unknown.reason.includes('nope'),
                'an unknown -w= names what is actually available'
            );

            const noPrompt = build('/pic -steps=20');
            expect(!noPrompt.ok, 'an empty prompt is refused (the API requires one)');

            // 20 MiB decoded is the documented cap; 4 base64 chars = 3 bytes
            const oversized = build('/pic 改成夜景', ['A'.repeat(28 * 1024 * 1024)]);
            expect(
                !oversized.ok && oversized.reason.includes('20 MiB'),
                'an oversized reference image is refused locally, not by a 413'
            );

            const negative = build('/pic 一只猫 -!: 模糊');
            expect(
                negative.ok && negative.request.negative_prompt_override === true,
                '-!: reaches the request as negative_prompt_override'
            );
        },
    },
    {
        // The whole async path the old synchronous /generate could not survive.
        name: 'a pic job is submitted, polled and delivered',
        body: async () => {
            const { createServer } = await import('node:http');
            const { forgetWorkflows } = await import('../../src/services/comfy-forward-service.js');
            const { runGeneration } = await import(
                '../../src/reply/commands/pic-generation-runner.js'
            );
            const { forgetAllJobs } = await import('../../src/reply/commands/pic-job-store.js');

            const PNG_BYTES = Buffer.from('89504e470d0a1a0a', 'hex');
            const pollPaths: string[] = [];
            let submittedBody: Record<string, unknown> = {};
            /** Statuses handed out in order, so the poller sees a real transition */
            let statuses = ['running', 'succeeded'];

            const server = createServer((request, response) => {
                const path = request.url ?? '';
                const json = (body: unknown, status = 200): void => {
                    response.writeHead(status, { 'Content-Type': 'application/json' });
                    response.end(JSON.stringify(body));
                };

                if (path === '/health') {
                    json({ status: 'ok', comfyui: 'available', queue: { running: 0, pending: 0 } });
                    return;
                }
                if (path === '/v1/workflows') {
                    json({
                        success: true,
                        workflows: [{
                            id: 'z-image-turbo',
                            name: 'Z-Image Turbo 文生图',
                            kind: 'text-to-image',
                            input_image_required: false,
                            default_options: {},
                        }],
                    });
                    return;
                }
                if (path === '/v1/generations' && request.method === 'POST') {
                    const chunks: Buffer[] = [];
                    request.on('data', (chunk: Buffer) => chunks.push(chunk));
                    request.on('end', () => {
                        submittedBody = JSON.parse(Buffer.concat(chunks).toString());
                        json({ success: true, id: 'job-1', status: 'queued' }, 202);
                    });
                    return;
                }
                if (path === '/v1/generations/job-1/images/0') {
                    response.writeHead(200, { 'Content-Type': 'image/png' });
                    response.end(PNG_BYTES);
                    return;
                }
                if (path === '/v1/generations/job-1') {
                    pollPaths.push(path);
                    const status = statuses.shift() ?? 'succeeded';
                    json({
                        success: true,
                        id: 'job-1',
                        status,
                        images: status === 'succeeded'
                            ? [{ index: 0, filename: 'out.png', url: '/v1/generations/job-1/images/0' }]
                            : [],
                        error: status === 'failed' ? 'CUDA out of memory' : undefined,
                    });
                    return;
                }
                json({ error: 'not found' }, 404);
            });
            await new Promise<void>((ready) => server.listen(COMFY_PORT, '127.0.0.1', ready));

            // The runner only touches these methods; a real grammy Api needs a
            // bot token and a network, so a stub stands in for it.
            interface SentPhoto { spoiler: boolean; caption: string; hasButton: boolean }
            const sentPhotos: SentPhoto[] = [];
            const editedTexts: string[] = [];
            const deletedIds: number[] = [];
            let photoMessageId = 0;

            const makeApi = () => ({
                sendMessage: async () => ({ message_id: takeMessageId() }),
                editMessageText: async (_chatId: number, _messageId: number, text: string) => {
                    editedTexts.push(text);
                    return true;
                },
                editMessageReplyMarkup: async () => true,
                deleteMessage: async (_chatId: number, messageId: number) => {
                    deletedIds.push(messageId);
                    return true;
                },
                sendPhoto: async (
                    _chatId: number,
                    _photo: unknown,
                    other: { has_spoiler?: boolean; caption?: string; reply_markup?: unknown }
                ) => {
                    sentPhotos.push({
                        spoiler: Boolean(other.has_spoiler),
                        caption: other.caption ?? '',
                        hasButton: Boolean(other.reply_markup),
                    });
                    photoMessageId = takeMessageId();
                    return { message_id: photoMessageId };
                },
            });

            try {
                forgetWorkflows();
                forgetAllJobs();
                const userMessageId = await seedMessage({ text: '/pic 一只猫' });

                await runGeneration({
                    api: makeApi() as unknown as Parameters<typeof runGeneration>[0]['api'],
                    chatId: OFFLINE_CHAT_ID,
                    userMessageId,
                    request: {
                        workflow: 'z-image-turbo',
                        prompt: '一只猫',
                        options: { seed: 4242 },
                    },
                    spoiler: true,
                    workflowName: 'Z-Image Turbo 文生图',
                });

                expect(
                    submittedBody.workflow === 'z-image-turbo' && submittedBody.prompt === '一只猫',
                    `the job is submitted with the request body (got ${JSON.stringify(submittedBody)})`
                );
                expect(pollPaths.length >= 2, `the job is polled until it settles (${pollPaths.length} polls)`);
                expect(
                    editedTexts.some((text) => text.includes('生成中')),
                    `the placeholder reports progress (got ${JSON.stringify(editedTexts)})`
                );
                expect(sentPhotos.length === 1, 'one picture is sent');
                expect(sentPhotos[0]?.spoiler === true, 'and /pic masked it');
                expect(
                    sentPhotos[0]?.caption.includes('seed 4242'),
                    `the caption carries the seed (got ${JSON.stringify(sentPhotos[0]?.caption)})`
                );
                expect(sentPhotos[0]?.hasButton === true, 'with a 🎲 reroll button on it');
                expect(deletedIds.length === 1, 'and the placeholder is cleaned up');

                const stored = await Message.findOne({
                    where: { chatId: OFFLINE_CHAT_ID, messageId: photoMessageId },
                });
                expect(
                    stored?.file?.equals(PNG_BYTES) === true,
                    'the picture is stored, so the next /pic can use it as a reference'
                );

                // A backend failure has to reach the user, not just the log
                statuses = ['failed'];
                editedTexts.length = 0;
                await runGeneration({
                    api: makeApi() as unknown as Parameters<typeof runGeneration>[0]['api'],
                    chatId: OFFLINE_CHAT_ID,
                    userMessageId,
                    request: { workflow: 'z-image-turbo', prompt: '一只猫', options: {} },
                    spoiler: true,
                    workflowName: 'Z-Image Turbo 文生图',
                });
                expect(
                    editedTexts.some((text) => text.includes('CUDA out of memory')),
                    `a failed job reports why (got ${JSON.stringify(editedTexts)})`
                );
            } finally {
                await new Promise<void>((closed) => server.close(() => closed()));
                forgetWorkflows();
            }
        },
    },
    {
        // Deletes everything seeded above (the seeds carry 1970-era dates), so
        // this case has to stay last.
        name: 'the hourly cleanup deletes expired rows in batches and spares fresh ones',
        body: async () => {
            const { clearExpiredData } = await import('../../src/db/autoSave.js');

            // More than one batch worth (CLEANUP_BATCH_SIZE is 50)
            const expiredIds: number[] = [];
            for (let index = 0; index < 120; index += 1) {
                expiredIds.push(await seedMessage());
            }
            const freshId = takeMessageId();
            await Message.create({
                chatId: OFFLINE_CHAT_ID,
                messageId: freshId,
                fromBotSelf: false,
                date: new Date(),
                userName: 'tester',
                text: 'still within the retention window',
                quoteText: null,
                file: null,
                fileMime: null,
                fileUniqueId: null,
                replyToId: null,
                chatCommand: null,
                modelParts: null,
                mediaHint: null,
                forwardOrigin: null,
                ocrText: null,
            });

            await clearExpiredData();

            const survivors = await Message.findAll({ where: { chatId: OFFLINE_CHAT_ID } });
            const survivingIds = survivors.map((row) => row.messageId);
            expect(
                survivingIds.includes(freshId),
                'a message inside the retention window is kept'
            );
            expect(
                !expiredIds.some((id) => survivingIds.includes(id)),
                `all ${expiredIds.length} expired messages are gone, batching and all`
            );
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
reportResults(results);
