/**
 * Clipboard HTML -> text + Telegram entities.
 *
 * The clients do not agree on one dialect, so this parser is a tolerant
 * superset: tdesktop's export tags (b/i/u/s/code/pre/blockquote/tg-spoiler/a),
 * Android's private ones (<spoiler>, pre language attributes, blockquote
 * data-collapsed, details), WebK's ProseMirror markup, and WebA's Bot API HTML.
 * WebK also copies a `data-text-with-entities` JSON that is used when valid.
 *
 * Whitespace and newline semantics mirror tdesktop's TextWithTagsFromHtml:
 * text whitespace collapses, <br> is a visible newline, block elements add
 * structural newlines that are deduplicated and trimmed at the end.
 */
import type { MessageEntity } from 'telegram-md-entities';
import { isSafeLink } from './clipboard-html';
import type { ParsedClipboard } from './types';

type EntityType = MessageEntity['type'];

interface RunTag {
    type: EntityType;
    url?: string;
    language?: string;
}

interface TextRun {
    text: string;
    tags: RunTag[];
}

interface OpenElement {
    name: string;
    /** Formatting this element contributes (tag name, style and class) */
    styles: RunTag[];
    /** Last valid href of an <a> element, '' for a plain anchor */
    link: string;
    /** <pre> language, filled from attributes or a nested code.class */
    preLanguage: string;
    /** <blockquote> or <details> with collapsed/expandable markers */
    quoteExpandable: boolean;
    kind: 'inline' | 'link' | 'pre' | 'quote' | 'block';
}

const HIDDEN_TAGS = new Set([
    'button', 'head', 'iframe', 'link', 'meta', 'noscript', 'object', 'script', 'select',
    'style', 'svg', 'template', 'textarea', 'title', 'embed',
]);

const VOID_TAGS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param',
    'source', 'track', 'wbr',
]);

const BLOCK_TAGS = new Set([
    'address', 'article', 'aside', 'blockquote', 'dd', 'details', 'div', 'dl', 'dt', 'figcaption',
    'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'li', 'main', 'ol', 'p',
    'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

/** Tags whose formatting this converter cannot express; reported to the UI */
const IGNORED_FORMATTING_TAGS = new Set([
    'animated-emoji', 'audio', 'hr', 'img', 'mark', 'sub', 'sup', 'table', 'tbody', 'td',
    'tg-emoji', 'tfoot', 'th', 'thead', 'tr', 'video',
]);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: '\u00a0', quot: '"',
};

const decodeEntities = (text: string): string =>
    text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
        if (body.startsWith('#x') || body.startsWith('#X')) {
            const code = Number.parseInt(body.slice(2), 16);
            return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
        }
        if (body.startsWith('#')) {
            const code = Number.parseInt(body.slice(1), 10);
            return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
        }
        return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
    });

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

const isCollapsibleSpace = (character: string): boolean =>
    character === ' ' || character === '\t' || character === '\n' || character === '\r' || character === '\f';

const tagKey = (tag: RunTag): string => `${tag.type}\u0000${tag.url ?? ''}\u0000${tag.language ?? ''}`;

const sameTags = (left: readonly RunTag[], right: readonly RunTag[]): boolean => {
    if (left.length !== right.length) return false;
    const leftKeys = left.map(tagKey).sort();
    const rightKeys = right.map(tagKey).sort();
    return leftKeys.every((key, index) => key === rightKeys[index]);
};

const dedupeTags = (tags: readonly RunTag[]): RunTag[] => {
    const seen = new Set<string>();
    const result: RunTag[] = [];
    for (const tag of tags) {
        const key = tagKey(tag);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(tag);
    }
    return result;
};

// ---------------------------------------------------------------------------
// WebK fast path: the copied HTML carries the exact text and entities as JSON.
// ---------------------------------------------------------------------------

interface WebkEntityJson {
    _?: unknown;
    offset?: unknown;
    length?: unknown;
    url?: unknown;
    language?: unknown;
    collapsed?: unknown;
}

