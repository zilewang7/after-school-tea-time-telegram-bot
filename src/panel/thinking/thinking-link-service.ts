/**
 * The bot's single import surface of the thinking-link feature (design §8.1).
 *
 * Workflow B (streaming and final rendering) only needs these six exports; the
 * signatures are frozen so the two work streams can be built independently:
 *
 *   beginThinkingLink       create (or reuse) the link of one reply version
 *   thinkingAttemptKeyOf    the live-stream key of one version
 *   appendLiveThinking      keep one thinking chunk (from the very first one)
 *   finishLiveThinking      mark the thinking as ended (finalize / stop / error)
 *   thinkingLinkRefOfVersion the link a stored version replays (retry / switch)
 *   thinkingLinkEnabled     the THINKING_LINK switch
 *
 * `beginThinkingLink` never throws: a null means "this reply does not activate
 * the link mode", which is the documented fallback (design §9).
 */
import { webappPublicUrl } from '../share/share-urls.js';
import { isShareToken } from '../share/token.js';
import { thinkingLinkEnabled } from './thinking-config.js';
import { thinkingStream } from './thinking-stream.js';
import { findThinkingLink, insertThinkingLink } from './thinking-store.js';
import { thinkingFastPageUrl, thinkingMiniAppDeepLink } from './thinking-urls.js';
import type { BeginThinkingLinkInput, ThinkingAttemptInput, ThinkingLinkRef } from './thinking-types.js';

export type { BeginThinkingLinkInput, ThinkingLinkRef } from './thinking-types.js';
export { thinkingLinkEnabled } from './thinking-config.js';

/**
 * The ref of a token, or null when it cannot be a working link. Without a public
 * URL the whole feature is off; without BOT_USER_NAME the text link falls back to
 * the fast page, so the message is still tappable.
 */
const refOfToken = (token: string): ThinkingLinkRef | null => {
    if (!isShareToken(token) || webappPublicUrl() === '') return null;
    const fastPageUrl = thinkingFastPageUrl(token);
    const miniAppUrl = thinkingMiniAppDeepLink(token) ?? fastPageUrl;
    return { token, miniAppUrl, fastPageUrl };
};

/** The live-stream key of one reply version (`chatId:firstMessageId:versionId`) */
export const thinkingAttemptKeyOf = (input: ThinkingAttemptInput): string =>
    `${input.chatId}:${input.firstMessageId}:${input.versionId}`;

/**
 * The link of one reply version: the existing row when the version triggered the
 * link mode before, otherwise a new one. Null when the switch is off or the row
 * cannot be written (the caller then keeps the pre-link behaviour).
 */
export const beginThinkingLink = async (input: BeginThinkingLinkInput): Promise<ThinkingLinkRef | null> => {
    if (!thinkingLinkEnabled()) return null;
    try {
        const existing = await findThinkingLink(input);
        const row = existing ?? (await insertThinkingLink(input, new Date().toISOString()));
        return refOfToken(row.token);
    } catch (error) {
        console.warn(`[thinking] creating the link of ${thinkingAttemptKeyOf(input)} failed:`, error);
        return null;
    }
};

/** Keep one thinking chunk of an attempt; called from the very first chunk */
export const appendLiveThinking = (key: string, chunk: string): void => {
    thinkingStream.append(key, chunk);
};

/** Mark an attempt's thinking as ended; safe to call more than once */
export const finishLiveThinking = (key: string): void => {
    thinkingStream.finish(key);
};

/** The link a stored version replays on retry / version switch; null for old versions */
export const thinkingLinkRefOfVersion = (version: { thinkingLinkToken?: string }): ThinkingLinkRef | null => {
    const token = version.thinkingLinkToken;
    if (token === undefined || token === '') return null;
    return refOfToken(token);
};
