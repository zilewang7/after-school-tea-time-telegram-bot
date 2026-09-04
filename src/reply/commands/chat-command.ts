/**
 * `/chat` command handler.
 *
 * Records which bystander messages the user pulled into the context; the reply
 * itself is produced by the normal path afterwards. The selected ids go into
 * `message_links` (one insert-only row each, owned by this command message) —
 * never onto the reply target, which is why a `/chat` aimed at a reply the bot
 * is still streaming now works.
 *
 * Three selection modes, dispatched below: count/all walk forward from the
 * target (this file), `r` walks back through the recent burst
 * (chat-command-recent), a message link splices another conversation in and
 * asks for no reply (chat-command-link).
 */
import { Op } from '@sequelize/core';
import type { Context } from 'grammy';
import { match, P } from 'ts-pattern';
import { Message } from '../../db/messageDTO.js';
import { saveMessageLinks } from '../../db/queries/context-queries.js';
import { attachLinkedConversations, describeLinkProblems } from './chat-command-link.js';
import {
    parseChatCommand,
    type SequentialSelection,
    type UserScope,
} from './chat-command-parser.js';
import { attachRecentConversation } from './chat-command-recent.js';
import {
    selectAttachedMessageIds,
    type CandidateMessage,
} from './chat-command-selection.js';
import type { TelegramMessageLink } from './telegram-message-link.js';

/** Never attach more than this many messages to one reply */
const MAX_ATTACHED_MESSAGES = 100;

/**
 * Hard cap on the rows a single `/chat a` or `/chat r` scans, so an ancient
 * reply target cannot turn into a full-table read. Well above
 * MAX_ATTACHED_MESSAGES, since sub-images and the command's own row are
 * dropped after the query.
 */
const MAX_SCANNED_ROWS = 500;

/** What the caller (chat-handler) needs to know afterwards */
export type ChatCommandOutcome =
    /** Not a `/chat` message — fall back to the normal mention check */
    | { type: 'not-a-command' }
    /** Help was sent (missing reply target or malformed parameters) */
    | { type: 'help-shown' }
    /** Too many messages matched; the user was told, no reply follows */
    | { type: 'too-many'; matched: number }
    /** Nothing could be attached; the user was told why, no reply follows */
    | { type: 'declined' }
    /** Links recorded (possibly none) — the bot should reply */
    | { type: 'ready'; attached: number }
    /** Other conversations were spliced in — acknowledge, but do not reply */
    | { type: 'linked'; attached: number };

const HELP_TEXT = `\`/chat\` 仅在需要添加上下文时使用，如无此需求请直接回复或者 @${process.env.BOT_USER_NAME} 发送消息

用法:
在回复消息时添加参数, 最后可以加上你要告诉 ai 的内容
\`/chat [数字|a]\` 将被回复的消息及后面的\`[数字]\`条消息的上下文添加到会话中，如果是 a（或 all）则将后面的所有消息都添加到会话中
\`/chat r\` 收集最近一波聊天：从被回复的消息往上（不回复任何消息时从最新一条往上），相邻两条消息间隔超过 20 分钟就停止，最多 ${MAX_ATTACHED_MESSAGES} 条（超出自动截取，不报错）
\`/chat [数字|a|r]\` -[可选参数] 第二个参数为可选参数，筛选后不会影响要添加的消息条数
    \`s\`(single) 仅被回复的人的消息
    \`[数字]\` 加到上下文的用户人数，从被回复的人往下查找递增
    \`[firstName]\` 除被回复人外还要加到上下文的用户的前半部分名字，如果有多个用 \`/\` 分隔
\`/chat <消息链接> [<消息链接>…]\` 回复某条消息，把链接所指消息**所在的整串对话**拼进被回复的对话（长按消息 → 复制链接；只接受本群链接）。只做拼接、不触发回复，bot 用 👌 确认；之后照常回复/@ 即可看到拼接后的上下文

用例:
\`/chat 5 他们在说什么\` 将被回复的消息及后面的 4 条消息添加到上下文中
\`/chat 3 -s 解答一下\` 将被回复的人的消息及他后面的 2 条消息添加到上下文中
\`/chat 8 -3 他们三个人是什么关系\` 将被回复的消息以及后面出现的总共最多 3 人的共 8 条消息的添加到上下文中
\`/chat 5 -李四/王五 张三是不是大哥\` 将被回复人以及李四、王五的消息共计5条消息添加到上下文中
\`/chat a -s 总结一下他说的\` 将被回复消息的回复人的下面所有消息添加到上下文中
\`/chat r 刚才在吵什么\` 将最近一波聊天添加到上下文中
\`/chat https://t.me/c/1234567890/5678\` 将那条消息所在的对话拼到被回复的对话里`;

