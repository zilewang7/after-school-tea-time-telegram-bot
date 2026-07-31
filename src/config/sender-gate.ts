/**
 * Sender gate: the bot never responds to another bot.
 *
 * We run against a self-hosted Bot API server, which — unlike the cloud API —
 * does deliver other bots' messages. So an RSS bot posting a link that happens
 * to contain "@AfterSchoolTeatimeBot" used to get a full reply, and one bot even
 * triggered a paid /picgpt run.
 *
 * The gate is registered AFTER autoSave/autoUpdate on purpose: those messages
 * still go into the database, so a user replying to a bot's post still gets it
 * as context. Only the response paths (mentions, /pic*, /model, hears, ...) are
 * cut off.
 *
 * IGNORED_SENDER_IDS (comma-separated user ids) covers the case `is_bot` cannot:
 * automation running on a real user account, which reports is_bot: false.
 */
import type { Bot } from 'grammy';
import type { User } from 'grammy/types';

/**
 * Anonymous group admins speak through GroupAnonymousBot, which reports
 * is_bot: true while being an actual person — it must stay allowed.
 */
const GROUP_ANONYMOUS_BOT_ID = 1087968824;

const parseIgnoredSenderIds = (raw: string | undefined): Set<number> => {
    if (!raw) return new Set();
    return new Set(
        raw
            .split(',')
            .map((part) => Number(part.trim()))
            .filter((id) => Number.isFinite(id) && id !== 0)
    );
};

const ignoredSenderIds = parseIgnoredSenderIds(process.env.IGNORED_SENDER_IDS);

/** Whether the bot should stay silent for whoever sent this update */
export const shouldIgnoreSender = (from: User | undefined): boolean => {
    if (!from) return false;
    if (from.id === GROUP_ANONYMOUS_BOT_ID) return false;
    return from.is_bot || ignoredSenderIds.has(from.id);
};

/** Senders already reported, so a chatty bot can't flood the log */
const reportedSenders = new Set<number>();

const reportOnce = (from: User): void => {
    if (reportedSenders.has(from.id)) return;
    reportedSenders.add(from.id);
    const handle = from.username ? `@${from.username}` : from.first_name;
    console.log(`[sender-gate] not responding to ${handle} (${from.id})`);
};

/**
 * Register the gate. Must come after the message-saving middleware and before
 * every handler that can produce a response.
 */
export const registerSenderGate = (bot: Bot): void => {
    bot.use(async (ctx, next) => {
        const from = ctx.from;
        if (from && shouldIgnoreSender(from)) {
            reportOnce(from);
            return;
        }
        return next();
    });
};
