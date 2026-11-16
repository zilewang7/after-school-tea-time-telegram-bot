/**
 * A rich reply's stored answer snapshot (`richAnswerMarkdown`) as a block tree
 * and as safe HTML (v5.3 design 2026-1116-0310 §3.2).
 *
 * Two consumers share the block dialect: the public share page (server-rendered,
 * must stay readable without JavaScript) and the fold-length counter
 * (`rich-body-length.ts`), which measures a rich body's rendered text before
 * Telegram folds it. This is the SSR port of the Mini App's
 * `webapp/src/rich/rich-answer.ts` parser: the same block dialect (fences, headings, lists with depth, quotes,
 * tables, dividers, paragraphs, media blocks outside fences, block-level `<p>`
 * unwrapping, dangling hard breaks) and the same picture mapping (exact media
 * id, then the remaining inline entries in snapshot-id order, caption-only
 * fallback). Only the inline layer differs: this side renders each line with
 * the existing `markdownToHtml` (telegram-md-entities), the webapp renders runs.
 *
 * Everything emitted is built here — the snapshot's own text is escaped by the
 * inline renderer and never concatenated as markup: a `<script>` in the answer
 * shows as text, a `javascript:` link stays plain. Pure module (no db, no IO),
 * so the offline tests can compare its block sequence with the Mini App parser.
 */
import { match } from 'ts-pattern';
import { escapeHtml, markdownToHtml } from './markdown-html.js';

/** The media facts the snapshot's picture blocks need; `MediaDescriptor` satisfies it */
export interface RichAnswerHtmlMedia {
    /** The inline media id the snapshot references (`img1`…); attachments have none */
    readonly id?: string | null;
    /** Original caption markdown, rendered under the picture */
    readonly caption?: string | null;
    /** `inline` pictures are the ones the snapshot can reference */
    readonly placement?: 'inline' | 'attachment';
}

export interface RichAnswerHtmlListItem {
    /** 0-based indentation level (`  - x` is depth 1) */
    readonly depth: number;
    /** The item's inline content, already rendered */
    readonly html: string;
}

/** One picture block: the index into the version's `media[]` its id mapped to */
export interface RichAnswerHtmlPhotoBlock {
    readonly kind: 'photo';
    readonly mediaIndex: number;
    /** The picture's server-built URL (`/s/<token>/media/<id>/image?i=<index>`) */
    readonly src: string;
    /** The caption to show under it, already rendered; null when it has none */
    readonly captionHtml: string | null;
}

export type RichAnswerHtmlBlock =
    | { readonly kind: 'paragraph'; readonly html: string }
    | { readonly kind: 'heading'; readonly size: 1 | 2 | 3 | 4 | 5 | 6; readonly html: string }
    | { readonly kind: 'pre'; readonly language: string | null; readonly text: string }
    | {
          readonly kind: 'list';
          readonly ordered: boolean;
          /** Ordered lists only: the first item's number when it is not 1 (`<ol start>`) */
          readonly start?: number;
          readonly items: readonly RichAnswerHtmlListItem[];
      }
    | { readonly kind: 'quote'; readonly blocks: readonly RichAnswerHtmlBlock[] }
    | {
          readonly kind: 'table';
          /** The header row's cells; absent for a separator-less table fragment */
          readonly header?: readonly string[];
          readonly rows: readonly (readonly string[])[];
      }
    | { readonly kind: 'divider' }
    | RichAnswerHtmlPhotoBlock
    /** Fallback text: a picture whose media could not be matched keeps its caption */
    | { readonly kind: 'plain'; readonly text: string };

export interface RichAnswerHtmlResult {
    /** The body's HTML; empty for an empty snapshot */
    readonly html: string;
    /** The parsed blocks, for the consistency test and the leftover media */
    readonly blocks: readonly RichAnswerHtmlBlock[];
    /** The media indexes the body shows, ascending */
    readonly referencedMediaIndexes: readonly number[];
}

/** A base64-free picture URL builder over one message's media list */
export type RichAnswerPhotoUrlOf = (mediaIndex: number) => string;

// ---- block syntax ---------------------------------------------------------

