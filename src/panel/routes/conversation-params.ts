/**
 * What the conversation endpoints share: message ids from the path, the
 * member-only gate of the operations, and the "is this a conversation root"
 * check. Every lookup here is read-only (no luoxu backfill).
 */
import { findRootMessage, getContextMessage, type ContextMessage } from '../../db/queries/context-queries.js';
import type { GrantedChat } from '../access/require-access.js';
import { PanelError } from '../errors.js';
import { invalid } from '../request.js';
import { CONVERSATION_MESSAGES } from '../views/conversation-errors.js';

export { CONVERSATION_MESSAGES };

const MESSAGE_ID_PATTERN = /^\d{1,15}$/;

/** A Telegram message id from the path: a positive integer */
export const parseMessageIdParam = (raw: string | undefined, name: string): number => {
    if (raw === undefined || !MESSAGE_ID_PATTERN.test(raw)) throw invalid(`${name} 必须是正整数`);
    const messageId = Number(raw);
    if (!Number.isSafeInteger(messageId) || messageId < 1) throw invalid(`${name} 必须是正整数`);
    return messageId;
};

/** Model view, export, links and exclusions: members only, observers get 403 */
export const requireMember = (granted: GrantedChat): void => {
    if (granted.access !== 'member') throw new PanelError('forbidden', CONVERSATION_MESSAGES.membersOnly);
};

/**
 * The conversation's root row. 404 unless `rootId` is stored (a continuation
 * id of a bot reply does not count) and is the root of its own reply chain.
 */
export const requireConversationRoot = async (chatId: number, rootId: number): Promise<ContextMessage> => {
    const root = await getContextMessage(chatId, rootId);
    if (root === null || root.messageId !== rootId) {
        throw new PanelError('not_found', CONVERSATION_MESSAGES.conversationNotFound);
    }
    const chainRoot = await findRootMessage(chatId, rootId, { recover: false });
    if (chainRoot?.messageId !== rootId) {
        throw new PanelError('not_found', CONVERSATION_MESSAGES.conversationNotFound);
    }
    return root;
};
