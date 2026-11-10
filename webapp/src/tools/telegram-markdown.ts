/**
 * Rendered markdown -> the two plain-text markdown channels.
 *
 * - ios: CommonMark/GFM that the iOS client converts on paste. Telegram-only
 *   constructs are flattened: underline becomes inline <u>, spoilers lose their
 *   markers (the iOS parser has no ||spoiler||), code fences are kept.
 * - telegram: the dialect tdesktop converts on send (**bold**, __italic__,
 *   ~~strike~~, `code`, ```pre```, ||spoiler||, "> " quotes).
 *
 * The input is the library's styleSegments, which is already flattened by
 * renderMarkdown (no headings/tables reach this point).
 */
import { styleSegments } from 'telegram-md-entities';
import type { RenderedMarkdown } from './types';

type Dialect = 'ios' | 'telegram';

interface InlineRun {
    text: string;
    styles: readonly string[];
}

interface Line {
    runs: InlineRun[];
    /** null = not a pre line; '' = pre without language; otherwise the language */
    preLanguage: string | null;
    quote: boolean;
}

const quoteStyle = (style: string): boolean => style === 'blockquote' || style === 'expandable_blockquote';

const preStyleOf = (styles: readonly string[]): string | null => {
    const found = styles.find((style) => style === 'pre' || style.startsWith('pre:'));
    if (found === undefined) return null;
    return found === 'pre' ? '' : found.slice('pre:'.length);
};

const splitLines = (rendered: RenderedMarkdown): Line[] => {
    const lines: Line[] = [];
    let current: InlineRun[] = [];
    let currentPre: string | null = null;
    let currentQuote = false;
    const flush = (): void => {
        lines.push({ runs: current, preLanguage: currentPre, quote: currentQuote });
        current = [];
        currentPre = null;
        currentQuote = false;
    };
    for (const segment of styleSegments(rendered)) {
        const pre = preStyleOf(segment.styles);
        const quote = segment.styles.some(quoteStyle);
        const parts = segment.text.split('\n');
        for (let index = 0; index < parts.length; index += 1) {
            const part = parts[index] ?? '';
            if (part !== '') {
                current.push({ text: part, styles: segment.styles });
                if (pre !== null && currentPre === null) currentPre = pre;
                if (quote) currentQuote = true;
            }
            if (index < parts.length - 1) flush();
        }
    }
    flush();
    while (lines.length > 0 && lines[lines.length - 1]?.runs.length === 0) lines.pop();
    return lines;
};

const backtickFence = (text: string): string => {
    let longest = 0;
    for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
    return '`'.repeat(longest + 1);
};

const escapeIosPlain = (text: string): string =>
    text.replace(/[\\`*_~[\]<>]/g, (character) => `\\${character}`);

const renderCode = (text: string): string => {
    const fence = backtickFence(text);
    const needsPadding =
        text.startsWith('`') || text.endsWith('`') || text.startsWith(' ') || text.endsWith(' ');
    return needsPadding ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
};

const linkOf = (styles: readonly string[]): string | null => {
    const style = styles.find((entry) => entry.startsWith('text_link:'));
    return style === undefined ? null : style.slice('text_link:'.length);
};

const renderInlineRun = (run: InlineRun, dialect: Dialect): string => {
    const has = (style: string): boolean => run.styles.includes(style);
    if (has('code')) return renderCode(run.text);
    let text = dialect === 'ios' ? escapeIosPlain(run.text) : run.text;
    const link = linkOf(run.styles);
    if (has('underline')) text = dialect === 'ios' ? `<u>${text}</u>` : text;
    if (has('italic')) text = dialect === 'ios' ? `*${text}*` : `__${text}__`;
    if (has('bold')) text = `**${text}**`;
    if (has('strikethrough')) text = `~~${text}~~`;
    if (has('spoiler') && dialect === 'telegram') text = `||${text}||`;
    if (link !== null && /^(https?|tg):/i.test(link)) {
        const label = text.replace(/[[\]]/g, (character) => `\\${character}`);
        text = `[${label}](${link.trim()})`;
    }
    return text;
};

const renderInline = (runs: readonly InlineRun[], dialect: Dialect): string =>
    runs.map((run) => renderInlineRun(run, dialect)).join('');

const startsWithMarkdownStructure = (runs: readonly InlineRun[]): boolean => {
    const first = runs[0];
    if (first === undefined || first.styles.length > 0) return false;
    return /^(?:[#>\-+*]|\d+[.)]\s)/.test(first.text);
};

const renderLine = (line: Line, dialect: Dialect): string => {
    const inline = renderInline(line.runs, dialect);
    if (line.quote) return inline === '' ? '>' : `> ${inline}`;
    if (dialect === 'ios' && startsWithMarkdownStructure(line.runs)) return `\\${inline}`;
    return inline;
};

const renderLines = (lines: readonly Line[], dialect: Dialect): string => {
    const output: string[] = [];
    let index = 0;
    while (index < lines.length) {
        const line = lines[index];
        if (line === undefined) break;
        if (line.preLanguage === null) {
            output.push(renderLine(line, dialect));
            index += 1;
            continue;
        }
        const language = line.preLanguage;
        const code: string[] = [];
        while (index < lines.length) {
            const current = lines[index];
            if (current === undefined || current.preLanguage !== language) break;
            code.push(current.runs.map((run) => run.text).join(''));
            index += 1;
        }
        output.push(`\`\`\`${language}\n${code.join('\n')}\n\`\`\``);
    }
    return output.join('\n');
};

/** iOS paste dialect: CommonMark + GFM, inline <u> for underline, no spoiler markers */
export const renderedToIosMarkdown = (rendered: RenderedMarkdown): string => renderLines(splitLines(rendered), 'ios');

/** tdesktop typed-markdown dialect: converted when the message is sent */
export const renderedToTelegramMarkdown = (rendered: RenderedMarkdown): string =>
    renderLines(splitLines(rendered), 'telegram');
