/**
 * AI Response handler
 * Processes stream responses and updates Telegram messages
 */
import { match } from 'ts-pattern';
import type { Context } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import { to, isErr } from '../shared/result.js';
import { formatErrorForUser } from '../shared/errors.js';
import { THINKING_MAX_CHARS, THINKING_TRUNCATION_MARK } from '../shared/thinking-limits.js';
import {
    createSession,
    liveThinkingKeyOf,
    type BotMessageSession,
} from '../services/index.js';
import { buildResponseButtons } from '../cmd/menus/index.js';
import { ButtonState, type BotResponse, type CommandType } from '../db/index.js';

import {
    createTypingIndicator,
    createStreamingEditor,
    type StreamingEditor,
    type TypingIndicator,
} from '../telegram/index.js';
import { runApiCall } from '../telegram/edit-coordinator.js';
import { sendReplyFileMessage } from '../telegram/reply-file-send.js';
import { sendReplyImageMessage } from '../telegram/reply-image-send.js';
import {
    sendReplyWidgetLinkMessage,
    sendReplyWidgetMessage,
} from '../telegram/reply-widget-send.js';
import { editWidgetReplyMarkup } from '../telegram/widget-api.js';
import { isWidgetRenderConfigured, renderWidgetPng } from '../widget-image/index.js';
import { ensureSystemReplyShare, previewLinkUrlOf } from '../panel/share/share-link-service.js';
import type { ShareLinkRecord } from '../panel/share/share-types.js';
import { toApiEntities } from '../telegram/api-entities.js';
import { buildMessageLinkResolver } from '../telegram/message-link.js';
import { createContextLabelStripper, stripContextLabel } from './context-label.js';
import {
    linkifyContextNumbers,
    type ContextLinkResolver,
} from '../telegram/formatters/context-links.js';
import {
    registerBotReplyInFlight,
    registerContinuation,
    registerReplyInFlight,
    showsResumableVersion,
} from '../state.js';
import { touchProcessingBotResponse } from '../db/queries/bot-response-heartbeat.js';
import {
    concatMessages,
    renderMarkdown,
} from 'telegram-md-entities';
import type { RenderedMessage } from 'telegram-md-entities';
import { buildErrorDisplay } from '../telegram/formatters/error-display.js';
import {
    formatThinkingForStreaming,
    formatThinkingPreviewForLink,
    thinkingOverflowsMessage,
} from '../telegram/formatters/thinking-display.js';
import {
    renderThinkingLinkMessage,
    renderThinkingLinkStreaming,
    thinkingLinkPreviewOptions,
    thinkingLinkSummaryOf,
} from '../telegram/formatters/thinking-link.js';
import { renderThinkingQuote } from '../telegram/formatters/quoted-render.js';
import { buildFinalMessages, type FinalMessageChunk } from '../telegram/formatters/final-message-builder.js';
import { splitRawByFits, splitAtLastNewline } from '../telegram/formatters/smart-splitter.js';
import { buildImageCaption, type ImageCaptionFields } from './tools/image-message.js';
import {
    appendLiveThinking,
    beginThinkingLink,
    thinkingLinkEnabled,
    type ThinkingLinkRef,
} from '../panel/thinking/thinking-link-service.js';
import {
    buildWidgetLinkMessage,
    isWidgetNotAllowedError,
    miniAppShortName,
    resolveWidgetDelivery,
    widgetMiniAppLink,
} from './widget-link-fallback.js';
import type {
    StreamChunk,
    AIResponse,
    FileDelivery,
    ResponseState,
    StickerDelivery,
    ToolStatus,
    WidgetDelivery,
} from '../ai/types.js';
import type { ToolLoopCheckpoint } from '../ai/tools/tool-loop-checkpoint.js';
import type { FinalizeOptions } from '../services/bot-message-service.js';
import {
    fillToolUsageFromCheckpoint,
    keepPreparedCheckpoint,
    prepareCheckpointKeep,
    withKeptRoundsLine,
} from './resume/keep-checkpoint.js';
import type { ReplyResumeFacts } from './resume/reply-checkpoint.js';
import { getToolConfig } from '../config/tool-config.js';
import { noteStreamChunk } from '../services/reply-metrics-draft.js';
import { findStickerByPackIndex } from '../services/sticker-catalog.js';
import { downloadStickerPreview } from '../services/sticker-set-service.js';

const MESSAGE_LENGTH_LIMIT = 3900;
/** Per-message entity budget during streaming (server cap is ~100; the
 *  final pass re-renders per message so a little headroom is enough) */
const MESSAGE_ENTITY_LIMIT = 85;
const THINKING_BUFFER_LIMIT = 10000;
/** Link-mode trigger: the rendered thinking reaches the message budget minus the
 *  status-line headroom, exactly where the legacy split switch fires */
const THINKING_LINK_LENGTH_TRIGGER = MESSAGE_LENGTH_LIMIT - 50;
/** Below this remaining budget, move the whole text to the continuation
 *  instead of squeezing a tiny tail that would be chopped mid-sentence */
const MIN_TAIL_TEXT_BUDGET = 500;
/** Shown in place of a reply that was only an image Telegram would not take */
const IMAGE_NOT_SENT_TEXT = '[image failed to send]';
/** Shown in place of a reply that was only a sticker Telegram would not take */
const STICKER_NOT_SENT_TEXT = '[sticker failed to send]';
/** Shown in place of a reply that was only a file Telegram would not take */
const FILE_NOT_SENT_TEXT = '[file failed to send]';
/** Shown in place of a reply that was only a widget Telegram would not take */
const WIDGET_NOT_SENT_TEXT = '[widget failed to send]';

/**
 * Chat context for response handling
 */
export interface ChatContext {
    ctx: Context;
    chatId: number;
    userMessageId: number;
    editor: StreamingEditor;
    typing: TypingIndicator;
    /** Current response state for idle updates */
    currentState?: ResponseState;
    /** Bot message session for lifecycle management */
    session: BotMessageSession;
    /** Current button state for maintaining buttons during edits */
    currentButtonState: ButtonState;
    /** Flag to prevent idle updates after finalization */
    isFinalized: boolean;
    /** Command type for image generation context detection and retry routing */
    commandType: CommandType;
    /**
     * The last checkpoint the tool loop handed over (only the Gemini loop
     * does). A failure or stop with one at hand keeps it for "继续".
     */
    lastCheckpoint?: ToolLoopCheckpoint;
    /** What a kept checkpoint needs besides that, captured where the context and tools were built */
    resumeFacts?: ReplyResumeFacts;
}

/**
 * Options for creating chat context
 */
export interface CreateChatContextOptions {
    /** Model generating this reply; recorded on the response and its version */
    model: string;
    /** Command type for retry routing */
    commandType?: CommandType;
}

/**
 * Create chat context from grammy context
 */
export const createChatContext = async (
    ctx: Context,
    options: CreateChatContextOptions
): Promise<ChatContext | null> => {
    if (!ctx.message || !ctx.chat) return null;

    const chatId = ctx.chat.id;
    const userMessageId = ctx.message.message_id;

    // Create typing indicator
    const typing = createTypingIndicator(ctx.api, chatId);
    typing.start();

    // Create bot message session (handles processing message creation)
    const session = await createSession(ctx, userMessageId, {
        model: options.model,
        commandType: options.commandType,
    });
    if (!session) {
        typing.stop();
        console.error('[response-handler] Failed to create bot message session');
        return null;
    }

    // Create chat context
    const chatContext: ChatContext = {
        ctx,
        chatId,
        userMessageId,
        editor: null as any, // Will be set below
        typing,
        currentState: undefined,
        session,
        currentButtonState: ButtonState.PROCESSING,
        isFinalized: false,
        commandType: options.commandType ?? 'chat',
    };

    // Create StreamingEditor with idle update callback
    const editor = createStreamingEditor({
        api: ctx.api,
        chatId,
        messageId: session.currentMessageId,
        idleInterval: 2500,
        initialContent: '✽ Thinking...', // Initial message content to avoid duplicate edits
        getButtons: () => {
            // Stop idle updates when finalized or stream aborted (stop button)
            if (chatContext.isFinalized || session.streamController.isAborted()) {
                return undefined;
            }
            return buildResponseButtons(chatContext.currentButtonState);
        },
    });

    chatContext.editor = editor;

    return chatContext;
};

