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

/** A message link plus the URL that addresses its cache row */
export interface ParsedTelegramMessageLink {
    link: TelegramMessageLink;
    /** Canonical `https://t.me/…` form; topic segments and query strings are dropped */
    url: string;
}

/**
 * Canonical URL for one message link: `t.me/c/<chat>/<msg>` for internal links,
 * `t.me/<username>/<msg>` for public ones. The same message linked through two
 * spellings (`www.`, `telegram.me`, a topic segment, `?single`) collapses to one
 * cache row.
 */
export const canonicalTelegramMessageLink = (link: TelegramMessageLink): string =>
    match(link.chatRef)
        .with({ type: 'internal' }, (ref) => {
            const internalId = -ref.chatId - 1_000_000_000_000;
            return `https://t.me/c/${internalId}/${link.messageId}`;
        })
        .with(
            { type: 'username' },
            (ref) => `https://t.me/${ref.username}/${link.messageId}`
        )
        .exhaustive();

/**
 * The message-link shape itself, not a generic URL: Chinese text often follows
 * a link without a space (`…/1090259看这个`), and a generic match would swallow
 * it and then fail to parse. The pattern ends at the message id, or at a `?query`.
 */
const MESSAGE_LINK_PATTERN =
    /https?:\/\/(?:www\.)?t(?:elegram)?\.me\/(?:c\/\d+|[A-Za-z][A-Za-z0-9_]{4,31})\/\d+(?:\/\d+)?(?:\?\S*)?/g;

/** Punctuation that commonly trails a pasted link but is not part of it */
const TRAILING_PUNCTUATION = /[.,;:!?，。；：！？、]+$/;

/**
 * Every distinct Telegram message link in one piece of text, in order of
 * appearance. Links to users, `t.me/s/…` preview pages and other telegram.me
 * URLs that do not address a message are dropped by the parser.
 */
export const extractTelegramMessageLinks = (
    text: string | null | undefined
): ParsedTelegramMessageLink[] => {
    if (!text) return [];

    const links: ParsedTelegramMessageLink[] = [];
    const seen = new Set<string>();

    for (const matched of text.matchAll(MESSAGE_LINK_PATTERN)) {
        const token = matched[0].replace(TRAILING_PUNCTUATION, '');
        const link = parseTelegramMessageLink(token);
        if (!link) continue;

        const url = canonicalTelegramMessageLink(link);
        if (seen.has(url)) continue;
        seen.add(url);
        links.push({ link, url });
    }

    return links;
};
