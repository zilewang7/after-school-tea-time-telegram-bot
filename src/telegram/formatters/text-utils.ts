/**
 * Plain-text helpers for non-markdown paths (error messages, truncation)
 */

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