/**
 * Process stream chunk and update state.
 * Exported for the offline tests, which pin the label stripping to this seam.
 */
export const processChunk = (
    chunk: StreamChunk,
    state: ResponseState,
    stripLeadingLabel: (chunk: string) => string
): ResponseState => {
    return match(chunk)
        .with({ type: 'text' }, ({ content }) => {
            // Drops a `[#N]` label the model copied from its own history; a
            // no-op for every reply that doesn't start with one
            const appended = stripLeadingLabel(content ?? '');
            return {
                ...state,
                textBuffer: state.textBuffer + appended,
                fullText: state.fullText + appended,
            };
        })
        .with({ type: 'thinking' }, ({ content }) => {
            const appended = content ?? '';
            let newThinkingBuffer = state.thinkingBuffer + appended;
            let truncatedChars = state.thinkingTruncatedChars;

            // Display buffer: bounded so a long CoT cannot flood the message
            if (newThinkingBuffer.length > THINKING_BUFFER_LIMIT) {
                truncatedChars += newThinkingBuffer.length;
                newThinkingBuffer = `[reasoning truncated, ${truncatedChars} chars omitted to avoid telegram flood]\n`;
            }

            // Full buffer: what the version stores and the thinking page reads.
            // Once the cap is hit, the truncation mark is appended and the rest
            // is dropped (the same cap the live stream keeps).
            let newFullThinking = state.fullThinking;
            if (newFullThinking.length < THINKING_MAX_CHARS) {
                newFullThinking += appended;
                if (newFullThinking.length > THINKING_MAX_CHARS) {
                    newFullThinking =
                        newFullThinking.slice(0, THINKING_MAX_CHARS) + THINKING_TRUNCATION_MARK;
                }
            }

            return {
                ...state,
                thinkingBuffer: newThinkingBuffer,
                fullThinking: newFullThinking,
                thinkingTruncatedChars: truncatedChars,
            };
        })
        .with({ type: 'image' }, ({ imageData, imageCaption }) => ({
            ...state,
            images: imageData ? [...state.images, imageData] : state.images,
            // Only the first image is delivered, so only its caption is kept
            imageCaption:
                imageData && state.images.length === 0 ? imageCaption : state.imageCaption,
        }))
        .with({ type: 'sticker' }, ({ sticker }) => ({
            ...state,
            // One sticker per reply; a second call is ignored (the tool rejects it too)
            stickers:
                sticker && state.stickers.length === 0 ? [...state.stickers, sticker] : state.stickers,
        }))
        .with({ type: 'file' }, ({ file }) => ({
            ...state,
            // One file per reply: a later call carries the whole content, so it wins
            files: file ? [file] : state.files,
        }))
        .with({ type: 'widget' }, ({ widget }) => ({
            ...state,
            // One widget per reply: the last prepared card wins
            widgets: widget ? [widget] : state.widgets,
        }))
        .with({ type: 'grounding' }, ({ groundingMetadata }) => ({
            ...state,
            groundingData: groundingMetadata
                ? [...state.groundingData, groundingMetadata]
                : state.groundingData,
        }))
        // A status chunk without `status` clears the line
        .with({ type: 'status' }, ({ status }) => ({
            ...state,
            toolStatus: status,
        }))
        .with({ type: 'done' }, ({ rawResponse, agentStats }) => {
            const rawFinalText = (rawResponse as any)?.output_text;
            // This text bypassed the streaming stripper, so clean it here too
            const finalOutputText =
                typeof rawFinalText === 'string' ? stripContextLabel(rawFinalText) : rawFinalText;
            const canSafelyReplaceBufferedText =
                typeof finalOutputText === 'string' && state.fullText === state.textBuffer;

            return {
                ...state,
                agentStats: agentStats ?? state.agentStats,
                textBuffer: canSafelyReplaceBufferedText ? finalOutputText : state.textBuffer,
                fullText: canSafelyReplaceBufferedText ? finalOutputText : state.fullText,
                isDone: true,
                modelParts: (rawResponse as any)?.candidates?.[0]?.content?.parts,
                rawResponse,
            };
        })
        .exhaustive();
};

/**
 * Resolver that makes the `#N` context references in this reply clickable.
 * Built per render, not cached on the chat context: the numbering is published
 * by buildContext, which runs after the chat context already exists.
 */
const contextLinkResolverFor = (
    chatContext: ChatContext
): ContextLinkResolver | undefined =>
    buildMessageLinkResolver(chatContext.chatId, chatContext.userMessageId);

/**
 * How much of the full thinking the link-mode preview reads from. Link mode
 * never splits the message, so the display buffer does reach its flood cap and
 * turns into its omission placeholder; the preview must show the real CoT tail
 * instead, and only the last two sections are rendered out of this window.
 */
const LINK_PREVIEW_TAIL_CHARS = 4000;

/** The real tail of the thinking, cut at a paragraph boundary */
const linkPreviewTailOf = (state: ResponseState): string => {
    if (state.fullThinking.length <= LINK_PREVIEW_TAIL_CHARS) return state.fullThinking;
    const tail = state.fullThinking.slice(-LINK_PREVIEW_TAIL_CHARS);
    const start = tail.indexOf('\n\n');
    return start === -1 ? tail : tail.slice(start + 2);
};

/**
 * Format current state for display (without status text - handled by
 * StreamingEditor). While processing, markdown renders in streaming mode
 * (unclosed constructs show as their intended formatting) and thinking shows
 * as a rolling preview (older segments collapse while streaming); the final
 * pass renders strict and collapses thinking entirely.
 */
const formatStateForDisplay = (
    state: ResponseState,
    isProcessing: boolean,
    resolveContextLink?: ContextLinkResolver,
    thinkingLink?: ThinkingLinkRef,
): RenderedMessage => {
    // Link mode: the CoT lives behind the link, so the message only shows the
    // fixed-height link + last-two-sections preview instead of a quote
    if (thinkingLink !== undefined && !state.textBuffer) {
        return linkifyContextNumbers(
            renderThinkingLinkStreaming(
                thinkingLink,
                formatThinkingPreviewForLink(linkPreviewTailOf(state))
            ),
            resolveContextLink
        );
    }

    const parts: (RenderedMessage | string)[] = [];

    if (state.thinkingBuffer) {
        parts.push(
            isProcessing
                ? formatThinkingForStreaming(state.thinkingBuffer, {
                    answerStarted: Boolean(state.textBuffer),
                })
                : renderThinkingQuote(state.thinkingBuffer, { expandable: true })
        );
        if (state.textBuffer) {
            parts.push('\n');
        }
    }

    if (state.textBuffer) {
        // The whole text is cleaned here, not just the opening: a label the
        // model dropped further down must not show up mid-stream and then
        // disappear in the final edit
        parts.push(
            renderMarkdown(stripContextLabel(state.textBuffer), { streaming: isProcessing })
        );
    }

    // Linkified here, before the caller measures length/entities, so the
    // continuation split sees the same entity count the message will carry
    return linkifyContextNumbers(concatMessages(...parts), resolveContextLink);
};

/**
 * Finalize current message during streaming (before switching to continuation)
 * Note: Database save is handled by session.finalize() at the end
 */
const finalizeCurrentMessage = async (
    chatContext: ChatContext,
    state: ResponseState,
): Promise<void> => {
    const { editor } = chatContext;

    // Stop the editor first to prevent any race conditions with idle updates
    editor.stop();

    // Format final content (with collapse if needed)
    const finalContent = formatStateForDisplay(
        state,
        false,
        contextLinkResolverFor(chatContext)
    );

    // Update message with final content (no status text - isFinal)
    await editor.updateContent(finalContent.text, {
        entities: finalContent.entities,
        isFinal: true,
    });
};