const WEBK_ENTITY_TYPES: Readonly<Record<string, EntityType>> = {
    messageEntityBold: 'bold',
    messageEntityBlockquote: 'blockquote',
    messageEntityCode: 'code',
    messageEntityItalic: 'italic',
    messageEntityPre: 'pre',
    messageEntitySpoiler: 'spoiler',
    messageEntityStrike: 'strikethrough',
    messageEntityTextUrl: 'text_link',
    messageEntityUnderline: 'underline',
};

const readAttribute = (html: string, name: string): string | null => {
    const lower = html.toLowerCase();
    let from = lower.indexOf(`${name.toLowerCase()}=`);
    if (from < 0) return null;
    from += name.length + 1;
    while (from < html.length && (html[from] === ' ' || html[from] === '\n')) from += 1;
    const quote = html[from];
    if (quote !== '"' && quote !== "'") {
        let till = from;
        while (till < html.length && html[till] !== '>' && html[till] !== ' ' && html[till] !== '\n') till += 1;
        return html.slice(from, till);
    }
    const end = html.indexOf(quote, from + 1);
    if (end < 0) return null;
    return decodeEntities(html.slice(from + 1, end));
};

const parseWebkJson = (html: string): ParsedClipboard | null => {
    const raw = readAttribute(html, 'data-text-with-entities');
    if (raw === null) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!isRecord(parsed)) return null;
    const text = parsed.text;
    const entities = parsed.entities;
    if (typeof text !== 'string' || !Array.isArray(entities)) return null;
    const result: MessageEntity[] = [];
    for (const item of entities) {
        if (!isRecord(item)) return null;
        const entity: WebkEntityJson = item;
        if (typeof entity._ !== 'string') return null;
        const type = WEBK_ENTITY_TYPES[entity._];
        if (type === undefined) continue;
        const offset = entity.offset;
        const length = entity.length;
        if (typeof offset !== 'number' || typeof length !== 'number') return null;
        if (!Number.isInteger(offset) || !Number.isInteger(length)) return null;
        if (offset < 0 || length <= 0 || offset + length > text.length) return null;
        const mapped: MessageEntity = { type, offset, length };
        if (type === 'text_link') {
            if (typeof entity.url !== 'string' || !isSafeLink(entity.url)) continue;
            mapped.url = entity.url.trim();
        }
        if (type === 'pre' && typeof entity.language === 'string' && entity.language !== '') {
            mapped.language = entity.language;
        }
        if (type === 'blockquote' && entity.collapsed === true) {
            mapped.type = 'expandable_blockquote';
        }
        result.push(mapped);
    }
    return { text, entities: normalizeEntities(text, result), ignoredTags: [], source: 'webk-json' };
};

/**
 * Block tags in the clients' HTML cover their terminating newline. Markdown
 * wants the block range without it, otherwise a quote renders an extra ">"
 * line and a fence gets a blank line.
 */
export const trimBlockEntityNewlines = (
    text: string,
    entities: readonly MessageEntity[]
): MessageEntity[] =>
    entities.flatMap((entity) => {
        const block = entity.type === 'blockquote' || entity.type === 'expandable_blockquote' || entity.type === 'pre';
        if (!block) return [entity];
        let length = entity.length;
        while (length > 0 && text[entity.offset + length - 1] === '\n') length -= 1;
        return length > 0 ? [{ ...entity, length }] : [];
    });

// ---------------------------------------------------------------------------
// Generic HTML parser
// ---------------------------------------------------------------------------

const normalizeEntities = (text: string, entities: readonly MessageEntity[]): MessageEntity[] => {
    const valid = entities.filter(
        (entity) =>
            Number.isInteger(entity.offset) &&
            Number.isInteger(entity.length) &&
            entity.offset >= 0 &&
            entity.length > 0 &&
            entity.offset + entity.length <= text.length
    );
    const merged: MessageEntity[] = [];
    for (const entity of valid) {
        if (entity.type === 'text_link') {
            const url = entity.url ?? '';
            if (!isSafeLink(url)) continue;
            const visible = text.slice(entity.offset, entity.offset + entity.length);
            // The client drops self-links (label == URL); markdown would be noisy too.
            if (/^https?:/i.test(url) && url.trim() === visible) continue;
            merged.push({ ...entity, url: url.trim() });
            continue;
        }
        merged.push({ ...entity });
    }
    merged.sort((left, right) => left.offset - right.offset || right.length - left.length);
    return merged;
};

