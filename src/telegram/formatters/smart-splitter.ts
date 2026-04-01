/**
 * Smart message splitter - finds optimal split point at newline
 */

export const TELEGRAM_MAX_LENGTH = 4000; // Safe visible limit
const TELEGRAM_RAW_HARD_LIMIT = 12000; // Safety cap for very long raw MarkdownV2 strings

export interface SplitResult {
    currentPart: string;  // Part to send now
    remaining: string;    // Part to keep in buffer
}

const findUnescapedChar = (text: string, target: string, start: number): number => {
    for (let i = start; i < text.length; i++) {
        if (text[i] === '\\') {
            i += 1;
            continue;
        }

        if (text[i] === target) {
            return i;
        }
    }

    return -1;
};

const markdownLinkAt = (
    text: string,
    start: number
): { end: number; label: string } | null => {
    if (text[start] !== '[') {
        return null;
    }

    const closeBracket = findUnescapedChar(text, ']', start + 1);
    if (closeBracket < 0 || text[closeBracket + 1] !== '(') {
        return null;
    }

    const closeParen = findUnescapedChar(text, ')', closeBracket + 2);
    if (closeParen < 0) {
        return null;
    }

    return {
        end: closeParen + 1,
        label: text.slice(start + 1, closeBracket),
    };
};

const getMarkdownUnit = (
    text: string,
    index: number
): { nextIndex: number; visibleLength: number; visibleText?: string } => {
    const current = text[index];

    if (current === '\\') {
        if (index + 1 < text.length) {
            return {
                nextIndex: index + 2,
                visibleLength: 1,
                visibleText: text[index + 1],
            };
        }

        return {
            nextIndex: index + 1,
            visibleLength: 0,
        };
    }

    if (text.startsWith('||', index)) {
        return {
            nextIndex: index + 2,
            visibleLength: 0,
        };
    }

    const markdownLink = markdownLinkAt(text, index);
    if (markdownLink) {
        return {
            nextIndex: markdownLink.end,
            visibleLength: getTelegramVisibleLength(markdownLink.label),
            visibleText: markdownLink.label,
        };
    }

    if ('*_~`'.includes(current ?? '')) {
        return {
            nextIndex: index + 1,
            visibleLength: 0,
        };
    }

    if (current === '>' && (index === 0 || text[index - 1] === '\n')) {
        return {
            nextIndex: index + 1,
            visibleLength: 0,
        };
    }

    return {
        nextIndex: index + 1,
        visibleLength: 1,
        visibleText: current,
    };
};

export const getTelegramVisibleLength = (text: string): number => {
    let index = 0;
    let visibleLength = 0;

    while (index < text.length) {
        const unit = getMarkdownUnit(text, index);
        visibleLength += unit.visibleLength;
        index = unit.nextIndex;
    }

    return visibleLength;
};

const findSplitPos = (text: string, maxLength: number): number => {
    let index = 0;
    let visibleLength = 0;
    let lastPreferredBoundary = 0;
    let lastSafeBoundary = 0;

    while (index < text.length) {
        if (index >= TELEGRAM_RAW_HARD_LIMIT) {
            break;
        }

        const unit = getMarkdownUnit(text, index);
        if (visibleLength + unit.visibleLength > maxLength) {
            break;
        }

        visibleLength += unit.visibleLength;
        index = unit.nextIndex;
        lastSafeBoundary = index;

        if (unit.visibleText === '\n' || unit.visibleText === ' ') {
            lastPreferredBoundary = index;
        } else if (
            unit.visibleText &&
            !unit.visibleText.includes('\n') &&
            !unit.visibleText.includes(' ')
        ) {
            const previousChar = text[index - 1];
            if (previousChar === ')' || previousChar === '|' || previousChar === ']') {
                lastPreferredBoundary = index;
            }
        }
    }

    return lastPreferredBoundary || lastSafeBoundary || Math.min(text.length, TELEGRAM_RAW_HARD_LIMIT);
};

/**
 * Split text at optimal visible-length-aware boundary
 * Returns current part to send and remaining part for buffer
 */
export const smartSplit = (text: string, maxLength: number = TELEGRAM_MAX_LENGTH): SplitResult => {
    if (
        getTelegramVisibleLength(text) <= maxLength &&
        text.length <= TELEGRAM_RAW_HARD_LIMIT
    ) {
        return {
            currentPart: text,
            remaining: '',
        };
    }

    const splitPos = findSplitPos(text, maxLength);

    return {
        currentPart: text.slice(0, splitPos),
        remaining: text.slice(splitPos),
    };
};

/**
 * Check if text needs splitting
 */
export const needsSplit = (text: string, maxLength: number = TELEGRAM_MAX_LENGTH): boolean => {
    return (
        getTelegramVisibleLength(text) > maxLength ||
        text.length > TELEGRAM_RAW_HARD_LIMIT
    );
};
