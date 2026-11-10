/**
 * /share and /shareone: turn the replied-to message into a public share link.
 *
 * /share shares the whole conversation the replied message belongs to;
 * /shareone only shares the replied bot reply (its current version). Both are
 * read-only: resolve the target, reuse/create its share row and reply with the
 * URL. The command message and the bot's reply are kept out of the message
 * table (autoSave excludes the commands), so a share token never lands in the
 * /chat context or in a shared conversation page.
 */
import type { Bot, CommandContext, Context } from 'grammy';
import { match } from 'ts-pattern';
import { shareCommandEnabled } from '../../config/share-command.js';
import { findBotResponseByMessageId } from '../../db/index.js';
import { findRootMessage, type ContextMessage } from '../../db/queries/context-queries.js';
import { isPanelRunning } from '../../panel/panel-state.js';
import { createUserShare } from '../../panel/share/share-link-service.js';
import type { ShareCreateFailure } from '../../panel/share/share-types.js';
import { plainExcerptOf } from '../../panel/views/excerpt.js';

/** Which target a command asks for: the whole conversation, or the single reply */
export type ShareCommandKind = 'conversation' | 'reply';

/** Why the replied-to message could not become a share target */
export type ShareCommandFailure = 'not_stored' | 'not_bot_reply' | 'bot_reply_expired';

/** Cap of the conversation root excerpt, in characters */
const ROOT_SUMMARY_MAX = 30;

const EMPTY_SUMMARY = '（无正文）';

const SHARE_FAILED_TEXT = '生成分享链接失败，请稍后再试。';

/** Per-user sliding windows, shared by both commands */
const RATE_WINDOWS = [
    { windowMs: 60_000, limit: 5 },
    { windowMs: 3_600_000, limit: 30 },
] as const;

/** Above this many tracked users, finished windows are swept */
const SWEEP_THRESHOLD = 5_000;

export const USAGE_TEXT = `/share 与 /shareone 都需要回复一条消息：
/share = 分享这条消息所在的整个会话
/shareone = 只分享被回复的那条 bot 回复
链接公开，拿到链接的人都能查看。`;

export const OFF_TEXT = '分享功能未启用。';

export const PERSONAL_ACCOUNT_TEXT = '请用个人账号发送 /share。';

export const shareCommandFailureText = (reason: ShareCommandFailure): string =>
    match(reason)
        .with('not_stored', () => '找不到被回复的消息（可能已超出 7 天保留期），无法分享。')
        .with('not_bot_reply', () => '被回复的消息不是我的回复；用 /share 可以分享它所在的整个会话。')
        .with('bot_reply_expired', () => '这条回复已超出保留期或无法定位；用 /share 可以分享它所在的整个会话。')
        .exhaustive();

export const shareCreateFailureText = (reason: ShareCreateFailure): string =>
    match(reason)
        .with('reply_not_found', () => '这条回复不存在或已被清理。')
        .with('version_not_found', () => '这条回复没有可分享的版本。')
        .with('conversation_not_found', () => '这个会话不存在或已被清理。')
        .with('invalid_target', () => '分享目标不合法。')
        .exhaustive();

export interface ShareCommandLimiter {
    /** Record one command for this user; retryAfterSeconds is set when refused */
    take(userId: number): { allowed: boolean; retryAfterSeconds: number };
}

export interface ShareCommandLimiterOptions {
    /** Clock in ms, replaceable by tests */
    now?: () => number;
}

