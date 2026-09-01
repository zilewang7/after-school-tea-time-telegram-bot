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

/** The comfy-forward stub the /pic and /vid cases run against */
const COMFY_PORT = 9138;

/** The xAI-shaped stub the storyboard case runs against */
const GROK_PORT = 9139;

// The /chat and /pic parsers decide whether `/cmd@Name` is addressed to us
process.env.BOT_USER_NAME = 'AfterSchoolTeatimeBot';
process.env.LUOXU_PREVIEW_URL = `http://127.0.0.1:${BACKFILL_PORT}`;
process.env.COMFY_FORWARD_URL = `http://127.0.0.1:${COMFY_PORT}`;
process.env.GROK_API_URL = `http://127.0.0.1:${GROK_PORT}/v1`;
process.env.GROK_API_KEY = 'offline-stub';
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
    userId?: number | null;
    viaBot?: string | null;
    ocrText?: string | null;
    forwardOrigin?: string | null;
    forwardFromId?: number | null;
}

/** Insert one message row directly, bypassing the Telegram-facing save path */
const seedMessage = async (options: SeedOptions = {}): Promise<number> => {
    const messageId = options.messageId ?? takeMessageId();
    await Message.create({
        chatId: OFFLINE_CHAT_ID,
        messageId,
        fromBotSelf: options.fromBotSelf ?? false,
        userId: options.userId ?? null,
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
        forwardOrigin: options.forwardOrigin ?? null,
        forwardFromId: options.forwardFromId ?? null,
        viaBot: options.viaBot ?? null,
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
                const { messages: turns } = await buildContext(row);
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

            const { buildSystemPrompt } = await import('../../src/ai/system-prompt/index.js');
            // gemini sees images, mimo-pro does not — the OCR note must follow
            const visionPrompt = buildSystemPrompt('gemini-3.1-pro-preview');
            const blindPrompt = buildSystemPrompt('mimo-v2.5-pro');
            rmSync(promptPath, { force: true });
            process.env.BOT_USER_NAME = ownUserName;

            expect(
                visionPrompt.includes('@WatchFirstBot') && visionPrompt.includes('你的用户名是 Test-KON'),
                `the running bot's own identity is substituted (got ${JSON.stringify(visionPrompt.slice(0, 200))})`
            );
            expect(
                !visionPrompt.includes('{{BOT_USER_NAME}}') && !visionPrompt.includes('{{BOT_NAME}}'),
                'no placeholder is left behind'
            );
            expect(
                visionPrompt.includes('{{UNKNOWN_VAR}}'),
                'a variable outside the allowlist is left verbatim rather than silently dropped'
            );
            expect(
                /当前时间：\d{4}\/\d{2}\/\d{2} \d{2}:\d{2} 周./.test(visionPrompt),
                `the current time is injected as YYYY/MM/DD HH:mm 周X (got ${JSON.stringify(visionPrompt.match(/当前时间：[^\n]*/)?.[0])})`
            );
            expect(
                visionPrompt.includes('当前模型：gemini-3.1-pro-preview') &&
                    blindPrompt.includes('当前模型：mimo-v2.5-pro'),
                'the current model id is injected'
            );
            expect(
                visionPrompt.includes('# 你收到的消息格式') && visionPrompt.includes('<<EOF'),
                'the built-in format protocol section is appended'
            );
            expect(
                !visionPrompt.includes('OCR') && blindPrompt.includes('OCR'),
                'the OCR fallback note is injected only for models that cannot see images'
            );
        },
    },
    {
        // Inline-mode messages carry the sending bot in a header annotation, so
        // the model knows the content came out of that bot's results.
        name: 'a via-bot message is annotated in the header',
        body: async () => {
            const { buildContext } = await import('../../src/reply/context-builder.js');

            const messageId = await seedMessage({ text: '看这个', viaBot: '@gif' });
            const row = await Message.findOne({
                where: { chatId: OFFLINE_CHAT_ID, messageId },
            });
            if (!row) throw new Error('seeded message not found');

            const { messages: context } = await buildContext(row, {
                supportsImageInput: true,
                supportsImageOutput: false,
                supportsSystemPrompt: true,
                requiresMessageMerge: false,
                supportsThinking: false,
                supportsGrounding: false,
                supportsMediaInput: false,
            });
            const texts = context.flatMap((message) =>
                message.content.filter((part) => part.type === 'text').map((part) => part.text ?? '')
            );
            expect(
                texts.some((text) => text.includes('[via inline bot @gif]')),
                `the header carries the inline bot (got ${JSON.stringify(texts)})`
            );
        },
    },
    {
        // The roster feeds the system prompt: authors carry their id/@username
        // from telegram_users, mentioned users are resolved out of the text
        // (both tg://user links and plain @handles), the bot stays out.
        name: 'the context user roster resolves authors and mentions',
        body: async () => {
            const { TelegramUser } = await import('../../src/db/telegramUserDTO.js');
            const { buildContext } = await import('../../src/reply/context-builder.js');
            const { buildSystemPrompt } = await import('../../src/ai/system-prompt/index.js');

            const now = new Date();
            await TelegramUser.upsert({ userId: 1001, username: 'alice_a', firstName: 'Alice', lastName: null, updatedAt: now });
            await TelegramUser.upsert({ userId: 1002, username: null, firstName: '李四', lastName: null, updatedAt: now });
            await TelegramUser.upsert({ userId: 1003, username: 'carol_c', firstName: 'Carol', lastName: null, updatedAt: now });
            await TelegramUser.upsert({ userId: 1004, username: 'dave_d', firstName: 'Dave', lastName: null, updatedAt: now });
            await TelegramUser.upsert({ userId: 1005, username: 'helper_bot', firstName: 'Helper', lastName: null, isBot: true, updatedAt: now });

            const first = await seedMessage({
                text: '问问 @carol_c 和 @helper_bot 还有 [李四](tg://user?id=1002)，邮箱 someone@example.com 别管',
                userId: 1001,
                userName: 'Alice',
            });
            await seedMessage({ text: '我插一句', fromBotSelf: true, replyToId: first });
            await seedMessage({
                text: '这条是转来的',
                userId: 1001,
                userName: 'Alice',
                replyToId: first,
                forwardOrigin: 'user Dave',
                forwardFromId: 1004,
            });
            const messageId = await seedMessage({
                text: '好',
                userId: 9999,
                userName: '路人',
                replyToId: first,
            });
            const row = await Message.findOne({
                where: { chatId: OFFLINE_CHAT_ID, messageId },
            });
            if (!row) throw new Error('seeded message not found');

            const { contextUsers } = await buildContext(row, {
                supportsImageInput: true,
                supportsImageOutput: false,
                supportsSystemPrompt: true,
                requiresMessageMerge: false,
                supportsThinking: false,
                supportsGrounding: false,
                supportsMediaInput: false,
            });

            const alice = contextUsers.find((user) => user.userId === 1001);
            expect(
                alice?.username === 'alice_a' && alice.mentionedOnly === false,
                `the author is resolved against the roster table (got ${JSON.stringify(contextUsers)})`
            );
            const passerby = contextUsers.find((user) => user.userId === 9999);
            expect(
                passerby?.firstName === '路人' && passerby.username === undefined,
                'an author without a roster row falls back to the stored first name'
            );
            const lisi = contextUsers.find((user) => user.userId === 1002);
            expect(
                lisi?.mentionedOnly === true && lisi.username === undefined,
                'a tg://user mention is collected with its id'
            );
            const carol = contextUsers.find((user) => user.userId === 1003);
            expect(
                carol?.mentionedOnly === true && carol.username === 'carol_c',
                'a plain @handle mention resolves through the roster table'
            );
            const dave = contextUsers.find((user) => user.userId === 1004);
            expect(
                dave?.mentionedOnly === true && dave.username === 'dave_d',
                'the original sender of a forwarded message joins the roster'
            );
            const helperBot = contextUsers.find((user) => user.userId === 1005);
            expect(
                helperBot?.isBot === true,
                `a mentioned bot carries its is_bot flag (got ${JSON.stringify(helperBot)})`
            );
            expect(
                !contextUsers.some((user) => user.username === 'example'),
                'an email address is not mistaken for a mention'
            );
            expect(
                contextUsers.every((user) => user.userId !== undefined || user.username !== undefined),
                'no information-free entries'
            );

            const prompt = buildSystemPrompt('gemini-3.1-pro-preview', { contextUsers });
            expect(
                prompt.includes('# 上下文中的用户') &&
                    prompt.includes('- Alice：id 1001，@alice_a') &&
                    prompt.includes('无需再 @ 它的作者') &&
                    prompt.includes('优先写 `[名字](tg://user?id=数字)`'),
                `the roster section lands in the system prompt (got ${JSON.stringify(prompt.match(/# 上下文中的用户[\s\S]*?(?=\n\n# )/)?.[0])})`
            );
            const botBlockStart = prompt.indexOf('以下是 bot 账号');
            expect(
                botBlockStart > 0 &&
                    prompt.indexOf('- Helper：id 1005，@helper_bot') > botBlockStart &&
                    prompt.indexOf('- Alice：id 1001，@alice_a') < botBlockStart,
                'bots are listed apart from humans'
            );
            expect(
                !buildSystemPrompt('gemini-3.1-pro-preview').includes('# 上下文中的用户'),
                'no roster, no section'
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

            const { messages: blind } = await buildContext(row, capabilities);
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

            const { messages: seeing } = await buildContext(row, {
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
                // The same list carries video workflows since 2.3.0
                {
                    id: 'minimax-h3-turbo',
                    name: 'MiniMax H3 Turbo 文生视频',
                    kind: 'text-to-video',
                    input_image_required: false,
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

            const videoWorkflow = build('/pic -w=minimax 一只猫');
            expect(
                !videoWorkflow.ok && videoWorkflow.reason.includes('/vid'),
                `pointing -w= at a video workflow says which command to use (got ${videoWorkflow.ok ? 'ok' : videoWorkflow.reason})`
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
                '../../src/reply/commands/generation-runner.js'
            );
            const { forgetAllJobs } = await import('../../src/reply/commands/generation-job-store.js');

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
                    kind: 'image',
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
                    kind: 'image',
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
        name: '/vid parameters are parsed by the documented syntax',
        body: async () => {
            const { parseVidCommand } = await import(
                '../../src/reply/commands/vid-command-parser.js'
            );
            const parse = parseVidCommand;
            const specOf = (text: string) => {
                const parsed = parse(text);
                return parsed.type === 'valid' ? parsed.spec : null;
            };

            expect(parse('随便一句话').type === 'none', 'ordinary text is not a vid command');
            expect(parse('/video of a cat').type === 'none', 'a longer word is not /vid');
            expect(
                parse('/vid@AfterSchoolTeatimeBot 猫').type === 'valid',
                'the @BotName form is ours'
            );
            expect(
                parse('/vid@SomeOtherBot 猫').type === 'none',
                'a command addressed to another bot is not ours to answer'
            );

            expect(specOf('/vid 一只猫')?.spoiler === true, '/vid masks the result');
            expect(specOf('/vidunsafe 一只猫')?.spoiler === false, '/vidunsafe does not');
            expect(specOf('/vid')?.brief === '', 'a bare /vid parses with an empty brief');

            const flagged = specOf('/vid -d=8 -ar=9:16 -seed=7 -ref=max 雨夜的电车');
            expect(
                flagged?.options.duration_seconds === 8 &&
                    flagged?.options.aspect_ratio === '9:16' &&
                    flagged?.options.seed === 7 &&
                    flagged?.options.ref_image_size === 'max',
                `the H3 flags land in options (got ${JSON.stringify(flagged?.options)})`
            );
            expect(flagged?.brief === '雨夜的电车', 'and everything after them is the brief');

            const steering = specOf('/vid -w=h3 -mode=i2va -shots=3 -raw=1 已经写好的分镜');
            expect(
                steering?.workflowQuery === 'h3' &&
                    steering?.mode === 'i2va' &&
                    steering?.shots === 3 &&
                    steering?.raw === true,
                `the steering flags stay out of options (got ${JSON.stringify(steering)})`
            );
            expect(
                Object.keys(steering?.options ?? {}).length === 0,
                'none of them are sent to the API'
            );

            expect(
                specOf('/vid -size=608x352 街景')?.options.width === 608,
                '-size= splits into width/height'
            );
            expect(
                specOf('/vid -lowvram=1 街景')?.options.low_vram === true,
                '-lowvram= is a boolean option'
            );

            // A flag written after the idea used to be swallowed into the brief:
            // the request went out with the default ratio and nothing said so
            const trailing = specOf('/vid 雨夜的电车 -ar=9:16 -d=8');
            expect(
                trailing?.options.aspect_ratio === '9:16' && trailing?.options.duration_seconds === 8,
                `flags after the idea count too (got ${JSON.stringify(trailing?.options)})`
            );
            expect(trailing?.brief === '雨夜的电车', 'and they are taken back out of the brief');

            const surrounded = specOf('/vid -d=8 街头 -ar=1:1 的电车');
            expect(
                surrounded?.options.aspect_ratio === '1:1' && surrounded?.brief === '街头 的电车',
                `a flag mid-sentence is lifted out (got ${JSON.stringify(surrounded)})`
            );

            const multiline = specOf('/vid -ar=1:1 第一行\n第二行');
            expect(multiline?.brief === '第一行\n第二行', 'a multi-line brief keeps its line breaks');

            expect(
                specOf('/vid 一只 close-up 的猫 -ar=1:1')?.brief === '一只 close-up 的猫',
                'a hyphen inside a word is not a flag'
            );
            expect(
                specOf('/vid 一只猫 -zzz=1')?.brief === '一只猫 -zzz=1',
                'an unknown flag after the idea is just text the user wrote'
            );

            const spaced = parse('/vid -ar 9:16 一只猫');
            expect(
                spaced.type === 'invalid' && spaced.reason.includes('-ar='),
                `a known flag without its = is named, not silently ignored (got ${JSON.stringify(spaced)})`
            );

            // H3 takes no negative prompt, but /pic habits die hard
            const negative = specOf('/vid 一只猫 -: 模糊');
            expect(
                negative?.negativeIgnored === true && negative?.brief === '一只猫',
                `-: is stripped off the brief and flagged (got ${JSON.stringify(negative)})`
            );

            // The API takes any 宽:高 in 1:4…4:1 now, so only the shape is ours to check
            expect(
                specOf('/vid -ar=2.39:1 猫')?.options.aspect_ratio === '2.39:1',
                'a decimal ratio is passed straight through'
            );
            expect(
                specOf('/vid -ar=16x9 猫')?.options.aspect_ratio === '16:9',
                'a ratio written with x is normalised to the API spelling'
            );

            for (const bad of [
                '/vid -d=99 猫',
                '/vid -ar=5:1 猫',
                '/vid -ar=1:5 猫',
                '/vid -ar=16:9:2 猫',
                '/vid -size=600x352 猫',
                '/vid -mode=nope 猫',
                '/vid -shots=9 猫',
                '/vid -ref=huge 猫',
                '/vid -zzz=1 猫',
            ]) {
                expect(parse(bad).type === 'invalid', `${bad} is rejected with an explanation`);
            }
        },
    },
    {
        name: 'a single reference picture decides the video shape',
        body: async () => {
            const { readImageSize } = await import('../../src/shared/image-size.js');
            const { formatAspectRatio } = await import(
                '../../src/reply/commands/aspect-ratio.js'
            );
            const { planVideoGeneration } = await import(
                '../../src/reply/commands/vid-request-builder.js'
            );
            const { parseVidCommand } = await import(
                '../../src/reply/commands/vid-command-parser.js'
            );

            /** A PNG is its signature, then IHDR carrying the two dimensions */
            const pngOf = (width: number, height: number): string => {
                const header = Buffer.alloc(24);
                Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
                header.writeUInt32BE(13, 8);
                header.write('IHDR', 12, 'ascii');
                header.writeUInt32BE(width, 16);
                header.writeUInt32BE(height, 20);
                return header.toString('base64');
            };
            /** SOI, a stray segment to walk past, then SOF0 with height before width */
            const jpegOf = (width: number, height: number): string => {
                const segment = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
                const sof = Buffer.alloc(11);
                sof.writeUInt16BE(0xffc0, 0);
                sof.writeUInt16BE(8, 2);
                sof.writeUInt8(8, 4);
                sof.writeUInt16BE(height, 5);
                sof.writeUInt16BE(width, 7);
                return Buffer.concat([Buffer.from([0xff, 0xd8]), segment, sof]).toString('base64');
            };

            expect(
                JSON.stringify(readImageSize(pngOf(1080, 2400))) === '{"width":1080,"height":2400}',
                `a PNG header is read (got ${JSON.stringify(readImageSize(pngOf(1080, 2400)))})`
            );
            expect(
                JSON.stringify(readImageSize(jpegOf(1600, 900))) === '{"width":1600,"height":900}',
                `a JPEG frame marker is found after other segments (got ${JSON.stringify(readImageSize(jpegOf(1600, 900)))})`
            );
            expect(readImageSize('QUJD') === null, 'and something that is not an image says so');

            expect(
                formatAspectRatio(1080, 2400) === '9:20',
                `a phone screenshot keeps its own shape (got ${formatAspectRatio(1080, 2400)})`
            );
            expect(
                formatAspectRatio(1920, 1080) === '16:9',
                `and a familiar shape is spelled the familiar way (got ${formatAspectRatio(1920, 1080)})`
            );
            expect(
                formatAspectRatio(1000, 1010) === '1:1',
                `a near-square picture snaps to 1:1 (got ${formatAspectRatio(1000, 1010)})`
            );
            expect(
                formatAspectRatio(3440, 1440) === '2.39:1',
                `an ultrawide monitor is cinema scope (got ${formatAspectRatio(3440, 1440)})`
            );
            expect(
                formatAspectRatio(1284, 2778) === '1:2.16',
                `a ratio that reduces to nothing readable becomes decimal (got ${formatAspectRatio(1284, 2778)})`
            );
            expect(
                formatAspectRatio(6000, 1000) === '4:1',
                `and a panorama is clamped to the widest the server takes (got ${formatAspectRatio(6000, 1000)})`
            );

            const workflows = [
                {
                    id: 'minimax-h3-turbo',
                    name: 'turbo',
                    kind: 'text-to-video',
                    input_image_required: false,
                    accepted_inputs: ['input_image'],
                    default_options: { steps: 6, lora_strength: 1 },
                },
                {
                    id: 'minimax-h3-i2v',
                    name: 'i2v',
                    kind: 'image-to-video',
                    input_image_required: true,
                    accepted_inputs: ['first_frame', 'last_frame', 'input_image'],
                    default_options: { steps: 6, lora_strength: 1 },
                },
                {
                    id: 'minimax-h3-ref2v',
                    name: 'ref2v',
                    kind: 'reference-to-video',
                    input_image_required: false,
                    accepted_inputs: ['input_image', 'reference_images'],
                    default_options: { steps: 6, lora_strength: 1 },
                },
            ];
            const planOf = (text: string, referenceImages: string[]) => {
                const parsed = parseVidCommand(text);
                if (parsed.type !== 'valid') throw new Error(`unparsable: ${text}`);
                const result = planVideoGeneration({ spec: parsed.spec, workflows, referenceImages });
                return result.ok ? result.plan : null;
            };

            const portrait = planOf('/vid 唯从图片里跳出来', [pngOf(1080, 2400)]);
            expect(
                portrait?.aspectRatio === '9:20' && portrait?.aspectRatioFromImage === true,
                `a portrait screenshot makes a portrait video (got ${portrait?.aspectRatio})`
            );
            expect(portrait?.sendAspectRatio === true, 'and the ratio is actually sent');

            expect(
                planOf('/vid -ar=16:9 唯', [pngOf(1080, 2400)])?.aspectRatio === '16:9',
                'an explicit -ar= still wins over the picture'
            );
            expect(
                planOf('/vid 唯', [pngOf(1080, 2400), pngOf(1080, 2400)])?.aspectRatio === '16:9',
                'with several pictures there is no single shape to follow'
            );
            expect(
                planOf('/vid 唯', [])?.aspectRatio === '16:9',
                'and text-only keeps the documented default'
            );

            const anchored = planOf('/vid -mode=i2va 唯', [pngOf(1080, 2400)]);
            expect(
                anchored?.sendAspectRatio === false,
                'frame anchoring sends no ratio at all — the backend follows the first frame exactly'
            );
        },
    },
    {
        name: 'the video plan picks the workflow and the H3 input mode',
        body: async () => {
            const { planVideoGeneration, buildVideoRequest, resolveVidMode } = await import(
                '../../src/reply/commands/vid-request-builder.js'
            );
            const { parseVidCommand } = await import(
                '../../src/reply/commands/vid-command-parser.js'
            );

            // The 2.3.0 workflow list, verbatim in the parts that matter
            const workflows = [
                {
                    id: 'z-image-turbo',
                    name: '文生图',
                    kind: 'text-to-image',
                    input_image_required: false,
                    accepted_inputs: [],
                    default_options: {},
                },
                // Its id says "base" too, which is what made `-w=base` ambiguous
                {
                    id: 'flux2-klein-9b-base-edit',
                    name: 'FLUX.2 图像编辑',
                    kind: 'image-edit',
                    input_image_required: true,
                    accepted_inputs: ['input_image'],
                    default_options: {},
                },
                {
                    id: 'minimax-h3-turbo',
                    name: 'MiniMax H3 Turbo 文生视频 / 单图参考',
                    kind: 'text-to-video',
                    input_image_required: false,
                    accepted_inputs: ['input_image'],
                    default_options: { steps: 6, lora_strength: 1 },
                },
                {
                    id: 'minimax-h3-i2v',
                    name: 'MiniMax H3 Turbo 首尾帧图生视频',
                    kind: 'image-to-video',
                    input_image_required: true,
                    accepted_inputs: ['first_frame', 'last_frame', 'input_image'],
                    default_options: { steps: 6, lora_strength: 1 },
                },
                {
                    id: 'minimax-h3-ref2v',
                    name: 'MiniMax H3 Turbo 多素材参考视频',
                    kind: 'reference-to-video',
                    input_image_required: false,
                    accepted_inputs: [
                        'input_image', 'reference_images', 'reference_videos', 'reference_audios',
                    ],
                    default_options: { steps: 6, lora_strength: 1 },
                },
                {
                    id: 'minimax-h3-base',
                    name: 'MiniMax H3 Base 24 步质量模式',
                    kind: 'text-to-video',
                    input_image_required: false,
                    accepted_inputs: [
                        'input_image', 'first_frame', 'last_frame',
                        'reference_images', 'reference_videos', 'reference_audios',
                    ],
                    default_options: { steps: 24, sampler_name: 'res_multistep' },
                },
            ];
            const workflowById = (id: string) =>
                workflows.find((workflow) => workflow.id === id)!;

            const plan = (text: string, referenceImages: string[] = []) => {
                const parsed = parseVidCommand(text);
                if (parsed.type !== 'valid') throw new Error(`unparsable: ${text}`);
                return {
                    spec: parsed.spec,
                    result: planVideoGeneration({ spec: parsed.spec, workflows, referenceImages }),
                };
            };

            const plain = plan('/vid 雨夜的电车');
            expect(
                plain.result.ok && plain.result.plan.workflow.id === 'minimax-h3-turbo',
                'without -w= the Turbo workflow wins over the 24-step quality one'
            );
            expect(
                plain.result.ok && plain.result.plan.mode === 't2va',
                'no reference image means text-to-video'
            );
            expect(
                plain.result.ok &&
                    plain.result.plan.durationSeconds === 5 &&
                    plain.result.plan.aspectRatio === '16:9',
                'and the documented defaults are made explicit'
            );

            const referenced = plan('/vid 让她转过身来', ['QUJD']);
            expect(
                referenced.result.ok && referenced.result.plan.mode === 'ref2va',
                'one image on the Turbo workflow is a reference, not a first frame'
            );
            expect(
                referenced.result.ok && referenced.result.plan.workflow.id === 'minimax-h3-turbo',
                'and one image does not need the multi-asset workflow'
            );

            expect(
                resolveVidMode('auto', workflowById('minimax-h3-i2v'), 1) === 'i2va' &&
                    resolveVidMode('auto', workflowById('minimax-h3-i2v'), 2) === 'fl2va' &&
                    resolveVidMode('t2va', workflowById('minimax-h3-i2v'), 1) === 't2va',
                'a frame-anchoring workflow means i2va/fl2va, and -mode= always wins'
            );
            expect(
                resolveVidMode('auto', workflowById('minimax-h3-base'), 2) === 'ref2va',
                'a workflow that does both defaults to referencing, never to locking frames'
            );

            // -mode= is the conditioning axis: asking for it picks the workflow
            // that can do it, without the user naming one
            const anchored = plan('/vid -mode=i2va 镜头缓缓推进', ['QUJD']);
            expect(
                anchored.result.ok && anchored.result.plan.workflow.id === 'minimax-h3-i2v',
                `-mode=i2va selects the frame-anchoring workflow (got ${anchored.result.ok ? anchored.result.plan.workflow.id : anchored.result.reason})`
            );

            const twoImages = plan('/vid 动起来', ['QUJD', 'RUZH']);
            expect(
                twoImages.result.ok && twoImages.result.plan.workflow.id === 'minimax-h3-ref2v',
                'more images than input_image can carry escalates to the multi-asset workflow'
            );
            expect(
                twoImages.result.ok && twoImages.result.plan.extraReferenceImages === 0,
                'and both of them are used'
            );

            // A picture workflow with "base" in its id is not a rival here: /vid
            // could never run it, so it was never a candidate to be ambiguous with
            const quality = plan('/vid -w=base -steps=24 慢工出细活');
            expect(
                quality.result.ok && quality.result.plan.workflow.id === 'minimax-h3-base',
                `-w= substring-matches the quality workflow among the video ones (got ${quality.result.ok ? quality.result.plan.workflow.id : quality.result.reason})`
            );

            const tooManySteps = plan('/vid -steps=24 猫');
            expect(
                !tooManySteps.result.ok && tooManySteps.result.reason.includes('4-8'),
                'the same 24 steps on Turbo is caught locally, before a round trip'
            );

            const wrongCommand = plan('/vid -w=z-image 猫');
            expect(
                !wrongCommand.result.ok && wrongCommand.result.reason.includes('/pic'),
                'pointing -w= at a picture workflow says which command to use'
            );
            expect(
                !plan('/vid -w=flux2 猫').result.ok,
                'and that stays true for a picture workflow that a video query nearly matches'
            );

            const noSuchWorkflow = plan('/vid -w=nope 猫');
            expect(
                !noSuchWorkflow.result.ok &&
                    !noSuchWorkflow.result.reason.includes('z-image') &&
                    noSuchWorkflow.result.reason.includes('minimax-h3-base'),
                `an unknown -w= lists the video workflows only (got ${noSuchWorkflow.result.ok ? 'ok' : noSuchWorkflow.result.reason})`
            );

            const oneImageAnchored = plan('/vid -mode=i2va 推进', ['QUJD', 'RUZH']);
            expect(
                oneImageAnchored.result.ok &&
                    oneImageAnchored.result.plan.referenceImages.length === 1,
                'i2va uses one image only — the second would become a frame lock nobody asked for'
            );

            const halfAnchored = plan('/vid -mode=fl2va 变天', ['QUJD']);
            expect(
                !halfAnchored.result.ok && halfAnchored.result.reason.includes('两张图'),
                'fl2va with one image is refused rather than promising a <Picture 2> that is not there'
            );

            const unanchorable = plan('/vid -w=minimax-h3-turbo -mode=i2va 猫', ['QUJD']);
            expect(
                !unanchorable.result.ok && unanchorable.result.reason.includes('首帧'),
                'asking a workflow for frames it cannot lock says so instead of silently referencing'
            );

            const oversized = plan('/vid 改成夜景', ['A'.repeat(28 * 1024 * 1024)]);
            expect(
                !oversized.result.ok && oversized.result.reason.includes('20 MiB'),
                'an oversized reference is rejected before it is uploaded'
            );

            const tenImages = plan('/vid 群像', Array.from({ length: 10 }, (_, i) => `IMG${i}`));
            expect(
                tenImages.result.ok && tenImages.result.plan.referenceImages.length === 9,
                'the 9-image cap is respected'
            );
            expect(
                tenImages.result.ok && tenImages.result.plan.extraReferenceImages === 1,
                'and the leftovers are counted so the user can be told'
            );

            // The request body: the storyboard is the prompt, never the brief
            const planOf = (result: ReturnType<typeof planVideoGeneration>) => {
                if (!result.ok) throw new Error(`unplanned: ${result.reason}`);
                return result.plan;
            };

            const built = buildVideoRequest(
                planOf(referenced.result),
                referenced.spec,
                'integrated_multimodal_description: [Shot 1] ...'
            );
            expect(
                built.prompt.startsWith('integrated_multimodal_description:'),
                'the storyboard is what gets submitted'
            );
            expect(
                typeof built.options?.seed === 'number' &&
                    built.options?.duration_seconds === 5 &&
                    built.options?.aspect_ratio === '16:9',
                `a seed is always sent, alongside the planned duration and ratio (got ${JSON.stringify(built.options)})`
            );
            expect(
                built.input_image?.data === 'QUJD' && built.reference_images === undefined,
                'a single Ref2VA image rides on input_image'
            );
            expect(built.negative_prompt === undefined, 'H3 never gets a negative prompt');

            const multiRequest = buildVideoRequest(
                planOf(twoImages.result),
                twoImages.spec,
                'prompt'
            );
            expect(
                multiRequest.reference_images?.length === 2 && multiRequest.input_image === undefined,
                `several images go to reference_images (got ${JSON.stringify(Object.keys(multiRequest))})`
            );

            const anchoredRequest = buildVideoRequest(
                planOf(anchored.result),
                anchored.spec,
                'prompt'
            );
            expect(
                anchoredRequest.first_frame?.data === 'QUJD' &&
                    anchoredRequest.input_image === undefined,
                'a frame anchor goes to first_frame, not input_image'
            );
            expect(
                anchoredRequest.options?.aspect_ratio === undefined,
                'and no ratio is sent, so the output follows that frame'
            );

            const anchoredWithRatio = plan('/vid -mode=i2va -ar=1:1 方的', ['QUJD']);
            expect(
                buildVideoRequest(planOf(anchoredWithRatio.result), anchoredWithRatio.spec, 'p')
                    .options?.aspect_ratio === '1:1',
                'unless the user asked for one explicitly'
            );

            const sized = plan('/vid -size=608x352 街景');
            const sizedRequest = buildVideoRequest(planOf(sized.result), sized.spec, 'prompt');
            expect(
                sizedRequest.options?.width === 608 && sizedRequest.options?.aspect_ratio === undefined,
                'an explicit -size= drops the ratio the server would have ignored anyway'
            );
        },
    },
    {
        name: 'the storyboard is written by grok, cleaned, and degrades on failure',
        body: async () => {
            const { createServer } = await import('node:http');
            const {
                buildSystemPrompt,
                buildUserMessage,
                cleanStoryboard,
                enhanceVideoPrompt,
                H3PromptError,
            } = await import('../../src/services/h3-prompt-service.js');

            // Only the format block the mode needs is sent: showing the model a
            // spec it must not follow is how a three-field answer becomes six
            const ref2va = buildSystemPrompt('ref2va');
            const base = buildSystemPrompt('t2va');
            expect(
                ref2va.includes('subject_definitions') && !ref2va.includes('integrated_multimodal_description'),
                'ref2va gets the six-section spec only'
            );
            expect(
                base.includes('integrated_multimodal_description') && !base.includes('subject_definitions'),
                't2va gets the multi-shot spec only'
            );
            expect(
                base.includes('One dominant action') || base.includes('ONE dominant action'),
                'both carry the shared rules'
            );
            expect(!base.includes('<!--'), 'and the marker comments are stripped');

            const withImage = buildUserMessage({
                brief: '雨夜的电车',
                mode: 'ref2va',
                durationSeconds: 8,
                aspectRatio: '9:16',
                shots: 2,
                referenceImages: ['QUJD'],
            });
            expect(
                withImage.includes('MODE: ref2va') &&
                    withImage.includes('duration_s: 8') &&
                    withImage.includes('ratio: 9:16') &&
                    withImage.includes('shots: 2'),
                `the brief template carries the target (got ${JSON.stringify(withImage)})`
            );
            expect(
                withImage.includes('<Picture 1>') && withImage.includes('NOT a frame anchor'),
                'and tells the model what the image is for'
            );

            expect(
                cleanStoryboard('```\nintegrated_multimodal_description: [Shot 1] x\n```') ===
                    'integrated_multimodal_description: [Shot 1] x',
                'markdown fences are stripped'
            );
            expect(
                cleanStoryboard('Here is your prompt:\n\nsubject_definitions:\n<Subject 1> is a cat.') ===
                    'subject_definitions:\n<Subject 1> is a cat.',
                'and so is the preamble it was told not to write'
            );

            let lastBody: Record<string, any> = {};
            let replyWith: { status: number; body: unknown } = {
                status: 200,
                body: {
                    choices: [
                        {
                            message: {
                                content: '```\nintegrated_multimodal_description: [Shot 1] A tram.\n```',
                            },
                        },
                    ],
                },
            };

            const server = createServer((request, response) => {
                const chunks: Buffer[] = [];
                request.on('data', (chunk: Buffer) => chunks.push(chunk));
                request.on('end', () => {
                    lastBody = JSON.parse(Buffer.concat(chunks).toString() || '{}');
                    response.writeHead(replyWith.status, { 'Content-Type': 'application/json' });
                    response.end(JSON.stringify(replyWith.body));
                });
            });
            await new Promise<void>((ready) => server.listen(GROK_PORT, '127.0.0.1', ready));

            try {
                const storyboard = await enhanceVideoPrompt({
                    brief: '雨夜的电车',
                    mode: 'ref2va',
                    durationSeconds: 5,
                    aspectRatio: '16:9',
                    shots: null,
                    referenceImages: ['QUJD'],
                });
                expect(
                    storyboard === 'integrated_multimodal_description: [Shot 1] A tram.',
                    `the answer comes back cleaned (got ${JSON.stringify(storyboard)})`
                );

                const parts = lastBody.messages?.[1]?.content ?? [];
                expect(
                    lastBody.messages?.[0]?.role === 'system' &&
                        String(lastBody.messages?.[0]?.content).includes('subject_definitions'),
                    'the mode picked the system prompt'
                );
                expect(
                    Array.isArray(parts) &&
                        parts.some((part: any) => part.type === 'image_url' &&
                            String(part.image_url?.url).includes('QUJD')),
                    'and the reference image is actually shown to the model'
                );

                replyWith = { status: 500, body: { error: 'boom' } };
                const [error] = await import('../../src/shared/result.js').then(({ to }) =>
                    to(
                        enhanceVideoPrompt({
                            brief: '雨夜的电车',
                            mode: 't2va',
                            durationSeconds: 5,
                            aspectRatio: '16:9',
                            shots: null,
                            referenceImages: [],
                        })
                    )
                );
                expect(
                    error instanceof H3PromptError && Boolean(error.userReason),
                    `a failure is reportable rather than fatal (got ${String(error)})`
                );
            } finally {
                await new Promise<void>((closed) => server.close(() => closed()));
            }
        },
    },
    {
        // The picture path proves submit/poll; this one proves the fork at the
        // end — a video is downloaded from videos/N and goes out as a video.
        name: 'a video job is delivered as a video and stored as one',
        body: async () => {
            const { createServer } = await import('node:http');
            const { forgetWorkflows } = await import('../../src/services/comfy-forward-service.js');
            const { runGeneration } = await import(
                '../../src/reply/commands/generation-runner.js'
            );
            const { forgetAllJobs } = await import(
                '../../src/reply/commands/generation-job-store.js'
            );

            const MP4_BYTES = Buffer.from('00000018667479706d703432', 'hex');
            let downloadedPath = '';

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
                if (path === '/v1/generations' && request.method === 'POST') {
                    request.on('data', () => undefined);
                    request.on('end', () => json({ success: true, id: 'job-2', status: 'queued' }, 202));
                    return;
                }
                if (path === '/v1/generations/job-2/videos/0') {
                    downloadedPath = path;
                    response.writeHead(200, { 'Content-Type': 'video/mp4' });
                    response.end(MP4_BYTES);
                    return;
                }
                if (path === '/v1/generations/job-2') {
                    json({
                        success: true,
                        id: 'job-2',
                        status: 'succeeded',
                        // No `images` at all: a video job carries only `videos`
                        videos: [
                            { index: 0, filename: 'h3.mp4', url: '/v1/generations/job-2/videos/0' },
                        ],
                    });
                    return;
                }
                json({ error: 'not found' }, 404);
            });
            await new Promise<void>((ready) => server.listen(COMFY_PORT, '127.0.0.1', ready));

            interface SentVideo { spoiler: boolean; caption: string; streaming: boolean }
            const sentVideos: SentVideo[] = [];
            const sentPhotos: unknown[] = [];
            let videoMessageId = 0;

            const api = {
                sendMessage: async () => ({ message_id: takeMessageId() }),
                editMessageText: async () => true,
                editMessageReplyMarkup: async () => true,
                deleteMessage: async () => true,
                sendPhoto: async () => {
                    sentPhotos.push({});
                    return { message_id: takeMessageId() };
                },
                sendVideo: async (
                    _chatId: number,
                    _video: unknown,
                    other: { has_spoiler?: boolean; caption?: string; supports_streaming?: boolean }
                ) => {
                    sentVideos.push({
                        spoiler: Boolean(other.has_spoiler),
                        caption: other.caption ?? '',
                        streaming: Boolean(other.supports_streaming),
                    });
                    videoMessageId = takeMessageId();
                    return { message_id: videoMessageId };
                },
            };

            try {
                forgetWorkflows();
                forgetAllJobs();
                const userMessageId = await seedMessage({ text: '/vid 雨夜的电车' });

                await runGeneration({
                    api: api as unknown as Parameters<typeof runGeneration>[0]['api'],
                    chatId: OFFLINE_CHAT_ID,
                    userMessageId,
                    kind: 'video',
                    request: {
                        workflow: 'minimax-h3-turbo',
                        prompt: 'integrated_multimodal_description: [Shot 1] A tram.',
                        options: { seed: 4242, duration_seconds: 5, aspect_ratio: '16:9' },
                    },
                    spoiler: true,
                    workflowName: 'MiniMax H3 Turbo 文生视频',
                });

                expect(
                    downloadedPath === '/v1/generations/job-2/videos/0',
                    `the video is fetched from the videos path (got ${JSON.stringify(downloadedPath)})`
                );
                expect(sentPhotos.length === 0, 'and it does not go out as a photo');
                expect(sentVideos.length === 1, 'one video is sent');
                expect(sentVideos[0]?.spoiler === true, 'and /vid masked it');
                expect(sentVideos[0]?.streaming === true, 'with streaming enabled, so it plays inline');
                expect(
                    sentVideos[0]?.caption.includes('seed 4242') &&
                        sentVideos[0]?.caption.includes('5s') &&
                        sentVideos[0]?.caption.includes('16:9'),
                    `the caption says how to reproduce it (got ${JSON.stringify(sentVideos[0]?.caption)})`
                );

                const stored = await Message.findOne({
                    where: { chatId: OFFLINE_CHAT_ID, messageId: videoMessageId },
                });
                expect(
                    stored?.file?.equals(MP4_BYTES) === true && stored?.fileMime === 'video/mp4',
                    `the clip is stored as a video (got mime ${JSON.stringify(stored?.fileMime)})`
                );
                expect(
                    stored?.text?.startsWith('[生成的视频]') === true,
                    `and labelled as one for the model (got ${JSON.stringify(stored?.text)})`
                );
            } finally {
                await new Promise<void>((closed) => server.close(() => closed()));
                forgetWorkflows();
            }
        },
    },
    {
        name: 'streaming thinking keeps a two-segment preview and collapses the rest',
        body: async () => {
            const { segmentThinking, formatThinkingForStreaming } =
                await import('../../src/telegram/formatters/thinking-display.js');

            const quoteTypes = (rendered: { entities: readonly { type: string }[] }): string[] =>
                rendered.entities
                    .filter((entity) => entity.type === 'blockquote' || entity.type === 'expandable_blockquote')
                    .map((entity) => entity.type);

            // Segmentation: a heading adopts the paragraphs under it (Gemini shape)
            const geminiStyle =
                '**Plan**\n\nthink about the request\n\n**Execute**\n\ndo the thing\n\nkeep doing it\n\n**Review**\n\ncheck the result';
            const geminiSections = segmentThinking(geminiStyle);
            expect(
                geminiSections.length === 3 &&
                    geminiSections[1]?.startsWith('**Execute**') === true &&
                    geminiSections[1]?.includes('keep doing it') === true,
                `heading + content group into one section (got ${geminiSections.length})`
            );

            // Segmentation: headingless paragraphs group by size instead
            const paragraph = 'A reasoning paragraph without any heading in front of it.'.repeat(5); // ~290 chars
            const headingless = Array.from({ length: 6 }, () => paragraph).join('\n\n');
            const groupedSections = segmentThinking(headingless);
            expect(
                groupedSections.length >= 2 &&
                    groupedSections.length < 6 &&
                    groupedSections.every((s) => s.length <= 950),
                `headingless paragraphs merge into section-sized groups (got ${groupedSections.map((s) => s.length).join(',')})`
            );

            // Segmentation: a long run without blank lines is cut by size too
            const sentence = 'This is one reasoning sentence that keeps going for a while. ';
            const longRun = sentence.repeat(40).trim(); // ~2480 chars, no blank lines
            const fallbackSegments = segmentThinking(longRun);
            expect(
                fallbackSegments.length >= 3 && fallbackSegments.every((s) => s.length <= 950),
                `a wall of text is cut into section-sized segments (got ${fallbackSegments.map((s) => s.length).join(',')})`
            );

            // Prefix stability: appending more text never reshuffles earlier segments
            const grown = segmentThinking(longRun + sentence.repeat(5));
            expect(
                fallbackSegments
                    .slice(0, -1)
                    .every((segment, index) => grown[index] === segment),
                'already-streamed segments stay identical as more text arrives'
            );

            // <= 3 sections: everything visible in one plain blockquote
            const shortThinking = '**Alpha**\n\nalpha body\n\n**Beta**\n\nbeta body\n\n**Gamma**\n\ngamma body';
            expect(
                quoteTypes(formatThinkingForStreaming(shortThinking, { answerStarted: false }))
                    .join(',') === 'blockquote',
                'up to three sections render as one visible blockquote'
            );

            // > 3 sections: collapsed head + two-section visible preview
            const longThinking =
                shortThinking + '\n\n**Delta**\n\ndelta body\n\n**Epsilon**\n\nepsilon body';
            expect(
                segmentThinking(longThinking).length === 5,
                `five heading sections are five segments (got ${segmentThinking(longThinking).length})`
            );
            const rolling = formatThinkingForStreaming(longThinking, { answerStarted: false });
            expect(
                quoteTypes(rolling).join(',') === 'expandable_blockquote,blockquote',
                `older sections collapse, the tail stays visible (got ${quoteTypes(rolling).join(',')})`
            );
            const visibleStart = rolling.text.indexOf('Delta');
            const collapsedEntity = rolling.entities.find((e) => e.type === 'expandable_blockquote');
            const previewEntity = rolling.entities.find((e) => e.type === 'blockquote');
            expect(
                collapsedEntity !== undefined &&
                    previewEntity !== undefined &&
                    collapsedEntity.offset + collapsedEntity.length <= visibleStart &&
                    previewEntity.offset <= visibleStart &&
                    rolling.text.includes('epsilon'),
                'the preview blockquote covers exactly the last two segments'
            );

            // Answer started: the whole thinking collapses like the final render
            expect(
                quoteTypes(formatThinkingForStreaming(longThinking, { answerStarted: true }))
                    .join(',') === 'expandable_blockquote',
                'once the answer starts the whole thinking collapses'
            );
        },
    },
    {
        name: 'mention batcher merges a burst into one trigger',
        body: async () => {
            // Short sliding window so the case runs in milliseconds; the module
            // reads it per call, so setting it here (post-import) works.
            process.env.MENTION_BATCH_WINDOW_MS = '100';
            const { submitToMentionBatch } = await import('../../src/reply/mention-batcher.js');
            type BatcherCtx = Parameters<typeof submitToMentionBatch>[0];

            const fakeCtx = (fields: {
                messageId: number;
                userId?: number;
                forward?: boolean;
                photo?: boolean;
            }): BatcherCtx => {
                const shape = {
                    chat: { id: OFFLINE_CHAT_ID, type: 'private' },
                    message: {
                        message_id: fields.messageId,
                        from: { id: fields.userId ?? 500, is_bot: false, first_name: 'T' },
                        ...(fields.forward ? { forward_origin: { type: 'hidden_user' } } : {}),
                        ...(fields.photo ? { photo: [{}] } : {}),
                    },
                };
                // Only the fields the batcher touches; a real grammy Context is
                // not constructible without a live bot instance.
                return shape as unknown as BatcherCtx;
            };

            interface FlushRecord {
                anchorId: number;
                earlierIds: number[];
            }
            const flushes: FlushRecord[] = [];
            const record = (anchorCtx: BatcherCtx, earlierIds: number[]): Promise<void> => {
                flushes.push({
                    anchorId: anchorCtx.message?.message_id ?? -1,
                    earlierIds,
                });
                return Promise.resolve();
            };
            const settle = (): Promise<void> =>
                new Promise((resolve) => setTimeout(resolve, 250));

            // 1. A forwarded burst collapses into one flush anchored on the last
            const f1 = takeMessageId();
            const f2 = takeMessageId();
            const f3 = takeMessageId();
            submitToMentionBatch(fakeCtx({ messageId: f1, forward: true }), record);
            submitToMentionBatch(fakeCtx({ messageId: f2, forward: true }), record);
            submitToMentionBatch(fakeCtx({ messageId: f3, forward: true }), record);
            expect(flushes.length === 0, 'the window holds the burst back');
            await settle();
            expect(flushes.length === 1, 'the burst flushes exactly once');
            expect(flushes[0]?.anchorId === f3, 'the newest message is the anchor');
            expect(
                JSON.stringify(flushes[0]?.earlierIds) === JSON.stringify([f1, f2]),
                'the earlier members ride along, oldest first'
            );

            // …and linking them onto the anchor merges the burst into one context
            const m1 = await seedMessage({ text: '转发一' });
            const m2 = await seedMessage({ text: '转发二' });
            const anchor = await seedMessage({ text: '转发三' });
            await queries.saveMessageLinks(OFFLINE_CHAT_ID, anchor, [m1, m2]);
            const history = await queries.getRepliesHistory(OFFLINE_CHAT_ID, anchor, {
                excludeSelf: false,
            });
            expect(
                JSON.stringify(idsOf(history)) === JSON.stringify([m1, m2, anchor]),
                'the linked burst assembles chronologically with no reply relation'
            );

            // 2. A plain typed message with no open window triggers immediately
            flushes.length = 0;
            const typed = takeMessageId();
            submitToMentionBatch(fakeCtx({ messageId: typed }), record);
            expect(
                flushes.length === 1 && flushes[0]?.anchorId === typed,
                'plain text with no window flushes with zero delay'
            );
            expect(flushes[0]?.earlierIds.length === 0, 'and carries no batch members');

            // 3. A typed message closes an open window on the spot
            flushes.length = 0;
            const media = takeMessageId();
            const question = takeMessageId();
            submitToMentionBatch(fakeCtx({ messageId: media, photo: true }), record);
            expect(flushes.length === 0, 'a lone media message opens a window');
            submitToMentionBatch(fakeCtx({ messageId: question }), record);
            expect(
                flushes.length === 1 && flushes[0]?.anchorId === question,
                'the typed follow-up flushes immediately as the anchor'
            );
            expect(
                JSON.stringify(flushes[0]?.earlierIds) === JSON.stringify([media]),
                'with the media message as the earlier member'
            );

            // 4. Different users never share a window
            flushes.length = 0;
            const alice = takeMessageId();
            const bob = takeMessageId();
            submitToMentionBatch(fakeCtx({ messageId: alice, forward: true, userId: 501 }), record);
            submitToMentionBatch(fakeCtx({ messageId: bob, forward: true, userId: 502 }), record);
            await settle();
            expect(flushes.length === 2, 'two users get two separate flushes');
            expect(
                flushes.every((flush) => flush.earlierIds.length === 0),
                'neither batch absorbed the other user'
            );
        },
    },
    {
        name: 'the keyboard is dropped when only bodyless failures precede a good version',
        body: async () => {
            const { decideFinalButtonState } = await import(
                '../../src/services/final-button-state.js'
            );
            const { ButtonState } = await import('../../src/db/botResponseDTO.js');
            type Version = Parameters<typeof decideFinalButtonState>[0]['versions'][number];

            let versionId = 0;
            const version = (fields: { text?: string; imageBase64?: string }): Version => ({
                versionId: ++versionId,
                createdAt: new Date().toISOString(),
                messageIds: [versionId],
                currentMessageId: versionId,
                text: fields.text ?? '',
                imageBase64: fields.imageBase64,
                wasStoppedByUser: false,
            });
            const decide = (
                versions: Version[],
                overrides?: { hasError?: boolean; editedWhileProcessing?: boolean }
            ) =>
                decideFinalButtonState({
                    versions,
                    hasError: overrides?.hasError ?? false,
                    editedWhileProcessing: overrides?.editedWhileProcessing ?? false,
                });

            const emptyFailure = version({});
            const goodText = version({ text: 'a proper answer' });

            expect(
                decide([emptyFailure, goodText]) === ButtonState.NONE,
                'empty failure + clean answer hides the keyboard'
            );
            expect(
                decide([emptyFailure, version({}), version({ text: 'finally' })]) ===
                    ButtonState.NONE,
                'any number of bodyless failures before the good version still hides it'
            );
            expect(
                decide([emptyFailure, version({ imageBase64: 'aGk=' })]) === ButtonState.NONE,
                'an image counts as body for the current version'
            );
            expect(
                decide([version({ text: 'partial words' }), version({ text: 'retried' })]) ===
                    ButtonState.HAS_VERSIONS,
                'an earlier version with body keeps version switching'
            );
            expect(
                decide([version({ imageBase64: 'aGk=' }), version({ text: 'retried' })]) ===
                    ButtonState.HAS_VERSIONS,
                'an earlier image-only version also counts as switchable body'
            );
            expect(
                decide([emptyFailure, version({ text: 'partial' })], { hasError: true }) ===
                    ButtonState.HAS_VERSIONS,
                'a current version that itself errored keeps the keyboard'
            );
            expect(
                decide([emptyFailure, version({})]) === ButtonState.HAS_VERSIONS,
                'a bodyless current version keeps the keyboard (retry stays reachable)'
            );
            expect(
                decide([emptyFailure, goodText], { editedWhileProcessing: true }) ===
                    ButtonState.EDIT_DETECTED,
                'the collapse falls through to the edit-detected offer'
            );
            expect(
                decide([goodText]) === ButtonState.NONE &&
                    decide([version({ text: 'oops' })], { hasError: true }) ===
                        ButtonState.RETRY_ONLY,
                'single-version behavior is unchanged'
            );
        },
    },
    {
        name: 'bilifeed video messages get their danmaku extracted and rendered',
        body: async () => {
            const {
                isBilifeedVideoMessage,
                extractBilibiliVideoRef,
                parseDanmakuXml,
                selectDanmaku,
                renderDanmakuBlock,
                saveDanmakuSnapshot,
                loadArchivedDanmakuBlock,
            } = await import('../../src/services/bilibili-danmaku-service.js');

            // --- trigger condition ---
            const inlinePost = {
                text: '[标题](https://www.bilibili.com/video/av117189625585269?p=1)',
                viaBot: '@bilifeedbot',
                forwardOrigin: null,
                mediaHint: 'a video',
            };
            const forwardedPost = {
                ...inlinePost,
                viaBot: null,
                forwardOrigin: 'user Bilibili Feed Bot',
            };
            expect(
                isBilifeedVideoMessage(inlinePost) && isBilifeedVideoMessage(forwardedPost),
                'inline via @bilifeedbot and forwards of it both trigger'
            );
            expect(
                !isBilifeedVideoMessage({ ...inlinePost, mediaHint: 'a picture' }),
                'a bilifeed post without a video does not trigger'
            );
            expect(
                !isBilifeedVideoMessage({ ...inlinePost, viaBot: '@gif' }),
                'a video via some other inline bot does not trigger'
            );

            // --- video reference extraction ---
            const avRef = extractBilibiliVideoRef(inlinePost.text);
            expect(
                avRef?.aid === '117189625585269' && avRef.bvid === null && avRef.page === 1,
                'the avid and page are read out of the markdown link'
            );
            const bvRef = extractBilibiliVideoRef(
                'look https://www.bilibili.com/video/BV1uht86rEDA?p=3&t=10 nice'
            );
            expect(
                bvRef?.bvid === 'BV1uht86rEDA' && bvRef.page === 3,
                'BV ids and a mid-query p= parameter are extracted'
            );
            expect(
                extractBilibiliVideoRef('no video here') === null,
                'a text without a video link yields no reference'
            );

            // --- XML parsing (entities decoded, empty lines dropped) ---
            const xml =
                '<?xml version="1.0"?><i><maxlimit>1000</maxlimit>' +
                '<d p="126.248,5,25,16777215,1788202194,0,a1,90001,10">是不是太正常了</d>' +
                '<d p="3.5,1,25,16777215,1788202194,0,a2,90002,4">A &amp;&lt;B&gt; &#33; ok</d>' +
                '<d p="60,1,25,16777215,1788202194,0,a3,90003,7">   </d>' +
                '</i>';
            const entries = parseDanmakuXml(xml);
            expect(
                entries.length === 2 && entries[1].text === 'A &<B> ! ok',
                'danmaku lines are parsed and XML entities are decoded'
            );
            expect(
                entries[0].timeSec === 126.248 && entries[0].weight === 10,
                'appearance time and weight come from the p attribute'
            );

            // --- over-cap selection keeps the heavy ones, in timeline order ---
            const many = Array.from({ length: 10 }, (_, i) => ({
                timeSec: 10 - i,
                weight: i,
                text: `w${i}`,
            }));
            const picked = selectDanmaku(many, 3);
            expect(
                picked.map((entry) => entry.text).join(',') === 'w9,w8,w7' &&
                    picked[0].timeSec < picked[2].timeSec,
                'selection keeps the highest-weight danmaku and restores timeline order'
            );

            // --- rendered block ---
            const block = renderDanmakuBlock(
                { aid: null, bvid: 'BV1uht86rEDA', page: 2 },
                entries
            );
            expect(
                Boolean(
                    block?.startsWith('[system]') &&
                        block.includes('BV1uht86rEDA P2') &&
                        block.includes('[02:06] 是不是太正常了') &&
                        block.includes('[00:03] A &<B> ! ok')
                ),
                'the block carries the video label and mm:ss-stamped lines'
            );
            expect(
                renderDanmakuBlock({ aid: '1', bvid: null, page: 1 }, []) === null,
                'no danmaku means no block at all'
            );

            // --- archive snapshot roundtrip (deletion fallback) ---
            const snapshotRef = { aid: '999000111', bvid: null, page: 1 };
            await saveDanmakuSnapshot(snapshotRef, entries);
            const archived = await loadArchivedDanmakuBlock(snapshotRef);
            expect(
                Boolean(
                    archived?.includes('弹幕存档快照') &&
                        archived.includes('av999000111') &&
                        archived.includes('[02:06] 是不是太正常了')
                ),
                'a persisted snapshot renders back as a marked archive block'
            );
            await saveDanmakuSnapshot(snapshotRef, []);
            expect(
                (await loadArchivedDanmakuBlock(snapshotRef)) === archived,
                'an empty fetch result never overwrites an existing snapshot'
            );
            expect(
                (await loadArchivedDanmakuBlock({ aid: '404404', bvid: null, page: 1 })) ===
                    null,
                'a video never snapshotted has no archive to fall back to'
            );
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
