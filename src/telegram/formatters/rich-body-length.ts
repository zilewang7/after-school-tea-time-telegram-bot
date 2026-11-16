/**
 * How long a rich reply body will be, in the units Telegram folds on.
 *
 * Measured 2026-11-16 on Bot API 10.4 with the test bot and an MTProto read-back
 * (design `2026-1116-1710-设计-富文本消息折叠触发与CoT链接模式联动.md` §1.2):
 * the server marks the delivered rich message `part` (clients then show
 * "Show more") when either
 *
 *   1. the rendered text exceeds 8192 UTF-16 code units, or
 *   2. the serialized payload exceeds ~16 KiB — UTF-8 text bytes plus
 *      per-block, per-entity and text_link URL bytes plus media objects.
 *
 * The bot cannot see the flag afterwards (the Bot API does not expose it and a
 * send response carries the full blocks), so the delivery predicts it before
 * sending. The counting is source-aware: the answer section goes through the
 * block parser of `rich-answer-html.ts` (the splitter the share page and the
 * Mini App already trust for this dialect) and only its rendered text counts —
 * `#`, `**`, `|`, fences, list markers, link URLs and media ids are syntax, not
 * text. Bot-built blocks are already exact {text, entities} messages
 * (`toRichHtml` is lossless), so their text and entities are taken as they are.
 *
 * Do not measure a composed body with `renderMarkdown`: it treats the bot's
 * HTML blocks as literal text (`<blockquote>` counts), renders a media block as
 * its URL and adds display sugar (list bullets, table grids), which overestimates
 * irregularly (measured up to 2.4x on one answer, +6% over the production corpus).
 */
import type { MessageEntity, RenderedMessage } from 'telegram-md-entities';
import { RICH_FOLD_MAX_BYTES, RICH_FOLD_MAX_UNITS } from './message-budget.js';
import {
    renderRichAnswerHtml,
    type RichAnswerHtmlBlock,
    type RichAnswerHtmlMedia,
} from './rich-answer-html.js';

/**
 * What a body costs: the two measured limits are `units` (8192) and
 * `serializedBytes` (~16 KiB). The components are kept for logs and tests.
 */
export interface RichBodyLength {
    /** Rendered text, UTF-16 code units (Telegram's own count unit) */
    readonly units: number;
    /** Rendered text, UTF-8 bytes (the serialized-budget unit) */
    readonly utf8Bytes: number;
    /** Rich blocks, approximated: block entities, paragraphs, list items, table rows, pictures */
    readonly blockCount: number;
    /** Inline formatting / link entities */
    readonly entityCount: number;
    /** UTF-8 bytes of text_link URLs (they ride in the serialized entity payload) */
    readonly linkUrlBytes: number;
    /** Pictures embedded in the body (one serialized media object each) */
    readonly mediaCount: number;
    /** Estimated serialized payload bytes */
    readonly serializedBytes: number;
    /** The block parser fell back to literal text: the estimate is only an upper bound */
    readonly degraded: boolean;
}

/** An empty body: no text, no block */
export const EMPTY_RICH_BODY_LENGTH: RichBodyLength = {
    units: 0,
    utf8Bytes: 0,
    blockCount: 0,
    entityCount: 0,
    linkUrlBytes: 0,
    mediaCount: 0,
    serializedBytes: 0,
    degraded: false,
};

/** Per-rich-block overhead of the serialized payload (conservative) */
const BLOCK_OVERHEAD_BYTES = 16;
/** Per-entity overhead (formatting and link ranges) */
const ENTITY_OVERHEAD_BYTES = 8;
/** A media object's serialized size: a Photo (file reference, sizes vector, dc) is unmeasured, so this is deliberately generous */
const MEDIA_OVERHEAD_BYTES = 512;
/** The blank line `joinRichBlocks` puts between two top-level blocks: two units and two bytes */
const BLOCK_SEPARATOR_LENGTH = 2;

/** Whether Telegram would fold a body of this length ("显示更多") */
export const foldWouldTrigger = (length: RichBodyLength): boolean =>
    length.units > RICH_FOLD_MAX_UNITS || length.serializedBytes > RICH_FOLD_MAX_BYTES;

