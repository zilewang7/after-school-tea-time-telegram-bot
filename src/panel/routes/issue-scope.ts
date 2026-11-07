/**
 * Who sees which issues (design §6.7).
 *
 * The list: the owner sees every issue, those without a chat included;
 * anyone else the issues of the chats they are a member of — their candidate
 * set plus the start_param hint, so a member who arrives through a group
 * notice (`i<N>`) sees it without ever having spoken there.
 *
 * One issue: its chat decides. A member sees it; anyone else gets the same
 * 404 as for a missing issue. The owner sees every issue, whatever the chat
 * (the membership lookup only tells whether the chat opens for them); an
 * issue without a chat is the owner's alone.
 */
import { listChats, type ChatRow } from '../../db/queries/panel-registry.js';
import type { HarnessIssueRecord } from '../../services/harness-issue-service.js';
import { listAccessibleChats, MembershipUnavailableError } from '../access/chat-access.js';
import { parseStartParam, resolveHintChatId } from '../auth/start-param.js';
import type { RequestAuth } from '../context.js';
import { PanelError } from '../errors.js';
import { findIssueChatId } from '../queries/harness-issues.js';
import type { ChatsById, IssueChatAccess } from '../views/issue-view.js';

/** Missing and not visible read the same */
export const issueNotFound = (): PanelError => new PanelError('not_found', '找不到该 issue');

export interface IssueListScope {
    /** null = every issue (the owner) */
    visibleChatIds: readonly number[] | null;
    /** Registry rows for naming the chats on the page */
    chats: ChatsById;
}

const byChatId = (chats: readonly ChatRow[]): ChatsById => new Map(chats.map((chat) => [chat.chatId, chat]));

export const issueListScopeOf = async (auth: RequestAuth): Promise<IssueListScope> => {
    if (auth.user.isOwner) return { visibleChatIds: null, chats: byChatId(await listChats()) };
    const hintChatId = await resolveHintChatId(parseStartParam(auth.startParam), findIssueChatId);
    const memberChats = (await listAccessibleChats(auth.access, hintChatId))
        .filter((accessible) => accessible.access === 'member')
        .map((accessible) => accessible.chat);
    return { visibleChatIds: memberChats.map((chat) => chat.chatId), chats: byChatId(memberChats) };
};

/** The owner's access to an issue's chat, which only decides whether the chat can be opened */
const ownerChatAccessOf = async (auth: RequestAuth, chatId: number): Promise<IssueChatAccess> => {
    try {
        return await auth.access.resolve(chatId);
    } catch (error) {
        if (error instanceof MembershipUnavailableError) return 'unavailable';
        throw error;
    }
};

/**
 * Let the request see one issue: resolves with the requester's access to the
 * issue's chat (null when it has none), or throws the not-found 404. A
 * non-owner whose membership lookup Telegram rate-limits gets the usual 503
 * (MembershipUnavailableError, mapped by the error handler).
 */
export const requireIssueVisible = async (
    auth: RequestAuth,
    record: HarnessIssueRecord
): Promise<IssueChatAccess | null> => {
    const chatId = record.chatId;
    if (chatId === null) {
        if (auth.user.isOwner) return null;
        throw issueNotFound();
    }
    if (auth.user.isOwner) return ownerChatAccessOf(auth, chatId);
    const access = await auth.access.resolve(chatId);
    if (access === 'none') throw issueNotFound();
    return access;
};
