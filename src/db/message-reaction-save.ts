/**
 * Inbound `message_reaction` updates: keep message_reactions in step with what
 * users picked.
 *
 * Telegram only delivers these updates when the bot is an administrator of the
 * chat and `message_reaction` is listed in `allowed_updates` (see
 * config/polling-updates.ts), and never for reactions the bot itself set. The
 * handler therefore only writes user reactions; the bot's own reaction is
 * recorded by the code that set it (`replaceBotReaction`).
 */
import type { Bot } from 'grammy';
import type { MessageReactionUpdated, ReactionType, User } from 'grammy/types';
import { match } from 'ts-pattern';
import { applyUserReactionUpdate, type ReactionActor, type ReactionInput } from './queries/reaction-queries.js';

/**
 * Anonymous group admins speak through GroupAnonymousBot, which reports
 * `is_bot: true` while being a person. A reaction from that account is an
 * anonymous one, not a bot's.
 */
const GROUP_ANONYMOUS_BOT_ID = 1087968824;

/** One storage write per change; state-like, so a re-delivered update is idempotent */
const toReactionInput = (reaction: ReactionType): ReactionInput =>
    match(reaction)
        .with({ type: 'emoji' }, (emoji) => ({ kind: 'emoji' as const, emoji: emoji.emoji, customEmojiId: null }))
        .with({ type: 'custom_emoji' }, (custom) => ({
            kind: 'custom_emoji' as const,
            emoji: null,
            customEmojiId: custom.custom_emoji_id,
        }))
        .with({ type: 'paid' }, () => ({ kind: 'paid' as const, emoji: null, customEmojiId: null }))
        .exhaustive();

/** The display name snapshot: first name only, the convention message rows use */
const actorNameOf = (user: User): string | null => user.first_name || null;

/**
 * The actor of one update. Anonymous reactions carry `actor_chat` instead of
 * `user`; a bot account other than the anonymous-admin stand-in is not a person
 * whose feedback the model should see (and Telegram does not report bot
 * reactions anyway), so it is skipped.
 */
const actorOf = (update: MessageReactionUpdated): ReactionActor | null => {
    if (update.user !== undefined && update.user.id !== GROUP_ANONYMOUS_BOT_ID) {
        if (update.user.is_bot) return null;
        return { userId: update.user.id, actorChatId: null, userName: actorNameOf(update.user) };
    }
    const actorChat = update.actor_chat;
    return {
        userId: null,
        actorChatId: actorChat?.id ?? null,
        userName: actorChat?.title ?? null,
    };
};

/**
 * Store one update. Exported for the offline cases; the registered handler only
 * adds logging and never lets a storage error escape into the update loop.
 */
export const applyInboundReaction = async (
    update: MessageReactionUpdated
): Promise<{ canonicalMessageId: number | null; stored: boolean }> => {
    const actor = actorOf(update);
    if (actor === null) return { canonicalMessageId: null, stored: false };
    return applyUserReactionUpdate({
        chatId: update.chat.id,
        messageId: update.message_id,
        actor,
        // Only the new set matters: it is the actor's complete current reaction
        reactions: update.new_reaction.map(toReactionInput),
    });
};

/** Register the inbound handler; reactions are stored, they never produce a reply */
export const autoReaction = (bot: Bot): void => {
    bot.on('message_reaction', async (ctx) => {
        const update = ctx.messageReaction;
        if (update === undefined) return;
        try {
            await applyInboundReaction(update);
        } catch (error) {
            console.error(
                `[reaction] failed to store ${update.chat.id}/${update.message_id}:`,
                error instanceof Error ? error.message : error
            );
        }
    });
};
