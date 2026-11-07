/**
 * Who may see which chat in the panel (design §4.3).
 *
 * Order: the instance's chat allow-list (the HTTP path bypasses grammy's
 * gate), then the user's own private chat (member even before a chats row
 * exists; the row is created from initData), then the registry (unknown chat
 * = none, never distinguished from "not yours"), then the Bot API membership.
 * Only an `unknown` membership (network / 5xx) falls back to "spoke here in
 * the last 30 days"; a 429 makes the chat temporarily unanswerable. Everyone
 * else who is not a member is `none`, except the owner, who observes.
 *
 * A resolver lives for one request and memoizes per chat; nothing negative is
 * kept across requests.
 */
import { match } from 'ts-pattern';
import { isChatAllowed } from '../../config/instance.js';
import {
    ensurePrivateChatRow,
    findChat,
    listChats,
    listGroupChatIdsSpokenIn,
    spokeWithinDays,
    type ChatRow,
} from '../../db/queries/panel-registry.js';
import type { ChatAccess, PanelUser, VisibleAccess } from '../types.js';
import type { MembershipChecker } from './membership.js';

/** How far back a spoken message still vouches for membership when the API cannot answer */
const SPOKEN_FALLBACK_DAYS = 30;

/** The Bot API rate-limited the membership lookup: single-chat endpoints answer 503 */
export class MembershipUnavailableError extends Error {
    readonly chatId: number;

    constructor(chatId: number) {
        super(`membership of chat ${chatId} is temporarily unavailable`);
        this.name = 'MembershipUnavailableError';
        this.chatId = chatId;
    }
}

const accessWithoutMembership = (user: PanelUser): ChatAccess => (user.isOwner ? 'observer' : 'none');

/** One chat's access level for one user; throws MembershipUnavailableError on a Bot API 429 */
export const resolveChatAccess = async (
    user: PanelUser,
    chatId: number,
    checker: MembershipChecker
): Promise<ChatAccess> => {
    if (!isChatAllowed(chatId)) return 'none';
    if (chatId === user.id) {
        await ensurePrivateChatRow({
            id: user.id,
            first_name: user.firstName,
            last_name: user.lastName ?? undefined,
            username: user.username ?? undefined,
        });
        return 'member';
    }
    const chat = await findChat(chatId);
    if (chat === null) return 'none';

    const membership = await checker.checkMembership(chat, user.id);
    return match(membership)
        .returnType<Promise<ChatAccess>>()
        .with('member', () => Promise.resolve('member'))
        .with('throttled', () => Promise.reject(new MembershipUnavailableError(chatId)))
        .with('unknown', async () =>
            (await spokeWithinDays(chatId, user.id, SPOKEN_FALLBACK_DAYS)) ? 'member' : accessWithoutMembership(user)
        )
        .with('not_member', () => Promise.resolve(accessWithoutMembership(user)))
        .exhaustive();
};

/** Per-request access lookups, memoized by chat */
export interface ChatAccessResolver {
    readonly user: PanelUser;
    /** May reject with MembershipUnavailableError */
    resolve(chatId: number): Promise<ChatAccess>;
}

export const createChatAccessResolver = (user: PanelUser, checker: MembershipChecker): ChatAccessResolver => {
    const memo = new Map<number, Promise<ChatAccess>>();
    return {
        user,
        resolve: (chatId) => {
            const known = memo.get(chatId);
            if (known !== undefined) return known;
            const pending = resolveChatAccess(user, chatId, checker);
            memo.set(chatId, pending);
            return pending;
        },
    };
};

export interface AccessibleChat {
    chat: ChatRow;
    access: VisibleAccess;
}

/**
 * Chats a non-owner may even be asked about: their own private chat, the
 * groups they have spoken in, and the start_param hint. Everything else is
 * `none` without a lookup.
 */
const candidateChatIds = async (user: PanelUser, hintChatId: number | null): Promise<Set<number>> => {
    const spokenIn = await listGroupChatIdsSpokenIn(user.id);
    const candidates = new Set<number>([user.id, ...spokenIn]);
    if (hintChatId !== null) candidates.add(hintChatId);
    return candidates;
};

/** Resolve without failing the whole list: a rate-limited chat is skipped */
const resolveForList = async (resolver: ChatAccessResolver, chatId: number): Promise<ChatAccess> => {
    try {
        return await resolver.resolve(chatId);
    } catch (error) {
        if (error instanceof MembershipUnavailableError) return 'none';
        throw error;
    }
};

const isVisible = (access: ChatAccess | undefined): access is VisibleAccess =>
    access === 'member' || access === 'observer';

/**
 * Every chat the user can open, most recently active first. The owner gets
 * every registered chat (member or observer); anyone else only the members of
 * their candidate set. Lookups run concurrently, each under its own deadline.
 */
export const listAccessibleChats = async (
    resolver: ChatAccessResolver,
    hintChatId: number | null = null
): Promise<AccessibleChat[]> => {
    const user = resolver.user;
    // First, so the private chat's row exists before the registry is read
    if (isChatAllowed(user.id)) await resolveForList(resolver, user.id);

    const registered = await listChats();
    const candidates = user.isOwner
        ? new Set(registered.map((chat) => chat.chatId))
        : await candidateChatIds(user, hintChatId);

    const accessByChat = new Map<number, ChatAccess>();
    await Promise.all(
        [...candidates].map(async (chatId) => {
            accessByChat.set(chatId, await resolveForList(resolver, chatId));
        })
    );

    return registered.flatMap((chat) => {
        const access = accessByChat.get(chat.chatId);
        return isVisible(access) ? [{ chat, access }] : [];
    });
};
