/**
 * StreamingEditor - Manages real-time message editing with status updates
 *
 * Features:
 * - Version-based edit queue (new edits cancel pending old ones)
 * - Automatic status text cycling during idle periods
 * - Rate limiting for Telegram API
 * - Markdown error fallback (retry with escaped text)
 */
import { Api, RawApi } from 'grammy';
import { to } from '../shared/result';
import { waitForRateLimit, recordEdit } from './rate-limiter';
import { formatResponseSafe } from './formatters/markdown-formatter';
import { appendGroundingToMessage } from './formatters/grounding-formatter';
import type { GroundingData } from '../ai/types';

/**
 * Status text entries for cycling display
 */
interface StatusEntry {
    symbol: string;
    message: string;
}

const statusData: StatusEntry[] = [
    { symbol: '✽', message: 'Thinking...' },
    { symbol: '◐', message: 'Processing...' },
    { symbol: '◑', message: 'Analyzing...' },
    { symbol: '◒', message: 'Computing...' },
    { symbol: '◓', message: 'Synthesizing...' },
    { symbol: '●', message: 'Reasoning...' },
    { symbol: '◯', message: 'Generating...' },
    { symbol: '◈', message: 'Composing...' },
    { symbol: '◇', message: 'Reflecting...' },
    { symbol: '◆', message: 'Iterating...' },
    { symbol: '▲', message: 'Optimizing...' },
    { symbol: '▼', message: 'Finalizing...' },
];

/**
 * Options for creating a StreamingEditor
 */
export interface StreamingEditorOptions {
    api: Api<RawApi>;
    chatId: number;
    messageId: number;
    /** Base interval for idle status updates (default 2500ms) */
    idleInterval?: number;
    /** Callback for buttons during updates */
    getButtons?: () => any;
    /** Initial content of the message (to track and avoid duplicate edits) */
    initialContent?: string;
}

/**
 * Raw parts for reconstructing message on parse error
 */
export interface RawMessageParts {
    text?: string;
    thinking?: string;
    groundingData?: GroundingData[];
}

/**
 * Options for updateContent
 */
export interface UpdateContentOptions {
    parseMode?: 'MarkdownV2' | 'HTML';
    replyMarkup?: any;
    /** If true, don't append status text (for final messages) */
    isFinal?: boolean;
}

/**
 * StreamingEditor interface
 */
export interface StreamingEditor {
    /**
     * Update message content
     * Automatically appends status text, applies rate limiting, and resets idle timer
     */
    updateContent: (content: string, options?: UpdateContentOptions) => Promise<boolean>;

    /**
     * Update with just status text (no content yet)
     */
    updateStatusOnly: (options?: { replyMarkup?: any }) => Promise<boolean>;

    /**
     * Stop the editor - clears timers, no more updates
     */
    stop: () => void;

    /**
     * Check if editor is stopped
     */
    isStopped: () => boolean;

    /**
     * Delete the message
     */
    delete: () => Promise<boolean>;

    /**
     * Get chat and message IDs
     */
    getIds: () => { chatId: number; messageId: number };

    /**
     * Set raw parts for fallback formatting on parse error
     * Should be called before sending final response
     */
    setRawParts: (parts: RawMessageParts) => void;
}

/**
 * Internal editor state
 */
interface EditorState {
    statusIndex: number;
    idleTimer: ReturnType<typeof setTimeout> | null;
    idleStretchCount: number;
    lastEditTime: number;
    stopped: boolean;
    lastContent: string;
    /** Edit version - incremented on each content update, idle updates check this */
    editVersion: number;
    /** Flag to indicate an edit is in progress */
    editInProgress: boolean;
    /** Raw parts for fallback formatting on parse error */
    rawParts?: RawMessageParts;
    /** Last time status text was rotated */
    lastStatusRotateTime: number;
}

/**
 * Create a StreamingEditor instance
 */
