/**
 * Data-level redaction of public share content (design 2026-1110-1733): a
 * share page is public, so the ids inside Telegram links must never leave the
 * server. Only the id numbers are replaced — with the literal
 * `[data-deletion]` — so the rest of the text and the link's shape stay as the
 * author wrote them.
 *
 * The share page and its JSON API both build from the same content, so the
 * redaction happens once, in `loadShareContent` (share-content.ts), before
 * either surface renders. The panel (members only) is not redacted.
 */
import type {
    ShareBotBubble,
    ShareBubble,
    ShareContent,
    ShareReplyTarget,
    ShareUserBubble,
    ShareWidgetContent,
} from './share-content.js';

/** The literal that replaces a redacted id inside a public share link */
export const DELETION_PLACEHOLDER = '[data-deletion]';

/** Telegram link hosts; `t.me` is the one that appears in stored text */
const TELEGRAM_HOSTS = '(?:t\\.me|telegram\\.me|telegram\\.dog)';

/** A `tg://` link; stops before whitespace, closing brackets and markdown delimiters */
const TG_URL_PATTERN = /tg:\/\/[^\s)\]"'<>]+/gi;

/**
 * The id-bearing query parameters of a `tg://` link. `message_id` stays: a
 * message id means nothing without its chat, which is redacted.
 */
const TG_ID_PARAMETER_PATTERN = /(\b(?:id|chat_id|user_id|channel|channel_id)=)(-?\d+)/g;

/** `t.me/c/<internal chat id>/<message id>`: the internal chat id is the secret */
const TELEGRAM_INTERNAL_PATTERN = new RegExp(`((?:https?:\\/\\/)?${TELEGRAM_HOSTS}\\/c\\/)(-?\\d+)`, 'gi');

/** `t.me/joinchat/<hash>`: a join key to a private chat */
const TELEGRAM_JOINCHAT_PATTERN = new RegExp(`((?:https?:\\/\\/)?${TELEGRAM_HOSTS}\\/joinchat\\/)([A-Za-z0-9_-]{4,})`, 'gi');

/** `t.me/+<hash>`: the newer form of the same join key */
const TELEGRAM_INVITE_PATTERN = new RegExp(`((?:https?:\\/\\/)?${TELEGRAM_HOSTS}\\/\\+)([A-Za-z0-9_-]{4,})`, 'gi');

const redactTgUrl = (url: string): string => url.replace(TG_ID_PARAMETER_PATTERN, `$1${DELETION_PLACEHOLDER}`);

/**
 * Replace the sensitive ids of every Telegram link in `text`; idempotent, so
 * running it twice changes nothing. Applied to markdown as well as plain text:
 * a markdown link's URL lives in the source verbatim.
 */
export const redactSensitiveIds = (text: string): string =>
    text
        .replace(TG_URL_PATTERN, redactTgUrl)
        .replace(TELEGRAM_INTERNAL_PATTERN, `$1${DELETION_PLACEHOLDER}`)
        .replace(TELEGRAM_JOINCHAT_PATTERN, `$1${DELETION_PLACEHOLDER}`)
        .replace(TELEGRAM_INVITE_PATTERN, `$1${DELETION_PLACEHOLDER}`);

const redactWidget = (widget: ShareWidgetContent | null): ShareWidgetContent | null =>
    widget === null ? null : { ...widget, caption: widget.caption === null ? null : redactSensitiveIds(widget.caption) };

const redactReplyTarget = (target: ShareReplyTarget | null): ShareReplyTarget | null =>
    target === null
        ? null
        : {
              ...target,
              authorName: redactSensitiveIds(target.authorName),
              snippet: target.snippet === null ? null : redactSensitiveIds(target.snippet),
              mediaHint: target.mediaHint === null ? null : redactSensitiveIds(target.mediaHint),
          };

const redactUserBubble = (bubble: ShareUserBubble): ShareUserBubble => ({
    ...bubble,
    text: redactSensitiveIds(bubble.text),
    quote: bubble.quote === null ? null : redactSensitiveIds(bubble.quote),
    previewText: bubble.previewText === null ? null : redactSensitiveIds(bubble.previewText),
    mediaHint: bubble.mediaHint === null ? null : redactSensitiveIds(bubble.mediaHint),
    replyTo: redactReplyTarget(bubble.replyTo),
});

const redactBotBubble = (bubble: ShareBotBubble): ShareBotBubble => ({
    ...bubble,
    text: redactSensitiveIds(bubble.text),
    widget: redactWidget(bubble.widget),
    replyTo: redactReplyTarget(bubble.replyTo),
});

const redactBubble = (bubble: ShareBubble): ShareBubble =>
    bubble.kind === 'user' ? redactUserBubble(bubble) : redactBotBubble(bubble);

/** Every string a share page or its JSON API can show, with its ids redacted */
export const redactShareContent = (content: ShareContent): ShareContent =>
    content.kind === 'reply'
        ? {
              ...content,
              chatTitle: content.chatTitle === null ? null : redactSensitiveIds(content.chatTitle),
              text: redactSensitiveIds(content.text),
              widget: redactWidget(content.widget),
          }
        : {
              ...content,
              chatTitle: content.chatTitle === null ? null : redactSensitiveIds(content.chatTitle),
              bubbles: content.bubbles.map(redactBubble),
          };
