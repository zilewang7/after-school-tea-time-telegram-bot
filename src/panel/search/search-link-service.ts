/**
 * The bot's import surface of the folded-footer page (design 2026-1113-1831
 * §3.6): generate the page once, store it, and hand the reply a pointer.
 *
 * The final layout asks here only after deciding the footer cannot fit one
 * message. This module renders the page and stores it **before returning**, so
 * the link message is never sent for a page that does not exist yet: Telegram's
 * preview crawler fetches once and keeps that card, and a replay of the version
 * reads the same token and therefore the same page.
 *
 * `beginSearchLink` never throws: a null means the reply falls back to the
 * inline footer, exactly as before the feature.
 */
import {
    searchLinkEnabled,
    searchPageLinkOfToken,
    searchPageTokenOf,
    type SearchPageLink,
} from '../../shared/search-page.js';
import { renderSearchPage } from './search-page.js';
import { findSearchLinkByToken, insertSearchLink } from './search-store.js';
import type { BeginSearchLinkInput } from './search-types.js';

/** The pointer of one version, if its token is well-formed and a public origin exists */
const refOfInput = (input: BeginSearchLinkInput): SearchPageLink | null =>
    searchPageLinkOfToken(searchPageTokenOf(input));

/**
 * The page of one folded footer: existing page reused, otherwise rendered once
 * from the footer document and stored before anything is sent. Null when the
 * switch is off, no public origin is configured, or storage fails — the caller
 * then keeps the inline footer.
 */
export const beginSearchLink = async (input: BeginSearchLinkInput): Promise<SearchPageLink | null> => {
    if (!searchLinkEnabled()) return null;
    const ref = refOfInput(input);
    if (ref === null) return null;
    try {
        const existing = await findSearchLinkByToken(ref.token);
        if (existing !== null) return ref;
        const html = renderSearchPage({
            model: input.model,
            createdAt: input.createdAt,
            document: input.document,
        });
        await insertSearchLink({
            token: ref.token,
            chatId: input.chatId,
            firstMessageId: input.firstMessageId,
            versionId: input.versionId,
            model: input.model,
            createdAt: input.createdAt,
            html,
        });
        return ref;
    } catch (error) {
        console.warn(
            `[search-link] generating the page of ${input.chatId}:${input.firstMessageId}:${input.versionId} failed:`,
            error
        );
        return null;
    }
};