interface AttributeMap {
    values: ReadonlyMap<string, string>;
    has: (name: string) => boolean;
}

const readAttributes = (raw: string): AttributeMap => {
    const values = new Map<string, string>();
    let index = 0;
    const size = raw.length;
    while (index < size) {
        while (index < size && /\s/.test(raw[index] ?? '')) index += 1;
        const nameStart = index;
        while (index < size && /[a-zA-Z0-9_:.-]/.test(raw[index] ?? '')) index += 1;
        if (nameStart === index) {
            index += 1;
            continue;
        }
        const name = raw.slice(nameStart, index).toLowerCase();
        while (index < size && /\s/.test(raw[index] ?? '')) index += 1;
        if (raw[index] !== '=') {
            values.set(name, '');
            continue;
        }
        index += 1;
        while (index < size && /\s/.test(raw[index] ?? '')) index += 1;
        const quote = raw[index];
        if (quote === '"' || quote === "'") {
            const end = raw.indexOf(quote, index + 1);
            const value = end < 0 ? raw.slice(index + 1) : raw.slice(index + 1, end);
            values.set(name, decodeEntities(value));
            index = end < 0 ? size : end + 1;
        } else {
            const valueStart = index;
            while (index < size && !/[\s>]/.test(raw[index] ?? '')) index += 1;
            values.set(name, decodeEntities(raw.slice(valueStart, index)));
        }
    }
    return { values, has: (name) => values.has(name) };
};

const classListOf = (attributes: AttributeMap): string[] =>
    (attributes.values.get('class') ?? '').toLowerCase().split(/\s+/).filter((entry) => entry !== '');

const styleDeltaOf = (attributes: AttributeMap): RunTag[] => {
    const styles: RunTag[] = [];
    const style = attributes.values.get('style');
    if (style !== undefined) {
        for (const declaration of style.split(';')) {
            const colon = declaration.indexOf(':');
            if (colon < 0) continue;
            const property = declaration.slice(0, colon).trim().toLowerCase();
            const value = declaration.slice(colon + 1).trim().toLowerCase();
            if (property === 'font-weight') {
                const numeric = Number.parseInt(value, 10);
                if (value === 'bold' || value === 'bolder' || (Number.isFinite(numeric) && numeric >= 600)) {
                    styles.push({ type: 'bold' });
                }
            } else if (property === 'font-style' && (value === 'italic' || value === 'oblique')) {
                styles.push({ type: 'italic' });
            } else if (property === 'text-decoration' || property === 'text-decoration-line') {
                if (value.includes('underline')) styles.push({ type: 'underline' });
                if (value.includes('line-through')) styles.push({ type: 'strikethrough' });
            }
        }
    }
    const classes = classListOf(attributes);
    if (classes.includes('tg-spoiler')) styles.push({ type: 'spoiler' });
    return styles;
};

const formattingTagsOf = (name: string, attributes: AttributeMap): RunTag[] => {
    const styles: RunTag[] = [];
    if (name === 'b' || name === 'strong') styles.push({ type: 'bold' });
    else if (name === 'i' || name === 'em' || name === 'cite' || name === 'dfn') styles.push({ type: 'italic' });
    else if (name === 'u' || name === 'ins') styles.push({ type: 'underline' });
    else if (name === 's' || name === 'strike' || name === 'del') styles.push({ type: 'strikethrough' });
    else if (name === 'code' || name === 'tt') styles.push({ type: 'code' });
    else if (name === 'tg-spoiler' || name === 'spoiler') styles.push({ type: 'spoiler' });
    else if (name === 'span') {
        if (attributes.has('data-spoiler')) styles.push({ type: 'spoiler' });
        if ((attributes.values.get('data-markup') ?? '').includes('spoiler')) styles.push({ type: 'spoiler' });
    }
    return styles;
};

