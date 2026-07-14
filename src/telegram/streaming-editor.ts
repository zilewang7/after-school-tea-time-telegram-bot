/**
 * StreamingEditor - Manages real-time message editing with status updates
 *
 * Thin layer over the per-chat edit coordinator: every update submits the
 * latest desired state of the message (plain text + pre-rendered entities).
 * Pacing, coalescing, 429 backoff and final-state retries are all handled by
 * the coordinator, so this module only tracks the current content and rotates
 * the status line.
 */
import type { Api, RawApi } from 'grammy';
import type { MessageEntity as RenderedEntity } from 'telegram-md-entities';
import { to } from '../shared/result.js';
import {
    submitEdit,
    primeSentState,
    discardPendingEdit,
    dropMessageState,
    runApiCall,
} from './edit-coordinator.js';

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

/** Minimum time between status rotations */
const STATUS_ROTATE_MS = 3000;

/**
 * Options for creating a StreamingEditor
 */
export interface StreamingEditorOptions {
    api: Api<RawApi>;
    chatId: number;
    messageId: number;
    /** Base interval for idle status updates (default 2500ms) */
    idleInterval?: number;
    /** Callback for buttons during updates; undefined result = finalized */
    getButtons?: () => any;
    /** Initial content of the message (to skip identical first edits) */
    initialContent?: string;
}

/**
 * Options for updateContent
 */
export interface UpdateContentOptions {
    /** Entities matching the content (offsets stay valid: status is appended after) */
    entities?: readonly RenderedEntity[];
    replyMarkup?: any;
    /** If true, don't append status text (for final messages) */
    isFinal?: boolean;
}

/**
 * StreamingEditor interface
 */
export interface StreamingEditor {
    /**
     * Update message content (status text appended unless final).
     * Non-final updates are accepted immediately and flushed by the
     * coordinator; final updates resolve once actually delivered.
     */
    updateContent: (content: string, options?: UpdateContentOptions) => Promise<boolean>;

    /**
     * Update with just status text (no content yet)
     */
    updateStatusOnly: (options?: { replyMarkup?: any }) => Promise<boolean>;

    /**
     * Stop the editor - clears timers, discards pending non-final edits
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
}

/**
 * Internal editor state
 */
interface EditorState {
    stopped: boolean;
    statusIndex: number;
    lastStatusRotateTime: number;
    /** Latest submitted content, without the status line */
    currentContent: string | null;
    currentEntities: readonly RenderedEntity[] | undefined;
    spinnerTimer: ReturnType<typeof setInterval> | null;
}

/**
 * Create a StreamingEditor instance
 */
export const createStreamingEditor = (options: StreamingEditorOptions): StreamingEditor => {
    const { api, chatId, messageId, idleInterval = 2500, getButtons, initialContent } = options;

    const state: EditorState = {
        stopped: false,
        statusIndex: 0,
        lastStatusRotateTime: Date.now(),
        currentContent: null,
        currentEntities: undefined,
        spinnerTimer: null,
    };

    if (initialContent) {
        primeSentState(chatId, messageId, initialContent);
    }

    /**
     * Get the plain status line, rotating when due
     */
    const getStatusText = (): string => {
        const now = Date.now();
        if (now - state.lastStatusRotateTime >= STATUS_ROTATE_MS) {
            state.statusIndex = (state.statusIndex + 1) % statusData.length;
            state.lastStatusRotateTime = now;
        }
        const entry = statusData[state.statusIndex] ?? statusData[0]!;
        return `${entry.symbol} ${entry.message}`;
    };

    const stopSpinner = (): void => {
        if (state.spinnerTimer) {
            clearInterval(state.spinnerTimer);
            state.spinnerTimer = null;
        }
    };

    /**
     * Spinner tick: submit a lowest-priority status refresh.
     * Submitting is free (desired-state overwrite); under load the
     * coordinator starves these in favor of content/final edits.
     */
    const spinnerTick = (): void => {
        if (state.stopped) {
            stopSpinner();
            return;
        }

        const buttons = getButtons?.();
        if (buttons === undefined) {
            // Message finalized upstream - stop idle updates for good
            state.stopped = true;
            stopSpinner();
            return;
        }

        const statusText = getStatusText();
        const text = state.currentContent
            ? `${state.currentContent}\n${statusText}`
            : statusText;

        void submitEdit(api, chatId, messageId, text, {
            entities: state.currentEntities,
            replyMarkup: buttons,
            priority: 'spinner',
        });
    };

    state.spinnerTimer = setInterval(spinnerTick, idleInterval);

    return {
        updateContent: async (content: string, opts?: UpdateContentOptions): Promise<boolean> => {
            if (state.stopped && !opts?.isFinal) return false;

            if (opts?.isFinal) {
                stopSpinner();
                // Final: await actual delivery (sticky-retried by coordinator)
                return submitEdit(api, chatId, messageId, content, {
                    entities: opts.entities,
                    replyMarkup: opts.replyMarkup,
                    isFinal: true,
                });
            }

            state.currentContent = content;
            state.currentEntities = opts?.entities;
            const text = `${content}\n${getStatusText()}`;

            // Fire-and-forget: the coordinator always flushes the newest state
            void submitEdit(api, chatId, messageId, text, {
                entities: opts?.entities,
                replyMarkup: opts?.replyMarkup,
                priority: 'content',
            });
            return true;
        },

        updateStatusOnly: async (opts?: { replyMarkup?: any }): Promise<boolean> => {
            if (state.stopped) return false;

            void submitEdit(api, chatId, messageId, getStatusText(), {
                replyMarkup: opts?.replyMarkup,
                priority: 'spinner',
            });
            return true;
        },

        stop: (): void => {
            state.stopped = true;
            stopSpinner();
            // Drop stale streaming content; a final state usually follows
            discardPendingEdit(chatId, messageId);
        },

        isStopped: (): boolean => state.stopped,

        delete: async (): Promise<boolean> => {
            state.stopped = true;
            stopSpinner();
            dropMessageState(chatId, messageId);

            const [err] = await to(
                runApiCall(chatId, () => api.deleteMessage(chatId, messageId))
            );
            if (err) {
                console.error('[streaming-editor] Delete failed:', err.message);
                return false;
            }
            return true;
        },

        getIds: () => ({ chatId, messageId }),
    };
};