const FENCE_OPEN = /^(\s*)```(.*)$/;
const FENCE_CLOSE = /^\s*```\s*$/;
const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const DIVIDER = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE_LINE = /^\s{0,3}>\s?(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const MEDIA_BLOCK = /^!\[\]\(tg:\/\/photo\?id=([A-Za-z0-9_-]+)(?:\s+"([^"]*)")?\)\s*$/;
const TABLE_SEPARATOR_CELL = /^:?-{1,}:?$/;

const headingSizeOf = (level: number): 1 | 2 | 3 | 4 | 5 | 6 => {
    if (level >= 6) return 6;
    if (level === 5) return 5;
    if (level === 4) return 4;
    if (level === 3) return 3;
    if (level === 2) return 2;
    return 1;
};

const isOrderedMarker = (marker: string): boolean => /^\d/.test(marker);

/** Two spaces per nesting level, the indentation toRichMarkdown keeps */
const depthOfIndent = (indent: string): number => Math.min(5, Math.floor(indent.replace(/\t/g, '  ').length / 2));

const splitTableRow = (line: string): string[] => {
    let trimmed = line.trim();
    if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
    if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
    return trimmed.split('|').map((cell) => cell.trim());
};

const isTableSeparator = (line: string): boolean => {
    const cells = splitTableRow(line);
    return cells.length > 0 && cells.every((cell) => TABLE_SEPARATOR_CELL.test(cell));
};

const isTableStart = (lines: readonly string[], index: number): boolean => {
    const header = lines[index] ?? '';
    const separator = lines[index + 1] ?? '';
    return header.includes('|') && separator.includes('|') && isTableSeparator(separator);
};

/** Whether the line opens a block, so a paragraph cannot swallow it */
const startsBlock = (lines: readonly string[], index: number): boolean => {
    const line = lines[index] ?? '';
    return (
        MEDIA_BLOCK.test(line)
        || FENCE_OPEN.test(line)
        || HEADING.test(line)
        || DIVIDER.test(line)
        || QUOTE_LINE.test(line)
        || LIST_ITEM.test(line)
        || isTableStart(lines, index)
    );
};

/**
 * The snapshot writes a hard line break as a trailing `\\` before the newline.
 * A lone trailing backslash has no next line to break: it is a marker with
 * nothing to carry, and renderMarkdown would show it literally.
 */
const withoutDanglingHardBreak = (text: string): string => {
    if (!text.endsWith('\\')) return text;
    let backslashes = 0;
    for (let index = text.length - 1; index >= 0 && text[index] === '\\'; index -= 1) backslashes += 1;
    return backslashes % 2 === 1 ? text.slice(0, -1) : text;
};

/**
 * One inline segment as safe HTML. Newlines inside the rendered text are hard
 * breaks the chat showed (a trailing `\\` marker line, or a multi-line list
 * item); the block serializer never emits whitespace between tags, so a `<br>`
 * keeps them without the container needing `white-space: pre-wrap`.
 */
const inlineHtml = (text: string): string =>
    markdownToHtml(withoutDanglingHardBreak(text)).replace(/\n/g, '<br>');

// ---- media mapping --------------------------------------------------------

/** Decode the entity escapes a snapshot caption title carries (`&quot;`…) */
const decodeMediaTitle = (title: string | null): string =>
    (title ?? '')
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');

/**
 * Distinct media ids the body references, in first-appearance order. Only real
 * media blocks count: a code fence showing `tg://photo?id=…` is an example,
 * not a picture the version delivered. A block quoted with `>` still makes the
 * picture a body picture, so the quote prefix is looked through here (the
 * quote's own parse sees the stripped line).
 */
const snapshotMediaIds = (markdown: string): string[] => {
    const ids: string[] = [];
    let inFence = false;
    for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
        if (inFence) {
            if (FENCE_CLOSE.test(line)) inFence = false;
            continue;
        }
        if (FENCE_OPEN.test(line)) {
            inFence = true;
            continue;
        }
        const id = MEDIA_BLOCK.exec(line.replace(/^\s{0,3}(?:>\s?)+/, ''))?.[1];
        if (id !== undefined && !ids.includes(id)) ids.push(id);
    }
    return ids;
};

/**
 * Rich bodies mix two dialects: the answer markdown, and blocks the bot built
 * as HTML (`toRichHtml` — the L2 "pictures could not be embedded" note). A
 * block-level `<p>` is not markdown and would show as literal tags, so strip
 * the tags at line boundaries; code fences keep every character.
 */