/**
 * Create continuation message for long responses
 * Returns the new message ID
 */
const createContinuationMessage = async (
    chatContext: ChatContext
): Promise<number | null> => {
    const { ctx, chatId, userMessageId, session } = chatContext;

    // Build processing button for continuation
    const buttons = buildResponseButtons(chatContext.currentButtonState);

    // Create new processing message with button
    // Use a simple status placeholder - StreamingEditor will manage actual status
    const sendResult = await to(
        runApiCall(chatId, () =>
            ctx.api.sendMessage(chatId, 'continued', {
                reply_parameters: { message_id: userMessageId },
                reply_markup: buttons,
            })
        )
    );

    if (isErr(sendResult)) {
        console.error('[response-handler] Failed to create continuation message:', sendResult[0]);
        return null;
    }

    const newMessage = sendResult[1];
    session.messageIds.push(newMessage.message_id);
    // The continuation is the reply's last message from now on: terminal buttons
    // (retry / version switch) and the stored `currentMessageId` belong to it,
    // not to the message that just closed
    session.currentMessageId = newMessage.message_id;
    registerContinuation(chatId, newMessage.message_id, session.firstMessageId);

    // Create new StreamingEditor for the continuation message
    const newEditor = createStreamingEditor({
        api: ctx.api,
        chatId,
        messageId: newMessage.message_id,
        idleInterval: 2500,
        initialContent: 'continued',
        getButtons: () => {
            // Stop idle updates when finalized or stream aborted (stop button)
            if (chatContext.isFinalized || session.streamController.isAborted()) {
                return undefined;
            }
            return buildResponseButtons(chatContext.currentButtonState);
        },
    });

    // Replace the editor in context
    chatContext.editor = newEditor;

    return newMessage.message_id;
};

/**
 * Display-only: while a tool runs, its status line replaces the spinner word
 * and its chat action replaces "typing"; undefined restores both.
 */
const showToolStatus = (chatContext: ChatContext, status: ToolStatus | undefined): void => {
    chatContext.editor.setStatus(status?.text);
    chatContext.typing.setAction(status?.chatAction ?? 'typing');
    // The panel's live status shows the same line
    chatContext.session.statusLine = status?.text ?? null;
};

/**
 * Where the link-mode decision stands for one chunk: still waiting for the
 * thinking to overflow, active, or no longer possible for this reply.
 */
type ThinkingLinkActivation = 'waiting' | 'active' | 'failed';

/**
 * Activate link mode when the thinking alone already fills a message: create
 * (or reuse) the version's link and remember it on the session. A disabled
 * switch is filtered by the caller; a failed row keeps the legacy split path.
 */
const activateThinkingLink = async (
    chatContext: ChatContext,
    state: ResponseState,
    resolveContextLink?: ContextLinkResolver
): Promise<ThinkingLinkActivation> => {
    const { chatId, session } = chatContext;
    // The display buffer loses its tail past its own limit; measure the full
    // thinking then, so a single big chunk cannot hide the overflow
    const measured = state.thinkingTruncatedChars > 0 ? state.fullThinking : state.thinkingBuffer;
    if (
        !thinkingOverflowsMessage(
            measured,
            { maxLength: THINKING_LINK_LENGTH_TRIGGER, maxEntities: MESSAGE_ENTITY_LIMIT },
            resolveContextLink
        )
    ) {
        return 'waiting';
    }

    const ref = await beginThinkingLink({
        chatId,
        firstMessageId: session.firstMessageId,
        versionId: session.versionCount + 1,
        model: session.model,
    });
    if (ref === null) {
        console.warn('[thinking-link] link creation failed, keeping the legacy thinking split');
        return 'failed';
    }

    session.thinkingLink = { ...ref, key: liveThinkingKeyOf(session), emitted: false };
    console.log(
        `[thinking-link] active chat=${chatId} first=${session.firstMessageId} version=${session.versionCount + 1}`
    );
    return 'active';
};

/**
 * The thinking is done: finalize the streaming message as the link plus the
 * italic line about the CoT it hides (its preview card included, no
 * reply_markup so the stop button goes away), then open the continuation the
 * body streams into.
 */
const emitThinkingLink = async (
    chatContext: ChatContext,
    shownToolStatus: ToolStatus | undefined,
    thinking: string
): Promise<boolean> => {
    const link = chatContext.session.thinkingLink;
    if (link === undefined) return false;

    const { editor } = chatContext;
    // Stop the spinner before the final edit and drop the queued streaming state
    editor.stop();
    const message = renderThinkingLinkMessage(link, thinkingLinkSummaryOf(thinking) ?? undefined);
    const delivered = await editor.updateContent(message.text, {
        entities: message.entities,
        linkPreviewOptions: thinkingLinkPreviewOptions(link),
        isFinal: true,
    });
    if (!delivered) {
        console.warn('[thinking-link] the link message edit did not go through');
    }

    const continuationId = await createContinuationMessage(chatContext);
    if (continuationId === null) {
        // The link message is already final; the legacy final delivery still
        // replays the body, so the reply is not lost
        console.error('[thinking-link] continuation message failed; the link stays the first message');
        return false;
    }

    link.emitted = true;
    // A running tool's status line follows the body to the new message
    chatContext.editor.setStatus(shownToolStatus?.text);
    console.log(`[thinking-link] emitted chat=${chatContext.chatId} first=${chatContext.session.firstMessageId}`);
    return true;
};

/** Gap between two heartbeats of a reply being generated */
export const REPLY_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * The heartbeat of a reply that is still streaming; call it on every chunk.
 *
 * A reply can run far longer than the in-flight marks live (10 minutes) or
 * than `deploy:check` trusts a processing row (25 minutes). At most once per
 * interval it renews both marks and moves the row's updatedAt forward. A
 * finalized session is left alone, or a finished reply would be marked as
 * generating again. The row update is not awaited: a failed one only logs.
 * Exported for the offline tests, which drive it with their own clock.
 */
export const createReplyHeartbeat = (
    session: BotMessageSession,
    now: () => number = Date.now
): (() => void) => {
    let lastBeatAt = now();
    return () => {
        const beatAt = now();
        if (beatAt - lastBeatAt <= REPLY_HEARTBEAT_INTERVAL_MS) return;
        lastBeatAt = beatAt;
        if (session.isFinalized) return;

        registerReplyInFlight(session.chatId, session.userMessageId);
        // The first message is not in messageIds when a retry re-sent it
        for (const messageId of new Set([session.firstMessageId, ...session.messageIds])) {
            registerBotReplyInFlight(session.chatId, messageId);
        }
        void touchProcessingBotResponse(session.chatId, session.firstMessageId).catch((error: unknown) => {
            console.warn('[response-handler] heartbeat could not touch the reply row:', error);
        });
    };
};

/**
 * Process AI stream and update message in real-time
 */
