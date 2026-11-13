/**
 * What the public Google-search fast page renders (design 2026-1113-1831 §3.5).
 *
 * One document per reply version: the signed pointer it was opened with, the
 * model and delivery time the meta line shows, and the search records
 * themselves. The live cache holds the same values without the target (its key
 * is the token), so the two read paths render the same page.
 */
import type { SearchPageTarget } from '../../shared/search-page.js';
import type { GoogleSearchDocument } from '../../telegram/formatters/google-search-document.js';

/** Everything `GET /g/<token>` shows */
export interface SearchPageDocument {
    /** The reply version the token names */
    readonly target: SearchPageTarget;
    /** Model that generated the version; null when it did not record one */
    readonly model: string | null;
    /** ISO time of the delivery, from the version (or the live cache) */
    readonly createdAt: string;
    /** The version's GoogleSearch footer as data */
    readonly document: GoogleSearchDocument;
}
