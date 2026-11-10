/**
 * The conversation tree of GET …/conversations/:rootId: every message of the
 * reply tree (excluded ones kept, flagged and unnumbered) plus the replied-to
 * messages pulled in from outside it, numbered exactly as buildContext numbers
 * them for the same trigger (both go through assembleContextMessages).
 *
 * Read-only: no luoxu backfill, no media bytes, nothing published to the
 * process state. Members get full user nodes; observers get the eight-field
 * placeholder (tree-nodes.ts).
 */
import {
    findRootMessage,
    getRepliesHistory,
    listBotResponsesByIds,
    type ContextMessage,
} from '../../db/queries/context-queries.js';
import type { BotResponse } from '../../db/index.js';
import type { ChatRow } from '../../db/queries/panel-registry.js';
import { findTelegramUsersByIds } from '../../db/queries/user-queries.js';
import { assembleContextMessages, type AssembledContext } from '../../reply/context-assembly.js';
import { describeMessageAnnotations } from '../../reply/context-builder.js';
import { getRepliesInFlight, isBotReplyInFlight } from '../../state.js';
import type { VisibleAccess } from '../types.js';
import { runtimeChatTitleOf } from './chat-view.js';
import { buildLinkPreviewTexts } from './message-previews.js';
import { toReplySummaryView } from './reply-view.js';
import { placeTreeMessages } from './tree-edges.js';
import { loadMessageMediaViews, toPreviewMediaViews, type MediaView } from './media-view.js';
import { loadLinkPreviewMediaDescriptors } from '../media/media-content.js';
import type { SignedMediaSigner } from '../share/signed-media.js';
import {
    toBotNode,
    toMemberUserNode,
    toObserverUserNode,
    type MemberNodeExtras,
    type TreeNode,
} from './tree-nodes.js';

export interface ConversationTreeView {
    rootId: number;
    /** The message the `#N` are computed for: the newest one of this conversation's own reply chain */
    triggerId: number;
    /** A reply in this conversation is being generated right now */
    generating: boolean;
    /** Chronological */
    nodes: TreeNode[];
}

const byMessageId = (a: ContextMessage, b: ContextMessage): number => a.messageId - b.messageId;

/** Every message of the conversation rooted at `rootId`, excluded ones flagged; read-only */
export const loadConversationMessages = (chatId: number, rootId: number): Promise<ContextMessage[]> =>
    getRepliesHistory(chatId, rootId, { recover: false, includeExcluded: true });

/**
 * The newest message whose own reply chain leads back to `rootId`. A message
 * spliced in from another conversation has another root, and assembling from
 * it would number that other conversation.
 */
export const findTreeTrigger = async (
    chatId: number,
    rootId: number,
    messages: readonly ContextMessage[]
): Promise<number> => {
    const cache = new Map<number, ContextMessage | null>();
    const newestFirst = [...messages].sort((a, b) => b.messageId - a.messageId);
    for (const message of newestFirst) {
        if (message.messageId === rootId) return rootId;
        const root = await findRootMessage(chatId, message.messageId, { recover: false, cache });
        if (root?.messageId === rootId) return message.messageId;
    }
    return rootId;
};

/** The context of the next reply in this conversation, excluded messages kept */
export const assembleConversation = async (chatId: number, rootId: number): Promise<AssembledContext> => {
    const history = await loadConversationMessages(chatId, rootId);
    const triggerId = await findTreeTrigger(chatId, rootId, history);
    return assembleContextMessages(chatId, triggerId, { recover: false, includeExcluded: true });
};

const usernamesOf = async (messages: readonly ContextMessage[]): Promise<Map<number, string>> => {
    const userIds = [
        ...new Set(messages.map((message) => message.userId).filter((id): id is number => id !== null && id > 0)),
    ];
    const users = await findTelegramUsersByIds(userIds);
    const usernames = new Map<number, string>();
    for (const user of users) {
        if (user.username) usernames.set(user.userId, user.username);
    }
    return usernames;
};

