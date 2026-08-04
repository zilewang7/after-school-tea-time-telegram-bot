/**
 * Repair holes in the stored history from Telegram itself.
 *
 * Every message the bot sees is stored, and that row is the only record the
 * context tree has: the tree resolves ids to rows, so a message whose write was
 * lost — a locked database (see docs/2026-0804-1858), a restart, a crash — is
 * invisible forever, and replying to it only gets "I can't see that message".
 *
 * luoxu's MTProto client can still read those messages, so when the reply chain
 * points at an id we have no row for, we ask for it and store it. Text only:
 * media bytes would need a second streaming endpoint, and a message the model
 * can read with a note that its picture is missing beats a message that never
 * existed.
 *
 * Unconfigured (LUOXU_PREVIEW_URL empty) → every call here is a no-op.
 */
import { saveMessage } from '../db/index.js';
import { entitiesToMarkdown } from 'telegram-md-entities';
import type { MessageEntity } from 'grammy/types';

const luoxuBaseUrl = process.env.LUOXU_PREVIEW_URL;

/** Whether history backfill is available. */
export const isMessageBackfillEnabled = (): boolean => Boolean(luoxuBaseUrl);

/** Never ask for more than this in one go — more means something else is wrong */
const MAX_BACKFILL_IDS = 20;

/** A reply is waiting on this, so the request is kept short */
const REQUEST_TIMEOUT_MS = 5000;

/**
 * Ids that came back empty (deleted, or never visible to luoxu) are remembered
 * for a while: without this, every context build would ask again for the same
 * permanently missing message.
 */
const NEGATIVE_CACHE_TTL_MS = 10 * 60 * 1000;

const missingIds = new Map<string, number>();

const negativeCacheKey = (chatId: number, messageId: number): string => `${chatId}:${messageId}`;

const isKnownMissing = (chatId: number, messageId: number): boolean => {
    const expiresAt = missingIds.get(negativeCacheKey(chatId, messageId));
    if (expiresAt === undefined) return false;
    if (expiresAt > Date.now()) return true;
    missingIds.delete(negativeCacheKey(chatId, messageId));
    return false;
};

const rememberMissing = (chatId: number, messageId: number): void => {
    missingIds.set(negativeCacheKey(chatId, messageId), Date.now() + NEGATIVE_CACHE_TTL_MS);
};

/**
 * Bot API supergroup/channel ids look like -100<channel_id>; luoxu (MTProto)
 * uses the bare channel_id. Returns null for chats luoxu can't address.
 */
const toLuoxuChannelId = (chatId: number): number | null => {
    if (chatId >= -1_000_000_000_000) return null;
    return -chatId - 1_000_000_000_000;
};

/** One media descriptor as luoxu reports it */
interface LuoxuMediaDescriptor {
    type: string;
    mime: string | null;
}

interface LuoxuHistoricalMessage {
    id: number;
    sender_id: number | null;
    sender_name: string;
    sender_is_bot: boolean;
    text: string;
    /** Bot API shaped, so the normal markdown pipeline applies */
    entities: MessageEntity[];
    reply_to: number | null;
    date: number | null;
    media: LuoxuMediaDescriptor | null;
}

/**
 * The bytes are gone, so the model is told what kind of media it cannot see —
 * same wording as the live path's failure hints.
 */
const describeMedia = (media: LuoxuMediaDescriptor | null): string | undefined => {
    if (!media) return undefined;
    const article = /^[aeiou]/i.test(media.type) ? 'an' : 'a';
    return `${article} ${media.type} — recovered from history, the file itself is no longer available`;
};

const fetchHistoricalMessages = async (
    channelId: number,
    messageIds: number[]
): Promise<LuoxuHistoricalMessage[]> => {
    const url = `${luoxuBaseUrl}/messages?g=${channelId}&ids=${messageIds.join(',')}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) {
        throw new Error(`luoxu /messages returned HTTP ${response.status}`);
    }
    const payload: unknown = await response.json();
    if (typeof payload !== 'object' || payload === null || !('messages' in payload)) {
        throw new Error('luoxu /messages returned an unexpected payload');
    }
    const { messages } = payload;
    return Array.isArray(messages) ? messages : [];
};

/**
 * Fetch the given messages from Telegram and store them. Returns the ids that
 * are now in the database. Never throws — a failed repair just leaves the hole.
 */
export const backfillMessages = async (
    chatId: number,
    messageIds: number[]
): Promise<number[]> => {
    if (!luoxuBaseUrl) return [];

    const channelId = toLuoxuChannelId(chatId);
    if (channelId === null) return [];

    const wanted = messageIds
        .filter((messageId) => !isKnownMissing(chatId, messageId))
        .slice(0, MAX_BACKFILL_IDS);
    if (wanted.length === 0) return [];

    try {
        const messages = await fetchHistoricalMessages(channelId, wanted);
        const stored: number[] = [];

        for (const message of messages) {
            const text = message.entities.length
                ? entitiesToMarkdown({ text: message.text, entities: message.entities })
                : message.text;

            await saveMessage({
                chatId,
                messageId: message.id,
                userId: message.sender_id ?? 0,
                date: message.date === null ? new Date() : new Date(message.date * 1000),
                userName: message.sender_name || '佚名',
                message: text,
                replyToId: message.reply_to ?? undefined,
                mediaHint: describeMedia(message.media) ?? null,
            });
            stored.push(message.id);
        }

        // Whatever Telegram did not return is gone for good, not worth re-asking
        for (const messageId of wanted) {
            if (!stored.includes(messageId)) rememberMissing(chatId, messageId);
        }

        if (stored.length) {
            console.log(`[backfill] recovered ${stored.length} message(s) in chat ${chatId}: ${stored.join(', ')}`);
        }
        return stored;
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`[backfill] could not recover ${wanted.join(', ')} in chat ${chatId}: ${reason}`);
        return [];
    }
};
