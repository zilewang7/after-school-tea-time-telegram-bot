/**
 * Context number → clickable message link.
 *
 * The numbering only exists inside one assembled context, so it is looked up
 * from the registry buildContext fills, keyed by the user message the reply
 * belongs to. Resolved lazily at render time: the registry is written after the
 * chat context (and its editor) already exist.
 */
import { getContextNumbering } from '../state.js';
import type { ContextLinkResolver } from './formatters/context-links.js';

/** Only supergroups / channels have a t.me deep-link form for their messages */
const SUPERGROUP_ID_PREFIX = '-100';

/**
 * Resolver for one reply, or undefined when nothing can be linked (private
 * chat, plain group, or a context whose numbering is no longer known — e.g. a
 * version switch after a restart).
 */
export const buildMessageLinkResolver = (
    chatId: number,
    userMessageId: number
): ContextLinkResolver | undefined => {
    const rawChatId = String(chatId);
    if (!rawChatId.startsWith(SUPERGROUP_ID_PREFIX)) return undefined;

    const numbering = getContextNumbering(chatId, userMessageId);
    if (!numbering) return undefined;

    const chatPath = rawChatId.slice(SUPERGROUP_ID_PREFIX.length);

    return (contextNumber) => {
        const messageId = numbering.get(contextNumber);
        return messageId === undefined
            ? undefined
            : `https://t.me/c/${chatPath}/${messageId}`;
    };
};
