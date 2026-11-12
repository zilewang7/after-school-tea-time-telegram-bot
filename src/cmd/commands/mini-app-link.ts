/**
 * The Mini App entry point of a chat, shared by `/panel` and `/apply`.
 *
 * Private chats open the app in place (a web_app button needs WEBAPP_PUBLIC_URL);
 * groups can only carry a URL button, so they get a Direct Link (which needs
 * BOT_USER_NAME). A caller with no usable target gets null and falls back to
 * plain text.
 */
import { InlineKeyboard } from 'grammy';
import type { Chat } from 'grammy/types';
import { match } from 'ts-pattern';

const DEFAULT_SHORT_NAME = 'panel';

/** A Direct Link into the Mini App; null without BOT_USER_NAME */
export const miniAppDirectLink = (startParam?: string): string | null => {
    const botUserName = process.env.BOT_USER_NAME?.trim();
    if (!botUserName) return null;
    const shortName = process.env.WEBAPP_BOT_SHORT_NAME?.trim() || DEFAULT_SHORT_NAME;
    const query = startParam === undefined || startParam === '' ? '' : `?startapp=${startParam}`;
    return `https://t.me/${botUserName}/${shortName}${query}`;
};

/** The public Mini App URL, used for private-chat web_app buttons */
const miniAppPublicUrl = (): string | null => process.env.WEBAPP_PUBLIC_URL?.trim() || null;

/**
 * A keyboard that opens the Mini App from this chat; null when the chat kind
 * cannot carry one or the required env is missing.
 */
export const miniAppKeyboardForChat = (
    chat: Chat,
    label: string,
    startParam?: string
): InlineKeyboard | null =>
    match(chat.type)
        .returnType<InlineKeyboard | null>()
        .with('private', () => {
            const url = miniAppPublicUrl();
            return url === null ? null : new InlineKeyboard().webApp(label, url);
        })
        .with('group', 'supergroup', () => {
            const link = miniAppDirectLink(startParam);
            return link === null ? null : new InlineKeyboard().url(label, link);
        })
        .otherwise(() => null);
