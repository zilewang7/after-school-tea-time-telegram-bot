/**
 * The conversation list of GET …/conversations: the last 7 days of replies
 * (what the database keeps), grouped by the root of their trigger's reply
 * chain (read-only, never backfilled), most recently active first, paged by a
 * `<lastActivityAt ISO>_<rootId>` cursor.
 *
 * A conversation's last activity is its newest reply's last write (finalize,
 * version switch). Grouping reads reply heads only (the versions column holds
 * every image as base64); full rows are read for the page alone. The root
 * summary follows the tree's rule: members see the author and the first 40
 * characters; observers see only that a user message started it (a bot root
 * is bot output and shows for both).
 */
import type { BotResponse } from '../../db/index.js';
import {
    findRootMessage,
    getContextMessage,
    listBotResponsesByIds,
    listReplyHeadsSince,
    type ContextMessage,
    type ReplyHead,
} from '../../db/queries/context-queries.js';
import { findTelegramUsersByIds } from '../../db/queries/user-queries.js';
import { isBotReplyInFlight } from '../../state.js';
import type { VisibleAccess } from '../types.js';
import { loadConversationMessages } from './conversation-tree.js';
import { modelOfVersion } from './reply-view.js';
import type { AuthorView } from './tree-nodes.js';

/** What the database keeps; the list never reaches further back */
const LIST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ROOT_EXCERPT_CHARS = 40;
const LEGACY_EOF_MARKER = /\s*<<EOF\s*$/;

export interface ConversationCursor {
    lastActivityAt: Date;
    rootId: number;
}

export interface ObserverUserRootView {
    messageId: number;
    date: string;
    kind: 'user';
    redacted: true;
    excluded: boolean;
}

export interface MemberUserRootView {
    messageId: number;
    date: string;
    kind: 'user';
    redacted: false;
    excluded: boolean;
    author: AuthorView;
    excerpt: string;
}

export interface BotRootView {
    messageId: number;
    date: string;
    kind: 'bot';
    excluded: boolean;
    excerpt: string;
}

export type RootSummaryView = ObserverUserRootView | MemberUserRootView | BotRootView;

export interface ConversationListItem {
    rootId: number;
    lastActivityAt: string;
    /** Messages of the reply tree, excluded ones included */
    messageCount: number;
    /** Bot replies answering a message of this conversation */
    replyCount: number;
    /** Model of the most recently generated version */
    lastModel: string | null;
    generating: boolean;
    /** Some version of some reply ended with an error */
    hasError: boolean;
    root: RootSummaryView;
}

export interface ConversationListView {
    conversations: ConversationListItem[];
    /** Cursor of the next page; null on the last one */
    nextBefore: string | null;
}

interface ConversationGroup {
    rootId: number;
    replies: ReplyHead[];
    lastActivityAt: Date;
}

const CURSOR_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)_(\d{1,15})$/;

/** null when the cursor is malformed */
export const parseConversationCursor = (raw: string): ConversationCursor | null => {
    const matched = CURSOR_PATTERN.exec(raw);
    if (matched === null || matched[1] === undefined || matched[2] === undefined) return null;
    const lastActivityAt = new Date(matched[1]);
    const rootId = Number(matched[2]);
    if (Number.isNaN(lastActivityAt.getTime()) || !Number.isSafeInteger(rootId)) return null;
    return { lastActivityAt, rootId };
};

const formatCursor = (group: ConversationGroup): string => `${group.lastActivityAt.toISOString()}_${group.rootId}`;

/** Newest first; ties broken by the larger root id */
const compareGroups = (a: ConversationGroup, b: ConversationGroup): number =>
    b.lastActivityAt.getTime() - a.lastActivityAt.getTime() || b.rootId - a.rootId;

const isBeforeCursor = (group: ConversationGroup, cursor: ConversationCursor): boolean => {
    const time = group.lastActivityAt.getTime();
    const cursorTime = cursor.lastActivityAt.getTime();
    return time < cursorTime || (time === cursorTime && group.rootId < cursor.rootId);
};

/** Every reply under the root of its trigger's chain (its own chain when the trigger is gone) */
const groupRepliesByRoot = async (chatId: number, replies: readonly ReplyHead[]): Promise<ConversationGroup[]> => {
    const cache = new Map<number, ContextMessage | null>();
    const byRoot = new Map<number, ReplyHead[]>();
    for (const reply of replies) {
        const root =
            (await findRootMessage(chatId, reply.userMessageId, { recover: false, cache })) ??
            (await findRootMessage(chatId, reply.messageId, { recover: false, cache }));
        if (root === null) continue;
        const group = byRoot.get(root.messageId);
        if (group === undefined) byRoot.set(root.messageId, [reply]);
        else group.push(reply);
    }
    return [...byRoot].map(([rootId, grouped]) => ({
        rootId,
        replies: grouped,
        lastActivityAt: new Date(Math.max(...grouped.map((reply) => reply.updatedAt.getTime()))),
    }));
};