export const createStreamingEditor = (options: StreamingEditorOptions): StreamingEditor => {
    const { api, chatId, idleInterval = 2500, getButtons, initialContent } = options;
    const messageId = options.messageId;

    const state: EditorState = {
        statusIndex: 0,
        idleTimer: null,
        idleStretchCount: 0,
        lastEditTime: Date.now(),
        stopped: false,
        lastContent: initialContent || '',
        editVersion: 0,
        editInProgress: false,
        lastStatusRotateTime: Date.now(),
    };

    /**
     * Get current status entry
     */
    const getStatusEntry = (): StatusEntry => statusData[state.statusIndex] ?? statusData[0]!;

    /**
     * Advance to next status
     */
    const advanceStatus = (): void => {
        state.statusIndex = (state.statusIndex + 1) % statusData.length;
        state.lastStatusRotateTime = Date.now();
    };

    /**
     * Rotate status if needed (more than 3000ms since last rotation)
     */
    const rotateStatusIfNeeded = (): void => {
        const now = Date.now();
        if (now - state.lastStatusRotateTime >= 3000) {
            advanceStatus();
        }
    };

    /**
     * Get status text escaped for MarkdownV2
     * Automatically rotates status if more than 3000ms since last rotation
     */
    const getStatusTextEscaped = (): string => {
        rotateStatusIfNeeded();
        const entry = getStatusEntry();
        return `${entry.symbol} ${entry.message.replace(/\./g, '\\.')}`;
    };

    /**
     * Calculate idle interval with progressive stretch
     */
    const calculateInterval = (): number => {
        const stretch = Math.min(state.idleStretchCount, 5);
        return idleInterval + stretch * 500; // Max 5000ms
    };

    /**
     * Perform the actual edit operation with fallback
     * Uses version checking to ensure only the latest edit executes
     * @param capturedVersion - The editVersion when this edit was initiated
     * @param isFinal - If true, skip version/stopped checks (for final messages)
     */
    const doEdit = async (
        text: string,
        options?: { parseMode?: string; replyMarkup?: any },
        capturedVersion: number = state.editVersion,
        isFinal: boolean = false,
        isRetry: boolean = false
    ): Promise<boolean> => {
        // Skip if same content
        if (text === state.lastContent) {
            return true;
        }

        await waitForRateLimit(chatId);

        // After rate limit wait, check if this edit is still relevant
        if (!isFinal) {
            // Skip if stopped
            if (state.stopped) {
                return false;
            }
            // Skip if a newer edit has been initiated (version changed)
            if (state.editVersion !== capturedVersion) {
                return false;
            }
        }

        const [err] = await to(
            api.editMessageText(chatId, messageId, text, {
                parse_mode: options?.parseMode as any,
                reply_markup: options?.replyMarkup,
            })
        );

        if (err) {
            const errMsg = err.message || '';

            // Check if it's a Markdown parsing error
            if (errMsg.includes("can't parse entities") && !isRetry && options?.parseMode === 'MarkdownV2') {
                // If we have raw parts in state, reconstruct with safe formatting
                if (state.rawParts) {
                    console.warn('[streaming-editor] Markdown parse error, retrying with safe formatting');

                    const { text: rawText, thinking, groundingData } = state.rawParts;
                    let safeMessage = formatResponseSafe(rawText || '', thinking);

                    if (groundingData?.length) {
                        safeMessage = appendGroundingToMessage(safeMessage, groundingData);
                    }

                    // Retry with same captured version
                    return doEdit(safeMessage, options, capturedVersion, isFinal, true);
                }

                // No raw parts available, just log and fail
                console.warn('[streaming-editor] Markdown parse error, no raw parts for fallback');
            }

            // Check if message wasn't modified (not really an error)
            if (errMsg.includes('message is not modified')) {
                state.lastContent = text;
                return true;
            }

            console.error('[streaming-editor] Edit failed:', errMsg, text, options, isRetry);
            return false;
        }

        // Record successful edit for rate limiting
        recordEdit(chatId);
        state.lastContent = text;
        state.lastEditTime = Date.now();
        return true;
    };

    /**
     * Cancel idle timer
     */
    const cancelIdleTimer = (): void => {
        if (state.idleTimer) {
            clearTimeout(state.idleTimer);
            state.idleTimer = null;
        }
    };

    /**
     * Schedule idle check timer
     */
    const scheduleIdleCheck = (): void => {
        if (state.stopped || state.idleTimer) return;

        const interval = calculateInterval();
        const currentVersion = state.editVersion;

        state.idleTimer = setTimeout(async () => {
            state.idleTimer = null;

            // Check if stopped or version changed (new edit came in)
            if (state.stopped || state.editVersion !== currentVersion) {
                return;
            }

            // Check if an edit is in progress
            if (state.editInProgress) {
                // Reschedule and try again later
                scheduleIdleCheck();
                return;
            }

            const timeSinceLastEdit = Date.now() - state.lastEditTime;

            // If no edit happened in the interval, trigger idle update
            if (timeSinceLastEdit >= interval - 100) {
                // Check if message is finalized (getButtons returns undefined)
                const buttons = getButtons?.();
                if (buttons === undefined) {
                    // Message is finalized, stop idle updates
                    state.stopped = true;
                    return;
                }

                state.idleStretchCount++;
                advanceStatus();

                // Idle update: edit with current content + new status
                const statusText = getStatusTextEscaped();

                // Check if lastContent is just a status line (no real content yet)
                const isOnlyStatus = !state.lastContent || !state.lastContent.includes('\n');

                let newText: string;
                if (isOnlyStatus) {
                    // No real content yet - just show new status (replace old status)
                    newText = statusText;
                } else {
                    // Have content - replace last line (old status) with new status
                    newText = state.lastContent.replace(/\n[^\n]+$/, '') + '\n' + statusText;
                }

                // Check again before edit in case stop() was called or version changed
                if (state.stopped || state.editVersion !== currentVersion) {
                    return;
                }

                await doEdit(newText, {
                    parseMode: 'MarkdownV2',
                    replyMarkup: buttons,
                }, currentVersion);
            }

            // Check again after async operation
            if (!state.stopped && state.editVersion === currentVersion) {
                scheduleIdleCheck();
            }
        }, interval);
    };

    /**
     * Reset idle timer (called after content updates)
     */
    const resetIdleTimer = (): void => {
        cancelIdleTimer();
        state.idleStretchCount = 0;
        scheduleIdleCheck();
    };

    // Start idle checking
    scheduleIdleCheck();

    return {
        updateContent: async (content: string, opts?: UpdateContentOptions): Promise<boolean> => {
            // Allow isFinal updates even when stopped (for sendFinalResponse)
            if (state.stopped && !opts?.isFinal) return false;

            // Increment version to cancel any pending idle updates
            state.editVersion++;
            state.editInProgress = true;

            // Cancel pending idle timer
            cancelIdleTimer();

            let finalText: string;

            if (opts?.isFinal) {
                // Final message - no status appended
                finalText = content;
            } else {
                // Append current status
                const statusText = getStatusTextEscaped();
                finalText = content + '\n' + statusText;
            }

            // Capture current version for this edit
            const currentVersion = state.editVersion;

            const result = await doEdit(finalText, {
                parseMode: opts?.parseMode,
                replyMarkup: opts?.replyMarkup,
            }, currentVersion, opts?.isFinal);

            state.editInProgress = false;

            // Reset idle timer after successful edit (unless final or stopped)
            if (result && !opts?.isFinal && !state.stopped) {
                resetIdleTimer();
            }

            return result;
        },

        updateStatusOnly: async (opts?: { replyMarkup?: any }): Promise<boolean> => {
            if (state.stopped) return false;

            // Increment version
            state.editVersion++;
            const currentVersion = state.editVersion;

            const statusText = getStatusTextEscaped();
            return doEdit(statusText, {
                parseMode: 'MarkdownV2',
                replyMarkup: opts?.replyMarkup,
            }, currentVersion);
        },

        stop: (): void => {
            state.stopped = true;
            state.editVersion++; // Cancel any pending operations
            cancelIdleTimer();
        },

        isStopped: (): boolean => state.stopped,

        delete: async (): Promise<boolean> => {
            state.stopped = true;
            state.editVersion++;
            cancelIdleTimer();

            const [err] = await to(api.deleteMessage(chatId, messageId));
            if (err) {
                console.error('[streaming-editor] Delete failed:', err.message);
                return false;
            }
            return true;
        },

        getIds: () => ({ chatId, messageId }),

        setRawParts: (parts: RawMessageParts): void => {
            state.rawParts = parts;
        },
    };
};
