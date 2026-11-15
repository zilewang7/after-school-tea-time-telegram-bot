/**
 * A picture inside a rich message body: the media block's markdown and the
 * caption escaping Telegram needs.
 *
 * The scan replaces each embedded picture's marker with a sentinel paragraph
 * (`⟦media:img1⟧`), so the rest of the body goes through the normal markdown
 * rendering (`withCitations`, `toRichMarkdown`, `#N` links) with the sentinels
 * as plain text; the sentinel is then swapped for the media block here.
 *
 * Caption escaping is entity-based on purpose, measured on the real API:
 * - a backslash before the quote (`\"`) is accepted with 200 but the line is no
 *   longer a media block: the picture is dropped without an error;
 * - a real newline inside the title keeps the picture and drops the caption;
 * - `&quot;`/`&amp;`/`&lt;`/`&gt;` are decoded in the title, and inline
 *   markdown (`**bold**`, backticks) still works next to them;
 * - a backslash needs no escaping at all: one and two both render as one.
 * The HTML `<figure>` form is the fallback if the entity path ever fails; it
 * also decodes entities and keeps inline tags (`<b>`, `<code>`).
 */

/** A picture the answer embeds: the media id and what its caption says */
export interface RichInlineMedia {
    /** The media id the body references: `img1`, `img2`, … */
    readonly id: string;
    /** The caption source; markdown inline formatting is kept */
    readonly caption: string;
}

/** Telegram accepted 520 characters in a probe; the design keeps a shorter caption */
export const MAX_INLINE_CAPTION_LENGTH = 200;

/** The paragraph a scan leaves where a media block goes */
export const mediaSentinelOf = (id: string): string => `⟦media:${id}⟧`;

/** Any media sentinel of a body */
const MEDIA_SENTINEL = /⟦media:([A-Za-z0-9_-]+)⟧/g;

/** The caption as one line: a real newline inside the title silently drops it */
const foldCaption = (caption: string): string => caption.replace(/\s*\n\s*/g, ' ').trim();

/** Cut a very long caption, so a body budget cannot be spent on one */
const truncateCaption = (caption: string): string =>
    caption.length <= MAX_INLINE_CAPTION_LENGTH
        ? caption
        : `${caption.slice(0, MAX_INLINE_CAPTION_LENGTH).trimEnd()}…`;

/**
 * The caption inside a markdown title: HTML entities instead of backslashes
 * (see the file comment). The `&` goes first, so an entity the caption itself
 * contained is escaped once, not twice.
 */
export const escapeCaptionTitle = (caption: string): string =>
    foldCaption(caption)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

/** The characters that would end an HTML text node's caption early */
const escapeCaptionHtml = (caption: string): string =>
    foldCaption(caption)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

/** The trailing part of a caption inside a title, cut and escaped */
const titleTextOf = (caption: string): string => escapeCaptionTitle(truncateCaption(caption));

/** One media block: `![](tg://photo?id=img1 "图注")`, or bare without a caption */
export const richMediaBlockOf = (media: RichInlineMedia): string => {
    const title = titleTextOf(media.caption);
    const reference = `tg://photo?id=${media.id}`;
    return title === '' ? `![](${reference})` : `![](${reference} "${title}")`;
};

/**
 * The HTML fallback of one media block: a figure with the caption as its
 * figcaption. It decodes the same entities and keeps inline tags.
 */
export const richHtmlMediaBlockOf = (media: RichInlineMedia): string =>
    `<figure><img src="tg://photo?id=${media.id}"/><figcaption>${escapeCaptionHtml(
        truncateCaption(media.caption)
    )}</figcaption></figure>`;

/**
 * Put the media blocks where the scan left the sentinels. A sentinel with no
 * media is dropped (its picture failed to resolve and the caller already
 * replaced it with the caption text), and a body without media is returned
 * unchanged, byte for byte.
 */
export const replaceMediaSentinels = (
    markdown: string,
    media: readonly RichInlineMedia[]
): string => {
    if (media.length === 0) return markdown;
    const byId = new Map(media.map((picture) => [picture.id, picture]));
    return markdown.replace(MEDIA_SENTINEL, (_whole, id: string) => {
        const picture = byId.get(id);
        return picture === undefined ? '' : richMediaBlockOf(picture);
    });
};

/**
 * Replace a failed picture's sentinel with its caption text, so the body keeps
 * saying what was meant there (design §5.7: a picture that does not resolve
 * keeps its caption as text).
 */
export const replaceSentinelsWithCaptionText = (
    markdown: string,
    captions: ReadonlyMap<string, string>
): string =>
    markdown.replace(MEDIA_SENTINEL, (whole, id: string) => {
        // Only a failed picture is replaced: the others still become media blocks
        if (!captions.has(id)) return whole;
        const caption = foldCaption(captions.get(id) ?? '');
        return caption === '' ? '' : `（图片：${caption}）`;
    });
