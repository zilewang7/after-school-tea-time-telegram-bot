/**
 * Offline cases for the runtime block's `# 消息 reaction` section: reactions are
 * rendered per part of a multi-message bot reply (design 2026-1123-1610 §2.3/§4),
 * the section keeps its 16-part-line / 800-character caps, and the reaction
 * roster entries stay as they were (design 2026-1120-1312 §4.3 / §7.1 B).
 *
 * The rows are written the way the app writes them: user reactions through the
 * committed inbound query (the ledger supplies the part snapshot), the model's
 * own through the committed bot-reaction query. The section is read back out of
 * what `buildContext` makes of a real reply tree — the same path a reply and the
 * panel's model view take.
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
type ReplyPartKind = import('../../src/shared/reply-part.js').ReplyPartKind;

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
const { setReplyPart } = await import('../../src/db/queries/reply-part-queries.js');
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

/**
 * Record one delivered message as a part of `canonicalMessageId` the way the
 * delivery ledger does, and return its (Telegram) message id.
 */
const addPart = async (
    canonicalMessageId: number,
    part: ReplyPartKind,
    partIndex: number | null = null
): Promise<number> => {
    const messageId = takeMessageId();
    await setReplyPart({ chatId: CHAT_ID, canonicalMessageId, messageId, part, partIndex });
    return messageId;
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

/** Write one actor's current reaction set through the committed inbound query */
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

/** The model's own reaction, on a part when `part` is given */
const reactAsModel = async (
    canonicalMessageId: number,
    emoji: string,
    part?: { readonly messageId: number; readonly part: ReplyPartKind; readonly partIndex: number | null }
): Promise<void> => {
    await replaceBotReaction(
        CHAT_ID,
        canonicalMessageId,
        emoji,
        part === undefined
            ? undefined
            : { messageId: part.messageId, part: part.part, partIndex: part.partIndex }
    );
};

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
    return (end < 0 ? runtime.slice(start) : runtime.slice(start, end)).trimEnd();
};

const sectionOfContext = async (
    messageId: number,
    options: Partial<BuildContextOptions> = {}
): Promise<string | null> => reactionSectionOf(runtimeTextOf(await buildFor(messageId, options)));

const sectionLines = (section: string): string[] => section.split('\n');

/** The section as the exact text the design asks for, heading included */
const expectedSection = (lines: readonly string[]): string => `${REACTION_HEADING}\n${lines.join('\n')}`;

