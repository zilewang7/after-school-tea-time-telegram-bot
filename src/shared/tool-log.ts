/**
 * Display limits of the Tools block's per-call log (design 2026-1119-1835).
 *
 * Shared by the AI-layer collector (which writes the records) and the Telegram
 * formatter / public page (which render them), so one line always fits the same
 * budget on both sides. There is no cap on how many calls a reply may show: the
 * block grows, and the delivery decides where it goes (inline, its own message,
 * or the public log page).
 */

/** Characters of an argument summary one call line shows */
export const TOOL_LOG_ARGUMENT_MAX_CHARS = 56;

/** Characters of an outcome summary one call line shows */
export const TOOL_LOG_RESULT_MAX_CHARS = 40;

/** A call slower than this shows its duration at the end of the line */
export const TOOL_LOG_SLOW_CALL_MS = 3_000;

/**
 * Clickable spans one call line keeps (design 2026-1120-1617): `read_history`
 * shows at most three refs or one `around`, `fetch_image` at most three; heads
 * room for one more without letting a single line grow unbounded.
 */
export const TOOL_LOG_MAX_LINKS_PER_CALL = 4;

/**
 * Clickable spans one reply keeps in total. Each is ~50–70 bytes of JSON, so
 * this bounds the extra `versions` storage at roughly 13KB even for a reply
 * with hundreds of calls; normal replies are far below it.
 */
export const TOOL_LOG_MAX_LINKS = 200;

/**
 * Safety cap of records kept for one reply. Production's observed maximum is
 * 329 calls; a reply beyond this keeps counting (the usage line stays complete)
 * and the log says how many records were dropped.
 */
export const TOOL_LOG_MAX_RECORDS = 500;

/** Cut by code points, so an emoji is never split in half */
export const truncateCodePoints = (text: string, maxChars: number): string => {
    const points = Array.from(text);
    return points.length <= maxChars ? text : points.slice(0, Math.max(0, maxChars - 1)).join('') + '…';
};

/** `3.4s` for a slow call's duration; one decimal, never `0.0s` */
export const formatCallSeconds = (ms: number): string => {
    const seconds = Math.max(0.1, Math.round(ms / 100) / 10);
    return `${seconds.toFixed(1)}s`;
};
