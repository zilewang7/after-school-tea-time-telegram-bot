/**
 * Main chat handler
 * Handles incoming messages and coordinates AI responses
 */
import type { Bot, Context } from 'grammy';
import { to, isErr } from '../shared/result.js';
import { getMessage } from '../db/index.js';
import { getRepliesHistory, type ContextMessage } from '../db/queries/context-queries.js';
import { sendMessage, getSystemPrompt, getModelCapabilities } from '../ai/index.js';
import { getCurrentModel, getMediaGroupIdTemp, getAsyncFileSaveMsgIdList, getAsyncPreviewMsgIdList, tryMarkUserMessageHandling } from '../state.js';
import { checkIfMentioned } from '../util.js';
import { buildContext } from './context-builder.js';
import {
    createChatContext,
    processStream,
    sendFinalResponse,
    handleResponseError,
} from './response-handler.js';
import { handlePicbananaCommand, checkPicbananaCommand } from './commands/picbanana-handler.js';
import { handlePicgptCommand, checkPicgptCommand } from './commands/picgpt-handler.js';
import { dealChatCommand } from './commands/chat-command.js';

const MEDIA_WAIT_TIMEOUT_MS = 30000;

/**
 * Whether the bot will actually reply to this message — used to gate the
 * "downloading media" feedback so unrelated group messages don't trigger it.
 */
const willReply = (ctx: Context): boolean => {
    const text = ctx.message?.text ?? ctx.message?.caption ?? '';
    if (/^\/(picbanana|picgpt|chat)(@\S+)?(\s|$)/.test(text)) return true;
    return checkIfMentioned(ctx, undefined);
};

/**
 * Collect the message ids whose media this reply depends on, from the already
 * resolved context tree (reply chain + /chat-added messages, plus each message's
 * media-group sub-images recorded in `replies`).
 */
const collectContextMessageIds = (history: ContextMessage[], selfId: number): number[] => {
    const ids = new Set<number>([selfId]);
    for (const message of history) {
        ids.add(message.messageId);
        try {
            const replyIds: number[] = JSON.parse(message.replies);
            replyIds.forEach((id) => ids.add(id));
        } catch {
            // ignore malformed replies json
        }
    }
    return [...ids];
};

/** Immediate media ids for command paths: current message + reply target. */
const collectImmediateMediaIds = (ctx: Context): number[] => {
    const ids: number[] = [];
    if (ctx.message?.message_id) ids.push(ctx.message.message_id);
    if (ctx.message?.reply_to_message?.message_id) ids.push(ctx.message.reply_to_message.message_id);
    return ids;
};

/**
 * Wait for the given messages' media to finish saving while keeping the user
 * informed: post a "downloading" notice up front; on success delete it so the
 * normal processing placeholder takes over seamlessly; on timeout/failure edit
 * it into a report of which media failed (and won't be in context).
 */
const awaitMediaWithFeedback = async (ctx: Context, ids: number[]): Promise<void> => {
    if (!ctx.message || !ctx.chat) return;

    const pending = ids.filter((id) => getAsyncFileSaveMsgIdList().includes(id));
    const pendingPreview = ids.filter((id) => getAsyncPreviewMsgIdList().includes(id));
    if (pending.length === 0 && pendingPreview.length === 0) return; // nothing in flight → no notice, just continue

    const chatId = ctx.chat.id;

    const allSettled = (): boolean =>
        pending.every((id) => !getAsyncFileSaveMsgIdList().includes(id)) &&
        pendingPreview.every((id) => !getAsyncPreviewMsgIdList().includes(id));

    const waitLoop = async (): Promise<void> => {
        const start = Date.now();
        while (Date.now() - start < MEDIA_WAIT_TIMEOUT_MS) {
            if (allSettled()) return;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    };

    // Post the notice; if it can't be sent, degrade to a silent wait.
    // Preview-only failures are silent (an enhancement, not core content), so
    // the notice text just reflects what is being waited on.
    const noticeText = pending.length
        ? '⏳ 正在获取消息中的媒体，请稍候…'
        : '⏳ 正在获取链接预览，请稍候…';
    const noticeResult = await to(
        ctx.reply(noticeText, {
            reply_parameters: { message_id: ctx.message.message_id },
        })
    );
    if (isErr(noticeResult)) {
        await waitLoop();
        return;
    }
    const noticeId = noticeResult[1].message_id;

    await waitLoop();

    // Classify each media: failure if still pending (timeout), or saved with a
    // [system] failure marker, or without a cached file id.
    const failures: string[] = [];
    for (const id of pending) {
        const stuck = getAsyncFileSaveMsgIdList().includes(id);
        const message = await getMessage(chatId, id);
        if (stuck || !message?.fileUniqueId) {
            const name = message?.text?.match(/I send (a[^,()]*)/)?.[1]?.trim() ?? '媒体';
            const reason = stuck
                ? '下载超时'
                : (message?.text?.match(/\[system\]\s*([^)\n]*)/)?.[1]?.trim() || '获取失败');
            failures.push(`${name}：${reason}`);
        }
    }

    if (failures.length === 0) {
        // Seamless: drop the notice; the processing placeholder is sent next.
        await to(ctx.api.deleteMessage(chatId, noticeId));
    } else {
        // Keep the notice, turn it into a failure report.
        await to(
            ctx.api.editMessageText(
                chatId,
                noticeId,
                `⚠️ 以下媒体获取失败，不会纳入本次对话上下文：\n${failures.map((f) => `• ${f}`).join('\n')}`
            )
        );
    }
};

