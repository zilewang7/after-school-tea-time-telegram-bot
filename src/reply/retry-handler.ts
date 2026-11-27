/**
 * Retry handler for bot responses
 * Handles retry logic when user clicks retry button
 * Reuses the same processStream and sendFinalResponse as normal flow
 */
import type { Context } from 'grammy';
import { match } from 'ts-pattern';
import { GEMINI_IMAGE_MODEL, GROK_IMAGE_MODEL, OPENAI_IMAGE_MODEL } from '../config/models.js';
import { modelCatalogVersion } from '../config/model-catalog.js';
import { getMessage, getBotResponse } from '../db/index.js';
import type { CommandType } from '../db/index.js';
import { collectReferenceImages } from './commands/reference-images.js';
import { startRetry } from '../services/index.js';
import {
    sendMessage,
    buildStaticSystemPrompt,
    capabilitiesOf,
    logReplyTraits,
    resolveRuntimeTraits,
    isOpenCodeGoModel,
    openCodeGoSessionId,
} from '../ai/index.js';
import { buildContext, buildContextFromParts } from './context-builder.js';
import { appendWorkspaceTailForReply } from './workspace/workspace-tail.js';
import { chatTitleOf } from '../telegram/chat-title.js';
import { jailbreakPolicyText, readJailbreakSession } from '../services/jailbreak-session-service.js';
import { resolveContextRoot } from './context-root.js';
import { buildReplyToolContext, createReplyTools } from './tools/index.js';
import { snapshotReplySettings } from '../services/chat-settings-service.js';
import { resolveReplyAddendum } from '../services/prompt-templates-service.js';
import {
    effectiveReplyModel,
    resolveAccessTier,
    resolveTriggerAccess,
    type AccessTier,
} from '../services/access-tier.js';
import { formatUserDisplayName } from '../shared/user-display-name.js';
import { sendBotNotice } from '../services/bot-notice-service.js';
import { TRIAL_COMMAND_REFUSAL_TEXT, refuseTrialQuota } from './commands/trial-refusal.js';
import { refuseImageChatModel } from './image-model-refusal.js';
import { triggerAccessNoteOf } from './trigger-access-note.js';
import { buildStaticPromptOptions } from './static-prompt-options.js';
import { countCodePoints } from '../shared/code-points.js';
import { to } from '../shared/result.js';
import {
    markRequestStarted,
    recordContextSize,
    recordImageGeneration,
    recordReferenceImages,
    recordThinkingEffort,
    setCatalogVersion,
} from '../services/reply-metrics-draft.js';
import { checkTrialQuota, type TrialSpend } from '../services/trial-quota.js';
import {
    createChatContextForRetry,
    processStream,
    sendFinalResponse,
    handleResponseError,
} from './response-handler.js';
import type { UnifiedContentPart } from '../ai/types.js';
import { runPicgrokGeneration } from './commands/picgrok-handler.js';
import { checkpointSinkFor } from './resume/keep-checkpoint.js';
import { captureResumeFacts } from './resume/resume-facts.js';
import { getContextNumbering } from '../state.js';
import { priorityRequestOf } from './priority-request.js';
import { thinkingRequestOf } from './thinking-request.js';

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
    if (access === 'trial' && (commandType === 'picgpt' || commandType === 'picgrok')) {
        await sendBotNotice(ctx, TRIAL_COMMAND_REFUSAL_TEXT);
        return;
    }
    // The spend cap is the presser's too (design 2026-1116-1500 §D7 #3): a
    // trial user whose cap is used up starts no retry at all
    const trialSpend = await checkTrialQuota(access, ctx.from?.id ?? null);
    if (await refuseTrialQuota(ctx, trialSpend)) return;

    return match(commandType)
        .with('picbanana', () => handlePicbananaRetry(ctx, botResponse, access))
        .with('picgpt', () => handlePicgptRetry(ctx, botResponse, access))
        .with('picgrok', () => handlePicgrokRetry(ctx, botResponse, access))
        .with('chat', () => handleChatRetry(ctx, botResponse, access, trialSpend))
        .exhaustive();
};

/**
 * Handle retry for picbanana command
 */