const serializedBytesOf = (
    utf8Bytes: number,
    blockCount: number,
    entityCount: number,
    linkUrlBytes: number,
    mediaCount: number
): number =>
    utf8Bytes +
    linkUrlBytes +
    blockCount * BLOCK_OVERHEAD_BYTES +
    entityCount * ENTITY_OVERHEAD_BYTES +
    mediaCount * MEDIA_OVERHEAD_BYTES;

const withSerializedBytes = (length: Omit<RichBodyLength, 'serializedBytes'>): RichBodyLength => ({
    ...length,
    serializedBytes: serializedBytesOf(
        length.utf8Bytes,
        length.blockCount,
        length.entityCount,
        length.linkUrlBytes,
        length.mediaCount
    ),
});

/**
 * Length of a body made of top-level blocks joined by `joinRichBlocks`: the blank
 * line between two blocks is rendered text too, so each boundary adds two units.
 *
 * Block breaks *inside* a markdown section (blank lines between parsed blocks)
 * are not counted: the parser's block count does not map one-to-one onto rendered
 * line breaks (list items and table rows are blocks too), so counting them would
 * need an estimate of its own. The unit margin (8192 measured vs 7680 used)
 * covers roughly 250 such breaks; the production corpus peaked at 48 blocks.
 */
export const combineRichBodyLengths = (parts: readonly RichBodyLength[]): RichBodyLength => {
    const total: Omit<RichBodyLength, 'serializedBytes'> = parts.reduce<Omit<RichBodyLength, 'serializedBytes'>>(
        (sum, part) => ({
            units: sum.units + part.units,
            utf8Bytes: sum.utf8Bytes + part.utf8Bytes,
            blockCount: sum.blockCount + part.blockCount,
            entityCount: sum.entityCount + part.entityCount,
            linkUrlBytes: sum.linkUrlBytes + part.linkUrlBytes,
            mediaCount: sum.mediaCount + part.mediaCount,
            degraded: sum.degraded || part.degraded,
        }),
        { units: 0, utf8Bytes: 0, blockCount: 0, entityCount: 0, linkUrlBytes: 0, mediaCount: 0, degraded: false }
    );
    const separators = Math.max(0, parts.length - 1) * BLOCK_SEPARATOR_LENGTH;
    return withSerializedBytes({ ...total, units: total.units + separators, utf8Bytes: total.utf8Bytes + separators });
};

// ---- plain text of display HTML -------------------------------------------

/** Decode every HTML entity `markdownToHtml` can emit; an astral code point is 2 UTF-16 units */
const decodeEntities = (text: string): string => {
    if (!text.includes('&')) return text;
    return text.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity: string): string => {
        if (entity.startsWith('#x') || entity.startsWith('#X')) {
            const codePoint = Number.parseInt(entity.slice(2), 16);
            return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : whole;
        }
        if (entity.startsWith('#')) {
            const codePoint = Number.parseInt(entity.slice(1), 10);
            return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : whole;
        }
        switch (entity) {
            case 'amp':
                return '&';
            case 'lt':
                return '<';
            case 'gt':
                return '>';
            case 'quot':
                return '"';
            case 'apos':
                return "'";
            case 'nbsp':
                return ' ';
            default:
                return whole;
        }
    });
};

/** Telegram's `==marked==` is markdown syntax: the delimiters are not rendered text */
const MARKED_SPAN = /==(?=\S)([^=\n]*?\S)==/g;

const withoutMarkedDelimiters = (text: string): string => text.replace(MARKED_SPAN, '$1');

/**
 * Rendered text of one block's HTML: tags are structure (0 units, except `<br>`
 * which is one line break), text is decoded. `<img>` carries no text (a picture's
 * caption is a block text of its own).
 */
export const plainTextOfHtml = (html: string): string => {
    let out = '';
    let index = 0;
    while (index < html.length) {
        const lt = html.indexOf('<', index);
        if (lt === -1) {
            out += decodeEntities(html.slice(index));
            break;
        }
        out += decodeEntities(html.slice(index, lt));
        const gt = html.indexOf('>', lt);
        if (gt === -1) {
            out += decodeEntities(html.slice(lt));
            break;
        }
        if (/^<br\b/iu.test(html.slice(lt, gt + 1))) out += '\n';
        index = gt + 1;
    }
    return withoutMarkedDelimiters(out);
};