/** The model of the newest version across the group's replies */
const lastModelOf = (replies: readonly BotResponse[]): string | null => {
    let newest: { time: number; model: string | null } | null = null;
    for (const reply of replies) {
        for (const version of reply.getVersions()) {
            const time = Date.parse(version.createdAt);
            const comparable = Number.isNaN(time) ? 0 : time;
            if (newest === null || comparable >= newest.time) {
                newest = { time: comparable, model: modelOfVersion(version, reply) };
            }
        }
    }
    return newest?.model ?? null;
};

const hasErrorIn = (replies: readonly BotResponse[]): boolean =>
    replies.some((reply) =>
        reply.getVersions().some((version) => typeof version.errorMessage === 'string' && version.errorMessage !== '')
    );

/** One line, at most 40 characters; a message without words shows what it is */
const excerptOf = (message: ContextMessage): string => {
    const words = (message.text ?? '').replace(LEGACY_EOF_MARKER, '').replace(/\s+/g, ' ').trim();
    if (words === '') {
        if (message.chatCommand) return '[/chat]';
        return message.mediaHint ? `[${message.mediaHint}]` : '';
    }
    const characters = Array.from(words);
    return characters.length > ROOT_EXCERPT_CHARS
        ? `${characters.slice(0, ROOT_EXCERPT_CHARS).join('')}…`
        : words;
};

const usernameOf = async (userId: number | null): Promise<string | null> => {
    if (userId === null || userId <= 0) return null;
    const [user] = await findTelegramUsersByIds([userId]);
    return user?.username ?? null;
};

const toRootSummary = async (root: ContextMessage, access: VisibleAccess): Promise<RootSummaryView> => {
    const excluded = root.excludedFromContext === true;
    const date = root.date.toISOString();
    if (root.fromBotSelf) {
        return { messageId: root.messageId, date, kind: 'bot', excluded, excerpt: excerptOf(root) };
    }
    if (access === 'observer') {
        return { messageId: root.messageId, date, kind: 'user', redacted: true, excluded };
    }
    return {
        messageId: root.messageId,
        date,
        kind: 'user',
        redacted: false,
        excluded,
        author: { userId: root.userId, name: root.userName, username: await usernameOf(root.userId) },
        excerpt: excerptOf(root),
    };
};

const toListItem = async (
    chatId: number,
    group: ConversationGroup,
    access: VisibleAccess
): Promise<ConversationListItem | null> => {
    const messages = await loadConversationMessages(chatId, group.rootId);
    const root =
        messages.find((message) => message.messageId === group.rootId) ??
        (await getContextMessage(chatId, group.rootId));
    if (root === null) return null;
    const replies = await listBotResponsesByIds(
        chatId,
        group.replies.map((reply) => reply.messageId)
    );
    return {
        rootId: group.rootId,
        lastActivityAt: group.lastActivityAt.toISOString(),
        messageCount: messages.length,
        replyCount: group.replies.length,
        lastModel: lastModelOf(replies),
        generating: group.replies.some((reply) => isBotReplyInFlight(chatId, reply.messageId)),
        hasError: hasErrorIn(replies),
        root: await toRootSummary(root, access),
    };
};

export const buildConversationListView = async (options: {
    chatId: number;
    access: VisibleAccess;
    limit: number;
    before: ConversationCursor | null;
    now: Date;
}): Promise<ConversationListView> => {
    const { chatId, access, limit, before } = options;
    const replies = await listReplyHeadsSince(chatId, new Date(options.now.getTime() - LIST_WINDOW_MS));
    const groups = (await groupRepliesByRoot(chatId, replies))
        .filter((group) => before === null || isBeforeCursor(group, before))
        .sort(compareGroups);
    const page = groups.slice(0, limit);

    const conversations: ConversationListItem[] = [];
    for (const group of page) {
        const item = await toListItem(chatId, group, access);
        if (item !== null) conversations.push(item);
    }
    const last = page.at(-1);
    return {
        conversations,
        nextBefore: groups.length > limit && last !== undefined ? formatCursor(last) : null,
    };
};
