/**
 * Markdown formatting utilities for Telegram MarkdownV2
 */
import telegramifyMarkdown from 'telegramify-markdown';

/**
 * Escape special characters for MarkdownV2
 * Characters that need escaping: _ * [ ] ( ) ~ ` > # + - = | { } . !
 */
export const escapeMarkdownV2 = (text: string): string => {
    if (!text) return '';
    return text.replace(/(?<!\\)([_*[\]()~`>#+-=|{}.!])/g, '\\$1');
};

/**
 * Convert markdown to Telegram MarkdownV2 format
 */
export const toTelegramMarkdown = (text: string): string => {
    if (!text) return '';
    return telegramifyMarkdown(text, 'escape');
};

/**
 * Format thinking content as Telegram quote block
 */
export const formatThinkingContent = (thinking: string): string => {
    if (!thinking) return '';

    const lines = thinking.split('\n');
    const escapedLines = lines.map((line) => escapeMarkdownV2(line));
    return '**>' + escapedLines.join('\n>') + '||';
};

/**
 * Format response with optional thinking content
 */
export const formatResponse = (
    text: string,
    thinking?: string
): string => {
    let result = '';

    if (thinking) {
        result = formatThinkingContent(thinking);
        if (text) {
            result += '\n';
        }
    }

    if (text) {
        result += toTelegramMarkdown(text);
    }

    return result;
};

/**
 * Format processing indicator
 */
export const formatProcessing = (
    currentText: string,
    processingText: string = 'Processing...'
): string => {
    if (!currentText) return processingText;
    return currentText + '\n' + processingText;
};

/**
 * Strip processing suffix from text
 */
export const stripProcessing = (
    text: string,
    processingText: string = 'Processing...'
): string => {
    if (!text) return '';

    const suffix = '\n' + processingText;
    if (text.endsWith(suffix)) {
        return text.slice(0, -suffix.length);
    }

    if (text.endsWith(processingText)) {
        return text.slice(0, -processingText.length);
    }

    return text;
};

/**
 * Truncate text to fit Telegram message limit
 */
export const truncateForTelegram = (
    text: string,
    maxLength: number = 4000,
    suffix: string = '...'
): string => {
    if (!text || text.length <= maxLength) return text;
    return text.slice(0, maxLength - suffix.length) + suffix;
};

/**
 * Format error message for display
 */
export const formatErrorMessage = (
    error: unknown,
    prefix?: string
): string => {
    const message =
        error instanceof Error ? error.message : String(error);
    const fullMessage = prefix ? `${prefix}: ${message}` : message;
    return truncateForTelegram(fullMessage);
};
