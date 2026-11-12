/**
 * Retry handler for bot responses
 * Handles retry logic when user clicks retry button
 * Reuses the same processStream and sendFinalResponse as normal flow
 */
import type { Context } from 'grammy';
import { match } from 'ts-pattern';
import { GEMINI_IMAGE_MODEL, OPENAI_IMAGE_MODEL } from '../config/models.js';
import { getMessage, getBotResponse } from '../db/index.js';
import type { CommandType } from '../db/index.js';
import { collectReferenceImages } from './commands/reference-images.js';
import { startRetry } from '../services/index.js';
import {
    sendMessage,
    buildStaticSystemPrompt,
    carriesLargeMedia,
    getModelCapabilities,
    isOpenCodeGoModel,
    openCodeGoSessionId,
} from '../ai/index.js';
import { buildContext, buildContextFromParts } from './context-builder.js';
import { appendWorkspaceManifestForReply } from './workspace/workspace-manifest.js';
import { chatTitleOf } from '../telegram/chat-title.js';
import { resolveContextRoot } from './context-root.js';
import { buildReplyToolContext, createReplyTools } from './tools/index.js';
import { snapshotReplySettings } from '../services/chat-settings-service.js';
import {
    effectiveReplyModel,
    resolveAccessTier,
    resolveTriggerAccess,
    type AccessTier,
} from '../services/access-tier.js';
import { formatUserDisplayName } from '../shared/user-display-name.js';
import { sendBotNotice } from '../services/bot-notice-service.js';
import { TRIAL_COMMAND_REFUSAL_TEXT } from './commands/trial-refusal.js';
import { triggerAccessNoteOf } from './trigger-access-note.js';
import { buildStaticPromptOptions } from './static-prompt-options.js';
import { to } from '../shared/result.js';
import {
    markRequestStarted,
    recordContextSize,
    recordReferenceImages,
} from '../services/reply-metrics-draft.js';
import {
    createChatContextForRetry,
    processStream,
    sendFinalResponse,
    handleResponseError,
} from './response-handler.js';
import type { UnifiedContentPart } from '../ai/types.js';
import { checkpointSinkFor } from './resume/keep-checkpoint.js';
import { captureResumeFacts } from './resume/resume-facts.js';

/**
 * Handle retry for a bot response
 */
export const handleRetryRequest = async (
    ctx: Context,
    firstMessageId: number
): Promise<void> => {
    if (!ctx.chat) return;

    const chatId = ctx.chat.id;

    console.log('[retry-handler] Starting retry for message:', firstMessageId);

    // Get bot response record
    const botResponse = await getBotResponse(chatId, firstMessageId);
    if (!botResponse) {
        console.error('[retry-handler] BotResponse not found');
        return;
    }

    // Check command type for routing
    const metadata = botResponse.getMetadata();
    const commandType: CommandType = metadata.commandType || 'chat';

    // A retry re-generates and re-bills: the tier is whoever pressed the
    // button (design §9.3), so a trial user cannot rerun a paid image reply
    const access = await resolveAccessTier(ctx.from?.id ?? null, chatId);
    if (access === 'trial' && commandType === 'picgpt') {
        await sendBotNotice(ctx, TRIAL_COMMAND_REFUSAL_TEXT);
        return;
    }

    return match(commandType)
        .with('picbanana', () => handlePicbananaRetry(ctx, botResponse))
        .with('picgpt', () => handlePicgptRetry(ctx, botResponse))
        .with('chat', () => handleChatRetry(ctx, botResponse, access))
        .exhaustive();
};

/**
 * Handle retry for picbanana command
 */
