/**
 * Telegram markdown entities -> clipboard HTML that the clients accept on paste.
 *
 * The dialect is the one tdesktop itself writes (TextWithTagsToHtml): b/i/u/s,
 * code, pre, blockquote, tg-spoiler, a[href] and <br> for newlines. Android has
 * its own quirks (spoiler element, pre language attribute, multiline pre needs
 * <br>), so the generator takes a target and adapts those tags.
 *
 * The entity set is resolved with the library's styleSegments, which returns
 * fully nested styles per run; that makes the tag open/close diff a flat walk.
 */
import { styleSegments, type MessageEntity } from 'telegram-md-entities';
import type { ClipboardTarget } from './types';

const HTML_ESCAPES: Readonly<Record<string, string>> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
};

export const escapeHtml = (text: string): string =>
    text.replace(/[&<>"]/g, (character) => HTML_ESCAPES[character] ?? character);

const SAFE_LINK = /^(https?|tg):/i;

export const isSafeLink = (url: string): boolean => SAFE_LINK.test(url.trim());

interface OpenTag {
    key: string;
    open: string;
    close: string;
    order: number;
}

/** The blockquote entity styles the library reports for quotes */
const QUOTE_STYLES = new Set(['blockquote', 'expandable_blockquote']);

const tagOfStyle = (style: string, target: ClipboardTarget): OpenTag | null => {
    if (style === 'bold') return { key: 'bold', open: '<b>', close: '</b>', order: 2 };
    if (style === 'italic') return { key: 'italic', open: '<i>', close: '</i>', order: 3 };
    if (style === 'underline') return { key: 'underline', open: '<u>', close: '</u>', order: 4 };
    if (style === 'strikethrough') return { key: 'strikethrough', open: '<s>', close: '</s>', order: 5 };
    if (style === 'spoiler') {
        // Android knows <spoiler>; the others know <tg-spoiler> and pass unknown tags through.
        return target === 'android'
            ? { key: 'spoiler', open: '<tg-spoiler><spoiler>', close: '</spoiler></tg-spoiler>', order: 6 }
            : { key: 'spoiler', open: '<tg-spoiler>', close: '</tg-spoiler>', order: 6 };
    }
    if (style === 'code') {
        // Android's paste parser has no <code> branch; plain text is all it keeps.
        return target === 'android' ? null : { key: 'code', open: '<code>', close: '</code>', order: 11 };
    }
    if (style === 'pre' || style.startsWith('pre:')) {
        const language = style.startsWith('pre:') ? style.slice('pre:'.length).trim() : '';
        if (target === 'android') {
            const languageAttribute = language === '' ? '' : ` lang="${escapeHtml(language)}" data-language="${escapeHtml(language)}"`;
            return { key: `pre:${language}`, open: `<pre${languageAttribute}>`, close: '</pre>', order: 10 };
        }
        const codeOpen = language === '' ? '<code>' : `<code class="language-${escapeHtml(language)}">`;
        return { key: `pre:${language}`, open: `<pre>${codeOpen}`, close: '</code></pre>', order: 10 };
    }
    if (style === 'expandable_blockquote') {
        // tdesktop's HTML import has no collapsed quote; the attribute is for Android/Web.
        const attributes = target === 'desktop' ? '' : ' data-collapsed="1" expandable="1"';
        return { key: 'quote', open: `<blockquote${attributes}>`, close: '</blockquote>', order: 0 };
    }
    if (QUOTE_STYLES.has(style)) {
        return { key: 'quote', open: '<blockquote>', close: '</blockquote>', order: 0 };
    }
    if (style.startsWith('text_link:')) {
        const url = style.slice('text_link:'.length);
        if (!isSafeLink(url)) return null;
        return { key: `link:${url}`, open: `<a href="${escapeHtml(url.trim())}">`, close: '</a>', order: 1 };
    }
    return null;
};

const textToHtml = (text: string, insidePre: boolean, target: ClipboardTarget): string => {
    let html = '';
    for (const character of text) {
        if (character === '\n') {
            // Android collapses literal newlines even inside <pre>; everywhere else a
            // literal newline only survives inside <pre>, so plain text uses <br>.
            html += insidePre && target !== 'android' ? '\n' : '<br>';
        } else {
            html += escapeHtml(character);
        }
    }
    return html;
};

/**
 * Rendered text plus entities -> one clipboard HTML document. Returns '' when
 * there is nothing to copy.
 */
interface Segment {
    text: string;
    styles: readonly string[];
}

const isBlockStyle = (style: string): boolean =>
    style === 'pre' || style.startsWith('pre:') || style === 'blockquote' || style === 'expandable_blockquote';

/**
 * The clients' own HTML keeps the terminating newline inside a block tag
 * (blockquote/pre); the parser adds a structural newline when the block closes,
 * so without this a quote or code block gains one blank line on paste.
 */
const extendBlocksOverNewline = (segments: readonly Segment[]): Segment[] => {
    const result: Segment[] = segments.map((segment) => ({ text: segment.text, styles: segment.styles }));
    for (let index = 0; index + 1 < result.length; index += 1) {
        const current = result[index];
        const next = result[index + 1];
        if (current === undefined || next === undefined) continue;
        const blockStyle = current.styles.find(isBlockStyle);
        if (blockStyle === undefined) continue;
        if (next.styles.some((style) => style === blockStyle)) continue;
        if (!next.text.startsWith('\n')) continue;
        current.text += '\n';
        next.text = next.text.slice(1);
    }
    return result.filter((segment) => segment.text !== '');
};

export const entitiesToClipboardHtml = (
    text: string,
    entities: readonly MessageEntity[],
    target: ClipboardTarget
): string => {
    if (text === '') return '';
    const segments = extendBlocksOverNewline(styleSegments({ text, entities: [...entities] }));
    let html = '<html><body>';
    let current: OpenTag[] = [];
    for (const segment of segments) {
        const desired = segment.styles
            .flatMap((style) => {
                const tag = tagOfStyle(style, target);
                return tag === null ? [] : [tag];
            })
            .sort((left, right) => left.order - right.order);
        let shared = 0;
        while (
            shared < current.length &&
            shared < desired.length &&
            current[shared]?.key === desired[shared]?.key
        ) {
            shared += 1;
        }
        for (let index = current.length - 1; index >= shared; index -= 1) {
            html += current[index]?.close ?? '';
        }
        for (let index = shared; index < desired.length; index += 1) {
            html += desired[index]?.open ?? '';
        }
        current = desired;
        html += textToHtml(segment.text, desired.some((tag) => tag.key.startsWith('pre:')), target);
    }
    for (let index = current.length - 1; index >= 0; index -= 1) {
        html += current[index]?.close ?? '';
    }
    html += '</body></html>';
    return html;
};
