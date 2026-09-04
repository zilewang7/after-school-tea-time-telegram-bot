/**
 * `/chat r`: attach the recent burst of conversation.
 *
 * Walks back from the reply target (or from the command itself when nothing is
 * replied to), stops at the first gap longer than RECENT_GAP_MS, and silently
 * keeps at most `maxMessages` — unlike `a`, there is no "too many" refusal.
 */
import { Op } from '@sequelize/core';
import { Message } from '../../db/messageDTO.js';
import { getContextMessage, saveMessageLinks } from '../../db/queries/context-queries.js';
import type { UserScope } from './chat-command-parser.js';
import { selectRecentMessageIds } from './chat-command-selection.js';

export interface RecentAttachmentOptions {
    chatId: number;
    commandMessageId: number;
    /** The reply target, if the command replied to something */
    targetMessageId: number | undefined;
    userScope: UserScope;
    maxMessages: number;
    maxScannedRows: number;
}

/** Records the links and returns how many messages were attached */
export const attachRecentConversation = async (
    options: RecentAttachmentOptions
): Promise<number> => {
    const { chatId, commandMessageId, targetMessageId } = options;

    // The target itself reaches the context through the command's replyToId;
    // the walk starts just before it (or just before the command).
    const anchorMessageId = targetMessageId ?? commandMessageId;
    const anchor =
        targetMessageId === undefined ? null : await getContextMessage(chatId, targetMessageId);

    const rows = await Message.findAll({
        where: { chatId, messageId: { [Op.lt]: anchorMessageId } },
        attributes: ['messageId', 'userName', 'text', 'date'],
        order: [['messageId', 'DESC']],
        limit: options.maxScannedRows,
    });

    if (rows.length === options.maxScannedRows) {
        console.log(
            `[chat-command] recent scan capped at ${options.maxScannedRows} rows before message ${anchorMessageId} without finding a gap`
        );
    }

    const selected = selectRecentMessageIds(rows, {
        userScope: options.userScope,
        commandMessageId,
        anchorDate: anchor?.date ?? null,
        maxMessages: options.maxMessages,
    });

    await saveMessageLinks(chatId, commandMessageId, selected);
    return selected.length;
};