// ---- block numbers ---------------------------------------------------------

interface BlockNumbers {
    readonly units: number;
    readonly utf8Bytes: number;
    readonly blockCount: number;
    readonly mediaCount: number;
}

const EMPTY_BLOCK_NUMBERS: BlockNumbers = { units: 0, utf8Bytes: 0, blockCount: 0, mediaCount: 0 };

const utf8BytesOf = (text: string): number => Buffer.byteLength(text, 'utf8');

const addTextPiece = (numbers: BlockNumbers, text: string, blocks = 0): BlockNumbers => ({
    units: numbers.units + text.length,
    utf8Bytes: numbers.utf8Bytes + utf8BytesOf(text),
    blockCount: numbers.blockCount + blocks,
    mediaCount: numbers.mediaCount,
});

const addBlocks = (numbers: BlockNumbers, blocks: readonly RichAnswerHtmlBlock[]): BlockNumbers =>
    blocks.reduce((acc, block) => addBlock(acc, block), numbers);

const addBlock = (numbers: BlockNumbers, block: RichAnswerHtmlBlock): BlockNumbers => {
    switch (block.kind) {
        case 'paragraph':
        case 'heading':
            return addTextPiece(numbers, plainTextOfHtml(block.html), 1);
        case 'pre':
            return addTextPiece(numbers, block.text, 1);
        case 'plain':
            return addTextPiece(numbers, block.text, 1);
        case 'divider':
            return { ...numbers, blockCount: numbers.blockCount + 1 };
        case 'list': {
            const withList = { ...numbers, blockCount: numbers.blockCount + 1 + block.items.length };
            // A task-list checkbox (`- [x] done`) is a flag, not text
            return block.items.reduce(
                (acc, item) => addTextPiece(acc, plainTextOfHtml(item.html).replace(/^\[[ xX]\]\s+/u, '')),
                withList
            );
        }
        case 'quote':
            return addBlocks({ ...numbers, blockCount: numbers.blockCount + 1 }, block.blocks);
        case 'table': {
            const rows = (block.header === undefined ? 0 : 1) + block.rows.length;
            const withTable = { ...numbers, blockCount: numbers.blockCount + 1 + rows };
            const header = block.header ?? [];
            const afterHeader = header.reduce(
                (acc, cell) => addTextPiece(acc, plainTextOfHtml(cell)),
                withTable
            );
            return block.rows.reduce(
                (acc, row) => row.reduce((inner, cell) => addTextPiece(inner, plainTextOfHtml(cell)), acc),
                afterHeader
            );
        }
        case 'photo': {
            const withMedia = {
                ...numbers,
                blockCount: numbers.blockCount + 1,
                mediaCount: numbers.mediaCount + 1,
            };
            return block.captionHtml === null ? withMedia : addTextPiece(withMedia, plainTextOfHtml(block.captionHtml));
        }
    }
};

// ---- entity / link-URL estimates from the markdown source ------------------

