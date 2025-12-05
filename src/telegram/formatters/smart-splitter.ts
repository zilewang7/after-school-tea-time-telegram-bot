/**
 * Smart message splitter - finds optimal split point at newline
 */

const TELEGRAM_MAX_LENGTH = 4000; // Safe limit

export interface SplitResult {
    currentPart: string;  // Part to send now
    remaining: string;    // Part to keep in buffer
}

/**
 * Find the last newline before maxLength
 * Returns the position after the newline
 */
const findLastNewline = (text: string, maxLength: number): number => {
    if (text.length <= maxLength) {
        return text.length;
    }

    // Search backwards from maxLength for the last newline
    for (let i = maxLength - 1; i >= 0; i--) {
        if (text[i] === '\n') {
            return i + 1; // Include the newline in current part
        }
    }

    // No newline found, search for last space
    for (let i = maxLength - 1; i >= 0; i--) {
        if (text[i] === ' ') {
            return i + 1;
        }
    }

    // No good split point, hard cut at maxLength
    return maxLength;
};

/**
 * Split text at optimal newline position
 * Returns current part to send and remaining part for buffer
 */
export const smartSplit = (text: string, maxLength: number = TELEGRAM_MAX_LENGTH): SplitResult => {
    if (text.length <= maxLength) {
        return {
            currentPart: text,
            remaining: '',
        };
    }

    const splitPos = findLastNewline(text, maxLength);

    return {
        currentPart: text.slice(0, splitPos),
        remaining: text.slice(splitPos),
    };
};

/**
 * Check if text needs splitting
 */
export const needsSplit = (text: string, maxLength: number = TELEGRAM_MAX_LENGTH): boolean => {
    return text.length > maxLength;
};