export const createShareCommandLimiter = (options: ShareCommandLimiterOptions = {}): ShareCommandLimiter => {
    const now = options.now ?? Date.now;
    /** userId → accepted takes inside the longest window */
    const takes = new Map<number, number[]>();
    const longestWindowMs = RATE_WINDOWS.reduce((longest, window) => Math.max(longest, window.windowMs), 0);

    return {
        take: (userId) => {
            const nowMs = now();
            // Drop users who stopped using the commands, so a long-lived
            // process does not keep every id it has ever seen.
            if (takes.size > SWEEP_THRESHOLD) {
                for (const [trackedId, takenAt] of takes) {
                    const newest = takenAt[takenAt.length - 1] ?? 0;
                    if (nowMs - newest >= longestWindowMs) takes.delete(trackedId);
                }
            }
            const fresh = (takes.get(userId) ?? []).filter((takenAt) => nowMs - takenAt < longestWindowMs);
            // Wait for the window that frees a slot first (the smallest remaining time)
            const waits = RATE_WINDOWS.flatMap((window) => {
                const inside = fresh.filter((takenAt) => nowMs - takenAt < window.windowMs);
                if (inside.length < window.limit) return [];
                const oldest = inside[0] ?? nowMs;
                return [oldest + window.windowMs - nowMs];
            });
            if (waits.length > 0) {
                const retryAfterSeconds = Math.max(1, Math.ceil(Math.min(...waits) / 1000));
                return { allowed: false, retryAfterSeconds };
            }
            fresh.push(nowMs);
            takes.set(userId, fresh);
            return { allowed: true, retryAfterSeconds: 0 };
        },
    };
};

/** Both commands share one limiter: the budget is per user, not per command */
export const shareCommandLimiter = createShareCommandLimiter();

const rootSummaryOf = (root: ContextMessage): string =>
    plainExcerptOf(root.text, ROOT_SUMMARY_MAX)
    ?? plainExcerptOf(root.mediaHint, ROOT_SUMMARY_MAX)
    ?? EMPTY_SUMMARY;

export type ShareCommandTarget =
    | { ok: true; kind: 'conversation'; rootId: number; rootSummary: string }
    | { ok: true; kind: 'reply'; firstMessageId: number }
    | { ok: false; reason: ShareCommandFailure };

export interface ResolveShareTargetInput {
    chatId: number;
    repliedMessageId: number;
    mode: ShareCommandKind;
    /** The replied message was sent by this bot */
    repliedFromBot: boolean;
}

/**
 * Map the replied-to message onto a share target. A reply is normalized to its
 * first segment: the share service's reply gate only knows bot_responses ids.
 */
export const resolveShareTargetForCommand = async (input: ResolveShareTargetInput): Promise<ShareCommandTarget> => {
    const botReply = await findBotResponseByMessageId(input.chatId, input.repliedMessageId);

    if (input.mode === 'reply') {
        if (botReply === null) {
            return { ok: false, reason: input.repliedFromBot ? 'bot_reply_expired' : 'not_bot_reply' };
        }
        return { ok: true, kind: 'reply', firstMessageId: botReply.messageId };
    }

    // The trigger user message is the panel's conversation identity; the stored
    // reply and the replied id are fallbacks for rows whose trigger is gone
    const anchors = [botReply?.userMessageId, botReply?.messageId, input.repliedMessageId];
    for (const anchor of anchors) {
        if (anchor === undefined || !Number.isSafeInteger(anchor) || anchor < 1) continue;
        const root = await findRootMessage(input.chatId, anchor, { recover: false });
        if (root !== null) {
            return {
                ok: true,
                kind: 'conversation',
                rootId: root.messageId,
                rootSummary: rootSummaryOf(root),
            };
        }
    }
    return { ok: false, reason: 'not_stored' };
};

export interface FormatShareCommandReplyInput {
    kind: ShareCommandKind;
    url: string;
    /** Plain-text excerpt of the conversation root; null for a single reply */
    rootSummary: string | null;
    /** true when this command created the link, false when it reused one */
    created: boolean;
    createdBy: number;
    senderId: number;
}

const shareCreatedLine = (input: FormatShareCommandReplyInput): string =>
    input.kind === 'conversation'
        ? `已分享会话「${input.rootSummary ?? EMPTY_SUMMARY}」；创建者可在面板撤销（/panel）。`
        : '已分享这条回复；创建者可在面板撤销（/panel）。';

const reuseOwnerHint = (createdBy: number, senderId: number): string =>
    createdBy === senderId ? '（你创建的链接，可在面板撤销）' : '（由其他成员或系统创建；撤销请联系创建者或机主）';

