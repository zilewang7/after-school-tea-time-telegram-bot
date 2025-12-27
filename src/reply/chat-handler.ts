/**
 * Main chat handler
 * Handles incoming messages and coordinates AI responses
 */
import type { Bot, Context } from 'grammy';
import { match, P } from 'ts-pattern';
import { to, isErr } from '../shared/result';
import { getMessage } from '../db';
import { sendMessage, getSystemPrompt, getModelCapabilities } from '../ai';
import { getCurrentModel, getMediaGroupIdTemp, getAsyncFileSaveMsgIdList } from '../state';
import { checkIfMentioned } from '../util';
import { buildContext } from './context-builder';
import {
    createChatContext,
    processStream,
    sendFinalResponse,
    handleResponseError,
} from './response-handler';
import { handlePicbananaCommand, checkPicbananaCommand } from './commands/picbanana-handler';
import { dealChatCommand } from './commands/chat-command';

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
    const mediaGroupTemp = getMediaGroupIdTemp();

    return Boolean(
        ctx.message?.photo &&
        mediaGroupTemp.chatId === ctx.chat?.id &&
        mediaGroupTemp.messageId !== ctx.message?.message_id &&
        mediaGroupTemp.mediaGroupId === ctx.update?.message?.media_group_id
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

    // Skip duplicate media group messages
    if (shouldSkipMessage(ctx)) return;

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
    bot.on(['msg:text', 'msg:photo', 'msg:sticker'], async (ctx, next) => {
        // Call next middleware first
        next();

        // Process message after middleware chain
        setTimeout(async () => {
            // Wait for async file save operations
            await waitForFileSave();

            // Check for /picbanana command
            const [mentionInPicbanana, picbananaData] = await checkPicbananaCommand(ctx);
            if (picbananaData) {
                await handlePicbananaCommand(ctx, picbananaData);
                return;
            }

            // Check for /chat command (adds context)
            const mentionInChat = await dealChatCommand(ctx);

            const mention = match([mentionInPicbanana, mentionInChat])
                .with([P.boolean, P.boolean], ([a, b]) => a || b)
                .with([P.boolean, undefined], ([a, _]) => a)
                .with([undefined, P.boolean], ([_, b]) => b)
                .otherwise(() => undefined);

            // Handle normal reply
            await handleReply(ctx, { mention });
        });
    });
};

// Re-export for backward compatibility
export { handleReply as reply };
