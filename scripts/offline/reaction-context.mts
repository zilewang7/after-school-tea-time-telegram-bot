/**
 * Offline cases for the runtime block's `# 消息 reaction` section and the
 * reaction roster entries (design 2026-1120-1312 §4.3 / §7.1 B).
 *
 * The rows are written through the committed reaction queries and the section is
 * read back out of what `buildContext` makes of a real reply tree — the same
 * path a reply and the panel's model view take.
 *
 * Run: npx tsx scripts/offline/reaction-context.mts
 */
import {
    expect,
    reportResults,
    runCase,
    setupOfflineDb,
    takeMessageId,
    type CaseResult,
} from './harness.mts';

type BuildContextOptions = import('../../src/reply/context-builder.js').BuildContextOptions;
type BuiltContext = import('../../src/reply/context-builder.js').BuiltContext;
type ModelCapabilities = import('../../src/ai/types.js').ModelCapabilities;
type ReactionInput = import('../../src/db/queries/reaction-queries.js').ReactionInput;
type ReactionActor = import('../../src/db/queries/reaction-queries.js').ReactionActor;

// Read at import/call time by the modules below; set before anything from src/
process.env.BOT_USER_ID = '7777';
process.env.BOT_NAME = 'ReactionBot';
process.env.DEFAULT_MODEL = 'gemini-4-argon';
delete process.env.ALLOWED_CHAT_IDS;
delete process.env.LUOXU_PREVIEW_URL;

const CHAT_ID = -1009999999990;
const MODEL = 'gemini-4-argon';
const BOT_USER_ID = 7777;
const ALICE_ID = 1001;
const GROUP = -1009999999991;
const RUNTIME_MARKER = '[system] 运行时信息';
const REACTION_HEADING = '# 消息 reaction';
const ADDENDUM_HEADING = '# 本聊天的附加提示词';

const CAPABILITIES: ModelCapabilities = {
    supportsImageInput: true,
    supportsImageOutput: false,
    supportsSystemPrompt: true,
    requiresMessageMerge: false,
    supportsThinking: false,
    supportsMediaInput: false,
};

const db = await setupOfflineDb();
const { buildContext } = await import('../../src/reply/context-builder.js');
const { buildRuntimeContext } = await import('../../src/ai/system-prompt/runtime-context.js');
const { replaceBotReaction, applyUserReactionUpdate } = await import('../../src/db/queries/reaction-queries.js');
const { ContextExclusion } = await import('../../src/db/contextExclusionDTO.js');
const { MessageReaction } = await import('../../src/db/messageReactionDTO.js');
const { TelegramUser } = await import('../../src/db/telegramUserDTO.js');

/** One stored message of the offline chat; returns its id */
const seed = async (
    text: string,
    options: { replyToId?: number; userId?: number; userName?: string } = {}
): Promise<number> => {
    const messageId = takeMessageId();
    await db.saveMessage({
        chatId: CHAT_ID,
        messageId,
        userId: options.userId ?? ALICE_ID,
        userName: options.userName ?? 'Alice',
        date: new Date(Date.now() - 600_000 + messageId),
        message: text,
        replyToId: options.replyToId,
    });
    return messageId;
};

/** A reply chain of `count` messages, each answering the previous one */
const seedChain = async (count: number): Promise<number[]> => {
    const ids: number[] = [];
    let replyToId: number | undefined;
    for (let index = 0; index < count; index += 1) {
        const messageId = await seed(`M${index + 1}`, { replyToId });
        ids.push(messageId);
        replyToId = messageId;
    }
    return ids;
};

interface Actor {
    readonly userId: number | null;
    readonly actorChatId?: number;
    readonly name: string;
}

const actorOf = (actor: Actor): ReactionActor => ({
    userId: actor.userId,
    actorChatId: actor.actorChatId ?? null,
    userName: actor.name,
});

const emojiInput = (text: string): ReactionInput => ({ kind: 'emoji', emoji: text, customEmojiId: null });