export const formatShareCommandReply = (input: FormatShareCommandReplyInput): string => {
    if (input.created) {
        const headline = '🔗 公开分享链接（拿到链接的人都能查看）：';
        return `${headline}\n${input.url}\n\n${shareCreatedLine(input)}`;
    }
    const headline = '🔗 分享链接（这个内容之前已分享过，链接相同）：';
    return `${headline}\n${input.url}\n\n${reuseOwnerHint(input.createdBy, input.senderId)}`;
};

const runShareCommand = async (ctx: CommandContext<Context>, kind: ShareCommandKind): Promise<void> => {
    const startedAt = Date.now();
    try {
        if (!shareCommandEnabled() || !isPanelRunning()) {
            await ctx.reply(OFF_TEXT);
            return;
        }

        const replied = ctx.message?.reply_to_message;
        const chat = ctx.chat;
        const sender = ctx.from;
        if (replied === undefined || chat === undefined || sender === undefined) {
            await ctx.reply(USAGE_TEXT);
            return;
        }
        // A channel post has no reply-chain context a member could share, and
        // answering inside a channel is noise
        if (chat.type === 'channel') return;
        // Anonymous admins and other bots have no panel identity to revoke the link
        if (sender.is_bot) {
            await ctx.reply(PERSONAL_ACCOUNT_TEXT);
            return;
        }
        // Independent commands: no arguments, anything after the command is usage
        if (ctx.match.trim() !== '') {
            await ctx.reply(USAGE_TEXT);
            return;
        }

        const gate = shareCommandLimiter.take(sender.id);
        if (!gate.allowed) {
            await ctx.reply(`分享太频繁了，请 ${gate.retryAfterSeconds} 秒后再试。`);
            return;
        }

        // This bot's own id: botInfo once bot.start() has fetched it, the env
        // value as the fallback for a context without botInfo (offline tests)
        const ownUserId = (): number => {
            try {
                return ctx.me.id;
            } catch {
                return Number(process.env.BOT_USER_ID);
            }
        };
        const botUserId = ownUserId();
        const target = await resolveShareTargetForCommand({
            chatId: chat.id,
            repliedMessageId: replied.message_id,
            mode: kind,
            repliedFromBot: replied.from?.is_bot === true && replied.from.id === botUserId,
        });
        if (!target.ok) {
            await ctx.reply(shareCommandFailureText(target.reason));
            return;
        }

        const result = await createUserShare({
            kind: target.kind,
            chatId: chat.id,
            ...(target.kind === 'reply'
                ? { firstMessageId: target.firstMessageId }
                : { rootId: target.rootId }),
            createdBy: sender.id,
            ensurePreviewOnReuse: false,
        });
        if (!result.ok) {
            await ctx.reply(shareCreateFailureText(result.reason));
            return;
        }

        const share = result.share;
        await ctx.reply(formatShareCommandReply({
            kind: share.kind,
            url: share.url,
            rootSummary: target.kind === 'conversation' ? target.rootSummary : null,
            created: result.created,
            createdBy: share.createdBy,
            senderId: sender.id,
        }));
        const targetId = target.kind === 'reply' ? target.firstMessageId : target.rootId;
        console.log(
            `[share-command] chat=${chat.id} user=${sender.id} kind=${share.kind} target=${targetId} created=${result.created} token=${share.token} ms=${Date.now() - startedAt}`
        );
    } catch (error) {
        console.error(`[share-command] ${kind} command failed:`, error);
        // A failed command must not crash the bot: report it and carry on
        await ctx.reply(SHARE_FAILED_TEXT).catch((replyError: unknown) => {
            console.error('[share-command] sending the failure reply failed:', replyError);
        });
    }
};

export const registerShareCommand = (bot: Bot): void => {
    bot.command('share', (ctx) => runShareCommand(ctx, 'conversation'));
    bot.command('shareone', (ctx) => runShareCommand(ctx, 'reply'));
};
