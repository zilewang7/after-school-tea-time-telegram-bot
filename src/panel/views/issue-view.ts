/**
 * Harness issues as the panel API returns them: a summary per list row, the
 * full record for the detail page. Chats are named like everywhere else in
 * the panel (title + @username); people by their display name.
 */
import type { ChatRow, ChatType } from '../../db/queries/panel-registry.js';
import type { HarnessIssueRecord, HarnessIssueSource } from '../../services/harness-issue-service.js';
import type { ChatAccess } from '../types.js';
import { displayNameOf, lookupDisplayNames, type DisplayNames } from './display-names.js';

export interface IssueChatView {
    chatId: number;
    /** null when the chat is not in the registry */
    type: ChatType | null;
    /** Group title or the private chat user's full name; null until named */
    title: string | null;
    /** Public @username, without the @ */
    username: string | null;
}

export interface IssueCreatorView {
    userId: number;
    /** First + last name; 「用户 <id>」 when the roster does not know them */
    name: string;
}

export interface IssueSummaryView {
    id: number;
    /** open | triaged | fixed | wontfix | duplicate */
    status: string;
    /** bug | improvement | feature */
    kind: string;
    /** low | medium | high; null when not given */
    severity: string | null;
    title: string;
    source: HarnessIssueSource;
    toolName: string | null;
    /** null when filed on no chat */
    chat: IssueChatView | null;
    /** The filing person; null for the model's issues */
    createdBy: IssueCreatorView | null;
    hasNote: boolean;
    createdAt: string;
    updatedAt: string;
}

/** `unavailable`: Telegram rate-limited the membership lookup (the chat itself may still open) */
export type IssueChatAccess = ChatAccess | 'unavailable';

export interface IssueDetailView extends IssueSummaryView {
    body: string;
    /** The owner's handling note */
    note: string | null;
    /** The requester's access to the issue's chat, i.e. whether it can be opened; null without a chat */
    chatAccess: IssueChatAccess | null;
}

export type ChatsById = ReadonlyMap<number, ChatRow>;

const toIssueChatView = (chatId: number | null, chats: ChatsById): IssueChatView | null => {
    if (chatId === null) return null;
    const chat = chats.get(chatId);
    return {
        chatId,
        type: chat?.type ?? null,
        title: chat?.title ?? null,
        username: chat?.username ?? null,
    };
};

const creatorIdOf = (record: HarnessIssueRecord): number | null =>
    record.source === 'user' ? record.createdBy : null;

const toCreatorView = (record: HarnessIssueRecord, names: DisplayNames): IssueCreatorView | null => {
    const creatorId = creatorIdOf(record);
    return creatorId === null ? null : { userId: creatorId, name: displayNameOf(names, creatorId) };
};

const toIssueSummary = (record: HarnessIssueRecord, chats: ChatsById, names: DisplayNames): IssueSummaryView => ({
    id: record.id,
    status: record.status,
    kind: record.kind,
    severity: record.severity,
    title: record.title,
    source: record.source,
    toolName: record.toolName,
    chat: toIssueChatView(record.chatId, chats),
    createdBy: toCreatorView(record, names),
    hasNote: record.note !== null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
});

const creatorNamesOf = (records: readonly HarnessIssueRecord[]): Promise<DisplayNames> => {
    const creatorIds = records.flatMap((record) => {
        const creatorId = creatorIdOf(record);
        return creatorId === null ? [] : [creatorId];
    });
    return lookupDisplayNames(creatorIds);
};

/** List rows, with one batched name lookup for every creator */
export const toIssueSummaryViews = async (
    records: readonly HarnessIssueRecord[],
    chats: ChatsById
): Promise<IssueSummaryView[]> => {
    const names = await creatorNamesOf(records);
    return records.map((record) => toIssueSummary(record, chats, names));
};

export const toIssueDetailView = async (
    record: HarnessIssueRecord,
    chat: ChatRow | null,
    chatAccess: IssueChatAccess | null
): Promise<IssueDetailView> => {
    const names = await creatorNamesOf([record]);
    const chats: ChatsById = chat === null ? new Map() : new Map([[chat.chatId, chat]]);
    return {
        ...toIssueSummary(record, chats, names),
        body: record.body,
        note: record.note,
        chatAccess,
    };
};