export const processStream = async (
    stream: AsyncIterable<StreamChunk>,
    chatContext: ChatContext,
    updateInterval: number = 500
): Promise<AIResponse> => {
    const { session } = chatContext;

    let state: ResponseState = {
        textBuffer: '',
        thinkingBuffer: '',
        fullText: '',
        fullThinking: '',
        thinkingTruncatedChars: 0,
        images: [],
        stickers: [],
        files: [],
        widgets: [],
        groundingData: [],
        agentStats: undefined,
        modelParts: undefined,
        rawResponse: undefined,
        isDone: false,
    };

    let lastUpdateTime = Date.now();

    // The numbering is already published (buildContext ran before the stream)
    const resolveContextLink = contextLinkResolverFor(chatContext);
    // Per-stream, because the label can arrive split across the first chunks
    const stripLeadingLabel = createContextLabelStripper();
    // The tool status on screen; never synced to the session, so never stored
    let shownToolStatus: ToolStatus | undefined;
    // Link mode is decided once per stream: the switch, the live-thinking key,
    // and whether an attempt already failed (then the legacy path owns the reply)
    const linkFeatureOn = thinkingLinkEnabled();
    const attemptKey = liveThinkingKeyOf(session);
    let linkActivationFailed = false;
    let linkEmitAttempted = false;
    const heartbeat = createReplyHeartbeat(session);

    for await (const chunk of stream) {
        // Check if stream was aborted (user clicked stop)
        if (session.streamController.isAborted()) {
            console.log('[response-handler] Stream aborted by user');
            break;
        }

        // Any chunk counts, a status line included: a reply waiting on a
        // retry still shows that it is alive
        heartbeat();

        // First-chunk time and raw thinking length for the reply metrics
        noteStreamChunk(session.metrics, chunk);

        // The full thinking goes to the in-memory stream from the very first
        // chunk: the page can be open before the version (and token) exists
        if (linkFeatureOn && chunk.type === 'thinking' && chunk.content) {
            appendLiveThinking(attemptKey, chunk.content);
        }

        state = processChunk(chunk, state, stripLeadingLabel);
        const toolStatusChanged = state.toolStatus !== shownToolStatus;
        if (toolStatusChanged) {
            shownToolStatus = state.toolStatus;
            showToolStatus(chatContext, shownToolStatus);
        }

        // Link mode: the thinking itself fills a whole message when the answer
        // has not started yet (the legacy split keeps owning the started case)
        if (
            session.thinkingLink === undefined &&
            !linkActivationFailed &&
            state.textBuffer === '' &&
            linkFeatureOn
        ) {
            const activation = await activateThinkingLink(chatContext, state, resolveContextLink);
            if (activation === 'failed') linkActivationFailed = true;
        }

        // Once the link message went out, later thinking only feeds the page and
        // the stored version: it must not reappear in the body message
        if (session.thinkingLink?.emitted === true && state.thinkingBuffer !== '') {
            state = { ...state, thinkingBuffer: '' };
        }

        // The first body chunk finalizes the message as the link and continues
        // in a new one. A failed attempt leaves the legacy final delivery to
        // replay the link chunk, so it is not retried every chunk.
        if (
            session.thinkingLink !== undefined &&
            !session.thinkingLink.emitted &&
            state.textBuffer !== '' &&
            !linkEmitAttempted
        ) {
            linkEmitAttempted = true;
            if (await emitThinkingLink(chatContext, shownToolStatus, state.fullThinking)) {
                state = { ...state, thinkingBuffer: '' };
            }
        }

        // Sync complete text to session buffers (not the display buffers)
        session.textBuffer = state.fullText;
        session.thinkingBuffer = state.fullThinking;
        session.images = state.images;
        session.groundingData = state.groundingData;
        session.agentStats = state.agentStats;

        // Update current state for idle updates
        chatContext.currentState = state;

        // Format current display (without status - StreamingEditor handles it)
        const linkForDisplay =
            session.thinkingLink !== undefined && !session.thinkingLink.emitted
                ? session.thinkingLink
                : undefined;
        const rendered = formatStateForDisplay(state, true, resolveContextLink, linkForDisplay);

        // A pending link message is bounded by design: the message-budget split
        // only applies to the legacy shape (and to the body once the link is out)
        const linkPending =
            session.thinkingLink !== undefined && !session.thinkingLink.emitted;

        // Check if we need to switch to a new message: both budgets matter —
        // some buffer for the status text; entities past ~100 are dropped
        if (
            !linkPending &&
            (rendered.text.length >= MESSAGE_LENGTH_LIMIT - 50 ||
                rendered.entities.length >= MESSAGE_ENTITY_LIMIT)
        ) {
            console.log('[response-handler] Message budget exceeded, switching to continuation...');

            let thinkingToSend = state.thinkingBuffer;
            let remainingThinking = '';
            let textToSend = state.textBuffer;
            let remainingText = '';

            // Renderer used for thinking in the streaming (processing) view.
            // Linkified like the real display, so the measurements below match
            // the entity count the message actually carries.
            const renderThinkingForStreaming = (thinking: string): RenderedMessage =>
                linkifyContextNumbers(
                    formatThinkingForStreaming(thinking, {
                        answerStarted: Boolean(state.textBuffer),
                    }),
                    resolveContextLink
                );

            const thinkingRendered = state.thinkingBuffer
                ? renderThinkingForStreaming(state.thinkingBuffer)
                : concatMessages();

            // Case 1: Thinking alone can't fit in one message
            if (
                thinkingRendered.text.length >= MESSAGE_LENGTH_LIMIT ||
                thinkingRendered.entities.length >= MESSAGE_ENTITY_LIMIT
            ) {
                console.log('[response-handler] Thinking itself exceeds limit, splitting thinking...');
                // Exact-measure split: keeps everything already displayed
                const { currentPart, remaining } = splitRawByFits(
                    state.thinkingBuffer,
                    (prefix) => {
                        const measured = renderThinkingForStreaming(prefix);
                        return (
                            measured.text.length <= MESSAGE_LENGTH_LIMIT &&
                            measured.entities.length <= MESSAGE_ENTITY_LIMIT
                        );
                    }
                );
                thinkingToSend = currentPart;
                remainingThinking = remaining;
                textToSend = ''; // Can't send any text in this message
                remainingText = state.textBuffer; // Keep all text for next message
            } else {
                // Case 2: Thinking fits, but thinking + text is too long
                const newlineSpace = state.thinkingBuffer ? 1 : 0; // Newline between thinking and text
                const availableSpace = MESSAGE_LENGTH_LIMIT - thinkingRendered.text.length - newlineSpace;
                const availableEntities = MESSAGE_ENTITY_LIMIT - thinkingRendered.entities.length;
                const textFits = (prefix: string): boolean => {
                    const measured = linkifyContextNumbers(
                        renderMarkdown(prefix, { streaming: true }),
                        resolveContextLink
                    );
                    return (
                        measured.text.length <= availableSpace &&
                        measured.entities.length <= availableEntities
                    );
                };

                if (state.textBuffer) {
                    if (availableSpace < MIN_TAIL_TEXT_BUDGET) {
                        // Thinking ate the budget: don't close this message with
                        // a tiny text tail (even one that currently fits) —
                        // start the text cleanly in the next message
                        textToSend = '';
                        remainingText = state.textBuffer;
                    } else if (!textFits(state.textBuffer)) {
                        // Exact-measure split, preferring paragraph/newline boundaries
                        const { currentPart, remaining } = splitRawByFits(
                            state.textBuffer,
                            textFits
                        );
                        textToSend = currentPart;
                        remainingText = remaining;
                    } else {
                        // Text fits, but the message is closing mid-stream: end
                        // it at a paragraph/newline instead of wherever the last
                        // stream chunk happened to land
                        const { currentPart, remaining } = splitAtLastNewline(
                            state.textBuffer,
                            Math.floor(state.textBuffer.length / 4)
                        );
                        // Without thinking to carry the message, keep everything
                        // rather than finalizing a near-empty message
                        if (currentPart || state.thinkingBuffer) {
                            textToSend = currentPart;
                            remainingText = remaining;
                        }
                    }
                } else if (state.thinkingBuffer) {
                    // Thinking-only message closing mid-stream: same rule, end
                    // at a line boundary (keep whole when none qualifies)
                    const { currentPart, remaining } = splitAtLastNewline(
                        state.thinkingBuffer,
                        Math.floor(state.thinkingBuffer.length / 4)
                    );
                    if (currentPart) {
                        thinkingToSend = currentPart;
                        remainingThinking = remaining;
                    }
                }
            }

            // Finalize current message with what we can send
            await finalizeCurrentMessage(chatContext, {
                ...state,
                thinkingBuffer: thinkingToSend,
                textBuffer: textToSend,
            });

            // Create continuation message (also switches editor to new message)
            const newMessageId = await createContinuationMessage(chatContext);
            if (!newMessageId) {
                console.error('[response-handler] Failed to create continuation message, stopping stream');
                break;
            }
            // A running tool's status moves along to the new message
            chatContext.editor.setStatus(shownToolStatus?.text);

            // Update state with remaining content
            state.thinkingBuffer = remainingThinking; // May have remaining thinking
            state.textBuffer = remainingText; // Keep remaining text

            // Reset last update time
            lastUpdateTime = Date.now();
            continue;
        }

        // Update message periodically. A tool status change flushes at once:
        // the text streamed right before a long tool call must not sit behind
        // the throttle until the tool is done.
        const shouldUpdate =
            (state.textBuffer || state.thinkingBuffer) &&
            (toolStatusChanged || Date.now() - lastUpdateTime > updateInterval);

        if (shouldUpdate) {
            const buttons = buildResponseButtons(chatContext.currentButtonState);
            await chatContext.editor.updateContent(rendered.text, {
                entities: rendered.entities,
                replyMarkup: buttons,
                // The link shape carries the Mini App deep link as a text_link:
                // left alone, Telegram renders its own bot-app card above the
                // text. Pin the fast-page card instead, so the reader sees where
                // the link leads while the CoT is still being generated.
                ...(linkForDisplay === undefined
                    ? {}
                    : { linkPreviewOptions: thinkingLinkPreviewOptions(linkForDisplay) }),
            });
            lastUpdateTime = Date.now();
        }
    }

    // The streaming stripper only guards the opening, so the assembled text is
    // cleaned once more: what the final edit displays, what finalize stores and
    // therefore what the next context reads never carries an imitated label.
    state.textBuffer = stripContextLabel(state.textBuffer);
    state.fullText = stripContextLabel(state.fullText);
    session.textBuffer = state.fullText;

    return {
        text: state.textBuffer,
        thinkingText: state.thinkingBuffer,
        images: state.images,
        imageCaption: state.imageCaption,
        stickers: state.stickers,
        files: state.files,
        widgets: state.widgets,
        groundingData: state.groundingData,
        agentStats: state.agentStats,
        modelParts: state.modelParts,
        rawResponse: state.rawResponse,
    };
};

