/**
 * A rich reply's stored answer snapshot (`richAnswerMarkdown`) as display
 * blocks (v5.1 design 2026-1115-2355 §三).
 *
 * The snapshot is the rich body's answer section as it was sent: a block-level
 * markdown document whose inline formatting is already tags (`<b>`, `<i>`,
 * `<tg-spoiler>`), whose pictures are `![](tg://photo?id=imgK "caption")`
 * blocks at the position the model put them, and whose `#N` references are
 * links. Splitting it into blocks is all this module does itself; every inline
 * run comes from telegram-md-entities' `renderMarkdown` + `styleSegments`, the
 * same parser that produced the snapshot, so the Mini App shows the text the
 * chat showed.
 *
 * Pure module (no React) so the offline tests can cover it.
 */
import { renderMarkdown, styleSegments } from 'telegram-md-entities';

/** One styled text run; `styles` are telegram-md-entities' style keys */
export interface RichAnswerRun {
    readonly text: string;
    /** e.g. `bold`, `code`, `spoiler`, `text_link:<url>`, `blockquote` */
    readonly styles: readonly string[];
}

/** One table cell: its inline runs */
export type RichAnswerCell = readonly RichAnswerRun[];

export interface RichAnswerListItem {
    /** 0-based indentation level (`  - x` is depth 1) */
    readonly depth: number;
    readonly runs: readonly RichAnswerRun[];
}

/** A picture block: the index into the version's `media[]` its id mapped to */
export interface RichAnswerPhotoBlock {
    readonly kind: 'photo';
    readonly mediaIndex: number;
}

export type RichAnswerBlock =
    | { readonly kind: 'paragraph'; readonly runs: readonly RichAnswerRun[] }
    | { readonly kind: 'heading'; readonly size: 1 | 2 | 3 | 4 | 5 | 6; readonly runs: readonly RichAnswerRun[] }
    | { readonly kind: 'pre'; readonly language: string | null; readonly text: string }
    | {
          readonly kind: 'list';
          readonly ordered: boolean;
          /** Ordered lists only: the first item's number when it is not 1 (`<ol start>`) */
          readonly start?: number;
          readonly items: readonly RichAnswerListItem[];
      }
    | { readonly kind: 'quote'; readonly blocks: readonly RichAnswerBlock[] }
    | {
          readonly kind: 'table';
          /** The header row's cells; absent for a separator-less table fragment */
          readonly header?: readonly RichAnswerCell[];
          readonly rows: readonly (readonly RichAnswerCell[])[];
      }
    | { readonly kind: 'divider' }
    | RichAnswerPhotoBlock
    /** Fallback text: a picture whose media could not be matched keeps its caption */
    | { readonly kind: 'plain'; readonly text: string };

/** The media facts this parser needs; `MediaAttachment` satisfies it */
export interface RichAnswerMedia {
    /** The inline media id the snapshot references (`img1`…); attachments have none */
    readonly id?: string | null;
    /** Original caption markdown, rendered by the page's media view */
    readonly caption?: string | null;
    /** `inline` pictures are the ones the snapshot can reference */
    readonly placement?: 'inline' | 'attachment';
}

const LINK_STYLE = 'text_link:';

/** Only links a reader can safely follow: http(s) and tg, never the internal media refs */
const SAFE_LINK = /^(?:https?:\/\/|tg:)[^\s<>"']*$/i;
const INTERNAL_MEDIA_LINK = /^tg:\/\/photo\?/i;

export const isSafeLinkUrl = (url: string): boolean => SAFE_LINK.test(url) && !INTERNAL_MEDIA_LINK.test(url);

/** Inline style keys renderMarkdown/rich snapshots can carry */
const INLINE_STYLE_NAMES: ReadonlySet<string> = new Set([
    'bold',
    'italic',
    'underline',
    'strikethrough',
    'spoiler',
    'code',
    'pre',
    'blockquote',
    'expandable_blockquote',
]);

const isKeptStyle = (style: string): boolean => {
    if (style.startsWith(LINK_STYLE)) return isSafeLinkUrl(style.slice(LINK_STYLE.length));
    if (style.startsWith('pre:')) return true;
    return INLINE_STYLE_NAMES.has(style);
};

const sameStyles = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && left.every((style, index) => style === right[index]);

/**
 * The snapshot dialect writes a hard line break as a trailing `\` before the
 * newline. A lone trailing backslash has no next line to break: it is a marker
 * with nothing to carry, and renderMarkdown would show it literally.
 */
const withoutDanglingHardBreak = (text: string): string => {
    if (!text.endsWith('\\')) return text;
    let backslashes = 0;
    for (let index = text.length - 1; index >= 0 && text[index] === '\\'; index -= 1) backslashes += 1;
    return backslashes % 2 === 1 ? text.slice(0, -1) : text;
};

/** `renderMarkdown` + `styleSegments`: the package's view of one line of inline markdown */
export const inlineRuns = (text: string): RichAnswerRun[] => {
    const source = withoutDanglingHardBreak(text);
    if (source === '') return [];
    const runs: RichAnswerRun[] = [];
    for (const segment of styleSegments(renderMarkdown(source))) {
        const styles = segment.styles.filter(isKeptStyle);
        const previous = runs[runs.length - 1];
        if (previous !== undefined && sameStyles(previous.styles, styles)) {
            runs[runs.length - 1] = { text: previous.text + segment.text, styles };
            continue;
        }
        runs.push({ text: segment.text, styles });
    }
    return runs;
};

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
const depthOfIndent = (indent: string): number =>
    Math.min(5, Math.floor(indent.replace(/\t/g, '  ').length / 2));

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
 * not a picture the version delivered.
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
        const id = MEDIA_BLOCK.exec(line)?.[1];
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
        const body = line
            .slice(leading.length)
            .replace(/^<p>\s*/iu, '')
            .replace(/\s*<\/p>$/iu, '');
        stripped.push(`${leading}${body}`);
    }
    return stripped;
};

