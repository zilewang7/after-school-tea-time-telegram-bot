/**
 * Access applications as the panel API returns them: the applicant named from
 * the user roster (display name and raw @handle), the source chat named from the
 * chat registry. One row per application; every lookup is batched per call.
 */
import type { ChatRow, ChatType } from '../../db/queries/panel-registry.js';
import { findChat } from '../../db/queries/panel-registry.js';
import type { AccessApplicationRecord } from '../../services/user-access-service.js';
import { lookupUserProfiles, userProfileOf, type UserProfiles } from './display-names.js';

export interface AccessApplicationView {
    id: number;
    userId: number;
    /** The applicant's display name; 「用户 <id>」 when the roster does not know them */
    userName: string;
    /** Without the @; null when the roster knows no handle */
    username: string | null;
    chatId: number;
    /** Group title or the private chat user's name; null until the registry knows it */
    chatTitle: string | null;
    chatType: ChatType | null;
    identity: string;
    purpose: string;
    source: 'command' | 'miniapp';
    status: 'pending' | 'approved' | 'rejected';
    comment: string | null;
    /** ISO */
    createdAt: string;
    /** ISO; null while pending */
    reviewedAt: string | null;
    deliveryStatus: 'sent' | 'failed' | null;
    deliveryError: string | null;
}

type ChatsById = ReadonlyMap<number, ChatRow | null>;

/** One findChat per distinct chat id; null when the registry does not know it */
const loadChats = async (chatIds: readonly number[]): Promise<ChatsById> => {
    const distinctIds = [...new Set(chatIds)];
    const rows = await Promise.all(distinctIds.map((chatId) => findChat(chatId)));
    return new Map(distinctIds.map((chatId, index) => [chatId, rows[index] ?? null]));
};

interface ViewContext {
    profiles: UserProfiles;
    chats: ChatsById;
}

const loadContext = async (records: readonly AccessApplicationRecord[]): Promise<ViewContext> => {
    const [profiles, chats] = await Promise.all([
        lookupUserProfiles(records.map((record) => record.userId)),
        loadChats(records.map((record) => record.chatId)),
    ]);
    return { profiles, chats };
};

const toView = (record: AccessApplicationRecord, context: ViewContext): AccessApplicationView => {
    const profile = userProfileOf(context.profiles, record.userId);
    const chat = context.chats.get(record.chatId) ?? null;
    return {
        id: record.id,
        userId: record.userId,
        userName: profile.name,
        username: profile.username,
        chatId: record.chatId,
        chatTitle: chat?.title ?? null,
        chatType: chat?.type ?? null,
        identity: record.identity,
        purpose: record.purpose,
        source: record.source,
        status: record.status,
        comment: record.comment,
        createdAt: record.createdAt.toISOString(),
        reviewedAt: record.reviewedAt === null ? null : record.reviewedAt.toISOString(),
        deliveryStatus: record.deliveryStatus,
        deliveryError: record.deliveryError,
    };
};

export const toAccessApplicationView = async (
    record: AccessApplicationRecord
): Promise<AccessApplicationView> => toView(record, await loadContext([record]));

export const toAccessApplicationViews = async (
    records: readonly AccessApplicationRecord[]
): Promise<AccessApplicationView[]> => {
    const context = await loadContext(records);
    return records.map((record) => toView(record, context));
};
