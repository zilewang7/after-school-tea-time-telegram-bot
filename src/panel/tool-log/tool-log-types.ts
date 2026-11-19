/**
 * The stored shape of a folded Tools block's public page (design 2026-1119-1835
 * §13.2: the page is generated once, not on request).
 *
 * The row is written before the link message goes out, so Telegram's preview
 * crawler — which fetches once and never refreshes the card — reads the final
 * page on its first request. `html` is the complete fast page as it was
 * rendered at delivery time; the row never changes afterwards.
 */
import type { ToolLogPageTarget } from '../../shared/tool-log-page.js';
import type { ToolLogDocument } from '../../telegram/formatters/tool-log-document.js';

/** One row of the public tool-log pages table; the signed token names the same triple */
export interface ToolLogPageRow extends ToolLogPageTarget {
    /** Signed page token: `<payload>.<signature>`; also the row's primary key */
    readonly token: string;
    /** Model that generated the version; null when it did not record one */
    readonly model: string | null;
    /** ISO time of the delivery, the page's meta line */
    readonly createdAt: string;
    /** The whole fast page, rendered once at delivery time */
    readonly html: string;
}

/** Generating (or reusing) the page of one reply version */
export interface BeginToolLogLinkInput extends ToolLogPageTarget {
    readonly model: string | null;
    readonly createdAt: string;
    /** The Tools block document the page is rendered from */
    readonly document: ToolLogDocument;
}

/** What the page renderer needs, before it is stored as `html` */
export interface ToolLogPageRenderInput {
    readonly model: string | null;
    readonly createdAt: string;
    readonly document: ToolLogDocument;
}