const handlePicbananaRetry = async (
    ctx: Context,
    botResponse: Awaited<ReturnType<typeof getBotResponse>>
): Promise<void> => {
    if (!botResponse || !ctx.chat) return;

    const chatId = ctx.chat.id;

    // Start retry session
    const session = await startRetry(ctx, botResponse.messageId, { model: GEMINI_IMAGE_MODEL });
    if (!session) {
        console.error('[retry-handler] Failed to create retry session for picbanana');
        return;
    }

    // Create chat context for retry
    const chatContext = createChatContextForRetry(ctx, session, 'picbanana');

    // Get original user message to extract prompt and images
    const [msgErr, userMessage] = await to(getMessage(chatId, botResponse.userMessageId));
    if (msgErr || !userMessage) {
        console.error('[retry-handler] Failed to get user message:', msgErr);
        await handleResponseError(chatContext, msgErr ?? new Error('Original user message not found'));
        return;
    }

    // Extract prompt from original message (strip /picbanana command prefix).
    // Stored text is pure content now; the EOF / "(I send ...)" strips only
    // cover legacy rows and can be dropped after 2026-07-24 (7-day retention).
    const originalText = userMessage.text
        ?.replace(/<<EOF\s*$/, '')
        ?.replace(/\s*\(I send [^)]+\)\s*$/, '')
        || '';
    const commandMatch = originalText.match(/^\/picbanana(@\S+)?\s*([\s\S]*)?$/);
    const prompt = commandMatch?.[2]?.trim() || originalText;

    // Collect reference images (same helper as the live command)
    const referenceImages = await collectReferenceImages(chatId, [
        userMessage.replyToId,
        botResponse.userMessageId,
    ]);

    // Build content parts
    const contentParts: UnifiedContentPart[] = [
        { type: 'text', text: prompt },
    ];

    referenceImages.forEach((imageData) => {
        contentParts.push({ type: 'image', imageData });
    });

    // Build context from parts
    const messages = buildContextFromParts(contentParts);
    recordReferenceImages(session.metrics, referenceImages.length);

    // Send to Gemini image model; like the live command, ride out 429s until an image comes back
    markRequestStarted(session.metrics);
    const [streamErr, stream] = await to(
        sendMessage(messages, {
            model: GEMINI_IMAGE_MODEL,
            maxRetries: 50,
            signal: session.streamController.signal,
            usageSink: session.metrics.usage,
        })
    );
    if (streamErr) {
        console.error('[retry-handler] Failed to send picbanana message:', streamErr);
        await handleResponseError(chatContext, streamErr);
        return;
    }

    // Process stream (same as normal flow)
    const [processErr, response] = await to(processStream(stream, chatContext));
    if (processErr) {
        console.error('[retry-handler] Failed to process picbanana stream:', processErr);
        await handleResponseError(chatContext, processErr);
        return;
    }

    // Send final response (same as normal flow)
    const [sendErr] = await to(sendFinalResponse(chatContext, response));
    if (sendErr) {
        console.error('[retry-handler] Failed to send picbanana final response:', sendErr);
    }
};

/**
 * Handle retry for picgpt command
 */
const handlePicgptRetry = async (
    ctx: Context,
    botResponse: Awaited<ReturnType<typeof getBotResponse>>
): Promise<void> => {
    if (!botResponse || !ctx.chat) return;

    const chatId = ctx.chat.id;

    // Start retry session
    const session = await startRetry(ctx, botResponse.messageId, { model: OPENAI_IMAGE_MODEL });
    if (!session) {
        console.error('[retry-handler] Failed to create retry session for picgpt');
        return;
    }

    // Create chat context for retry
    const chatContext = createChatContextForRetry(ctx, session, 'picgpt');

    // Get original user message to extract prompt and images
    const [msgErr, userMessage] = await to(getMessage(chatId, botResponse.userMessageId));
    if (msgErr || !userMessage) {
        console.error('[retry-handler] Failed to get user message:', msgErr);
        await handleResponseError(chatContext, msgErr ?? new Error('Original user message not found'));
        return;
    }

    // Extract prompt from original message (strip /picgpt command prefix; legacy strips as above)
    const originalText = userMessage.text
        ?.replace(/<<EOF\s*$/, '')
        ?.replace(/\s*\(I send [^)]+\)\s*$/, '')
        || '';
    const commandMatch = originalText.match(/^\/picgpt(@\S+)?\s*([\s\S]*)?$/);
    const prompt = commandMatch?.[2]?.trim() || originalText;

    // Collect reference images (same helper as the live command)
    const referenceImages = await collectReferenceImages(chatId, [
        userMessage.replyToId,
        botResponse.userMessageId,
    ]);

    // Build content parts
    const contentParts: UnifiedContentPart[] = [
        { type: 'text', text: prompt },
    ];

    referenceImages.forEach((imageData) => {
        contentParts.push({ type: 'image', imageData });
    });

    // Build context from parts
    const messages = buildContextFromParts(contentParts);
    recordReferenceImages(session.metrics, referenceImages.length);

    // Send to OpenAI image model
    markRequestStarted(session.metrics);
    const [streamErr, stream] = await to(
        sendMessage(messages, {
            model: OPENAI_IMAGE_MODEL,
            signal: session.streamController.signal,
            usageSink: session.metrics.usage,
        })
    );
    if (streamErr) {
        console.error('[retry-handler] Failed to send picgpt message:', streamErr);
        await handleResponseError(chatContext, streamErr);
        return;
    }

    // Process stream (same as normal flow)
    const [processErr, response] = await to(processStream(stream, chatContext));
    if (processErr) {
        console.error('[retry-handler] Failed to process picgpt stream:', processErr);
        await handleResponseError(chatContext, processErr);
        return;
    }

    // Send final response (same as normal flow)
    const [sendErr] = await to(sendFinalResponse(chatContext, response));
    if (sendErr) {
        console.error('[retry-handler] Failed to send picgpt final response:', sendErr);
    }
};

/**
 * Handle retry for normal chat
 */