const stripBlockParagraphTags = (lines: readonly string[]): string[] => {
    const stripped: string[] = [];
    let inFence = false;
    for (const line of lines) {
        if (inFence) {
            stripped.push(line);
            if (FENCE_CLOSE.test(line)) inFence = false;
            continue;
        }
        if (FENCE_OPEN.test(line)) {
            inFence = true;
            stripped.push(line);
            continue;
        }
        const leading = /^\s*/u.exec(line)?.[0] ?? '';
        const body = line.slice(leading.length);
        // Only a line that is one whole <p> element is unwrapped: a stray tag in
        // the answer's own text (someone explaining HTML) is text, not markup.
        const paragraph = /^<p\b[^>]*>([\s\S]*)<\/p>\s*$/iu.exec(body);
        stripped.push(`${leading}${paragraph === null ? body : (paragraph[1] ?? '')}`);
    }
    return stripped;
};

interface ResolvedPhoto {
    readonly mediaIndex: number;
    readonly captionHtml: string | null;
}

interface UnresolvedPhoto {
    /** The decoded media-block title, shown as plain text */
    readonly title: string;
}

type PhotoResolution = ResolvedPhoto | UnresolvedPhoto;

/** The rendered caption for a picture: the stored caption, else the block title */
const captionHtmlOf = (
    media: readonly RichAnswerHtmlMedia[],
    mediaIndex: number,
    captionTitle: string | null
): string | null => {
    const stored = media[mediaIndex]?.caption;
    if (typeof stored === 'string' && stored.trim() !== '') return inlineHtml(stored);
    const title = decodeMediaTitle(captionTitle);
    return title === '' ? null : escapeHtml(title);
};

/**
 * Map the snapshot's picture ids onto `media[]`: an exact `media[i].id` first,
 * then the remaining inline entries in snapshot-id order (older rows carry no
 * id), and a caption-only fallback when nothing is left.
 */
const createMediaMapping = (
    media: readonly RichAnswerHtmlMedia[],
    ids: readonly string[]
): ((id: string, captionTitle: string | null) => PhotoResolution) => {
    const inlineIndexes = media.flatMap((item, index) => ((item.placement ?? 'inline') === 'attachment' ? [] : [index]));
    const byId = new Map<string, number>();
    for (const index of inlineIndexes) {
        const id = media[index]?.id;
        if (typeof id === 'string' && id !== '' && !byId.has(id)) byId.set(id, index);
    }

    const assigned = new Map<string, number>();
    const used = new Set<number>();
    // Exact ids first, so a fallback never takes a picture another id names
    for (const id of ids) {
        const exact = byId.get(id);
        if (exact === undefined || used.has(exact)) continue;
        assigned.set(id, exact);
        used.add(exact);
    }
    for (const id of ids) {
        if (assigned.has(id)) continue;
        const next = inlineIndexes.find((index) => !used.has(index));
        if (next === undefined) continue;
        assigned.set(id, next);
        used.add(next);
    }

    return (id, captionTitle) => {
        const mediaIndex = assigned.get(id);
        if (mediaIndex !== undefined) return { mediaIndex, captionHtml: captionHtmlOf(media, mediaIndex, captionTitle) };
        return { title: decodeMediaTitle(captionTitle) };
    };
};

// ---- block parsing --------------------------------------------------------

