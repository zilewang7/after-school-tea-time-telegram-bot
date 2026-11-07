/**
 * Which reply the model view re-computes: "what would the model see if retry
 * were pressed now". The answer is always a user message (the runtime block
 * rides it, as in a real request) plus, when it already has a reply, that
 * reply — left out of the context exactly as the retry handler does.
 *
 * - `at` names a bot message (a continuation id too): its reply is normalized
 *   to the first message and the retry answers that reply's user message.
 * - `at` names a user message: its newest finished reply is the one replaced;
 *   a message nobody answered yet replaces nothing.
 * - no `at`: the newest user message of this conversation's own chain that has
 *   a finished reply, else its newest user message.
 *
 * Replies still streaming take no part. Lookups are read-only.
 */
import { findBotResponseByMessageId, getMessage } from '../../db/index.js';
import type { Message } from '../../db/messageDTO.js';
import {
    findRootMessage,
    getContextMessage,
    listReplyHeadsForUserMessages,
    type ContextMessage,
} from '../../db/queries/context-queries.js';
import { isBotReplyInFlight } from '../../state.js';
import { PanelError } from '../errors.js';
import { invalid } from '../request.js';
import { CONVERSATION_MESSAGES } from './conversation-errors.js';
import { assembleConversation } from './conversation-tree.js';

export interface ModelViewTarget {
    /** The message the retry answers */
    userMessage: Message;
    /** The reply a retry would replace (left out of the context); null when there is none */
    excludedReplyId: number | null;
}

interface TargetIds {
    userMessageId: number;
    replyId: number | null;
}

const notFound = (message: string): PanelError => new PanelError('not_found', message);

/** userMessageId → first message id of its newest finished reply */
const finishedRepliesOf = async (chatId: number, userMessageIds: readonly number[]): Promise<Map<number, number>> => {
    const newest = new Map<number, number>();
    for (const reply of await listReplyHeadsForUserMessages(chatId, userMessageIds)) {
        if (isBotReplyInFlight(chatId, reply.messageId)) continue;
        const known = newest.get(reply.userMessageId);
        if (known === undefined || reply.messageId > known) newest.set(reply.userMessageId, reply.messageId);
    }
    return newest;
};

const resolveExplicitAt = async (chatId: number, at: number, treeIds: ReadonlySet<number>): Promise<TargetIds> => {
    const message = await getContextMessage(chatId, at);
    if (message === null) throw notFound(CONVERSATION_MESSAGES.messageNotFound);
    // Canonical id: a continuation id resolves to its reply's first message
    if (!treeIds.has(message.messageId)) throw notFound(CONVERSATION_MESSAGES.notInConversation);

    if (!message.fromBotSelf) {
        const replies = await finishedRepliesOf(chatId, [message.messageId]);
        return { userMessageId: message.messageId, replyId: replies.get(message.messageId) ?? null };
    }
    const response = await findBotResponseByMessageId(chatId, at);
    if (response !== null) return { userMessageId: response.userMessageId, replyId: response.messageId };
    if (message.replyToId !== null) return { userMessageId: message.replyToId, replyId: message.messageId };
    throw invalid('无法确定这条回复所回答的消息');
};

const resolveDefaultAt = async (
    chatId: number,
    rootId: number,
    messages: readonly ContextMessage[]
): Promise<TargetIds> => {
    const candidates = messages
        .filter((message) => !message.fromBotSelf)
        .sort((a, b) => b.messageId - a.messageId);
    const replies = await finishedRepliesOf(
        chatId,
        candidates.map((message) => message.messageId)
    );
    const cache = new Map<number, ContextMessage | null>();
    // A message spliced in from another conversation answers in that one
    const inOwnChain = async (message: ContextMessage): Promise<boolean> =>
        (await findRootMessage(chatId, message.messageId, { recover: false, cache }))?.messageId === rootId;

    for (const message of candidates) {
        const replyId = replies.get(message.messageId);
        if (replyId !== undefined && (await inOwnChain(message))) return { userMessageId: message.messageId, replyId };
    }
    for (const message of candidates) {
        if (await inOwnChain(message)) return { userMessageId: message.messageId, replyId: null };
    }
    throw notFound('本会话里没有可查看的用户消息');
};

export const resolveModelViewTarget = async (
    chatId: number,
    rootId: number,
    at: number | undefined
): Promise<ModelViewTarget> => {
    const conversation = await assembleConversation(chatId, rootId);
    const messages = [...conversation.messages, ...conversation.excludedMessages];
    const ids =
        at === undefined
            ? await resolveDefaultAt(chatId, rootId, messages)
            : await resolveExplicitAt(chatId, at, new Set(messages.map((message) => message.messageId)));

    const userMessage = await getMessage(chatId, ids.userMessageId);
    if (userMessage === null || userMessage.fromBotSelf) throw notFound(CONVERSATION_MESSAGES.messageNotFound);
    return { userMessage, excludedReplyId: ids.replyId };
};
