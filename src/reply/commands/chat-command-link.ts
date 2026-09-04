/**
 * `/chat <message link>`: splice the conversation another message sits in into
 * the conversation the command replies to.
 *
 * The context tree is assembled root-down (getRepliesHistory walks up to the
 * root, then collects replies and links downward), so the edge has to point at
 * the linked message's *root* — an edge to the message itself would bring in
 * only that message and what hangs below it, not the conversation above it.
 */
import {
    findRootMessage,
    getContextMessageOrRecover,
    saveMessageLinks,
} from '../../db/queries/context-queries.js';
import { linkPointsIntoChat, type TelegramMessageLink } from './telegram-message-link.js';

export interface LinkAttachmentResult {
    /** Distinct conversation roots that were linked in */
    attachedRoots: number;
    /** Links into another chat: never followed */
    foreign: number[];
    /** Messages not stored and not recoverable */
    missing: number[];
    /** Messages already in the same tree as the reply target */
    alreadyInTree: number[];
}

export const attachLinkedConversations = async (
    chat: { id: number; username?: string },
    commandMessageId: number,
    targetMessageId: number,
    links: TelegramMessageLink[]
): Promise<LinkAttachmentResult> => {
    const chatId = chat.id;
    const result: LinkAttachmentResult = {
        attachedRoots: 0,
        foreign: [],
        missing: [],
        alreadyInTree: [],
    };

    // A target still being streamed by the bot has no row yet; it is then its own root
    const targetRoot = await findRootMessage(chatId, targetMessageId);
    const targetRootId = targetRoot?.messageId ?? targetMessageId;

    const rootIds = new Set<number>();
    for (const link of links) {
        if (!linkPointsIntoChat(link, chat)) {
            result.foreign.push(link.messageId);
            continue;
        }
        const linked = await getContextMessageOrRecover(chatId, link.messageId);
        if (!linked) {
            result.missing.push(link.messageId);
            continue;
        }
        const root = await findRootMessage(chatId, link.messageId);
        const rootId = root?.messageId ?? link.messageId;
        if (rootId === targetRootId) {
            result.alreadyInTree.push(link.messageId);
            continue;
        }
        rootIds.add(rootId);
    }

    await saveMessageLinks(chatId, commandMessageId, [...rootIds]);
    result.attachedRoots = rootIds.size;
    return result;
};

/** User-facing notice about the links that could not be spliced in; null if all went in */
export const describeLinkProblems = (result: LinkAttachmentResult): string | null => {
    const lines: string[] = [];
    if (result.foreign.length) {
        lines.push(`只能拼接本群的消息链接，跳过了 ${result.foreign.length} 条别处的链接`);
    }
    for (const messageId of result.missing) {
        lines.push(`找不到消息 ${messageId}（可能太早或未入库）`);
    }
    for (const messageId of result.alreadyInTree) {
        lines.push(`消息 ${messageId} 已经在同一个上下文里`);
    }
    return lines.length ? lines.join('\n') : null;
};