const quoteExpandableOf = (name: string, attributes: AttributeMap): boolean => {
    if (name === 'details') return true;
    if (name !== 'blockquote') return false;
    if (attributes.has('data-collapsed') || attributes.has('collapsed') || attributes.has('expandable')) {
        const raw = attributes.values.get('data-collapsed') ?? attributes.values.get('collapsed') ?? '';
        if (raw !== '0' && raw !== 'false') return true;
    }
    return classListOf(attributes).includes('telegram-collapsed-quote');
};

const preLanguageOf = (attributes: AttributeMap): string => {
    const direct = attributes.values.get('lang') ?? attributes.values.get('language') ?? attributes.values.get('lng') ?? '';
    if (direct !== '') return direct.replace(/^language-/i, '');
    const data = attributes.values.get('data-language') ?? '';
    return data.replace(/^language-/i, '');
};

const classLanguageOf = (attributes: AttributeMap): string => {
    for (const entry of classListOf(attributes)) {
        if (entry.startsWith('language-')) return entry.slice('language-'.length);
    }
    return '';
};

interface ParseState {
    runs: TextRun[];
    stack: OpenElement[];
    hidden: string[];
    pendingSpace: boolean;
    trailingStructuralNewlines: number;
    totalLength: number;
    ignoredTags: Set<string>;
}

const createState = (): ParseState => ({
    runs: [],
    stack: [],
    hidden: [],
    pendingSpace: false,
    trailingStructuralNewlines: 0,
    totalLength: 0,
    ignoredTags: new Set(),
});

const lastCharacter = (state: ParseState): string => {
    const last = state.runs[state.runs.length - 1];
    if (last === undefined) return '';
    return last.text.slice(-1);
};

const pushRun = (state: ParseState, text: string, tags: readonly RunTag[]): void => {
    if (text === '') return;
    const normalized = dedupeTags(tags);
    const last = state.runs[state.runs.length - 1];
    if (last !== undefined && sameTags(last.tags, normalized)) {
        last.text += text;
    } else {
        state.runs.push({ text, tags: normalized });
    }
    state.totalLength += text.length;
};

const activeTags = (state: ParseState): RunTag[] => {
    // Inside <pre> the client keeps only the pre tag (no nested formatting).
    for (let index = state.stack.length - 1; index >= 0; index -= 1) {
        const element = state.stack[index];
        if (element === undefined || element.kind !== 'pre') continue;
        const preTag: RunTag = { type: 'pre' };
        if (element.preLanguage !== '') preTag.language = element.preLanguage;
        return [preTag];
    }
    const tags: RunTag[] = [];
    for (const element of state.stack) {
        if (element.kind === 'link' && element.link !== '') {
            tags.push({ type: 'text_link', url: element.link });
            continue;
        }
        if (element.kind === 'pre') {
            const preTag: RunTag = { type: 'pre' };
            if (element.preLanguage !== '') preTag.language = element.preLanguage;
            tags.push(preTag);
            continue;
        }
        if (element.kind === 'quote') {
            tags.push({ type: element.quoteExpandable ? 'expandable_blockquote' : 'blockquote' });
            continue;
        }
        tags.push(...element.styles);
    }
    return tags;
};

const hasPreActive = (state: ParseState): boolean => state.stack.some((element) => element.kind === 'pre');

const activeBlockTag = (state: ParseState): RunTag[] => {
    for (let index = state.stack.length - 1; index >= 0; index -= 1) {
        const element = state.stack[index];
        if (element === undefined) continue;
        if (element.kind === 'pre') {
            const tag: RunTag = { type: 'pre' };
            if (element.preLanguage !== '') tag.language = element.preLanguage;
            return [tag];
        }
        if (element.kind === 'quote') {
            return [{ type: element.quoteExpandable ? 'expandable_blockquote' : 'blockquote' }];
        }
    }
    return [];
};

const appendTagged = (state: ParseState, text: string, tags: readonly RunTag[]): void => {
    pushRun(state, text, tags);
    state.trailingStructuralNewlines = 0;
};

