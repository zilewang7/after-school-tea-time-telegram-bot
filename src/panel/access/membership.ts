/**
 * Group membership as the Bot API reports it, classified for the panel.
 *
 * | answer                                                          | result       |
 * |-----------------------------------------------------------------|--------------|
 * | creator / administrator / member, restricted with is_member     | member       |
 * | left / kicked / restricted without is_member / other statuses   | not_member   |
 * | 4xx (user not found, bot was kicked, chat not found, ...)        | not_member   |
 * | 429                                                             | throttled    |
 * | 5xx, network error, our 5s deadline                             | unknown      |
 *
 * Only `unknown` may fall back to the speaker record (chat-access); the rest
 * never do. A positive answer straight from the API is cached for 5 minutes;
 * nothing else is cached, so one short outage never lets anyone in for long.
 *
 * The lookup is injected: production passes the panel's own grammy Api (no
 * autoRetry, so a 429 is reported instead of being slept on), offline cases a
 * fake.
 */
import { GrammyError, HttpError, type Api } from 'grammy';
import { match, P } from 'ts-pattern';
import type { ChatType } from '../../db/queries/panel-registry.js';
import { toTelegramApiAbortSignal } from '../../services/telegram-file-service.js';

export type Membership = 'member' | 'not_member' | 'unknown' | 'throttled';

/** What getChatMember answers, as far as membership cares; a grammy ChatMember fits */
export interface MemberStatus {
    status: string;
    is_member?: boolean;
}

/**
 * getChatMember. Throws GrammyError for a Bot API error and HttpError for a
 * network failure, as grammy does; must honour `signal`.
 */
export type MembershipLookup = (chatId: number, userId: number, signal: AbortSignal) => Promise<MemberStatus>;

/** The chat fields a membership check needs; a ChatRow fits */
export interface MembershipChat {
    chatId: number;
    type: ChatType;
}

export interface MembershipChecker {
    checkMembership(chat: MembershipChat, userId: number): Promise<Membership>;
}

export interface MembershipCheckerOptions {
    lookup: MembershipLookup;
    /** How long a positive API answer is trusted (default 5 minutes) */
    cacheTtlMs?: number;
    /** Deadline of one lookup (default 5s) */
    timeoutMs?: number;
    /** Clock in ms, replaceable by tests */
    now?: () => number;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_LOOKUP_TIMEOUT_MS = 5000;
/** Above this many cached answers, expired ones are swept on the next write */
const CACHE_SWEEP_THRESHOLD = 1000;

/** Our own deadline expired before the lookup settled */
class LookupDeadlineError extends Error {
    constructor() {
        super('membership lookup deadline expired');
        this.name = 'LookupDeadlineError';
    }
}

export const classifyMemberStatus = (member: MemberStatus): 'member' | 'not_member' =>
    match(member)
        .returnType<'member' | 'not_member'>()
        .with({ status: P.union('creator', 'administrator', 'member') }, () => 'member')
        .with({ status: 'restricted', is_member: true }, () => 'member')
        .otherwise(() => 'not_member');

const classifyGrammyError = (error: GrammyError, chatId: number): Membership => {
    if (error.error_code === 429) return 'throttled';
    if (error.error_code >= 500) return 'unknown';
    if (error.description.toLowerCase().includes('member list is inaccessible')) {
        console.warn(`[panel] member list is inaccessible in chat ${chatId}; treating as not a member`);
    }
    return 'not_member';
};

/** An abort or timeout surfacing outside grammy (DOMException names) */
const isAbortLike = (error: unknown): boolean =>
    error instanceof LookupDeadlineError ||
    (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'));

export const classifyLookupError = (error: unknown, chatId: number): Membership => {
    if (error instanceof GrammyError) return classifyGrammyError(error, chatId);
    if (error instanceof HttpError || isAbortLike(error)) return 'unknown';
    // Not a Bot API answer nor a network failure: deny rather than fall back
    console.warn(`[panel] unexpected membership lookup failure in chat ${chatId}:`, error);
    return 'not_member';
};

/** Run the lookup with an abort signal and a hard deadline, whichever comes first */
const lookupWithDeadline = async (
    lookup: MembershipLookup,
    chatId: number,
    userId: number,
    timeoutMs: number
): Promise<MemberStatus> => {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new LookupDeadlineError());
        }, timeoutMs);
    });
    try {
        return await Promise.race([lookup(chatId, userId, controller.signal), deadline]);
    } finally {
        clearTimeout(timer);
    }
};

export const createMembershipChecker = (options: MembershipCheckerOptions): MembershipChecker => {
    const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS;
    const now = options.now ?? Date.now;
    /** `chatId:userId` → expiry (ms) of a positive answer */
    const positiveUntil = new Map<string, number>();

    const isCachedMember = (key: string): boolean => {
        const expiresAt = positiveUntil.get(key);
        if (expiresAt === undefined) return false;
        if (expiresAt > now()) return true;
        positiveUntil.delete(key);
        return false;
    };

    const rememberMember = (key: string): void => {
        const current = now();
        if (positiveUntil.size > CACHE_SWEEP_THRESHOLD) {
            for (const [cachedKey, expiresAt] of positiveUntil) {
                if (expiresAt <= current) positiveUntil.delete(cachedKey);
            }
        }
        positiveUntil.set(key, current + cacheTtlMs);
    };

    const checkGroupMembership = async (chatId: number, userId: number): Promise<Membership> => {
        const key = `${chatId}:${userId}`;
        if (isCachedMember(key)) return 'member';
        try {
            const member = await lookupWithDeadline(options.lookup, chatId, userId, timeoutMs);
            const membership = classifyMemberStatus(member);
            if (membership === 'member') rememberMember(key);
            return membership;
        } catch (error) {
            return classifyLookupError(error, chatId);
        }
    };

    return {
        checkMembership: (chat, userId) =>
            match(chat.type)
                .returnType<Promise<Membership>>()
                .with('private', () => Promise.resolve(chat.chatId === userId ? 'member' : 'not_member'))
                .with('group', 'supergroup', () => checkGroupMembership(chat.chatId, userId))
                .with('channel', () => Promise.resolve('not_member'))
                .exhaustive(),
    };
};

/** The production lookup: getChatMember on the panel's own Api instance */
export const botApiMembershipLookup =
    (api: Api): MembershipLookup =>
    (chatId, userId, signal) =>
        api.getChatMember(chatId, userId, toTelegramApiAbortSignal(signal));
