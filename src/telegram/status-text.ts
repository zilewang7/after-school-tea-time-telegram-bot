/**
 * Dynamic status text for processing messages
 * Cycles through different status messages with symbols
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

let globalIndex = 0;

/**
 * Get current status text (symbol + message)
 */
export const getStatusText = (): string => {
    const entry = statusData[globalIndex] ?? statusData[0]!;
    globalIndex = (globalIndex + 1) % statusData.length;
    return `${entry.symbol} ${entry.message}`;
};

/**
 * Status controller that manages automatic status updates during idle periods
 */
export interface StatusController {
    /** Get current status text (plain) */
    getText: () => string;
    /** Get current status text escaped for MarkdownV2 */
    getTextEscaped: () => string;
    /** Notify that content was edited - resets idle timer */
    notifyEdit: () => void;
    /** Stop the controller */
    stop: () => void;
}

/**
 * Create a status controller that triggers edits during idle periods
 *
 * @param baseInterval Base interval for status updates (default 2500ms)
 * @param onIdleUpdate Callback to trigger an edit when idle - should call getText() and edit the message
 */
export const createStatusController = (
    baseInterval: number = 2500,
    onIdleUpdate: () => Promise<void>
): StatusController => {
    let index = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastEditTime = Date.now();
    let idleStretchCount = 0;
    let stopped = false;

    const getEntry = (): StatusEntry => statusData[index] ?? statusData[0]!;

    const advanceStatus = (): void => {
        index = (index + 1) % statusData.length;
    };

    const calculateInterval = (): number => {
        // Increase interval gradually when idle for too long
        // idleStretchCount increases when we trigger idle updates without real edits
        const stretch = Math.min(idleStretchCount, 5);
        return baseInterval + stretch * 500; // Max 5000ms
    };

    const scheduleIdleCheck = (): void => {
        if (stopped || timer) return;

        const interval = calculateInterval();

        timer = setTimeout(async () => {
            timer = null;
            if (stopped) return;

            const timeSinceLastEdit = Date.now() - lastEditTime;

            // If no edit happened in the interval, trigger an idle update
            if (timeSinceLastEdit >= interval - 100) {
                idleStretchCount++;
                advanceStatus();

                try {
                    await onIdleUpdate();
                } catch {
                    // Ignore errors
                }
            }

            scheduleIdleCheck();
        }, interval);
    };

    // Start checking
    scheduleIdleCheck();

    return {
        getText: () => {
            const entry = getEntry();
            return `${entry.symbol} ${entry.message}`;
        },
        getTextEscaped: () => {
            const entry = getEntry();
            return `${entry.symbol} ${entry.message.replace(/\./g, '\\.')}`;
        },
        notifyEdit: () => {
            lastEditTime = Date.now();
            // Reset idle stretch when real content comes in
            idleStretchCount = 0;
            // Advance status for next display
            advanceStatus();
        },
        stop: () => {
            stopped = true;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        },
    };
};