/** Annotations, previews and usernames of the user messages, for members only */
const buildMemberExtras = async (
    chat: ChatRow,
    assembled: AssembledContext,
    messages: readonly ContextMessage[]
): Promise<Map<number, MemberNodeExtras>> => {
    const userMessages = messages.filter((message) => !message.fromBotSelf);
    const previews = await buildLinkPreviewTexts(
        chat.chatId,
        assembled.messages,
        assembled.numbering,
        runtimeChatTitleOf(chat)
    );
    const usernames = await usernamesOf(userMessages);
    const extras = new Map<number, MemberNodeExtras>();
    for (const message of userMessages) {
        extras.set(message.messageId, {
            annotations: await describeMessageAnnotations(message, assembled),
            linkPreview: previews.get(message.messageId) ?? null,
            username: message.userId === null ? null : (usernames.get(message.userId) ?? null),
        });
    }
    return extras;
};

/** A reply of the conversation is streaming, or a message of it is being answered */
export const isConversationGenerating = (chatId: number, messages: readonly ContextMessage[]): boolean => {
    const answering = new Set(getRepliesInFlight(chatId));
    return messages.some((message) =>
        message.fromBotSelf ? isBotReplyInFlight(chatId, message.messageId) : answering.has(message.messageId)
    );
};

const EMPTY_EXTRAS: MemberNodeExtras = { annotations: [], linkPreview: null, username: null };

const loadPreviewMediaViews = async (
    signer: SignedMediaSigner,
    chatId: number,
    messages: readonly ContextMessage[]
): Promise<Map<number, MediaView[]>> => {
    const descriptors = await loadLinkPreviewMediaDescriptors(messages);
    const views = new Map<number, MediaView[]>();
    for (const [messageId, previews] of descriptors) {
        views.set(messageId, toPreviewMediaViews(signer, chatId, messageId, previews));
    }
    return views;
};

export interface ConversationTreeOptions {
    /** Signs the `/m/…` URLs of every media the tree shows */
    mediaSigner: SignedMediaSigner;
}

export const buildConversationTreeView = async (
    chat: ChatRow,
    access: VisibleAccess,
    rootId: number,
    options?: ConversationTreeOptions
): Promise<ConversationTreeView> => {
    const chatId = chat.chatId;
    const assembled = await assembleConversation(chatId, rootId);
    const messages = [...assembled.messages, ...assembled.excludedMessages].sort(byMessageId);
    const placements = await placeTreeMessages(chatId, rootId, messages, assembled.replyTargetIds);
    const botIds = messages.filter((message) => message.fromBotSelf).map((message) => message.messageId);
    const responses = new Map<number, BotResponse>(
        (await listBotResponsesByIds(chatId, botIds)).map((response) => [response.messageId, response])
    );
    const memberExtras = access === 'member' ? await buildMemberExtras(chat, assembled, messages) : null;
    // Observers see redacted user nodes, and the markdown export carries no URLs:
    // media is signed only when a caller asked for a panel tree.
    const mediaSigner = options?.mediaSigner;
    const userMessages = messages.filter((message) => !message.fromBotSelf);
    const mediaByMessageId = access === 'member' && mediaSigner !== undefined
        ? await loadMessageMediaViews(mediaSigner, chatId, userMessages)
        : new Map();
    const previewMediaByMessageId = access === 'member' && mediaSigner !== undefined
        ? await loadPreviewMediaViews(mediaSigner, chatId, userMessages)
        : new Map();

    const nodes = messages.map((message): TreeNode => {
        const placement = placements.get(message.messageId) ?? { parentId: null, edge: null };
        const position = { number: assembled.numbering.numberOf.get(message.messageId) ?? null, ...placement };
        if (message.fromBotSelf) {
            return toBotNode(
                message,
                position,
                toReplySummaryView(responses.get(message.messageId), message, mediaSigner)
            );
        }
        if (memberExtras === null) return toObserverUserNode(message, position);
        return toMemberUserNode(
            message,
            position,
            memberExtras.get(message.messageId) ?? EMPTY_EXTRAS,
            chat,
            mediaByMessageId.get(message.messageId) ?? null,
            previewMediaByMessageId.get(message.messageId) ?? []
        );
    });

    return {
        rootId,
        triggerId: assembled.triggerId,
        generating: isConversationGenerating(chatId, messages),
        nodes,
    };
};
