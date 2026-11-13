/**
 * The conversation tab's statistics: the chat statistics aggregates, restricted
 * to the replies of one conversation tree (every bot reply the tree contains,
 * retries included). The time range is the tree's whole life, so no range
 * picker is involved.
 */
import { loadConversationMessages } from '../views/conversation-tree.js';
import type { StatsResponse } from '../views/stats-view.js';
import { buildStats } from './build-stats.js';

/**
 * The first message id of every bot reply in the tree. reply_metrics rows are
 * keyed by exactly that id (bot_responses.messageId), continuations included in
 * the message list are harmless: they never start a metric row.
 */
export const conversationReplyIds = async (chatId: number, rootId: number): Promise<number[]> => {
    const messages = await loadConversationMessages(chatId, rootId);
    return messages.filter((message) => message.fromBotSelf).map((message) => message.messageId);
};

export const buildConversationStats = async (
    chatId: number,
    rootId: number,
    now: Date,
    isOwner: boolean
): Promise<StatsResponse> => {
    const firstMessageIds = await conversationReplyIds(chatId, rootId);
    // The pricing block shows pending proposals to the owner only; the route
    // knows who asked, so pass it through instead of silently dropping it.
    return buildStats({ chatId, range: 'all', now, firstMessageIds, isOwner });
};
