/**
 * The stored shape of a folded GoogleSearch footer's public page
 * (design 2026-1113-1831 §3.6: the page is generated once, not on request).
 *
 * The row is written before the link message goes out, so Telegram's preview
 * crawler — which fetches once and never refreshes the card — reads the final
 * page on its first request. `html` is the complete fast page as it was
 * rendered at delivery time; the row never changes afterwards.
 */
import type { GoogleSearchDocument } from '../../telegram/formatters/google-search-document.js';

/** The reply version a page belongs to; the signed token names the same triple */
export interface SearchPageTarget {
    readonly chatId: number;
    readonly firstMessageId: number;
    readonly versionId: number;
}

/** One row of the public search pages table */
export interface SearchLinkRow {
    /** Signed page token: `<payload>.<signature>`; also the row's primary key */
    readonly token: string;
    readonly chatId: number;
    readonly firstMessageId: number;
    readonly versionId: number;
    /** Model that generated the version; null when it did not record one */
    readonly model: string | null;
    /** ISO time of the delivery, the page's meta line */
    readonly createdAt: string;
    /** The whole fast page, rendered once at delivery time */
    readonly html: string;
}

/** Generating (or reusing) the page of one reply version */
export interface BeginSearchLinkInput extends SearchPageTarget {
    readonly model: string | null;
    readonly createdAt: string;
    /** The footer document the page is rendered from */
    readonly document: GoogleSearchDocument;
}

/** What the page renderer needs, before it is stored as `html` */
export interface SearchPageRenderInput {
    readonly model: string | null;
    readonly createdAt: string;
    readonly document: GoogleSearchDocument;
}
