/**
 * Per-message budgets of the final layout: Telegram accepts 4096 characters
 * and silently drops entities past ~100, so the splitter keeps headroom.
 *
 * Shared with the long-CoT segment estimate, which must count the messages the
 * splitter would actually produce.
 */

/** Safe per-message length budget (below Telegram's 4096 hard limit) */
export const TELEGRAM_MAX_LENGTH = 4000;

/** Per-message entity budget (the server silently drops entities past ~100) */
export const TELEGRAM_MAX_ENTITIES = 90;