/** Write one actor's current reaction set through the committed query */
const react = async (messageId: number, actor: Actor, reactions: readonly ReactionInput[]): Promise<void> => {
    const result = await applyUserReactionUpdate({
        chatId: CHAT_ID,
        messageId,
        actor: actorOf(actor),
        reactions,
    });
    expect(result.stored, `reaction rows stored for message ${messageId}`);
};

const reactWithEmoji = (messageId: number, actor: Actor, emoji: string): Promise<void> =>
    react(messageId, actor, [emojiInput(emoji)]);

const buildFor = async (
    messageId: number,
    options: Partial<BuildContextOptions> = {}
): Promise<BuiltContext> => {
    const row = await db.Message.findOne({ where: { chatId: CHAT_ID, messageId } });
    if (row === null) throw new Error(`message ${messageId} of chat ${CHAT_ID} missing`);
    return buildContext(row, {
        model: MODEL,
        capabilities: CAPABILITIES,
        chatTitle: 'Reaction Lab',
        ...options,
    });
};

/** The runtime block of a built context: the part that starts with its marker */
const runtimeTextOf = (context: BuiltContext): string => {
    for (const message of context.messages) {
        for (const part of message.content) {
            if (part.type === 'text' && (part.text ?? '').startsWith(RUNTIME_MARKER)) return part.text ?? '';
        }
    }
    throw new Error('the built context carries no runtime block');
};

/** The reaction section alone: heading up to the addendum/end */
const reactionSectionOf = (runtime: string): string | null => {
    const start = runtime.indexOf(REACTION_HEADING);
    if (start < 0) return null;
    const end = runtime.indexOf(ADDENDUM_HEADING, start);
    return end < 0 ? runtime.slice(start) : runtime.slice(start, end);
};

const sectionOfContext = async (
    messageId: number,
    options: Partial<BuildContextOptions> = {}
): Promise<string | null> => reactionSectionOf(runtimeTextOf(await buildFor(messageId, options)));

const sectionLines = (section: string): string[] => section.split('\n');

const messageLines = (section: string): string[] => sectionLines(section).filter((line) => line.startsWith('- #'));