/**
 * A user edit can flip buttonState to EDIT_DETECTED while the final edits are
 * still in flight; the final edit (sent without markup) then wipes the retry
 * button autoUpdate just added. Re-check after delivery and re-apply it.
 */
const healEditDetectedButtons = async (chatContext: ChatContext): Promise<void> => {
    const { ctx, chatId, session } = chatContext;
    const { getBotResponse } = await import('../db/index.js');
    const response = await getBotResponse(chatId, session.firstMessageId);
    if (response?.buttonState !== ButtonState.EDIT_DETECTED) return;
    const buttons = buildResponseButtons(ButtonState.EDIT_DETECTED);
    const [err] = await to(
        runApiCall(chatId, () =>
            ctx.api.editMessageReplyMarkup(chatId, session.currentMessageId, {
                reply_markup: buttons,
            })
        )
    );
    if (!err) {
        console.log('[editMonitor] Re-applied edit-detected button after final edit');
    }
};

/**
 * Send the reply's image after its text, with the caption the model wrote
 * for it; a photo Telegram refuses goes out as a document, caption included,
 * and a refused caption is tried once more as plain text. Returns the id of
 * the message that carries the image, null when nothing went through.
 */
const sendReplyImage = async (
    chatContext: ChatContext,
    image: Buffer,
    captionFields: ImageCaptionFields
): Promise<number | null> => {
    const { ctx, chatId, userMessageId } = chatContext;

    // GIF goes out as an animation, everything else as a photo; the fallbacks
    // (document, then photo) live in the shared sender
    const sent = await sendReplyImageMessage({
        api: ctx.api,
        chatId,
        image,
        captionFields,
        target: { reply_parameters: { message_id: userMessageId } },
        runApiCall: (operation) => runApiCall(chatId, operation),
    });
    if (isErr(sent)) {
        console.error('[response-handler] image send failed:', sent[0]);
        return null;
    }
    return sent[1];
};

/**
 * Send the reply's (first) image and make it the last message of the reply.
 * An image that went out neither as a photo nor as a document is dropped
 * from the session, so it is not stored as part of the reply either (B7).
 * Returns whether it went out.
 */
const deliverReplyImage = async (
    chatContext: ChatContext,
    image: Buffer | undefined,
    captionFields: ImageCaptionFields
): Promise<boolean> => {
    const { session } = chatContext;
    const imageMessageId = image ? await sendReplyImage(chatContext, image, captionFields) : null;
    if (imageMessageId === null) {
        session.images = [];
        return false;
    }
    session.messageIds.push(imageMessageId);
    session.currentMessageId = imageMessageId;
    return true;
};

/**
 * Send the reply's file after its text. The same bytes stay on the session so
 * the stored version can re-upload them on a version switch; a failed send
 * leaves the reply without the file, as the image path does.
 */
const deliverReplyFile = async (
    chatContext: ChatContext,
    file: FileDelivery | undefined,
    captionFields: ImageCaptionFields
): Promise<boolean> => {
    const { session } = chatContext;
    if (!file) return false;

    const sent = await sendReplyFileMessage({
        api: chatContext.ctx.api,
        chatId: chatContext.chatId,
        file,
        captionFields,
        target: { reply_parameters: { message_id: chatContext.userMessageId } },
        runApiCall: (operation) => runApiCall(chatContext.chatId, operation),
    });
    if (isErr(sent)) {
        console.error('[response-handler] file send failed:', sent[0]);
        return false;
    }

    session.messageIds.push(sent[1]);
    session.currentMessageId = sent[1];
    session.file = file;
    return true;
};

/**
 * Send the reply's sticker after its text. The webp is downloaded too, so the
 * stored version and the next context can show what went out; a failed
 * download is only a missing preview, never a failed send.
 */
const deliverReplySticker = async (
    chatContext: ChatContext,
    sticker: StickerDelivery
): Promise<boolean> => {
    const { ctx, chatId, userMessageId, session } = chatContext;

    const sent = await to(
        runApiCall(chatId, () =>
            ctx.api.sendSticker(chatId, sticker.fileId, {
                reply_parameters: { message_id: userMessageId },
            })
        )
    );
    if (isErr(sent)) {
        console.error('[response-handler] sticker send failed:', sent[0]);
        return false;
    }

    const messageId = sent[1].message_id;
    session.messageIds.push(messageId);
    session.currentMessageId = messageId;
    session.sticker = sticker;

    const entry = findStickerByPackIndex(sticker.packIndex);
    const setName = getToolConfig().stickerSetName;
    if (entry && setName !== '') {
        try {
            const preview = await downloadStickerPreview(ctx.api, setName, entry, 'thumbnail');
            session.stickerBytes = preview.data;
        } catch (error) {
            console.warn('[response-handler] sticker preview for storage failed:', error);
        }
    }
    return true;
};

/**
 * The 600px card image, when the renderer is configured. Failure is never
 * fatal: the card itself still goes out, and the image is only what a later
 * context and the share preview get from it.
 */
const renderWidgetImage = async (widget: WidgetDelivery): Promise<Buffer | null> => {
    if (!isWidgetRenderConfigured()) return null;
    const rendered = await renderWidgetPng(widget.html, { width: 600 });
    return rendered?.png ?? null;
};

/**
 * The reply's share page, created (or reused) for the version being delivered.
 * The preview snapshot travels with the call: the version is not stored yet,
 * so the share service cannot read it from the database. null = no share page;
 * the link still goes out without the large preview and with the reply's own
 * deep link.
 */
const ensureWidgetShare = async (
    chatContext: ChatContext,
    widget: WidgetDelivery
): Promise<ShareLinkRecord | null> => {
    const { ctx, chatId, session } = chatContext;
    const [error, share] = await to(
        ensureSystemReplyShare({
            chatId,
            firstMessageId: session.firstMessageId,
            versionId: session.versionCount + 1,
            preview: {
                widgetHtml: widget.html,
                ...(session.widgetImageBase64 !== undefined
                    ? { widgetImageBase64: session.widgetImageBase64 }
                    : {}),
                caption: widget.caption ?? null,
                chatTitle: ctx.chat?.title ?? null,
            },
        })
    );
    if (error !== null) {
        console.error('[response-handler] widget share page failed:', error);
        return null;
    }
    return share;
};

