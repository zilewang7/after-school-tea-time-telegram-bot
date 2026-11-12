/**
 * Current group membership as the Bot API reports it, for the access tier
 * (design D1-C).
 *
 * A message posted in an access group proves membership without a lookup; a
 * private chat (or a chat outside the list) asks getChatMember every time, so a
 * member who was kicked loses the full tier on the very next message. Only the
 * in-flight lookup is shared: no positive answer is cached.
 *
 * The lookup is injected: index.ts passes the bot's own Api without autoRetry,
 * so a rate limit fails fast instead of being slept on inside a reply; offline
 * cases pass a fake.
 */
import { GrammyError, HttpError, type Api } from 'grammy';
import { match, P } from 'ts-pattern';
import { toTelegramApiAbortSignal } from './telegram-file-service.js';

export type GroupMembership = 'member' | 'not_member' | 'unknown' | 'throttled';

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

let lookup: MembershipLookup | null = null;

/** Production wiring: a Bot API client without autoRetry */
export const configureAccessMembership = (api: Api): void => {
    lookup = (chatId, userId, signal) => api.getChatMember(chatId, userId, toTelegramApiAbortSignal(signal));
};

/** Offline cases inject a fake; null puts the process back to "no lookup" */
export const setAccessMembershipLookup = (next: MembershipLookup | null): void => {
    lookup = next;
};

const LOOKUP_TIMEOUT_MS = 5000;

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

/** An abort or timeout surfacing outside grammy (DOMException names) */
const isAbortLike = (error: unknown): boolean =>
    error instanceof LookupDeadlineError ||
    (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'));

const classifyLookupError = (error: unknown): GroupMembership => {
    if (error instanceof GrammyError) {
        // A rate limit is not an answer; the caller must not treat it as membership
        if (error.error_code === 429) return 'throttled';
        if (error.error_code >= 500) return 'unknown';
        return 'not_member';
    }
    if (error instanceof HttpError || isAbortLike(error)) return 'unknown';
    console.warn('[access] unexpected membership lookup failure:', error);
    return 'not_member';
};

/** Run the lookup with an abort signal and a hard deadline, whichever comes first */
const lookupWithDeadline = async (
    current: MembershipLookup,
    chatId: number,
    userId: number
): Promise<MemberStatus> => {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new LookupDeadlineError());
        }, LOOKUP_TIMEOUT_MS);
    });
    try {
        return await Promise.race([current(chatId, userId, controller.signal), deadline]);
    } finally {
        clearTimeout(timer);
    }
};

/** `chatId:userId` → the lookup still running, so a burst asks once */
const inFlight = new Map<string, Promise<GroupMembership>>();

/**
 * The current membership of one user in one group. 'unknown' means the Bot API
 * could not answer (network, 5xx, our deadline) and the caller may fall back to
 * its own evidence; 'throttled' means a 429 and never does.
 */
export const checkGroupMembership = (chatId: number, userId: number): Promise<GroupMembership> => {
    const current = lookup;
    if (current === null) return Promise.resolve('unknown');
    const key = `${chatId}:${userId}`;
    const pending = inFlight.get(key);
    if (pending !== undefined) return pending;
    const task = (async (): Promise<GroupMembership> => {
        try {
            return classifyMemberStatus(await lookupWithDeadline(current, chatId, userId));
        } catch (error) {
            return classifyLookupError(error);
        }
    })().finally(() => {
        inFlight.delete(key);
    });
    inFlight.set(key, task);
    return task;
};