/** Every part line of the section, in the rendered order */
const partLines = (section: string): string[] => sectionLines(section).filter((line) => /^- #\d+/.test(line));

/** The `#N` of each part line; a multi-part message repeats its number */
const partLineNumbers = (section: string): number[] =>
    partLines(section).map((line) => Number(/^- #(\d+)/.exec(line)?.[1] ?? 'NaN'));

const omissionLineOf = (section: string): string | undefined =>
    sectionLines(section).find((line) => line.startsWith('- 还有 '));

const codePointCount = (text: string): number => Array.from(text).length;

// ---- cases ----------------------------------------------------------------

const cases: { name: string; body: () => Promise<void> }[] = [
    {
        name: 'one reacted body part is unlabelled, even when it is the second segment',
        body: async () => {
            const [reply] = await seedChain(1);
            const secondSegment = await addPart(reply!, 'body', 2);
            await reactWithEmoji(secondSegment, { userId: 2001, name: '张三' }, '👍');
            await reactWithEmoji(secondSegment, { userId: 2002, name: '李四' }, '❤');
            await reactAsModel(reply!, '🔥', { messageId: secondSegment, part: 'body', partIndex: 2 });

            const section = (await sectionOfContext(reply!)) ?? '';
            expect(
                section === expectedSection(['- #1：👍（张三）；❤（李四）；🔥（模型）']),
                `the second segment reads as the reply's body, without a position (got ${JSON.stringify(section)})`
            );
        },
    },
    {
        name: 'two reacted body segments are each labelled by their index',
        body: async () => {
            const [reply] = await seedChain(1);
            const firstSegment = await addPart(reply!, 'body', 1);
            const secondSegment = await addPart(reply!, 'body', 2);
            const thirdSegment = await addPart(reply!, 'body', 3);
            await reactWithEmoji(firstSegment, { userId: 2101, name: '张三' }, '👍');
            await reactWithEmoji(secondSegment, { userId: 2102, name: '李四' }, '🎉');
            await reactWithEmoji(thirdSegment, { userId: 2103, name: '王五' }, '🤩');

            const section = (await sectionOfContext(reply!)) ?? '';
            expect(
                section ===
                    expectedSection([
                        '- #1 正文：👍（张三）',
                        '- #1 正文第 2 段：🎉（李四）',
                        '- #1 正文第 3 段：🤩（王五）',
                    ]),
                `each body segment gets its own labelled line (got ${JSON.stringify(section)})`
            );
        },
    },
    {
        name: 'a product reacted to alone is labelled, never merged into the body',
        body: async () => {
            const [reply] = await seedChain(1);
            const sticker = await addPart(reply!, 'sticker');
            const secondPicture = await addPart(reply!, 'picture', 2);
            await reactWithEmoji(sticker, { userId: 2201, name: '赵六' }, '🤩');
            await reactWithEmoji(secondPicture, { userId: 2202, name: '钱七' }, '🥰');

            const section = (await sectionOfContext(reply!)) ?? '';
            expect(
                section ===
                    expectedSection(['- #1 图片 2：🥰（钱七）', '- #1 贴纸：🤩（赵六）']),
                `product parts keep their labels even alone, in kind order (got ${JSON.stringify(section)})`
            );
        },
    },
    {
        name: 'mixed body and product parts: every part gets its own line',
        body: async () => {
            const [reply] = await seedChain(1);
            const firstSegment = await addPart(reply!, 'body', 1);
            const sticker = await addPart(reply!, 'sticker');
            const cardLink = await addPart(reply!, 'widget-link');
            // The same person may react to two parts of one reply: both stand
            await reactWithEmoji(firstSegment, { userId: 2301, name: '张三' }, '👍');
            await reactWithEmoji(sticker, { userId: 2301, name: '张三' }, '❤');
            await reactAsModel(reply!, '🎉', { messageId: cardLink, part: 'widget-link', partIndex: null });

            const section = (await sectionOfContext(reply!)) ?? '';
            expect(
                section ===
                    expectedSection([
                        '- #1 正文：👍（张三）',
                        '- #1 贴纸：❤（张三）',
                        '- #1 卡片链接：🎉（模型）',
                    ]),
                `body, then media, then card link (got ${JSON.stringify(section)})`
            );
        },
    },
    {
        name: 'all part kinds render in the fixed order, legacy rows last as 整条',
        body: async () => {
            const [reply] = await seedChain(1);
            const sources = {
                bodySecond: await addPart(reply!, 'body', 2),
                bodyFirst: await addPart(reply!, 'body', 1),
                cotLink: await addPart(reply!, 'cot-link'),
                searchLink: await addPart(reply!, 'search-link'),
                toolsLink: await addPart(reply!, 'tools-link'),
                pictureSecond: await addPart(reply!, 'picture', 2),
                pictureFirst: await addPart(reply!, 'picture', 1),
                gif: await addPart(reply!, 'gif'),
                sticker: await addPart(reply!, 'sticker'),
                file: await addPart(reply!, 'file'),
                widget: await addPart(reply!, 'widget'),
                widgetLink: await addPart(reply!, 'widget-link'),
            };
            await reactWithEmoji(sources.bodyFirst, { userId: 2401, name: '甲' }, '👍');
            await reactWithEmoji(sources.bodySecond, { userId: 2402, name: '乙' }, '❤');
            await reactWithEmoji(sources.cotLink, { userId: 2403, name: '丙' }, '🔥');
            await reactWithEmoji(sources.searchLink, { userId: 2404, name: '丁' }, '🥰');
            await reactWithEmoji(sources.toolsLink, { userId: 2405, name: '戊' }, '👏');
            await reactWithEmoji(sources.pictureFirst, { userId: 2406, name: '己' }, '😁');
            await reactWithEmoji(sources.pictureSecond, { userId: 2407, name: '庚' }, '🤔');
            await reactWithEmoji(sources.gif, { userId: 2408, name: '辛' }, '🤯');
            await reactWithEmoji(sources.sticker, { userId: 2409, name: '壬' }, '😱');
            await reactWithEmoji(sources.file, { userId: 2410, name: '癸' }, '🤬');
            await reactWithEmoji(sources.widget, { userId: 2411, name: '子' }, '😢');
            await reactWithEmoji(sources.widgetLink, { userId: 2412, name: '丑' }, '🎉');
            // No ledger row for the canonical id itself: a row from before the parts model
            await reactWithEmoji(reply!, { userId: 2413, name: '寅' }, '🤩');

            const section = (await sectionOfContext(reply!)) ?? '';
            expect(
                section ===
                    expectedSection([
                        '- #1 正文：👍（甲）',
                        '- #1 正文第 2 段：❤（乙）',
                        '- #1 CoT 链接条：🔥（丙）',
                        '- #1 搜索来源链接条：🥰（丁）',
                        '- #1 工具记录链接条：👏（戊）',
                        '- #1 图片 1：😁（己）',
                        '- #1 图片 2：🤔（庚）',
                        '- #1 动图：🤯（辛）',
                        '- #1 贴纸：😱（壬）',
                        '- #1 文件：🤬（癸）',
                        '- #1 卡片：😢（子）',
                        '- #1 卡片链接：🎉（丑）',
                        '- #1 整条：🤩（寅）',
                    ]),
                `every kind is labelled and ordered as the design says (got ${JSON.stringify(section)})`
            );
        },
    },
    {
        name: 'the same part delivered under a new message id still reads as one line',
        body: async () => {
            const [reply] = await seedChain(1);
            // A version switch re-delivers the body: both ids are the same part
            const firstLayout = await addPart(reply!, 'body', 1);
            const secondLayout = await addPart(reply!, 'body', 1);
            await reactWithEmoji(firstLayout, { userId: 2501, name: '张三' }, '👍');
            await reactWithEmoji(secondLayout, { userId: 2502, name: '李四' }, '❤');

            const section = (await sectionOfContext(reply!)) ?? '';
            expect(
                section === expectedSection(['- #1：👍（张三）；❤（李四）']),
                `one part is one line, whatever message id delivered it (got ${JSON.stringify(section)})`
            );
        },
    },
    {
        name: 'within a part: standard emoji order, four names, custom, paid, anonymous and the model',
        body: async () => {
            const [reply] = await seedChain(1);
            const body = await addPart(reply!, 'body', 1);
            const names = ['张三', '李四', '王五', '赵六', '钱七', '孙八'];
            for (let index = 0; index < names.length; index += 1) {
                await reactWithEmoji(body, { userId: 2600 + index, name: names[index]! }, '👍');
            }
            await reactWithEmoji(body, { userId: 2610, name: '群友' }, '😁');
            await reactWithEmoji(body, { userId: null, actorChatId: GROUP, name: '匿名频道' }, '🎉');
            await react(body, { userId: 2611, name: 'Cara' }, [
                { kind: 'custom_emoji', emoji: null, customEmojiId: '111' },
            ]);
            await react(body, { userId: 2612, name: 'Dan' }, [
                { kind: 'custom_emoji', emoji: null, customEmojiId: '222' },
            ]);
            await react(body, { userId: 2613, name: 'Eve' }, [
                { kind: 'paid', emoji: null, customEmojiId: null },
            ]);
            await reactAsModel(reply!, '🏆', { messageId: body, part: 'body', partIndex: 1 });

            const section = (await sectionOfContext(reply!)) ?? '';
            expect(
                section ===
                    expectedSection([
                        '- #1：👍（张三、李四、王五、赵六…等 2 人）；😁（群友）；🎉（匿名）；🏆（模型）；[自定义表情]（Cara）；[自定义表情]（Dan）；⭐（Eve）',
                    ]),
                `entries keep today's order and merging rules (got ${JSON.stringify(section)})`
            );
        },
    },
    {
        name: 'the newest sixteen part lines survive and whole older messages are counted',
        body: async () => {
            const chain = await seedChain(10);
            for (const messageId of chain) {
                const body = await addPart(messageId, 'body', 1);
                const sticker = await addPart(messageId, 'sticker');
                await reactWithEmoji(body, { userId: 2700, name: '甲' }, '👍');
                await reactWithEmoji(sticker, { userId: 2701, name: '乙' }, '❤');
            }

            const section = (await sectionOfContext(chain[9]!)) ?? '';
            expect(
                partLineNumbers(section).join(',') ===
                    '3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10',
                `sixteen part lines are kept, oldest messages dropped whole (got ${partLineNumbers(section).join(',')})`
            );
            expect(
                omissionLineOf(section) === '- 还有 2 条消息的 reaction 未显示',
                `the dropped messages are announced (got ${JSON.stringify(omissionLineOf(section))})`
            );
            expect(
                partLines(section).every((line) => line.endsWith('）')),
                `no part line is cut mid-entry (got ${JSON.stringify(partLines(section))})`
            );
        },
    },
    {
        name: 'whole message groups are dropped until the section fits 800 characters',
        body: async () => {
            const chain = await seedChain(5);
            const emojis = ['👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔'];
            const names = ['风花雪月', '山高水长', '云淡风轻', '海阔天空'];
            for (const messageId of chain) {
                const parts = [await addPart(messageId, 'body', 1), await addPart(messageId, 'sticker')];
                for (const part of parts) {
                    for (const [emojiIndex, emoji] of emojis.entries()) {
                        for (const [nameIndex, name] of names.entries()) {
                            await reactWithEmoji(
                                part,
                                { userId: 2800 + emojiIndex * 10 + nameIndex, name },
                                emoji
                            );
                        }
                    }
                }
            }

            const section = (await sectionOfContext(chain[4]!)) ?? '';
            expect(
                codePointCount(section) <= 800,
                `the section stays within 800 characters (got ${codePointCount(section)})`
            );
            const numbers = partLineNumbers(section);
            const keptMessages = [...new Set(numbers)];
            expect(
                keptMessages.length > 0 && keptMessages.length < chain.length,
                `whole messages are dropped (kept messages ${keptMessages.join(',')})`
            );
            expect(
                keptMessages.join(',') ===
                    chain
                        .slice(chain.length - keptMessages.length)
                        .map((_, index) => chain.length - keptMessages.length + index + 1)
                        .join(','),
                `the newest messages are the ones kept (got ${keptMessages.join(',')})`
            );
            expect(
                omissionLineOf(section) === `- 还有 ${chain.length - keptMessages.length} 条消息的 reaction 未显示`,
                `the dropped count is announced (got ${JSON.stringify(omissionLineOf(section))})`
            );
            expect(
                partLines(section).every((line) => line.endsWith('）')),
                `no part line is cut mid-entry (got ${JSON.stringify(partLines(section))})`
            );
        },
    },
    {
        name: 'a lone legacy row reads as the body, without a position',
        body: async () => {
            const [reply] = await seedChain(1);
            // No ledger row and a telegram row: an inbound path before the parts model
            await reactWithEmoji(reply!, { userId: 2901, name: '张三' }, '👍');

            const section = (await sectionOfContext(reply!)) ?? '';
            expect(
                section === expectedSection(['- #1：👍（张三）']),
                `a legacy row alone carries no 整条 label (got ${JSON.stringify(section)})`
            );
        },
    },
    {
        name: 'legacy rows read as 整条 next to a labelled part, still last',
        body: async () => {
            const [reply] = await seedChain(1);
            const body = await addPart(reply!, 'body', 1);
            const sticker = await addPart(reply!, 'sticker');
            // A legacy row on the reply and a new body row on its first segment:
            // the legacy row cannot name its part, so it stays a separate 整条 line
            await reactWithEmoji(reply!, { userId: 2911, name: '张三' }, '👍');
            await reactWithEmoji(body, { userId: 2912, name: '李四' }, '❤');
            await reactWithEmoji(sticker, { userId: 2913, name: '王五' }, '🎉');

            const section = (await sectionOfContext(reply!)) ?? '';
            expect(
                section ===
                    expectedSection([
                        '- #1 正文：❤（李四）',
                        '- #1 贴纸：🎉（王五）',
                        '- #1 整条：👍（张三）',
                    ]),
                `the legacy row is labelled 整条 in a multi-part reply (got ${JSON.stringify(section)})`
            );
        },
    },
    {
        name: 'message groups stay in #N order and their part lines stay together',
        body: async () => {
            const chain = await seedChain(3);
            await reactWithEmoji(chain[0]!, { userId: 2921, name: '张三' }, '👍');
            const secondSegment = await addPart(chain[1]!, 'body', 2);
            const secondSticker = await addPart(chain[1]!, 'sticker');
            await reactWithEmoji(secondSegment, { userId: 2922, name: '李四' }, '❤');
            await reactWithEmoji(secondSticker, { userId: 2923, name: '王五' }, '🎉');
            const thirdSticker = await addPart(chain[2]!, 'sticker');
            await reactWithEmoji(thirdSticker, { userId: 2924, name: '赵六' }, '🤩');

            const section = (await sectionOfContext(chain[2]!)) ?? '';
            expect(
                partLineNumbers(section).join(',') === '1,2,2,3',
                `#N ascending, a message's parts adjacent (got ${partLineNumbers(section).join(',')})`
            );
            expect(
                section ===
                    expectedSection([
                        '- #1：👍（张三）',
                        // Two reacted parts: the second segment is labelled on its own
                        '- #2 正文第 2 段：❤（李四）',
                        '- #2 贴纸：🎉（王五）',
                        '- #3 贴纸：🤩（赵六）',
                    ]),
                `every message renders its own part lines (got ${JSON.stringify(section)})`
            );
        },
    },
    {
        name: 'the section sits after the trigger line and before the chat addendum',
        body: async () => {
            const [reply] = await seedChain(1);
            const body = await addPart(reply!, 'body', 1);
            await reactWithEmoji(body, { userId: 2001, name: '张三' }, '👍');
            const context = await buildFor(reply!, {
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
            const [reply] = await seedChain(1);
            const runtime = runtimeTextOf(await buildFor(reply!));
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
        name: 'a reaction-only person joins the roster, anonymous and bot actors do not',
        body: async () => {
            const [reply] = await seedChain(1);
            const body = await addPart(reply!, 'body', 1);
            const sticker = await addPart(reply!, 'sticker');
            await reactWithEmoji(body, { userId: 2002, name: 'Bob' }, '👍');
            await reactWithEmoji(sticker, { userId: null, actorChatId: GROUP, name: '匿名频道' }, '🎉');
            await reactAsModel(reply!, '❤', { messageId: sticker, part: 'sticker', partIndex: null });
            // A bot account the roster knows about reacts too: no @ target for a bot
            await TelegramUser.create({
                userId: 5005,
                username: null,
                firstName: 'Helper',
                lastName: null,
                isBot: true,
                updatedAt: new Date(),
            });
            await reactWithEmoji(body, { userId: 5005, name: 'Helper' }, '🔥');

            const context = await buildFor(reply!);
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
            const [reply] = await seedChain(1);
            const body = await addPart(reply!, 'body', 1);
            await reactWithEmoji(body, { userId: 2001, name: '张三' }, '👍');
            const before = await MessageReaction.count({ where: { chatId: CHAT_ID } });
            const drySection = (await sectionOfContext(reply!, { dryRun: true })) ?? '';
            const after = await MessageReaction.count({ where: { chatId: CHAT_ID } });
            expect(
                drySection === expectedSection(['- #1：👍（张三）']),
                `the dry run renders the section (got ${JSON.stringify(drySection)})`
            );
            expect(after === before, 'the dry run writes no reaction row');
        },
    },
    {
        name: 'the same state renders the same text whatever order it was written in',
        body: async () => {
            const [reply] = await seedChain(1);
            const firstSegment = await addPart(reply!, 'body', 1);
            const secondSegment = await addPart(reply!, 'body', 2);
            const write = async (reverse: boolean): Promise<void> => {
                const steps = [
                    (): Promise<void> => reactWithEmoji(secondSegment, { userId: 5002, name: '乙' }, '❤'),
                    (): Promise<void> => reactWithEmoji(firstSegment, { userId: 5001, name: '甲' }, '👍'),
                    (): Promise<void> => reactWithEmoji(firstSegment, { userId: 5003, name: '丙' }, '🎉'),
                ];
                for (const step of reverse ? steps.slice().reverse() : steps) await step();
            };
            await write(false);
            const first = (await sectionOfContext(reply!)) ?? '';

            // Same state, written in the other order: the rows' own order and
            // timestamps must not reach the rendered text.
            await MessageReaction.destroy({ where: { chatId: CHAT_ID } });
            await write(true);
            const second = (await sectionOfContext(reply!)) ?? '';

            expect(
                first.length > 0 && first === second,
                `the rendering is stable (got ${JSON.stringify(first)} vs ${JSON.stringify(second)})`
            );
        },
    },
    {
        name: 'an excluded message takes its reactions out of the section',
        body: async () => {
            const chain = await seedChain(3);
            const middle = chain[1]!;
            const middleBody = await addPart(middle, 'body', 1);
            await reactWithEmoji(middleBody, { userId: 6001, name: '张三' }, '👍');
            const before = (await sectionOfContext(chain[2]!)) ?? '';
            expect(
                before.includes('- #2：👍（张三）'),
                `before: the reaction line is there (got ${JSON.stringify(before)})`
            );

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