const appendCollapsedText = (state: ParseState, raw: string): void => {
    const text = raw.replace(/\r\n?/g, '\n');
    if (text === '') return;
    if (hasPreActive(state)) {
        state.pendingSpace = false;
        appendTagged(state, text, activeTags(state));
        return;
    }
    const tags = activeTags(state);
    let pending = state.pendingSpace;
    let chunk = '';
    const flushChunk = (): void => {
        if (chunk !== '') {
            appendTagged(state, chunk, tags);
            chunk = '';
        }
    };
    for (const character of text) {
        if (isCollapsibleSpace(character)) {
            flushChunk();
            if (state.totalLength > 0 && lastCharacter(state) !== '\n') pending = true;
            continue;
        }
        if (pending) {
            if (state.totalLength > 0 && lastCharacter(state) !== '\n') {
                appendTagged(state, ' ', tags);
            }
            pending = false;
        }
        chunk += character;
    }
    flushChunk();
    state.pendingSpace = pending;
};

const appendVisibleNewline = (state: ParseState): void => {
    state.pendingSpace = false;
    appendTagged(state, '\n', activeTags(state));
};

const appendStructuralNewline = (state: ParseState): void => {
    state.pendingSpace = false;
    if (state.totalLength === 0 || lastCharacter(state) === '\n') return;
    const previous = state.trailingStructuralNewlines;
    appendTagged(state, '\n', activeBlockTag(state));
    state.trailingStructuralNewlines = previous + 1;
};

const findOpenElement = (state: ParseState, name: string): number => {
    for (let index = state.stack.length - 1; index >= 0; index -= 1) {
        if (state.stack[index]?.name === name) return index;
    }
    return -1;
};

const popTo = (state: ParseState, index: number): void => {
    if (index < 0) return;
    state.stack.length = index;
};

const applyLanguageToPre = (state: ParseState, language: string): void => {
    for (let index = state.stack.length - 1; index >= 0; index -= 1) {
        const element = state.stack[index];
        if (element === undefined) continue;
        if (element.kind === 'pre') {
            if (element.preLanguage === '') element.preLanguage = language;
            return;
        }
    }
};

const handleOpenTag = (state: ParseState, name: string, attributes: AttributeMap, selfClosing: boolean): void => {
    if (name === 'br') {
        appendVisibleNewline(state);
        return;
    }
    if (VOID_TAGS.has(name)) {
        if (IGNORED_FORMATTING_TAGS.has(name)) state.ignoredTags.add(name);
        return;
    }
    if (HIDDEN_TAGS.has(name)) {
        if (!selfClosing) state.hidden.push(name);
        return;
    }
    const blockBoundary = BLOCK_TAGS.has(name);
    if (blockBoundary) appendStructuralNewline(state);
    if (selfClosing) {
        if (blockBoundary) appendStructuralNewline(state);
        return;
    }
    const styles = [...formattingTagsOf(name, attributes), ...styleDeltaOf(attributes)];
    if (styles.length > 0) {
        // Keep the raw tag name out of ignoredTags when it contributed formatting.
    } else if (IGNORED_FORMATTING_TAGS.has(name)) {
        state.ignoredTags.add(name);
    }
    let kind: OpenElement['kind'] = 'inline';
    let link = '';
    let preLanguage = '';
    let quoteExpandable = false;
    if (name === 'a') {
        kind = 'link';
        const href = (attributes.values.get('href') ?? '').trim();
        link = isSafeLink(href) ? href : '';
    } else if (name === 'pre') {
        kind = 'pre';
        preLanguage = preLanguageOf(attributes);
    } else if (name === 'blockquote' || name === 'details') {
        kind = 'quote';
        quoteExpandable = quoteExpandableOf(name, attributes);
    }
    if (name === 'code' && hasPreActive(state)) {
        const language = classLanguageOf(attributes);
        if (language !== '') applyLanguageToPre(state, language);
    }
    if (name === 'mark' || name === 'sub' || name === 'sup') {
        // No entity/markdown equivalent; text is kept and the tag is reported.
        state.ignoredTags.add(name);
    }
    state.stack.push({ name, styles, link, preLanguage, quoteExpandable, kind });
};

const handleCloseTag = (state: ParseState, name: string): void => {
    if (name === 'br') return;
    if (VOID_TAGS.has(name)) return;
    if (state.hidden.length > 0) {
        const index = state.hidden.lastIndexOf(name);
        if (index >= 0) state.hidden.length = index;
        return;
    }
    const index = findOpenElement(state, name);
    if (index < 0) return;
    popTo(state, index);
    if (BLOCK_TAGS.has(name)) appendStructuralNewline(state);
};