type PhotoResolution = { readonly mediaIndex: number } | { readonly caption: string };

/**
 * Map the snapshot's picture ids onto `media[]`: an exact `media[i].id` first,
 * then the remaining inline entries in snapshot-id order (older rows carry no
 * id), and a caption-only fallback when nothing is left.
 */
const createMediaMapping = (
    media: readonly RichAnswerMedia[],
    ids: readonly string[]
): ((id: string, captionTitle: string | null) => PhotoResolution) => {
    const inlineIndexes = media.flatMap((item, index) =>
        (item.placement ?? 'inline') === 'attachment' ? [] : [index]
    );
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
        if (mediaIndex !== undefined) return { mediaIndex };
        return { caption: decodeMediaTitle(captionTitle) };
    };
};

// ---- block parsing --------------------------------------------------------

const parseBlocks = (markdown: string, resolvePhoto: (id: string, captionTitle: string | null) => PhotoResolution): RichAnswerBlock[] => {
    const lines = stripBlockParagraphTags(markdown.replace(/\r\n?/g, '\n').split('\n'));
    const blocks: RichAnswerBlock[] = [];
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
            if ('mediaIndex' in resolved) blocks.push({ kind: 'photo', mediaIndex: resolved.mediaIndex });
            else if (resolved.caption !== '') blocks.push({ kind: 'plain', text: resolved.caption });
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
                runs: inlineRuns(line),
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
            const header = splitTableRow(line).map((cell) => inlineRuns(cell));
            const rows: RichAnswerCell[][] = [];
            index += 2; // header + separator
            while (index < lines.length) {
                const row = lines[index] ?? '';
                if (row.trim() === '' || !row.includes('|') || isTableSeparator(row)) break;
                rows.push(splitTableRow(row).map((cell) => inlineRuns(cell)));
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
            blocks.push({ kind: 'quote', blocks: parseBlocks(innerLines.join('\n'), resolvePhoto) });
            continue;
        }

        const listItem = LIST_ITEM.exec(line);
        if (listItem !== null) {
            const ordered = isOrderedMarker(listItem[2] ?? '');
            const items: RichAnswerListItem[] = [];
            let start: number | undefined;
            // A list item may run over several lines: toRichMarkdown writes the
            // rest as indented lines (a trailing `\\` on the marker line is its
            // hard break), so they join the current item until the next marker.
            let itemLines: string[] | null = null;
            let itemDepth = 0;
            const pushItem = (): void => {
                if (itemLines === null) return;
                items.push({ depth: itemDepth, runs: inlineRuns(itemLines.join('\n')) });
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
        blocks.push({ kind: 'paragraph', runs: inlineRuns(paragraphLines.join('\n')) });
    }

    return blocks;
};

/**
 * The snapshot's display blocks: pictures come back where the markdown put
 * them. A snapshot this module cannot read at all becomes one plain block, so
 * the page never loses the text.
 */
export const parseRichAnswer = (
    markdown: string,
    media: readonly RichAnswerMedia[]
): RichAnswerBlock[] => {
    if (markdown.trim() === '') return [];
    try {
        const resolvePhoto = createMediaMapping(media, snapshotMediaIds(markdown));
        return parseBlocks(markdown, resolvePhoto);
    } catch {
        return [{ kind: 'plain', text: markdown.trim() }];
    }
};

const collectPhotoIndexes = (blocks: readonly RichAnswerBlock[], into: Set<number>): void => {
    for (const block of blocks) {
        if (block.kind === 'photo') into.add(block.mediaIndex);
        else if (block.kind === 'quote') collectPhotoIndexes(block.blocks, into);
    }
};

/** The media indexes the snapshot's picture blocks show, ascending */
export const referencedMediaIndexes = (blocks: readonly RichAnswerBlock[]): number[] => {
    const indexes = new Set<number>();
    collectPhotoIndexes(blocks, indexes);
    return [...indexes].sort((left, right) => left - right);
};

/**
 * The media left for the end of the body: a rich-text fallback's attachments,
 * a `send_image` album, or a picture whose block was dropped. Order preserved.
 */
export const unreferencedMediaIndexes = (
    blocks: readonly RichAnswerBlock[],
    mediaCount: number
): number[] => {
    const referenced = new Set(referencedMediaIndexes(blocks));
    return Array.from({ length: mediaCount }, (_unused, index) => index).filter((index) => !referenced.has(index));
};