const handlePicbananaRetry = async (
    ctx: Context,
    botResponse: Awaited<ReturnType<typeof getBotResponse>>,
    access: AccessTier
): Promise<void> => {
    if (!botResponse || !ctx.chat) return;

    const chatId = ctx.chat.id;

    // Start retry session; the attempt records the presser's tier
    const session = await startRetry(ctx, botResponse.messageId, {
        model: GEMINI_IMAGE_MODEL,
        accessTier: access,
    });
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
    setCatalogVersion(session.metrics, modelCatalogVersion());

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
    botResponse: Awaited<ReturnType<typeof getBotResponse>>,
    access: AccessTier
): Promise<void> => {
    if (!botResponse || !ctx.chat) return;

    const chatId = ctx.chat.id;

    // Start retry session; the attempt records the presser's tier
    const session = await startRetry(ctx, botResponse.messageId, {
        model: OPENAI_IMAGE_MODEL,
        accessTier: access,
    });
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
    setCatalogVersion(session.metrics, modelCatalogVersion());

    // Send to OpenAI image model; no usageSink: call-billed model (design D5),
    // its row is priced per image, token usage would only mislead the panel
    markRequestStarted(session.metrics);
    const [streamErr, stream] = await to(
        sendMessage(messages, {
            model: OPENAI_IMAGE_MODEL,
            signal: session.streamController.signal,
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
 * Handle retry for a /picgrok reply: regenerate the same prompt through xAI and
 * deliver it on the new version, exactly like the live command.
 */
const handlePicgrokRetry = async (
    ctx: Context,
    botResponse: Awaited<ReturnType<typeof getBotResponse>>,
    access: AccessTier
): Promise<void> => {
    if (!botResponse || !ctx.chat) return;

    const chatId = ctx.chat.id;

    // Start retry session; the attempt records the presser's tier
    const session = await startRetry(ctx, botResponse.messageId, {
        model: GROK_IMAGE_MODEL,
        accessTier: access,
    });
    if (!session) {
        console.error('[retry-handler] Failed to create retry session for picgrok');
        return;
    }

    // Create chat context for retry
    const chatContext = createChatContextForRetry(ctx, session, 'picgrok');

    // Get original user message to extract the prompt
    const [msgErr, userMessage] = await to(getMessage(chatId, botResponse.userMessageId));
    if (msgErr || !userMessage) {
        console.error('[retry-handler] Failed to get user message:', msgErr);
        await handleResponseError(chatContext, msgErr ?? new Error('Original user message not found'));
        return;
    }

    // Extract prompt from the original command (legacy EOF / "(I send ...)" strips as elsewhere)
    const originalText = userMessage.text
        ?.replace(/<<EOF\s*$/, '')
        ?.replace(/\s*\(I send [^)]+\)\s*$/, '')
        || '';
    const commandMatch = originalText.match(/^\/picgrok(@\S+)?\s*([\s\S]*)?$/);
    const prompt = commandMatch?.[2]?.trim() || originalText;
    if (prompt === '') {
        await handleResponseError(chatContext, new Error('找不到原来的图片描述，请重新发送 /picgrok'));
        return;
    }

    setCatalogVersion(session.metrics, modelCatalogVersion());
    await runPicgrokGeneration(chatContext, prompt);
};

/**
 * Handle retry for normal chat
 */
const handleChatRetry = async (
    ctx: Context,
    botResponse: Awaited<ReturnType<typeof getBotResponse>>,
    access: AccessTier,
    /** The quota check made by the caller, reused for the runtime tail */
    trialSpend: TrialSpend | null
): Promise<void> => {
    if (!botResponse || !ctx.chat) return;

    const chatId = ctx.chat.id;

    // The chat's settings at the moment retry was pressed; the model the
    // original version used is never carried over. A trial presser gets the
    // cheap model whatever the chat says (design D2).
    const settings = snapshotReplySettings(chatId);
    // A retry inside a `/jb` tree keeps that tree's policy and model override
    const rootId = await resolveContextRoot(chatId, botResponse.userMessageId);
    const jbSession = access === 'trial' ? null : await readJailbreakSession(chatId, rootId);
    const jbPolicy = jbSession === null ? null : await jailbreakPolicyText(jbSession);
    const model =
        jbSession?.model !== null && jbSession?.model !== undefined && jbPolicy !== null
            ? jbSession.model
            : effectiveReplyModel(access, settings.model);
    // The presser's tier can swap the model, and the combination follows the model
    const addendum = await resolveReplyAddendum(
        chatId,
        {
            custom: settings.promptAddendum,
            templateIds: settings.promptTemplateIds,
            auto: settings.promptTemplatesAuto,
        },
        model
    );
    if (addendum.applied.length > 0) {
        console.log(
            `[retry-handler] addendum templates: ${addendum.applied.map((template) => template.name).join(', ')} (chat ${chatId}, model ${model})`
        );
    }
    const traits = resolveRuntimeTraits(model);
    // Before the retry session: the reply and its buttons stay as they are
    if (await refuseImageChatModel(ctx, model, traits)) return;
    logReplyTraits(traits);
    const capabilities = capabilitiesOf(traits);
    // The presser's tier was decided above; reuse it so the two cannot disagree
    const triggerAccess = await resolveTriggerAccess(
        ctx.from?.id ?? null,
        ctx.from ? formatUserDisplayName({ firstName: ctx.from.first_name, lastName: ctx.from.last_name }) : null,
        chatId,
        access
    );

    // Start retry session; the attempt records the presser's tier
    const session = await startRetry(ctx, botResponse.messageId, { model, accessTier: access });
    if (!session) {
        console.error('[retry-handler] Failed to create retry session');
        return;
    }

    // Create chat context for retry (reuses same flow as normal messages)
    const chatContext = createChatContextForRetry(ctx, session, 'chat', { richReplies: settings.richReplies });

    // Get original user message
    const [msgErr, userMessage] = await to(getMessage(chatId, botResponse.userMessageId));
    if (msgErr || !userMessage) {
        console.error('[retry-handler] Failed to get user message:', msgErr);
        await handleResponseError(chatContext, msgErr ?? new Error('Original user message not found'));
        return;
    }

    // Build AI context (exclude current bot response since we're retrying it)
    const [ctxErr, builtContext] = await to(buildContext(userMessage, {
        capabilities,
        model,
        chatTitle: chatTitleOf(ctx.chat),
        chatAddendum: addendum.text,
        excludeMessageIds: [botResponse.messageId], // Exclude the bot response we're retrying
        triggerAccess: triggerAccessNoteOf(triggerAccess, trialSpend),
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
    const { tools, availability, workspaceState, toolState, availableSkills } = createReplyTools(
        model,
        buildReplyToolContext({
            chat: ctx.chat,
            triggerMessage: userMessage,
            contextIndex,
            conversationRootIds: builtContext.conversationRootIds,
            signal,
            api: ctx.api,
            // A picture drawn inside this retried reply is billed to this attempt
            recordImageGeneration: (imageModel, usage) =>
                recordImageGeneration(session.metrics, imageModel, usage),
        }),
        settings.toolOverrides,
        access,
        undefined,
        capabilities
    );
    // Picture references and context numbers resolve as in the first answer
    chatContext.mediaState = toolState.media;
    chatContext.contextIndex = contextIndex;
    // Same volatile tail as the first answer: the panel and a retry must
    // send the same skill catalog, manifest and rich-reply notes.
    const tail = await appendWorkspaceTailForReply({
        messages: chatContents,
        triggerTurnIndex: builtContext.triggerTurnIndex,
        workspaceState,
        conversationRootIds: builtContext.conversationRootIds,
        contextIndex,
        enabled: availability.workspace,
        handoff: availability.handoff,
        fileTools: availability.file,
        widgetTools: availability.widget,
        richInlineImages: settings.richReplies === true && availability.sendImage,
        richReplies: settings.richReplies,
        availableSkills,
    });

    const staticPrompt = buildStaticSystemPrompt(model, buildStaticPromptOptions(availability), capabilities);
    const systemPrompt = jbPolicy === null ? staticPrompt : `${jbPolicy}\n\n${staticPrompt}`;
    console.log(
        `[prompt] model=${model} head=${countCodePoints(systemPrompt)} ` +
            `legend=${builtContext.legendChars} catalog=${tail.catalogChars} ` +
            `tools=${countCodePoints(JSON.stringify(tools.definitions))}`
    );
    // The retry sends the chat's current thinking level against the model it reuses
    const thinking = thinkingRequestOf(model, settings.thinkingEffort, traits);
    // A retry starts from nothing, so it keeps its own checkpoints like a first answer
    chatContext.resumeFacts = captureResumeFacts({
        model,
        systemPrompt,
        tools,
        toolState,
        contextIndex,
        // A continued reply renders its `#N` links with the same numbering
        numbering: getContextNumbering(chatId, botResponse.userMessageId),
        conversationRootIds: builtContext.conversationRootIds,
        promptAddendum: addendum.text,
        promptAddendumCustom: settings.promptAddendum,
        promptTemplateIds: settings.promptTemplateIds,
        promptTemplatesAuto: settings.promptTemplatesAuto,
        thinkingEffort: settings.thinkingEffort,
        thinkingEffortSent: thinking.facts.sent,
        traits,
        builtAt,
    });

    recordThinkingEffort(session.metrics, thinking.facts);
    setCatalogVersion(session.metrics, traits.catalogVersion);

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
            traits,
            ...priorityRequestOf(access, settings.geminiPriority),
            ...thinking.platform,
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