/** `#N`s of the message lines, in the rendered order */
const messageLineNumbers = (section: string): number[] =>
    messageLines(section).map((line) => Number(/^- #(\d+)：/.exec(line)?.[1] ?? 'NaN'));

const omissionLineOf = (section: string): string | undefined =>
    sectionLines(section).find((line) => line.startsWith('- 还有 '));

const codePointCount = (text: string): number => Array.from(text).length;

// ---- cases ----------------------------------------------------------------

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'a message line names its #N, the reactees and the model',
        body: async () => {
            const chain = await seedChain(3);
            const [first, second, trigger] = chain;
            // A bot reaction is only recorded locally: the Bot API never reports it
            await replaceBotReaction(CHAT_ID, first!, '❤');
            await reactWithEmoji(second!, { userId: 2001, name: '张三' }, '👍');
            await reactWithEmoji(second!, { userId: 2002, name: '李四' }, '👍');

            const runtime = runtimeTextOf(await buildFor(trigger!));
            expect(
                runtime.includes(`\n\n${REACTION_HEADING}\n`),
                `the section is its own block after a blank line (got ${JSON.stringify(runtime)})`
            );
            const section = reactionSectionOf(runtime) ?? '';
            const lines = sectionLines(section);
            expect(lines.includes('- #1：❤（模型）'), `the model's own reaction reads as 模型 (got ${JSON.stringify(lines)})`);
            expect(
                lines.includes('- #2：👍（张三、李四）'),
                `the reactees are listed by name (got ${JSON.stringify(lines)})`
            );
            expect(!section.includes('- #3'), 'a message without reactions gets no line');
        },
    },
    {
        name: 'the section sits after the trigger line and before the chat addendum',
        body: async () => {
            const [trigger] = await seedChain(1);
            await reactWithEmoji(trigger!, { userId: 2001, name: '张三' }, '👍');
            const context = await buildFor(trigger!, {
                chatAddendum: '附加规则：保持简短。',
                triggerAccess: {
                    userId: 2001,
                    name: '张三',
                    applicationStatus: null,
                    applicationComment: null,
                },
            });
            const runtime = runtimeTextOf(context);
            const triggerIndex = runtime.indexOf('- 本次回复的触发用户：');
            const sectionIndex = runtime.indexOf(REACTION_HEADING);
            const addendumIndex = runtime.indexOf(ADDENDUM_HEADING);
            expect(
                triggerIndex >= 0 && sectionIndex > triggerIndex,
                `the section follows the trigger line (got ${JSON.stringify(runtime)})`
            );
            expect(addendumIndex > sectionIndex, 'the chat addendum keeps its place at the end of the block');
            expect(runtime.slice(0, sectionIndex).endsWith('\n\n'), 'the section is separated by a blank line');
        },
    },
    {
        name: 'no reactions: no section, and the runtime block keeps its old bytes',
        body: async () => {
            const [trigger] = await seedChain(1);
            const runtime = runtimeTextOf(await buildFor(trigger!));
            expect(!runtime.includes(REACTION_HEADING), 'a context without reactions renders no section');

            // The new argument is trailing and optional: absent, null and empty
            // all have to leave the block exactly as it was before reactions.
            const withoutArgument = buildRuntimeContext(MODEL, [], 'Reaction Lab', null, null);
            const empty = buildRuntimeContext(MODEL, [], 'Reaction Lab', null, null, []);
            const nullArgument = buildRuntimeContext(MODEL, [], 'Reaction Lab', null, null, null);
            expect(
                withoutArgument === empty && empty === nullArgument,
                `the trailing argument leaves the block byte-identical (got ${JSON.stringify(withoutArgument)} vs ${JSON.stringify(empty)})`
            );
            expect(
                sectionLines(withoutArgument).length === 4 && !withoutArgument.includes('reaction'),
                `the block is still header + time + chat + model (got ${JSON.stringify(withoutArgument)})`
            );
        },
    },
    {
        name: 'the newest twelve message lines survive and the older ones are counted',
        body: async () => {
            const chain = await seedChain(15);
            for (let index = 0; index < chain.length; index += 1) {
                await reactWithEmoji(chain[index]!, { userId: 2100 + index, name: `R${index + 1}` }, '👍');
            }
            const section = (await sectionOfContext(chain[14]!)) ?? '';
            const numbers = messageLineNumbers(section);
            expect(numbers.length === 12, `twelve message lines are kept (got ${numbers.length})`);
            expect(
                numbers.join(',') === '4,5,6,7,8,9,10,11,12,13,14,15',
                `the newest twelve lines are kept, ascending (got ${numbers.join(',')})`
            );
            expect(
                omissionLineOf(section) === '- 还有 3 条消息的 reaction 未显示',
                `the dropped messages are announced (got ${JSON.stringify(omissionLineOf(section))})`
            );
        },
    },
    {
        name: 'the same emoji lists four names and summarizes the rest',
        body: async () => {
            const [messageId] = await seedChain(1);
            const names = ['张三', '李四', '王五', '赵六', '钱七', '孙八'];
            for (let index = 0; index < names.length; index += 1) {
                await reactWithEmoji(messageId!, { userId: 3000 + index, name: names[index]! }, '👍');
            }
            const section = (await sectionOfContext(messageId!)) ?? '';
            expect(
                sectionLines(section).includes('- #1：👍（张三、李四、王五、赵六…等 2 人）'),
                `four names then the count of the others (got ${JSON.stringify(section)})`
            );
        },
    },
    {
        name: 'custom, paid and anonymous reactions read as the design says',
        body: async () => {
            const [messageId] = await seedChain(1);
            await reactWithEmoji(messageId!, { userId: 3101, name: 'Fay' }, '👍');
            await reactWithEmoji(messageId!, { userId: null, actorChatId: GROUP, name: '匿名频道' }, '😂');
            await react(messageId!, { userId: 3102, name: 'Cara' }, [
                { kind: 'custom_emoji', emoji: null, customEmojiId: '111' },
            ]);
            await react(messageId!, { userId: 3103, name: 'Dan' }, [
                { kind: 'custom_emoji', emoji: null, customEmojiId: '222' },
            ]);
            await react(messageId!, { userId: 3104, name: 'Eve' }, [
                { kind: 'paid', emoji: null, customEmojiId: null },
            ]);

            const section = (await sectionOfContext(messageId!)) ?? '';
            const line = messageLines(section)[0] ?? '';
            expect(line.includes('👍（Fay）'), `the standard emoji is shown as is (got ${JSON.stringify(line)})`);
            expect(line.includes('😂（匿名）'), `an anonymous actor reads as 匿名 (got ${JSON.stringify(line)})`);
            expect(
                line.includes('[自定义表情]（Cara）') && line.includes('[自定义表情]（Dan）'),
                `custom reactions read as [自定义表情] (got ${JSON.stringify(line)})`
            );
            expect(line.includes('⭐（Eve）'), `a paid reaction reads as ⭐ (got ${JSON.stringify(line)})`);

            const paidIndex = line.indexOf('⭐（Eve）');
            const secondCustomIndex = line.indexOf('[自定义表情]（Dan）');
            const firstCustomIndex = line.indexOf('[自定义表情]（Cara）');
            const standardIndex = line.indexOf('👍（Fay）');
            expect(
                standardIndex < firstCustomIndex && firstCustomIndex < secondCustomIndex && secondCustomIndex < paidIndex,
                `standard emoji, then custom (by id), then paid (got ${JSON.stringify(line)})`
            );
        },
    },
    {
        name: 'whole message lines are dropped until the section fits 600 characters',
        body: async () => {
            const chain = await seedChain(5);
            const emojis = ['😀', '😁', '😂', '🤣', '😃', '😄', '😅', '😆'];
            const names = ['风花雪月', '山高水长', '云淡风轻', '海阔天空'];
            for (const messageId of chain) {
                for (const [emojiIndex, emoji] of emojis.entries()) {
                    for (const [nameIndex, name] of names.entries()) {
                        await reactWithEmoji(messageId, { userId: 4000 + emojiIndex * 10 + nameIndex, name }, emoji);
                    }
                }
            }

            const section = (await sectionOfContext(chain[4]!)) ?? '';
            expect(
                codePointCount(section) <= 600,
                `the section stays within 600 characters (got ${codePointCount(section)})`
            );
            const numbers = messageLineNumbers(section);
            expect(numbers.length > 0 && numbers.length < chain.length, `whole lines are dropped (kept ${numbers.length})`);
            expect(
                numbers.join(',') === [1, 2, 3, 4, 5].slice(chain.length - numbers.length).join(','),
                `the oldest lines are the ones dropped (got ${numbers.join(',')})`
            );
            expect(
                omissionLineOf(section) === `- 还有 ${chain.length - numbers.length} 条消息的 reaction 未显示`,
                `the dropped count is announced (got ${JSON.stringify(omissionLineOf(section))})`
            );
            expect(
                messageLines(section).every((line) => line.endsWith('）')),
                `no line is cut mid-entry (got ${JSON.stringify(messageLines(section))})`
            );
        },
    },
    {
        name: 'a reaction-only person joins the roster, anonymous and bot actors do not',
        body: async () => {
            const [messageId] = await seedChain(1);
            await reactWithEmoji(messageId!, { userId: 2002, name: 'Bob' }, '👍');
            await reactWithEmoji(messageId!, { userId: null, actorChatId: GROUP, name: '匿名频道' }, '😂');
            await replaceBotReaction(CHAT_ID, messageId!, '❤');
            // A bot account the roster knows about reacts too: no @ target for a bot
            await TelegramUser.create({
                userId: 5005,
                username: null,
                firstName: 'Helper',
                lastName: null,
                isBot: true,
                updatedAt: new Date(),
            });
            await reactWithEmoji(messageId!, { userId: 5005, name: 'Helper' }, '🔥');

            const context = await buildFor(messageId!);
            const runtime = runtimeTextOf(context);
            const bob = context.contextUsers.find((user) => user.userId === 2002);
            expect(bob?.mentionedOnly === false, 'a reactor is not a mention');
            expect(bob?.reactionOnly === true, 'a reactor is marked reactionOnly');
            expect(
                sectionLines(runtime).includes('- Bob：id 2002，无 username（只点了 reaction，未在上下文中发言）'),
                `the roster line says why the person is there (got ${JSON.stringify(runtime)})`
            );
            const alice = context.contextUsers.find((user) => user.userId === ALICE_ID);
            expect(
                alice?.mentionedOnly === false && alice.reactionOnly !== true,
                'an author keeps the ordinary roster line'
            );
            expect(
                !context.contextUsers.some((user) => user.userId === 5005),
                'a bot account that only reacted stays out of the roster'
            );
            expect(
                !context.contextUsers.some((user) => user.userId === BOT_USER_ID),
                'the model itself stays out of the roster'
            );
            expect(
                !context.contextUsers.some((user) => user.userId === null),
                'an anonymous actor has no user id to mention and stays out'
            );
        },
    },
    {
        name: 'the panel model view reads the same section and writes nothing',
        body: async () => {
            const [messageId] = await seedChain(1);
            await reactWithEmoji(messageId!, { userId: 2001, name: '张三' }, '👍');
            const before = await MessageReaction.count({ where: { chatId: CHAT_ID } });
            const drySection = (await sectionOfContext(messageId!, { dryRun: true })) ?? '';
            const after = await MessageReaction.count({ where: { chatId: CHAT_ID } });
            expect(drySection.includes('- #1：👍（张三）'), `the dry run renders the section (got ${JSON.stringify(drySection)})`);
            expect(after === before, 'the dry run writes no reaction row');
        },
    },
    {
        name: 'the same state renders the same text whatever order it was written in',
        body: async () => {
            const [messageId] = await seedChain(1);
            await reactWithEmoji(messageId!, { userId: 5002, name: '乙' }, '❤');
            await reactWithEmoji(messageId!, { userId: 5001, name: '甲' }, '👍');
            const first = (await sectionOfContext(messageId!)) ?? '';

            // Same state, written in the other order: the rows' own order and
            // timestamps must not reach the rendered text.
            await MessageReaction.destroy({ where: { chatId: CHAT_ID, messageId: messageId! } });
            await reactWithEmoji(messageId!, { userId: 5002, name: '乙' }, '❤');
            await reactWithEmoji(messageId!, { userId: 5001, name: '甲' }, '👍');
            const second = (await sectionOfContext(messageId!)) ?? '';

            expect(first.length > 0 && first === second, `the rendering is stable (got ${JSON.stringify(first)} vs ${JSON.stringify(second)})`);
        },
    },
    {
        name: "an excluded message takes its reactions out of the section",
        body: async () => {
            const chain = await seedChain(3);
            const middle = chain[1]!;
            await reactWithEmoji(middle, { userId: 6001, name: '张三' }, '👍');
            const before = (await sectionOfContext(chain[2]!)) ?? '';
            expect(before.includes('- #2：👍（张三）'), `before: the reaction line is there (got ${JSON.stringify(before)})`);

            await ContextExclusion.create({
                chatId: CHAT_ID,
                messageId: middle,
                createdAt: new Date(),
                createdBy: 9999,
            });
            expect((await sectionOfContext(chain[2]!)) === null, 'an excluded message does not show reactions');

            await ContextExclusion.destroy({ where: { chatId: CHAT_ID, messageId: middle } });
            const restored = (await sectionOfContext(chain[2]!)) ?? '';
            expect(restored.includes('- #2：👍（张三）'), 'restoring the message restores its reaction line');
        },
    },
];

const results: CaseResult[] = [];
for (const testCase of cases) {
    results.push(await runCase(testCase.name, testCase.body));
}
reportResults(results);
