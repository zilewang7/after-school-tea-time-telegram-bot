/**
 * Telegram message links as pasted from "Copy link": which chat and which
 * message they point at. Pure, so the accepted forms can be asserted offline.
 */
import { match } from 'ts-pattern';

export type TelegramChatRef =
    /** `t.me/c/<internal id>/…` — private supergroup/channel; chat id is -100<internal id> */
    | { type: 'internal'; chatId: number }
    /** `t.me/<username>/…` — public group/channel */
    | { type: 'username'; username: string };

export interface TelegramMessageLink {
    chatRef: TelegramChatRef;
    messageId: number;
}

/**
 * `t.me/c/123/456`, `t.me/c/123/<topic>/456`, `t.me/name/456`,
 * `t.me/name/<topic>/456`, with an optional query string (`?single`,
 * `?comment=`, `?thread=`). Usernames are 5–32 chars, so `c` cannot be one.
 */
const LINK_PATTERN =
    /^https?:\/\/(?:www\.)?t(?:elegram)?\.me\/(?:c\/(\d+)|([A-Za-z][A-Za-z0-9_]{4,31}))\/(\d+)(?:\/(\d+))?(?:\?\S*)?$/;

export const parseTelegramMessageLink = (token: string): TelegramMessageLink | null => {
    const matched = token.match(LINK_PATTERN);
    if (!matched) return null;

    const [, internalId, username, firstNumber, secondNumber] = matched;
    // With a topic segment the message id is the last number
    const messageId = Number(secondNumber ?? firstNumber);
    if (!Number.isSafeInteger(messageId) || messageId <= 0) return null;

    if (internalId !== undefined) {
        return { chatRef: { type: 'internal', chatId: Number(`-100${internalId}`) }, messageId };
    }
    if (username === undefined) return null;
    return { chatRef: { type: 'username', username: username.toLowerCase() }, messageId };
};

/** Whether the link points into `chat`, the chat the command was sent in */
export const linkPointsIntoChat = (
    link: TelegramMessageLink,
    chat: { id: number; username?: string }
): boolean =>
    match(link.chatRef)
        .with({ type: 'internal' }, (ref) => ref.chatId === chat.id)
        .with({ type: 'username' }, (ref) => chat.username?.toLowerCase() === ref.username)
        .exhaustive();
