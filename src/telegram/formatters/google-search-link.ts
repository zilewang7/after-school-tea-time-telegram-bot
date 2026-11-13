/**
 * The compact message a GoogleSearch footer becomes when it cannot fit one
 * Telegram message (design 2026-1113-1831 §3.2): one text link to the public
 * fast page, an italic stats line, and the fast page's preview card.
 *
 * Same shape as the long-CoT link message (thinking-link.ts): the whole visible
 * text is the link, the stats line sits right below it, and `link_preview_options`
 * pins the card to the fast page. Unlike the CoT card, this card's description
 * is the quote block's text — the reader still sees what was searched.
 */
import { concatMessages } from 'telegram-md-entities';
import type { RenderedMessage } from 'telegram-md-entities';
import type { SearchPageLink } from '../../shared/search-page.js';
import type { LinkPreviewOptions } from '../link-preview.js';
import { italicText } from './entity-text.js';
import type { GoogleSearchDocument } from './google-search-document.js';
import type { FinalMessageChunk } from './final-message-builder.js';

/** The whole visible text of the link (the emoji is part of the link) */
export const SEARCH_LINK_LABEL = '🔍 查看完整搜索过程';

/** How the link hides the footer's size, in the numbers the footer would list */
export interface SearchLinkStats {
    /** Queries the footer lists (one per search) */
    readonly queryCount: number;
    /** Numbered sources the footer lists */
    readonly sourceCount: number;
}

/** `共搜索 131 次，引用 3 条来源`; a footer with only one of the two says only that */
export const searchLinkSummaryLine = (stats: SearchLinkStats): string => {
    const parts: string[] = [];
    if (stats.queryCount > 0) {
        parts.push(`共搜索 ${stats.queryCount.toLocaleString('zh-CN')} 次`);
    }
    if (stats.sourceCount > 0) {
        parts.push(`引用 ${stats.sourceCount.toLocaleString('zh-CN')} 条来源`);
    }
    return parts.join('，');
};

/** The stats of the footer a folded link message replaced */
export const searchLinkStatsOf = (document: GoogleSearchDocument): SearchLinkStats => ({
    queryCount: document.queryCount,
    sourceCount: document.sourceCount,
});

/**
 * The card of the link message: the public fast page, shown below the text. No
 * large media — the page has no og:image, so Telegram renders a text card whose
 * description is the quote block's text.
 */
export const searchLinkPreviewOptions = (link: SearchPageLink): LinkPreviewOptions => ({
    url: link.url,
    show_above_text: false,
});

/** Terminal message: the link, then the italic stats line on the very next line */
export const renderSearchLinkMessage = (
    link: SearchPageLink,
    stats: SearchLinkStats
): RenderedMessage => {
    const label: RenderedMessage = {
        text: SEARCH_LINK_LABEL,
        entities: [
            {
                type: 'text_link',
                offset: 0,
                length: SEARCH_LINK_LABEL.length,
                url: link.url,
            },
        ],
    };
    const line = searchLinkSummaryLine(stats);
    return line === '' ? label : concatMessages(label, '\n', italicText(line));
};

/** Terminal chunk for buildFinalMessages / version replay, preview card included */
export const toSearchLinkChunk = (
    link: SearchPageLink,
    stats: SearchLinkStats
): FinalMessageChunk => ({
    ...renderSearchLinkMessage(link, stats),
    linkPreviewOptions: searchLinkPreviewOptions(link),
});