const parseBlocks = (
    markdown: string,
    resolvePhoto: (id: string, captionTitle: string | null) => PhotoResolution,
    photoUrlOf: RichAnswerPhotoUrlOf
): RichAnswerHtmlBlock[] => {
    const lines = stripBlockParagraphTags(markdown.replace(/\r\n?/g, '\n').split('\n'));
    const blocks: RichAnswerHtmlBlock[] = [];
    let index = 0;

    while (index < lines.length) {
        const line = lines[index] ?? '';
        if (line.trim() === '') {
            index += 1;
            continue;
        }

        const media = MEDIA_BLOCK.exec(line);
        if (media !== null) {
            const resolved = resolvePhoto(media[1] ?? '', media[2] ?? null);
            if ('mediaIndex' in resolved) {
                blocks.push({
                    kind: 'photo',
                    mediaIndex: resolved.mediaIndex,
                    src: photoUrlOf(resolved.mediaIndex),
                    captionHtml: resolved.captionHtml,
                });
            } else if (resolved.title !== '') {
                blocks.push({ kind: 'plain', text: resolved.title });
            }
            index += 1;
            continue;
        }

        const fence = FENCE_OPEN.exec(line);
        if (fence !== null) {
            const info = (fence[2] ?? '').trim();
            const codeLines: string[] = [];
            index += 1;
            while (index < lines.length && !FENCE_CLOSE.test(lines[index] ?? '')) {
                codeLines.push(lines[index] ?? '');
                index += 1;
            }
            index += 1; // the closing fence
            blocks.push({
                kind: 'pre',
                language: info === '' ? null : (info.split(/\s+/)[0] ?? null),
                text: codeLines.join('\n'),
            });
            continue;
        }

        const heading = HEADING.exec(line);
        if (heading !== null) {
            blocks.push({
                kind: 'heading',
                size: headingSizeOf((heading[1] ?? '').length),
                // The package reads the `###` marker and returns the text bold,
                // exactly what the chat showed for a rich heading
                html: inlineHtml(line),
            });
            index += 1;
            continue;
        }

        if (DIVIDER.test(line)) {
            blocks.push({ kind: 'divider' });
            index += 1;
            continue;
        }

        if (isTableStart(lines, index)) {
            const header = splitTableRow(line).map((cell) => inlineHtml(cell));
            const rows: string[][] = [];
            index += 2; // header + separator
            while (index < lines.length) {
                const row = lines[index] ?? '';
                if (row.trim() === '' || !row.includes('|') || isTableSeparator(row)) break;
                rows.push(splitTableRow(row).map((cell) => inlineHtml(cell)));
                index += 1;
            }
            blocks.push({ kind: 'table', header, rows });
            continue;
        }

        const quote = QUOTE_LINE.exec(line);
        if (quote !== null) {
            const innerLines: string[] = [];
            let match: RegExpExecArray | null = quote;
            while (match !== null) {
                innerLines.push(match[1] ?? '');
                index += 1;
                match = index < lines.length ? QUOTE_LINE.exec(lines[index] ?? '') : null;
            }
            blocks.push({ kind: 'quote', blocks: parseBlocks(innerLines.join('\n'), resolvePhoto, photoUrlOf) });
            continue;
        }

        const listItem = LIST_ITEM.exec(line);
        if (listItem !== null) {
            const ordered = isOrderedMarker(listItem[2] ?? '');
            const items: RichAnswerHtmlListItem[] = [];
            let start: number | undefined;
            // A list item may run over several lines: toRichMarkdown writes the
            // rest as indented lines (a trailing `\\` on the marker line is its
            // hard break), so they join the current item until the next marker.
            let itemLines: string[] | null = null;
            let itemDepth = 0;
            const pushItem = (): void => {
                if (itemLines === null) return;
                items.push({ depth: itemDepth, html: inlineHtml(itemLines.join('\n')) });
                itemLines = null;
            };
            while (index < lines.length) {
                const current = lines[index] ?? '';
                if (current.trim() === '') {
                    // A blank line either separates loose items of this list or ends it
                    let lookahead = index;
                    while (lookahead < lines.length && (lines[lookahead] ?? '').trim() === '') lookahead += 1;
                    const next = lookahead < lines.length ? LIST_ITEM.exec(lines[lookahead] ?? '') : null;
                    index = lookahead;
                    if (next !== null && isOrderedMarker(next[2] ?? '') === ordered) continue;
                    break;
                }
                const marker = LIST_ITEM.exec(current);
                if (marker !== null) {
                    if (isOrderedMarker(marker[2] ?? '') !== ordered) break;
                    pushItem();
                    itemDepth = depthOfIndent(marker[1] ?? '');
                    itemLines = [marker[3] ?? ''];
                    if (ordered && start === undefined) start = Number.parseInt(marker[2] ?? '', 10);
                    index += 1;
                    continue;
                }
                if (itemLines === null) break;
                // An unindented block opener ends the list instead of joining
                // the item: the markdown would have started a new block there
                if (!/^\s/u.test(current) && startsBlock(lines, index)) break;
                itemLines.push(current.replace(/^\s+/u, ''));
                index += 1;
            }
            pushItem();
            blocks.push({
                kind: 'list',
                ordered,
                ...(start === undefined || start === 1 ? {} : { start }),
                items,
            });
            continue;
        }

        const paragraphLines: string[] = [];
        while (index < lines.length) {
            const current = lines[index] ?? '';
            if (current.trim() === '') break;
            if (paragraphLines.length > 0 && startsBlock(lines, index)) break;
            paragraphLines.push(current);
            index += 1;
        }
        blocks.push({ kind: 'paragraph', html: inlineHtml(paragraphLines.join('\n')) });
    }

    return blocks;
};

// ---- HTML serialization ---------------------------------------------------

