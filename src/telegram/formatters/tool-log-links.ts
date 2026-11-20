/**
 * Where the clickable spans of one Tools-block line sit (design 2026-1120-1617).
 *
 * The chat block (text_link entities) and the public `/x` page (`<a>`) both
 * read this one answer, so the two views can never disagree about which `h45`
 * is a link, and the panel exports the same spans.
 *
 * Offsets are UTF-16 units, exactly what Telegram entity offsets are and what
 * `String.prototype.indexOf` returns.
 */
import type { MessageEntity } from 'telegram-md-entities';
import type { ToolLogLine } from './tool-log-document.js';

export interface LineLinkSpan {
    /** UTF-16 offset in the line's text */
    offset: number;
    length: number;
    url: string;
}

/** Only http(s) may become a link; the record builder already drops the rest, this is the second gate */
const OPENABLE_URL = /^https?:\/\//i;

const overlaps = (spans: readonly LineLinkSpan[], offset: number, length: number): boolean =>
    spans.some((span) => offset < span.offset + span.length && span.offset < offset + length);

/**
 * Every occurrence of every link's text, in offset order. A span that would
 * overlap one already placed is skipped (`h1` is not linked inside a claimed
 * `h12`), and the same text with two URLs keeps the first one.
 */
export const lineLinkSpansOf = (line: ToolLogLine): LineLinkSpan[] => {
    const spans: LineLinkSpan[] = [];
    for (const link of line.links) {
        const text = link.text;
        if (text === '' || !OPENABLE_URL.test(link.url)) continue;
        for (let at = line.text.indexOf(text); at >= 0; at = line.text.indexOf(text, at + text.length)) {
            if (overlaps(spans, at, text.length)) continue;
            spans.push({ offset: at, length: text.length, url: link.url });
        }
    }
    return spans.sort((left, right) => left.offset - right.offset);
};

/** The line's clickable spans as Telegram `text_link` entities */
export const lineLinkEntities = (line: ToolLogLine): MessageEntity[] =>
    lineLinkSpansOf(line).map((span) => ({
        type: 'text_link',
        offset: span.offset,
        length: span.length,
        url: span.url,
    }));
