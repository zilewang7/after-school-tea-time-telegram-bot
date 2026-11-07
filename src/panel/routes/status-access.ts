/**
 * Which chats of the status page the requester may see, and as what. Only
 * chats that actually have a live reply or a recent error are asked about.
 * The owner's are resolved one by one (member or observer); anyone else only
 * ever gets their candidate chats looked up — own private chat, groups they
 * spoke in, the start_param hint (listAccessibleChats, design §4.3) — so a
 * poll every 5s never probes chats they have nothing to do with.
 */
import { listAccessibleChats, MembershipUnavailableError } from '../access/chat-access.js';
import { parseStartParam, resolveHintChatId } from '../auth/start-param.js';
import type { RequestAuth } from '../context.js';
import { findIssueChatId } from '../queries/harness-issues.js';
import type { ChatAccess, VisibleAccess } from '../types.js';

const isVisible = (access: ChatAccess): access is VisibleAccess => access === 'member' || access === 'observer';

/** A rate-limited lookup hides the chat for this poll instead of failing the page */
const resolveForStatus = async (auth: RequestAuth, chatId: number): Promise<ChatAccess> => {
    try {
        return await auth.access.resolve(chatId);
    } catch (error) {
        if (error instanceof MembershipUnavailableError) return 'none';
        throw error;
    }
};

const resolveForOwner = async (auth: RequestAuth, chatIds: ReadonlySet<number>): Promise<Map<number, VisibleAccess>> => {
    const resolved = await Promise.all(
        [...chatIds].map(async (chatId): Promise<[number, ChatAccess]> => [chatId, await resolveForStatus(auth, chatId)])
    );
    const visible = new Map<number, VisibleAccess>();
    for (const [chatId, access] of resolved) {
        if (isVisible(access)) visible.set(chatId, access);
    }
    return visible;
};

const resolveForCandidate = async (auth: RequestAuth, chatIds: ReadonlySet<number>): Promise<Map<number, VisibleAccess>> => {
    const hintChatId = await resolveHintChatId(parseStartParam(auth.startParam), findIssueChatId);
    const accessible = await listAccessibleChats(auth.access, hintChatId);
    return new Map(
        accessible.filter(({ chat }) => chatIds.has(chat.chatId)).map(({ chat, access }) => [chat.chatId, access])
    );
};

export const resolveStatusAccess = async (
    auth: RequestAuth,
    chatIds: ReadonlySet<number>
): Promise<Map<number, VisibleAccess>> => {
    if (chatIds.size === 0) return new Map();
    return auth.user.isOwner ? resolveForOwner(auth, chatIds) : resolveForCandidate(auth, chatIds);
};
