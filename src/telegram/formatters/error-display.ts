/**
 * Display-time error decoration.
 *
 * A mid-stream error must never wipe already-streamed content: the partial
 * message stays rendered and the error is appended as one italic line. The
 * error text lives only in this display layer (and version.errorMessage) —
 * it is never written into message/version text, so version switches and
 * retries stay clean.
 */
import {
    concatMessages,
    renderMarkdown,
    splitMessage,
    wrapInBlockquote,
} from 'telegram-md-entities';
import type { RenderedMessage } from 'telegram-md-entities';
import { italicText } from './entity-text.js';
import { truncateForTelegram } from './text-utils.js';

const ERROR_TEXT_LIMIT = 500;
/** Keep partial + error line safely inside Telegram's 4096 limit */
const PARTIAL_BUDGET = 3400;

export interface ErrorDisplayInput {
    /** Partial (or full) response text streamed before the error */
    text?: string;
    /** Partial thinking/reasoning text streamed before the error */
    thinking?: string;
    /** User-facing error description (already localized) */
    errorMessage: string;
}

/** Italic one-liner appended below whatever content survived. */
export const buildErrorLine = (errorMessage: string): RenderedMessage =>
    italicText(`⚠ ${truncateForTelegram(errorMessage, ERROR_TEXT_LIMIT)}`);

/** Entity-aware clamp: keeps the leading chunk when the partial overflows */
const clampToBudget = (message: RenderedMessage): RenderedMessage => {
    if (message.text.length <= PARTIAL_BUDGET) return message;
    const [head] = splitMessage(message, { maxLength: PARTIAL_BUDGET });
    return head ?? message;
};

/**
 * Partial content (collapsed thinking quote + strict-rendered text) with the
 * error line appended. Degrades to the bare error line when nothing streamed.
 */
export const buildErrorDisplay = (input: ErrorDisplayInput): RenderedMessage => {
    const parts: (RenderedMessage | string)[] = [];

    if (input.thinking) {
        parts.push(wrapInBlockquote(renderMarkdown(input.thinking), true));
        if (input.text) parts.push('\n');
    }
    if (input.text) {
        parts.push(renderMarkdown(input.text));
    }

    const partial = clampToBudget(concatMessages(...parts));
    return concatMessages(
        partial,
        partial.text ? '\n\n' : '',
        buildErrorLine(input.errorMessage)
    );
};

/**
 * Append the error line to an already-rendered message (used when rebuilding
 * an errored version's display on version switch / refresh).
 */
export const appendErrorLine = (
    message: RenderedMessage,
    errorMessage: string
): RenderedMessage => {
    const partial = clampToBudget(message);
    return concatMessages(
        partial,
        partial.text ? '\n\n' : '',
        buildErrorLine(errorMessage)
    );
};