const URL_AFTER_LINK = /\]\((https?:\/\/|tg:\/\/)[^\s)]*\)/g;
const HTML_HREF = /<a\s[^>]*href="([^"]*)"/giu;
const HTML_OPEN_TAG = /<(b|strong|i|em|u|ins|s|strike|del|code|tg-spoiler)\b/giu;
const INLINE_CODE = /`[^`\n]+`/g;

interface MarkdownSyntax {
    readonly entityCount: number;
    readonly linkUrlBytes: number;
}

/**
 * Entity and link-URL estimates read from the markdown source. Every inline
 * formatting in a rich snapshot is an HTML tag except code spans (and markdown
 * the model wrote that `toRichMarkdown` left as markup), so the scan covers
 * tags, `[label](url)` and backtick code.
 */
const markdownSyntaxOf = (markdown: string): MarkdownSyntax => {
    let linkUrlBytes = 0;
    let linkCount = 0;
    for (const match of markdown.matchAll(URL_AFTER_LINK)) {
        const url = (match[0] ?? '').slice(2, -1);
        // A media block's tg://photo reference is not a link entity
        if (url.startsWith('tg://photo')) continue;
        linkCount += 1;
        linkUrlBytes += utf8BytesOf(url);
    }
    for (const match of markdown.matchAll(HTML_HREF)) {
        linkCount += 1;
        linkUrlBytes += utf8BytesOf(match[1] ?? '');
    }
    const tagCount = markdown.match(HTML_OPEN_TAG)?.length ?? 0;
    const codeCount = markdown.match(INLINE_CODE)?.length ?? 0;
    return { entityCount: tagCount + linkCount + codeCount, linkUrlBytes };
};

// ---- public estimates ------------------------------------------------------

/**
 * Length of one answer-markdown section (the stored `richAnswerMarkdown` or a
 * `toRichMarkdown` output). `media` maps the section's picture blocks onto the
 * media objects the body sends, so each counts as one block plus its caption;
 * without it a picture block counts as its caption text only.
 */
export const estimateAnswerMarkdown = (
    markdown: string,
    media: readonly RichAnswerHtmlMedia[] = []
): RichBodyLength => {
    if (markdown.trim() === '') return EMPTY_RICH_BODY_LENGTH;
    const { blocks } = renderRichAnswerHtml(markdown, media, () => '');
    const numbers = addBlocks(EMPTY_BLOCK_NUMBERS, blocks);
    const syntax = markdownSyntaxOf(markdown);
    return withSerializedBytes({
        units: numbers.units,
        utf8Bytes: numbers.utf8Bytes,
        blockCount: numbers.blockCount,
        entityCount: syntax.entityCount,
        linkUrlBytes: syntax.linkUrlBytes,
        mediaCount: numbers.mediaCount,
        // A single literal-text block means the display splitter fell back (a
        // parser failure) or a lone unresolved picture title is all there is: the
        // count is then an upper bound, not a structural measurement
        degraded: blocks.length === 1 && blocks[0]?.kind === 'plain',
    });
};

/**
 * Length of one bot-built block. `{text, entities}` is exactly what Telegram
 * renders (`toRichHtml` keeps every character), so the text is exact and the
 * entities and link URLs are known, not guessed.
 */
export const estimateRenderedMessage = (message: RenderedMessage): RichBodyLength => {
    const blockEntities = message.entities.filter(
        (entity) => entity.type === 'pre' || entity.type === 'blockquote' || entity.type === 'expandable_blockquote'
    ).length;
    // A block entity is a block; every paragraph inside it is one block too
    const paragraphBreaks = message.text.split(/\n[ \t]*\n/u).length;
    const blockCount = Math.max(1, blockEntities + paragraphBreaks);
    const linkUrlBytes = message.entities.reduce(
        (sum, entity: MessageEntity) =>
            sum + (entity.type === 'text_link' && entity.url !== undefined ? utf8BytesOf(entity.url) : 0),
        0
    );
    const utf8Bytes = utf8BytesOf(message.text);
    return withSerializedBytes({
        units: message.text.length,
        utf8Bytes,
        blockCount,
        entityCount: message.entities.length,
        linkUrlBytes,
        mediaCount: 0,
        degraded: false,
    });
};

export interface RichBodySources {
    /** Answer sections in rich markdown, rendered the way the body shows them */
    readonly markdownSections?: readonly string[];
    /** The media objects of the body's picture blocks, when the sections reference them */
    readonly media?: readonly RichAnswerHtmlMedia[];
    /** Bot-built blocks: the {text, entities} before toRichHtml (thinking quote, tool records, footer, status) */
    readonly messages?: readonly (RenderedMessage | undefined)[];
}

/** Length of a body assembled from its sources, in the order `joinRichBlocks` joins them */
export const estimateRichBody = (sources: RichBodySources): RichBodyLength =>
    combineRichBodyLengths([
        ...(sources.markdownSections ?? []).map((section) =>
            estimateAnswerMarkdown(section, sources.media ?? [])
        ),
        ...(sources.messages ?? []).flatMap((message) =>
            message === undefined ? [] : [estimateRenderedMessage(message)]
        ),
    ]);
