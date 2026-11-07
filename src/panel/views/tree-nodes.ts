/**
 * The node shapes of the conversation tree (design §6.2), and how observers
 * are cut down. Every message the bot did not write itself is a user message,
 * other bots included. An observer's user node carries exactly eight fields —
 * id, time, tree position and the excluded flag — and nothing about who wrote
 * it or what it says; bot nodes are the same for members and observers.
 */
import { canonicalTelegramMessageLink } from '../../reply/commands/telegram-message-link.js';
import type { ContextMessage } from '../../db/queries/context-queries.js';
import type { ChatRow } from '../../db/queries/panel-registry.js';
import type { ReplySummaryView } from './reply-view.js';
import type { TreeEdge } from './tree-edges.js';

/** Where a node sits; observers keep exactly this much of a user message */
interface NodePosition {
    messageId: number;
    /** `#N` in the model's context; null when excluded (or not in the context) */
    number: number | null;
    /** ISO time */
    date: string;
    parentId: number | null;
    edge: TreeEdge | null;
}

export interface AuthorView {
    /** null on rows stored before author ids were recorded; 0 on luoxu backfills */
    userId: number | null;
    /** The name the model reads (the stored first name) */
    name: string;
    username: string | null;
}

export interface ObserverUserNode extends NodePosition {
    kind: 'user';
    redacted: true;
    excluded: boolean;
}

export interface MemberUserNode extends NodePosition {
    kind: 'user';
    redacted: false;
    author: AuthorView;
    /** Plain text, newlines kept */
    text: string | null;
    quote: string | null;
    /** The header annotations the model reads, e.g. `[replying to #2 Mio]` */
    annotations: string[];
    mediaHint: string | null;
    linkPreview: string | null;
    ocrText: string | null;
    excluded: boolean;
    /** Supergroups only: t.me/c/<internal id>/<message id> */
    telegramLink: string | null;
}

export interface BotNode extends NodePosition {
    kind: 'bot';
    excluded: boolean;
    reply: ReplySummaryView;
}

export type TreeNode = ObserverUserNode | MemberUserNode | BotNode;

export interface TreeNodePosition {
    number: number | null;
    parentId: number | null;
    edge: TreeEdge | null;
}

/** What a member's user node shows beyond the message row itself */
export interface MemberNodeExtras {
    annotations: string[];
    linkPreview: string | null;
    username: string | null;
}

/** Rows older than the header change kept the `<<EOF` marker inside their text */
const LEGACY_EOF_MARKER = /\s*<<EOF\s*$/;

const isExcluded = (message: ContextMessage): boolean => message.excludedFromContext === true;

const SUPERGROUP_ID_UPPER_BOUND = -1_000_000_000_000;

/** Jump link into Telegram; only supergroup messages can be linked to */
export const telegramLinkOf = (chat: Pick<ChatRow, 'chatId' | 'type'>, messageId: number): string | null =>
    chat.type === 'supergroup' && chat.chatId <= SUPERGROUP_ID_UPPER_BOUND
        ? canonicalTelegramMessageLink({ chatRef: { type: 'internal', chatId: chat.chatId }, messageId })
        : null;

export const toObserverUserNode = (message: ContextMessage, position: TreeNodePosition): ObserverUserNode => ({
    messageId: message.messageId,
    number: position.number,
    date: message.date.toISOString(),
    parentId: position.parentId,
    edge: position.edge,
    kind: 'user',
    redacted: true,
    excluded: isExcluded(message),
});

export const toMemberUserNode = (
    message: ContextMessage,
    position: TreeNodePosition,
    extras: MemberNodeExtras,
    chat: Pick<ChatRow, 'chatId' | 'type'>
): MemberUserNode => ({
    messageId: message.messageId,
    number: position.number,
    date: message.date.toISOString(),
    parentId: position.parentId,
    edge: position.edge,
    kind: 'user',
    redacted: false,
    author: { userId: message.userId, name: message.userName, username: extras.username },
    text: message.text === null ? null : message.text.replace(LEGACY_EOF_MARKER, ''),
    quote: message.quoteText,
    annotations: extras.annotations,
    mediaHint: message.mediaHint,
    linkPreview: extras.linkPreview,
    ocrText: message.ocrText,
    excluded: isExcluded(message),
    telegramLink: telegramLinkOf(chat, message.messageId),
});

export const toBotNode = (message: ContextMessage, position: TreeNodePosition, reply: ReplySummaryView): BotNode => ({
    messageId: message.messageId,
    number: position.number,
    date: message.date.toISOString(),
    parentId: position.parentId,
    edge: position.edge,
    kind: 'bot',
    excluded: isExcluded(message),
    reply,
});
