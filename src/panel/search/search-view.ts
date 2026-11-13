/**
 * What the public Google-search page reads (design 2026-1113-1831 §3.7).
 *
 * Read order: the live delivery cache first — Telegram's crawler hits the page
 * right after the link message goes out, while the reply version is not stored
 * yet — then the stored version's `groundingData` (process restarted, or a
 * stale link).
 *
 * The page must show exactly the text the chat footer shows, so the stored
 * value goes through the same `buildGoogleSearchDocument` the footer and the
 * version replay use, with no second parser of its own: a field-by-field guard
 * would silently drop whatever a later GroundingData field adds (the panel's
 * `parseGroundingSteps` already lost `searchEntryPoint` that way). The JSON is
 * written by this repository, so the only defence needed is a try/catch — a
 * corrupt version is treated like every other miss: the same uniform 404.
 */
import type { ResponseVersion } from '../../db/index.js';
import { findBotResponseInChat } from '../../db/queries/context-queries.js';
import { searchPageTargetOfToken, type SearchPageTarget } from '../../shared/search-page.js';
import {
    buildGoogleSearchDocument,
    type GoogleSearchDocument,
} from '../../telegram/formatters/google-search-document.js';
import { cachedSearchDocument } from './search-document-cache.js';
import type { SearchPageDocument } from './search-types.js';

/** The stored version the token names; null when the reply or the version is gone */
const storedVersionOf = async (target: SearchPageTarget): Promise<ResponseVersion | null> => {
    const response = await findBotResponseInChat(target.chatId, target.firstMessageId);
    if (response === null) return null;
    return response.getVersions().find((version) => version.versionId === target.versionId) ?? null;
};

const modelOf = (version: ResponseVersion): string | null => {
    const model = version.model;
    return typeof model === 'string' && model.trim() !== '' ? model : null;
};

/** The version's search records as the page document; null when it carries none */
const searchDocumentOf = (version: ResponseVersion): GoogleSearchDocument | null => {
    try {
        const document = buildGoogleSearchDocument(version.groundingData ?? []);
        return document.blocks.length === 0 ? null : document;
    } catch {
        // The stored JSON is ours; a corrupt one reads as the same 404
        return null;
    }
};

/** The page document behind a token; null for every kind of miss (the route's 404) */
export const loadSearchDocument = async (token: string): Promise<SearchPageDocument | null> => {
    // The signature is the permission; verify it before the cache so a forged
    // token can never read a cached document.
    const target = searchPageTargetOfToken(token);
    if (target === null) return null;

    const cached = cachedSearchDocument(token);
    if (cached !== null) {
        return {
            target,
            model: cached.model,
            createdAt: cached.createdAt,
            document: cached.document,
        };
    }

    const version = await storedVersionOf(target);
    if (version === null) return null;
    const document = searchDocumentOf(version);
    if (document === null) return null;
    return {
        target,
        model: modelOf(version),
        createdAt: version.createdAt,
        document,
    };
};