/**
 * The group form of a widget: one text message whose Mini App link opens the
 * reply's public share (or the reply itself when the share page failed), with
 * the share page as its large preview. A message Telegram refuses with the
 * preview is retried without it by the sender.
 */
const deliverReplyWidgetLink = async (
    chatContext: ChatContext,
    widget: WidgetDelivery,
    captionFields: ImageCaptionFields,
    share: ShareLinkRecord | null
): Promise<boolean> => {
    const { ctx, chatId, session } = chatContext;
    const botUsername = ctx.me.username;
    if (botUsername === undefined || botUsername.length === 0) {
        console.warn('[response-handler] widget link fallback needs the bot username, card not sent');
        return false;
    }

    const previewUrl = share === null ? null : previewLinkUrlOf(share);
    const message = buildWidgetLinkMessage({
        caption: captionFields,
        ...(previewUrl === null ? {} : { previewUrl }),
        miniAppLink: widgetMiniAppLink({
            botUsername,
            shortName: miniAppShortName(),
            chatId,
            firstMessageId: session.firstMessageId,
            shareToken: share?.token ?? null,
        }),
        replyToMessageId: chatContext.userMessageId,
    });
    const sent = await sendReplyWidgetLinkMessage({ chatId, api: ctx.api, message });
    if (isErr(sent)) return false;

    session.messageIds.push(sent[1]);
    session.currentMessageId = sent[1];
    if (session.widget === undefined) session.widget = widget;
    session.widgetMessageId = sent[1];
    session.widgetDeliveredAs = 'link';
    if (share !== null) session.widgetShareUrl = share.url;
    return true;
};

/**
 * Send the reply's chat UI card after its text.
 *
 * A private chat takes the native widget. Groups (and a private chat whose
 * server refuses widgets) take the link fallback: the same card rendered into
 * a 600px PNG for storage, then a text message that opens the card in the Mini
 * App and previews its share page. The widget HTML is final and cannot be
 * edited later, so the exact bytes are kept on the session for the stored
 * version and for version switching; a failed send costs the reply only the
 * card, like a failed image.
 */
const deliverReplyWidget = async (
    chatContext: ChatContext,
    widget: WidgetDelivery | undefined,
    captionFields: ImageCaptionFields
): Promise<boolean> => {
    const { ctx, session } = chatContext;
    if (!widget) return false;

    const config = getToolConfig();
    // Rendered first: the image is part of the version and the bot row in
    // either shape, and a render failure only drops the image
    const image = await renderWidgetImage(widget);
    const chatType = ctx.chat?.type;
    const initialPlan = resolveWidgetDelivery({
        chatType,
        groupFallback: config.widgetGroupFallback,
        shareEnabled: config.shareEnabled,
        renderOk: image !== null,
        shareOk: false,
    });
    if (initialPlan.kind === 'none') {
        console.warn('[response-handler] no widget delivery path for this chat, card not sent');
        return false;
    }
    if (initialPlan.keepImage && image !== null) {
        session.widgetImageBase64 = image.toString('base64');
    }

    let serverRejected = false;
    if (initialPlan.kind === 'widget') {
        const sent = await sendReplyWidgetMessage({
            chatId: chatContext.chatId,
            widget,
            captionFields,
            target: { reply_parameters: { message_id: chatContext.userMessageId } },
        });
        if (!isErr(sent)) {
            session.messageIds.push(sent[1]);
            session.currentMessageId = sent[1];
            if (session.widget === undefined) session.widget = widget;
            session.widgetMessageId = sent[1];
            session.widgetDeliveredAs = 'widget';
            return true;
        }
        if (!isWidgetNotAllowedError(sent[0])) return false;
        // The server no longer takes widgets here: fall through to the link
        serverRejected = true;
        console.warn('[response-handler] server refused the widget, falling back to a Mini App link');
    }

    const share = await ensureWidgetShare(chatContext, widget);
    const linkPlan = resolveWidgetDelivery({
        chatType,
        groupFallback: config.widgetGroupFallback,
        shareEnabled: config.shareEnabled,
        renderOk: image !== null,
        shareOk: share !== null,
        serverRejected,
    });
    if (linkPlan.kind !== 'link') {
        console.warn('[response-handler] widget link fallback is not configured, card not sent');
        return false;
    }
    return deliverReplyWidgetLink(
        chatContext,
        widget,
        captionFields,
        linkPlan.withPreview ? share : null
    );
};

/**
 * Buttons on the last message; a widget message can only be edited through the
 * cloud client that sent it, so a local failure falls back once.
 */
const editCurrentMessageButtons = async (
    chatContext: ChatContext,
    buttons: InlineKeyboardMarkup | undefined
): Promise<void> => {
    if (buttons === undefined) return;
    const { ctx, chatId, session } = chatContext;
    const [error] = await to(
        runApiCall(chatId, () =>
            ctx.api.editMessageReplyMarkup(chatId, session.currentMessageId, {
                reply_markup: buttons,
            })
        )
    );
    if (error === null) return;
    // A link-fallback message is a normal text message: no widget client needed
    if (session.widget === undefined || session.widgetDeliveredAs === 'link') {
        console.error('[response-handler] Failed to add buttons to media:', error);
        return;
    }
    const [widgetError] = await to(
        editWidgetReplyMarkup(chatId, session.currentMessageId, buttons)
    );
    if (widgetError !== null) {
        console.error('[response-handler] Failed to add buttons to widget:', widgetError);
    }
};

/**
 * Send the reply's one attachment: a file, a sticker, its first image or its
 * widget. The tools keep these exclusive, so the order only decides the
 * unlikely case of a stored response carrying two. Returns whether anything
 * went out.
 */
const deliverReplyMedia = async (
    chatContext: ChatContext,
    response: AIResponse,
    imageCaptionFields: ImageCaptionFields,
    fileCaptionFields: ImageCaptionFields,
    widgetCaptionFields: ImageCaptionFields
): Promise<boolean> => {
    const widget = response.widgets?.[0];
    if (widget) return deliverReplyWidget(chatContext, widget, widgetCaptionFields);
    const file = response.files?.[0];
    if (file) return deliverReplyFile(chatContext, file, fileCaptionFields);
    const sticker = response.stickers?.[0];
    if (sticker) return deliverReplySticker(chatContext, sticker);
    if (response.images.length > 0) {
        return deliverReplyImage(chatContext, response.images[0], imageCaptionFields);
    }
    return false;
};

/**
 * Finalize the reply. A stopped reply with a checkpoint at hand keeps it (D10):
 * whether it is kept is decided before the finalization writes the metrics
 * row, and it is stored after it, because the finalization clears the
 * reply's earlier mark.
 */
const finalizeKeepingCheckpoint = async (
    chatContext: ChatContext,
    finalizeOptions: FinalizeOptions
): Promise<void> => {
    const kept = finalizeOptions.wasStoppedByUser === true ? prepareCheckpointKeep(chatContext) : null;
    await chatContext.session.finalize(finalizeOptions);
    keepPreparedCheckpoint(kept);
};

/** "继续" goes with the buttons only while the stored reply shows its resumable latest version */
const showsResumable = (chatId: number, botResponse: BotResponse | null): boolean =>
    botResponse !== null &&
    showsResumableVersion(chatId, botResponse.messageId, botResponse.getVersions(), botResponse.currentVersionIndex);

/**
 * Send final response (text and/or images)
 * Handles the last message in the chain (may be first or continuation)
 */