/** Parse one HTML string into text + entities. */
export const parseClipboardHtml = (html: string): ParsedClipboard => {
    const webk = parseWebkJson(html);
    if (webk !== null) return webk;
    const state = createState();
    let index = 0;
    const size = html.length;
    while (index < size) {
        const next = html.indexOf('<', index);
        if (next < 0) {
            if (state.hidden.length === 0) appendCollapsedText(state, decodeEntities(html.slice(index)));
            break;
        }
        if (next > index && state.hidden.length === 0) {
            appendCollapsedText(state, decodeEntities(html.slice(index, next)));
        }
        index = next;
        if (html.startsWith('<!--', index)) {
            const end = html.indexOf('-->', index + 4);
            index = end < 0 ? size : end + 3;
            continue;
        }
        if (html[index + 1] === '!' || html[index + 1] === '?') {
            const end = html.indexOf('>', index + 2);
            index = end < 0 ? size : end + 1;
            continue;
        }
        const tagEnd = html.indexOf('>', index + 1);
        if (tagEnd < 0) {
            if (state.hidden.length === 0) appendCollapsedText(state, '<');
            index += 1;
            continue;
        }
        const body = html.slice(index + 1, tagEnd);
        index = tagEnd + 1;
        const closing = body.startsWith('/');
        const raw = closing ? body.slice(1) : body;
        const selfClosing = /\/\s*$/.test(raw);
        const nameMatch = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(raw);
        if (nameMatch === null || nameMatch[1] === undefined) {
            if (state.hidden.length === 0) appendCollapsedText(state, `<${body}>`);
            continue;
        }
        const name = nameMatch[1].toLowerCase();
        if (state.hidden.length > 0) {
            if (closing) {
                const hiddenIndex = state.hidden.lastIndexOf(name);
                if (hiddenIndex >= 0) state.hidden.length = hiddenIndex;
            } else if (!selfClosing && !VOID_TAGS.has(name)) {
                state.hidden.push(name);
            }
            continue;
        }
        if (closing) {
            handleCloseTag(state, name);
            continue;
        }
        const attributes = readAttributes(raw.slice(nameMatch[0].length));
        handleOpenTag(state, name, attributes, selfClosing);
    }
    // Trim the structural newlines a closing block left at the end.
    if (state.trailingStructuralNewlines > 0) {
        let remaining = state.trailingStructuralNewlines;
        while (remaining > 0 && state.runs.length > 0) {
            const last = state.runs[state.runs.length - 1];
            if (last === undefined) break;
            if (last.text.length === 0) {
                state.runs.pop();
                continue;
            }
            last.text = last.text.slice(0, -1);
            remaining -= 1;
            if (last.text === '') state.runs.pop();
        }
        state.trailingStructuralNewlines = 0;
    }
    const text = state.runs.map((run) => run.text).join('');
    const entities: MessageEntity[] = [];
    const ranges = new Map<string, Array<{ tag: RunTag; start: number; end: number }>>();
    let offset = 0;
    for (const run of state.runs) {
        for (const tag of run.tags) {
            const key = tagKey(tag);
            const list = ranges.get(key) ?? [];
            const last = list[list.length - 1];
            if (last !== undefined && last.end === offset) {
                last.end += run.text.length;
            } else {
                list.push({ tag, start: offset, end: offset + run.text.length });
            }
            ranges.set(key, list);
        }
        offset += run.text.length;
    }
    for (const list of ranges.values()) {
        for (const range of list) {
            const entity: MessageEntity = {
                type: range.tag.type,
                offset: range.start,
                length: range.end - range.start,
            };
            if (range.tag.type === 'text_link') entity.url = range.tag.url ?? '';
            if (range.tag.type === 'pre' && range.tag.language !== undefined) entity.language = range.tag.language;
            entities.push(entity);
        }
    }
    return {
        text,
        entities: normalizeEntities(text, entities),
        ignoredTags: [...state.ignoredTags].sort(),
        source: 'html',
    };
};
