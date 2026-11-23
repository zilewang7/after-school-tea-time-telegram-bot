/**
 * Terminal outcome notices of the generation commands (`/pic`, `/picunsafe`,
 * `/vid`).
 *
 * A run shows progress in a placeholder message ("已提交 · 排队中", "生成中",
 * "下载中") and deletes that placeholder on success: those updates are
 * transient and deliberately never recorded. The text that stays in the chat
 * is the outcome — the placeholder edited into a failure/cancel/timeout
 * notice, or a fresh message when the placeholder is gone. Without a record
 * later contexts cannot quote it and a reaction on it is dropped by the inbound
 * reaction path, which only resolves message ids that exist in the database.
 *
 * Recording is best-effort: the helpers edit/send first and never throw, so a
 * failed database write cannot take the user-visible outcome down with it.
 */
import type { Api } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import { sendBotNoticeVia, updateBotNoticeVia } from '../../services/bot-notice-service.js';
import { to } from '../../shared/result.js';

/** Who a terminal outcome answers: the command message, in its chat */
interface GenerationReplyTarget {
    readonly api: Api;
    readonly chatId: number;
    /** The command message the outcome answers */
    readonly userMessageId: number;
}

export interface GenerationOutcomeTarget extends GenerationReplyTarget {
    /** The transient progress message the outcome replaces */
    readonly placeholderMessageId: number;
}

/**
 * Replace the placeholder with the terminal outcome and record it.
 *
 * When the placeholder is gone (deleted by a user, or replaced by an earlier
 * attempt) the same text is posted as a fresh reply: swallowing the outcome
 * would be worse than a duplicate notice. That fallback records the message it
 * actually sent, under the id Telegram returned.
 */
export const settleGenerationOutcome = async (
    target: GenerationOutcomeTarget,
    text: string,
    replyMarkup?: InlineKeyboardMarkup
): Promise<void> => {
    const [editError] = await to(
        target.api.editMessageText(target.chatId, target.placeholderMessageId, text, {
            reply_markup: replyMarkup,
        })
    );
    if (editError === null) {
        await updateBotNoticeVia(
            target.api,
            target.chatId,
            target.placeholderMessageId,
            text,
            target.userMessageId
        );
        return;
    }

    await sendGenerationOutcome(target, text, replyMarkup);
};

/** Post a terminal outcome as a fresh reply and record it (no placeholder existed) */
export const sendGenerationOutcome = async (
    target: GenerationReplyTarget,
    text: string,
    replyMarkup?: InlineKeyboardMarkup
): Promise<void> => {
    await sendBotNoticeVia(target.api, target.chatId, target.userMessageId, text, {
        reply_parameters: { message_id: target.userMessageId },
        ...(replyMarkup === undefined ? {} : { reply_markup: replyMarkup }),
    });
};
