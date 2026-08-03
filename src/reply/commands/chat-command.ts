/**
 * `/chat` command handler.
 *
 * Records which bystander messages the user pulled into the context; the reply
 * itself is produced by the normal path afterwards. The selected ids go into
 * `message_links` (one insert-only row each, owned by this command message) —
 * never onto the reply target, which is why a `/chat` aimed at a reply the bot
 * is still streaming now works.
 */
import { Op } from '@sequelize/core';
import type { Context } from 'grammy';
import { Message } from '../../db/messageDTO.js';
import { saveMessageLinks } from '../../db/queries/context-queries.js';
import { parseChatCommand, type UserScope } from './chat-command-parser.js';
import {
    selectAttachedMessageIds,
    type CandidateMessage,
} from './chat-command-selection.js';

/** Never attach more than this many messages to one reply */
const MAX_ATTACHED_MESSAGES = 50;

/**
 * Hard cap on the rows a single `/chat a` scans, so an ancient reply target
 * cannot turn into a full-table read. Well above MAX_ATTACHED_MESSAGES, since
 * sub-images and the command's own row are dropped after the query.
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
    /** Links recorded (possibly none) — the bot should reply */
    | { type: 'ready'; attached: number };

const HELP_TEXT = `\`/chat\` 仅在需要添加上下文时使用，如无此需求请直接回复或者 @${process.env.BOT_USER_NAME} 发送消息

用法:
在回复消息时添加参数, 最后可以加上你要告诉 ai 的内容
\`/chat [数字|a]\` 将被回复的消息及后面的\`[数字]\`条消息的上下文添加到会话中，如果是 a 则将后面的所有消息都添加到会话中
\`/chat [数字|a]\` -[可选参数] 第二个参数为可选参数，筛选后不会影响要添加的消息条数
    \`s\`(single) 仅被回复的人的消息
    \`[数字]\` 加到上下文的用户人数，从被回复的人往下查找递增
    \`[firstName]\` 除被回复人外还要加到上下文的用户的前半部分名字，如果有多个用 \`/\` 分隔

用例:
\`/chat 5 他们在说什么\` 将被回复的消息及后面的 4 条消息添加到上下文中
\`/chat 3 -s 解答一下\` 将被回复的人的消息及他后面的 2 条消息添加到上下文中
\`/chat 8 -3 他们三个人是什么关系\` 将被回复的消息以及后面出现的总共最多 3 人的共 8 条消息的添加到上下文中
\`/chat 5 -李四/王五 张三是不是大哥\` 将被回复人以及李四、王五的消息共计5条消息添加到上下文中
\`/chat a -s 总结一下他说的\` 将被回复消息的回复人的下面所有消息添加到上下文中`;

/**
 * Rows that may be attached: everything after the target. `Op.gt` because the
 * target itself reaches the context through this command's `replyToId`, so it
 * must not spend a slot.
 */
const findCandidates = async (
    chatId: number,
    targetMessageId: number,
    userScope: UserScope
): Promise<CandidateMessage[]> => {
    const rows = await Message.findAll({
        where: {
            chatId,
            messageId: { [Op.gt]: targetMessageId },
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

/**
 * Handle `/chat`. Returns what happened so the caller can decide whether the
 * bot should reply at all.
 */
export const dealChatCommand = async (ctx: Context): Promise<ChatCommandOutcome> => {
    if (!ctx.message || !ctx.chat) return { type: 'not-a-command' };

    // Commands ride on a photo's caption just as well as on plain text
    const rawText = ctx.message.text ?? ctx.message.caption;
    const targetMessageId = ctx.message.reply_to_message?.message_id;
    const targetAuthor = ctx.message.reply_to_message?.from?.first_name || '';

    const parsed = parseChatCommand(rawText, targetAuthor);
    if (parsed.type === 'none') return { type: 'not-a-command' };

    if (parsed.type === 'invalid' || !targetMessageId) {
        await ctx.reply(HELP_TEXT, { parse_mode: 'Markdown' });
        return { type: 'help-shown' };
    }

    const chatId = ctx.chat.id;
    const commandMessageId = ctx.message.message_id;

    const candidates = await findCandidates(chatId, targetMessageId, parsed.spec.userScope);
    const selected = selectAttachedMessageIds(candidates, parsed.spec, commandMessageId);

    if (selected.length > MAX_ATTACHED_MESSAGES) {
        await ctx.reply(`共查询到 ${selected.length} 条消息，超出50条，太多了！`);
        return { type: 'too-many', matched: selected.length };
    }

    // No rows to write for a pure summon (`/chat 1`): the message row's own
    // chatCommand marker is what tells the context builder this was a /chat.
    await saveMessageLinks(chatId, commandMessageId, selected);

    return { type: 'ready', attached: selected.length };
};
