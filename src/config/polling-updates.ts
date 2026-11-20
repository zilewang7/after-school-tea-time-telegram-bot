/**
 * The update types the long-polling client asks Telegram for.
 *
 * A reaction update is never delivered unless `message_reaction` is listed
 * explicitly: the server's default set is everything except `chat_member`,
 * `message_reaction` and `message_reaction_count`. An explicit list replaces
 * that default set as a whole, so it is derived from `DEFAULT_UPDATE_TYPES`
 * instead of hand-written — a missing type fails silently (grammy only warns
 * under `DEBUG=grammy*`).
 *
 * Kept outside `index.ts` so tests can import it: that module creates the bot
 * and starts the panel at import time.
 */
import { API_CONSTANTS } from 'grammy';

/**
 * Today's default set plus the reaction updates. `chat_member` stays off (no
 * handler, and a busy chat would stream join/leave updates); the anonymous
 * `message_reaction_count` is not handled either (channel posts are not stored
 * as messages, so there is no context row to attach it to).
 *
 * The list is frozen at the 27 update types of @grammyjs/types 5.0.0. When
 * Telegram adds a type (e.g. Bot API 10.4's `widget_query`), bump the dependency
 * and extend this list — otherwise the explicit list keeps filtering it out.
 */
export const POLLING_ALLOWED_UPDATES = [
    ...API_CONSTANTS.DEFAULT_UPDATE_TYPES,
    'message_reaction',
] as const;