export const sendFinalResponse = async (
    chatContext: ChatContext,
    response: AIResponse
): Promise<void> => {
    // Immediately mark as finalized to prevent race conditions with idle updates
    chatContext.isFinalized = true;

    const { ctx, chatId, userMessageId, editor, typing, session } = chatContext;

    typing.stop();
    editor.stop();

    // Check if stopped by user
    const wasStoppedByUser = session.streamController.isAborted();
    const resolveContextLink = contextLinkResolverFor(chatContext);

    const builtChunks = buildFinalMessages({
        text: response.text,
        // The link message's stats must count the whole CoT, while the stream
        // only returns its 10k display buffer: in link mode the session holds
        // the full thinking (the body ignores `thinking` when a link exists)
        thinking:
            session.thinkingLink === undefined
                ? response.thinkingText
                : session.thinkingBuffer,
        // Link mode: the reply leads with the link message instead of the CoT
        thinkingLink: session.thinkingLink,
        agentStats: response.agentStats,
        wasStoppedByUser,
        groundingData: response.groundingData,
        resolveContextLink,
    });
    // A link message emitted during streaming is already in the chat: its chunk
    // must not be re-delivered, it only leads the stored layout
    const finalChunks =
        session.thinkingLink?.emitted === true ? builtChunks.slice(1) : builtChunks;
    // Only the first image is delivered, and it carries the reply's image caption
    const imageCaptionFields = buildImageCaption(response.imageCaption, resolveContextLink);
    // The file's caption rides on the file itself, so a version switch keeps it
    const fileCaptionFields = buildImageCaption(response.files?.[0]?.caption, resolveContextLink);
    // The widget's caption sits below the card; the HTML itself is final
    const widgetCaptionFields = buildImageCaption(response.widgets?.[0]?.caption, resolveContextLink);
    const finalizeOptions = {
        modelParts: response.modelParts,
        wasStoppedByUser,
        imageCaption: response.imageCaption,
    };
    let finalMessage: FinalMessageChunk = finalChunks[0] ?? { text: '', entities: [] };

    if (response.groundingData?.length) {
        console.log('[response-handler] Grounding metadata:', JSON.stringify(response.groundingData));
    }

    // Check if final message needs multi-message output
    if (finalChunks.length > 1) {
        console.log('[response-handler] Final message exceeds limit, splitting by sections...');

        // Send current part first (no buttons on split messages)
        await editor.updateContent(finalMessage.text, {
            entities: finalMessage.entities,
            linkPreviewOptions: finalMessage.linkPreviewOptions,
            isFinal: true,
        });

        for (const chunk of finalChunks.slice(1)) {
            const continuationResult = await to(
                runApiCall(chatId, () =>
                    ctx.api.sendMessage(chatId, chunk.text, {
                        entities: toApiEntities(chunk.entities),
                        reply_parameters: { message_id: userMessageId },
                        link_preview_options: chunk.linkPreviewOptions,
                    })
                )
            );

            if (isErr(continuationResult)) {
                console.error('[response-handler] Failed to send continuation:', continuationResult[0]);
                break;
            }

            const contMsg = continuationResult[1];
            session.messageIds.push(contMsg.message_id);
            session.currentMessageId = contMsg.message_id;
        }

        // Send the one attachment (file, sticker or image) after the text split
        if (
            (response.files?.length ?? 0) > 0 ||
            response.images.length > 0 ||
            (response.stickers?.length ?? 0) > 0 ||
            (response.widgets?.length ?? 0) > 0
        ) {
            await deliverReplyMedia(
                chatContext,
                response,
                imageCaptionFields,
                fileCaptionFields,
                widgetCaptionFields
            );
        }

        // Finalize session (saves to both Message and BotResponse tables)
        await finalizeKeepingCheckpoint(chatContext, finalizeOptions);

        // Add buttons to the last message after finalization
        const getBotResponseForButtons = async () => {
            const { getBotResponse } = await import('../db/index.js');
            return getBotResponse(chatId, session.firstMessageId);
        };
        const botResponse = await getBotResponseForButtons();
        const finalButtonState = botResponse?.buttonState ?? ButtonState.NONE;

        if (finalButtonState !== ButtonState.NONE) {
            const finalButtons = buildResponseButtons(
                finalButtonState,
                botResponse?.currentVersionIndex ?? 0,
                botResponse?.getVersions().length ?? 1,
                { resumable: showsResumable(chatId, botResponse) }
            );

            await editCurrentMessageButtons(chatContext, finalButtons);
        } else {
            await healEditDetectedButtons(chatContext);
        }
        return;
    }

    const hasText = Boolean(finalMessage.text);
    const hasImages = response.images.length > 0;
    const hasStickers = (response.stickers?.length ?? 0) > 0;
    const hasFile = (response.files?.length ?? 0) > 0;
    const hasWidget = (response.widgets?.length ?? 0) > 0;
    const hasMedia = hasImages || hasStickers || hasFile || hasWidget;

    // Check if this is an image generation context
    const isImageGenerationContext = chatContext.commandType === 'picbanana'
        || chatContext.commandType === 'picgpt';
    const noImageInResponse = isImageGenerationContext && !hasImages && !wasStoppedByUser;

    // Add [no image in response] marker for image generation without images
    if (noImageInResponse) {
        finalMessage = {
            ...concatMessages(
                finalMessage,
                finalMessage.text ? '\n\n[no image in response]' : '[no image in response]'
            ),
            linkPreviewOptions: finalMessage.linkPreviewOptions,
        };
    }

    console.log('[response-handler] Final response:', {
        hasText,
        hasImages,
        hasStickers,
        hasFile,
        hasWidget,
        imageCount: response.images.length,
        stickerCount: response.stickers?.length ?? 0,
        fileName: response.files?.[0]?.name,
        fileBytes: response.files?.[0]?.data.length,
        widgetMode: response.widgets?.[0]?.mode,
        widgetZlibBytes: response.widgets?.[0]?.zlibBytes,
        widgetDeliveredAs: session.widgetDeliveredAs,
        textLength: response.text.length,
        thinkingLength: response.thinkingText.length,
        messageCount: session.messageIds.length,
        wasStoppedByUser,
        isImageGenerationContext,
        noImageInResponse,
    });

    if (hasMedia) {
        // Update text message first (no buttons - intermediate message)
        if (hasText) {
            await editor.updateContent(finalMessage.text, {
                entities: finalMessage.entities,
                linkPreviewOptions: finalMessage.linkPreviewOptions,
                isFinal: true,
            });
        }

        // Send the attachment as last message (buttons will be added after finalize)
        const mediaDelivered = await deliverReplyMedia(
            chatContext,
            response,
            imageCaptionFields,
            fileCaptionFields,
            widgetCaptionFields
        );

        if (!hasText) {
            if (mediaDelivered) {
                // No text: the attachment takes the processing message's place
                const processingMessageId = editor.getIds().messageId;
                await editor.delete();
                session.messageIds = session.messageIds.filter(id => id !== processingMessageId);
            } else {
                // Nothing went out: the processing message stays and says so
                const notSentText = hasWidget
                    ? WIDGET_NOT_SENT_TEXT
                    : hasFile
                      ? FILE_NOT_SENT_TEXT
                      : hasStickers
                        ? STICKER_NOT_SENT_TEXT
                        : IMAGE_NOT_SENT_TEXT;
                await editor.updateContent(notSentText, { isFinal: true });
            }
        }

        // Finalize session AFTER sending all messages (so image message ID is included)
        await finalizeKeepingCheckpoint(chatContext, finalizeOptions);

        // Get the correct button state after finalization and update the last message
        const getBotResponseForButtons = async () => {
            const { getBotResponse } = await import('../db/index.js');
            return getBotResponse(chatId, session.firstMessageId);
        };
        const botResponse = await getBotResponseForButtons();
        const finalButtonState = botResponse?.buttonState ?? ButtonState.NONE;

        if (finalButtonState !== ButtonState.NONE) {
            const finalButtons = buildResponseButtons(
                finalButtonState,
                botResponse?.currentVersionIndex ?? 0,
                botResponse?.getVersions().length ?? 1,
                { resumable: showsResumable(chatId, botResponse) }
            );

            // Edit the last message (the attachment, unless it did not go out) to add buttons
            await editCurrentMessageButtons(chatContext, finalButtons);
        } else {
            await healEditDetectedButtons(chatContext);
        }
    } else {
        // Finalize session first to determine button state (no media case)
        await finalizeKeepingCheckpoint(chatContext, finalizeOptions);

        // Get the correct button state after finalization
        const getBotResponseForButtons = async () => {
            const { getBotResponse } = await import('../db/index.js');
            return getBotResponse(chatId, session.firstMessageId);
        };
        const botResponse = await getBotResponseForButtons();
        // For image generation without images: ensure at least RETRY_ONLY, but keep HAS_VERSIONS if already set
        const dbButtonState = botResponse?.buttonState ?? ButtonState.NONE;
        const finalButtonState = noImageInResponse && dbButtonState === ButtonState.NONE
            ? ButtonState.RETRY_ONLY
            : dbButtonState;
        const finalButtons = finalButtonState !== ButtonState.NONE
            ? buildResponseButtons(
                finalButtonState,
                botResponse?.currentVersionIndex ?? 0,
                botResponse?.getVersions().length ?? 1,
                { resumable: showsResumable(chatId, botResponse) }
            )
            : undefined;

        if (hasText || wasStoppedByUser || noImageInResponse) {
            // Text response, stopped, or no image in image generation context
            const displayMessage: RenderedMessage = finalMessage.text
                ? finalMessage
                : { text: '[stopped]', entities: [] };
            await editor.updateContent(displayMessage.text, {
                entities: displayMessage.entities,
                linkPreviewOptions: finalMessage.linkPreviewOptions,
                replyMarkup: finalButtons,
                isFinal: true,
            });
        } else {
            // No content and not stopped - show error
            const fallbackMessage = '寄了';
            await editor.updateContent(fallbackMessage, { replyMarkup: finalButtons, isFinal: true });
        }

        if (finalButtonState === ButtonState.NONE) {
            await healEditDetectedButtons(chatContext);
        }
    }
};