/**
 * Rows that may be attached: what sits between the target and the command.
 * `Op.gt` because the target itself reaches the context through this command's
 * `replyToId`, so it must not spend a slot; `Op.lt` because anything past the
 * command is not what the user was pointing at — without it a message arriving
 * while this query runs could still be swept in.
 */
const findCandidates = async (
    chatId: number,
    targetMessageId: number,
    commandMessageId: number,
    userScope: UserScope
): Promise<CandidateMessage[]> => {
    const rows = await Message.findAll({
        where: {
            chatId,
            messageId: { [Op.gt]: targetMessageId, [Op.lt]: commandMessageId },
            // Named scopes filter in SQL; a people *count* has to be applied in
            // order, so that one is filtered below.
            ...(userScope.type === 'named' ? { userName: { [Op.in]: userScope.names } } : {}),
        },
        attributes: ['messageId', 'userName', 'text'],
        order: [['messageId', 'ASC']],
        limit: MAX_SCANNED_ROWS,
    });

    if (rows.length === MAX_SCANNED_ROWS) {
        console.log(
            `[chat-command] scan capped at ${MAX_SCANNED_ROWS} rows after message ${targetMessageId}; anything further is left out`
        );
    }

    return rows;
};

/** `/chat 5` / `/chat a`: the messages after the target, in order */
const handleSequentialSelection = async (
    ctx: Context,
    chatId: number,
    commandMessageId: number,
    targetMessageId: number,
    selection: SequentialSelection,
    userScope: UserScope
): Promise<ChatCommandOutcome> => {
    const candidates = await findCandidates(chatId, targetMessageId, commandMessageId, userScope);
    const selected = selectAttachedMessageIds(candidates, selection, userScope, commandMessageId);

    if (selected.length > MAX_ATTACHED_MESSAGES) {
        await ctx.reply(`共查询到 ${selected.length} 条消息，超出${MAX_ATTACHED_MESSAGES}条，太多了！`);
        return { type: 'too-many', matched: selected.length };
    }

    // No rows to write for a pure summon (`/chat 1`): the message row's own
    // chatCommand marker is what tells the context builder this was a /chat.
    await saveMessageLinks(chatId, commandMessageId, selected);
    return { type: 'ready', attached: selected.length };
};

/** `/chat <link>`: splice other conversations in, tell the user about any that failed */
const handleLinkSelection = async (
    ctx: Context,
    chat: { id: number; username?: string },
    commandMessageId: number,
    targetMessageId: number,
    links: TelegramMessageLink[]
): Promise<ChatCommandOutcome> => {
    const result = await attachLinkedConversations(chat, commandMessageId, targetMessageId, links);
    const problems = describeLinkProblems(result);
    if (problems !== null) {
        await ctx.reply(problems);
    }
    return result.attachedRoots > 0
        ? { type: 'linked', attached: result.attachedRoots }
        : { type: 'declined' };
};

/**
 * Handle `/chat`. Returns what happened so the caller can decide whether the
 * bot should reply at all.
 */
export const dealChatCommand = async (ctx: Context): Promise<ChatCommandOutcome> => {
    if (!ctx.message || !ctx.chat) return { type: 'not-a-command' };
    const chat = ctx.chat;

    // Commands ride on a photo's caption just as well as on plain text
    const rawText = ctx.message.text ?? ctx.message.caption;
    const targetMessageId = ctx.message.reply_to_message?.message_id;
    const targetAuthor = ctx.message.reply_to_message?.from?.first_name || '';

    const parsed = parseChatCommand(rawText, targetAuthor);
    if (parsed.type === 'none') return { type: 'not-a-command' };

    const showHelp = async (): Promise<ChatCommandOutcome> => {
        await ctx.reply(HELP_TEXT, { parse_mode: 'Markdown' });
        return { type: 'help-shown' };
    };
    if (parsed.type === 'invalid') return showHelp();

    const { selection, userScope } = parsed.spec;
    const commandMessageId = ctx.message.message_id;

    return match(selection)
        .with({ type: 'recent' }, async () => {
            // The only mode that works without a reply target
            const attached = await attachRecentConversation({
                chatId: chat.id,
                commandMessageId,
                targetMessageId,
                userScope,
                maxMessages: MAX_ATTACHED_MESSAGES,
                maxScannedRows: MAX_SCANNED_ROWS,
            });
            return { type: 'ready' as const, attached };
        })
        .with({ type: 'link' }, async (linkSelection) =>
            targetMessageId === undefined
                ? showHelp()
                : handleLinkSelection(ctx, chat, commandMessageId, targetMessageId, linkSelection.links)
        )
        .with({ type: P.union('count', 'all') }, async (sequential) =>
            targetMessageId === undefined
                ? showHelp()
                : handleSequentialSelection(
                    ctx,
                    chat.id,
                    commandMessageId,
                    targetMessageId,
                    sequential,
                    userScope
                )
        )
        .exhaustive();
};
