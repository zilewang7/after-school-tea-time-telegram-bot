/**
 * The bot's own notices: text replies sent by command handlers (/model, /help,
 * /chat help, /pic errors, ...). They have no BotResponse, and Telegram never
 * delivers the bot's own messages back to it, so without a record written here
 * they stay invisible to every context (/chat, reply trees, /context, panel).
 *
 * The record is a normal `telegram_messages` row with `fromBotSelf=1`, written
 * by the same writer AI replies use. Recording is best-effort: the user-visible
 * message has already been sent, so a failed write is logged and dropped, never
 * thrown.
 */
import type { Api, Context } from 'grammy';
import { getBotResponse, getMessage, writeBotMessageRow } from '../db/index.js';
import { to } from '../shared/result.js';

/** Options `ctx.reply` accepts; chat_id/text are supplied by the helper */
type CtxReplyOptions = NonNullable<Parameters<Context['reply']>[1]>;
/** Options `api.sendMessage` accepts; chat_id/text are supplied by the helper */
type ApiSendOptions = NonNullable<Parameters<Api['sendMessage']>[2]>;

/** Telegram dates are whole seconds; an offline stub may report 0, then use now */
const dateOfSent = (unixSeconds: number): Date =>
    unixSeconds > 0 ? new Date(unixSeconds * 1000) : new Date();

/** Write the notice as the bot's own row. Never throws. */
const recordNotice = async (
    chatId: number,
    messageId: number,
    replyToId: number | null,
    text: string,
    sentAt: Date
): Promise<void> => {
    const [error] = await to(
        writeBotMessageRow({
            chatId,
            messageId,
            replyToId,
            date: sentAt,
            text,
            modelParts: null,
            file: null,
            fileMime: null,
        })
    );
    if (error) {
        console.error(
            `[bot-notice] failed to record notice ${messageId} in chat ${chatId}:`,
            error.message
        );
    }
};

/**
 * Send a notice through `ctx.reply` (keeps topic/thread behavior) and record it
 * as answering `ctx.message`. Returns whether the message went out.
 */
export const sendBotNotice = async (
    ctx: Context,
    text: string,
    options?: CtxReplyOptions
): Promise<boolean> => {
    if (!ctx.chat) return false;

    const [sendError, sent] = await to(ctx.reply(text, options));
    if (sendError) {
        console.error('[bot-notice] send failed:', sendError.message);
        return false;
    }

    await recordNotice(
        ctx.chat.id,
        sent.message_id,
        ctx.message?.message_id ?? null,
        text,
        dateOfSent(sent.date)
    );
    return true;
};

/**
 * Send a notice when the caller holds only an `Api` (generation runners and
 * /vid, which answer from a detached task). `replyToMessageId` is what the
 * record says the notice answers.
 */
export const sendBotNoticeVia = async (
    api: Api,
    chatId: number,
    replyToMessageId: number,
    text: string,
    options?: ApiSendOptions
): Promise<boolean> => {
    const [sendError, sent] = await to(api.sendMessage(chatId, text, options));
    if (sendError) {
        console.error('[bot-notice] send failed:', sendError.message);
        return false;
    }

    await recordNotice(chatId, sent.message_id, replyToMessageId, text, dateOfSent(sent.date));
    return true;
};

/**
 * A message the bot edits in place into a notice: the /model menu's buttons
 * (keep the stored text in step, or a context would quote a stale model state)
 * and the generation commands' "Processing..." placeholder turned into an
 * error (it was never recorded while it was transient).
 *
 * Upserts: a menu message sent before this feature existed has no row yet. An
 * AI reply is never touched — its row is owned by the finalize path.
 * `replyToMessageId` is the fallback for a row that does not exist yet.
 */
export const updateBotNotice = async (
    ctx: Context,
    messageId: number,
    text: string,
    replyToMessageId?: number
): Promise<void> => {
    if (!ctx.chat) return;
    const chatId = ctx.chat.id;

    const [readError, existing] = await to(getMessage(chatId, messageId));
    if (readError) {
        console.error('[bot-notice] failed to read notice before update:', readError.message);
        return;
    }
    if (existing && !existing.fromBotSelf) return;

    const [replyError, response] = await to(getBotResponse(chatId, messageId));
    if (replyError) {
        console.error('[bot-notice] failed to check for a reply before update:', replyError.message);
        return;
    }
    if (response) return;

    await recordNotice(
        chatId,
        messageId,
        existing?.replyToId ?? replyToMessageId ?? null,
        text,
        existing?.date ?? new Date()
    );
};
