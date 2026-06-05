/**
 * Main chat handler
 * Handles incoming messages and coordinates AI responses
 */
import type { Bot, Context } from 'grammy';
import { to, isErr } from '../shared/result.js';
import { getMessage } from '../db/index.js';
import { sendMessage, getSystemPrompt, getModelCapabilities } from '../ai/index.js';
import { getCurrentModel, getMediaGroupIdTemp, getAsyncFileSaveMsgIdList, tryMarkUserMessageHandling } from '../state.js';
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

/**
 * Wait for async file save operations to complete
 */
const waitForFileSave = async (): Promise<void> => {
    while (getAsyncFileSaveMsgIdList().length) {
        await new Promise((resolve) => setTimeout(resolve, 100));
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

    // Idempotency: skip if this user message is already being handled or was
    // just handled. Guards against Telegram update re-delivery and re-entry of
    // the detached (setTimeout) handler.
    if (!tryMarkUserMessageHandling(ctx.chat.id, ctx.message.message_id)) return;

    const chatId = ctx.chat.id;
    const userMessageId = ctx.message.message_id;
    const model = getCurrentModel();

    // Create chat context (includes processing message and typing indicator)
    const chatContext = await createChatContext(ctx);
    if (!chatContext) {
        console.error('[chat-handler] Failed to create chat context');
        return;
    }

    // Get message from database
    const msgResult = await to(getMessage(chatId, userMessageId));
    if (isErr(msgResult)) {
        await handleResponseError(
            chatContext,
            msgResult[0]
        );
        return;
    }
    const msg = msgResult[1];
    if (!msg) {
        await handleResponseError(
            chatContext,
            new Error('读取消息失败')
        );
        return;
    }

    // Build AI context
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
        await handleResponseError(
            chatContext,
            processResult[0],
            // Pass partial text if available
            undefined
        );
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
export const registerChatHandler = (
    bot: Bot
): void => {
    bot.on(['msg:text', 'msg:photo', 'msg:sticker', 'msg:voice', 'msg:audio', 'msg:video', 'msg:video_note', 'msg:document'], async (ctx, next) => {
        // Call next middleware first
        next();

        // Process message after middleware chain.
        // NOTE: this runs detached from grammy's middleware chain, so errors here
        // do NOT reach bot.catch — they must be caught here or they crash the process.
        setTimeout(async () => {
            try {
                // Wait for async file save operations
                await waitForFileSave();

                // Check for /picbanana command
                const [mentionInPicbanana, picbananaData] = await checkPicbananaCommand(ctx);
                if (picbananaData) {
                    await handlePicbananaCommand(ctx, picbananaData);
                    return;
                }

                // Check for /picgpt command
                const [mentionInPicgpt, picgptData] = await checkPicgptCommand(ctx);
                if (picgptData) {
                    await handlePicgptCommand(ctx, picgptData);
                    return;
                }

                // Check for /chat command (adds context)
                const mentionInChat = await dealChatCommand(ctx);

                // Combine all mention flags (any truthy value means mentioned)
                const mention = mentionInPicbanana || mentionInPicgpt || mentionInChat;

                // Handle normal reply
                await handleReply(ctx, { mention });
            } catch (error) {
                console.error('[chat-handler] Unhandled error in deferred reply processing:', error);
            }
        });
    });
};

// Re-export for backward compatibility
export { handleReply as reply };