/**
 * Handle error during response processing.
 *
 * Already-streamed partial content stays visible; the error is appended as a
 * display-only italic line (never persisted into message/version text). The
 * partial is read from the session buffers, which processStream syncs on
 * every chunk — pre-stream failures simply have empty buffers and degrade to
 * an error-only message. This is the single owner of the visible error edit;
 * session.handleError only persists.
 */
export const handleResponseError = async (
    chatContext: ChatContext,
    error: Error
): Promise<void> => {
    // Check if this is an abort (user clicked stop)
    const isAborted = error.message === 'Aborted' || chatContext.session.streamController.isAborted();

    if (isAborted) {
        // Treat abort as normal stop, not error
        // Build response from current state; the attachments earlier tool
        // rounds buffered go out with it, as on the normal stop path
        const response = {
            text: chatContext.currentState?.textBuffer || '',
            thinkingText: chatContext.currentState?.thinkingBuffer || '',
            images: chatContext.currentState?.images || [],
            imageCaption: chatContext.currentState?.imageCaption,
            stickers: chatContext.currentState?.stickers ?? [],
            files: chatContext.currentState?.files ?? [],
            widgets: chatContext.currentState?.widgets ?? [],
            groundingData: chatContext.currentState?.groundingData || [],
            agentStats: chatContext.currentState?.agentStats,
            modelParts: chatContext.currentState?.modelParts,
            rawResponse: chatContext.currentState?.rawResponse,
        };

        // Use normal final response flow with stopped flag
        await sendFinalResponse(chatContext, response);
        return;
    }

    // Immediately mark as finalized to prevent race conditions with idle updates
    chatContext.isFinalized = true;

    const { chatId, editor, typing, session } = chatContext;

    typing.stop();
    editor.stop();

    // The error edit below carries text only: an image produced before the
    // failure never reached the chat, so it is not stored as part of the reply
    session.images = [];

    // A checkpoint at hand: the failed version and its row count the tools of
    // the kept rounds, and whether it is kept is decided before the row is written
    if (chatContext.lastCheckpoint !== undefined) {
        fillToolUsageFromCheckpoint(session, chatContext.lastCheckpoint);
    }
    const keptCheckpoint = prepareCheckpointKeep(chatContext);

    // Finalize session with error first: persists partial text as the version
    // content and the error string in the separate errorMessage field
    await session.handleError(error);
    // After the finalization, which clears the reply's earlier mark
    keepPreparedCheckpoint(keptCheckpoint);

    // Partial content shown to the user: the display buffers of the message
    // this editor owns (continuations reset them), falling back to session
    // buffers for callers that never entered processStream
    const partialText = chatContext.currentState?.textBuffer ?? session.textBuffer;
    const partialThinking = chatContext.currentState?.thinkingBuffer ?? session.thinkingBuffer;

    // A link message that has not gone out yet becomes the error message's
    // prefix; once it went out, the error belongs to the body message alone
    const pendingLink =
        session.thinkingLink !== undefined && !session.thinkingLink.emitted
            ? session.thinkingLink
            : undefined;

    const errorDisplay = buildErrorDisplay({
        text: partialText,
        thinking: pendingLink === undefined ? partialThinking : undefined,
        thinkingLink: pendingLink,
        // The stats line counts the full thinking, not the display buffer
        thinkingLinkSummary:
            pendingLink === undefined
                ? undefined
                : thinkingLinkSummaryOf(session.thinkingBuffer || partialThinking) ?? undefined,
        errorMessage: formatErrorForUser(error),
        resolveContextLink: contextLinkResolverFor(chatContext),
    });
    // Display only, like the error line itself
    const errorRendered =
        keptCheckpoint === null
            ? errorDisplay
            : withKeptRoundsLine(errorDisplay, keptCheckpoint.checkpoint.loop.completedRounds);

    // Get the correct button state after finalization (may be HAS_VERSIONS for retry errors)
    const getBotResponseForButtons = async () => {
        const { getBotResponse } = await import('../db/index.js');
        return getBotResponse(chatId, session.firstMessageId);
    };
    const botResponse = await getBotResponseForButtons();
    // Always show at least RETRY_ONLY for errors
    const finalButtonState = botResponse?.buttonState === ButtonState.NONE
        ? ButtonState.RETRY_ONLY
        : (botResponse?.buttonState ?? ButtonState.RETRY_ONLY);
    const errorButtons = buildResponseButtons(
        finalButtonState,
        botResponse?.currentVersionIndex ?? 0,
        botResponse?.getVersions().length ?? 1,
        { resumable: showsResumable(chatId, botResponse) }
    );

    // Edit with retry button (delivery retries handled by the edit coordinator)
    const delivered = await editor.updateContent(errorRendered.text, {
        entities: errorRendered.entities,
        replyMarkup: errorButtons,
        ...(pendingLink === undefined
            ? {}
            : { linkPreviewOptions: thinkingLinkPreviewOptions(pendingLink) }),
        isFinal: true,
    });
    if (!delivered) {
        console.error('[response-handler] Failed to edit error message');
    }
    console.error('[response-handler]', error);
};

/**
 * Create chat context for retry from existing session
 * Reuses the same processStream and sendFinalResponse as normal flow
 */
export const createChatContextForRetry = (
    ctx: Context,
    session: BotMessageSession,
    commandType: CommandType = 'chat'
): ChatContext => {
    const chatId = session.chatId;

    // Create typing indicator
    const typing = createTypingIndicator(ctx.api, chatId);
    typing.start();

    // Create chat context
    const chatContext: ChatContext = {
        ctx,
        chatId,
        userMessageId: session.userMessageId,
        editor: null as any, // Will be set below
        typing,
        currentState: undefined,
        session,
        currentButtonState: ButtonState.PROCESSING,
        isFinalized: false,
        commandType,
    };

    // Create StreamingEditor with idle update callback
    const editor = createStreamingEditor({
        api: ctx.api,
        chatId,
        messageId: session.currentMessageId,
        idleInterval: 2500,
        initialContent: '✽ Thinking...', // Initial message content to avoid duplicate edits
        getButtons: () => {
            // Stop idle updates when finalized or stream aborted (stop button)
            if (chatContext.isFinalized || session.streamController.isAborted()) {
                return undefined;
            }
            return buildResponseButtons(chatContext.currentButtonState);
        },
    });

    chatContext.editor = editor;

    return chatContext;
};