const handleChatRetry = async (
    ctx: Context,
    botResponse: Awaited<ReturnType<typeof getBotResponse>>,
    access: AccessTier
): Promise<void> => {
    if (!botResponse || !ctx.chat) return;

    const chatId = ctx.chat.id;

    // The chat's settings at the moment retry was pressed; the model the
    // original version used is never carried over. A trial presser gets the
    // cheap model whatever the chat says (design D2).
    const settings = snapshotReplySettings(chatId);
    const model = effectiveReplyModel(access, settings.model);
    // The presser's tier was decided above; reuse it so the two cannot disagree
    const triggerAccess = await resolveTriggerAccess(
        ctx.from?.id ?? null,
        ctx.from ? formatUserDisplayName({ firstName: ctx.from.first_name, lastName: ctx.from.last_name }) : null,
        chatId,
        access
    );

    // Start retry session
    const session = await startRetry(ctx, botResponse.messageId, { model });
    if (!session) {
        console.error('[retry-handler] Failed to create retry session');
        return;
    }

    // Create chat context for retry (reuses same flow as normal messages)
    const chatContext = createChatContextForRetry(ctx, session);

    // Get original user message
    const [msgErr, userMessage] = await to(getMessage(chatId, botResponse.userMessageId));
    if (msgErr || !userMessage) {
        console.error('[retry-handler] Failed to get user message:', msgErr);
        await handleResponseError(chatContext, msgErr ?? new Error('Original user message not found'));
        return;
    }

    // Build AI context (exclude current bot response since we're retrying it)
    const capabilities = getModelCapabilities(model);
    const [ctxErr, builtContext] = await to(buildContext(userMessage, {
        capabilities,
        model,
        chatTitle: chatTitleOf(ctx.chat),
        chatAddendum: settings.promptAddendum,
        excludeMessageIds: [botResponse.messageId], // Exclude the bot response we're retrying
        triggerAccess: triggerAccessNoteOf(triggerAccess),
    }));
    if (ctxErr || !builtContext) {
        console.error('[retry-handler] Failed to build context:', ctxErr);
        await handleResponseError(chatContext, ctxErr ?? new Error('Failed to build context'));
        return;
    }
    const builtAt = Date.now();
    const { messages: chatContents, contextIndex } = builtContext;
    recordContextSize(session.metrics, contextIndex);

    // Argon rides the OpenCode Go subscription: reuse the same session id the
    // original turn used, so a retry stays inside the same upstream session.
    const openCodeGoSession = isOpenCodeGoModel(model)
        ? openCodeGoSessionId(chatId, await resolveContextRoot(chatId, botResponse.userMessageId))
        : null;

    // The context still answers the original message's author; the tier (and
    // therefore the model and tool set) is the one who pressed retry
    const signal = session.streamController.signal;
    const requestTraits = { carriesLargeMedia: carriesLargeMedia(chatContents) };
    const { tools, availability, workspaceState, toolState } = createReplyTools(
        model,
        buildReplyToolContext({
            chat: ctx.chat,
            triggerMessage: userMessage,
            contextIndex,
            conversationRootIds: builtContext.conversationRootIds,
            signal,
            api: ctx.api,
        }),
        requestTraits,
        settings.toolOverrides,
        access
    );
    // Same manifest injection as the first answer: the panel and a retry must
    // send the same volatile tail.
    await appendWorkspaceManifestForReply({
        messages: chatContents,
        triggerTurnIndex: builtContext.triggerTurnIndex,
        workspaceState,
        conversationRootIds: builtContext.conversationRootIds,
        contextIndex,
        enabled: availability.workspace,
        fileTools: availability.file,
        widgetTools: availability.widget,
    });

    const systemPrompt = buildStaticSystemPrompt(model, buildStaticPromptOptions(availability));
    // A retry starts from nothing, so it keeps its own checkpoints like a first answer
    chatContext.resumeFacts = captureResumeFacts({
        model,
        systemPrompt,
        tools,
        toolState,
        contextIndex,
        conversationRootIds: builtContext.conversationRootIds,
        requestTraits,
        promptAddendum: settings.promptAddendum,
        builtAt,
    });

    // Send to AI
    markRequestStarted(session.metrics);
    const [streamErr, stream] = await to(
        sendMessage(chatContents, {
            model,
            systemPrompt,
            ...(openCodeGoSession ? { sessionId: openCodeGoSession } : {}),
            signal,
            tools,
            usageSink: session.metrics.usage,
            checkpointSink: checkpointSinkFor(chatContext),
            ...(settings.geminiPriority ? { serviceTier: 'priority' as const } : {}),
        })
    );
    if (streamErr) {
        console.error('[retry-handler] Failed to send message:', streamErr);
        await handleResponseError(chatContext, streamErr);
        return;
    }

    // Process stream (same as normal flow)
    const [processErr, response] = await to(processStream(stream, chatContext));
    if (processErr) {
        console.error('[retry-handler] Failed to process stream:', processErr);
        await handleResponseError(chatContext, processErr);
        return;
    }

    // Send final response (same as normal flow)
    const [sendErr] = await to(sendFinalResponse(chatContext, response));
    if (sendErr) {
        console.error('[retry-handler] Failed to send final response:', sendErr);
    }
};
