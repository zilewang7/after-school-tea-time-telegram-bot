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

/**
 * Streaming edit budget: below the final one because the status line rides on
 * the same message while it generates.
 */
export const STREAMING_MAX_LENGTH = 3900;

/** Streaming entity budget, the same status-line headroom as above */
export const STREAMING_MAX_ENTITIES = 85;

/**
 * Rich-message fold limit, rendered text: the server marks a long rich message
 * `part` (clients show "显示更多") past 8192 UTF-16 code units (measured on Bot
 * API 10.4). The decision keeps ~6% headroom: over-predicting only costs the
 * thinking link the reply shows anyway, under-predicting leaves body text below
 * the fold.
 */
export const RICH_FOLD_MAX_UNITS = 7_680;

/**
 * Rich-message fold limit, serialized payload: ~16 KiB counts text bytes plus
 * per-block, per-entity and text_link URL bytes and media objects. ~8.5%
 * headroom over the measured boundary; see RICH_FOLD_MAX_UNITS.
 */
export const RICH_FOLD_MAX_BYTES = 15_000;