/**
 * Check if message should be skipped (duplicate media group)
 */
const shouldSkipMessage = (ctx: Context): boolean => {
    // Any media-group member (photo / video / document / ...) other than the
    // first one should be skipped — the first member carries the whole group.
    const mediaGroupId = ctx.update?.message?.media_group_id;
    if (!mediaGroupId) return false;

    const mediaGroupTemp = getMediaGroupIdTemp();

    return (
        mediaGroupTemp.chatId === ctx.chat?.id &&
        mediaGroupTemp.mediaGroupId === mediaGroupId &&
        mediaGroupTemp.messageId !== ctx.message?.message_id
    );
};

/**
 * Main reply handler
 */
export const handleReply = async (
    ctx: Context,
    options?: { mention?: boolean }
): Promise<void> => {
    if (!ctx.message || !ctx.chat) return;

    // Check if bot was mentioned
    if (!checkIfMentioned(ctx, options?.mention)) return;

    // Skip duplicate media group messages (any media type, not just photos)
    if (shouldSkipMessage(ctx)) return;

    const chatId = ctx.chat.id;
    const userMessageId = ctx.message.message_id;
    const model = getCurrentModel();

    // Resolve the context tree (reply chain + any messages /chat added to
    // `replies`) to learn which media this reply depends on, then wait for any
    // still downloading — with feedback — before the placeholder. buildContext
    // re-walks the tree AFTER this wait so freshly-downloaded files are read.
    const contextTree = await getRepliesHistory(chatId, userMessageId, { excludeSelf: false });
    await awaitMediaWithFeedback(ctx, collectContextMessageIds(contextTree, userMessageId));

    // Create chat context (includes processing message and typing indicator)
    const chatContext = await createChatContext(ctx);
    if (!chatContext) {
        console.error('[chat-handler] Failed to create chat context');
        return;
    }

    // Get message from database
    const msgResult = await to(getMessage(chatId, userMessageId));
    if (isErr(msgResult)) {
        await handleResponseError(chatContext, msgResult[0]);
        return;
    }
    const msg = msgResult[1];
    if (!msg) {
        await handleResponseError(chatContext, new Error('读取消息失败'));
        return;
    }

    // Build AI context (buildContext walks the reply tree itself, post-wait, so
    // media downloaded during the wait is now included).
    const capabilities = getModelCapabilities(model);
    const ctxResult = await to(buildContext(msg, capabilities));
    if (isErr(ctxResult)) {
        await handleResponseError(chatContext, ctxResult[0]);
        return;
    }
    const chatContents = ctxResult[1];

    // Send to AI and get stream
    const streamResult = await to(
        sendMessage(chatContents, {
            model,
            systemPrompt: getSystemPrompt(),
            signal: chatContext.session.streamController.signal,
        })
    );
    if (isErr(streamResult)) {
        await handleResponseError(chatContext, streamResult[0]);
        return;
    }
    const stream = streamResult[1];

    // Process stream and update message
    const processResult = await to(processStream(stream, chatContext));
    if (isErr(processResult)) {
        await handleResponseError(chatContext, processResult[0], undefined);
        return;
    }
    const response = processResult[1];

    // Send final response
    const sendResult = await to(sendFinalResponse(chatContext, response));
    if (isErr(sendResult)) {
        console.error('[chat-handler] Failed to send final response:', sendResult[0]);
    }
};

/**
 * Register chat handler on bot
 */
export const registerChatHandler = (bot: Bot): void => {
    bot.on(['msg:text', 'msg:photo', 'msg:sticker', 'msg:voice', 'msg:audio', 'msg:video', 'msg:video_note', 'msg:document'], async (ctx, next) => {
        // Call next middleware first
        next();

        // Process message after middleware chain.
        // NOTE: this runs detached from grammy's middleware chain, so errors here
        // do NOT reach bot.catch — they must be caught here or they crash the process.
        setTimeout(async () => {
            try {
                if (!ctx.message || !ctx.chat) return;

                // Only proceed for messages we'll actually reply to, so the
                // "downloading media" feedback never fires on unrelated messages.
                if (!willReply(ctx)) return;

                // Idempotency (covers all reply paths; also prevents a duplicate
                // trigger from posting two "downloading" notices).
                if (!tryMarkUserMessageHandling(ctx.chat.id, ctx.message.message_id)) return;

                const text = ctx.message.text ?? ctx.message.caption ?? '';
                const isPicCommand = /^\/(picbanana|picgpt)(@\S+)?(\s|$)/.test(text);

                if (isPicCommand) {
                    // Pic commands read reference images during the check, so wait
                    // for the current + reply target media first (with feedback).
                    await awaitMediaWithFeedback(ctx, collectImmediateMediaIds(ctx));

                    const [, picbananaData] = await checkPicbananaCommand(ctx);
                    if (picbananaData) {
                        await handlePicbananaCommand(ctx, picbananaData);
                        return;
                    }
                    const [, picgptData] = await checkPicgptCommand(ctx);
                    if (picgptData) {
                        await handlePicgptCommand(ctx, picgptData);
                        return;
                    }
                    return;
                }

                // /chat mutates the context tree (writes into `replies`); run it
                // BEFORE the wait (which happens inside handleReply, before
                // buildContext) so the wait covers the messages /chat pulls in.
                const mentionInChat = await dealChatCommand(ctx);
                await handleReply(ctx, { mention: mentionInChat });
            } catch (error) {
                console.error('[chat-handler] Unhandled error in deferred reply processing:', error);
            }
        });
    });
};

// Re-export for backward compatibility
export { handleReply as reply };