const headingTagOf = (size: 1 | 2 | 3 | 4 | 5 | 6): 'h3' | 'h4' | 'h5' => {
    if (size <= 2) return 'h3';
    if (size <= 4) return 'h4';
    return 'h5';
};

/** One indentation step per list depth, matching the Mini App's `depth * 16px` */
const LIST_INDENT_PX = 16;

const serializeBlock = (block: RichAnswerHtmlBlock): string =>
    match(block)
        .with({ kind: 'paragraph' }, (paragraph) => `<p>${paragraph.html}</p>`)
        .with({ kind: 'heading' }, (heading) => {
            const tag = headingTagOf(heading.size);
            return `<${tag} class="rich-heading rich-heading--${heading.size}">${heading.html}</${tag}>`;
        })
        .with({ kind: 'pre' }, (pre) => `<pre><code>${escapeHtml(pre.text)}</code></pre>`)
        .with({ kind: 'list' }, (list) => {
            const tag = list.ordered ? 'ol' : 'ul';
            const start = list.ordered && list.start !== undefined ? ` start="${list.start}"` : '';
            const items = list.items
                .map((item) => `<li style="margin-inline-start:${item.depth * LIST_INDENT_PX}px">${item.html}</li>`)
                .join('');
            return `<${tag}${start}>${items}</${tag}>`;
        })
        .with({ kind: 'quote' }, (quote) => `<blockquote>${serializeBlocks(quote.blocks)}</blockquote>`)
        .with({ kind: 'table' }, (table) => {
            const head =
                table.header === undefined
                    ? ''
                    : `<thead><tr>${table.header.map((cell) => `<th>${cell}</th>`).join('')}</tr></thead>`;
            const body = table.rows
                .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
                .join('');
            return `<div class="rich-table"><table>${head}<tbody>${body}</tbody></table></div>`;
        })
        .with({ kind: 'divider' }, () => '<hr>')
        .with({ kind: 'photo' }, (photo) => {
            const caption = photo.captionHtml === null ? '' : `<figcaption>${photo.captionHtml}</figcaption>`;
            return `<figure class="rich-figure"><img src="${escapeHtml(photo.src)}" alt="图片" loading="lazy">${caption}</figure>`;
        })
        .with({ kind: 'plain' }, (plain) => `<p>${escapeHtml(plain.text)}</p>`)
        .exhaustive();

const serializeBlocks = (blocks: readonly RichAnswerHtmlBlock[]): string => blocks.map(serializeBlock).join('');

const collectPhotoIndexes = (blocks: readonly RichAnswerHtmlBlock[], into: Set<number>): void => {
    for (const block of blocks) {
        if (block.kind === 'photo') into.add(block.mediaIndex);
        else if (block.kind === 'quote') collectPhotoIndexes(block.blocks, into);
    }
};

const referencedMediaIndexes = (blocks: readonly RichAnswerHtmlBlock[]): number[] => {
    const indexes = new Set<number>();
    collectPhotoIndexes(blocks, indexes);
    return [...indexes].sort((left, right) => left - right);
};

/**
 * The media left for the end of the body: a rich-text fallback's attachments,
 * a `send_image` album, or a picture whose block was dropped. Order preserved.
 */
export const unreferencedMediaIndexes = (
    blocks: readonly RichAnswerHtmlBlock[],
    mediaCount: number
): number[] => {
    const referenced = new Set(referencedMediaIndexes(blocks));
    return Array.from({ length: mediaCount }, (_unused, index) => index).filter((index) => !referenced.has(index));
};

/**
 * The snapshot's display blocks as SSR HTML: pictures come back where the
 * markdown put them, captions under them. A snapshot this parser cannot read at
 * all becomes one plain block, so the page never loses the text.
 */
export const renderRichAnswerHtml = (
    markdown: string,
    media: readonly RichAnswerHtmlMedia[],
    photoUrlOf: RichAnswerPhotoUrlOf
): RichAnswerHtmlResult => {
    if (markdown.trim() === '') return { html: '', blocks: [], referencedMediaIndexes: [] };
    let blocks: RichAnswerHtmlBlock[];
    try {
        const resolvePhoto = createMediaMapping(media, snapshotMediaIds(markdown));
        blocks = parseBlocks(markdown, resolvePhoto, photoUrlOf);
    } catch {
        blocks = [{ kind: 'plain', text: markdown.trim() }];
    }
    return {
        html: serializeBlocks(blocks),
        blocks,
        referencedMediaIndexes: referencedMediaIndexes(blocks),
    };
};
